/**
 * Outbound send validation and payload construction.
 *
 * `assertSendable` is the last gate before mail leaves the system, so its rules
 * (recipients, size, envelope From domain) get direct coverage.
 */

import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_jwt_secret_that_is_definitely_long_enough_to_pass_validation_0123456789';
process.env.MAIL_DOMAINS = 're-el.co.za';

const {
  assertSendable,
  buildSendPayload,
  formatFrom,
  formatAddressList,
  normalizeRecipients,
  buildReplyDraft,
  buildForwardDraft,
  recipientSuggestions,
} = await import('../packages/mail/compose.js');

describe('normalizeRecipients', () => {
  it('lowercases and de-duplicates addresses', () => {
    const result = normalizeRecipients(['A@Example.com', 'a@example.com', 'b@example.com']);
    expect(result).toEqual(['a@example.com', 'b@example.com']);
  });

  it('drops excluded addresses, e.g. the sender on reply-all', () => {
    const result = normalizeRecipients(['me@re-el.co.za', 'them@example.com'], {
      exclude: ['me@re-el.co.za'],
    });
    expect(result).toEqual(['them@example.com']);
  });

  it('returns an empty list for empty input', () => {
    expect(normalizeRecipients([])).toEqual([]);
    expect(normalizeRecipients(null)).toEqual([]);
  });
});

describe('assertSendable', () => {
  const base = {
    to: ['them@example.com'],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: 'Hi',
    text: 'Hello',
    from: 'me@re-el.co.za',
  };

  it('accepts a well-formed message', () => {
    expect(assertSendable(base)).toBe(true);
  });

  it('requires at least one recipient', () => {
    expect(() => assertSendable({ ...base, to: [], cc: [], bcc: [] })).toThrow();
  });

  it('rejects an over-long subject', () => {
    expect(() => assertSendable({ ...base, subject: 'x'.repeat(201) })).toThrow();
  });

  it('rejects an oversized body', () => {
    expect(() => assertSendable({ ...base, text: 'x'.repeat(600_000) })).toThrow();
  });

  it('requires a body', () => {
    expect(() => assertSendable({ ...base, text: '   ', html: '' })).toThrow();
  });

  it('rejects more than the To recipient cap', () => {
    const to = Array.from({ length: 26 }, (_, i) => `r${i}@example.com`);
    expect(() => assertSendable({ ...base, to })).toThrow();
  });

  it('rejects more attachments than allowed', () => {
    const attachments = Array.from({ length: 11 }, () => ({ filename: 'a.txt', size: 10 }));
    expect(() => assertSendable({ ...base, attachments })).toThrow();
  });

  it('requires From to be on a domain this deployment serves', () => {
    // The caller has already checked ownership; this is the last gate that stops
    // a spoofed From reaching the provider.
    expect(() => assertSendable({ ...base, from: 'someone@gmail.com' })).toThrow();
    expect(() => assertSendable({ ...base, from: null })).toThrow();
  });

  it('rejects more than 5 reply-to addresses', () => {
    const replyTo = Array.from({ length: 6 }, (_, i) => `r${i}@re-el.co.za`);
    expect(() => assertSendable({ ...base, replyTo })).toThrow();
  });
});

describe('formatFrom', () => {
  it('quotes a display name', () => {
    expect(formatFrom('me@re-el.co.za', 'Ada Lovelace')).toBe('"Ada Lovelace" <me@re-el.co.za>');
  });

  it('omits the name when there is none', () => {
    expect(formatFrom('me@re-el.co.za', null)).toBe('me@re-el.co.za');
  });

  it('strips newlines so a name cannot inject a header', () => {
    const result = formatFrom('me@re-el.co.za', 'Ada\r\nBcc: victim@x.com');
    expect(result).not.toContain('\n');
    expect(result).not.toContain('\r');
  });

  it('escapes embedded quotes and backslashes', () => {
    expect(formatFrom('me@re-el.co.za', 'A"d\\a')).toBe('"A\\"d\\\\a" <me@re-el.co.za>');
  });
});

describe('formatAddressList', () => {
  it('joins addresses for a header line', () => {
    expect(formatAddressList(['a@b.co', 'c@d.co'])).toBe('a@b.co, c@d.co');
  });
});

describe('buildSendPayload', () => {
  const base = {
    from: '"Me" <me@re-el.co.za>',
    to: ['them@example.com'],
    subject: 'Subject line',
    html: '<p>Body</p>',
    text: 'Body',
  };

  it('produces the provider payload shape', () => {
    const payload = buildSendPayload(base);
    expect(payload.from).toBe('"Me" <me@re-el.co.za>');
    expect(payload.to).toEqual(['them@example.com']);
    expect(payload.subject).toBe('Subject line');
  });

  it('omits empty optional fields rather than sending blanks', () => {
    const payload = buildSendPayload(base);
    expect(payload).not.toHaveProperty('cc');
    expect(payload).not.toHaveProperty('bcc');
    expect(payload).not.toHaveProperty('attachments');
  });

  it('requires a body', () => {
    expect(() => buildSendPayload({ ...base, html: '', text: '' })).toThrow();
  });

  it('sets scheduled_at for a scheduled send', () => {
    const when = new Date(Date.now() + 86_400_000).toISOString();
    const payload = buildSendPayload({ ...base, scheduledFor: when });
    expect(payload.scheduled_at).toBe(when);
  });

  it('rejects an invalid send time', () => {
    expect(() => buildSendPayload({ ...base, scheduledFor: 'not-a-date' })).toThrow();
  });

  it('maps priority to a header and omits it when normal', () => {
    expect(buildSendPayload({ ...base, priority: 'high' }).headers['X-Priority']).toBe('1');
    expect(buildSendPayload({ ...base, priority: 'low' }).headers['X-Priority']).toBe('5');
    expect(buildSendPayload({ ...base, priority: 'normal' })).not.toHaveProperty('headers');
  });

  it('sanitises the HTML body on the way out', () => {
    // Guards the case where a draft body was round-tripped through the API or
    // restored from an older record: the provider is the last hop before render.
    const payload = buildSendPayload({
      ...base,
      html: '<p>ok</p><script>alert(1)</script><img src=x onerror=alert(1)>',
      text: 'ok',
    });
    expect(payload.html).not.toContain('<script');
    expect(payload.html).not.toContain('onerror');
  });

  it('encodes attachments as base64 content', () => {
    const payload = buildSendPayload({
      ...base,
      attachments: [{ filename: 'a.txt', content: 'aGk=', content_type: 'text/plain' }],
    });
    expect(payload.attachments).toEqual([
      { filename: 'a.txt', content: 'aGk=', content_type: 'text/plain' },
    ]);
  });
});

describe('buildReplyDraft', () => {
  // Reply helpers read the raw DB row, hence snake_case fields.
  const message = {
    id: 'msg_1',
    from_email: 'them@example.com',
    to_emails: ['me@re-el.co.za'],
    cc_emails: ['watcher@example.com'],
    subject: 'Original subject',
    body_text: 'Original body',
    message_id: 'parent@example.com',
    references: ['root@example.com'],
    thread_id: 'thr_1',
  };

  it('replies to the sender only by default', () => {
    const draft = buildReplyDraft(message);
    expect(draft.to).toEqual(['them@example.com']);
    expect(draft.cc).toEqual([]);
  });

  it('includes the other recipients on reply-all, without duplicating the sender', () => {
    const draft = buildReplyDraft(message, { mode: 'all' });
    expect(draft.to).toContain('watcher@example.com');
    expect(draft.to.filter((a) => a === 'them@example.com')).toHaveLength(1);
  });

  it('excludes the replying mailbox on reply-all', () => {
    const draft = buildReplyDraft(message, { mode: 'all', excludeAddress: 'me@re-el.co.za' });
    expect(draft.to).not.toContain('me@re-el.co.za');
  });

  it('prefixes the subject with Re: and strips existing prefixes', () => {
    expect(buildReplyDraft(message).subject).toBe('Re: Original subject');
    expect(buildReplyDraft({ ...message, subject: 'Re: Original' }).subject).toBe('Re: Original');
    expect(buildReplyDraft({ ...message, subject: 'RE: Original' }).subject).toBe('Re: Original');
    // Re/Fw/Fwd prefixes are all normalised away before the single Re: is added.
    expect(buildReplyDraft({ ...message, subject: 'Fwd: Original' }).subject).toBe('Re: Original');
    expect(buildReplyDraft({ ...message, subject: 'Re[2]: Original' }).subject).toBe('Re: Original');
  });

  it('quotes the body and carries the thread headers', () => {
    const draft = buildReplyDraft(message);
    expect(draft.quotedText).toContain('Original body');
    expect(draft.threadId).toBe('thr_1');
    expect(draft.inReplyTo).toBe('parent@example.com');
    expect(draft.references).toContain('root@example.com');
    expect(draft.references).toContain('parent@example.com');
  });
});

describe('buildForwardDraft', () => {
  const message = {
    id: 'msg_1',
    from_email: 'them@example.com',
    to_emails: ['me@re-el.co.za'],
    subject: 'Original subject',
    body_text: 'Original body',
    thread_id: 'thr_1',
  };

  it('prefixes the subject with Fwd: exactly once', () => {
    expect(buildForwardDraft(message).subject).toBe('Fwd: Original subject');
    expect(buildForwardDraft({ ...message, subject: 'Fwd: Original' }).subject).toBe('Fwd: Original');
  });

  it('embeds the original headers and body', () => {
    const draft = buildForwardDraft(message);
    expect(draft.quotedText).toContain('---------- Forwarded message ----------');
    expect(draft.quotedText).toContain('Original subject');
    expect(draft.quotedText).toContain('Original body');
  });

  it('references the source message for attachments only when asked', () => {
    expect(buildForwardDraft(message, { includeAttachments: true }).attachmentMessageId).toBe('msg_1');
    expect(buildForwardDraft(message, { includeAttachments: false }).attachmentMessageId).toBeNull();
  });

  it('has no recipient yet', () => {
    expect(buildForwardDraft(message).to).toEqual([]);
  });
});

describe('recipientSuggestions', () => {
  const recent = [{ email: 'recent@example.com' }];
  const contacts = [
    { email: 'client@example.com', name: 'Client Co' },
    { email: 'other@example.com', name: 'Other' },
  ];

  it('matches on a partial address', () => {
    const result = recipientSuggestions({ recent, contacts, query: 'client' });
    expect(result[0].email).toBe('client@example.com');
  });

  it('matches on a display name', () => {
    const result = recipientSuggestions({ recent, contacts, query: 'other' });
    expect(result[0].email).toBe('other@example.com');
  });

  it('excludes addresses already on the message', () => {
    const result = recipientSuggestions({
      recent,
      contacts,
      query: 'example.com',
      exclude: ['client@example.com'],
    });
    expect(result.map((r) => r.email)).not.toContain('client@example.com');
  });

  it('respects the limit', () => {
    expect(recipientSuggestions({ recent, contacts, query: 'example', limit: 1 })).toHaveLength(1);
  });
});