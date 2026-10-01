#!/usr/bin/env node
/**
 * Apply `database/schema.sql` (idempotently) and every migration in order.
 *
 * Safe to run repeatedly: schema.sql and each migration are written to be
 * re-runnable (create-if-not-exists / replace function / insert … on conflict).
 *
 * Usage:
 *   npm run db:migrate
 *   DATABASE_URL=... node scripts/migrate.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadEnvFile, REPO_ROOT } from '../packages/shared/dotenv.js';

loadEnvFile();

const SCHEMA = path.join(REPO_ROOT, 'database', 'schema.sql');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'database', 'migrations');

async function main() {
  const { closePool } = await import('../packages/db/pool.js');
  const { default: pg } = await import('pg');
  const Client = typeof pg === 'function' ? pg : pg.Client;

  // Mirror the pool's TLS settings. Supabase requires SSL, and a migration that
  // connects without it fails against a remote database even though the app works.
  const wantSsl = process.env.DATABASE_SSL !== 'false';
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
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