/**
 * Users and password resets.
 *
 * `password_hash` never leaves this module in a readable form: the public
 * projection used in API responses omits it entirely.
 */

import * as pool from './pool.js';
import { newId, randomToken, sha256 } from '../shared/ids.js';
import { nowIso, daysFromNow } from '../shared/dates.js';
import { AppError, Codes } from '../shared/errors.js';

const DEFAULT_POOL = pool;

/** Columns safe to return to the client (no password hash, no lock counters). */
const PUBLIC_COLUMNS = `
  id, email, display_name, role, status,
  must_change_password, preferences, created_at, updated_at, last_login_at
`;

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function findByEmail(email, db = DEFAULT_POOL) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  return db.queryOne(
    `select ${PUBLIC_COLUMNS}, password_hash from public.users where lower(email) = $1`,
    [normalized],
  );
}

export async function findById(id, db = DEFAULT_POOL) {
  if (!id) return null;
  return db.queryOne(`select ${PUBLIC_COLUMNS} from public.users where id = $1`, [id]);
}

export async function findPublicById(id, db = DEFAULT_POOL) {
  return findById(id, db);
}

export async function listUsers({ status, role, search, limit = 100, offset = 0 } = {}, db = DEFAULT_POOL) {
  const conditions = [];
  const params = [];

  if (status) {
    params.push(status);
    conditions.push(`u.status = $${params.length}`);
  }
  if (role) {
    params.push(role);
    conditions.push(`u.role = $${params.length}`);
  }
  if (search) {
    params.push(`%${String(search).trim().toLowerCase()}%`);
    conditions.push(`(lower(u.email) like $${params.length} or lower(u.display_name) like $${params.length})`);
  }

  const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
  params.push(limit, offset);

  return db.queryAll(
    `select ${PUBLIC_COLUMNS.split(',').map((c) => `u.${c.trim()}`).join(', ')},
            (select count(*) from public.mailboxes mb where mb.user_id = u.id) as mailbox_count
     from public.users u
     ${where}
     order by u.created_at desc
     limit $${params.length - 1} offset $${params.length}`,
    params,
  );
}

export async function countUsers({ status, role } = {}, db = DEFAULT_POOL) {
  const conditions = [];
  const params = [];
  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  if (role) {
    params.push(role);
    conditions.push(`role = $${params.length}`);
  }
  const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
  const row = await db.queryOne(`select count(*)::int as total from public.users ${where}`, params);
  return row?.total ?? 0;
}

export async function countAdmins(excludeUserId, db = DEFAULT_POOL) {
  const row = await db.queryOne(
    `select count(*)::int as total from public.users
     where role = 'admin' and status = 'active' and ($1::text is null or id <> $1)`,
    [excludeUserId ?? null],
  );
  return row?.total ?? 0;
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export async function createUser(
  { email, passwordHash, displayName, role = 'user', status = 'active', mustChangePassword = false, preferences = {} },
  db = DEFAULT_POOL,
) {
  const id = newId('user');
  const row = await db.queryOne(
    `insert into public.users (id, email, password_hash, display_name, role, status, must_change_password, preferences)
     values ($1, lower($2), $3, $4, $5, $6, $7, $8::jsonb)
     returning ${PUBLIC_COLUMNS}`,
    [id, String(email).trim(), passwordHash, displayName, role, status, mustChangePassword, JSON.stringify(preferences)],
  );
  return row;
}

export async function updateUser(id, patch, db = DEFAULT_POOL) {
  const assignments = [];
  const params = [id];

  const set = (column, value, cast = '') => {
    params.push(value);
    assignments.push(`${column} = $${params.length}${cast}`);
  };

  if (patch.displayName !== undefined) set('display_name', patch.displayName);
  if (patch.role !== undefined) set('role', patch.role);
  if (patch.status !== undefined) set('status', patch.status);
  if (patch.mustChangePassword !== undefined) set('must_change_password', patch.mustChangePassword);
  if (patch.preferences !== undefined) set('preferences', JSON.stringify(patch.preferences), '::jsonb');
  if (patch.email !== undefined) set('email', String(patch.email).trim().toLowerCase());
  if (patch.passwordHash !== undefined) {
    set('password_hash', patch.passwordHash);
    set('password_changed_at', nowIso());
    // A new password invalidates the lockout state and forces a fresh password.
    assignments.push('failed_login_count = 0');
    assignments.push('locked_until = null');
  }

  if (assignments.length === 0) return findById(id, db);

  const row = await db.queryOne(
    `update public.users set ${assignments.join(', ')} where id = $1 returning ${PUBLIC_COLUMNS}`,
    params,
  );
  if (!row) throw new AppError(Codes.NOT_FOUND, 'User not found.');
  return row;
}

export async function deleteUser(id, db = DEFAULT_POOL) {
  const { rowCount } = await db.query('delete from public.users where id = $1', [id]);
  return rowCount > 0;
}

/** Record a successful login. */
export async function recordLogin(id, db = DEFAULT_POOL) {
  return db.queryOne(
    `update public.users
     set last_login_at = now(), failed_login_count = 0, locked_until = null
     where id = $1
     returning ${PUBLIC_COLUMNS}`,
    [id],
  );
}

/**
 * Record a failed login. Returns `{ locked, lockedUntil }` so the caller can
 * report the lockout without re-querying.
 */
export async function recordFailedLogin(id, { maxAttempts = 10, lockoutMinutes = 15 } = {}, db = DEFAULT_POOL) {
  const row = await db.queryOne(
    `update public.users
     set failed_login_count = failed_login_count + 1,
         locked_until = case
           when failed_login_count + 1 >= $2 then now() + make_interval(mins => $3)
           else locked_until
         end
     where id = $1
     returning failed_login_count, locked_until`,
    [id, maxAttempts, lockoutMinutes],
  );

  const locked = Boolean(row?.locked_until) && new Date(row.locked_until) > new Date();
  return { locked, lockedUntil: row?.locked_until ?? null, attempts: row?.failed_login_count ?? 0 };
}

/** Clear the lockout without recording a success (admin unlock). */
export async function unlockUser(id, db = DEFAULT_POOL) {
  return db.queryOne(
    `update public.users
     set failed_login_count = 0, locked_until = null
     where id = $1
     returning ${PUBLIC_COLUMNS}`,
    [id],
  );
}

// ─── Password resets ─────────────────────────────────────────────────────────

/**
 * Create a single-use reset token. Any earlier outstanding tokens for the user
 * are invalidated so only the newest link works.
 *
 * @returns {{id: string, tokenHash: string}}
 */
export async function createPasswordReset(userId, { ttlMinutes = 30, ip } = {}, db = DEFAULT_POOL) {
  return pool.withTransaction(async (tx) => {
    await tx.query(
      `update public.password_resets
       set used_at = now()
       where user_id = $1 and used_at is null`,
      [userId],
    );
    const token = `${randomToken(32)}.${Date.now().toString(36)}`;
    const tokenHash = sha256(token);
    const id = newId('reset');
    await tx.query(
      `insert into public.password_resets (id, user_id, token_hash, ip, expires_at)
       values ($1, $2, $3, $4, $5)`,
      [id, userId, tokenHash, ip ?? null, daysFromNow(ttlMinutes / 1440).toISOString()],
    );
    return { id, tokenHash, token };
  });
}

/** Look up a valid (unexpired, unused) reset token hash. */
export async function findPasswordResetByHash(tokenHash, db = DEFAULT_POOL) {
  return db.queryOne(
    `select pr.id, pr.user_id, pr.expires_at, pr.used_at, u.email, u.status
     from public.password_resets pr
     join public.users u on u.id = pr.user_id
     where pr.token_hash = $1`,
    [tokenHash],
  );
}

/** Mark a reset token as used. Idempotent. */
export async function consumePasswordReset(id, db = DEFAULT_POOL) {
  return db.queryOne(
    `update public.password_resets set used_at = now() where id = $1 returning id, user_id`,
    [id],
  );
}