/**
 * /api/admin — back-office.
 *
 *   overview · users · create-user · update-user · delete-user ·
 *   reset-user-password · mailboxes · create-mailbox · update-mailbox ·
 *   delete-mailbox · domains · create-domain · update-domain · delete-domain ·
 *   routes · create-route · update-route · delete-route · audit
 *
 * Role policy:
 *   • admins  — full control (create/disable users and mailboxes, domains,
 *               routing, view the audit trail).
 *   • managers — read-only oversight: overview, listings and the audit trail.
 *   • users   — nothing here; they use /api/mail and /api/send.
 *
 * Two rules are enforced on every mutation:
 *   1. The last remaining administrator cannot be removed or demoted, which
 *      would otherwise lock everyone out of the console with no way back.
 *   2. When an account is disabled, its sessions are revoked immediately.
 */

import { createHandler, queryInt } from '../packages/http/pipeline.js';
import { z } from 'zod';
import { withTransaction } from '../packages/db/pool.js';
import { AppError, Codes } from '../packages/shared/errors.js';
import { logger } from '../packages/shared/logger.js';
import { mail as mailConfig } from '../packages/shared/config.js';
import { requireAdmin, requireRole } from '../packages/auth/guard.js';
import { generatePassword, hashPassword, checkPasswordPolicy } from '../packages/auth/passwords.js';
import {
  countAdmins,
  createUser,
  deleteUser,
  findById,
  listUsers,
  updateUser,
} from '../packages/db/users.js';
import {
  createInboundRoute,
  createMailbox,
  deleteDomain,
  deleteInboundRoute,
  deleteMailbox,
  findDomainByName,
  findMailboxById,
  listAllMailboxes,
  listDomains,
  listInboundRoutes,
  listMailboxesForUser,
  ensureDefaultLabels,
  updateDomain,
  updateInboundRoute,
  updateMailbox,
  upsertDomain,
} from '../packages/db/mailboxes.js';
import {
  listAuditLogs,
  platformStats,
  pruneSessions,
  recentActivity,
  revokeAllSessions,
  usageSeries,
} from '../packages/db/system.js';
import { unlockUser } from '../packages/db/users.js';
import { sendWelcome } from '../packages/mail/templates.js';
import { deleteMailboxPrefixes } from '../packages/storage/attachments.js';
import {
  createMailboxSchema,
  createUserSchema,
  domainSchema,
  dnsRecordSchema,
  resetPasswordAdminSchema,
  routeSchema,
  updateMailboxSchema,
  updateUserSchema,
} from '../packages/validation/schemas.js';

const READ_ROLES = ['admin', 'manager'];

/** Guard every action with at least read access. */
function requireStaff(ctx) {
  return requireRole(ctx.session, READ_ROLES);
}

/** Guard mutations with full admin. */
function requireFullAdmin(ctx) {
  return requireAdmin(ctx.session);
}

/**
 * Refuse an operation that would leave the deployment with no administrator.
 */
async function assertNotLastAdmin(userId, { demoting = false } = {}) {
  const remaining = await countAdmins(demoting ? userId : null);
  if (remaining < 1) {
    throw new AppError(
      Codes.VALIDATION_ERROR,
      'This is the last administrator; promote someone else first.',
    );
  }
}

/** Shape a mailbox row for the console. */
function mailboxView(row) {
  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    domainId: row.domain_id,
    domain: row.domain_name ?? undefined,
    status: row.status,
    quotaBytes: Number(row.quota_bytes ?? 0),
    storageUsedBytes: Number(row.storage_used_bytes ?? 0),
    dailySendLimit: row.daily_send_limit,
    hourlySendLimit: row.hourly_send_limit,
    isPrimary: Boolean(row.is_primary),
    autoRead: Boolean(row.auto_read),
    replyTo: row.reply_to,
    createdAt: row.created_at,
  };
}

/** Shape a domain row for the console. */
function domainView(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    notes: row.notes ?? null,
    mailboxCount: Number(row.mailbox_count ?? 0),
    activeMailboxes: Number(row.active_mailboxes ?? 0),
    dnsRecords: row.dns_records ?? [],
    createdAt: row.created_at,
  };
}

/** Shape an inbound route row for the console. */
function routeView(row) {
  return {
    id: row.id,
    domainId: row.domain_id,
    pattern: row.pattern,
    mailboxId: row.mailbox_id ?? null,
    mailboxEmail: row.mailbox_email ?? null,
    action: row.action,
    priority: Number(row.priority ?? 0),
    note: row.note ?? null,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
  };
}

/** Shape an audit row for the console. */
function auditView(row) {
  return {
    id: row.id,
    actorEmail: row.actor_email ?? null,
    action: row.action,
    entityType: row.entity_type ?? null,
    entityId: row.entity_id ?? null,
    ip: row.ip ?? null,
    metadata: row.metadata ?? null,
    createdAt: row.created_at,
  };
}

/** Action name -> audit entry, for the mutations the console can perform. */
const AUDIT_ACTIONS = {
  'create-user': { action: 'admin.user.create', entityType: 'user' },
  'update-user': { action: 'admin.user.update', entityType: 'user' },
  'delete-user': { action: 'admin.user.delete', entityType: 'user' },
  'create-mailbox': { action: 'admin.mailbox.create', entityType: 'mailbox' },
  'update-mailbox': { action: 'admin.mailbox.update', entityType: 'mailbox' },
  'delete-mailbox': { action: 'admin.mailbox.delete', entityType: 'mailbox' },
  'create-domain': { action: 'admin.domain.create', entityType: 'domain' },
  'delete-domain': { action: 'admin.domain.delete', entityType: 'domain' },
  'delete-route': { action: 'admin.route.delete', entityType: 'route' },
};

/**
 * Exported so the handlers can be unit tested directly. createHandler() closes
 * over this map, so without the export there is no seam: the dashboard payload
 * contract could only be checked by deploying and signing in by hand, which is
 * how stats rendered as "[object Object]" and every activity date as
 * "Invalid Date" for so long.
 */
export const actions = {
    // ── Dashboard ───────────────────────────────────────────────────────────
    overview: {
      method: 'GET',
      auth: 'session',
      handler: async (ctx) => {
        requireStaff(ctx);
        const stats = await platformStats();
        return {
          // Flattened to what the console renders. platformStats() nests its counts
          // ({ users: { total, admins, active } }), so the tiles were handed an
          // object and printed "[object Object]", while storageBytes and the
          // send/receive counts — which exist in neither shape — silently read 0.
          stats: {
            users: stats.users.total,
            mailboxes: stats.mailboxes.total,
            messages: stats.messages.total,
            storageBytes: stats.messages.bytes,
            sentToday: stats.sentToday,
            receivedToday: stats.receivedToday,
          },
          usage: await usageSeries({ days: queryInt(ctx, 'days', { min: 1, max: 90, fallback: 14 }) }),
          // auditView, like every other admin action: recentActivity() returns raw
          // snake_case rows, so the console read a.actorEmail and a.createdAt as
          // undefined and printed "system" and "Invalid Date" for every entry.
          activity: (await recentActivity({ limit: 12 })).map(auditView),
        };
      },
    },

    // ── Users ───────────────────────────────────────────────────────────────
    users: {
      method: 'GET',
      auth: 'session',
      handler: async (ctx) => {
        requireStaff(ctx);
        const users = await listUsers({
          status: ctx.query.status || undefined,
          role: ctx.query.role || undefined,
          search: ctx.query.q || undefined,
          limit: queryInt(ctx, 'limit', { min: 1, max: 200, fallback: 50 }),
          offset: queryInt(ctx, 'offset', { min: 0, max: 100_000, fallback: 0 }),
        });

        // Attach each user's mailboxes so the console can show them inline.
        const withMailboxes = await Promise.all(
          users.map(async (user) => ({
            id: user.id,
            email: user.email,
            displayName: user.display_name,
            role: user.role,
            status: user.status,
            mustChangePassword: Boolean(user.must_change_password),
            lockedUntil: user.locked_until,
            failedLoginCount: Number(user.failed_login_count ?? 0),
            lastLoginAt: user.last_login_at,
            createdAt: user.created_at,
            mailboxes: (await listMailboxesForUser(user.id, { includeDisabled: true })).map(mailboxView),
          })),
        );

        return { users: withMailboxes };
      },
    },

    'create-user': {
      method: 'POST',
      body: 'json',
      auth: 'session',
      schema: createUserSchema,
      handler: async (ctx) => {
        requireFullAdmin(ctx);
        const body = ctx.body;

        // A supplied password must satisfy policy; an omitted one is generated
        // and delivered by email.
        let password = body.password;
        if (password) {
          checkPasswordPolicy(password);
        } else {
          password = generatePassword();
        }

        const passwordHash = await hashPassword(password);

        // User + primary mailbox are one unit of work: provisioning half of it
        // leaves an account that cannot receive mail and cannot be fixed by the
        // caller without a second request. Create both or neither.
        const domain = body.status !== 'disabled' ? await findDomainByName(mailConfig.domains[0]) : null;
        const { user, mailbox } = await withTransaction(async (tx) => {
          const created = await createUser(
            {
              email: body.email,
              passwordHash,
              displayName: body.displayName,
              role: body.role,
              status: body.status,
              mustChangePassword: body.mustChangePassword,
            },
            tx,
          );

          let primaryMailbox = null;
          if (domain) {
            primaryMailbox = await createMailbox(
              {
                userId: created.id,
                domainId: domain.id,
                email: body.email,
                displayName: body.displayName,
                status: 'active',
                isPrimary: true,
              },
              tx,
            );
            await ensureDefaultLabels(primaryMailbox.id, tx);
          }
          return { user: created, mailbox: primaryMailbox };
        });

        // Best-effort welcome email; a provider failure must not roll back the
        // account that was already created.
        const temporaryPassword = body.password ? null : password;
        if (body.status !== 'disabled') {
          await sendWelcome({ to: user.email, displayName: user.display_name, temporaryPassword }).catch((err) => {
            logger.warn('Welcome email failed', { error: err?.message, user: user.id });
          });
        }

        ctx.auditEntity = { type: 'user', id: user.id };
        return {
          user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role, status: user.status },
          mailbox: mailbox ? mailboxView(mailbox) : null,
          temporaryPassword,
        };
      },
    },

    'update-user': {
      method: 'PUT',
      body: 'json',
      auth: 'session',
      schema: updateUserSchema,
      handler: async (ctx) => {
        requireFullAdmin(ctx);
        const id = String(ctx.query.id || ctx.body.id || '').trim();
        if (!id) throw new AppError(Codes.VALIDATION_ERROR, 'A user id is required.');

        const user = await findById(id);
        if (!user) throw new AppError(Codes.NOT_FOUND, 'User not found.');

        const patch = {};
        if (ctx.body.displayName !== undefined) patch.displayName = ctx.body.displayName;
        if (ctx.body.status !== undefined) patch.status = ctx.body.status;
        if (ctx.body.role !== undefined) patch.role = ctx.body.role;
        if (ctx.body.unlock) {
          // Use the dedicated helper so failed-login counters are cleared and
          // audit trail consistency is preserved, in addition to unsetting the lock.
          await unlockUser(id);
          const updated = await findById(id);
          ctx.auditEntity = { type: 'user', id };
          return {
            user: {
              id: updated.id,
              email: updated.email,
              displayName: updated.display_name,
              role: updated.role,
              status: updated.status,
              mustChangePassword: Boolean(updated.must_change_password),
            },
          };
        }

        // Demoting the last admin is refused.
        if (ctx.body.role && ctx.body.role !== 'admin' && user.role === 'admin') {
          await assertNotLastAdmin(id, { demoting: true });
        }

        if (ctx.body.password) {
          checkPasswordPolicy(ctx.body.password);
          patch.passwordHash = await hashPassword(ctx.body.password);
          patch.mustChangePassword = true;
        }

        const updated = await updateUser(id, patch);

        // Changing a password or disabling an account kills its sessions.
        if (ctx.body.password || ctx.body.status === 'disabled') {
          await revokeAllSessions(id, 'admin_changed');
        }

        ctx.auditEntity = { type: 'user', id };
        return {
          user: {
            id: updated.id,
            email: updated.email,
            displayName: updated.display_name,
            role: updated.role,
            status: updated.status,
            mustChangePassword: Boolean(updated.must_change_password),
          },
        };
      },
    },

    'delete-user': {
      method: 'DELETE',
      auth: 'session',
      handler: async (ctx) => {
        requireFullAdmin(ctx);
        const id = String(ctx.query.id || '').trim();
        if (!id) throw new AppError(Codes.VALIDATION_ERROR, 'A user id is required.');
        if (id === ctx.session.user.id) {
          throw new AppError(Codes.VALIDATION_ERROR, 'You cannot delete your own account here.');
        }

        const user = await findById(id);
        if (!user) throw new AppError(Codes.NOT_FOUND, 'User not found.');
        if (user.role === 'admin') await assertNotLastAdmin(id, { demoting: true });

        await deleteUser(id);
        ctx.auditEntity = { type: 'user', id };
        return { deleted: true };
      },
    },

    'reset-user-password': {
      method: 'POST',
      body: 'json',
      auth: 'session',
      schema: resetPasswordAdminSchema,
      handler: async (ctx) => {
        requireFullAdmin(ctx);
        const id = String(ctx.query.id || '').trim();
        if (!id) throw new AppError(Codes.VALIDATION_ERROR, 'A user id is required.');

        const user = await findById(id);
        if (!user) throw new AppError(Codes.NOT_FOUND, 'User not found.');

        // Either set a known password or generate one and return it for the
        // administrator to pass on out of band.
        let password = ctx.body.password;
        if (password) {
          checkPasswordPolicy(password);
        } else {
          password = generatePassword();
        }

        const passwordHash = await hashPassword(password);
        await updateUser(id, { passwordHash, mustChangePassword: ctx.body.mustChangePassword });
        await revokeAllSessions(id, 'admin_reset_password');

        ctx.auditEntity = { type: 'user', id };
        return { reset: true, temporaryPassword: ctx.body.password ? null : password };
      },
    },

    // ── Mailboxes ───────────────────────────────────────────────────────────
    mailboxes: {
      method: 'GET',
      auth: 'session',
      handler: async (ctx) => {
        requireStaff(ctx);
        const rows = await listAllMailboxes({
          status: ctx.query.status || undefined,
          search: ctx.query.q || undefined,
          limit: queryInt(ctx, 'limit', { min: 1, max: 500, fallback: 100 }),
          offset: queryInt(ctx, 'offset', { min: 0, max: 100_000, fallback: 0 }),
        });
        return { mailboxes: rows.map(mailboxView) };
      },
    },

    'create-mailbox': {
      method: 'POST',
      body: 'json',
      auth: 'session',
      schema: createMailboxSchema,
      handler: async (ctx) => {
        requireFullAdmin(ctx);
        const body = ctx.body;

        const domainName = body.domain || mailConfig.domains[0];
        const domain = await findDomainByName(domainName);
        if (!domain) throw new AppError(Codes.VALIDATION_ERROR, `Unknown domain "${domainName}".`);
        const email = (body.email || `${body.localPart}@${domainName}`).toLowerCase();

        // Attach to an existing user, or optionally provision one.
        let userId = body.userId || null;
        if (!userId && body.createUser) {
          const password = body.password || generatePassword();
          const user = await createUser({
            email,
            passwordHash: await hashPassword(password),
            displayName: body.displayName,
            role: body.role,
            status: 'active',
            mustChangePassword: body.mustChangePassword,
          });
          userId = user.id;
          if (!body.password) {
            await sendWelcome({ to: email, displayName: body.displayName, temporaryPassword: password }).catch(() => {});
          }
        }
        if (!userId) {
          throw new AppError(Codes.VALIDATION_ERROR, 'Choose a user for this mailbox.');
        }

        const mailbox = await withTransaction(async (tx) => {
          // Only one primary mailbox per user.
          if (body.isPrimary) {
            await tx.query(`update public.mailboxes set is_primary = false where user_id = $1`, [userId]);
          }
          return createMailbox(
            {
              userId,
              domainId: domain.id,
              email,
              displayName: body.displayName,
              status: body.status,
              quotaBytes: body.quotaBytes,
              dailySendLimit: body.dailySendLimit,
              hourlySendLimit: body.hourlySendLimit,
              isPrimary: body.isPrimary,
            },
            tx,
          );
        });

        ctx.auditEntity = { type: 'mailbox', id: mailbox.id };
        return { mailbox: mailboxView(mailbox) };
      },
    },

    'update-mailbox': {
      method: 'PUT',
      body: 'json',
      auth: 'session',
      schema: updateMailboxSchema.extend({ id: z.string().trim().min(1).max(64).optional() }),
      handler: async (ctx) => {
        requireFullAdmin(ctx);
        const id = String(ctx.query.id || ctx.body.id || '').trim();
        if (!id) throw new AppError(Codes.VALIDATION_ERROR, 'A mailbox id is required.');

        const existing = await findMailboxById(id);
        if (!existing) throw new AppError(Codes.NOT_FOUND, 'Mailbox not found.');

        const patch = {};
        const map = {
          displayName: 'displayName',
          status: 'status',
          quotaBytes: 'quotaBytes',
          dailySendLimit: 'dailySendLimit',
          hourlySendLimit: 'hourlySendLimit',
          autoRead: 'autoRead',
          replyTo: 'replyTo',
          domainId: 'domainId',
        };
        for (const [key, column] of Object.entries(map)) {
          if (ctx.body[key] !== undefined) patch[column] = ctx.body[key];
        }
        if (ctx.body.signatureHtml !== undefined) patch.signatureHtml = ctx.body.signatureHtml;
        if (ctx.body.signatureText !== undefined) patch.signatureText = ctx.body.signatureText;

        // Promoting to primary demotes the user's current one, atomically.
        if (ctx.body.isPrimary === true) {
          await withTransaction(async (tx) => {
            await tx.query(`update public.mailboxes set is_primary = false where user_id = $1`, [existing.user_id]);
            await updateMailbox(id, { ...patch, isPrimary: true }, tx);
          });
        } else {
          if (ctx.body.isPrimary === false) patch.isPrimary = false;
          await updateMailbox(id, patch);
        }

        const mailbox = await findMailboxById(id);
        ctx.auditEntity = { type: 'mailbox', id };
        return { mailbox: mailboxView(mailbox) };
      },
    },

    'delete-mailbox': {
      method: 'DELETE',
      auth: 'session',
      handler: async (ctx) => {
        requireFullAdmin(ctx);
        const id = String(ctx.query.id || '').trim();
        if (!id) throw new AppError(Codes.VALIDATION_ERROR, 'A mailbox id is required.');

        // Clean up the mailbox's storage objects before dropping the rows.
        await deleteMailboxPrefixes(id).catch((err) => {
          logger.warn('Could not remove mailbox storage objects', { error: err?.message, mailbox: id });
        });

        await deleteMailbox(id);
        ctx.auditEntity = { type: 'mailbox', id };
        return { deleted: true };
      },
    },

    // ── Domains ─────────────────────────────────────────────────────────────
    domains: {
      method: 'GET',
      auth: 'session',
      handler: async (ctx) => {
        requireStaff(ctx);
        return { domains: (await listDomains()).map(domainView) };
      },
    },

    'create-domain': {
      method: 'POST',
      body: 'json',
      auth: 'session',
      schema: domainSchema,
      handler: async (ctx) => {
        requireFullAdmin(ctx);
        const domain = await upsertDomain({
          name: ctx.body.name,
          status: ctx.body.status,
          notes: ctx.body.notes,
          dnsRecords: [],
        });
        ctx.auditEntity = { type: 'domain', id: domain.id };
        return { domain };
      },
    },

    'update-domain': {
      method: 'PUT',
      body: 'json',
      auth: 'session',
      schema: domainSchema
        .extend({ id: z.string().trim().min(1).max(64).optional() })
        .extend({ dnsRecords: z.array(dnsRecordSchema).max(50).optional() })
        .omit({ name: true }),
      handler: async (ctx) => {
        requireFullAdmin(ctx);
        const id = String(ctx.body.id || ctx.query.id || '').trim();
        if (!id) throw new AppError(Codes.VALIDATION_ERROR, 'A domain id is required.');

        // Status, notes and the DNS record set are applied in one statement so
        // the domain is never left half-updated.
        const domain = await updateDomain(id, {
          status: ctx.body.status,
          notes: ctx.body.notes,
          dnsRecords: ctx.body.dnsRecords,
        });

        ctx.auditEntity = { type: 'domain', id };
        return { domain };
      },
    },

    'delete-domain': {
      method: 'DELETE',
      auth: 'session',
      handler: async (ctx) => {
        requireFullAdmin(ctx);
        const id = String(ctx.query.id || '').trim();
        if (!id) throw new AppError(Codes.VALIDATION_ERROR, 'A domain id is required.');
        await deleteDomain(id);
        ctx.auditEntity = { type: 'domain', id };
        return { deleted: true };
      },
    },

    // ── Inbound routing ─────────────────────────────────────────────────────
    routes: {
      method: 'GET',
      auth: 'session',
      handler: async (ctx) => {
        requireStaff(ctx);
        const domainId = String(ctx.query.domainId || '').trim();
        if (!domainId) throw new AppError(Codes.VALIDATION_ERROR, 'A domain id is required.');
        return { routes: (await listInboundRoutes(domainId)).map(routeView) };
      },
    },

    'create-route': {
      method: 'POST',
      body: 'json',
      auth: 'session',
      schema: routeSchema,
      handler: async (ctx) => {
        requireFullAdmin(ctx);
        const domainId = String(ctx.query.domainId || '').trim();
        if (!domainId) throw new AppError(Codes.VALIDATION_ERROR, 'A domain id is required.');

        // A deliver route needs a target mailbox; reject/bounce/discard do not.
        if (ctx.body.action === 'deliver' && !ctx.body.mailboxId) {
          throw new AppError(Codes.VALIDATION_ERROR, 'A deliver route needs a target mailbox.');
        }

        const route = await createInboundRoute({
          domainId,
          pattern: ctx.body.pattern,
          mailboxId: ctx.body.mailboxId,
          action: ctx.body.action,
          priority: ctx.body.priority,
          note: ctx.body.note,
        });
        ctx.auditEntity = { type: 'route', id: route.id };
        return { route };
      },
    },

    'update-route': {
      method: 'PUT',
      body: 'json',
      auth: 'session',
      schema: routeSchema
        .partial()
        .extend({ id: z.string().trim().min(1).max(64).optional(), isActive: z.boolean().optional() }),
      handler: async (ctx) => {
        requireFullAdmin(ctx);
        const id = String(ctx.query.id || ctx.body.id || '').trim();
        if (!id) throw new AppError(Codes.VALIDATION_ERROR, 'A route id is required.');
        const route = await updateInboundRoute(id, ctx.body);
        ctx.auditEntity = { type: 'route', id };
        return { route };
      },
    },

    'delete-route': {
      method: 'DELETE',
      auth: 'session',
      handler: async (ctx) => {
        requireFullAdmin(ctx);
        const id = String(ctx.query.id || '').trim();
        if (!id) throw new AppError(Codes.VALIDATION_ERROR, 'A route id is required.');
        await deleteInboundRoute(id);
        ctx.auditEntity = { type: 'route', id };
        return { deleted: true };
      },
    },

    // ── Audit trail ─────────────────────────────────────────────────────────
    audit: {
      method: 'GET',
      auth: 'session',
      handler: async (ctx) => {
        requireStaff(ctx);
        return {
          logs: (
            await listAuditLogs({
              actorId: ctx.query.actorId || undefined,
              action: ctx.query.action || undefined,
              entityType: ctx.query.entityType || undefined,
              limit: queryInt(ctx, 'limit', { min: 1, max: 200, fallback: 50 }),
              offset: queryInt(ctx, 'offset', { min: 0, max: 100_000, fallback: 0 }),
            })
          ).map(auditView),
        };
      },
    },
};

export default createHandler({
  name: 'admin',
  audit: AUDIT_ACTIONS,
  actions,
});