/**
 * Sessions, audit logs, rate limits, settings and dashboard statistics.
 */

import * as pool from './pool.js';
import { newId, sha256 } from '../shared/ids.js';

const DEFAULT_POOL = pool;

// ─── Sessions ────────────────────────────────────────────────────────────────

const SESSION_COLUMNS = `
  id, user_id, mailbox_id, ip, user_agent, created_at, last_used_at,
  expires_at, revoked_at, revoked_reason
`;

/**
 * Create a refresh session.
 *
 * @param {object} session
 * @param {string} session.userId
 * @param {string} session.token raw token (only its SHA-256 hash is stored)
 */
export async function createSession(
  { userId, mailboxId = null, token, ip = null, userAgent = null, expiresAt, maxSessions = 5 },
  db = DEFAULT_POOL,
) {
  const tokenHash = sha256(token);

  // Cap concurrent sessions: revoke the oldest beyond the limit.
  await db.query(
    `update public.sessions
     set revoked_at = now(), revoked_reason = 'session_limit'
     where id in (
       select id from public.sessions
       where user_id = $1 and revoked_at is null
       order by last_used_at desc
       offset $2
     )`,
    [userId, maxSessions],
  );

  const row = await db.queryOne(
    `insert into public.sessions (id, user_id, mailbox_id, token_hash, ip, user_agent, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning ${SESSION_COLUMNS}`,
    [newId('session'), userId, mailboxId, tokenHash, ip, userAgent, expiresAt],
  );
  return { ...row, tokenHash };
}

export async function findActiveSessionByTokenHash(tokenHash, db = DEFAULT_POOL) {
  return db.queryOne(
    `select ${SESSION_COLUMNS}, s.user_id
     from public.sessions s
     where s.token_hash = $1
       and s.revoked_at is null
       and s.expires_at > now()`,
    [tokenHash],
  );
}

/**
 * Look a session up by its id (the `sid` claim carried in access tokens).
 * This is the revocation check performed on every authenticated request.
 */
export async function findActiveSessionById(id, db = DEFAULT_POOL) {
  if (!id) return null;
  return db.queryOne(
    `select ${SESSION_COLUMNS}, s.user_id
     from public.sessions s
     where s.id = $1
       and s.revoked_at is null
       and s.expires_at > now()`,
    [id],
  );
}

export async function touchSession(id, db = DEFAULT_POOL) {
  return db.queryOne(
    'update public.sessions set last_used_at = now() where id = $1 returning id, last_used_at',
    [id],
  );
}

export async function revokeSessionByTokenHash(tokenHash, reason = 'logout', db = DEFAULT_POOL) {
  const row = await db.queryOne(
    `update public.sessions set revoked_at = now(), revoked_reason = $2
     where token_hash = $1 and revoked_at is null
     returning ${SESSION_COLUMNS}`,
    [tokenHash, reason],
  );
  return row;
}

/** Revoke one session by its id. Used when a user signs out another device. */
export async function revokeSessionById(id, reason = 'revoked', db = DEFAULT_POOL) {
  const row = await db.queryOne(
    `update public.sessions set revoked_at = now(), revoked_reason = $2
     where id = $1 and revoked_at is null
     returning ${SESSION_COLUMNS}`,
    [id, reason],
  );
  return row;
}

export async function revokeAllSessions(userId, reason = 'revoked', exceptSessionId = null, db = DEFAULT_POOL) {
  const { rowCount } = await db.query(
    `update public.sessions
     set revoked_at = now(), revoked_reason = $2
     where user_id = $1 and revoked_at is null and ($3::text is null or id <> $3)`,
    [userId, reason, exceptSessionId],
  );
  return { rowCount };
}

export async function listActiveSessions(userId, db = DEFAULT_POOL) {
  return db.queryAll(
    `select ${SESSION_COLUMNS}
     from public.sessions
     where user_id = $1 and revoked_at is null and expires_at > now()
     order by last_used_at desc`,
    [userId],
  );
}

/** Housekeeping: drop sessions that expired long ago. */
export async function pruneSessions(db = DEFAULT_POOL) {
  const { rowCount } = await db.query(
    `delete from public.sessions where expires_at < now() - interval '7 days'`,
  );
  return { rowCount };
}

// ─── Audit log ───────────────────────────────────────────────────────────────

/**
 * Append an audit entry. Never throws into the request path — a failure to log
 * must not break the action being logged.
 */
export async function audit(
  { actorId = null, actorEmail = null, action, entityType = null, entityId = null, ip = null, userAgent = null, metadata = {} },
  db = DEFAULT_POOL,
) {
  try {
    return await db.queryOne(
      `insert into public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, ip, user_agent, metadata)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       returning id, created_at`,
      [actorId, actorEmail, action, entityType, entityId, ip, userAgent, JSON.stringify(metadata ?? {})],
    );
  } catch (err) {
    // Logged, not thrown: auditing is best-effort so it cannot fail a request.
    (await import('../shared/logger.js')).logger.exception('Failed to write audit log', err, { action });
    return null;
  }
}

export async function listAuditLogs(
  { actorId, action, entityType, sinceIso, untilIso, limit = 50, offset = 0 } = {},
  db = DEFAULT_POOL,
) {
  const conditions = [];
  const params = [];
  if (actorId) {
    params.push(actorId);
    conditions.push(`actor_id = $${params.length}`);
  }
  if (action) {
    params.push(action);
    conditions.push(`action = $${params.length}`);
  }
  if (entityType) {
    params.push(entityType);
    conditions.push(`entity_type = $${params.length}`);
  }
  if (sinceIso) {
    params.push(sinceIso);
    conditions.push(`created_at >= $${params.length}::timestamptz`);
  }
  if (untilIso) {
    params.push(untilIso);
    conditions.push(`created_at <= $${params.length}::timestamptz`);
  }
  const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
  params.push(limit, offset);

  return db.queryAll(
    `select id, actor_id, actor_email, action, entity_type, entity_id, ip, metadata, created_at
     from public.audit_logs
     ${where}
     order by created_at desc
     limit $${params.length - 1} offset $${params.length}`,
    params,
  );
}

export async function countAuditLogs(filters = {}, db = DEFAULT_POOL) {
  const conditions = [];
  const params = [];
  if (filters.actorId) {
    params.push(filters.actorId);
    conditions.push(`actor_id = $${params.length}`);
  }
  if (filters.action) {
    params.push(filters.action);
    conditions.push(`action = $${params.length}`);
  }
  if (filters.sinceIso) {
    params.push(filters.sinceIso);
    conditions.push(`created_at >= $${params.length}::timestamptz`);
  }
  const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
  const row = await db.queryOne(
    `select count(*)::int as total from public.audit_logs ${where}`,
    params,
  );
  return row?.total ?? 0;
}

export async function listAuditActions(db = DEFAULT_POOL) {
  return db.queryAll(
    `select action, count(*)::int as count from public.audit_logs
     group by action order by count desc limit 100`,
  );
}

// ─── Rate limits ─────────────────────────────────────────────────────────────

/**
 * Fixed-window counter.
 *
 * @returns {Promise<{allowed: boolean, count: number, remaining: number,
 *                    resetAt: string, retryAfterSeconds: number}>}
 */
export async function hitRateLimit(bucketKey, { limit, windowSeconds = 60 } = {}, db = DEFAULT_POOL) {
  const windowMs = windowSeconds * 1000;
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs);

  const row = await db.queryOne(
    `insert into public.rate_limits (bucket_key, window_start, count)
     values ($1, $2, 1)
     on conflict (bucket_key, window_start)
     do update set count = public.rate_limits.count + 1
     returning count`,
    [bucketKey, windowStart.toISOString()],
  );

  const count = Number(row?.count ?? 1);
  const resetAt = new Date(windowStart.getTime() + windowMs);
  const remaining = Math.max(0, limit - count);
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt.getTime() - now) / 1000));

  return {
    allowed: count <= limit,
    count,
    remaining,
    resetAt: resetAt.toISOString(),
    retryAfterSeconds,
  };
}

/** Read a counter without incrementing it. */
export async function peekRateLimit(bucketKey, windowSeconds = 60, db = DEFAULT_POOL) {
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs).toISOString();
  const row = await db.queryOne(
    'select count from public.rate_limits where bucket_key = $1 and window_start = $2',
    [bucketKey, windowStart],
  );
  return Number(row?.count ?? 0);
}

export async function clearRateLimits(prefix, db = DEFAULT_POOL) {
  const { rowCount } = await db.query(
    `delete from public.rate_limits where bucket_key like $1`,
    [`${prefix}%`],
  );
  return { rowCount };
}

// ─── Settings ────────────────────────────────────────────────────────────────

/** All settings as a plain object. */
export async function getSettings(db = DEFAULT_POOL) {
  const rows = await db.queryAll('select key, value, updated_at from public.settings');
  const out = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

export async function getSetting(key, fallback = null, db = DEFAULT_POOL) {
  const row = await db.queryOne('select value from public.settings where key = $1', [key]);
  return row ? row.value : fallback;
}

export async function setSetting(key, value, userId = null, db = DEFAULT_POOL) {
  return db.queryOne(
    `insert into public.settings (key, value, updated_by)
     values ($1, $2::jsonb, $3)
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by
     returning key, value, updated_at`,
    [key, JSON.stringify(value), userId],
  );
}

export async function deleteSetting(key, db = DEFAULT_POOL) {
  const { rowCount } = await db.query('delete from public.settings where key = $1', [key]);
  return rowCount > 0;
}

export async function listSettingDefinitions(db = DEFAULT_POOL) {
  return db.queryAll('select key, description, updated_at from public.settings order by key');
}

// ─── Dashboard statistics ────────────────────────────────────────────────────

/**
 * Platform-wide counters for the admin dashboard.
 *
 * Only numbers derived directly from the messages/mailboxes tables are
 * returned — nothing is estimated. `delivery` is omitted entirely when there
 * is not enough data to be meaningful rather than showing a misleading 0%.
 */
export async function platformStats(db = DEFAULT_POOL) {
  const [mailboxes, users, messages, sentToday, receivedToday, delivery] = await Promise.all([
    db.queryOne(
      `select count(*)::int as total,
              count(*) filter (where status = 'active')::int as active,
              count(*) filter (where status = 'disabled')::int as disabled
       from public.mailboxes`,
    ),
    db.queryOne(
      `select count(*)::int as total,
              count(*) filter (where role = 'admin')::int as admins,
              count(*) filter (where status = 'active')::int as active
       from public.users`,
    ),
    db.queryOne(
      `select count(*)::int as total,
              coalesce(sum(size_bytes), 0)::bigint as bytes
       from public.messages where folder <> 'drafts'`,
    ),
    db.queryOne(
      `select count(*)::int as total from public.messages
       where direction = 'outbound' and not is_draft and sent_at >= date_trunc('day', now() at time zone 'utc')`,
    ),
    db.queryOne(
      `select count(*)::int as total from public.messages
       where direction = 'inbound' and received_at >= date_trunc('day', now() at time zone 'utc')`,
    ),
    db.queryOne('select * from public.delivery_health'),
  ]);

  const decided = (delivery?.delivered ?? 0) + (delivery?.bounced ?? 0) + (delivery?.complained ?? 0);

  return {
    mailboxes: { total: mailboxes?.total ?? 0, active: mailboxes?.active ?? 0, disabled: mailboxes?.disabled ?? 0 },
    users: { total: users?.total ?? 0, admins: users?.admins ?? 0, active: users?.active ?? 0 },
    messages: { total: messages?.total ?? 0, bytes: Number(messages?.bytes ?? 0) },
    sentToday: sentToday?.total ?? 0,
    receivedToday: receivedToday?.total ?? 0,
    delivery: {
      total: delivery?.total ?? 0,
      delivered: delivery?.delivered ?? 0,
      bounced: delivery?.bounced ?? 0,
      complained: delivery?.complained ?? 0,
      deferred: delivery?.deferred ?? 0,
      sent: delivery?.sent ?? 0,
      queued: delivery?.queued ?? 0,
      // Only report a rate once at least one message reached a final state.
      ratePct: decided >= 1 ? Number(delivery?.delivery_rate_pct ?? 0) : null,
    },
  };
}

/** Daily send/receive series for the admin chart. */
export async function usageSeries({ days = 14, domainId = null } = {}, db = DEFAULT_POOL) {
  const params = [days];
  let filter = '';
  if (domainId) {
    params.push(domainId);
    filter = `and d.id = $${params.length}`;
  }

  return db.queryAll(
    `select day,
            sum(sent)::int      as sent,
            sum(received)::int  as received,
            sum(delivered)::int as delivered,
            sum(bounced)::int   as bounced,
            coalesce(sum(bytes), 0)::bigint as bytes
     from public.usage_daily
     where day >= (current_date - make_interval(days => $1 - 1)) ${filter}
     group by day
     order by day asc`,
    params,
  );
}

/** Per-user folder totals for the admin users table. */
export async function userFolderTotals(db = DEFAULT_POOL) {
  return db.queryAll('select * from public.folder_totals');
}

/** Storage rollup for every mailbox. */
export async function storageRollup(db = DEFAULT_POOL) {
  return db.queryAll(
    `select r.*, round(100.0 * r.total_bytes / nullif(r.quota_bytes, 0), 2) as used_pct
     from public.storage_rollup r
     order by r.total_bytes desc`,
  );
}

/** Live inbox counts for the dashboard polling endpoint. */
export async function recentActivity({ limit = 12 } = {}, db = DEFAULT_POOL) {
  return db.queryAll(
    `select a.id, a.action, a.entity_type, a.entity_id, a.actor_email, a.metadata, a.created_at,
            u.display_name as actor_name
     from public.audit_logs a
     left join public.users u on u.id = a.actor_id
     order by a.created_at desc
     limit $1`,
    [limit],
  );
}