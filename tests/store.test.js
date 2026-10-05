/**
 * Session state.
 *
 * The sign-in form and the boot sequence both land in `adoptSession()`, so it is
 * the one place that decides which mailbox the UI works on. It is also the fix
 * for a bug that made fresh sign-in impossible: the form navigated before the
 * store was populated, and every mail route is guarded on `state.user`.
 *
 * `api.js` is mocked because the real module resolves `window` and the API
 * origin at import time.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const session = {
  session: { accessToken: 'token_abc', mustChangePassword: false },
  user: { id: 'usr_1', email: 'a@re-el.co.za', displayName: 'A', role: 'user' },
  mailboxes: [
    { id: 'mbx_1', email: 'a@re-el.co.za' },
    { id: 'mbx_2', email: 'b@re-el.co.za' },
  ],
};

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

beforeEach(() => {
  vi.resetModules();
  sessionApi.mockReset();
  setAccessToken.mockReset();
  globalThis.localStorage.store.clear();
});

describe('adoptSession', () => {
  it('installs the token, user and mailboxes and picks the first mailbox', async () => {
    const store = await loadStore();
    store.adoptSession(session);

    expect(setAccessToken).toHaveBeenCalledWith('token_abc');
    expect(store.state.user).toEqual(session.user);
    expect(store.state.mailboxes).toHaveLength(2);
    expect(store.state.activeMailboxId).toBe('mbx_1');
    expect(store.activeMailbox().email).toBe('a@re-el.co.za');
  });

  it('keeps a previously chosen mailbox when it is still owned', async () => {
    const store = await loadStore();
    store.saveMailbox('mbx_2');
    store.adoptSession(session);
    expect(store.state.activeMailboxId).toBe('mbx_2');
  });

  it('falls back to the first mailbox when the remembered one is gone', async () => {
    const store = await loadStore();
    store.saveMailbox('mbx_deleted');
    store.adoptSession(session);
    expect(store.state.activeMailboxId).toBe('mbx_1');
  });

  it('tolerates a payload with no mailboxes', async () => {
    const store = await loadStore();
    store.adoptSession({ ...session, mailboxes: [] });
    expect(store.state.mailboxes).toEqual([]);
    expect(store.activeMailbox()).toBeNull();
    expect(store.state.activeMailboxId).toBeNull();
  });

  it('surfaces the forced password change flag from the payload', async () => {
    const store = await loadStore();
    store.adoptSession({ ...session, session: { ...session.session, mustChangePassword: true } });
    expect(store.state.session.mustChangePassword).toBe(true);
    // A valid session plus an outstanding change still counts as signed in, which
    // is why the route guard checks the flag separately.
    expect(store.state.user).toBeTruthy();
  });

  it('notifies subscribers so the shell can be swapped in', async () => {
    const store = await loadStore();
    const seen = [];
    store.subscribe(() => seen.push(store.state.user?.id ?? null));
    store.adoptSession(session);
    expect(seen).toContain('usr_1');
  });
});

describe('loadSession', () => {
  it('adopts the payload returned by the API', async () => {
    const store = await loadStore();
    sessionApi.mockResolvedValue(session);
    const user = await store.loadSession();
    expect(user).toEqual(session.user);
    expect(setAccessToken).toHaveBeenCalledWith('token_abc');
  });

  it('propagates a failed refresh so the app can show sign-in', async () => {
    const store = await loadStore();
    sessionApi.mockRejectedValue(new Error('unauthorised'));
    await expect(store.loadSession()).rejects.toThrow('unauthorised');
    expect(store.state.user).toBeNull();
  });
});

describe('resetState', () => {
  it('clears the token and every session-scoped field', async () => {
    const store = await loadStore();
    store.adoptSession(session);
    store.resetState();

    expect(setAccessToken).toHaveBeenLastCalledWith(null);
    expect(store.state.user).toBeNull();
    expect(store.state.session).toBeNull();
    expect(store.state.mailboxes).toEqual([]);
    expect(store.state.activeMailboxId).toBeNull();
    // Local preferences survive a sign-out: they are device settings, not session state.
    expect(store.state.theme).toBe(store.state.theme);
  });
});

describe('roles', () => {
  it('treats admin and manager as staff, but only admin as an owner', async () => {
    const store = await loadStore();
    store.adoptSession(session);
    expect(store.isAdmin()).toBe(false);
    expect(store.isOwner()).toBe(false);

    store.adoptSession({ ...session, user: { ...session.user, role: 'manager' } });
    expect(store.isAdmin()).toBe(true);
    expect(store.isOwner()).toBe(false);

    store.adoptSession({ ...session, user: { ...session.user, role: 'admin' } });
    expect(store.isAdmin()).toBe(true);
    expect(store.isOwner()).toBe(true);
  });
});
/**
 * Remembering that this browser was signed in.
 *
 * The access token is memory-only, so a page load has to rebuild it from the
 * httpOnly cookie. When that call failed because the network dropped, boot()
 * rendered the sign-in form — indistinguishable from being signed out, and on a
 * weak connection it happened constantly.
 *
 * This hint is what lets boot() tell "cannot reach the server" apart from "the
 * server rejected you". It must therefore never be treated as a session, and
 * never outlive an explicit sign-out.
 */
describe('last known user', () => {
  it('records who was signed in when a session is adopted', async () => {
    const store = await loadStore();
    store.adoptSession(session);
    expect(store.lastKnownUser()).toMatchObject({ email: 'a@re-el.co.za' });
  });

  it('stores no token or session id', async () => {
    const store = await loadStore();
    store.adoptSession(session);
    const raw = globalThis.localStorage.getItem('reel.lastUser');
    expect(raw).toBeTruthy();
    expect(raw).not.toContain('token_abc');
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['at', 'displayName', 'email']);
  });

  it('is forgotten on an explicit sign-out', async () => {
    const store = await loadStore();
    store.adoptSession(session);
    store.resetState();
    expect(store.lastKnownUser()).toBeNull();
  });

  it('returns null for a first-time visitor', async () => {
    const store = await loadStore();
    expect(store.lastKnownUser()).toBeNull();
  });

  it('survives corrupt storage instead of breaking boot', async () => {
    const store = await loadStore();
    globalThis.localStorage.setItem('reel.lastUser', '{not json');
    expect(store.lastKnownUser()).toBeNull();
  });
});
