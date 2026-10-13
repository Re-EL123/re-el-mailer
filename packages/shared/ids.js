/**
 * Prefixed, sortable-ish identifiers.
 *
 * Every table has a text primary key rather than a UUID so that logs and API
 * payloads stay readable: `usr_9f2c…`, `mbx_1a04…`, `msg_77bd…`.
 * The prefix is not a security boundary — it is a debugging aid.
 */

import crypto from 'node:crypto';

const PREFIXES = {
  user: 'usr',
  mailbox: 'mbx',
  message: 'msg',
  attachment: 'att',
  session: 'ses',
  reset: 'rst',
  label: 'lbl',
  contact: 'con',
  domain: 'dom',
  route: 'rte',
  thread: 'thr',
  rule: 'rul',
  template: 'tpl',
  note: 'not',
  job: 'job',
  webhook: 'whk',
  notification: 'ntf',
  campaign: 'cmp',
  recipient: 'rcp',
};

/** Cryptographically random, URL-safe token (refresh tokens, reset tokens). */
export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Constant-time string comparison that tolerates length differences. */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) {
    // Still perform a comparison so timing does not leak the length check.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/** @param {keyof typeof PREFIXES} kind */
export function newId(kind) {
  const prefix = PREFIXES[kind];
  if (!prefix) throw new Error(`Unknown id kind: ${kind}`);
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/**
 * Human-friendly thread reference, e.g. `THREAD-8A29F`.
 * Only the first 8 characters of a random hex value are used, so a thread id
 * is not a secret and can be shown in the UI.
 */
export function newThreadRef() {
  const alphabet = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O/0/1 ambiguity
  let out = '';
  const bytes = crypto.randomBytes(5);
  for (let i = 0; i < 5; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return `THREAD-${out}`;
}

/** Build a thread id from a message's In-Reply-To / References headers. */
export function threadIdFromReferences(references) {
  const values = (Array.isArray(references) ? references : [references])
    .filter(Boolean)
    .map((value) => String(value).trim());
  if (values.length === 0) return null;
  const joined = values.join(' ');
  return sha256(joined).slice(0, 32);
}

/** Normalise an RFC 5322 Message-ID to its bare form, without angle brackets. */
export function normalizeMessageId(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const withoutBrackets = trimmed.replace(/^</, '').replace(/>$/, '');
  return withoutBrackets.split(/\s/)[0] || null;
}

/** Generate an RFC 5322 compliant Message-ID for outbound mail. */
export function newMessageId(domain) {
  const host = String(domain || 're-el.co.za').replace(/^@/, '');
  return `${crypto.randomUUID()}@${host}`;
}

/**
 * True when a filename is safe to place in a single path segment.
 *
 * Rejects path separators, `..`, NUL and other control characters, leading dots
 * and Windows-reserved device names. Attachment names come from users and from
 * inbound mail, so both are untrusted.
 */
export function isSafeFilename(filename) {
  const name = String(filename ?? '').trim();
  if (!name || name.length > 255) return false;
  if (name === '.' || name === '..') return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) return false;
  if (/[\\/]/.test(name)) return false;
  if (name.startsWith('.')) return false;
  if (/[<>:"|?*]/.test(name)) return false;

  const base = name.split('.')[0].toUpperCase();
  if (['CON', 'PRN', 'AUX', 'NUL', 'CONIN', 'CONOUT'].includes(base)) return false;
  if (/^(COM|LPT)[1-9]$/.test(base)) return false;
  if (name.endsWith('.')) return false;

  return true;
}