/**
 * Email address handling: validation, normalisation, display formatting.
 *
 * Deliberately conservative: addresses are validated rather than "repaired",
 * because silently rewriting a recipient could deliver mail to the wrong
 * person. Display names are separated from the address, never parsed out of a
 * raw header with a single fragile regex.
 */

const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/;

/** Addresses we refuse outright: bounce handlers and RFC 2606 reserved names. */
const BLOCKED_LOCAL_PARTS = new Set(['postmaster', 'abuse', 'hostmaster', 'webmaster', 'root']);

/** Domains that must never receive mail from this platform. */
const BLOCKED_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'localhost', 'test', 'invalid']);

/**
 * Validate a bare `local@domain` address.
 * @returns {boolean}
 */
export function isValidEmail(value) {
  const address = String(value || '').trim();
  if (!address || address.length > 320) return false;
  if (/\s/.test(address)) return false;

  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return false;

  const local = address.slice(0, at);
  const domain = address.slice(at + 1);

  if (local.length > 64) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!LOCAL_PART.test(local)) return false;

  if (!DOMAIN.test(domain)) return false;
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  if (tld.length < 2 || /^\d+$/.test(tld)) return false;

  return true;
}

/** Lowercase and trim an address. Returns '' for anything unusable. */
export function normalizeEmail(value) {
  const address = String(value || '').trim().toLowerCase();
  return isValidEmail(address) ? address : '';
}

/** Domain part of an address, or '' when there is none. */
export function emailDomain(value) {
  const address = normalizeEmail(value);
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1);
}

/** Local part of an address, or '' when there is none. */
export function emailLocalPart(value) {
  const address = normalizeEmail(value);
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(0, at);
}

/**
 * Validate an address and reject reserved/blocked targets.
 * Used on the outbound path, where a typo becomes a bounced email.
 */
export function isDeliverableEmail(value, { allowBlockedDomains = false } = {}) {
  const address = normalizeEmail(value);
  if (!address) return false;
  if (emailLocalPart(address) in BLOCKED_LOCAL_PARTS) return false;
  if (!allowBlockedDomains && BLOCKED_DOMAINS.has(emailDomain(address))) return false;
  return true;
}

/**
 * Parse a single address that may carry a display name:
 *   `Akani Shibiri <akani@re-el.co.za>` → { name, email }
 */
export function parseAddress(value) {
  const raw = String(value || '').trim();
  if (!raw) return { name: '', email: '' };

  const angle = /^(.*?)<([^<>]+)>$/s.exec(raw);
  if (angle) {
    const email = normalizeEmail(angle[2]);
    let name = angle[1].trim().replace(/^["']|["']$/g, '').trim();
    return { name: collapseWhitespace(name), email };
  }

  return { name: '', email: normalizeEmail(raw) };
}

/**
 * Parse a header value that may contain several addresses.
 * Commas inside quotes and inside angle brackets are handled.
 * @returns {{name: string, email: string}[]}
 */
export function parseAddressList(value) {
  const raw = String(value || '');
  if (!raw.trim()) return [];

  const parts = [];
  let current = '';
  let inQuotes = false;
  let angleDepth = 0;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === '"' && raw[i - 1] !== '\\') inQuotes = !inQuotes;
    if (!inQuotes && char === '<') angleDepth += 1;
    if (!inQuotes && char === '>') angleDepth = Math.max(0, angleDepth - 1);
    if ((char === ',' || char === ';') && !inQuotes && angleDepth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);

  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => parseAddress(part))
    .filter((entry) => entry.email);
}

/** `true` when a domain is served by this deployment. */
export function isLocalDomain(domain, servedDomains) {
  const target = String(domain || '').trim().toLowerCase().replace(/\.$/, '');
  return (servedDomains || []).some((entry) => entry.toLowerCase().replace(/\.$/, '') === target);
}

/** Format an address for display in headers. */
export function formatAddress({ name, email }) {
  if (!name) return email;
  const needsQuotes = /[,;:<>"\\]/.test(name);
  return `${needsQuotes ? `"${name.replace(/"/g, '\\"')}"` : name} <${email}>`;
}

/** Human label for a contact row, e.g. `Akani Shibiri · akani@re-el.co.za`. */
export function contactLabel(name, email) {
  if (name && email) return `${name} · ${email}`;
  return name || email || '';
}

/** Initials for an avatar: up to two letters. */
export function initialsFor(value, fallback = '?') {
  const text = String(value || '').trim();
  if (!text) return fallback;
  const words = text.split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return fallback;
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
}

function collapseWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Guard against header injection: strip CR/LF and NUL from any value that will
 * end up in a header, and normalise internal whitespace.
 */
export function headerSafe(value, maxLength = 200) {
  return collapseWhitespace(String(value ?? '').replace(/[\r\n\0]/g, ' ')).slice(0, maxLength);
}

/** Reject addresses that are safe locally but not routable (Deny lists). */
export function assertNoHeaderInjection(...values) {
  for (const value of values) {
    if (/[\r\n\0]/.test(String(value ?? ''))) return false;
  }
  return true;
}