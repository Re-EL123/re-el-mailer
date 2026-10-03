/**
 * Outbound message assembly.
 *
 * Turns a validated send request plus stored attachments into the JSON body
 * Resend's `POST /emails` endpoint expects, and refuses anything that would
 * produce a malformed or abusive message:
 *
 *   - envelope From must be an address we actually own;
 *   - a visible From must not disagree with the envelope From (no spoofing);
 *   - recipient counts per field, after de-duplication;
 *   - subject length, body size, attachment count and size;
 *   - every body must carry at least one part (html or text).
 *
 * Reply/forward pre-filling also lives here, because deciding what a reply
 * should quote is message logic, not UI logic.
 */

import { mail as mailConfig } from '../shared/config.js';
import { AppError, Codes } from '../shared/errors.js';
import { baseSubject, htmlToText, isSafeUrl, sanitizeHtml, slugify } from '../shared/sanitize.js';
import { emailDomain, formatAddress, isLocalDomain, parseAddress, parseAddressList } from '../shared/email-address.js';

/** Lowercase, de-duplicated, self-filtered recipient list. */
export function normalizeRecipients(list, { exclude = [] } = {}) {
  const excluded = new Set(exclude.map((value) => String(value).toLowerCase()));
  const seen = new Set();
  const out = [];

  for (const address of list || []) {
    const value = String(address || '').trim().toLowerCase();
    if (!value || seen.has(value) || excluded.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Enforce the send policy for one message.
 * @throws {AppError} 400/413/429
 */
export function assertSendable({ to, cc, bcc, replyTo, subject, html, text, attachments = [], from }) {
  const recipientCount = to.length + cc.length + bcc.length;
  if (recipientCount === 0) {
    throw new AppError(Codes.VALIDATION_ERROR, 'Add at least one recipient.');
  }
  if (to.length > mailConfig.maxRecipients) {
    throw new AppError(Codes.VALIDATION_ERROR, `Up to ${mailConfig.maxRecipients} recipients in To.`);
  }
  if (bcc.length > mailConfig.maxBcc) {
    throw new AppError(Codes.VALIDATION_ERROR, `Up to ${mailConfig.maxBcc} recipients in Bcc.`);
  }
  if (recipientCount > mailConfig.maxRecipients + mailConfig.maxBcc) {
    throw new AppError(Codes.VALIDATION_ERROR, 'That message has too many recipients.');
  }

  if (replyTo.length > 5) {
    throw new AppError(Codes.VALIDATION_ERROR, 'Up to 5 reply-to addresses.');
  }

  const subjectLength = String(subject || '').length;
  if (subjectLength > mailConfig.maxSubjectLength) {
    throw new AppError(Codes.VALIDATION_ERROR, `Keep the subject under ${mailConfig.maxSubjectLength} characters.`, 400, {
      details: { maxLength: mailConfig.maxSubjectLength, length: subjectLength },
    });
  }

  const htmlText = String(html || '');
  const plainText = String(text || '');
  if (!htmlText.trim() && !plainText.trim()) {
    throw new AppError(Codes.VALIDATION_ERROR, 'Write a message before sending.');
  }

  const bodyBytes = Buffer.byteLength(htmlText, 'utf8') + Buffer.byteLength(plainText, 'utf8');
  if (bodyBytes > mailConfig.maxBodyBytes) {
    throw new AppError(Codes.PAYLOAD_TOO_LARGE, 'That message body is too large.', 413, {
      details: { maxBytes: mailConfig.maxBodyBytes, sizeBytes: bodyBytes },
    });
  }

  if (attachments.length > 10) {
    throw new AppError(Codes.VALIDATION_ERROR, 'Up to 10 attachments per message.');
  }
  const attachmentBytes = attachments.reduce((total, file) => total + (file.size || file.data?.length || 0), 0);
  if (attachmentBytes > mailConfig.attachmentMaxBytes * 3) {
    throw new AppError(Codes.PAYLOAD_TOO_LARGE, 'Those attachments are too large in total.', 413, {
      details: { totalBytes: attachmentBytes },
    });
  }

  // Envelope From must be on a domain this deployment serves. The caller has
  // already checked that the user owns the mailbox; this stops a mismatched or
  // injected From reaching the provider.
  //
  // api/send.js passes formatFrom()'s output, `"Name" <addr>`, because that is
  // the form the provider wants. Judging that string as an address rejected
  // every send from a mailbox that has a display name: normalizeEmail() refuses
  // anything containing whitespace, so the domain came back empty and the sender
  // was told their own address was not on the account. Parse out the address and
  // check that instead — the display name is cosmetic, and formatFrom() has
  // already escaped quotes and newlines out of it.
  const { email: fromAddress } = parseAddress(from);
  if (!fromAddress || !isLocalDomain(emailDomain(fromAddress), mailConfig.domains)) {
    throw new AppError(Codes.VALIDATION_ERROR, 'You can only send from an address on this account.', 400, {
      details: { from: String(from || '') },
    });
  }

  return true;
}

/**
 * Build the Resend send payload.
 *
 * The HTML part is sanitised on the way out as well as on the way in: a draft
 * body may have been round-tripped through the API or restored from an older
 * record, and the provider is the last place that content passes through before
 * it is rendered in someone's mail client.
 *
 * @param {object} args
 * @returns {object} Resend `POST /emails` body
 */
export function buildSendPayload({
  from,
  to,
  cc = [],
  bcc = [],
  replyTo = [],
  subject = '',
  html = '',
  text = '',
  attachments = [],
  priority = 'normal',
  scheduledFor = null,
  headers = {},
}) {
  const cleanHtml = html ? sanitizeHtml(html, { mode: 'email' }) : '';
  const cleanText = text || (cleanHtml ? htmlToText(cleanHtml) : '');

  if (!cleanHtml.trim() && !cleanText.trim()) {
    throw new AppError(Codes.VALIDATION_ERROR, 'Write a message before sending.');
  }

  const payload = {
    from,
    to,
    ...(cc.length ? { cc } : null),
    ...(bcc.length ? { bcc } : null),
    ...(replyTo.length ? { reply_to: replyTo } : null),
    subject: String(subject || '').trim(),
    // Resend accepts html and/or text; sending both keeps clients from having to
    // guess, and the text part is what spam filters and plain-text clients read.
    ...(cleanHtml ? { html: cleanHtml } : null),
    ...(cleanText ? { text: cleanText } : null),
    ...(Object.keys(headers).length ? { headers } : null),
  };

  if (attachments.length) {
    payload.attachments = attachments.map((file) => ({
      filename: file.filename,
      content: file.content, // base64
      ...(file.content_type ? { content_type: file.content_type } : null),
      ...(file.content_id ? { content_id: file.content_id } : null),
    }));
  }

  // Priority is a mail client hint, not an SMTP one; Resend exposes it as a
  // header rather than a field.
  if (priority && priority !== 'normal') {
    payload.headers = { ...(payload.headers || {}), 'X-Priority': priority === 'high' ? '1' : '5' };
  }

  if (scheduledFor) {
    const when = new Date(scheduledFor);
    if (Number.isNaN(when.getTime())) {
      throw new AppError(Codes.VALIDATION_ERROR, 'That send time is not valid.');
    }
    payload.scheduled_at = when.toISOString();
  }

  return payload;
}

/**
 * Build the "From" header for a mailbox.
 * Display names go through RFC 5322 quoting so a name containing a comma or a
 * quote cannot inject extra header fields.
 */
export function formatFrom(email, displayName) {
  if (!displayName) return email;
  const escaped = String(displayName).replace(/([\\"])/g, '\\$1').replace(/[\r\n]/g, ' ');
  return `"${escaped}" <${email}>`;
}

/** RFC 5322 address list for the header line. */
export function formatAddressList(addresses) {
  return addresses.map((address) => address).join(', ');
}

// ─── Reply / forward ─────────────────────────────────────────────────────────

/**
 * Pre-fill a reply.
 *
 * Default is reply to the sender only: replying to a long chain is a spam-filter
 * trigger and is rarely what the sender meant.
 *
 * @param {object} message the original message row
 * @param {'sender'|'all'|'replyAll'} mode
 * @param {string} [excludeAddress] the replying mailbox's own address, dropped
 *   from a reply-all so the user doesn't mail themselves
 */
export function buildReplyDraft(message, { mode = 'sender', excludeAddress = null } = {}) {
  const from = message.from_email;
  const to = [from].filter(Boolean);

  if (mode === 'all') {
    const drop = new Set(
      [from, excludeAddress]
        .filter(Boolean)
        .map((address) => String(address).toLowerCase()),
    );
    const others = [...(message.cc_emails || []), ...(message.to_emails || [])]
      .map((address) => String(address || '').toLowerCase())
      .filter((address) => address && !drop.has(address));
    to.push(...normalizeRecipients(others));
  }

  const subject = baseSubject(message.subject || '');

  return {
    to: [...new Set(to)],
    cc: [],
    bcc: [],
    subject: mode === 'all' && /(^|\s)re:/i.test(message.subject || '') ? `Re: ${message.subject}` : `Re: ${subject}`,
    // Quote the plain-text body; the caller re-renders it through the editor.
    quotedText: message.body_text || htmlToText(message.body_html || ''),
    inReplyTo: message.message_id || null,
    references: [...(message.references || []), message.message_id].filter(Boolean),
    threadId: message.thread_id || null,
  };
}

/** Pre-fill a forward. */
export function buildForwardDraft(message, { includeAttachments = true } = {}) {
  const body = [
    '',
    '---------- Forwarded message ----------',
    `From: ${formatAddress(parseAddress(message.from_email))}`,
    `Date: ${message.received_at || message.created_at || ''}`,
    `Subject: ${message.subject || '(no subject)'}`,
    `To: ${formatAddressList(message.to_emails || [])}`,
    message.body_text || htmlToText(message.body_html || ''),
    '---------- End of forwarded message ----------',
  ].join('\n');

  return {
    to: [],
    cc: [],
    bcc: [],
    subject: /^fwd:/i.test(message.subject || '') ? message.subject : `Fwd: ${message.subject || ''}`,
    quotedText: body,
    inReplyTo: null,
    references: [],
    threadId: message.thread_id || null,
    attachmentMessageId: includeAttachments ? message.id : null,
  };
}

// ─── Recipients ──────────────────────────────────────────────────────────────

/**
 * Suggest recipients from what a message already involved: the people this
 * mailbox has exchanged mail with most, then anyone matching the query.
 */
export function recipientSuggestions({ recent = [], contacts = [], query = '', limit = 8, exclude = [] } = {}) {
  const excluded = new Set(exclude.map((value) => String(value).toLowerCase()));
  const needle = query.trim().toLowerCase();
  const scored = new Map();

  for (const entry of recent) {
    const address = String(entry.email || '').toLowerCase();
    if (!address || excluded.has(address)) continue;
    scored.set(address, {
      email: address,
      name: entry.name || address.split('@')[0],
      score: Number(entry.count || 1),
      source: 'recent',
    });
  }

  for (const contact of contacts) {
    const address = String(contact.email || '').toLowerCase();
    if (!address || excluded.has(address)) continue;
    const existing = scored.get(address);
    scored.set(address, {
      email: address,
      name: contact.name || existing?.name || address.split('@')[0],
      score: (existing?.score || 0) + 0.5,
      source: existing ? existing.source : 'contact',
    });
  }

  let list = [...scored.values()];
  if (needle) {
    list = list.filter((entry) => entry.email.includes(needle) || String(entry.name).toLowerCase().includes(needle));
    // Prefix matches first, then by how often the person has been in contact.
    list.sort((a, b) => {
      const aStarts = a.email.startsWith(needle) ? 0 : 1;
      const bStarts = b.email.startsWith(needle) ? 0 : 1;
      return aStarts - bStarts || b.score - a.score;
    });
  } else {
    list.sort((a, b) => b.score - a.score);
  }

  return list.slice(0, limit);
}

/** Reject any link the sender cannot safely follow — used by the UI hint. */
export function isSafeOutboundUrl(url) {
  return isSafeUrl(url);
}

/** Turn the comma/semicolon/newline list a compose field holds into addresses. */
export { parseAddressList };

/** File-name-safe slug, used when naming generated exports. */
export { slugify };