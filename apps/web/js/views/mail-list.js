/**
 * The mail list: folder navigation, message list, search and bulk selection.
 * One view covers `inbox`, every other folder, `starred`, labels and search so
 * they share selection/refresh behaviour.
 */

import { api } from '../api.js';
import { clear, debounce, displayName, el, initials, mount, relTime, toast } from '../ui.js';
import { activeMailbox, saveMailbox, setState, state } from '../store.js';
import { navigate, refresh } from '../router.js';

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
      onClick: (event) => {
        // Clicking the star or checkbox shouldn't open the message.
        if (event.target.closest('.msg-star, .msg-check')) return;
        navigate(`message/${msg.id}?mailbox=${mailboxId}`);
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
      msg.hasAttachments ? el('span', { class: 'tag', text: '📎', title: 'Has attachments' }) : null,
      msg.deliveryStatus && msg.deliveryStatus !== 'delivered' && msg.deliveryStatus !== 'sent'
        ? el('span', { class: 'tag', text: msg.deliveryStatus })
        : null,
    ),
    el('button', {
      class: `msg-star${msg.isStarred ? ' on' : ''}`,
      title: msg.isStarred ? 'Unstar' : 'Star',
      'aria-label': msg.isStarred ? 'Unstar' : 'Star',
      text: msg.isStarred ? '★' : '☆',
      onClick: async (event) => {
        event.stopPropagation();
        try {
          await api.mail.star([msg.id], !msg.isStarred, mailboxId);
          refresh();
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    }),
  );
  return row;
}

function sidebar(container, { folder, labelId, query, onNavigate }) {
  const counts = state.counts?.folders || {};
  const inboxUnread = state.counts?.inboxUnread || 0;

  const nav = el(
    'nav',
    { class: 'side-nav' },
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

  return el('aside', { class: 'sidebar' }, nav, labelLinks);
}

export async function renderMailList(container, ctx) {
  const folderParam = ctx.params[0] || 'inbox';
  const folder = folderParam === 'starred' ? 'starred' : folderParam;
  const labelId = ctx.query.label || null;
  const mailboxId = ctx.query.mailbox || state.activeMailboxId;

  if (state.mailboxes.length > 1) saveMailbox(mailboxId);

  const selected = new Set();
  const listNode = el('div', { class: 'msg-list', role: 'list' });
  const headerNode = el('div', { class: 'list-header' });
  const actionsNode = el('div', { class: 'list-actions', hidden: true });

  const title =
    folderParam === 'starred'
      ? 'Starred'
      : labelId
        ? (state.labels || []).find((l) => l.id === labelId)?.name || 'Label'
        : FOLDERS.find(([f]) => f === folder)?.[1] || 'Mail';

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

  let messages = [];
  function renderRows() {
    if (messages.length === 0) {
      mount(listNode, el('div', { class: 'empty', text: `No messages in ${title}.` }));
      return;
    }
    mount(listNode, ...messages.map((msg) => messageRow(msg, { selected: selected.has(msg.id), onSelect, mailboxId })));
  }

  async function load() {
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
}