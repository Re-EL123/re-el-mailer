/**
 * Application state.
 *
 * A minimal observable store: `state` is a plain object, `setState` merges a
 * patch and notifies subscribers. Views subscribe on mount and unsubscribe on
 * teardown, so nothing has to remember to clean up a listener by hand.
 */

import { api, setAccessToken } from './api.js';

export const state = {
  booted: false,
  user: null,
  session: null, // { accessToken, expiresAt, mustChangePassword }
  mailboxes: [],
  activeMailboxId: null,
  counts: { folders: {}, inboxUnread: 0, starred: 0 },
  labels: [],
  settings: {},
  theme: 'system',
  density: 'comfortable',
  pageSize: 30,
};

const subscribers = new Set();

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function setState(patch) {
  Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
  for (const fn of subscribers) {
    try {
      fn(state);
    } catch (err) {
      console.error('State subscriber failed', err);
    }
  }
}

/** The mailbox the UI is currently operating on. */
export function activeMailbox() {
  return state.mailboxes.find((mb) => mb.id === state.activeMailboxId) || state.mailboxes[0] || null;
}

export function isAdmin() {
  return state.user?.role === 'admin' || state.user?.role === 'manager';
}

export function isOwner() {
  return state.user?.role === 'admin';
}

/** Persist the chosen mailbox and theme so they survive a reload. */
const LS_MAILBOX = 'reel.mailbox';
const LS_THEME = 'reel.theme';
const LS_DENSITY = 'reel.density';

export function loadLocalPrefs() {
  try {
    setState({
      activeMailboxId: localStorage.getItem(LS_MAILBOX) || null,
      theme: localStorage.getItem(LS_THEME) || 'system',
      density: localStorage.getItem(LS_DENSITY) || 'comfortable',
    });
  } catch {
    /* private mode */
  }
}

export function saveMailbox(id) {
  try {
    if (id) localStorage.setItem(LS_MAILBOX, id);
    else localStorage.removeItem(LS_MAILBOX);
  } catch {
    /* ignore */
  }
  setState({ activeMailboxId: id });
}

export function saveTheme(theme) {
  try {
    localStorage.setItem(LS_THEME, theme);
  } catch {
    /* ignore */
  }
  setState({ theme });
  applyTheme();
}

export function saveDensity(density) {
  try {
    localStorage.setItem(LS_DENSITY, density);
  } catch {
    /* ignore */
  }
  setState({ density });
  document.documentElement.dataset.density = density;
}

export function applyTheme() {
  const theme = state.theme;
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

/**
 * Normalise a session payload from the API.
 *
 * `buildSessionPayload()` returns `token`, `expiresIn` and `refreshExpiresAt` at
 * the top level with `mustChangePassword` on the user. An earlier client assumed
 * a nested `session: { accessToken, expiresAt, mustChangePassword }`, so sign-in
 * threw a TypeError on `data.session.accessToken` and reported a generic failure
 * for a login that had actually succeeded.
 *
 * Both shapes are accepted: the frontend on GitHub Pages and the API on Vercel
 * deploy independently, so a cached service worker can outlive a contract change
 * in either direction.
 */
function normalizeSession(data) {
  if (data?.session) return { ...data.session };
  const expiresAt = Date.now() + Number(data?.expiresIn ?? 0) * 1000;
  return {
    accessToken: data?.token ?? null,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    mustChangePassword: Boolean(data?.user?.mustChangePassword),
  };
}

/**
 * Adopt an already-fetched session payload.
 *
 * Both `loadSession()` and the sign-in form land here, so the token, user,
 * mailboxes and chosen mailbox are always installed the same way. Returning the
 * user lets callers branch on the forced password change without reading state.
 */
export function adoptSession(data) {
  const mailboxes = data.mailboxes || [];
  const session = normalizeSession(data);
  setAccessToken(session.accessToken);
  setState({
    user: data.user,
    session,
    mailboxes,
    activeMailboxId:
      state.activeMailboxId && mailboxes.some((mb) => mb.id === state.activeMailboxId)
        ? state.activeMailboxId
        : mailboxes[0]?.id || null,
    labels: [],
  });
  if (!state.activeMailboxId && mailboxes.length) {
    saveMailbox(mailboxes[0].id);
  }
  return data.user;
}

/** Load the signed-in user's session + mailboxes; throws if not signed in. */
export async function loadSession() {
  return adoptSession(await api.auth.session());
}

export async function loadSettings() {
  const data = await api.settings.app();
  setState({ settings: data.settings || {} });
  return data.settings;
}

/** Clear all auth state on sign-out. */
export function resetState() {
  setAccessToken(null);
  setState({
    user: null,
    session: null,
    mailboxes: [],
    activeMailboxId: null,
    counts: { folders: {}, inboxUnread: 0, starred: 0 },
    labels: [],
  });
}