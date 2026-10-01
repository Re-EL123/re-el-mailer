/**
 * /api/health — liveness, readiness and scheduled maintenance.
 *
 *   ping         — cheap unauthenticated liveness probe (used by uptime checks).
 *   status       — detailed per-dependency health for admins.
 *   maintenance  — purge/prune, callable by an admin or by Vercel Cron.
 *
 * The `ping` action deliberately reports only a coarse ok/degraded flag and
 * never which dependency failed, so an unauthenticated caller learns nothing
 * about the deployment's internals. `status` requires a session and only admits
 * admins and managers.
 */

import { createHandler } from '../packages/http/pipeline.js';
import { query, queryOne } from '../packages/db/pool.js';
import { AppError, Codes } from '../packages/shared/errors.js';
import { logger } from '../packages/shared/logger.js';
import { cron as cronConfig, mail as mailConfig } from '../packages/shared/config.js';
import { safeEqual } from '../packages/shared/ids.js';
import { requireRole, requireSession } from '../packages/auth/guard.js';
import { deleteAttachments, storageHealth } from '../packages/storage/attachments.js';
import { storagePathsPendingPurge } from '../packages/db/messages.js';
import { clearRateLimits, getSetting, pruneSessions } from '../packages/db/system.js';

/** Check that the cron bearer token matches, if one is configured. */
function assertCronAuthorised(ctx) {
  const expected = cronConfig.secret();
  if (!expected) {
    throw new AppError(
      Codes.FORBIDDEN,
      'Scheduled maintenance is not configured on this deployment.',
      403,
    );
  }
  const header = String(ctx.req.headers?.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !safeEqual(token, expected)) {
    throw new AppError(Codes.FORBIDDEN, 'A valid scheduler token is required.', 403);
  }
}

export default createHandler({
  name: 'health',

  actions: {
    // ── Liveness probe ──────────────────────────────────────────────────────
    ping: {
      method: 'GET',
      auth: 'none',
      handler: async () => {
        // The database is the only dependency whose absence makes the API
        // useless; storage and the provider are reported through /status.
        let ok = true;
        try {
          await query('select 1');
        } catch {
          ok = false;
        }
        return { ok, status: ok ? 'healthy' : 'degraded', time: new Date().toISOString() };
      },
    },

    // ── Detailed health ─────────────────────────────────────────────────────
    status: {
      method: 'GET',
      auth: 'session',
      handler: async (ctx) => {
        requireRole(ctx.session, ['admin', 'manager']);

        const startedAt = Date.now();
        let databaseOk = true;
        let latencyMs = null;
        try {
          const t0 = Date.now();
          await query('select 1');
          latencyMs = Date.now() - t0;
        } catch {
          databaseOk = false;
        }

        const storage = await storageHealth();
        const resendConfigured = Boolean(process.env.RESEND_API_KEY);
        const inboundConfigured = Boolean(mailConfig.inboundWebhookSecret());
        const eventConfigured = Boolean(mailConfig.eventWebhookSecret());

        return {
          ok: databaseOk,
          uptimeSeconds: Math.round(process.uptime()),
          checkedInMs: Date.now() - startedAt,
          checks: {
            database: { ok: databaseOk, latencyMs },
            storage: { ok: storage.ok, bucket: storage.bucket, error: storage.error },
            resend: { ok: resendConfigured, configured: resendConfigured },
            webhooks: { inbound: inboundConfigured, events: eventConfigured },
            scheduler: { ok: Boolean(cronConfig.secret()), configured: Boolean(cronConfig.secret()) },
          },
        };
      },
    },

    // ── Scheduled maintenance ───────────────────────────────────────────────
    maintenance: {
      method: 'POST',
      body: 'json',
      auth: 'none',
      handler: async (ctx) => {
        // Called either by an admin session or by Vercel Cron's bearer token.
        // This action is `auth: 'none'` so the cron can call it without a login,
        // which means the pipeline does not populate ctx.session. When the caller
        // identifies as an admin we resolve the session here and authorise it.
        let via = 'cron';
        if (ctx.query.admin === '1') {
          const session = await requireSession(ctx.req);
          requireRole(session, ['admin']);
          via = 'admin';
        } else {
          assertCronAuthorised(ctx);
        }

        const task = String(ctx.body?.task || 'all');
        const result = { via, task, ran: [] };

        const doPurge = task === 'all' || task === 'purge';
        if (doPurge) {
          const trashDays = Number(ctx.body?.trashDays ?? (await getSetting('retention.trash_days', '30'))) || 30;
          const spamDays = Number(ctx.body?.spamDays ?? (await getSetting('retention.spam_days', '30'))) || 30;

          // Storage is swept before the SQL runs, and the SQL purge is skipped
          // unless that sweep fully succeeded. Deleting the rows while the
          // objects remain would strand every attachment with no row to find it
          // from, and a retry could never clean them up afterwards.
          let objectsRemoved = 0;
          let storageReady = false;
          try {
            const purgePaths = await storagePathsPendingPurge({ trashDays, spamDays });
            if (purgePaths.truncated) {
              // More objects than one pass may collect. Leave the rows in place
              // and let the next run continue from where this one stopped.
              logger.warn('Storage sweep truncated; deferring the SQL purge', {
                count: purgePaths.paths.length,
              });
            } else {
              objectsRemoved = await deleteAttachments(purgePaths.paths);
              storageReady = true;
            }
          } catch (err) {
            logger.error('Storage sweep failed; deferring the SQL purge', { error: err?.message });
          }

          if (!storageReady) {
            result.ran.push({
              task: 'purge',
              trashDays,
              spamDays,
              deferred: true,
              storageObjectsRemoved: objectsRemoved,
              reason: 'storage sweep incomplete; rows retained so objects stay reachable',
            });
          } else {
            const purged = await queryOne(
              'select * from public.purge_expired_messages($1, $2)',
              [trashDays, spamDays],
            );
            result.ran.push({
              task: 'purge',
              trashDays,
              spamDays,
              deferred: false,
              messagesPurged: Number(purged?.messages_purged ?? 0),
              attachmentsPurged: Number(purged?.attachments_purged ?? 0),
              storageObjectsRemoved: objectsRemoved,
            });
          }
        }

        if (task === 'all' || task === 'sessions') {
          const pruned = await pruneSessions();
          result.ran.push({ task: 'sessions', rowsDeleted: pruned.rowCount });
        }

        if (task === 'all' || task === 'rate-limits') {
          // Only meaningful to run while traffic is quiet (the cron window).
          const cleared = await clearRateLimits('');
          result.ran.push({ task: 'rate-limits', rowsDeleted: cleared.rowCount });
        }

        // The audit trail is append-only for the application, but it still grows
        // without bound, so the retention job is the only thing that trims it.
        if (task === 'all' || task === 'audit') {
          const auditDays = Number(await getSetting('retention.audit_days', '400'));
          if (auditDays > 0) {
            const trimmed = await query(
              'delete from public.audit_logs where created_at < now() - make_interval(days => $1)',
              [auditDays],
            );
            result.ran.push({ task: 'audit', auditDays, rowsDeleted: trimmed.rowCount });
          }
        }

        logger.info('Maintenance completed', { via, task, steps: result.ran.length });
        return result;
      },
    },
  },
});