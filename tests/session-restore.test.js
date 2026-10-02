/**
 * Restoring a session across a page load.
 *
 * Every refresh sent the user back to the login screen even though the refresh
 * cookie was present and valid.
 *
 * The access token is held in memory only, so a fresh page load has to rebuild
 * it from the cookie by calling `?action=session`. `request()` skipped the
 * refresh-and-retry for every `/auth` path to avoid refreshing against a rejected
 * password — but `?action=session` is precisely the call that needs it. The
 * result was a guaranteed 401 on load, no retry, and boot() falling through to
 * the login screen, so no amount of correct signing in could survive a refresh.
 *
 * The exclusion still applies to login, logout, refresh and forgot-password:
 * refreshing on those either loops or turns a wrong password into a success.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

async function loadApi() {
  return import('../apps/web/js/api.js');
}

function callsTo(action) {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes(`action=${action}`));
}

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock;
  globalThis.window = { location: { origin: 'https://mailer.re-el.co.za' } };
  globalThis.localStorage = {
    store: new Map(),
    getItem(k) { return this.store.get(k) ?? null; },
    setItem(k, v) { this.store.set(k, v); },
    removeItem(k) { this.store.delete(k); },
  };
});

/** Exactly what ?action=session returns: identity, no token, no expiry. */
function sessionPayload() {
  return {
    user: { id: 'usr_1', email: 'admin@re-el.co.za', role: 'admin', mustChangePassword: true },
    mailbox: { id: 'mbx_1', email: 'admin@re-el.co.za' },
    mailboxes: [{ id: 'mbx_1', email: 'admin@re-el.co.za' }],
    sessionId: 'ses_1',
    issuedAt: '2026-10-02T09:00:00.000Z',
  };
}

describe('session restore after a reload', () => {
  it('refreshes the cookie and retries when the session call 401s', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { ok: false, error: { code: 'AUTH_REQUIRED' } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, data: { token: 'token_new' } }))
      .mockResolvedValueOnce(jsonResponse(200, {
        ok: true,
        data: {
          token: 'token_new',
          expiresIn: 900,
          user: { id: 'usr_1', email: 'admin@re-el.co.za', role: 'admin', mustChangePassword: false },
          mailboxes: [{ id: 'mbx_1', email: 'admin@re-el.co.za' }],
        },
      }));

    const { api } = await loadApi();
    const data = await api.auth.session();

    expect(callsTo('session')).toHaveLength(2);
    expect(callsTo('refresh')).toHaveLength(1);
    expect(data.user.email).toBe('admin@re-el.co.za');
  });

  it('sends the cookie on both calls so the server can rotate it', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, data: {} }));
    const { api } = await loadApi();
    await api.auth.session();
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.credentials).toBe('include');
    }
  });

  it('keeps the refreshed token when ?action=session returns none', async () => {
    // This is the production sequence that produced a 401 on change-password:
    // refresh() obtained a token, then the session call answered with identity
    // only and adoptSession wrote null over it, so the next authenticated
    // request went out with no Authorization header.
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { ok: false, error: { code: 'AUTH_REQUIRED' } }))
      .mockResolvedValueOnce(jsonResponse(200, {
        ok: true,
        data: { token: 'token_new', expiresIn: 900, user: sessionPayload().user, mailboxes: sessionPayload().mailboxes },
      }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, data: sessionPayload() }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, data: { changed: true } }));

    const { api } = await loadApi();
    // The real boot path: store.loadSession() feeds the payload into
    // adoptSession(), which is where the token was being clobbered. Calling the
    // API directly would skip the very code under test.
    const store = await import('../apps/web/js/store.js');
    const data = await api.auth.session();
    store.adoptSession(data);

    expect(data.sessionId).toBe('ses_1');
    // No token in the payload, so the one from refresh must survive.
    await api.auth.changePassword({ currentPassword: 'x', newPassword: 'y' });
    const lastCall = fetchMock.mock.calls.at(-1);
    expect(lastCall[1].headers.Authorization).toBe('Bearer token_new');
  });

  it('does not invent an expiry when the payload carries no expiresIn', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, data: sessionPayload() }));
    const { api } = await loadApi();
    const data = await api.auth.session();
    // expiresIn is absent, so a Date.now() + 0 calculation would report a token
    // that expired the instant it was issued.
    expect(data.expiresIn).toBeUndefined();
  });

  it('attempts one refresh, then gives up, when the cookie is absent', async () => {
    // One attempt is required: the cookie is httpOnly, so its absence is only
    // knowable by asking the server. Stopping there is what matters — boot()
    // turns the rejection into the login screen.
    fetchMock.mockResolvedValue(jsonResponse(401, { ok: false, error: { code: 'AUTH_REQUIRED' } }));
    const { api } = await loadApi();
    await expect(api.auth.session()).rejects.toThrow();
    expect(callsTo('refresh')).toHaveLength(1);
    expect(callsTo('session')).toHaveLength(1);
  });

  it('does not refresh when a login attempt is rejected', async () => {
    // Refreshing here would turn a wrong password into a successful session.
    fetchMock.mockResolvedValue(jsonResponse(401, { ok: false, error: { code: 'AUTH_INVALID' } }));
    const { api } = await loadApi();
    await expect(api.auth.login('a@re-el.co.za', 'wrong')).rejects.toThrow();
    expect(callsTo('refresh')).toHaveLength(0);
  });

  it('does not loop when both the session call and the refresh fail', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { ok: false, error: { code: 'AUTH_REQUIRED' } }));
    const { api } = await loadApi();
    await expect(api.auth.session()).rejects.toThrow();
    // A failing refresh propagates rather than triggering a second session call.
    expect(callsTo('refresh')).toHaveLength(1);
    expect(callsTo('session')).toHaveLength(1);
  });
});
