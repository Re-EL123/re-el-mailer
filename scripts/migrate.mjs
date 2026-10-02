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
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadEnvFile, REPO_ROOT } from '../packages/shared/dotenv.js';

loadEnvFile();

/**
 * With --pull, read the connection strings straight out of the Vercel project.
 *
 * This exists to stop the most common way this step fails: hand-copying a
 * connection string that embeds the database password, usually leaving the
 * literal `[YOUR-PASSWORD]` placeholder in place. The pulled file is written to
 * a temp path, used, and deleted in a finally — it holds every production
 * secret, not just the database URL.
 */
function pullFromVercel() {
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reel-env-')), '.env');
  const args = ['vercel', 'env', 'pull', target, '--environment=production', '--yes'];
  const result = spawnSync('npx', args, { encoding: 'utf8' });

  if (result.status !== 0) {
    // The directory already exists at this point; do not leave it behind.
    fs.rmSync(path.dirname(target), { recursive: true, force: true });
    console.error('Could not pull environment variables from Vercel.');
    console.error((result.stderr || '').trim().split('\n').slice(0, 4).join('\n'));
    console.error('\nRun `vercel login` and `vercel link`, or pass DIRECT_URL inline:');
    console.error('  DIRECT_URL=postgres://... node scripts/migrate.mjs');
    process.exit(1);
  }

  loadEnvFile(target);
  const host = (process.env.DIRECT_URL || process.env.DATABASE_URL || '').match(/@([^:/]+)/)?.[1];
  console.log(`Pulled Vercel environment (database host: ${host || 'unknown'}).`);
  return target;
}

const SCHEMA = path.join(REPO_ROOT, 'database', 'schema.sql');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'database', 'migrations');

async function main() {
  const pulled = process.argv.includes('--pull') ? pullFromVercel() : null;
  try {
    await migrate();
  } finally {
    // Never leave production secrets on disk.
    if (pulled) {
      fs.rmSync(path.dirname(pulled), { recursive: true, force: true });
    }
  }
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
  const client = new Client({
    connectionString: connectionStringWithoutSslMode(connectionString),
    ...(wantSsl
      ? { ssl: { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true' } }
      : null),
  });
  await client.connect();
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