/**
 * Settings: appearance, account security, and per-mailbox signature / reply-to.
 */

import { api } from '../api.js';
import { el, mount, toast } from '../ui.js';
import { saveDensity, saveMailbox, saveTheme, state } from '../store.js';

function section(title, ...children) {
  return el('section', { class: 'card' }, el('h3', { class: 'card-title', text: title }), ...children);
}

export async function renderSettings(container) {
  const app = el('div', { class: 'settings' });

  // ── Appearance ──
  const themeSelect = el('select', {},
    el('option', { value: 'system', text: 'Match system' }),
    el('option', { value: 'light', text: 'Light' }),
    el('option', { value: 'dark', text: 'Dark' }),
  );
  themeSelect.value = state.theme;
  themeSelect.addEventListener('change', () => saveTheme(themeSelect.value));

  const densitySelect = el('select', {},
    el('option', { value: 'comfortable', text: 'Comfortable' }),
    el('option', { value: 'compact', text: 'Compact' }),
  );
  densitySelect.value = state.density;
  densitySelect.addEventListener('change', () => saveDensity(densitySelect.value));

  app.append(
    section('Appearance',
      el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Theme' }), themeSelect),
      el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Density' }), densitySelect),
    ),
  );

  // ── Signature / reply-to (per mailbox) ──
  let mailboxes = [];
  try {
    mailboxes = (await api.settings.mailboxes()).mailboxes || [];
  } catch { /* ignore */ }

  if (mailboxes.length) {
    const mailboxSelect = el('select', {}, ...mailboxes.map((mb) => el('option', { value: mb.id, text: mb.email })));
    mailboxSelect.value = state.activeMailboxId || mailboxes[0].id;

    const sigHtml = el('textarea', { class: 'field', rows: 4, placeholder: '<p>Kind regards,<br>Your name</p>' });
    const sigText = el('textarea', { class: 'field', rows: 3, placeholder: 'Kind regards,\nYour name' });
    const replyTo = el('input', { type: 'email', class: 'field', placeholder: 'reply-to@re-el.co.za' });

    function fill(mb) {
      sigHtml.value = mb.signatureHtml || '';
      sigText.value = mb.signatureText || '';
      replyTo.value = mb.replyTo || '';
    }
    fill(mailboxes.find((mb) => mb.id === mailboxSelect.value) || mailboxes[0]);
    mailboxSelect.addEventListener('change', () => fill(mailboxes.find((mb) => mb.id === mailboxSelect.value)));

    const saveBtn = el('button', { class: 'btn btn-primary', text: 'Save mailbox settings', onClick: async () => {
      saveBtn.disabled = true;
      try {
        await api.settings.updateMailbox({
          signatureHtml: sigHtml.value,
          signatureText: sigText.value,
          replyTo: replyTo.value || null,
        }, mailboxSelect.value);
        toast('Mailbox settings saved.', 'success');
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        saveBtn.disabled = false;
      }
    } });

    app.append(
      section('Signature & reply-to',
        el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Mailbox' }), mailboxSelect),
        el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Signature (HTML)' }), sigHtml),
        el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Signature (plain text)' }), sigText),
        el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Reply-to' }), replyTo),
        saveBtn,
      ),
    );
  }

  // ── Security ──
  const sessionsBtn = el('button', { class: 'btn', text: 'Refresh session list', onClick: async () => {
    try {
      const data = await api.auth.sessions();
      mount(sessionList, ...data.sessions.map((s) =>
        el('div', { class: 'session-row' },
          el('span', { text: s.userAgent || 'Unknown device' }),
          el('span', { class: 'muted small', text: new Date(s.lastUsedAt).toLocaleString() }),
          el('button', { class: 'btn btn-sm', text: 'Revoke', onClick: async () => {
            await api.auth.revokeSession(s.id); toast('Session revoked.', 'success'); sessionsBtn.click();
          } }),
        ),
      ));
    } catch (err) { toast(err.message, 'error'); }
  } });
  const sessionList = el('div', { class: 'sessions' });

  app.append(
    section('Security',
      el('button', { class: 'btn', text: 'Change password', onClick: () => { location.hash = '#/change-password'; } }),
      el('button', { class: 'btn', text: 'Sign out other devices', onClick: async () => {
        try {
          const data = await api.settings.disconnect();
          toast(`Signed out ${data.revoked} other session(s).`, 'success');
        } catch (err) { toast(err.message, 'error'); }
      } }),
      sessionsBtn,
      sessionList,
    ),
  );

  mount(container, app);
}