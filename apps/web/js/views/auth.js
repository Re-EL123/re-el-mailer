/**
 * Auth screens: sign in, forgot password, reset password, and the forced
 * "change your password" gate shown after an admin provisions an account.
 */

import { api, ApiError, describeApiError } from '../api.js';
import { el, mount, toast } from '../ui.js';
import { state, setState, adoptSession, saveTheme } from '../store.js';
import { navigate } from '../router.js';
import { notifySignedIn } from '../auth-events.js';

function brandPanel() {
  return el(
    'div',
    { class: 'auth-brand' },
    el('img', { class: 'auth-logo', src: 'assets/icon-192.svg', alt: '', width: 56, height: 56 }),
    el('h1', { class: 'auth-title', text: 'Re-EL Mailer' }),
    el('p', { class: 'auth-tagline', text: 'Business email. Built for Re-EL.' }),
  );
}

function field(label, input) {
  return el('label', { class: 'field' }, el('span', { class: 'field-label', text: label }), input);
}

function errorBox() {
  return el('div', { class: 'form-error', hidden: true, role: 'alert' });
}

function showError(box, err) {
  box.textContent = describeApiError(err);
  box.hidden = false;
}

/** Strip HTML from a server-rendered error into plain text. */
function fieldErrors(err) {
  if (!(err instanceof ApiError) || !Array.isArray(err.details)) return {};
  const map = {};
  for (const issue of err.details) {
    if (issue?.field) map[issue.field] = issue.message;
  }
  return map;
}

function loginView(container) {
  const box = errorBox();
  const email = el('input', { type: 'email', name: 'email', required: true, autocomplete: 'username', placeholder: 'you@re-el.co.za' });
  const password = el('input', { type: 'password', name: 'password', required: true, autocomplete: 'current-password', placeholder: '••••••••' });
  const submit = el('button', { class: 'btn btn-primary btn-block', type: 'submit', text: 'Sign in' });

  const form = el(
    'form',
    { class: 'auth-form', novalidate: true },
    field('Email address', email),
    field('Password', password),
    box,
    submit,
    el(
      'div',
      { class: 'auth-links' },
      el('a', { href: '#/forgot', text: 'Forgot your password?' }),
      el('a', { href: '#/', class: 'muted', text: 'Back to sign in' }),
    ),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    box.hidden = true;
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    try {
      const data = await api.auth.login(email.value.trim(), password.value);
      // Install the token and mailboxes before routing: the mail routes are
      // guarded on `state.user`, so navigating first bounces straight back here.
      adoptSession(data);
      // Read from state, not the raw response: the API reports the flag on the
      // user, so `data.session?.mustChangePassword` was always undefined and the
      // forced password change was skipped for a temporary-password account.
      if (state.session?.mustChangePassword) {
        // Still show the auth surface for the password gate.
        notifySignedIn({ forcePasswordChange: true });
        navigate('change-password', { replace: true });
        return;
      }
      toast(`Welcome back, ${data.user.displayName || data.user.email}.`, 'success');
      notifySignedIn();
      navigate('inbox', { replace: true });
    } catch (err) {
      const fields = fieldErrors(err);
      if (fields.email) email.setCustomValidity(fields.email);
      showError(box, err);
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  });

  mount(container, el('div', { class: 'auth-wrap' }, brandPanel(), form));
}

function forgotView(container) {
  const box = errorBox();
  const email = el('input', { type: 'email', required: true, autocomplete: 'username', placeholder: 'you@re-el.co.za' });
  const submit = el('button', { class: 'btn btn-primary btn-block', type: 'submit', text: 'Send reset link' });
  const note = el('p', { class: 'muted small', text: '' });

  const form = el(
    'form',
    { class: 'auth-form' },
    field('Email address', email),
    box,
    submit,
    note,
    el('a', { href: '#/', class: 'muted', text: 'Back to sign in' }),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    box.hidden = true;
    submit.disabled = true;
    try {
      await api.auth.forgot(email.value.trim());
      note.textContent = 'If that address has an account, a reset link is on its way.';
      submit.disabled = true;
      submit.textContent = 'Sent';
    } catch (err) {
      showError(box, err);
      submit.disabled = false;
    }
  });

  mount(container, el('div', { class: 'auth-wrap' }, brandPanel(), form));
}

function resetView(container, ctx) {
  const box = errorBox();
  const token = ctx.query.token || '';
  const password = el('input', { type: 'password', required: true, autocomplete: 'new-password', placeholder: 'At least 8 characters' });
  const confirm = el('input', { type: 'password', required: true, autocomplete: 'new-password' });
  const submit = el('button', { class: 'btn btn-primary btn-block', type: 'submit', text: 'Set new password' });

  const form = el(
    'form',
    { class: 'auth-form' },
    !token ? el('div', { class: 'form-error', text: 'This reset link is missing its token.' }) : null,
    field('New password', password),
    field('Confirm password', confirm),
    box,
    submit,
    el('a', { href: '#/', class: 'muted', text: 'Back to sign in' }),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    box.hidden = true;
    if (password.value !== confirm.value) {
      showError(box, new ApiError('The passwords do not match.'));
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Saving…';
    try {
      await api.auth.reset(token, password.value);
      toast('Password updated. You can sign in now.', 'success');
      navigate('', { replace: true });
    } catch (err) {
      showError(box, err);
      submit.disabled = false;
      submit.textContent = 'Set new password';
    }
  });

  mount(container, el('div', { class: 'auth-wrap' }, brandPanel(), form));
}

function changePasswordView(container) {
  const box = errorBox();
  const current = el('input', { type: 'password', required: true, autocomplete: 'current-password' });
  // The server requires 10+ characters; enforcing it here avoids a round trip
  // that used to end in an unexplained generic validation message.
  const next = el('input', {
    type: 'password',
    required: true,
    minlength: 10,
    maxlength: 72,
    autocomplete: 'new-password',
  });
  const submit = el('button', { class: 'btn btn-primary btn-block', type: 'submit', text: 'Update password' });

  const form = el(
    'form',
    { class: 'auth-form' },
    el('p', { class: 'muted', text: 'You must change your temporary password before continuing.' }),
    field('Current password', current),
    field('New password', next),
    el('p', { class: 'muted', text: 'At least 10 characters.' }),
    box,
    submit,
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    box.hidden = true;
    submit.disabled = true;
    try {
      await api.auth.changePassword(current.value, next.value);
      setState({ session: { ...(state.session || {}), mustChangePassword: false } });
      toast('Password updated.', 'success');
      // Leaves the auth surface for the mail shell; a no-op if already there.
      notifySignedIn();
      navigate('inbox', { replace: true });
    } catch (err) {
      showError(box, err);
      submit.disabled = false;
    }
  });

  mount(container, el('div', { class: 'auth-wrap' }, brandPanel(), form));
}

export function renderLogin(container) {
  loginView(container);
}

export function renderForgot(container) {
  forgotView(container);
}

export function renderReset(container, ctx) {
  resetView(container, ctx);
}

export function renderChangePassword(container) {
  changePasswordView(container);
}

/** Small theme toggle shown on auth screens. */
export function themeToggle() {
  return el('button', {
    class: 'icon-btn',
    title: 'Toggle theme',
    'aria-label': 'Toggle theme',
    text: '◐',
    onClick: () => saveTheme(state.theme === 'dark' ? 'light' : 'dark'),
  });
}