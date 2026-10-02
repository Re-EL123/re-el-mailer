/**
 * Validation detail reaches the client.
 *
 * Submitting a too-short new password answered "Some of the details provided are
 * not valid." — the schema's own reason ("Use at least 10 characters.") was
 * attached to `error.details` all the way to the wire, and only the generic
 * fallback was ever displayed. On the forced-password-change screen, the first
 * thing a new account sees, the failure was unactionable: no field was named and
 * no rule stated.
 *
 * These tests drive the real pipeline and assert the per-field detail survives
 * serialization, so a future change that drops `details` fails here rather than
 * in front of a user.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { changePasswordSchema } from '../packages/validation/schemas.js';
import { ApiError, describeApiError } from '../apps/web/js/api.js';

function makeRes() {
  const state = { statusCode: null, body: null, headers: {}, headersSent: false, writableEnded: false };
  return {
    state,
    setHeader(k, v) { state.headers[k] = v; },
    getHeader(k) { return state.headers[k]; },
    removeHeader(k) { delete state.headers[k]; },
    writeHead(status, headers) {
      state.statusCode = status;
      Object.assign(state.headers, headers);
      state.headersSent = true;
      return this;
    },
    status(code) { state.statusCode = code; return this; },
    json(payload) { state.body = payload; state.writableEnded = true; return this; },
    end(chunk) {
      if (chunk) state.body = JSON.parse(chunk);
      state.writableEnded = true;
      return this;
    },
    write() { return true; },
    on() { return this; },
    once() { return this; },
    emit() { return false; },
  };
}

const BASE = {
  NODE_ENV: 'production',
  APP_URL: 'https://mailer.re-el.co.za',
  ALLOWED_ORIGINS: 'https://mailer.re-el.co.za',
  DATABASE_URL: 'postgres://u:p@db.example.invalid:5432/postgres',
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-value',
  JWT_SECRET: 'x'.repeat(48),
  RESEND_API_KEY: 're_test_key',
};

/** Drive the real pipeline with a schema, and report whether the handler ran. */
async function postWithSchema(body) {
  let reached = false;
  for (const [k, v] of Object.entries(BASE)) process.env[k] = v;
  vi.resetModules();
  const { createHandler } = await import('../packages/http/pipeline.js');
  const handler = createHandler({
    name: 'auth',
    actions: {
      probe: {
        method: 'POST',
        auth: 'none',
        body: 'json',
        schema: changePasswordSchema,
        handler: async () => { reached = true; return { changed: true }; },
      },
    },
  });
  const res = makeRes();
  await handler(
    {
      method: 'POST',
      query: { action: 'probe' },
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
      body,
    },
    res,
  );
  return { res, reached };
}

describe('validation detail survives to the wire', () => {
  beforeEach(() => {
    process.env.ALLOWED_ORIGINS = 'https://mailer.re-el.co.za';
    process.env.APP_URL = 'https://mailer.re-el.co.za';
  });

  it('names the offending field and rule for a short new password', async () => {
    const { res, reached } = await postWithSchema(
      JSON.stringify({ currentPassword: 'Generated-Pass1', newPassword: 'short' }),
    );

    expect(res.state.statusCode).toBe(400);
    expect(reached).toBe(false);
    // The generic fallback is useless on its own; the detail is the whole point.
    expect(res.state.body.error.message).toBe('Some of the details provided are not valid.');
    expect(res.state.body.error.details).toEqual([
      { field: 'newPassword', message: 'Use at least 10 characters.' },
    ]);
  });

  it('reports a pasted password with surrounding space', async () => {
    const { res } = await postWithSchema(
      JSON.stringify({ currentPassword: ' Generated-Pass1 ', newPassword: 'Long-Enough-Pass' }),
    );

    expect(res.state.statusCode).toBe(400);
    expect(res.state.body.error.details).toEqual([
      { field: 'currentPassword', message: 'Passwords cannot start or end with a space.' },
    ]);
  });

  it('accepts a password that satisfies every rule', async () => {
    const { res, reached } = await postWithSchema(
      JSON.stringify({ currentPassword: 'Generated-Pass1', newPassword: 'Long-Enough-Pass' }),
    );

    expect(reached).toBe(true);
    expect(res.state.statusCode).toBe(200);
    expect(res.state.body.error).toBeUndefined();
  });

  it('states the same rules the schema enforces', async () => {
    // Guards the client hint against drifting from the server.
    const short = changePasswordSchema.safeParse({ currentPassword: 'x', newPassword: 'short' });
    expect(short.success).toBe(false);
    expect(short.error.issues[0].path.join('.')).toBe('newPassword');
  });
});

describe('the message shown to the user', () => {
  it('prefers the specific reason over the generic fallback', () => {
    // Exactly what the pipeline sends for a too-short new password.
    const err = new ApiError('Some of the details provided are not valid.', {
      code: 'VALIDATION_ERROR',
      status: 400,
      details: [{ field: 'newPassword', message: 'Use at least 10 characters.' }],
    });

    expect(err.message).toBe('Some of the details provided are not valid.');
    expect(describeApiError(err)).toBe('Use at least 10 characters.');
  });

  it('joins every field reason when several fields are wrong', () => {
    const err = new ApiError('Some of the details provided are not valid.', {
      details: [
        { field: 'currentPassword', message: 'Enter your password.' },
        { field: 'newPassword', message: 'Use at least 10 characters.' },
      ],
    });

    expect(describeApiError(err)).toBe('Enter your password. Use at least 10 characters.');
  });

  it('falls back to the message for errors that carry no detail', () => {
    const err = new ApiError('Your current password is not correct.', {
      code: 'AUTH_INVALID',
      status: 400,
    });
    expect(describeApiError(err)).toBe('Your current password is not correct.');
  });

  it('does not leak an unexpected failure to the user', () => {
    expect(describeApiError(new TypeError('cannot read property of undefined')))
      .toBe('Something went wrong. Please try again.');
  });
});
