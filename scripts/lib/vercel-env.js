/**
 * Read environment variables out of a linked Vercel project.
 *
 * Migrations, seeding and admin provisioning all need DATABASE_URL, and without
 * this each of them required a local .env containing a password-bearing
 * connection string. That is the step people skip, and then the next command
 * fails with "Missing environment variable DATABASE_URL" — which reads like a
 * code fault rather than a missing local file.
 *
 * The pulled file holds every production secret, not just the database URL, so
 * it is written to a private temp directory and removed on exit.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadEnvFile } from '../../packages/shared/dotenv.js';

/**
 * Pull production variables from Vercel and load them into process.env.
 * Exits with guidance if the pull fails; never leaves the file behind.
 */
export function pullFromVercel({ label = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-env-'));
  const target = path.join(dir, '.env');
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });

  const result = spawnSync(
    'npx',
    ['vercel', 'env', 'pull', target, '--environment=production', '--yes'],
    { encoding: 'utf8' },
  );

  if (result.status !== 0) {
    // The directory already exists at this point; do not leave it behind.
    cleanup();
    console.error('Could not pull environment variables from Vercel.');
    console.error((result.stderr || '').trim().split('\n').slice(0, 4).join('\n'));
    console.error('\nRun `vercel login` and `vercel link`, or pass DATABASE_URL inline:');
    console.error('  DIRECT_URL=postgres://... node scripts/migrate.mjs');
    process.exit(1);
  }

  // Covers success, thrown errors and process.exit alike. Registering the hook
  // here rather than in a finally matters: a failed connect calls process.exit
  // from deep inside the migration, which never returns to any caller's finally.
  process.on('exit', cleanup);

  // Load before reporting the host, otherwise the summary reads "unknown"
  // because nothing has read the file yet.
  loadEnvFile(target);

  const host = (process.env.DIRECT_URL || process.env.DATABASE_URL || '').match(/@([^:/]+)/)?.[1];
  console.log(`Pulled Vercel environment${label ? ` for ${label}` : ''} (database host: ${host || 'unknown'}).`);
}