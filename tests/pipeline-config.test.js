import { describe, expect, it, beforeEach, vi } from 'vitest';

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

async function boot(env) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  const { createHandler } = await import('../packages/http/pipeline.js');
  return createHandler({
    name: 'health',
    actions: { ping: { method: 'GET', auth: 'none', handler: async () => ({ ok: true }) } },
  });
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

describe('production configuration is asserted before serving', () => {
  let saved;
  beforeEach(() => {
    saved = { ...process.env };
  });

  it('names a missing DATABASE_URL instead of reporting a bare degraded', async () => {
    const handler = await boot({ ...BASE, DATABASE_URL: undefined });
    const res = makeRes();
    await handler({ method: 'GET', query: { action: 'ping' }, headers: {} }, res);

    expect(res.state.statusCode).toBe(500);
    expect(res.state.body.error.code).toBe('SERVER_MISCONFIGURED');
    expect(res.state.body.error.message).toContain('DATABASE_URL');
    // The handler must not have run: a config error is not a health answer.
    expect(res.state.body.data).toBeUndefined();
  });

  it('rejects a JWT_SECRET too short to sign with', async () => {
    const handler = await boot({ ...BASE, JWT_SECRET: 'short' });
    const res = makeRes();
    await handler({ method: 'GET', query: { action: 'ping' }, headers: {} }, res);

    expect(res.state.statusCode).toBe(500);
    expect(res.state.body.error.message).toContain('32 characters');
  });

  it('serves normally when everything required is present', async () => {
    const handler = await boot({ ...BASE });
    const res = makeRes();
    await handler({ method: 'GET', query: { action: 'ping' }, headers: {} }, res);

    expect(res.state.statusCode).toBe(200);
    expect(res.state.body.data.ok).toBe(true);
  });

  it('stays lenient outside production so tests and local dev need no secrets', async () => {
    const handler = await boot({
      NODE_ENV: 'test',
      DATABASE_URL: undefined,
      SUPABASE_URL: undefined,
      SUPABASE_SERVICE_ROLE_KEY: undefined,
      JWT_SECRET: undefined,
      RESEND_API_KEY: undefined,
    });
    const res = makeRes();
    await handler({ method: 'GET', query: { action: 'ping' }, headers: {} }, res);

    expect(res.state.statusCode).toBe(200);
  });
});