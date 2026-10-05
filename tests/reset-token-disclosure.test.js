/**
 * Password-reset token disclosure.
 *
 * The forgot-password endpoint is unauthenticated by design: it must answer the
 * same way whether or not an address is registered. That same endpoint returned
 * the raw reset token in its response body, gated on `!env.isProduction`:
 *
 *   if (!env.isProduction) return { sent: true, devToken: reset?.token ?? null };
 *
 * Production ran with NODE_ENV=development, so env.isProduction was false and
 * the gate was open on the live deployment. Anyone could post an address and
 * read back a working reset token for it, then call ?action=reset with that
 * token and take the account over — no login, no email access required.
 *
 * The gate is now DEV_EXPOSE_RESET_TOKENS, defaulting off, deliberately not
 * derived from NODE_ENV: a misconfigured environment must never be able to open
 * it. These tests set NODE_ENV=development for the negative case on purpose,
 * because that is exactly the production condition that caused this.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const findByEmail = vi.fn();
const createPasswordReset = vi.fn();
const sendPasswordReset = vi.fn();
const audit = vi.fn();

vi.mock('../packages/db/users.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    findByEmail: (...a) => findByEmail(...a),
    createPasswordReset: (...a) => createPasswordReset(...a),
  };
});
vi.mock('../packages/mail/templates.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendPasswordReset: (...a) => sendPasswordReset(...a) };
});
vi.mock('../packages/db/system.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, audit: (...a) => audit(...a) };
});

const RAW_TOKEN = 'reset-token-abcdef0123456789';

function ctx(email) {
  return {
    body: { email },
    ip: '203.0.113.9',
    userAgent: 'test',
    query: {},
    setHeader() {},
    log: { info() {}, warn() {}, error() {} },
  };
}

beforeEach(() => {
  findByEmail.mockReset();
  createPasswordReset.mockReset();
  sendPasswordReset.mockReset();
  audit.mockReset();
  findByEmail.mockResolvedValue({ id: 'usr_1', email: 'admin@re-el.co.za', display_name: 'Site Admin', status: 'active' });
  createPasswordReset.mockResolvedValue({ id: 'rst_1', token: RAW_TOKEN });
  sendPasswordReset.mockResolvedValue(undefined);
  audit.mockResolvedValue(undefined);
});

const originalNodeEnv = process.env.NODE_ENV;
const originalExpose = process.env.DEV_EXPOSE_RESET_TOKENS;

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalExpose === undefined) delete process.env.DEV_EXPOSE_RESET_TOKENS;
  else process.env.DEV_EXPOSE_RESET_TOKENS = originalExpose;
});

async function forgot() {
  vi.resetModules();
  const { actions } = await import('../api/auth.js');
  return actions.forgot.handler(ctx('admin@re-el.co.za'));
}

describe('forgot-password never returns the token by default', () => {
  it('omits devToken when DEV_EXPOSE_RESET_TOKENS is unset', async () => {
    delete process.env.DEV_EXPOSE_RESET_TOKENS;
    const result = await forgot();

    expect(result).toEqual({ sent: true });
    expect(result.devToken).toBeUndefined();
  });

  it('omits devToken even when NODE_ENV is development', async () => {
    // This is the exact production condition: the deployed environment carried
    // NODE_ENV=development, and the old gate was `!env.isProduction`.
    process.env.NODE_ENV = 'development';
    delete process.env.DEV_EXPOSE_RESET_TOKENS;

    const result = await forgot();

    expect(result.devToken).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(RAW_TOKEN);
  });

  it('omits devToken even when NODE_ENV is missing entirely', async () => {
    delete process.env.NODE_ENV;
    delete process.env.DEV_EXPOSE_RESET_TOKENS;

    const result = await forgot();

    expect(result.devToken).toBeUndefined();
  });

  it('omits devToken in production', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.DEV_EXPOSE_RESET_TOKENS;

    const result = await forgot();

    expect(result.devToken).toBeUndefined();
  });
});

describe('token disclosure stays available when explicitly requested', () => {
  it('returns the token when DEV_EXPOSE_RESET_TOKENS is true', async () => {
    process.env.DEV_EXPOSE_RESET_TOKENS = 'true';

    const result = await forgot();

    expect(result).toEqual({ sent: true, devToken: RAW_TOKEN });
  });

  it('is off when the flag is the string false', async () => {
    process.env.DEV_EXPOSE_RESET_TOKENS = 'false';

    const result = await forgot();

    expect(result.devToken).toBeUndefined();
  });
});

describe('the response never varies with whether the account exists', () => {
  it('an unknown address gets the same body as a known one', async () => {
    delete process.env.DEV_EXPOSE_RESET_TOKENS;
    const known = await forgot();

    findByEmail.mockResolvedValue(null);
    const unknown = await forgot();

    expect(unknown).toEqual(known);
    expect(createPasswordReset).toHaveBeenCalledTimes(1);
  });

  it('an inactive account gets the same body too', async () => {
    delete process.env.DEV_EXPOSE_RESET_TOKENS;
    const known = await forgot();

    findByEmail.mockResolvedValue({ id: 'usr_2', email: 'b@re-el.co.za', status: 'suspended' });
    const inactive = await forgot();

    expect(inactive).toEqual(known);
  });

  it('a mail provider failure does not change the response', async () => {
    delete process.env.DEV_EXPOSE_RESET_TOKENS;
    sendPasswordReset.mockRejectedValue(new Error('provider down'));

    const result = await forgot();

    expect(result).toEqual({ sent: true });
  });
});