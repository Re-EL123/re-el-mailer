/**
 * Settings: appearance, account security, and per-mailbox signature / reply-to.
 */

import { api } from '../api.js';
import { el, mount, toast } from '../ui.js';
import { saveDensity, saveMailbox, saveTheme, state } from '../store.js';

function section(title, ...children) {
  return el('section', { class: 'card' }, el('h3', { class: 'card-title', text: title }), ...children);
}

/** Mailbox picker for anything that needs one, kept in sync with the store. */
function mailboxPicker(mailboxes, onChange) {
  const select = el('select', {},
    ...mailboxes.map((mb) => el('option', { value: mb.id, text: mb.email })));
  select.value = state.activeMailboxId || mailboxes[0]?.id || '';
  if (onChange) select.addEventListener('change', () => onChange(select.value));
  return select;
}

/**
 * Label management.
 *
 * The server has supported create/rename/recolour/delete since labels first
 * existed, but nothing in the UI ever called them, so labels could only be
 * created by seeding the database and the sidebar was effectively read-only.
 */
async function labelSection(mailboxes) {
  const list = el('div', {});
  const box = section('Labels', list);

  let current = state.activeMailboxId || mailboxes[0].id;

  async function refresh() {
    let labels = [];
    try {
      labels = (await api.mail.labels(current)).labels || [];
    } catch (err) {
      mount(list, el('p', { class: 'muted small', text: err.message }));
      return;
    }

    mount(list,
      labels.length
        ? labels.map((label) => el('div', { class: 'label-row' },
            el('span', { class: 'label-dot', style: { background: label.color || '#21396A' } }),
            el('input', {
              class: 'field',
              value: label.name,
              'aria-label': `Name for ${label.name}`,
              onChange: async (event) => {
                const name = event.target.value.trim();
                if (!name || name === label.name) return;
                try {
                  await api.mail.updateLabel(label.id, { name }, current);
                  toast('Label renamed.', 'success');
                  await refresh();
                } catch (err) {
                  toast(err.message, 'error');
                  await refresh();
                }
              },
            }),
            el('input', {
              type: 'color',
              class: 'label-swatch',
              value: label.color || '#21396A',
              'aria-label': `Colour for ${label.name}`,
              onChange: async (event) => {
                try {
                  await api.mail.updateLabel(label.id, { color: event.target.value }, current);
                  await refresh();
                } catch (err) { toast(err.message, 'error'); }
              },
            }),
            el('span', { class: 'muted small', text: `${label.messageCount ?? 0} message(s)` }),
            el('button', { class: 'btn btn-sm', text: 'Delete', onClick: async () => {
              if (!confirm(`Delete the label "${label.name}"? Messages are not deleted.`)) return;
              try {
                await api.mail.deleteLabel(label.id, current);
                toast('Label deleted.', 'success');
                await refresh();
              } catch (err) { toast(err.message, 'error'); }
            } }),
          ))
        : el('p', { class: 'muted small', text: 'No labels yet. Add one below.' }),
    );
  }

  const newName = el('input', { class: 'field', placeholder: 'New label name', maxlength: 40 });
  const newColor = el('input', { type: 'color', class: 'label-swatch', value: '#21396A', 'aria-label': 'Colour for the new label' });

  async function add() {
    const name = newName.value.trim();
    if (!name) { toast('Enter a label name.', 'error'); return; }
    try {
      await api.mail.createLabel({ name, color: newColor.value }, current);
      newName.value = '';
      toast('Label created.', 'success');
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  }

  box.append(
    el('div', { class: 'setting-grid' },
      el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Mailbox' }),
        mailboxPicker(mailboxes, async (id) => { current = id; await refresh(); })),
      el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'New label' }),
        el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          newName, newColor,
          el('button', { class: 'btn btn-primary', text: 'Add', onClick: add }))),
    ),
    el('p', { class: 'setting-note', text: 'Labels are per mailbox. Deleting a label leaves its messages untouched.' }),
    list,
  );

  await refresh();
  return box;
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

  // ── Labels ──
  if (mailboxes.length) {
    app.append(await labelSection(mailboxes));
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