/**
 * TLS must be decided by configuration, not by a connection string.
 *
 * `sslmode` inside a postgres URL overrides the `ssl` option passed next to it,
 * so a connection string ending in `?sslmode=disable` connects in plaintext with
 * DATABASE_SSL=true — the credential and the session token in every query travel
 * unencrypted, and nothing in the logs says so.
 *
 * Supabase's dashboard strings do not include sslmode, but plenty of connection
 * strings found elsewhere do, and it is pasted verbatim.
 */

import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_jwt_secret_that_is_definitely_long_enough_to_pass_validation_0123456789';

const { connectionStringWithoutSslMode } = await import('../packages/db/pool.js');

const DIRECT = 'postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres';
const POOLED = 'postgresql://postgres.abcdefgh:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true';

describe('connectionStringWithoutSslMode', () => {
  it('leaves a clean connection string untouched', () => {
    expect(connectionStringWithoutSslMode(DIRECT)).toBe(DIRECT);
  });

  it('keeps Supabase pooler parameters it does not own', () => {
    expect(connectionStringWithoutSslMode(POOLED)).toBe(POOLED);
    expect(connectionStringWithoutSslMode(POOLED)).toContain('pgbouncer=true');
  });

  it.each([
    ['disable', `${DIRECT}?sslmode=disable`],
    ['allow', `${DIRECT}?sslmode=allow`],
    ['require', `${DIRECT}?sslmode=require`],
    ['verify-full', `${DIRECT}?sslmode=verify-full`],
  ])('removes sslmode=%s', (_mode, url) => {
    expect(connectionStringWithoutSslMode(url)).toBe(DIRECT);
  });

  it('removes sslmode from the middle of a query string', () => {
    expect(connectionStringWithoutSslMode(`${POOLED}&sslmode=disable`)).toBe(POOLED);
    expect(connectionStringWithoutSslMode(`${POOLED}&sslmode=require&x=1`)).toBe(`${POOLED}&x=1`);
  });

  it('does not leave an empty trailing separator behind', () => {
    for (const url of [`${DIRECT}?sslmode=disable`, `${DIRECT}?pgbouncer=true&sslmode=disable`]) {
      const result = connectionStringWithoutSslMode(url);
      expect(result).not.toMatch(/[?&]$/);
      expect(result).not.toContain('?&');
    }
  });

  it('preserves the password when it contains url-encoded sslmode text', () => {
    const url = 'postgresql://postgres:p%40ssword@db.abcdefgh.supabase.co:5432/postgres';
    expect(connectionStringWithoutSslMode(url)).toBe(url);
  });

  it('actually prevents the plaintext downgrade', async () => {
    // Same assertion pg's own connection parameters make, so this fails if the
    // sanitiser stops being applied at the call site.
    const { Client } = (await import('pg')).default;
    const build = (url) =>
      new Client({ connectionString: url, ssl: { rejectUnauthorized: false } }).connectionParameters.ssl;
    const encrypted = (value) => value === true || (value && typeof value === 'object');

    // Before: the URL wins, and the connection is not encrypted.
    expect(encrypted(build(`${DIRECT}?sslmode=disable`))).toBe(false);
    // After: TLS survives.
    expect(encrypted(build(connectionStringWithoutSslMode(`${DIRECT}?sslmode=disable`)))).toBe(true);
  });
});