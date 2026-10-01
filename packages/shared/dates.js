/**
 * Date and duration helpers.
 *
 * The API speaks ISO 8601 UTC strings. The client formats them locally.
 * All parsing of RFC 5322 date strings goes through `parseMailDate`, which
 * handles the obsolete zone names that still appear in real mail.
 */

const OBSOLETE_ZONES = {
  ut: '+0000', utc: '+0000', gmt: '+0000', z: '+0000',
  est: '-0500', edt: '-0400', cst: '-0600', cdt: '-0500',
  mst: '-0700', mdt: '-0600', pst: '-0800', pdt: '-0700',
};

/** Current time as an ISO string. */
export function nowIso() {
  return new Date().toISOString();
}

/** `n` minutes from now, as a Date. */
export function minutesFromNow(minutes, from = new Date()) {
  return new Date(from.getTime() + minutes * 60_000);
}

/** `n` days from now, as a Date. */
export function daysFromNow(days, from = new Date()) {
  return new Date(from.getTime() + days * 86_400_000);
}

/** Seconds → milliseconds, honouring a value like '15m', '900', '2h'. */
export function ttlToMs(ttl, fallbackMs = 900_000) {
  const value = String(ttl ?? '').trim();
  if (!value) return fallbackMs;
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/i.exec(value);
  if (!match) return fallbackMs;
  const amount = Number.parseInt(match[1], 10);
  const unit = (match[2] || 's').toLowerCase();
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return amount * factor;
}

/** ISO string for `seconds` from now — used for JWT `exp`. */
export function expFromTtl(ttl) {
  return Math.floor((Date.now() + ttlToMs(ttl)) / 1000);
}

/**
 * Parse an RFC 5322 `Date:` header.
 * Returns a Date, or null when unparseable.
 */
export function parseMailDate(value) {
  if (!value) return null;
  const raw = String(value).trim().replace(/\s+/g, ' ');

  const match =
    /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[A-Za-z]{1,3})?/.exec(
      raw,
    );
  if (!match) {
    const fallback = new Date(raw);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }

  const [, , dayRaw, monthRaw, yearRaw, hourRaw, minuteRaw, secondRaw, zoneRaw] = match;
  let year = Number.parseInt(yearRaw, 4);
  // RFC 5322 §4.3: two-digit years >= 50 are 19xx, otherwise 20xx.
  if (yearRaw.length === 2) year += year >= 50 ? 1900 : 2000;

  const monthIndex = [
    'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
  ].indexOf(monthRaw.toLowerCase());

  let zone = 'Z';
  if (zoneRaw) {
    zone = /^[+-]/.test(zoneRaw) ? zoneRaw : OBSOLETE_ZONES[zoneRaw.toLowerCase()] ?? 'Z';
  }

  const iso =
    `${String(year).padStart(4, '0')}-${String(monthIndex + 1).padStart(2, '0')}-` +
    `${String(Number.parseInt(dayRaw, 10)).padStart(2, '0')}T` +
    `${String(hourRaw).padStart(2, '0')}:${minuteRaw}:${secondRaw ?? '00'}` +
    (zone === 'Z' ? 'Z' : zone);

  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    const fallback = new Date(raw);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }
  // Guard against absurd timestamps from malformed headers.
  const yearOut = parsed.getUTCFullYear();
  if (yearOut < 1970 || yearOut > 2200) return new Date();
  return parsed;
}

/** Normalise a Date | string | null to an ISO string or null. */
export function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** UTC day boundary used for daily send quotas. */
export function startOfUtcDay(from = new Date()) {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
}

/** ISO timestamp for the start of the current UTC day. */
export function startOfUtcDayIso(from = new Date()) {
  return startOfUtcDay(from).toISOString();
}

/** ISO timestamp for `minutes` ago — the window start for hourly quotas. */
export function minutesAgoIso(minutes, from = new Date()) {
  return new Date(from.getTime() - minutes * 60_000).toISOString();
}

/** Format a byte count for display, e.g. 1.8 GB. */
export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[unitIndex]}`;
}

/** Clamp a number into a range. */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}