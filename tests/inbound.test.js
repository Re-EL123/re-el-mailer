/**
 * Inbound normalisation: provider payloads → the shape the rest of the app uses.
 *
 * These are the decisions that are easy to get subtly wrong (which provider id is
 * the join key, whether mail is spam vs merely read, how threads are keyed), so
 * they are pinned here rather than only exercised through the webhook.
 */

import { describe, expect, it } from 'vitest';
import {
  hydrateInboundPayload,
  normalizeDeliveryEvent,
  normalizeInbound,
  shouldAutoRead,
  shouldMarkSpam,
} from '../packages/mail/inbound.js';

describe('normalizeDeliveryEvent', () => {
  it('joins on data.email_id, which Resend echoes as the stored resend_id', () => {
    // Regression: data.email_id must resolve to providerId. Reading it as the SMTP
    // message id meant delivery events never matched a stored message.
    const event = normalizeDeliveryEvent({
      type: 'email.delivered',
      created_at: '2026-03-01T10:00:00.000Z',
      data: { email_id: 'msg_abc123', message_id: 'smtp-id@resend.com' },
    });

    expect(event.providerId).toBe('msg_abc123');
    // `normalizeMessageId` strips the angle brackets.
    expect(event.providerMessageId).toBe('smtp-id@resend.com');
    expect(event.status).toBe('delivered');
  });

  it('maps each provider event type to a delivery status', () => {
    const cases = [
      ['email.sent', 'sent'],
      ['email.delivered', 'delivered'],
      ['email.delivery_delayed', 'deferred'],
      ['email.complained', 'complained'],
      ['email.bounced', 'bounced'],
      ['email.failed', 'bounced'],
      ['email.suppressed', 'bounced'],
      ['email.scheduled', 'queued'],
      ['email.queued', 'queued'],
    ];

    for (const [type, status] of cases) {
      const event = normalizeDeliveryEvent({ type, data: { email_id: 'msg_1' } });
      expect(event.status, `${type} → ${status}`).toBe(status);
    }
  });

  it('reports unknown event types as unknown rather than guessing', () => {
    const event = normalizeDeliveryEvent({ type: 'email.something_new', data: { email_id: 'm' } });
    expect(event.status).toBe('unknown');
  });

  it('carries a failure reason when the provider gives one', () => {
    const event = normalizeDeliveryEvent({
      type: 'email.bounced',
      data: { email_id: 'm', reason: 'Mailbox does not exist' },
    });
    expect(event.reason).toBe('Mailbox does not exist');
  });

  it('returns null ids for an event with no identifiers', () => {
    const event = normalizeDeliveryEvent({ type: 'email.delivered', data: {} });
    expect(event.providerId).toBeNull();
    expect(event.providerMessageId).toBeNull();
  });

  it('accepts a flat payload without a data envelope', () => {
    const event = normalizeDeliveryEvent({ type: 'email.delivered', email_id: 'msg_flat' });
    expect(event.providerId).toBe('msg_flat');
  });
});

describe('shouldMarkSpam', () => {
  it('honours an explicit spam verdict', () => {
    expect(shouldMarkSpam({ spamVerdict: 'spam' })).toBe(true);
  });

  it('honours an explicit not-spam verdict', () => {
    expect(shouldMarkSpam({ spamVerdict: 'not-spam' })).toBe(false);
    expect(shouldMarkSpam({ verdict: 'not_spam' })).toBe(false);
  });

  it('defaults to the inbox when the provider says nothing', () => {
    // Conservative: a false positive loses a real message.
    expect(shouldMarkSpam({ fromEmail: 'anyone@example.com' })).toBe(false);
  });

  it('never treats an auto-read sender as spam', () => {
    // Regression: auto-read sender membership previously drove the spam decision,
    // so every allow-listed sender's mail was filed as spam.
    expect(
      shouldMarkSpam({ fromEmail: 'noreply@notifications.example', spamVerdict: undefined }),
    ).toBe(false);
  });
});

describe('provider spam verdict', () => {
  /** A minimal inbound event carrying only the headers under test. */
  function event(headers) {
    return {
      data: {
        from: 'sender@example.com',
        to: ['info@re-el.co.za'],
        subject: 'Hello',
        text: 'Body',
        headers,
      },
    };
  }

  it('turns an SES FAIL into a spam verdict the webhook acts on', () => {
    const message = normalizeInbound(event({ 'x-ses-spam-verdict': 'FAIL' }));
    expect(message.spamVerdict).toBe('spam');
    expect(shouldMarkSpam(message)).toBe(true);
  });

  it('treats PASS as a not-spam verdict', () => {
    const message = normalizeInbound(event({ 'x-ses-spam-verdict': 'PASS' }));
    expect(message.spamVerdict).toBe('not-spam');
    expect(shouldMarkSpam(message)).toBe(false);
  });

  it('does not treat GRAY (unscanned) as spam', () => {
    const message = normalizeInbound(event({ 'x-ses-spam-verdict': 'GRAY' }));
    expect(message.spamVerdict).toBeNull();
    expect(shouldMarkSpam(message)).toBe(false);
  });

  it('understands x-spam-status aliases', () => {
    expect(normalizeInbound(event({ 'x-spam-status': 'Yes' })).spamVerdict).toBe('spam');
    expect(normalizeInbound(event({ 'x-spam-status': 'No' })).spamVerdict).toBe('not-spam');
  });

  it('leaves the verdict unknown when the provider sends no headers', () => {
    expect(normalizeInbound(event({})).spamVerdict).toBeNull();
  });
});

describe('shouldAutoRead', () => {
  it('is true when the receiving mailbox has auto_read enabled', () => {
    expect(shouldAutoRead({ fromEmail: 'a@b.co' }, true)).toBe(true);
  });

  it('is false for an ordinary sender and a normal mailbox', () => {
    expect(shouldAutoRead({ fromEmail: 'a@b.co' }, false)).toBe(false);
  });

  it('does not depend on the spam verdict', () => {
    // Auto-read is a read-state concern only.
    expect(shouldAutoRead({ fromEmail: 'a@b.co', spamVerdict: 'spam' }, false)).toBe(false);
  });
});

describe('html bodies', () => {
  it('recovers HTML a provider delivered entity-escaped', () => {
    // Regression: Oracle's mail arrived with `html` set to the escaped source,
    // so the reader showed `<table role="presentation">…` as literal text.
    const message = normalizeInbound({
      data: {
        from: 'noreply@oracle.com',
        to: ['info@re-el.co.za'],
        subject: 'Verify your email',
        html: '&lt;table&gt;&lt;tr&gt;&lt;td&gt;Hello&nbsp;there&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;',
        text: 'Hello there',
      },
    });

    expect(message.bodyHtml).toContain('<table>');
    expect(message.bodyHtml).toContain('Hello\u00a0there');
    expect(message.bodyHtml).not.toContain('&lt;table');
  });

  it('leaves escaped tags inside real markup alone', () => {
    const message = normalizeInbound({
      data: {
        from: 'dev@example.com',
        to: ['info@re-el.co.za'],
        subject: 'Code',
        html: '<p>Use &lt;div&gt; for a block</p>',
      },
    });

    expect(message.bodyHtml).toBe('<p>Use &lt;div&gt; for a block</p>');
  });
});

describe('plain-text bodies', () => {
  it('decodes entities the provider left in the text part', () => {
    // Regression: senders' text parts often carry `&nbsp;` / `&#34;` from a
    // naive HTML→text conversion, and the reader showed them literally.
    const message = normalizeInbound({
      data: {
        from: 'news@example.com',
        to: ['info@re-el.co.za'],
        subject: 'Update',
        text: 'Hi&nbsp;there, it&rsquo;s &#34;live&#34; &mdash; &amp; done',
      },
    });

    expect(message.bodyText).toBe('Hi\u00a0there, it’s "live" — & done');
  });
});

describe('hydrateInboundPayload', () => {
  // A real `email.received` body: envelope only, with an `email_id` to expand.
  const envelope = {
    type: 'email.received',
    created_at: '2026-10-04T12:41:18.000Z',
    data: {
      attachments: [],
      bcc: [],
      cc: [],
      created_at: '2026-10-04T12:41:20.375Z',
      email_id: 'db24eed0-ea98-4b09-9870-ee46b207665c',
      from: 'someone@example.com',
      message_id: '<abc@mail.example.com>',
      received_for: ['info@re-el.co.za'],
      subject: 'Invoice attached',
      to: ['info@re-el.co.za'],
    },
  };

  const content = {
    object: 'email',
    id: 'db24eed0-ea98-4b09-9870-ee46b207665c',
    to: ['info@re-el.co.za'],
    from: 'someone@example.com',
    subject: 'Invoice attached',
    message_id: '<abc@mail.example.com>',
    html: '<p>Please find it attached.</p>',
    text: 'Please find it attached.\n',
    headers: { 'x-ses-spam-verdict': 'PASS' },
    bcc: [],
    cc: [],
    reply_to: [],
    attachments: [],
  };

  it('supplies the body a metadata-only webhook omits', () => {
    // Regression: the webhook carries no body, so messages were stored empty and
    // opened as "This message has no body."
    const before = normalizeInbound(envelope);
    expect(before.bodyHtml).toBe('');
    expect(before.bodyText).toBe('');

    const after = normalizeInbound(hydrateInboundPayload(envelope, content));
    expect(after.bodyHtml).toContain('Please find it attached.');
    expect(after.bodyText).toContain('Please find it attached.');
    expect(after.snippet).not.toBe('');
    expect(after.sizeBytes).toBeGreaterThan(0);
  });

  it('keeps the envelope recipient and subject authoritative', () => {
    const hydrated = hydrateInboundPayload(envelope, {
      ...content,
      to: ['someone-else@re-el.co.za'],
      subject: 'Stored copy',
    });

    expect(hydrated.data.to).toEqual(['info@re-el.co.za']);
    expect(hydrated.data.subject).toBe('Invoice attached');
  });

  it('never overwrites content the webhook already supplied', () => {
    const rich = {
      type: 'email.received',
      data: { ...envelope.data, html: '<p>inline</p>', text: 'inline' },
    };

    const hydrated = hydrateInboundPayload(rich, content);
    expect(hydrated.data.html).toBe('<p>inline</p>');
    expect(hydrated.data.text).toBe('inline');
  });

  it('maps attachment download URLs onto the fields the handler stores', () => {
    const hydrated = hydrateInboundPayload(envelope, content, [
      {
        id: '2a0c9ce0-3112-4728-976e-47ddcd16a318',
        filename: 'invoice.pdf',
        content_type: 'application/pdf',
        content_disposition: 'attachment',
        content_id: null,
        size: 13264,
        download_url: 'https://example.resend.com/att/2a0c?Signature=abc',
      },
    ]);

    expect(hydrated.data.attachments).toHaveLength(1);
    const normalized = normalizeInbound(hydrated);
    expect(normalized.attachments[0]).toMatchObject({
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      size: 13264,
      remoteUrl: 'https://example.resend.com/att/2a0c?Signature=abc',
      inline: false,
      rejected: false,
    });
  });

  it('leaves the payload untouched when there is no content to merge', () => {
    expect(hydrateInboundPayload(envelope, null)).toBe(envelope);
    expect(hydrateInboundPayload(envelope, 'nope')).toBe(envelope);
  });
});