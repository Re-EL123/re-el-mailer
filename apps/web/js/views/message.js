/**
 * Reading pane: a single message plus its thread, with reply/forward shortcuts
 * and attachment downloads via short-lived signed URLs.
 */

import { api } from '../api.js';
import { displayName, el, fullDate, formatBytes, mount, skeletonCards, toast } from '../ui.js';
import { icon } from '../icons.js';
import { navigate, refresh } from '../router.js';
import { pushShortcuts } from '../keys.js';

function headerLine(label, value) {
  if (!value || (Array.isArray(value) && value.length === 0)) return null;
  const text = Array.isArray(value) ? value.map(displayName).join(', ') : displayName(value);
  return el('div', { class: 'hdr' }, el('span', { class: 'hdr-label', text: label }), el('span', { class: 'hdr-value', text }));
}

/**
 * Per-message label assignment.
 *
 * `set-labels` has always existed server-side, but nothing in the reader
 * reached it, so applying a label meant editing the database. The full label
 * list is fetched the first time the control is opened rather than on every
 * message load, so opening mail stays cheap.
 */
function labelControl(msg, mailboxId) {
  const applied = new Set((msg.labels || []).map((label) => label.id));
  const menu = el('div', { class: 'label-menu' }, el('span', { class: 'muted small', text: 'Loading labels…' }));
  const details = el('details', { class: 'label-picker' },
    el('summary', { class: 'icon-btn', title: 'Labels', 'aria-label': 'Labels' }, icon('tag')),
    el('div', { class: 'label-applied' },
      (msg.labels || []).length
        ? msg.labels.map((label) => el('span', { class: 'pill', style: { borderLeft: `3px solid ${label.color || '#21396A'}` }, text: label.name }))
        : el('span', { class: 'muted small', text: 'No labels' }),
    ),
    menu,
  );

  let loaded = false;
  details.addEventListener('toggle', async () => {
    if (!details.open || loaded) return;
    loaded = true;
    let labels = [];
    try {
      labels = (await api.mail.labels(mailboxId)).labels || [];
    } catch (err) {
      mount(menu, el('span', { class: 'muted small', text: err.message }));
      return;
    }
    if (!labels.length) {
      mount(menu, el('span', { class: 'muted small', text: 'Create labels in Settings first.' }));
      return;
    }
    mount(menu, ...labels.map((label) => {
      const box = el('input', { type: 'checkbox', checked: applied.has(label.id) });
      box.addEventListener('change', async () => {
        const next = new Set(applied);
        if (box.checked) next.add(label.id); else next.delete(label.id);
        box.disabled = true;
        try {
          await api.mail.setLabels([msg.id], [...next], mailboxId);
          applied.clear();
          for (const id of next) applied.add(id);
        } catch (err) {
          toast(err.message, 'error');
          box.checked = !box.checked;
        } finally {
          box.disabled = false;
        }
      });
      return el('label', { class: 'label-option' },
        box,
        el('span', { class: 'label-dot', style: { background: label.color || '#21396A' } }),
        el('span', { text: label.name }),
      );
    }));
  });

  return details;
}

export async function renderMessage(container, ctx) {
  const id = ctx.params[0];
  const mailboxId = ctx.query.mailbox;

  const body = el('div', { class: 'reader-body' }, skeletonCards({ count: 1, lines: 6 }));
  const head = el('div', { class: 'reader-head' });

  async function openAttachment(att, inline = false) {
    try {
      const data = await api.mail.attachmentUrl(att.id, id, inline, mailboxId);
      if (inline && /^image\//.test(att.mimeType || '')) {
        el('img', { class: 'attach-img', src: data.url, alt: att.filename });
        body.append(el('a', { href: data.url, target: '_blank', rel: 'noopener', text: att.filename }));
      } else {
        window.open(data.url, '_blank', 'noopener');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // Declared outside the try because the shortcut handlers below are registered
  // after it and close over the message; a `const` inside the block would not be
  // in scope there.
  let msg = null;

  async function load() {
    try {
      const data = await api.mail.get(id, mailboxId);
      msg = data.message;

      mount(
        head,
        el(
          'div',
          { class: 'reader-toolbar' },
          el('button', { class: 'icon-btn', title: 'Back', 'aria-label': 'Back to list', onClick: () => history.back() }, icon('back')),
          // aria-pressed carries the starred state: the icon alone distinguishes
          // the two only by fill, which a screen reader cannot perceive.
          el('button', { class: 'icon-btn', title: msg.isStarred ? 'Unstar' : 'Star', 'aria-label': msg.isStarred ? 'Remove star' : 'Star this message', 'aria-pressed': String(Boolean(msg.isStarred)), onClick: async () => {
            await api.mail.star([msg.id], !msg.isStarred, mailboxId); refresh();
          } }, icon(msg.isStarred ? 'starFilled' : 'star')),
          el('button', { class: 'icon-btn', title: 'Trash', 'aria-label': 'Move to trash', onClick: async () => {
            await api.mail.trash([msg.id], mailboxId); navigate('inbox');
          } }, icon('trash')),
          el('button', { class: 'icon-btn', title: 'Reply', 'aria-label': 'Reply', onClick: () => navigate(`compose?reply=${msg.id}&mailbox=${mailboxId}`) }, icon('reply')),
          el('button', { class: 'icon-btn', title: 'Forward', 'aria-label': 'Forward', onClick: () => navigate(`compose?forward=${msg.id}&mailbox=${mailboxId}`) }, icon('forward')),
          labelControl(msg, mailboxId),
        ),
        el('h2', { class: 'reader-subject', text: msg.subject || '(no subject)' }),
        el('div', { class: 'reader-meta' },
          headerLine('From', msg.from),
          headerLine('To', msg.to),
          msg.cc?.length ? headerLine('Cc', msg.cc) : null,
          el('div', { class: 'hdr' }, el('span', { class: 'hdr-label', text: 'Date' }), el('span', { class: 'hdr-value', text: fullDate(msg.receivedAt || msg.sentAt) })),
        ),
      );

      // Drop the loading placeholder before anything is appended, otherwise it
      // stays on screen above the message for the life of the view.
      mount(body);

      // Render body: sanitised HTML in a sandboxed frame, else plain text.
      if (msg.bodyHtml) {
        // Message bodies are sender-controlled, so they are never mounted as
        // live DOM. The server sanitises on ingest and send; this iframe adds the
        // browser-enforced backstop, with a restrictive sandbox that still allows
        // styling and images but not scripts, forms or same-origin access.
        const frame = el('iframe', {
          class: 'reader-frame',
          title: 'Message body',
          sandbox: 'allow-popups allow-popups-to-escape-sandbox',
          referrerpolicy: 'no-referrer',
          loading: 'lazy',
        });
        frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8">
<base target="_blank"><meta name="referrer" content="no-referrer">
<style>
  html,body{margin:0;padding:0;background:transparent;color:#1b2437;overflow-wrap:anywhere}
  body{font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:4px 2px}
  img{max-width:100%;height:auto}
  table{max-width:100%}
  a{color:#21396A}
  blockquote{margin:0;padding-left:12px;border-left:3px solid #d7deec;color:#4a5468}
  @media (prefers-color-scheme:dark){body{color:#e6ebf5}a{color:#8fb0ff}}
</style></head><body>${msg.bodyHtml}</body></html>`;
        body.append(el('div', { class: 'reader-html' }, frame));
      } else if (msg.bodyText) {
        body.append(el('pre', { class: 'reader-text', text: msg.bodyText }));
      } else {
        body.append(el('p', { class: 'muted', text: 'This message has no body.' }));
      }

      if (msg.attachments?.length) {
        body.append(
          el('div', { class: 'attachments' },
            el('h3', { text: `Attachments (${msg.attachments.length})` }),
            ...msg.attachments.map((att) =>
              el('button', { class: 'attach-chip', title: att.filename, onClick: () => openAttachment(att) },
                icon('paperclip'), el('span', { text: att.filename }),
                el('span', { class: 'muted small', text: formatBytes(att.sizeBytes) }),
              ),
            ),
          ),
        );
      }

      if (data.thread?.length > 1) {
        body.append(
          el('div', { class: 'thread' },
            el('h3', { class: 'thread-title', text: `Thread (${data.thread.length})` }),
            ...data.thread.map((t) =>
              el('button', { class: `thread-item${t.id === msg.id ? ' current' : ''}`, onClick: () => navigate(`message/${t.id}?mailbox=${mailboxId}`) },
                el('span', { class: 'thread-from', text: displayName(t.from) }),
                el('span', { class: 'thread-date', text: fullDate(t.receivedAt || t.sentAt) }),
                el('span', { class: 'thread-snip', text: t.snippet || '' }),
              ),
            ),
          ),
        );
      }
    } catch (err) {
      mount(body, el('div', { class: 'empty', text: err.message }));
      popShortcuts();
      return;
    }

    // Registered only once the message has loaded, because every binding needs
    // its id. Pushed after the toolbar so it sits above the global scope.
    popShortcuts = pushShortcuts('message', {
      r: () => navigate(`compose?reply=${msg.id}&mailbox=${mailboxId}`),
      a: () => navigate(`compose?reply=${msg.id}&mode=all&mailbox=${mailboxId}`),
      f: () => navigate(`compose?forward=${msg.id}&mailbox=${mailboxId}`),
      s: async () => {
        await api.mail.star([msg.id], !msg.isStarred, mailboxId);
        refresh();
      },
      hash: async () => {
        await api.mail.trash([msg.id], mailboxId);
        navigate('inbox');
      },
      u: () => history.back(),
    });
  }

  let popShortcuts = () => {};
  mount(container, el('div', { class: 'reader' }, head, body));
  await load();

  return () => popShortcuts();
}