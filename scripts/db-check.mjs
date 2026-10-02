#!/usr/bin/env node
/**
 * Test whether a database password actually works, before editing Vercel.
 *
 * Setup dead-ends here repeatedly: replace [YOUR-PASSWORD], redeploy, wait for a
 * timeout, read the error, repeat. Each cycle costs minutes and risks leaving a
 * wrong password in the dashboard where it may be committed or screenshotted.
 *
 * This connects once and answers the only question that matters, and takes the
 * password on stdin so it never appears in argv, shell history or a screenshot:
 *
 *   read -rs PASSWORD && printf '%s' "$PASSWORD" | npm run db:check -- --stdin; unset PASSWORD
 *
 * The password is never echoed or logged. Only the host, port and username are
 * printed, all of which are safe to show.
 *
 * Usage:
 *   npm run db:check -- --stdin [--direct] [--host H --port P --user U]
 *   DB_PASSWORD=... npm run db:check
 */

import { loadEnvFile } from '../packages/shared/dotenv.js';
import { pullFromVercel } from './lib/vercel-env.js';

loadEnvFile();

function arg(name, fallback = undefined) {
  const args = process.argv.slice(2);
  const index = args.indexOf(`--${name}`);
  if (index !== -1 && args[index + 1] && !args[index + 1].startsWith('--')) return args[index + 1];
  return fallback;
}

async function readPasswordFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function main() {
  const wantsStdin = process.argv.includes('--stdin');

  if (process.argv.includes('--pull') || (!wantsStdin && !process.env.DB_PASSWORD && !process.env.DATABASE_URL)) {
    // Reuse the configured host/port/user when they exist, but still require the
    // password to be supplied explicitly.
    pullFromVercel({ label: 'password check' });
  }

  let password = process.env.DB_PASSWORD || '';
  if (wantsStdin || !password) {
    if (process.stdin.isTTY) {
      console.error('Pipe the password on stdin, e.g.:');
      console.error("  read -rs PASSWORD && printf '%s' \"$PASSWORD\" | npm run db:check -- --stdin");
      process.exit(1);
    }
    password = await readPasswordFromStdin();
  }

  if (!password) {
    console.error('No password supplied. See the usage in scripts/db-check.mjs.');
    process.exit(1);
  }

  const useDirect = process.argv.includes('--direct');
  const base = useDirect
    ? process.env.DIRECT_URL || process.env.DATABASE_URL || ''
    : process.env.DATABASE_URL || process.env.DIRECT_URL || '';

  if (!base) {
    console.error('No connection string available. Add DATABASE_URL or pass --pull.');
    process.exit(1);
  }

  // Swap in the candidate password, keeping the host, port, user and database.
  const { connectionStringWithoutSslMode } = await import('../packages/db/pool.js');
  const url = new URL(base);
  url.password = encodeURIComponent(password);

  console.log(`Testing ${useDirect ? 'direct' : 'pooled'} connection: ${url.hostname}:${url.port || 5432}`);
  console.log(`  user: ${decodeURIComponent(url.username)}`);
  console.log(`  database: ${(url.pathname || '/postgres').slice(1)}`);
  console.log('  password: [supplied, not shown]');

  const { default: pg } = await import('pg');
  const Client = typeof pg === 'function' ? pg : pg.Client;
  const client = new Client({
    connectionString: connectionStringWithoutSslMode(url.toString()),
    ssl: { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true' },
    connectionTimeoutMillis: 15000,
  });

  try {
    await client.connect();
    const result = await client.query('select current_user, current_database()');
    console.log('\nAuthenticated.');
    console.log(`  current_user: ${result.rows[0].current_user}`);
    console.log(`  database: ${result.rows[0].current_database}`);
    console.log('\nThis password is correct. Use it in the Vercel connection strings.');
    await client.end();
    process.exit(0);
  } catch (error) {
    const code = error?.code || error?.cause?.code || '';
    console.error(`\nFailed: ${error.message}`);
    if (code === '28P01' || /password authentication failed/i.test(error.message)) {
      console.error('\nThe password was rejected. Confirm you used the DATABASE password,');
      console.error('not your Supabase account login password. Supabase → Settings →');
      console.error('Database → Database password. If unsure, reset it there, then run');
      console.error('this check again before putting it in Vercel.');
    } else if (code === 'ENOTFOUND') {
      console.error('\nThat hostname does not resolve.');
    } else if (code === 'ENETUNREACH' || code === 'EAFNOSUPPORT') {
      console.error('\nThe host is IPv6-only and this machine has no IPv6 route.');
      console.error('Drop --direct and test the pooler instead.');
    }
    process.exit(1);
  }
}

main();