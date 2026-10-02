/**
 * POST /api/auth
 *
 * Every authentication action, selected by `?action=`:
 *
 *   login · logout · refresh · session · forgot · reset · change-password ·
 *   preferences · update-preferences · sessions · revoke-session
 *
 * One function for all of them because the Vercel Hobby plan allows twelve
 * functions in total and these all need the same session machinery.
 *
 * Session model: a 15-minute access JWT for API calls, plus a long-lived opaque
 * refresh token in an httpOnly cookie. Refresh rotates the token, and every
 * access token is checked against the `sessions` table so a logout actually
 * ends access instead of waiting for the JWT to expire.
 */

import { createHandler } from '../packages/http/pipeline.js';
import { clearRefreshCookieHeader, readCookie, refreshCookieHeader } from '../packages/auth/guard.js';
import {
  buildSessionPayload,
  issueSessionPair,
  revokeAllForUser,
  revokeByRefreshToken,
  rotateRefreshToken,
} from '../packages/auth/tokens.js';
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../packages/auth/passwords.js';
import { findMailboxById, listMailboxesForUser } from '../packages/db/mailboxes.js';
import {
  createPasswordReset,
  findByEmail,
  findCredentialById,
  findPasswordResetByHash,
  recordFailedLogin,
  recordLogin,
  updateUser,
} from '../packages/db/users.js';
import { audit, listActiveSessions, revokeSessionById } from '../packages/db/system.js';
import { z } from 'zod';
import { AppError, Codes } from '../packages/shared/errors.js';
import { auth as authConfig, env, rateLimit } from '../packages/shared/config.js';
import { logger } from '../packages/shared/logger.js';
import { sha256 } from '../packages/shared/ids.js';
import { sendPasswordReset } from '../packages/mail/templates.js';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
  updatePreferencesSchema,
} from '../packages/validation/schemas.js';

/**
 * A hash to verify against when the address is unknown, so the response time is
 * the same whether or not an account exists.
 */
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.fDs6k6fPJm5F6wFVvIi9v2Uu0WjaD0uW';

/** Public shape of a user row. */
function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    status: user.status,
    mustChangePassword: Boolean(user.must_change_password),
    lastLoginAt: user.last_login_at,
    preferences: user.preferences ?? {},
  };
}

/** Public shape of a mailbox row. */
function publicMailbox(mailbox) {
  if (!mailbox) return null;
  return {
    id: mailbox.id,
    email: mailbox.email,
    displayName: mailbox.display_name,
    domain: mailbox.domain,
    status: mailbox.status,
    isPrimary: Boolean(mailbox.is_primary),
    quotaBytes: Number(mailbox.quota_bytes ?? 0),
    storageUsedBytes: Number(mailbox.storage_used_bytes ?? 0),
    signatureHtml: mailbox.signature_html,
    signatureText: mailbox.signature_text,
    replyTo: mailbox.reply_to,
    autoRead: Boolean(mailbox.auto_read),
  };
}

/** The list of mailboxes a client may switch between. */
async function mailboxesFor(userId) {
  const rows = await listMailboxesForUser(userId);
  return rows.map(publicMailbox);
}

/**
 * Choose the mailbox a login lands on: the requested one, the one whose address
 * was typed, else the caller's primary.
 */
async function resolveLoginMailbox(user, { mailboxId, email }) {
  if (mailboxId) {
    const mailbox = await findMailboxById(mailboxId);
    if (!mailbox || mailbox.user_id !== user.id) {
      throw new AppError(Codes.VALIDATION_ERROR, 'That mailbox is not available on this account.');
    }
    return mailbox;
  }

  const own = await listMailboxesForUser(user.id);
  const usable = own.filter((mailbox) => mailbox.status === 'active' || mailbox.status === 'read_only');
  if (usable.length === 0) {
    throw new AppError(
      Codes.MAILBOX_FORBIDDEN,
      'This account has no active mailbox yet. Ask an administrator to create one.',
      403,
    );
  }
  const typed = email ? own.find((mailbox) => mailbox.email.toLowerCase() === email.toLowerCase()) : null;
  return typed || usable.find((mailbox) => mailbox.is_primary) || usable[0];
}

/** Sign in, and set the refresh cookie. */
async function establishSession(ctx, { user, mailbox, ttlDays }) {
  const pair = await issueSessionPair({
    user,
    mailbox,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    ttlDays,
  });

  ctx.setHeader('Set-Cookie', refreshCookieHeader(pair.refreshToken, { expiresAt: pair.refreshExpiresAt }));

  const mailboxes = await mailboxesFor(user.id);
  return buildSessionPayload({ ...pair, user, mailbox, mailboxes });
}

/**
 * Exported so the handlers can be unit tested directly. createHandler() closes
 * over this map, so without the export there is no seam: a wrong branch in a
 * login path can only be discovered by deploying and signing in by hand.
 */
export const actions = {
  // ── Sign in ─────────────────────────────────────────────────────────────
  login: {
      method: 'POST',
      body: 'json',
      schema: loginSchema,
      // Per-bucket brute-force protection: the bucket key mixes the client IP
      // with the address, so an attacker cannot lock a real user out of their
      // own login by guessing at it.
      rateLimit: rateLimit.maxAuthAttempts,
      rateLimitWindow: 300,
      handler: async (ctx) => {
        const { email, password, mailboxId, remember } = ctx.body;

        const account = await findByEmail(email);
        const valid = await verifyPassword(password, account?.password_hash ?? DUMMY_HASH);

        if (!account || !valid) {
          if (account) {
            const result = await recordFailedLogin(account.id, { maxAttempts: 10, lockoutMinutes: 15 });
            if (result?.locked) {
              throw new AppError(Codes.ACCOUNT_LOCKED, undefined, 423, { details: { retryAfterMinutes: 15 } });
            }
          } else {
            logger.warn('Login attempt for an unknown address', { ip: ctx.ip, requestId: ctx.requestId });
          }
          throw new AppError(Codes.AUTH_INVALID, undefined, 401);
        }

        if (account.status !== 'active') {
          throw new AppError(
            Codes.ACCOUNT_DISABLED,
            account.status === 'pending' ? 'This account has not been activated yet.' : undefined,
            403,
          );
        }
        if (account.locked_until && new Date(account.locked_until) > new Date()) {
          throw new AppError(Codes.ACCOUNT_LOCKED, undefined, 423, {
            details: { lockedUntil: new Date(account.locked_until).toISOString() },
          });
        }

        const ttlDays = remember ? authConfig.refreshTokenTtlDays : 1;

        // A user who must change their password still gets a session; the client
        // routes them to the change-password screen and blocks everything else.
        if (account.must_change_password) {
          const payload = await establishSession(ctx, { user: account, mailbox: null, ttlDays });
          // Record the login here too. This branch returned before
          // recordLogin(), so an account on a temporary password — which is what
          // create-admin produces — accumulated sessions while last_login_at
          // stayed null, making "never signed in" the permanent answer in admin.
          await recordLogin(account.id);
          ctx.log.info('Signed in with a forced password change', { userId: account.id });
          return { ...payload, mustChangePassword: true };
        }

        const mailbox = await resolveLoginMailbox(account, { mailboxId, email });
        const payload = await establishSession(ctx, { user: account, mailbox, ttlDays });
        await recordLogin(account.id);
        ctx.log.info('Signed in', { userId: account.id, mailbox: mailbox.email });

        return payload;
      },
    },

    // ── Sign out ────────────────────────────────────────────────────────────
    logout: {
      method: 'POST',
      body: 'json',
      handler: async (ctx) => {
        const refreshToken = ctx.body.refreshToken || readCookie(ctx.req);
        if (refreshToken) {
          await revokeByRefreshToken(refreshToken, 'logout');
        }
        // Both sides: the client drops its copy, the browser drops the cookie.
        ctx.setHeader('Set-Cookie', clearRefreshCookieHeader());
        return { signedOut: true };
      },
    },

    // ── Refresh ─────────────────────────────────────────────────────────────
    refresh: {
      method: 'POST',
      body: 'json',
      rateLimit: 60,
      rateLimitWindow: 300,
      handler: async (ctx) => {
        const refreshToken = ctx.body.refreshToken || readCookie(ctx.req);
        if (!refreshToken) {
          throw new AppError(Codes.AUTH_REQUIRED, 'No refresh token was provided.', 401);
        }

        const rotated = await rotateRefreshToken(refreshToken, { ip: ctx.ip, userAgent: ctx.userAgent });

        ctx.setHeader(
          'Set-Cookie',
          refreshCookieHeader(rotated.refreshToken, { expiresAt: rotated.refreshExpiresAt }),
        );

        const mailboxes = await mailboxesFor(rotated.user.id);
        return buildSessionPayload({ ...rotated, mailboxes });
      },
    },

    // ── Who am I ────────────────────────────────────────────────────────────
    session: {
      method: 'GET',
      auth: 'session',
      handler: async (ctx) => ({
        user: publicUser(ctx.session.user),
        mailbox: publicMailbox(ctx.session.mailbox),
        mailboxes: await mailboxesFor(ctx.session.user.id),
        sessionId: ctx.session.sessionId,
        issuedAt: ctx.session.claims.iat ? new Date(ctx.session.claims.iat * 1000).toISOString() : null,
      }),
    },

    // ── Forgot password ─────────────────────────────────────────────────────
    forgot: {
      method: 'POST',
      body: 'json',
      schema: forgotPasswordSchema,
      rateLimit: 5,
      rateLimitWindow: 900,
      handler: async (ctx) => {
        const account = await findByEmail(ctx.body.email);

        // The answer is the same either way: whether an address is registered is
        // not public information.
        if (account && account.status === 'active') {
          const reset = await createPasswordReset(account.id, {
            ttlMinutes: authConfig.passwordResetTtlMinutes,
            ip: ctx.ip,
          });

          if (reset?.token) {
            try {
              await sendPasswordReset({
                to: account.email,
                displayName: account.display_name,
                token: reset.token,
                ttlMinutes: authConfig.passwordResetTtlMinutes,
              });
            } catch (err) {
              // A provider outage must not tell the caller the account exists.
              logger.exception('Could not send the password reset email', err, { userId: account.id });
            }
          }

          await audit({
            actorId: account.id,
            action: 'auth.password_reset_requested',
            entityType: 'user',
            entityId: account.id,
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });

          // Outside production the token is returned so the flow can be tested
          // without an email provider. Never in production.
          if (!env.isProduction) {
            return { sent: true, devToken: reset?.token ?? null };
          }
        }

        return { sent: true };
      },
    },

    // ── Complete a reset ────────────────────────────────────────────────────
    reset: {
      method: 'POST',
      body: 'json',
      schema: resetPasswordSchema,
      rateLimit: 10,
      rateLimitWindow: 900,
      handler: async (ctx) => {
        const record = await findPasswordResetByHash(sha256(ctx.body.token));
        if (!record) {
          throw new AppError(Codes.AUTH_INVALID, 'That reset link is invalid or has expired.', 400);
        }

        const policy = checkPasswordPolicy(ctx.body.password);
        if (!policy.ok) {
          throw new AppError(Codes.VALIDATION_ERROR, policy.message, 400, { details: policy });
        }

        await updateUser(record.user_id, {
          passwordHash: await hashPassword(ctx.body.password),
          mustChangePassword: false,
        });

        // A reset invalidates every existing session, including the attacker's.
        await revokeAllForUser(record.user_id, 'password_reset');
        await audit({
          actorId: record.user_id,
          action: 'auth.password_reset',
          entityType: 'user',
          entityId: record.user_id,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        return { reset: true };
      },
    },

    // ── Change password while signed in ─────────────────────────────────────
    'change-password': {
      method: 'POST',
      body: 'json',
      auth: 'session',
      schema: changePasswordSchema,
      rateLimit: 10,
      rateLimitWindow: 900,
      handler: async (ctx) => {
        const { user } = ctx.session;

        // The session carries the public user projection, which has no
        // password_hash. Comparing against it meant comparing bcrypt against
        // undefined, so every correct password was reported as incorrect.
        const credential = await findCredentialById(user.id);
        if (!credential) {
          throw new AppError(Codes.AUTH_REQUIRED, 'Your session is no longer valid.', 401);
        }

        const valid = await verifyPassword(ctx.body.currentPassword, credential.password_hash);
        if (!valid) {
          throw new AppError(Codes.AUTH_INVALID, 'Your current password is not correct.', 400);
        }
        if (await verifyPassword(ctx.body.newPassword, credential.password_hash)) {
          throw new AppError(Codes.VALIDATION_ERROR, 'Choose a password you have not used before.', 400);
        }

        const policy = checkPasswordPolicy(ctx.body.newPassword);
        if (!policy.ok) {
          throw new AppError(Codes.VALIDATION_ERROR, policy.message, 400, { details: policy });
        }

        await updateUser(user.id, {
          passwordHash: await hashPassword(ctx.body.newPassword),
          mustChangePassword: false,
        });

        if (ctx.body.revokeOtherSessions) {
          await revokeAllForUser(user.id, 'password_changed', ctx.session.sessionId);
        }
        return { changed: true, otherSessionsRevoked: Boolean(ctx.body.revokeOtherSessions) };
      },
    },

    // ── Preferences ─────────────────────────────────────────────────────────
    preferences: {
      method: 'GET',
      auth: 'session',
      handler: async (ctx) => ({ preferences: ctx.session.user.preferences ?? {} }),
    },

    'update-preferences': {
      method: 'PUT',
      body: 'json',
      auth: 'session',
      schema: updatePreferencesSchema,
      handler: async (ctx) => {
        const { user } = ctx.session;
        const merged = { ...(user.preferences ?? {}), ...ctx.body.preferences };
        const updated = await updateUser(user.id, { preferences: merged });
        return { preferences: updated.preferences ?? merged };
      },
    },

    // ── Active sessions ─────────────────────────────────────────────────────
    sessions: {
      method: 'GET',
      auth: 'session',
      handler: async (ctx) => {
        const rows = await listActiveSessions(ctx.session.user.id);
        return {
          sessions: rows.map((row) => ({
            id: row.id,
            ip: row.ip,
            userAgent: row.user_agent,
            createdAt: row.created_at,
            lastUsedAt: row.last_used_at,
            expiresAt: row.expires_at,
            current: row.id === ctx.session.sessionId,
          })),
        };
      },
    },

    'revoke-session': {
      method: 'POST',
      body: 'json',
      auth: 'session',
      schema: z.object({ sessionId: z.string().trim().min(1).max(64) }),
      handler: async (ctx) => {
        const id = ctx.body.sessionId;

        // Ownership check: a user may only revoke their own sessions.
        const owned = await listActiveSessions(ctx.session.user.id);
        if (!owned.some((row) => row.id === id)) {
          throw new AppError(Codes.NOT_FOUND, 'That session is not active.');
        }

        await revokeSessionById(id, 'user_revoked');
        return { revoked: true, wasCurrent: id === ctx.session.sessionId };
      },
    },
};

export default createHandler({
  name: 'auth',
  audit: {
    login: {
      action: 'auth.login',
      entityType: 'user',
      entityId: (data) => data?.user?.id ?? null,
      metadata: (data, ctx) => ({ mailbox: data?.mailbox?.email ?? null, ip: ctx.ip }),
    },
    logout: { action: 'auth.logout', entityType: 'user' },
    'change-password': { action: 'auth.password_changed', entityType: 'user' },
    'revoke-session': { action: 'auth.session_revoked', entityType: 'session' },
  },
  actions,
});
