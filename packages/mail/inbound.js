/**
 * Inbound email normalisation.
 *
 * Resend's inbound webhook delivers a parsed representation of the received
 * message (envelope, headers, text and HTML parts, attachments). This module
 * turns that into the flat shape the `messages` / `attachments` tables expect,
 * and is defensive about every field: inbound data is attacker-controlled, so
 * anything optional is treated as absent rather than trusted.
 *
 * There is deliberately no MIME parser here. Resend does the parsing server-side
 * and this way one large dependency (and its own CVEs) stays out of the project.
 */

import { mail as mailConfig } from '../shared/config.js';
import { AppError, Codes } from '../shared/errors.js';
import { htmlToText, makeSnippet, sanitizeHtml } from '../shared/sanitize.js';
import { emailDomain, normalizeEmail, parseAddress } from '../shared/email-address.js';
import { normalizeMessageId, threadIdFromReferences } from '../shared/ids.js';

/** Hard ceiling on a stored HTML body, so one enormous mail cannot blow up a row. */
const MAX_HTML_BYTES = 2_000_000;
const MAX_TEXT_BYTES = 512_000;

/** Coerce anything to a bounded string. */
function str(value, maxLength = 2000) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : String(value);
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

/** Coerce to a bounded integer, defaulting to 0. */
function num(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Pull an address out of whatever shape the provider used. */
function addressOf(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const parsed = parseAddress(value);
    return parsed.email ? parsed : null;
  }
  const email = normalizeEmail(value.email || value.address || '');
  if (!email) return null;
  return { name: str(value.name || '', 120), email };
}

/** Every address in a list field, de-duplicated, lowercased. */
function addressArray(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[,;]/);
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const address = addressOf(entry);
    if (!address) continue;
    const key = address.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out.slice(0, 200);
}

/**
 * Merge the provider's message content into a metadata-only webhook payload.
 *
 * Resend's `email.received` event carries only the envelope — `email_id`,
 * addresses, subject — and never the body. The full message is fetched
 * separately and folded in here so `normalizeInbound` sees one complete shape
 * regardless of which form the payload arrived in. Existing payload values win,
 * so a provider that does send inline content is never overwritten.
 *
 * @param {object} payload verified webhook body
 * @param {object|null} content response from the received-email endpoint
 * @param {object[]} [attachments] attachment metadata with download URLs
 * @returns {object} a payload suitable for `normalizeInbound`
 */
export function hydrateInboundPayload(payload, content, attachments = []) {
  if (!content || typeof content !== 'object') return payload;

  const target = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const base = { ...(target || {}) };

  const merged = { ...content, ...base };
  // The envelope in the webhook is authoritative for who the mail was delivered
  // to; the content response describes the same message but from storage.
  merged.to = base.to ?? content.to;
  merged.received_for = base.received_for ?? content.received_for;

  if (attachments.length > 0) {
    merged.attachments = attachments.map((file) => ({
      filename: file.filename,
      content_type: file.content_type,
      size: file.size,
      content_id: file.content_id ?? null,
      disposition: file.content_disposition ?? null,
      // `normalizeInbound` downloads `url` and stores it; the provider's signed
      // URL is short-lived, so it is resolved during this request only.
      url: file.download_url ?? null,
    }));
  }

  return payload?.data ? { ...payload, data: merged } : merged;
}

/**
 * Normalise an inbound webhook payload.
 *
 * @param {object} payload Resend inbound event body
 * @param {object} [options]
 * @param {string} [options.receivedAtIso] override, used by tests
 * @returns {{
 *   providerEventId: string|null,
 *   messageId: string|null,
 *   threadId: string|null,
 *   from: {name: string, email: string}|null,
 *   fromEmail: string, fromName: string,
 *   to: string[], cc: string[], bcc: string[], replyTo: string[],
 *   recipient: string|null,
 *   subject: string, bodyHtml: string, bodyText: string, snippet: string,
 *   sizeBytes: number, hasAttachments: boolean,
 *   priority: string, scheduledFor: null,
 *   headers: Record<string,string>, references: string[], inReplyTo: string|null,
 *   attachments: object[], receivedAt: string, rawMime: string|null
 * }}
 * @throws {AppError} 400 when there is no usable recipient or content
 */
export function normalizeInbound(payload, { receivedAtIso = null } = {}) {
  const message = payload?.message || payload?.data || payload || {};
  const envelopeTo = payload?.to || message.to;

  const from = addressOf(message.from || envelopeTo?.from);
  const recipient = normalizeEmail(
    Array.isArray(envelopeTo) ? envelopeTo[0] : envelopeTo?.[0]?.email || envelopeTo?.[0] || envelopeTo || message.to,
  );

  if (!recipient) {
    throw new AppError(Codes.VALIDATION_ERROR, 'The inbound event has no recipient.', 400);
  }

  let bodyHtml = str(message.html, MAX_HTML_BYTES);
  let bodyText = str(message.text || message.plain || message.plain_text, MAX_TEXT_BYTES);

  if (bodyHtml) {
    // Inbound HTML is hostile by default: sanitise before it is stored, so it is
    // already safe when rendered and never has to be trusted at read time.
    bodyHtml = sanitizeHtml(bodyHtml, { mode: 'email', maxLength: MAX_HTML_BYTES });
  }
  if (!bodyText && bodyHtml) bodyText = htmlToText(bodyHtml);
  if (bodyText.length > MAX_TEXT_BYTES) bodyText = bodyText.slice(0, MAX_TEXT_BYTES);

  if (!bodyHtml.trim() && !bodyText.trim() && !str(message.subject)) {
    throw new AppError(Codes.VALIDATION_ERROR, 'The inbound event has no content.', 400);
  }

  const attachments = normalizeInboundAttachments(message.attachments || payload?.attachments || []);

  const headers = {};
  for (const [key, value] of Object.entries(message.headers || {})) {
    headers[str(key, 100).toLowerCase()] = str(Array.isArray(value) ? value.join(', ') : value, 2000);
  }

  const messageId = normalizeMessageId(message.message_id || headers['message-id']);
  const references = [
    ...(Array.isArray(message.references) ? message.references : str(message.references).split(/\s+/)),
  ]
    .map((value) => normalizeMessageId(value))
    .filter(Boolean);
  const inReplyTo = normalizeMessageId(message.in_reply_to || headers['in-reply-to']);

  const receivedAt = receivedAtIso || str(message.last_modified || message.created_at, 60) || new Date().toISOString();
  const subject = str(message.subject, mailConfig.maxSubjectLength);
  const snippet = makeSnippet(bodyText || htmlToText(bodyHtml), 200);

  const sizeBytes = Math.min(
    MAX_HTML_BYTES + MAX_TEXT_BYTES,
    Buffer.byteLength(bodyHtml, 'utf8') + Buffer.byteLength(bodyText, 'utf8') + attachments.reduce((sum, file) => sum + file.size, 0),
  );

  return {
    providerEventId: str(payload?.id || payload?.event_id, 200) || null,
    messageId,
    threadId: threadIdFromReferences([...(references || []), inReplyTo].filter(Boolean)),
    from,
    fromEmail: from?.email || '',
    fromName: from?.name || '',
    to: addressArray(message.to || envelopeTo),
    cc: addressArray(message.cc),
    bcc: addressArray(message.bcc),
    replyTo: addressArray(message.reply_to),
    recipient,
    recipientDomain: emailDomain(recipient),
    subject,
    bodyHtml,
    bodyText,
    snippet,
    sizeBytes,
    hasAttachments: attachments.length > 0,
    priority: ['low', 'normal', 'high'].includes(message.priority) ? message.priority : 'normal',
    scheduledFor: null,
    headers,
    references,
    inReplyTo,
    attachments,
    receivedAt,
    rawMime: mailConfig.storeRawMime ? str(message.raw, MAX_HTML_BYTES) || null : null,
  };
}

/**
 * Normalise inbound attachments.
 *
 * Bodies arrive as base64 in the webhook payload, or as a URL that has to be
 * fetched. Sizes are checked here so an oversized attachment is dropped from the
 * message rather than failing the whole delivery.
 */
function normalizeInboundAttachments(list) {
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const filename = str(entry.filename || entry.name, 255);
    if (!filename) continue;

    const mimeType = str(entry.content_type || entry.mime_type || entry.type, 150) || 'application/octet-stream';
    const size = num(entry.content_length ?? entry.size, 0);

    if (size > mailConfig.attachmentMaxBytes) {
      // Recorded by the caller as skipped, not fatal.
      out.push({ filename, mimeType, size, rejected: true, reason: 'too_large' });
      continue;
    }

    const content = typeof entry.content === 'string' ? entry.content : null;
    out.push({
      filename,
      mimeType,
      size: size || (content ? Buffer.from(content, 'base64').length : 0),
      content, // base64, may be null when the provider only gave a URL
      contentId: str(entry.content_id, 255) || null,
      contentLocation: str(entry.content_location, 500) || null,
      remoteUrl: entry.url ? str(entry.url, 1000) : null,
      inline: Boolean(entry.content_id || entry.disposition === 'inline'),
      rejected: false,
    });
  }
  return out.slice(0, 20);
}

/**
 * Delivery-event classification, from Resend's event webhooks.
 *
 * @param {object} payload
 * @returns {{kind: string, providerMessageId: string|null, providerId: string|null,
 *            status: string, reason: string|null, occurredAt: string|null}}
 */
export function normalizeDeliveryEvent(payload) {
  const type = str(payload?.type || payload?.event, 60);
  const data = payload?.data || payload || {};

  // The Resend email id is the join key we stored as `resend_id` at send time
  // and the same value Resend echoes back as `email_id` on every delivery
  // event, so it must resolve to providerId. `message_id` (the SMTP id) is a
  // separate concept and becomes providerMessageId.
  const providerId = str(data.id || data.resend_id || data.email_id, 200) || null;
  const providerMessageId = normalizeMessageId(data.message_id || payload?.message_id) || null;

  const statusByType = {
    'email.sent': 'sent',
    'email.delivered': 'delivered',
    'email.delivery_delayed': 'deferred',
    'email.complained': 'complained',
    'email.bounced': 'bounced',
    'email.failed': 'bounced',
    'email.suppressed': 'bounced',
    'email.scheduled': 'queued',
    'email.queued': 'queued',
  };

  return {
    kind: type,
    providerEventId: str(payload?.id || payload?.event_id, 200) || null,
    providerId,
    providerMessageId,
    status: statusByType[type] || 'unknown',
    reason: str(data.reason || data.last_error || data.error?.message, 500) || null,
    occurredAt: str(data.created_at || payload?.created_at, 60) || new Date().toISOString(),
  };
}

/**
 * Decide whether an inbound message should land in spam.
 *
 * Deliberately conservative: a false positive loses a real message, so this only
 * fires on an explicit provider verdict or an address the sender has configured
 * as always-bulk. Everything else goes to the inbox for a human to judge.
 */
export function shouldMarkSpam(message) {
  const verdict = message?.spamVerdict || message?.verdict;
  if (verdict === 'spam') return true;
  if (verdict === 'not-spam' || verdict === 'not_spam') return false;

  // No explicit provider verdict: leave it in the inbox for a human to judge.
  // Auto-read is unrelated to spam and must never influence this decision.
  return false;
}

/**
 * Whether an inbound message should arrive already marked read.
 *
 * True when the receiving mailbox has `auto_read` enabled, or when the sender is
 * listed in INBOUND_AUTO_READ_SENDERS (used for automated senders whose mail is
 * informational). Applies only to the inbox; spam is never auto-read.
 */
export function shouldAutoRead(message, mailboxAutoRead) {
  if (mailboxAutoRead) return true;
  const senders = new Set(
    (mailConfig.inboundAutoReadSenders || []).map((value) => String(value).toLowerCase()),
  );
  return senders.has(String(message?.fromEmail || '').toLowerCase());
}