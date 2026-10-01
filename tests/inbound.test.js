/**
 * Inbound normalisation: provider payloads → the shape the rest of the app uses.
 *
 * These are the decisions that are easy to get subtly wrong (which provider id is
 * the join key, whether mail is spam vs merely read, how threads are keyed), so
 * they are pinned here rather than only exercised through the webhook.
 */

import { describe, expect, it } from 'vitest';
import {
  normalizeDeliveryEvent,
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