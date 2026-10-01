/**
 * Request authentication and authorisation guards.
 *
 * Every protected endpoint calls `requireSession()`, which resolves the caller
 * from the access token and confirms the matching session row is still live.
 * The session check is what makes revocation possible: a JWT alone cannot be
 * withdrawn before it expires.
 */

import { AppError, Codes } from '../shared/errors.js';
import { auth as authConfig } from '../shared/config.js';
import * as usersDb from '../db/users.js';
import * as mailboxesDb from '../db/mailboxes.js';
import * as systemDb from '../db/system.js';
import { verifyAccessToken } from './tokens.js';

const BEARER_PATTERN = /^Bearer\s+(.+)$/i;

/** Extract a bearer token from the Authorization header. */
export function bearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization;
  if (typeof header !== 'string') return null;
  const match = BEARER_PATTERN.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** Extract the refresh token from the request cookie jar. */
export function readCookie(req, name = authConfig.cookieName) {
  const header = req.headers?.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/** Build the Set-Cookie value for the refresh token. */
export function refreshCookieHeader(token, { expiresAt, secure = authConfig.cookieSecure } = {}) {
  const parts = [
    `${authConfig.cookieName}=${encodeURIComponent(token)}`,
    'Path=/api/auth',
    'HttpOnly',
    `SameSite=${authConfig.cookieSameSite === 'none' ? 'None' : capitalize(authConfig.cookieSameSite)}`,
  ];
  if (secure) parts.push('Secure');
  if (expiresAt) parts.push(`Expires=${new Date(expiresAt).toUTCString()}`);
  return parts.join('; ');
}

/** Build the Set-Cookie value that clears the refresh cookie. */
export function clearRefreshCookieHeader() {
  const parts = [
    `${authConfig.cookieName}=`,
    'Path=/api/auth',
    'HttpOnly',
    `SameSite=${authConfig.cookieSameSite === 'none' ? 'None' : capitalize(authConfig.cookieSameSite)}`,
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Max-Age=0',
  ];
  if (authConfig.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Resolve the caller from the request.
 *
 * Every protected request performs three checks:
 *   1. the access token signature and expiry,
 *   2. that the session row named by `sid` is still active (revocation),
 *   3. that the user and mailbox rows are still usable.
 *
 * @returns {{user: object, mailbox: object|null, claims: object,
 *            sessionId: string|null, token: string}}
 * @throws {AppError} 401/403 when the caller may not proceed
 */
export async function requireSession(req) {
  const token = bearerToken(req);
  if (!token) {
    throw new AppError(Codes.AUTH_REQUIRED, undefined, 401);
  }

  const claims = verifyAccessToken(token);

  // Revocation check. Tokens issued before this table existed have no `sid`;
  // they are rejected rather than trusted.
  const session = await systemDb.findActiveSessionById(claims.sid);
  if (!session) {
    throw new AppError(Codes.SESSION_REVOKED, undefined, 401);
  }
  if (session.user_id !== claims.sub) {
    throw new AppError(Codes.AUTH_INVALID, undefined, 401);
  }

  const user = await usersDb.findById(claims.sub);
  if (!user) {
    throw new AppError(Codes.AUTH_INVALID, 'Account no longer exists.', 401);
  }
  if (user.status === 'disabled') {
    throw new AppError(Codes.ACCOUNT_DISABLED, undefined, 403);
  }
  if (user.status === 'pending') {
    throw new AppError(Codes.ACCOUNT_DISABLED, 'This account is not active yet.', 403);
  }

  await systemDb.touchSession(session.id);

  let mailbox = null;
  if (claims.mailboxId) {
    mailbox = await mailboxesDb.findMailboxById(claims.mailboxId);
    if (mailbox && mailbox.user_id !== user.id) {
      throw new AppError(Codes.MAILBOX_FORBIDDEN, undefined, 403);
    }
    if (mailbox && mailbox.status === 'disabled') {
      throw new AppError(Codes.ACCOUNT_DISABLED, 'This mailbox has been disabled.', 403);
    }
  }

  return { user, mailbox, claims, sessionId: session.id, token };
}

/** Require one of the given roles. */
export function requireRole(session, roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  if (!allowed.includes(session.user.role)) {
    throw new AppError(
      allowed.includes('admin') ? Codes.ADMIN_REQUIRED : Codes.FORBIDDEN,
      undefined,
      403,
    );
  }
  return session;
}

/** Require administrator role. */
export function requireAdmin(session) {
  if (session.user.role !== 'admin') {
    throw new AppError(Codes.ADMIN_REQUIRED, undefined, 403);
  }
  return session;
}

/** True for administrators and managers. */
export function isManager(user) {
  return user?.role === 'admin' || user?.role === 'manager';
}

/**
 * Resolve the mailbox an action targets and assert the caller may use it.
 *
 * Rules:
 *   • `mailboxId` omitted → the session mailbox, else the caller's primary.
 *   • admin/manager → any mailbox.
 *   • user → only mailboxes they own.
 *
 * @returns {Promise<object>} the mailbox row
 */
export async function requireMailbox(session, requestedId = null) {
  const { user } = session;

  let mailbox = null;
  if (requestedId) {
    mailbox = await mailboxesDb.findMailboxById(requestedId);
    if (!mailbox) throw new AppError(Codes.NOT_FOUND, 'Mailbox not found.');
    if (mailbox.user_id !== user.id && !isManager(user)) {
      throw new AppError(Codes.MAILBOX_FORBIDDEN, undefined, 403);
    }
  } else if (session.mailbox?.id) {
    mailbox = session.mailbox;
  } else {
    const own = await mailboxesDb.listMailboxesForUser(user.id);
    mailbox = own.find((entry) => entry.isPrimary) || own[0] || null;
    if (!mailbox) {
      throw new AppError(
        Codes.MAILBOX_FORBIDDEN,
        'You do not have a mailbox yet. Ask an administrator to create one.',
        403,
      );
    }
  }

  if (mailbox.status === 'disabled') {
    throw new AppError(Codes.ACCOUNT_DISABLED, 'This mailbox has been disabled.', 403);
  }
  return mailbox;
}

/** Assert the mailbox may send outbound mail. */
export function assertCanSend(mailbox, user) {
  if (mailbox.status === 'read_only') {
    throw new AppError(Codes.FORBIDDEN, 'This mailbox is read-only.');
  }
  if (mailbox.status !== 'active') {
    throw new AppError(Codes.ACCOUNT_DISABLED, 'This mailbox is not active.');
  }
  if (user.status !== 'active') {
    throw new AppError(Codes.ACCOUNT_DISABLED, undefined, 403);
  }
  return mailbox;
}

/** Client IP, honouring a single trusted proxy hop. */
export function clientIp(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim().slice(0, 60);
  }
  return String(req.headers?.['x-real-ip'] || req.socket?.remoteAddress || '').slice(0, 60) || null;
}

/** User agent, truncated for storage. */
export function userAgent(req) {
  const value = req.headers?.['user-agent'];
  return typeof value === 'string' ? value.slice(0, 300) : null;
}