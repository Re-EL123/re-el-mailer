/**
 * Application bootstrap.
 *
 * On load we try to restore a session from the refresh cookie. If that works we
 * render the mail shell and start the router; if not we render the sign-in
 * screen. The public-routes list is the only place unauthenticated screens are
 * named.
 */

import { api } from './api.js';
import { el, mount, toast } from './ui.js';
import {
  activeMailbox,
  applyTheme,
  isAdmin,
  lastKnownUser,
  loadLocalPrefs,
  loadSession,
  loadSettings,
  resetState,
  saveMailbox,
  state,
  subscribe,
} from './store.js';
import { currentRoute, navigate, route, setRouterContainer, startRouter } from './router.js';
import { onSignedIn } from './auth-events.js';
import { renderChangePassword, renderForgot, renderLogin, renderReset, themeToggle } from './views/auth.js';
import { renderMailList } from './views/mail-list.js';
import { renderMessage } from './views/message.js';
import { renderCompose } from './views/compose.js';
import { renderSettings } from './views/settings.js';
import { renderAdmin } from './views/admin.js';

const PUBLIC_ROUTES = new Set(['', 'login', 'forgot', 'reset', 'change-password']);

let viewRoot = null;
let shellNode = null;

/* ── Shell ─────────────────────────────────────────────────────────────── */

function mailboxSelect() {
  const select = el('select', { class: 'mailbox-select', 'aria-label': 'Active mailbox' },
    ...state.mailboxes.map((mb) =>
      el('option', { value: mb.id, text: mb.email, selected: mb.id === state.activeMailboxId }),
    ),
  );
  select.addEventListener('change', () => {
    saveMailbox(select.value);
    navigate('inbox');
  });
  return select;
}

function buildShell() {
  const avatar = el('div', { class: 'user-avatar', text: (state.user?.displayName || state.user?.email || '?').slice(0, 1).toUpperCase() });
  const userMenu = el(
    'div',
    { class: 'user-menu' },
    avatar,
    el('span', { class: 'user-name', text: state.user?.displayName || state.user?.email }),
    el('button', { class: 'icon-btn', title: 'Sign out', text: '⏻', onClick: signOut }),
  );

  shellNode = el(
    'div',
    { class: 'shell' },
    el(
      'header',
      { class: 'topbar' },
      el('a', { class: 'brand', href: '#/inbox' },
        el('img', { src: 'assets/icon-192.svg', alt: '', width: 28, height: 28 }),
        el('span', { text: 'Re-EL Mailer' }),
      ),
      mailboxSelect(),
      el('div', { class: 'topbar-right' },
        el('a', { class: 'icon-btn', href: '#/settings', title: 'Settings', text: '⚙' }),
        themeToggle(),
        isAdmin() ? el('a', { class: 'icon-btn', href: '#/admin', title: 'Admin', text: '🛠' }) : null,
        userMenu,
      ),
    ),
    el('main', { class: 'view' }),
  );
  viewRoot = shellNode.querySelector('.view');
  return shellNode;
}

async function signOut() {
  try {
    await api.auth.logout();
  } catch {
    /* sign out locally regardless */
  }
  resetState();
  enterPublic();
  navigate('', { replace: true });
}

/** Mount the public chrome and point the router at the auth container. */
function enterPublic() {
  document.body.dataset.mode = 'public';
  shellNode = null;
  const root = document.getElementById('root');
  mount(
    root,
    el(
      'div',
      { class: 'public-shell' },
      el('div', { class: 'public-top' }, themeToggle()),
      el('div', { id: 'auth-view' }),
    ),
  );
  setRouterContainer(root.querySelector('#auth-view'));
}

/**
 * Mount a mail shell and point the router at it.
 *
 * This is the counterpart to `enterPublic()`: the router keeps its single
 * hashchange listener and only changes which container it renders into, so a
 * mid-session sign-in does not register a second listener and render twice.
 */
function enterShell() {
  document.body.dataset.mode = 'app';
  mount(document.getElementById('root'), buildShell());
  setRouterContainer(viewRoot);
  loadSettings().catch(() => {});
}

/**
 * Reconnecting screen for a boot that failed to reach the API.
 *
 * The alternative — falling through to the sign-in form — is indistinguishable
 * from being signed out, which is both untrue and alarming. This keeps the user
 * informed, retries on its own while the tab is visible, and gives up only when
 * the server actually refuses the session.
 */
function mountOffline(container, lastUser) {
  let attempts = 0;
  let stopped = false;
  let timer = null;

  const status = el('p', { class: 'muted', text: 'Trying to reconnect…' });
  const retry = el('button', { class: 'btn btn-primary', type: 'button', text: 'Retry now' });
  const wrap = el(
    'div',
    { class: 'auth-wrap' },
    el('h1', { text: 'Connection lost' }),
    el(
      'p',
      { text: `We could not reach Re-EL Mailer, so we cannot confirm your sign-in for ${lastUser.email} yet. You are not signed out.` },
    ),
    status,
    retry,
    el('a', { href: '#/', class: 'muted', text: 'Sign in with a different account' }),
  );

  // Back off, but stay responsive: the first few attempts are close together,
  // then settle at a steady cadence rather than hammering the API.
  const nextDelay = () => Math.min(1000 * 2 ** attempts++, 15000);

  async function attempt() {
    if (stopped) return;
    retry.disabled = true;
    try {
      const user = await loadSession();
      // Only a real session gets you in. If the server answers but rejects the
      // cookie, the sign-in form is the honest answer.
      if (!user) throw new Error('rejected');
      stopped = true;
      const { name } = currentRoute();
      enterShell();
      if (!name || name === 'login' || name === '') navigate('inbox', { replace: true });
      return;
    } catch (err) {
      if (err?.code !== 'NETWORK_ERROR') {
        stopped = true;
        navigate('', { replace: true });
        return;
      }
      attempts += 1;
      status.textContent = `Still trying… (attempt ${attempts})`;
      retry.disabled = false;
      // Do not keep polling a tab nobody is looking at.
      if (document.visibilityState === 'visible') timer = setTimeout(attempt, nextDelay());
    }
  }

  retry.addEventListener('click', () => {
    clearTimeout(timer);
    attempts = 0;
    attempt();
  });

  // A tab restored from the background is the most likely moment for the network
  // to be healthy again, so reconnect the moment it becomes visible.
  document.addEventListener('visibilitychange', () => {
    if (stopped || document.visibilityState !== 'visible') return;
    clearTimeout(timer);
    attempt();
  });

  mount(container, wrap);
  attempt();
}

/* ── Routes ────────────────────────────────────────────────────────────── */

// Public screens (also registered so the router can navigate to them).
route('', async (container) => {
  const { name, query } = currentRoute();
  if (!state.user) {
    if (name === 'forgot') return renderForgot(container);
    if (name === 'reset') return renderReset(container, { query });
    if (name === 'change-password') return renderChangePassword(container);
    return renderLogin(container);
  }
  // Session valid but the password must change first: never render mail here.
  if (state.session?.mustChangePassword) {
    navigate('change-password', { replace: true });
    return undefined;
  }
  return renderMailList(container, { params: ['inbox'], query: {} });
});

route('forgot', (container) => renderForgot(container));
route('reset', (container, ctx) => renderReset(container, ctx));
route('change-password', (container) => renderChangePassword(container));

// Mail screens (guarded).
route('inbox', guard((c, ctx) => renderMailList(c, { params: ['inbox'], query: ctx.query })));
route('starred', guard((c, ctx) => renderMailList(c, { params: ['starred'], query: ctx.query })));
route('drafts', guard((c, ctx) => renderMailList(c, { params: ['drafts'], query: ctx.query })));
route('sent', guard((c, ctx) => renderMailList(c, { params: ['sent'], query: ctx.query })));
route('archive', guard((c, ctx) => renderMailList(c, { params: ['archive'], query: ctx.query })));
route('spam', guard((c, ctx) => renderMailList(c, { params: ['spam'], query: ctx.query })));
route('trash', guard((c, ctx) => renderMailList(c, { params: ['trash'], query: ctx.query })));
route('label', guard((c, ctx) => renderMailList(c, { params: ['label'], query: { ...ctx.query, label: ctx.params[0] } })));
route('search', guard((c, ctx) => renderMailList(c, { params: ['search'], query: ctx.query })));
route('message', guard((c, ctx) => renderMessage(c, ctx)));
route('compose', guard((c, ctx) => renderCompose(c, ctx)));
route('settings', guard((c) => renderSettings(c)));
route('admin', guard((c) => {
  if (!isAdmin()) {
    mount(c, el('div', { class: 'empty', text: 'You do not have access to the admin console.' }));
    return undefined;
  }
  return renderAdmin(c);
}));

/** Wrap a view so it redirects to sign-in when there is no session. */
function guard(render) {
  return async (container, ctx) => {
    if (!state.user) {
      navigate('', { replace: true });
      return undefined;
    }
    // A valid session is not enough while a password change is outstanding.
    if (state.session?.mustChangePassword) {
      navigate('change-password', { replace: true });
      return undefined;
    }
    return render(container, ctx);
  };
}

/* ── Boot ──────────────────────────────────────────────────────────────── */

async function boot() {
  loadLocalPrefs();
  applyTheme();
  document.documentElement.dataset.density = state.density;

  // React to mailbox/theme changes from anywhere in the app.
  subscribe(() => {
    if (!shellNode) return;
    const sel = shellNode.querySelector('.mailbox-select');
    if (sel && sel.value !== state.activeMailboxId) sel.value = state.activeMailboxId || '';
  });

  let user = null;
  let bootError = null;
  try {
    user = await loadSession(); // restores from refresh cookie
  } catch (err) {
    bootError = err;
  }

  // A request that never arrived is not the same as a rejected session. Treating
  // the two alike sent a signed-in user to the sign-in form every time the
  // connection wobbled, which they reasonably read as being logged out. Retry
  // quietly first, then say plainly that the connection is the problem.
  if (bootError && bootError.code === 'NETWORK_ERROR' && lastKnownUser()) {
    enterPublic();
    startRouter(document.getElementById('auth-view'));
    mountOffline(document.getElementById('auth-view'), lastKnownUser());
    return;
  }

  const { name } = currentRoute();

  if (!user || user.mustChangePassword) {
    // A forced password change keeps the user on the public surface even though
    // the session is valid, so the mail shell stays out of reach until it is done.
    enterPublic();
    startRouter(document.getElementById('auth-view'));
    if (user) navigate('change-password', { replace: true });
    return;
  }

  enterShell();
  startRouter(viewRoot);

  // Land signed-in users on the inbox unless they deep-linked somewhere.
  if (!name || name === 'login' || name === '') navigate('inbox', { replace: true });
}

// A successful sign-in (including finishing a forced password change) swaps the
// auth container for the mail shell and lands on the inbox.
onSignedIn(({ forcePasswordChange } = {}) => {
  if (forcePasswordChange || !state.user) return;
  enterShell();
  const { name } = currentRoute();
  if (name === '' || name === 'login' || name === 'change-password') navigate('inbox', { replace: true });
});

window.addEventListener('error', (event) => {
  console.error('Unhandled error', event.error || event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled rejection', event.reason);
});

document.addEventListener('DOMContentLoaded', () => {
  boot().catch((err) => {
    console.error('Boot failed', err);
    toast('Could not start Re-EL Mailer. Please refresh.', 'error');
  });
});