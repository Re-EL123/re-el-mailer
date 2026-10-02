/**
 * PostgreSQL connection pool.
 *
 * Uses the Supabase connection string with node-postgres. Every query in the
 * application goes through `query()` or `withTransaction()`, so all values are
 * always passed as bind parameters — no SQL string interpolation anywhere.
 *
 * A single module-level pool is reused across warm invocations, which keeps
 * connection churn down on serverless.
 */

import pg from 'pg';
import { database } from '../shared/config.js';
import { AppError, Codes, toAppError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';

const { Pool } = pg;

let pool = null;

// ─── Type parsers ────────────────────────────────────────────────────────────

/**
 * node-postgres returns BIGINT (int8) and NUMERIC as strings to avoid silent
 * precision loss. Re-EL's counters never approach 2^53 and every consumer here
 * is JavaScript, so convert them once at the driver boundary.
 */
(function applyTypeParsers() {
  // OIDs: 20 = int8, 1700 = numeric, 1082 = date.
  pg.types.setTypeParser(20, (value) => (value === null ? null : Number(value)));
  pg.types.setTypeParser(1700, (value) => (value === null ? null : Number(value)));
  pg.types.setTypeParser(1082, (value) => value); // keep dates as ISO strings
})();

// ─── Pool ────────────────────────────────────────────────────────────────────

/**
 * Connection string with any sslmode stripped.
 *
 * `sslmode` in the connection string takes precedence over the `ssl` option
 * passed alongside it, so a URL ending in `?sslmode=disable` silently connects
 * in plaintext — DATABASE_SSL=true and all. Stripping it means TLS is decided
 * here, by configuration, instead of by whatever a dashboard or guide appended
 * to the URL.
 *
 * `pgbouncer=true`, `connection_limit` and friends are left alone: node-postgres
 * ignores the ones it does not know, and Supabase's pooled URLs carry them.
 */
export function connectionStringWithoutSslMode(url = database.url()) {
  const stripped = String(url).replace(/([?&])sslmode=[^&#]*/gi, (match, sep) =>
    sep === '?' ? '?' : '',
  );
  // …and drop a now-empty trailing '?' or '&'.
  return stripped.replace(/[?&]+$/, '').replace(/\?&/, '?');
}

/** Lazily construct the pool. Throws AppError if DATABASE_URL is missing. */
export function getPool() {
  if (pool) return pool;

  pool = new Pool({
    connectionString: connectionStringWithoutSslMode(),
    ssl: database.ssl ? { rejectUnauthorized: database.rejectUnauthorized } : undefined,
    max: database.maxConnections,
    idleTimeoutMillis: database.idleTimeoutMs,
    connectionTimeoutMillis: database.connectionTimeoutMs,
    statement_timeout: database.statementTimeoutMs,
    query_timeout: database.statementTimeoutMs,
    application_name: 're-el-mailer-api',
  });

  // A pool-level error (server restart, idle client killed) must not crash the
  // function: log it and let the next query open a fresh connection.
  pool.on('error', (err) => {
    logger.exception('Database pool emitted an error', err);
  });

  return pool;
}

// ─── Query helpers ───────────────────────────────────────────────────────────

/**
 * Execute a parameterised statement.
 * @template T
 * @param {string} text
 * @param {unknown[]} [params]
 * @returns {Promise<{rows: T[], rowCount: number}>}
 */
export async function query(text, params = []) {
  try {
    const result = await getPool().query(text, params);
    return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
  } catch (err) {
    // Log the statement shape only — never parameter values.
    logger.exception('Database query failed', err, {
      statement: text.replace(/\s+/g, ' ').trim().slice(0, 300),
      paramCount: params.length,
    });
    throw new AppError(Codes.DATABASE_ERROR, undefined, 500, { cause: err });
  }
}

/** First row, or null. */
export async function queryOne(text, params = []) {
  const { rows } = await query(text, params);
  return rows[0] ?? null;
}

/** All rows. */
export async function queryAll(text, params = []) {
  const { rows } = await query(text, params);
  return rows;
}

/**
 * Run `fn` inside a transaction, rolling back on any throw.
 *
 * The client passed to `fn` exposes the same query helpers bound to that
 * connection, so repositories can be reused inside a transaction by passing
 * `db` as their first argument.
 *
 * @template T
 * @param {(db: {query: Function, queryOne: Function, queryAll: Function}) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(fn) {
  const client = await getPool().connect();
  const bound = {
    query: async (text, params = []) => {
      const result = await client.query(text, params);
      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
    },
    queryOne: async (text, params = []) => {
      const result = await client.query(text, params);
      return result.rows[0] ?? null;
    },
    queryAll: async (text, params = []) => {
      const result = await client.query(text, params);
      return result.rows;
    },
    raw: client,
  };

  try {
    await client.query('begin');
    const result = await fn(bound);
    await client.query('commit');
    return result;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch (rollbackError) {
      logger.exception('Transaction rollback failed', rollbackError);
    }
    // Translate driver errors here rather than handing back a bare pg error:
    // callers inside a transaction want the same mapped AppError (a 409 for a
    // duplicate email, say) that the pipeline would produce at the edge.
    if (err instanceof AppError) throw err;
    throw toAppError(err);
  } finally {
    client.release();
  }
}

/** Liveness probe. Resolves to the round-trip time in milliseconds. */
export async function ping() {
  const startedAt = Date.now();
  await query('select 1 as ok');
  return Date.now() - startedAt;
}

/** Close the pool (used by scripts and tests). */
export async function closePool() {
  if (!pool) return;
  const closing = pool;
  pool = null;
  await closing.end();
}

export default { query, queryOne, queryAll, withTransaction, getPool, ping, closePool };