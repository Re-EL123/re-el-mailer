#!/usr/bin/env node
/**
 * Apply `database/schema.sql` (idempotently) and every migration in order.
 *
 * Safe to run repeatedly: schema.sql and each migration are written to be
 * re-runnable (create-if-not-exists / replace function / insert … on conflict).
 *
 * Usage:
 *   npm run db:migrate
 *   DIRECT_URL=... node scripts/migrate.mjs
 *   npm run db:migrate:vercel    # read DIRECT_URL from the Vercel project
 *
 * Migrations prefer DIRECT_URL and fall back to DATABASE_URL. Preferring the
 * direct connection matters: schema.sql issues DDL, `create extension`,
 * `create policy` and `alter table … enable row level security`, none of which
 * are safe through Supabase's transaction pooler, which multiplexes over one
 * connection and hands a later statement to an unrelated session.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadEnvFile, REPO_ROOT } from '../packages/shared/dotenv.js';
import { pullFromVercel } from './lib/vercel-env.js';

loadEnvFile();

const SCHEMA = path.join(REPO_ROOT, 'database', 'schema.sql');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'database', 'migrations');

async function main() {
  // Cleanup of the pulled file is registered on exit by pullFromVercel().
  if (process.argv.includes('--pull')) pullFromVercel({ label: 'migrations' });
  await migrate();
}

/**
 * Turn an opaque connect error into something actionable.
 *
 * The case that motivated this: Supabase's direct host resolves to AAAA only,
 * so a machine without IPv6 gets `connect ENETUNREACH 2a05:d018::10d2:5432`
 * and nothing else. The fix is to migrate over the session pooler, which is
 * IPv4 and gives one backend session per connection, so DDL stays safe.
 */
async function explainConnectionFailure(error, connectionString) {
  const code = error?.code || error?.cause?.code || '';
  const host = connectionString.match(/@([A-Za-z0-9.-]+)/)?.[1] || '';
  console.error(`\nMigration failed: ${error.message}`);

  if (code === 'ENETUNREACH' || code === 'EAFNOSUPPORT' || code === 'EHOSTUNREACH') {
    const { resolve4, resolve6 } = await import('node:dns').then((dns) => dns.promises);
    const v4 = await resolve4(host).catch(() => []);
    const v6 = await resolve6(host).catch(() => []);
    if (v4.length === 0 && v6.length > 0) {
      console.error(`\n${host} resolves to IPv6 only, and this machine has no IPv6 route.`);
      console.error('Supabase → Settings → Database → Connection string → URI:');
      console.error('  Session pooler  (aws-0-…pooler.supabase.com:5432) → set as DIRECT_URL');
      console.error('  Transaction pooler (:6543) is NOT safe for DDL — do not migrate through it.');
      console.error('\nKeep Vercel\'s DATABASE_URL on the transaction pooler for runtime.');
    } else {
      console.error(`\nCould not reach ${host}. Check your network, VPN or firewall.`);
    }
  } else if (code === '28P01') {
    console.error('\nAuthentication failed: the password is wrong, or it still contains');
    console.error('the literal [YOUR-PASSWORD] placeholder from the dashboard.');
  } else if (code === '28000' || code === '3D000') {
    console.error('\nThe role or database in the connection string does not exist. Use the');
    console.error('`postgres` role against the `postgres` database as shown in the dashboard.');
  }
  console.error('');
}

async function migrate() {
  const { closePool, connectionStringWithoutSslMode } = await import('../packages/db/pool.js');
  const { default: pg } = await import('pg');
  const Client = typeof pg === 'function' ? pg : pg.Client;

  // Mirror the pool's TLS settings. Supabase requires SSL, and a migration that
  // connects without it fails against a remote database even though the app works.
  const wantSsl = process.env.DATABASE_SSL !== 'false';
  const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
  if (!connectionString) {
    console.error('Neither DIRECT_URL nor DATABASE_URL is set. Set DIRECT_URL to the direct (non-pooler) connection string.');
    process.exit(1);
  }
  if (!process.env.DIRECT_URL) {
    // Falling back silently is how DDL ends up run through the transaction
    // pooler, where create extension / create policy can fail or land on an
    // unrelated session. Say so rather than letting it fail mysteriously later.
    console.warn('\x1b[33m! DIRECT_URL is not set; falling back to DATABASE_URL.\x1b[0m');
    console.warn('  If DATABASE_URL is the transaction pooler (:6543), set DIRECT_URL instead.');
  }

  const client = new Client({
    connectionString: connectionStringWithoutSslMode(connectionString),
    ...(wantSsl
      ? { ssl: { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true' } }
      : null),
  });

  try {
    await client.connect();
  } catch (error) {
    await explainConnectionFailure(error, connectionString);
    process.exit(1);
  }
  console.log('Connected.');

  try {
    console.log('→ schema.sql');
    await client.query(fs.readFileSync(SCHEMA, 'utf8'));

    const files = fs.existsSync(MIGRATIONS_DIR)
      ? fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
      : [];

    for (const file of files) {
      console.log(`→ ${file}`);
      await client.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    }

    // A cheap sanity query proves the schema is queryable, not just applied.
    const { rows } = await client.query('select count(*)::int as domains from public.domains');
    console.log(`\nDone. ${files.length} migration(s) applied; ${rows[0].domains} domain(s) present.`);
  } finally {
    await client.end();
    await closePool().catch(() => {});
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});