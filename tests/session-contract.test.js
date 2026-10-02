/**
 * The session contract between the API and the browser.
 *
 * A real sign-in returned 200 and created a session, then the UI reported
 * "Something went wrong. Please try again." The API had no bug: it authenticated
 * the user and returned buildSessionPayload(). The client read `data.session
 * .accessToken`, but that payload has no `session` object — it exposes `token`,
 * `expiresIn` and `refreshExpiresAt` at the top level. So adoptSession threw a
 * TypeError, which the sign-in view reported with its generic fallback message
 * and which left the user staring at a failed login that had actually succeeded.
 *
 * Every previous store test used a hand-written fixture in the client's assumed
 * shape, so both halves passed their own suites while disagreeing with each
 * other. These tests build the payload with the real server function, so the two
 * sides cannot drift apart again without a failure here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSessionPayload } from '../packages/auth/tokens.js';

const setAccessToken = vi.fn();
const sessionApi = vi.fn();

vi.mock('../apps/web/js/api.js', () => ({
  api: { auth: { session: (...args) => sessionApi(...args) } },
  setAccessToken: (...args) => setAccessToken(...args),
}));

globalThis.window = {
  matchMedia: () => ({ matches: false }),
  addEventListener() {},
  location: { hash: '' },
};
globalThis.document = { documentElement: { dataset: {} } };
globalThis.localStorage = {
  store: new Map(),
  getItem(k) { return this.store.get(k) ?? null; },
  setItem(k, v) { this.store.set(k, v); },
  removeItem(k) { this.store.delete(k); },
};

async function loadStore() {
  return import('../apps/web/js/store.js');
}

/** Exactly what api/auth.js returns for login, session and token refresh. */
function serverPayload(overrides = {}) {
  return buildSessionPayload({
    user: {
      id: 'usr_1',
      email: 'admin@re-el.co.za',
      displayName: 'admin',
      role: 'admin',
      status: 'active',
      mustChangePassword: false,
      lastLoginAt: '2026-10-02T09:00:00Z',
      preferences: {},
      ...overrides.user,
    },
    mailbox: {
      id: 'mbx_1',
      email: 'admin@re-el.co.za',
      displayName: null,
      domain: 're-el.co.za',
      status: 'active',
      isPrimary: true,
      quotaBytes: 5_000_000_000,
      storageUsedBytes: 0,
      signatureHtml: null,
      signatureText: null,
      replyTo: null,
      autoRead: false,
      ...overrides.mailbox,
    },
    accessToken: 'token_abc',
    accessTokenExpiresIn: 900,
    refreshExpiresAt: '2026-10-09T09:00:00Z',
    mailboxes: overrides.mailboxes ?? [
      {
        id: 'mbx_1',
        email: 'admin@re-el.co.za',
        displayName: null,
        domain: 're-el.co.za',
        status: 'active',
        isPrimary: true,
        quotaBytes: 5_000_000_000,
        storageUsedBytes: 0,
        signatureHtml: null,
        signatureText: null,
        replyTo: null,
        autoRead: false,
      },
    ],
  });
}

beforeEach(() => {
  vi.resetModules();
  sessionApi.mockReset();
  setAccessToken.mockReset();
  globalThis.localStorage.store.clear();
});

describe('server/client session contract', () => {
  it('adopts the payload the API actually returns', async () => {
    const store = await loadStore();
    const payload = serverPayload();

    expect(() => store.adoptSession(payload)).not.toThrow();
    expect(setAccessToken).toHaveBeenCalledWith('token_abc');
    expect(store.state.user.email).toBe('admin@re-el.co.za');
    expect(store.state.mailboxes).toHaveLength(1);
    expect(store.state.activeMailboxId).toBe('mbx_1');
  });

  it('surfaces the access token expiry for the refresh timer', async () => {
    const store = await loadStore();
    store.adoptSession(serverPayload());
    expect(store.state.session.expiresAt).toBeTypeOf('number');
  });

  it('carries mustChangePassword through to the state the routes read', async () => {
    // app.js and views/auth.js gate on state.session.mustChangePassword, while
    // the API reports it on the user. Losing it here lets a user with a
    // temporary password straight into the inbox.
    const store = await loadStore();
    store.adoptSession(serverPayload({ user: { mustChangePassword: true } }));
    expect(store.state.session.mustChangePassword).toBe(true);

    vi.resetModules();
    const fresh = await loadStore();
    fresh.adoptSession(serverPayload());
    expect(fresh.state.session.mustChangePassword).toBe(false);
  });

  it('gates sign-in on state, not the raw response, for a temporary password', async () => {
    // views/auth.js routed on `data.session?.mustChangePassword`, which the API
    // never sets, so a user on a generated password went straight into the
    // inbox instead of being forced to choose their own.
    const store = await loadStore();
    const payload = serverPayload({ user: { mustChangePassword: true } });
    store.adoptSession(payload);
    expect(payload.session).toBeUndefined();
    expect(store.state.session.mustChangePassword).toBe(true);
  });

  it('still accepts the older nested-session shape', async () => {
    // Tolerating both shapes keeps a cached service worker working against a
    // newer or older API, which matters because the two deploy independently.
    const store = await loadStore();
    store.adoptSession({
      session: { accessToken: 'token_old', expiresAt: 123, mustChangePassword: false },
      user: { id: 'usr_1', email: 'a@re-el.co.za' },
      mailboxes: [{ id: 'mbx_1', email: 'a@re-el.co.za' }],
    });
    expect(setAccessToken).toHaveBeenCalledWith('token_old');
    expect(store.state.activeMailboxId).toBe('mbx_1');
  });
});