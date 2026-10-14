// @vitest-environment jsdom
/**
 * PayFast ITN webhook, driven through the real createHandler pipeline with the
 * database boundary mocked.
 *
 * The point is the security gate: a callback is only believed after the source
 * IP is checked, the MD5 signature is recomputed over the posted fields, and
 * PayFast's own validate endpoint answers VALID. Everything downstream (writing
 * the subscription) is covered by workspace-guards/workspace-view.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test@localhost:5432/test';
process.env.ALLOWED_ORIGINS = 'https://mailer.re-el.co.za';
process.env.APP_URL = 'https://mailer.re-el.co.za';
process.env.JWT_SECRET = 'x'.repeat(48);
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.BILLING_PROVIDER = 'payfast';
process.env.PAYFAST_MERCHANT_ID = '10000100';
process.env.PAYFAST_MERCHANT_KEY = '46f0cd694581a';
process.env.PAYFAST_PASSPHRASE = 'jt7NOE43FZPn';
process.env.PAYFAST_SANDBOX = 'true';

const dbWorkspaces = {
  getWorkspace: vi.fn(),
  findSubscriptionByProviderRef: vi.fn(),
  findDefaultWorkspaceForUser: vi.fn(),
  recordBillingEvent: vi.fn(),
  upsertSubscription: vi.fn(),
  roleAtLeast: vi.fn(() => true),
};
const dbUsers = { findByEmail: vi.fn() };
const workspaceViews = {
  loadWorkspaceContext: vi.fn(),
  subscriptionView: vi.fn((s) => s),
  workspaceView: vi.fn((w) => w),
};

vi.mock('../packages/db/workspaces.js', () => dbWorkspaces);
vi.mock('../packages/db/users.js', async (io) => ({ ...(await io()), ...dbUsers }));
vi.mock('../packages/http/workspace-views.js', () => workspaceViews);

let clientIpValue = '197.97.145.150';
vi.mock('../packages/auth/guard.js', () => ({
  requireSession: async () => ({ user: { id: 'usr_1', role: 'user', status: 'active' } }),
  requireAdmin: () => {},
  requireMailbox: async () => ({}),
  requireWorkspace: async () => ({}),
  requireWorkspaceRole: async () => ({}),
  assertEntitlement: () => {},
  assertCanSend: (m) => m,
  isManager: () => false,
  clientIp: () => clientIpValue,
  userAgent: () => 'vitest',
}));

const billing = await import('../api/billing.js');
const handler = billing.default;

const md5 = (value) => crypto.createHash('md5').update(value).digest('hex');

function makeRes() {
  const state = { statusCode: null, payload: null, headers: {} };
  return {
    state,
    setHeader(k, v) { state.headers[k] = v; },
    getHeader(k) { return state.headers[k]; },
    removeHeader(k) { delete state.headers[k]; },
    writeHead(code, headers) { state.statusCode = code; Object.assign(state.headers, headers); return this; },
    status(code) { state.statusCode = code; return this; },
    json(p) { state.payload = JSON.stringify(p); return this; },
    end(chunk) { state.payload = typeof chunk === 'string' ? chunk : JSON.stringify(chunk); return this; },
    write() { return true; },
    on() { return this; },
    once() { return this; },
    emit() { return false; },
  };
}

function callWebhook(body) {
  const req = {
    method: 'POST',
    query: { action: 'webhook' },
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(Buffer.byteLength(body)),
    },
    body,
  };
  const res = makeRes();
  return Promise.resolve(handler(req, res)).then(() => {
    let data = null;
    try { data = JSON.parse(res.state.payload); } catch { data = res.state.payload; }
    return { status: res.state.statusCode, body: data };
  });
}

/** Build a signed ITN body exactly as PayFast would. */
function signedItn(overrides = {}) {
  const ordered = {
    m_payment_id: 'reel_wsp_1_1',
    pf_payment_id: '12345',
    payment_status: 'COMPLETE',
    item_name: 'Re-EL Mailer plan',
    amount_gross: '149.00',
    amount_fee: '-3.00',
    amount_net: '146.00',
    custom_str1: 'wsp_1',
    custom_str2: 'team',
    custom_int1: '1',
    email_address: 'ada@re-el.co.za',
    merchant_id: '10000100',
    token: 'tok_9',
    ...overrides,
  };
  const enc = (v) => encodeURIComponent(String(v)).replace(/%20/g, '+');
  const str = `${Object.entries(ordered).map(([k, v]) => `${k}=${enc(v)}`).join('&')}&passphrase=jt7NOE43FZPn`;
  ordered.signature = md5(str);
  return new URLSearchParams(ordered).toString();
}

const validResponse = { ok: true, status: 200, text: async () => 'VALID' };

beforeEach(() => {
  vi.clearAllMocks();
  clientIpValue = '197.97.145.150';
  dbWorkspaces.getWorkspace.mockResolvedValue({ id: 'wsp_1', plan_id: 'solo' });
  dbWorkspaces.findSubscriptionByProviderRef.mockResolvedValue(null);
  dbWorkspaces.findDefaultWorkspaceForUser.mockResolvedValue(null);
  dbWorkspaces.recordBillingEvent.mockResolvedValue({ inserted: true });
  dbWorkspaces.upsertSubscription.mockResolvedValue({});
  globalThis.fetch = vi.fn().mockResolvedValue(validResponse);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/billing?action=webhook', () => {
  it('applies a signed, confirmed ITN to the workspace subscription', async () => {
    const { status, body } = await callWebhook(signedItn());
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, data: { received: true, applied: true, workspaceId: 'wsp_1' } });
    expect(dbWorkspaces.upsertSubscription).toHaveBeenCalledWith(
      'wsp_1',
      expect.objectContaining({ provider: 'payfast', status: 'active', planId: 'team', seats: 1 }),
    );
    // The validate endpoint was called on the sandbox host.
    expect(globalThis.fetch.mock.calls[0][0]).toBe('https://sandbox.payfast.co.za/eng/query/validate');
  });

  it('rejects a tampered payload whose signature no longer matches', async () => {
    const body = signedItn();
    const tampered = body.replace('149.00', '1.00');
    const result = await callWebhook(tampered);
    expect(result.status).toBe(401);
    expect(dbWorkspaces.upsertSubscription).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects an ITN that did not come from a PayFast IP', async () => {
    clientIpValue = '8.8.8.8';
    const result = await callWebhook(signedItn());
    expect(result.status).toBe(403);
    expect(dbWorkspaces.upsertSubscription).not.toHaveBeenCalled();
  });

  it('rejects an ITN the provider will not confirm (validate says INVALID)', async () => {
    globalThis.fetch.mockResolvedValue({ ok: true, status: 200, text: async () => 'INVALID' });
    const result = await callWebhook(signedItn());
    expect(result.status).toBe(401);
    expect(dbWorkspaces.upsertSubscription).not.toHaveBeenCalled();
  });

  it('rejects a confirmed payment whose amount does not match the plan', async () => {
    const result = await callWebhook(signedItn({ amount_gross: '1.00' }));
    expect(result.status).toBe(400);
    expect(dbWorkspaces.upsertSubscription).not.toHaveBeenCalled();
  });

  it('ignores a duplicate delivery', async () => {
    dbWorkspaces.recordBillingEvent.mockResolvedValue({ inserted: false });
    const { status, body } = await callWebhook(signedItn());
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ received: true, duplicate: true });
    expect(dbWorkspaces.upsertSubscription).not.toHaveBeenCalled();
  });

  it('records the event but applies nothing for a status we do not act on', async () => {
    const { status, body } = await callWebhook(signedItn({ payment_status: 'REFUNDED' }));
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ received: true, applied: false });
    expect(dbWorkspaces.upsertSubscription).not.toHaveBeenCalled();
  });
});
