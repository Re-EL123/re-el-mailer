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

/**
 * Build a <select> from [value, label] pairs.
 */
function selectOf(options, value) {
  const select = el('select', {}, ...options.map(([v, label]) => el('option', { value: v, text: label })));
  if (value != null) select.value = value;
  return select;
}

const CONDITION_FIELDS = [
  ['from', 'From'], ['to', 'To'], ['subject', 'Subject'], ['body', 'Body'],
  ['has_attachments', 'Has attachments'], ['folder', 'Folder'],
];
const CONDITION_OPERATORS = [
  ['contains', 'contains'], ['not_contains', 'does not contain'], ['equals', 'equals'],
  ['not_equals', 'is not'], ['starts_with', 'starts with'], ['ends_with', 'ends with'],
  ['is_empty', 'is empty'], ['is_not_empty', 'is not empty'],
  ['is_true', 'is true'], ['is_false', 'is false'],
];
const RULE_ACTIONS = [
  ['move', 'Move to folder'], ['label', 'Add label'], ['star', 'Star'], ['mark_read', 'Mark read'],
  ['mark_unread', 'Mark unread'], ['archive', 'Archive'], ['trash', 'Move to trash'],
  ['assign', 'Assign to a user'], ['notify', 'Notify mailbox owners'], ['snooze', 'Snooze'],
  ['auto_reply', 'Send auto-reply'],
];
const MOVABLE_FOLDERS = [['inbox', 'Inbox'], ['archive', 'Archive'], ['spam', 'Spam'], ['trash', 'Trash']];

/** An editable summary of one rule's conditions and actions. */
function ruleSummary(rule) {
  const conditions = rule.conditions?.conditions || [];
  const actions = rule.actions || [];
  const condText = conditions
    .map((c) => `${c.field} ${String(c.operator || 'contains').replace(/_/g, ' ')}${c.value != null ? ` "${c.value}"` : ''}`)
    .join(rule.conditions?.match === 'any' ? ' or ' : ' and ') || 'any message';
  const actionText = actions.map((a) => String(a.type || '').replace(/_/g, ' ')).join(', ') || 'no actions';
  return `When ${condText}: ${actionText}.`;
}

/**
 * Canned responses.
 *
 * The composer can insert these; this is where they are written. Only the
 * plain-text body is edited here — the rich HTML variant is optional and the
 * composer falls back to wrapping this text, so an operator never has to write
 * markup by hand to get a usable canned reply.
 */
async function templatesCard(mailboxes) {
  let current = state.activeMailboxId || mailboxes[0].id;
  const list = el('div', { class: 'setting-rows' });
  const card = section(
    'Canned responses',
    el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Mailbox' }),
      mailboxPicker(mailboxes, async (id) => { current = id; await refresh(); })),
    list,
  );

  const nameInput = el('input', { class: 'field', placeholder: 'Name', maxlength: 120 });
  const subjectInput = el('input', { class: 'field', placeholder: 'Subject (optional)', maxlength: 200 });
  const bodyInput = el('textarea', { class: 'field', rows: 2, placeholder: 'Body text' });

  async function add() {
    if (!nameInput.value.trim()) { toast('Give the response a name.', 'error'); return; }
    try {
      await api.automation.createTemplate({
        name: nameInput.value.trim(),
        subject: subjectInput.value.trim() || null,
        bodyText: bodyInput.value,
      }, current);
      nameInput.value = '';
      subjectInput.value = '';
      bodyInput.value = '';
      toast('Canned response saved.', 'success');
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function refresh() {
    let templates = [];
    try {
      templates = (await api.automation.templates(current)).templates || [];
    } catch (err) {
      mount(list, el('p', { class: 'muted small', text: err.message }));
      return;
    }

    mount(list,
      ...(templates.length
        ? templates.map((tpl) => {
            const name = el('input', { class: 'field', value: tpl.name, 'aria-label': `Name for ${tpl.name}`, maxlength: 120 });
            const subject = el('input', { class: 'field', value: tpl.subject || '', 'aria-label': `Subject for ${tpl.name}`, maxlength: 200 });
            const body = el('textarea', { class: 'field', rows: 2, 'aria-label': `Body for ${tpl.name}` });
            body.value = tpl.bodyText || '';
            return el('div', { class: 'template-row' },
              name,
              subject,
              body,
              el('div', { class: 'row-actions' },
                el('button', { class: 'btn btn-sm btn-primary', text: 'Save', onClick: async () => {
                  try {
                    await api.automation.updateTemplate(tpl.id, {
                      name: name.value.trim(),
                      subject: subject.value.trim() || null,
                      bodyText: body.value,
                    }, current);
                    toast('Canned response updated.', 'success');
                    await refresh();
                  } catch (err) { toast(err.message, 'error'); }
                } }),
                el('button', { class: 'btn btn-sm', text: 'Delete', onClick: async () => {
                  if (!confirm(`Delete the canned response "${tpl.name}"?`)) return;
                  try {
                    await api.automation.deleteTemplate(tpl.id, current);
                    toast('Canned response deleted.', 'success');
                    await refresh();
                  } catch (err) { toast(err.message, 'error'); }
                } }),
              ),
            );
          })
        : [el('p', { class: 'muted small', text: 'No canned responses yet.' })]),
    );
  }

  card.append(
    el('div', { class: 'setting-grid' },
      el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'New response' }), nameInput),
      el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Subject' }), subjectInput),
    ),
    el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Body' }), bodyInput),
    el('button', { class: 'btn btn-primary', text: 'Add canned response', onClick: add }),
  );

  await refresh();
  return card;
}

/** Out-of-office auto-reply, stored on the mailbox row. */
async function autoReplyCard(mailboxes) {
  let current = state.activeMailboxId || mailboxes[0].id;
  const status = el('p', { class: 'setting-note' });
  const enabled = el('input', { type: 'checkbox', class: 'toggle', 'aria-label': 'Enable out-of-office' });
  const subject = el('input', { class: 'field', placeholder: 'Out of office', maxlength: 200 });
  const body = el('textarea', { class: 'field', rows: 4, placeholder: 'I am away and will reply when I return.' });
  const interval = el('input', { type: 'number', class: 'field', min: '1', value: '1440' });
  const start = el('input', { type: 'datetime-local', class: 'field' });
  const end = el('input', { type: 'datetime-local', class: 'field' });

  function fill(data) {
    enabled.checked = Boolean(data?.enabled);
    subject.value = data?.subject || '';
    body.value = data?.body || '';
    interval.value = String(data?.intervalMinutes ?? 1440);
    start.value = data?.start ? String(data.start).slice(0, 16) : '';
    end.value = data?.end ? String(data.end).slice(0, 16) : '';
    status.textContent = enabled.checked ? 'Auto-reply is on.' : 'Auto-reply is off.';
  }

  async function load() {
    try {
      fill((await api.automation.autoReply(current)).autoReply);
    } catch (err) {
      status.textContent = err.message;
    }
  }

  const save = el('button', { class: 'btn btn-primary', text: 'Save auto-reply', onClick: async () => {
    save.disabled = true;
    try {
      await api.automation.setAutoReply({
        enabled: enabled.checked,
        subject: subject.value.trim() || null,
        body: body.value,
        intervalMinutes: Number(interval.value) || 1440,
        start: start.value ? new Date(start.value).toISOString() : null,
        end: end.value ? new Date(end.value).toISOString() : null,
      }, current);
      toast('Auto-reply saved.', 'success');
      await load();
    } catch (err) { toast(err.message, 'error'); } finally { save.disabled = false; }
  } });

  const card = section(
    'Out of office',
    el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Mailbox' }),
      mailboxPicker(mailboxes, async (id) => { current = id; await load(); })),
    el('label', { class: 'field field-inline' }, enabled, el('span', { text: 'Send an automatic reply to new mail' })),
    el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Subject' }), subject),
    el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Body' }), body),
    el('div', { class: 'setting-grid' },
      el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Reply at most every (minutes)' }), interval),
      el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Start (optional)' }), start),
      el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'End (optional)' }), end),
    ),
    el('p', { class: 'setting-note', text: 'Each correspondent is replied to at most once per interval, which is what keeps an auto-reply from looping.' }),
    save,
    status,
  );

  await load();
  return card;
}

/** Inbound rules: list with enable/delete, plus a single-condition builder. */
async function rulesCard(mailboxes) {
  let current = state.activeMailboxId || mailboxes[0].id;
  const list = el('div', { class: 'setting-rows' });
  const card = section(
    'Rules',
    el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Mailbox' }),
      mailboxPicker(mailboxes, async (id) => { current = id; await refresh(); })),
    list,
  );

  const name = el('input', { class: 'field', placeholder: 'Rule name', maxlength: 120 });
  const field = selectOf(CONDITION_FIELDS, 'from');
  const operator = selectOf(CONDITION_OPERATORS, 'contains');
  const value = el('input', { class: 'field', placeholder: 'Value' });
  const actionType = selectOf(RULE_ACTIONS, 'move');
  const actionTarget = el('input', { class: 'field', placeholder: 'Folder name' });

  const targetFor = () => {
    if (actionType.value === 'move') actionTarget.placeholder = 'Folder (e.g. archive)';
    else if (actionType.value === 'label') actionTarget.placeholder = 'Label id';
    else if (actionType.value === 'assign') actionTarget.placeholder = 'User id';
    else if (actionType.value === 'notify') actionTarget.placeholder = 'Notification title';
    else if (actionType.value === 'snooze') actionTarget.placeholder = 'Minutes';
    else actionTarget.placeholder = 'Not needed';
  };
  targetFor();
  actionType.addEventListener('change', targetFor);

  function buildAction() {
    const target = actionTarget.value.trim();
    switch (actionType.value) {
      case 'move': return { type: 'move', folder: target || 'inbox' };
      case 'label': return { type: 'label', labelId: target || undefined };
      case 'assign': return { type: 'assign', userId: target || null };
      case 'notify': return { type: 'notify', title: target || 'Rule matched' };
      case 'snooze': return { type: 'snooze', minutes: Number(target) || 60 };
      default: return { type: actionType.value };
    }
  }

  async function add() {
    if (!name.value.trim()) { toast('Give the rule a name.', 'error'); return; }
    const condition = { field: field.value, operator: operator.value, value: value.value || null };
    try {
      await api.automation.createRule({
        name: name.value.trim(),
        direction: 'inbound',
        conditions: { match: 'all', conditions: [condition] },
        actions: [buildAction()],
      }, current);
      name.value = '';
      value.value = '';
      actionTarget.value = '';
      toast('Rule created.', 'success');
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function refresh() {
    let rules = [];
    try {
      rules = (await api.automation.rules(current)).rules || [];
    } catch (err) {
      mount(list, el('p', { class: 'muted small', text: err.message }));
      return;
    }

    mount(list,
      ...(rules.length
        ? rules.map((rule) => {
            const toggle = el('input', { type: 'checkbox', class: 'toggle', checked: rule.isActive, 'aria-label': `Enable ${rule.name}` });
            toggle.addEventListener('change', async () => {
              try {
                await api.automation.updateRule(rule.id, { isActive: toggle.checked }, current);
                toast(toggle.checked ? 'Rule enabled.' : 'Rule paused.', 'success');
              } catch (err) { toast(err.message, 'error'); toggle.checked = !toggle.checked; }
            });
            return el('div', { class: 'rule-row' },
              toggle,
              el('div', { class: 'rule-body' },
                el('span', { class: 'rule-name', text: rule.name }),
                el('span', { class: 'muted small', text: ruleSummary(rule) }),
              ),
              el('button', { class: 'btn btn-sm', text: 'Delete', onClick: async () => {
                if (!confirm(`Delete the rule "${rule.name}"?`)) return;
                try {
                  await api.automation.deleteRule(rule.id, current);
                  toast('Rule deleted.', 'success');
                  await refresh();
                } catch (err) { toast(err.message, 'error'); }
              } }),
            );
          })
        : [el('p', { class: 'muted small', text: 'No rules yet.' })]),
    );
  }

  card.append(
    el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'New rule' }), name),
    el('div', { class: 'setting-grid' },
      el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'When' }), field),
      el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Operator' }), operator),
      el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Value' }), value),
      el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Then' }), actionType),
      el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Target' }), actionTarget),
    ),
    el('button', { class: 'btn btn-primary', text: 'Add rule', onClick: add }),
  );

  await refresh();
  return card;
}

/** Outbound webhook endpoints. */
async function webhooksCard(mailboxes) {
  let current = state.activeMailboxId || mailboxes[0].id;
  const list = el('div', { class: 'setting-rows' });
  const secretNote = el('p', { class: 'setting-note' });
  const card = section(
    'Webhooks',
    el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Mailbox' }),
      mailboxPicker(mailboxes, async (id) => { current = id; await refresh(); })),
    list,
    secretNote,
  );

  const url = el('input', { class: 'field', type: 'url', placeholder: 'https://example.com/hook', maxlength: 2048 });
  const description = el('input', { class: 'field', placeholder: 'Description (optional)', maxlength: 200 });
  const events = el('input', { class: 'field', placeholder: 'message.received, message.sent' });

  async function add() {
    if (!url.value.trim()) { toast('Enter a webhook URL.', 'error'); return; }
    try {
      const data = await api.automation.createWebhook({
        url: url.value.trim(),
        description: description.value.trim() || null,
        events: events.value.split(',').map((e) => e.trim()).filter(Boolean),
      }, current);
      secretNote.textContent = data.secret
        ? `Signing secret (shown once, store it now): ${data.secret}`
        : '';
      url.value = '';
      description.value = '';
      events.value = '';
      toast('Webhook created.', 'success');
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function refresh() {
    let hooks = [];
    try {
      hooks = (await api.automation.webhooks(current)).webhooks || [];
    } catch (err) {
      mount(list, el('p', { class: 'muted small', text: err.message }));
      return;
    }

    mount(list,
      ...(hooks.length
        ? hooks.map((hook) => {
            const toggle = el('input', { type: 'checkbox', class: 'toggle', checked: hook.isActive, 'aria-label': `Enable webhook ${hook.url}` });
            toggle.addEventListener('change', async () => {
              try {
                await api.automation.updateWebhook(hook.id, { isActive: toggle.checked }, current);
                toast(toggle.checked ? 'Webhook enabled.' : 'Webhook paused.', 'success');
              } catch (err) { toast(err.message, 'error'); toggle.checked = !toggle.checked; }
            });
            return el('div', { class: 'rule-row' },
              toggle,
              el('div', { class: 'rule-body' },
                el('span', { class: 'rule-name', text: hook.url }),
                el('span', { class: 'muted small', text: (hook.events && hook.events.length ? hook.events.join(', ') : 'all events') + (hook.description ? ` — ${hook.description}` : '') }),
              ),
              el('button', { class: 'btn btn-sm', text: 'Delete', onClick: async () => {
                if (!confirm(`Delete the webhook for ${hook.url}?`)) return;
                try {
                  await api.automation.deleteWebhook(hook.id, current);
                  toast('Webhook deleted.', 'success');
                  await refresh();
                } catch (err) { toast(err.message, 'error'); }
              } }),
            );
          })
        : [el('p', { class: 'muted small', text: 'No webhooks yet.' })]),
    );
  }

  card.append(
    el('div', { class: 'setting-grid' },
      el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'URL' }), url),
      el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Events' }), events),
      el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Description' }), description),
    ),
    el('button', { class: 'btn btn-primary', text: 'Add webhook', onClick: add }),
  );

  await refresh();
  return card;
}

/** The automation cards, in the order an operator usually reaches for them. */
async function automationSections(mailboxes) {
  return [
    await templatesCard(mailboxes),
    await autoReplyCard(mailboxes),
    await rulesCard(mailboxes),
    await webhooksCard(mailboxes),
  ];
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

  // ── Automation ──
  if (mailboxes.length) {
    for (const card of await automationSections(mailboxes)) app.append(card);
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