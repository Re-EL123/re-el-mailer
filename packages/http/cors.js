/**
 * CORS handling.
 *
 * An explicit allowlist of origins — never `*` with credentials. Browsers cache
 * preflight results, so allowed origins are cached for an hour; disallowed
 * origins get no CORS headers at all, which makes the browser block the
 * response.
 *
 * Because the frontend (mail.re-el.co.za) and the API (api.mail.re-el.co.za)
 * share the registrable domain re-el.co.za, requests are same-*site*, so
 * `SameSite=Lax` cookies work and the strictest practical policy applies.
 */

import { app } from '../shared/config.js';

const PREFLIGHT_MAX_AGE = 3600;
const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, Authorization, X-Requested-With, X-Request-Id';

/** Normalise an Origin header for comparison (lowercase, no trailing slash). */
function normalizeOrigin(origin) {
  if (!origin) return null;
  const value = String(origin).trim().replace(/\/+$/, '');
  return value.toLowerCase();
}

const ALLOWED = new Set(app.allowedOrigins.map(normalizeOrigin).filter(Boolean));

/** True when the request's Origin is on the allowlist. */
export function isOriginAllowed(req) {
  const origin = normalizeOrigin(req.headers?.origin);
  // Same-origin / server-to-server requests carry no Origin header. Allowing
  // them is safe: CORS only constrains browser-initiated requests.
  if (!origin) return true;
  if (ALLOWED.has(origin)) return true;

  // Allow localhost in any port form during development.
  if (process.env.NODE_ENV !== 'production') {
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
  }
  return false;
}

/**
 * Apply CORS headers for a normal (non-preflight) response.
 * @returns {boolean} false when the origin is not allowed
 */
export function applyCors(req, res) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  if (!isOriginAllowed(req)) return false;

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');
  return true;
}

/**
 * Answer a preflight request.
 * @returns {boolean} true when the request was handled
 */
export function handlePreflight(req, res) {
  if (req.method !== 'OPTIONS') return false;

  const origin = req.headers?.origin;
  const allowed = isOriginAllowed(req);

  if (origin && allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
  res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After');
  res.setHeader('Access-Control-Max-Age', String(PREFLIGHT_MAX_AGE));

  res.writeHead(allowed ? 204 : 403, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(allowed ? '' : 'Origin not allowed');
  return true;
}