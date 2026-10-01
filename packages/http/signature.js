/**
 * Webhook signature verification (svix / Resend).
 *
 * Resend signs webhooks with an HMAC-SHA256 over
 *
 *     `${svix-id}.${svix-timestamp}.${rawBody}`
 *
 * and sends the result in `svix-signature` as `v1,<base64>` (possibly several
 * space-separated versions). Verification also enforces a 5-minute tolerance so
 * a captured request cannot be replayed indefinitely.
 */

import crypto from 'node:crypto';
import { AppError, Codes } from '../shared/errors.js';
import { safeEqual } from '../shared/ids.js';
import { logger } from '../shared/logger.js';

const DEFAULT_TOLERANCE_SECONDS = 300;
const SIGNATURE_VERSION = 'v1';

/** Base64-encode HMAC-SHA256 of `payload` with `secret`. */
function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64');
}

/**
 * Verify a svix-style webhook signature.
 *
 * @param {object} args
 * @param {Buffer|string} args.rawBody exact bytes the sender signed
 * @param {Record<string,string>} args.headers lowercase request headers
 * @param {string} args.secret webhook signing secret
 * @param {number} [args.toleranceSeconds=300]
 * @param {boolean} [args.allowStale=false] skip the timestamp window check
 * @returns {{verified: boolean, reason?: string}}
 */
export function verifyWebhookSignature({
  rawBody,
  headers = {},
  secret,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  allowStale = false,
}) {
  if (!secret) return { verified: false, reason: 'no_secret_configured' };

  const id = headers['svix-id'];
  const timestamp = headers['svix-timestamp'];
  const signatureHeader = headers['svix-signature'];

  if (!id || !timestamp || !signatureHeader) {
    return { verified: false, reason: 'missing_signature_headers' };
  }

  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampSeconds)) return { verified: false, reason: 'invalid_timestamp' };

  if (!allowStale) {
    const age = Math.abs(Date.now() / 1000 - timestampSeconds);
    if (age > toleranceSeconds) return { verified: false, reason: 'timestamp_outside_tolerance' };
  }

  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const expected = sign(secret, `${id}.${timestamp}.${payload.toString('utf8')}`);

  const candidates = String(signatureHeader)
    .split(' ')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SIGNATURE_VERSION},`))
    .map((part) => part.slice(SIGNATURE_VERSION.length + 1))
    .filter(Boolean);

  if (candidates.length === 0) return { verified: false, reason: 'no_matching_signature_version' };

  const matched = candidates.some((candidate) => safeEqual(candidate, expected));
  return matched ? { verified: true } : { verified: false, reason: 'signature_mismatch' };
}

/**
 * Verify and throw on failure.
 * @throws {AppError} 401 SIGNATURE_INVALID
 */
export function assertWebhookSignature(options) {
  const result = verifyWebhookSignature(options);
  if (result.verified) return true;

  logger.warn('Webhook signature rejected', { reason: result.reason });
  throw new AppError(Codes.SIGNATURE_INVALID, undefined, 401, {
    details: process.env.NODE_ENV === 'production' ? undefined : { reason: result.reason },
  });
}

/**
 * Build the header set Resend uses when POSTing to the inbound endpoint.
 * Exported so tests can generate a valid signature without duplicating the
 * algorithm.
 */
export function signWebhookPayload({ rawBody, id = 'msg_test', timestamp = Math.floor(Date.now() / 1000), secret }) {
  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const signature = sign(secret, `${id}.${timestamp}.${payload.toString('utf8')}`);
  return {
    'svix-id': id,
    'svix-timestamp': String(timestamp),
    'svix-signature': `${SIGNATURE_VERSION},${signature}`,
  };
}