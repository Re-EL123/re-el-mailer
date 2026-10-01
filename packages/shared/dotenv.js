/**
 * Minimal .env loader.
 *
 * Deliberately dependency-free: production runs on Vercel, where environment
 * variables are injected by the platform and this file does nothing. It exists
 * so `node scripts/*.mjs` and `vercel dev` work locally without adding dotenv.
 *
 * Existing process.env values always win — the file never overwrites a real
 * environment variable.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// here = <repo>/packages/shared  →  repo is two levels up.
export const REPO_ROOT = path.resolve(here, '..', '..');

/**
 * Parse the contents of a .env file into a plain object.
 * Supports `KEY=value`, `export KEY=value`, `#` comments, blank lines and
 * single-quoted / double-quoted values.
 */
export function parseEnvFile(contents) {
  const out = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq === -1) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
      if (rawLine.includes('"')) value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      const hashIndex = value.indexOf(' #');
      if (hashIndex !== -1) value = value.slice(0, hashIndex).trim();
    }

    out[key] = value;
  }
  return out;
}

/** Load a .env file into process.env without overwriting existing values. */
export function loadEnvFile(file = path.join(REPO_ROOT, '.env')) {
  let contents;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const parsed = parseEnvFile(contents);
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return parsed;
}