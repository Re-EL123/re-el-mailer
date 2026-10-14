/**
 * Every serverless function module loads.
 *
 * A handler that throws while its module is evaluated (a bad top-level constant,
 * a schema built the wrong way) crashes the whole function: Vercel answers
 * FUNCTION_INVOCATION_FAILED and no unit test that exercises the handler in
 * isolation would ever see it, because nothing imports the module. That is
 * exactly how a zod `.extend()` on a refined schema shipped. Import every file in
 * api/ so a module that cannot be evaluated fails here instead of in production.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test@localhost:5432/test';
process.env.JWT_SECRET = 'x'.repeat(48);
process.env.RESEND_API_KEY = 're_test_key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-value';
process.env.ALLOWED_ORIGINS = 'https://mailer.re-el.co.za';
process.env.APP_URL = 'https://mailer.re-el.co.za';

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'api');
const modules = fs
  .readdirSync(API_DIR)
  .filter((file) => file.endsWith('.js'))
  .sort();

describe('api modules', () => {
  it('has at least one function to check', () => {
    expect(modules.length).toBeGreaterThan(0);
  });

  it.each(modules)('api/%s imports and exports a handler', async (file) => {
    const module = await import(pathToFileURL(path.join(API_DIR, file)).href);
    expect(typeof module.default).toBe('function');
  });
});
