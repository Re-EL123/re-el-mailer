/**
 * The mail list: folder navigation, message list, search and bulk selection.
 * One view covers `inbox`, every other folder, `starred`, labels and search so
 * they share selection/refresh behaviour.
 */

import { api } from '../api.js';
import { clear, debounce, displayName, el, initials, mount, relTime, skeletonList, toast } from '../ui.js';
import { icon } from '../icons.js';
import { activeMailbox, saveMailbox, setState, state } from '../store.js';
import { navigate, refresh } from '../router.js';
import { pushShortcuts } from '../keys.js';

const FOLDERS = [
  ['inbox', 'Inbox'],
  ['starred', 'Starred'],
  ['drafts', 'Drafts'],
  ['sent', 'Sent'],
  ['archive', 'Archive'],
  ['spam', 'Spam'],
  ['trash', 'Trash'],
];

function messageRow(msg, { selected, onSelect, mailboxId }) {
  const row = el(
    'div',
    {
      class: `msg-row${msg.isRead ? '' : ' unread'}${selected ? ' selected' : ''}`,
      dataset: { id: msg.id },
      // role=list on the container requires listitem children, otherwise a
      // screen reader announces a list with no items and cannot count them.
      role: 'listitem',
      // The whole row is clickable, so it must be reachable by keyboard too.
      // A div carries no implicit role or focus, hence tabindex + the key
      // handler below; using a real <a> instead would fight the row's
      // interactive children (star, checkbox).
      tabindex: '0',
      'aria-label': `${msg.isRead ? '' : 'Unread. '}${displayName(msg.from)}. ${msg.subject || '(no subject)'}`,
      onClick: (event) => {
        // Clicking the star or checkbox shouldn't open the message.
        if (event.target.closest('.msg-star, .msg-check')) return;
        navigate(`message/${msg.id}?mailbox=${mailboxId}`);
      },
      onKeydown: (event) => {
        // Enter and Space activate a row; ArrowDown/ArrowUp move between rows so
        // the list can be walked without tabbing through every control inside it.
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          navigate(`message/${msg.id}?mailbox=${mailboxId}`);
          return;
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;

        event.preventDefault();
        const rows = [...event.currentTarget.closest('[role="list"]').querySelectorAll('.msg-row')];
        const next = rows[rows.indexOf(event.currentTarget) + (event.key === 'ArrowDown' ? 1 : -1)];
        next?.focus();
      },
    },
    el('input', {
      type: 'checkbox',
      class: 'msg-check',
      checked: selected,
      'aria-label': 'Select message',
      onChange: (event) => onSelect(msg.id, event.target.checked),
    }),
    el('div', { class: 'msg-avatar', text: initials(msg.direction === 'outbound' ? msg.to?.[0] : msg.from) }),
    el(
      'div',
      { class: 'msg-main' },
      el(
        'div',
        { class: 'msg-line' },
        el('span', { class: 'msg-from', text: displayName(msg.direction === 'outbound' ? { name: 'To', email: msg.to?.join(', ') } : msg.from) }),
        el('span', { class: 'msg-date', text: relTime(msg.sentAt || msg.receivedAt || msg.createdAt) }),
      ),
      el('div', { class: 'msg-subject', text: msg.subject || '(no subject)' }),
      el('div', { class: 'msg-snippet', text: msg.snippet || '' }),
    ),
    el('div', { class: 'msg-tags' },
      msg.hasAttachments ? el('span', { class: 'tag', title: 'Has attachments' }, icon('paperclip', { size: 14 })) : null,
      msg.deliveryStatus && msg.deliveryStatus !== 'delivered' && msg.deliveryStatus !== 'sent'
        ? el('span', { class: 'tag', text: msg.deliveryStatus })
        : null,
    ),
    el('button', {
      class: `msg-star${msg.isStarred ? ' on' : ''}`,
      title: msg.isStarred ? 'Unstar' : 'Star',
      'aria-label': msg.isStarred ? 'Unstar message' : 'Star message',
      'aria-pressed': String(Boolean(msg.isStarred)),
      onClick: async (event) => {
        event.stopPropagation();
        try {
          await api.mail.star([msg.id], !msg.isStarred, mailboxId);
          refresh();
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    }, icon(msg.isStarred ? 'starFilled' : 'star', { size: 15 })),
  );
  return row;
}

function sidebar(container, { folder, labelId, query, onNavigate }) {
  const counts = state.counts?.folders || {};
  const inboxUnread = state.counts?.inboxUnread || 0;

  const nav = el(
    'nav',
    // Named so a screen-reader user can jump straight to it rather than reading
    // the folder list as if it were part of the mail.
    { class: 'side-nav', 'aria-label': 'Mailboxes' },
    el('button', { class: 'side-compose', text: 'Compose', onClick: () => navigate('compose') }),
    el(
      'ul',
      { class: 'side-list' },
      ...FOLDERS.map(([key, label]) =>
        el(
          'li',
          {},
          el(
            'a',
            {
              href: `#/${key === 'starred' ? 'starred' : key}`,
              class: `side-link${folder === key ? ' active' : ''}`,
            },
            el('span', { text: label }),
            key === 'inbox' && inboxUnread
              ? el('span', { class: 'pill', text: String(inboxUnread) })
              : null,
            key !== 'inbox' && counts[key]
              ? el('span', { class: 'pill pill-quiet', text: String(counts[key]) })
              : null,
          ),
        ),
      ),
    ),
  );

  const labelLinks = el(
    'div',
    { class: 'side-labels' },
    el('h4', { text: 'Labels' }),
    el('ul', { class: 'side-list' },
      ...(state.labels || []).map((label) =>
        el(
          'li',
          {},
          el(
            'a',
            {
              href: `#/label/${label.id}`,
              class: `side-link${labelId === label.id ? ' active' : ''}`,
            },
            el('span', { class: 'label-dot', style: { background: label.color || '#21396A' } }),
            el('span', { text: label.name }),
          ),
        ),
      ),
      (state.labels || []).length === 0 ? el('li', { class: 'muted small', text: 'No labels yet' }) : null,
    ),
  );

  return el('aside', { class: 'sidebar', 'aria-label': 'Mailboxes and labels' }, nav, labelLinks);
}

export async function renderMailList(container, ctx) {
  const folderParam = ctx.params[0] || 'inbox';
  const folder = folderParam === 'starred' ? 'starred' : folderParam;
  const labelId = ctx.query.label || null;
  const mailboxId = ctx.query.mailbox || state.activeMailboxId;

  if (state.mailboxes.length > 1) saveMailbox(mailboxId);

  const selected = new Set();
  const headerNode = el('div', { class: 'list-header' });
  const actionsNode = el('div', { class: 'list-actions', hidden: true });

  const title =
    folderParam === 'starred'
      ? 'Starred'
      : labelId
        ? (state.labels || []).find((l) => l.id === labelId)?.name || 'Label'
        : FOLDERS.find(([f]) => f === folder)?.[1] || 'Mail';

  // Named after the folder/label so a screen reader user arriving here by
  // keyboard hears which list they are in, not just "list".
  const listNode = el('div', { class: 'msg-list', role: 'list', 'aria-label': `${title} messages` });

  const searchInput = el('input', {
    type: 'search',
    class: 'search',
    placeholder: `Search in ${title}…`,
    value: ctx.query.q || '',
    'aria-label': 'Search mail',
  });

  function onSearch(value) {
    navigate(`search?q=${encodeURIComponent(value)}${mailboxId ? `&mailbox=${mailboxId}` : ''}`);
  }
  searchInput.addEventListener('input', debounce((event) => onSearch(event.target.value.trim()), 350));
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') onSearch(event.target.value.trim());
  });

  mount(
    headerNode,
    el('div', { class: 'list-title-row' },
      el('h2', { class: 'list-title', text: title }),
      searchInput,
    ),
  );

  function onSelect(id, isSelected) {
    if (isSelected) selected.add(id);
    else selected.delete(id);
    updateActions();
    renderRows();
  }

  function updateActions() {
    const has = selected.size > 0;
    actionsNode.hidden = !has;
    if (has) actionsNode.textContent = `${selected.size} selected`;
  }

  function bulkButton(label, handler, danger = false) {
    return el('button', {
      class: danger ? 'btn btn-danger btn-sm' : 'btn btn-sm',
      text: label,
      onClick: async () => {
        try {
          await handler();
          selected.clear();
          updateActions();
          refresh();
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    });
  }

  mount(
    actionsNode,
    bulkButton('Star', () => api.mail.star([...selected], true, mailboxId)),
    bulkButton('Archive', () => api.mail.move([...selected], 'archive', mailboxId)),
    bulkButton('Trash', () => api.mail.trash([...selected], mailboxId)),
    folder === 'trash' || folder === 'spam'
      ? bulkButton('Delete forever', () => api.mail.deleteForever([...selected], mailboxId), true)
      : null,
    el('button', { class: 'btn btn-sm', text: 'Clear', onClick: () => { selected.clear(); updateActions(); renderRows(); } }),
  );

  /**
   * Keyboard shortcuts for this view.
   *
   * Row movement uses the roving pattern the rows already implement: focus a row,
   * then act on it. Each action resolves its target the same way the user would
   * — the focused row, or the selection if there is one — so a shortcut and the
   * equivalent click cannot disagree.
   */
  function focusedRow() {
    const active = document.activeElement;
    return active?.classList?.contains('msg-row') ? active : null;
  }

  /** Act on the selection when there is one, otherwise on the focused row. */
  async function actOnTargets(run) {
    const ids = selected.size ? [...selected] : focusedRow()?.dataset.id ? [focusedRow().dataset.id] : [];
    if (!ids.length) return;
    try {
      await run(ids);
      selected.clear();
      updateActions();
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function moveFocus(offset) {
    const rows = [...listNode.querySelectorAll('.msg-row')];
    if (!rows.length) return;
    const current = rows.indexOf(focusedRow());
    const next = rows[current + offset] || rows[0];
    next.focus();
  }

  const popShortcuts = pushShortcuts('mail-list', {
    // j/k move focus; the list itself also handles the arrow keys on a row.
    j: () => moveFocus(1),
    k: () => moveFocus(-1),
    down: () => moveFocus(1),
    up: () => moveFocus(-1),
    '/': () => searchInput.focus(),
    x: () => {
      const row = focusedRow();
      if (!row) return;
      const box = row.querySelector('.msg-check');
      if (!box) return;
      box.checked = !box.checked;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    },
    s: () => actOnTargets((ids) => api.mail.star(ids, true, mailboxId)),
    e: () => actOnTargets((ids) => api.mail.move(ids, 'archive', mailboxId)),
    hash: () => actOnTargets((ids) => api.mail.trash(ids, mailboxId)),
    // `u` unreads on a folder list but is "go back" in a reading pane; the reader
    // registers its own binding, which takes priority over this one.
    u: () => actOnTargets((ids) => api.mail.markRead(ids, false, mailboxId)),
  });

  let messages = [];
  function renderRows() {
    if (messages.length === 0) {
      mount(listNode, el('div', { class: 'empty', text: `No messages in ${title}.` }));
      return;
    }
    mount(listNode, ...messages.map((msg) => messageRow(msg, { selected: selected.has(msg.id), onSelect, mailboxId })));
  }

  /**
   * Placeholder rows while the list loads.
   *
   * These match the real row's dimensions, so the sidebar and header are already
   * in place and nothing shifts when data arrives. The count tracks state.pageSize
   * so a page that ends up full does not visibly extend at the end.
   */
  function showSkeletons() {
    const host = el('div', {
      class: 'msg-list',
      role: 'list',
      'aria-label': `${title} messages`,
      // One announcement for the whole list, not one per placeholder row.
      'aria-busy': 'true',
    });
    const skeleton = skeletonList({ rows: Math.min(state.pageSize || 30, 8) });
    for (const row of skeleton.children) host.append(row);
    mount(listNode, host);
  }

  async function load() {
    showSkeletons();
    try {
      let data;
      if (ctx.query.q) {
        data = await api.mail.search(ctx.query.q, { mailboxId, limit: state.pageSize });
        messages = data.messages || [];
      } else if (labelId) {
        data = await api.mail.messagesByLabel(labelId, { mailboxId, limit: state.pageSize });
        messages = data.messages || [];
      } else {
        data = await api.mail.list({ folder, mailboxId, limit: state.pageSize });
        messages = data.messages || [];
        setState({ counts: { folders: data.counts, inboxUnread: data.inboxUnread, starred: data.starred } });
      }
      renderRows();
      renderSidebar();
    } catch (err) {
      mount(listNode, el('div', { class: 'empty', text: err.message }));
    }
  }

  const sidebarNode = el('div');
  function renderSidebar() {
    mount(sidebarNode, sidebar(container, { folder, labelId, query: ctx.query }));
  }

  // Labels come from the API once per visit.
  try {
    const labels = await api.mail.labels(mailboxId);
    setState({ labels: labels.labels || [] });
  } catch {
    setState({ labels: [] });
  }

  mount(container, el('div', { class: 'mail-layout' }, sidebarNode, el('div', { class: 'mail-main' }, headerNode, actionsNode, listNode)));
  renderSidebar();
  await load();

  // The router runs the returned function before the next render, so these
  // bindings cannot outlive the view they act on.
  return () => {
    popShortcuts();
  };
}