/**
 * Access tokens (short-lived JWTs) and refresh tokens (opaque, DB-backed).
 *
 * Two-token model:
 *   • access token  — 15-minute JWT, sent by the client as `Authorization:
 *     Bearer …`. Not stored server-side; its short lifetime bounds the damage
 *     if one leaks.
 *   • refresh token — 30-day opaque random string, stored only as a SHA-256
 *     hash in `sessions` and delivered in an httpOnly cookie. Rotated on every
 *     refresh so replay after use is detectable.
 */

import jwt from 'jsonwebtoken';
import { auth as authConfig } from '../shared/config.js';
import { AppError, Codes } from '../shared/errors.js';
import { newId, randomToken, sha256 } from '../shared/ids.js';
import { expFromTtl } from '../shared/dates.js';
import * as usersDb from '../db/users.js';
import * as systemDb from '../db/system.js';
import * as mailboxesDb from '../db/mailboxes.js';
import { logger } from '../shared/logger.js';

/**
 * Issue a short-lived access token.
 * @param {{id: string, email: string, role: string, displayName: string}} user
 * @param {{id: string|null, email: string}} [mailbox] the mailbox selected for this session
 * @param {string} [sessionId] ties the token to a session row for revocation
 */
export function signAccessToken(user, mailbox = null, sessionId = null) {
  const payload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    name: user.displayName,
    mailboxId: mailbox?.id ?? null,
    mailboxEmail: mailbox?.email ?? null,
    sid: sessionId,
  };

  return jwt.sign(payload, authConfig.jwtSecret(), {
    expiresIn: authConfig.accessTokenTtl,
    issuer: authConfig.issuer,
    audience: authConfig.audience,
    algorithm: 'HS256',
  });
}

/**
 * Verify an access token.
 * Throws AppError(401) for anything invalid, expired or malformed.
 * @returns {object} the decoded claims
 */
export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, authConfig.jwtSecret(), {
      issuer: authConfig.issuer,
      audience: authConfig.audience,
      algorithms: ['HS256'],
    });
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new AppError(Codes.AUTH_EXPIRED, undefined, 401, { cause: err });
    }
    throw new AppError(Codes.AUTH_INVALID, undefined, 401, { cause: err });
  }
}

/** Decode without verifying. Only for logging/diagnostics. */
export function decodeAccessToken(token) {
  try {
    return jwt.decode(token);
  } catch {
    return null;
  }
}

/**
 * Create a session: access token + refresh token + `sessions` row.
 *
 * @returns {{accessToken: string, accessTokenExpiresIn: number,
 *            refreshToken: string, sessionId: string,
 *            user: object, mailbox: object}}
 */
export async function issueSessionPair({
  user,
  mailbox = null,
  ip = null,
  userAgent = null,
  maxSessions = 5,
  ttlDays = authConfig.refreshTokenTtlDays,
}) {
  const refreshToken = `${randomToken(40)}.${randomToken(24)}`;
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000);

  const session = await systemDb.createSession({
    userId: user.id,
    mailboxId: mailbox?.id ?? null,
    token: refreshToken,
    ip,
    userAgent: userAgent ? String(userAgent).slice(0, 300) : null,
    expiresAt,
    maxSessions,
  });

  const accessToken = signAccessToken(user, mailbox, session.id);
  const accessTokenExpiresIn = Math.floor(
    parseAccessTokenTtl(authConfig.accessTokenTtl),
  );

  return {
    accessToken,
    accessTokenExpiresIn,
    refreshToken,
    sessionId: session.id,
    refreshExpiresAt: expiresAt.toISOString(),
    user,
    mailbox,
  };
}

/** Convert the configured TTL ('15m') to seconds. */
export function parseAccessTokenTtl(ttl) {
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/i.exec(String(ttl));
  if (!match) return 900;
  const amount = Number.parseInt(match[1], 10);
  const factor = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 }[(match[2] || 's').toLowerCase()];
  return amount * factor;
}

/**
 * Rotate a refresh token.
 *
 * The old token's session row is revoked and a new one created, so a stolen
 * refresh token is only usable until the legitimate client next refreshes.
 *
 * @param {string} refreshToken
 * @returns {{accessToken: string, refreshToken: string, sessionId: string, user: object, mailbox: object|null}}
 */
export async function rotateRefreshToken(refreshToken, { ip = null, userAgent = null, maxSessions = 5 } = {}) {
  if (!refreshToken) {
    throw new AppError(Codes.AUTH_REQUIRED, 'A refresh token is required.');
  }

  const tokenHash = sha256(refreshToken);
  const session = await systemDb.findActiveSessionByTokenHash(tokenHash);
  if (!session) {
    throw new AppError(Codes.SESSION_REVOKED, undefined, 401);
  }

  const user = await usersDb.findById(session.user_id);
  if (!user) {
    throw new AppError(Codes.AUTH_INVALID, 'Account no longer exists.', 401);
  }
  if (user.status !== 'active') {
    throw new AppError(Codes.ACCOUNT_DISABLED, undefined, 403);
  }

  // Rotate: revoke the presented token before minting its replacement.
  await systemDb.revokeSessionByTokenHash(tokenHash, 'rotated');

  const mailbox = session.mailbox_id
    ? await mailboxesDb.findMailboxById(session.mailbox_id)
    : null;

  const pair = await issueSessionPair({
    user,
    mailbox,
    ip,
    userAgent,
    maxSessions,
  });

  // Preserve the mailbox selection when the mailbox still exists.
  if (!mailbox && session.mailbox_id) {
    logger.warn('Session referenced a mailbox that no longer exists', {
      sessionId: session.id,
      mailboxId: session.mailbox_id,
    });
  }

  return pair;
}

/** Revoke the session behind a refresh token. Idempotent. */
export async function revokeByRefreshToken(refreshToken, reason = 'logout') {
  if (!refreshToken) return null;
  return systemDb.revokeSessionByTokenHash(sha256(refreshToken), reason);
}

/** Revoke every session for a user (password change, admin action). */
export async function revokeAllForUser(userId, reason = 'password_changed', exceptSessionId = null) {
  return systemDb.revokeAllSessions(userId, reason, exceptSessionId);
}

/**
 * Read one value from either a raw database row or an already-mapped camelCase
 * object, so this cannot depend on which caller it came from.
 *
 * Login and refresh both hand buildSessionPayload() the rows straight out of
 * users/mailboxes, where the columns are snake_case. This function used to read
 * only camelCase, so every one of those fields came out undefined: the topbar
 * fell back to the email address, and `mustChangePassword` arrived as
 * undefined, which the client reads as false — an account on a temporary
 * password reached the inbox without ever being made to change it. The
 * contract test missed it because its fixture was hand-written in camelCase
 * with a comment claiming it mirrored the login response.
 */
function field(row, snakeName, camelName) {
  return row?.[camelName] ?? row?.[snakeName];
}

/**
 * Build the public session payload returned to the client on login/refresh.
 * Contains no password hash, no token hashes and no internal ids beyond the
 * ones the UI legitimately needs.
 */
export function buildSessionPayload({ user, mailbox, accessToken, accessTokenExpiresIn, refreshExpiresAt, mailboxes = [] }) {
  return {
    token: accessToken,
    expiresIn: accessTokenExpiresIn,
    refreshExpiresAt,
    user: {
      id: user.id,
      email: user.email,
      displayName: field(user, 'display_name', 'displayName') ?? null,
      role: user.role,
      status: user.status,
      mustChangePassword: Boolean(field(user, 'must_change_password', 'mustChangePassword')),
      lastLoginAt: field(user, 'last_login_at', 'lastLoginAt') ?? null,
      preferences: user.preferences ?? {},
    },
    mailbox: mailbox
      ? {
          id: mailbox.id,
          email: mailbox.email,
          displayName: field(mailbox, 'display_name', 'displayName') ?? null,
          domain: mailbox.domain,
          status: mailbox.status,
          quotaBytes: Number(field(mailbox, 'quota_bytes', 'quotaBytes') ?? 0),
          storageUsedBytes: Number(field(mailbox, 'storage_used_bytes', 'storageUsedBytes') ?? 0),
          signatureHtml: field(mailbox, 'signature_html', 'signatureHtml') ?? null,
          signatureText: field(mailbox, 'signature_text', 'signatureText') ?? null,
          autoRead: Boolean(field(mailbox, 'auto_read', 'autoRead')),
        }
      : null,
    mailboxes: mailboxes.map((entry) => ({
      id: entry.id,
      email: entry.email,
      displayName: field(entry, 'display_name', 'displayName') ?? null,
      status: entry.status,
      isPrimary: Boolean(field(entry, 'is_primary', 'isPrimary')),
      domain: entry.domain,
    })),
  };
}

/** Decode an access token and return its claims, or null. */
export function readClaims(token) {
  if (!token) return null;
  const decoded = decodeAccessToken(token);
  if (!decoded || typeof decoded !== 'object') return null;
  return decoded;
}

/** Absolute expiry of an access token, for the client-side refresh timer. */
export function accessTokenExpiresAt() {
  return new Date(expFromTtl(authConfig.accessTokenTtl) * 1000).toISOString();
}

export { newId };