#!/usr/bin/env node
/**
 * DESTRUCTIVE: drop and recreate the application schema, then re-apply
 * schema.sql and every migration.
 *
 * Requires an explicit confirmation flag (`--yes`) so it cannot be triggered by
 * accident, and refuses to run unless the target database name is present in
 * the connection string (a sanity check against pointing at production).
 *
 * Usage:
 *   npm run db:reset -- --yes
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadEnvFile, REPO_ROOT } from '../packages/shared/dotenv.js';

loadEnvFile();

if (!process.argv.includes('--yes')) {
  console.error('Refusing to reset without --yes. This drops all mail data.');
  process.exit(1);
}

const url = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const dbName = (() => {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
})();

if (!dbName || !/postgres/i.test(url)) {
  console.error('DATABASE_URL does not look like a Postgres connection string; refusing to reset.');
  process.exit(1);
}

console.log(`Target database: ${dbName}`);
console.log('This will DROP and recreate the public schema.');

async function main() {
  const { default: pg } = await import('pg');
  const Client = typeof pg === 'function' ? pg : pg.Client;
  const { connectionStringWithoutSslMode } = await import('../packages/db/pool.js');
  // Mirror the pool's TLS settings; a remote Supabase database rejects non-SSL.
  const wantSsl = process.env.DATABASE_SSL !== 'false';
  const client = new Client({
    connectionString: connectionStringWithoutSslMode(url),
    ...(wantSsl
      ? { ssl: { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true' } }
      : null),
  });
  await client.connect();

  const SCHEMA = path.join(REPO_ROOT, 'database', 'schema.sql');
  const MIGRATIONS_DIR = path.join(REPO_ROOT, 'database', 'migrations');

  try {
    await client.query('drop schema if exists public cascade;');
    await client.query('create schema public;');
    console.log('Schema dropped and recreated.');

    await client.query(fs.readFileSync(SCHEMA, 'utf8'));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      await client.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    }
    console.log(`Re-applied schema.sql and ${files.length} migration(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Reset failed:', err.message);
  process.exit(1);
});