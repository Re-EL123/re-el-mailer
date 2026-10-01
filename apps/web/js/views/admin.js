/**
 * Admin console: platform overview, users, mailboxes, domains, inbound routes
 * and the audit log.
 *
 * Rendered only for admin/manager roles; the route guards on the client and the
 * API re-checks every action server-side. Anything destructive goes through
 * `confirmAction()` because these calls are irreversible — deleting a domain or
 * mailbox takes its mail with it.
 */

import { api, ApiError } from '../api.js';
import { el, formatBytes, mount, toast } from '../ui.js';
import { isOwner } from '../store.js';

/** Run a destructive call behind a confirmation, reporting failures inline. */
async function confirmAction(message, action, { done } = {}) {
  if (!window.confirm(message)) return false;
  try {
    await action();
    toast('Done.', 'success');
    if (done) await done();
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

function errorBox(message) {
  return el('div', { class: 'empty', text: message instanceof ApiError ? message.message : String(message) });
}

/** Small labelled input used by the create forms. */
function field(label, input) {
  return el('label', { class: 'field' }, el('span', { class: 'field-label', text: label }), input);
}

function card(title, ...children) {
  return el('section', { class: 'card' }, el('h3', { class: 'card-title', text: title }), ...children);
}

function statTile(label, value) {
  return el('div', { class: 'stat' }, el('div', { class: 'stat-value', text: String(value ?? 0) }), el('div', { class: 'stat-label', text: label }));
}

async function overviewTab() {
  const node = el('div', { class: 'admin-tab' }, el('div', { class: 'loading', text: 'Loading overview…' }));
  try {
    const data = await api.admin.overview(14);
    const s = data.stats || {};
    mount(
      node,
      el('div', { class: 'stats-grid' },
        statTile('Users', s.users), statTile('Mailboxes', s.mailboxes),
        statTile('Messages', s.messages), statTile('Storage', formatBytes(s.storageBytes)),
        statTile('Sent (30d)', s.sent30d), statTile('Received (30d)', s.received30d),
      ),
      el('h4', { text: 'Recent activity' }),
      el('ul', { class: 'activity' }, ...(data.activity || []).map((a) =>
        el('li', { class: 'activity-item' },
          el('span', { class: 'activity-action', text: a.action }),
          el('span', { class: 'muted small', text: a.actorEmail || 'system' }),
          el('span', { class: 'muted small', text: new Date(a.createdAt).toLocaleString() }),
        ),
      )),
    );
  } catch (err) {
    mount(node, el('div', { class: 'empty', text: err.message }));
  }
  return node;
}

async function usersTab() {
  const node = el('div', { class: 'admin-tab' }, el('div', { class: 'loading', text: 'Loading users…' }));
  try {
    const data = await api.admin.users({ limit: 200 });
    const table = el('table', { class: 'table' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'Email' }), el('th', { text: 'Name' }), el('th', { text: 'Role' }),
        el('th', { text: 'Status' }), el('th', { text: 'Mailboxes' }), el('th', { text: 'Actions' }),
      )),
      el('tbody', {}, ...data.users.map((user) =>
        el('tr', {},
          el('td', { text: user.email }),
          el('td', { text: user.displayName }),
          el('td', {}, el('select', {
            onChange: async (e) => {
              try { await api.admin.updateUser(user.id, { role: e.target.value }); toast('Role updated.', 'success'); }
              catch (err) { toast(err.message, 'error'); e.target.value = user.role; }
            },
          }, ...['admin', 'manager', 'user'].map((role) => el('option', { value: role, text: role, selected: role === user.role })))),
          el('td', {}, el('select', {
            onChange: async (e) => {
              try { await api.admin.updateUser(user.id, { status: e.target.value }); toast('Status updated.', 'success'); }
              catch (err) { toast(err.message, 'error'); e.target.value = user.status; }
            },
          }, ...['active', 'disabled', 'pending'].map((s) => el('option', { value: s, text: s, selected: s === user.status })))),
          el('td', { text: user.mailboxes.map((m) => m.email).join(', ') || '—' }),
          el('td', {},
            el('button', { class: 'btn btn-sm', text: 'Reset password', onClick: async () => {
              try {
                const res = await api.admin.resetPassword(user.id, {});
                toast(res.temporaryPassword ? `Temporary password: ${res.temporaryPassword}` : 'Password reset.', 'success');
              } catch (err) { toast(err.message, 'error'); }
            } }),
            user.lockedUntil ? el('button', { class: 'btn btn-sm', text: 'Unlock', onClick: async () => {
              try { await api.admin.updateUser(user.id, { unlock: true }); toast('Unlocked.', 'success'); } catch (err) { toast(err.message, 'error'); }
            } }) : null,
          ),
        ),
      )),
    );
    mount(node, table);
  } catch (err) {
    mount(node, el('div', { class: 'empty', text: err.message }));
  }
  return node;
}

async function mailboxesTab() {
  const node = el('div', { class: 'admin-tab' }, el('div', { class: 'loading', text: 'Loading mailboxes…' }));
  try {
    const data = await api.admin.mailboxes({ limit: 500 });
    mount(node, el('table', { class: 'table' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'Address' }), el('th', { text: 'Display name' }), el('th', { text: 'Status' }),
        el('th', { text: 'Storage' }), el('th', { text: 'Quota' }),
      )),
      el('tbody', {}, ...data.mailboxes.map((mb) =>
        el('tr', {},
          el('td', { text: mb.email }), el('td', { text: mb.displayName }), el('td', { text: mb.status }),
          el('td', { text: formatBytes(mb.storageUsedBytes) }), el('td', { text: formatBytes(mb.quotaBytes) }),
        ),
      )),
    ));
  } catch (err) {
    mount(node, el('div', { class: 'empty', text: err.message }));
  }
  return node;
}

async function domainsTab() {
  const node = el('div', { class: 'admin-tab' }, el('div', { class: 'loading', text: 'Loading domains…' }));
  try {
    const data = await api.admin.domains();
    const nameInput = el('input', { type: 'text', placeholder: 'example.co.za', required: true });
    const statusSelect = el(
      'select',
      {},
      ...['pending', 'active', 'suspended'].map((s) => el('option', { value: s, text: s })),
    );
    const createBtn = el('button', { class: 'btn btn-primary', text: 'Add domain' });

    createBtn.addEventListener('click', async () => {
      createBtn.disabled = true;
      const created = await confirmAction(`Add the domain ${nameInput.value.trim()}?`, async () => {
        await api.admin.createDomain({ name: nameInput.value.trim(), status: statusSelect.value });
      }, { done: () => domainsTab().then((next) => mount(node, next)) });
      createBtn.disabled = false;
      if (!created) return;
      nameInput.value = '';
    });

    mount(
      node,
      card(
        'Domains',
        el('table', { class: 'table' },
          el('thead', {}, el('tr', {},
            el('th', { text: 'Domain' }), el('th', { text: 'Status' }), el('th', { text: 'Mailboxes' }),
            el('th', { text: 'Actions' }),
          )),
          el('tbody', {}, ...(data.domains || []).map((d) =>
            el('tr', {},
              el('td', {}, el('span', { text: d.name }), el('div', { class: 'muted small', text: `Added ${new Date(d.createdAt).toLocaleDateString()}` })),
              el('td', {}, el('select', {
                onChange: async (e) => {
                  try {
                    await api.admin.updateDomain(d.id, { status: e.target.value });
                    toast('Domain updated.', 'success');
                  } catch (err) {
                    toast(err.message, 'error');
                    e.target.value = d.status;
                  }
                },
              }, ...['pending', 'active', 'suspended'].map((s) => el('option', { value: s, text: s, selected: s === d.status })))),
              el('td', { text: `${d.activeMailboxes} active / ${d.mailboxCount}` }),
              el('td', {}, d.mailboxCount === 0 && isOwner()
                ? el('button', { class: 'btn btn-sm', text: 'Delete', onClick: async () => {
                    await confirmAction(`Delete ${d.name}? This cannot be undone.`, () => api.admin.deleteDomain(d.id),
                      { done: () => domainsTab().then((next) => mount(node, next)) });
                  } })
                : el('span', { class: 'muted small', text: d.mailboxCount ? 'Has mailboxes' : '—' })),
            ),
          )),
        ),
        el('div', { class: 'form-row' }, field('New domain', nameInput), field('Status', statusSelect), createBtn),
      ),
    );
  } catch (err) {
    mount(node, errorBox(err));
  }
  return node;
}

async function routesTab() {
  const node = el('div', { class: 'admin-tab' }, el('div', { class: 'loading', text: 'Loading routes…' }));
  try {
    const { domains } = await api.admin.domains();
    if (!domains?.length) {
      mount(node, card('Inbound routes', el('div', { class: 'empty', text: 'Add a domain first.' })));
      return node;
    }

    // Routes are always scoped to one domain, so the tab needs a picker.
    const picker = el('select', { class: 'domain-picker' },
      ...domains.map((d) => el('option', { value: d.id, text: d.name })));
    const body = el('div', { class: 'routes-body' });

    async function loadRoutes(domainId) {
      mount(body, el('div', { class: 'loading', text: 'Loading routes…' }));
      try {
        const data = await api.admin.routes(domainId);
        const { mailboxes } = await api.admin.mailboxes({ limit: 500 });
        const owned = mailboxes.filter((mb) => mb.domainId === domainId);
        const domain = domains.find((d) => d.id === domainId);

        const patternInput = el('input', { type: 'text', placeholder: 'support+*', required: true });
        const targetSelect = el('select', {},
          el('option', { value: '', text: '— catch-all —' }),
          ...owned.map((mb) => el('option', { value: mb.id, text: mb.email })));
        const actionSelect = el('select', {}, ...['deliver', 'reject', 'bounce', 'discard']
          .map((a) => el('option', { value: a, text: a })));
        const priorityInput = el('input', { type: 'number', value: '100', min: '0', max: '1000' });
        const createBtn = el('button', { class: 'btn btn-primary', text: 'Add route' });
        createBtn.addEventListener('click', async () => {
          if (!patternInput.value.trim()) {
            toast('Enter a local-part pattern.', 'error');
            return;
          }
          createBtn.disabled = true;
          const added = await confirmAction(`Route ${patternInput.value.trim()} on ${domain?.name}?`, () =>
            api.admin.createRoute(domainId, {
              pattern: patternInput.value.trim(),
              mailboxId: targetSelect.value || null,
              action: actionSelect.value,
              priority: Number(priorityInput.value) || 100,
            }), { done: () => loadRoutes(domainId) });
          createBtn.disabled = false;
          if (added) patternInput.value = '';
        });

        mount(
          body,
          card('Aliases and routing',
            el('table', { class: 'table' },
              el('thead', {}, el('tr', {},
                el('th', { text: 'Pattern' }), el('th', { text: 'Delivers to' }), el('th', { text: 'Action' }),
                el('th', { text: 'Priority' }), el('th', { text: 'Enabled' }), el('th', { text: '' }),
              )),
              el('tbody', {}, ...(data.routes || []).map((r) =>
                el('tr', {},
                  el('td', { text: r.pattern }),
                  el('td', { text: r.mailboxEmail || (r.action === 'deliver' ? 'catch-all' : '—') }),
                  el('td', { text: r.action }),
                  el('td', { text: String(r.priority) }),
                  el('td', {}, el('input', {
                    type: 'checkbox',
                    checked: r.isActive,
                    onChange: async (e) => {
                      try {
                        await api.admin.updateRoute(r.id, { isActive: e.target.checked });
                        toast('Route updated.', 'success');
                      } catch (err) {
                        toast(err.message, 'error');
                        e.target.checked = r.isActive;
                      }
                    },
                  })),
                  el('td', {}, isOwner()
                    ? el('button', { class: 'btn btn-sm', text: 'Delete', onClick: async () => {
                        await confirmAction(`Delete the route ${r.pattern}?`, () => api.admin.deleteRoute(r.id),
                          { done: () => loadRoutes(domainId) });
                      } })
                    : null),
                ),
              )),
            ),
            el('div', { class: 'form-row' },
              field('Local part', patternInput), field('Deliver to', targetSelect),
              field('Action', actionSelect), field('Priority', priorityInput), createBtn,
            ),
            el('p', { class: 'muted small', text: 'Patterns use the local part only, e.g. support, sales+* or *. Leave the target empty for a catch-all.' }),
          ),
        );
      } catch (err) {
        mount(body, errorBox(err));
      }
    }

    picker.addEventListener('change', () => loadRoutes(picker.value));
    mount(node, card('Domain', picker), body);
    await loadRoutes(picker.value);
  } catch (err) {
    mount(node, errorBox(err));
  }
  return node;
}

async function auditTab() {
  const node = el('div', { class: 'admin-tab' }, el('div', { class: 'loading', text: 'Loading audit log…' }));
  try {
    const actionFilter = el('input', { type: 'search', placeholder: 'e.g. admin.user.create' });
    const entityFilter = el('input', { type: 'search', placeholder: 'user, mailbox, domain…' });
    const body = el('div', { class: 'audit-body' });

    async function load() {
      mount(body, el('div', { class: 'loading', text: 'Loading…' }));
      try {
        const data = await api.admin.audit({ limit: 100, action: actionFilter.value.trim() || undefined, entityType: entityFilter.value.trim() || undefined });
        mount(body, el('table', { class: 'table' },
          el('thead', {}, el('tr', {},
            el('th', { text: 'When' }), el('th', { text: 'Actor' }), el('th', { text: 'Action' }),
            el('th', { text: 'Entity' }), el('th', { text: 'IP' }),
          )),
          el('tbody', {}, ...(data.logs || []).map((log) =>
            el('tr', {},
              el('td', { text: new Date(log.createdAt).toLocaleString() }),
              el('td', { text: log.actorEmail || 'system' }),
              el('td', {}, el('code', { text: log.action })),
              el('td', { text: log.entityId ? `${log.entityType} ${String(log.entityId).slice(0, 12)}` : log.entityType || '—' }),
              el('td', { text: log.ip || '—' }),
            ),
          )),
        ));
      } catch (err) {
        mount(body, errorBox(err));
      }
    }

    for (const input of [actionFilter, entityFilter]) {
      input.addEventListener('change', load);
    }
    mount(node, card('Audit log',
      el('div', { class: 'form-row' }, field('Action', actionFilter), field('Entity type', entityFilter)),
      body,
    ));
    await load();
  } catch (err) {
    mount(node, errorBox(err));
  }
  return node;
}

export async function renderAdmin(container) {
  const app = el('div', { class: 'admin' });
  const content = el('div', { class: 'admin-content' });

  const tabs = el('div', { class: 'admin-tabs' },
    ...[
      ['overview', 'Overview'],
      ['users', 'Users'],
      ['mailboxes', 'Mailboxes'],
      ['domains', 'Domains'],
      ['routes', 'Routes'],
      ['audit', 'Audit log'],
    ].map(([tab, label], index) =>
      el('button', {
        class: `admin-tab-btn${index === 0 ? ' active' : ''}`,
        'data-tab': tab,
        text: label,
        onClick: () => show(tab),
      }),
    ),
  );

  const TABS = {
    overview: overviewTab,
    users: usersTab,
    mailboxes: mailboxesTab,
    domains: domainsTab,
    routes: routesTab,
    audit: auditTab,
  };

  async function show(which) {
    const load = TABS[which] || overviewTab;
    for (const btn of tabs.children) {
      btn.classList.toggle('active', btn.dataset.tab === which);
    }
    // Clear first so a slow tab cannot land on top of a newer one.
    mount(content, el('div', { class: 'loading', text: 'Loading…' }));
    mount(content, await load());
  }

  app.append(el('h2', { text: 'Admin console' }), tabs, content);
  mount(container, app);
  await show('overview');
}