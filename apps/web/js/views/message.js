/**
 * Reading pane: a single message plus its thread, with reply/forward shortcuts
 * and attachment downloads via short-lived signed URLs.
 */

import { api } from '../api.js';
import { mountMessageFrame } from '../body-frame.js';
import { displayName, el, formatBytes, fullAddress, fullDate, mount, skeletonCards, toast } from '../ui.js';
import { icon } from '../icons.js';
import { navigate, refresh } from '../router.js';
import { pushShortcuts } from '../keys.js';

function headerLine(label, value) {
  if (!value || (Array.isArray(value) && value.length === 0)) return null;
  // fullAddress, not displayName: a header is where the address is verified.
  // The name alone is what a spoofed From line makes unreassuring.
  const text = Array.isArray(value) ? value.map(fullAddress).join(', ') : fullAddress(value);
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
  // in scope there. `bodyFrame` likewise, so the router's cleanup can tear it
  // down whichever path the load took.
  let msg = null;
  let bodyFrame = null;

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
          // A draft opens read-only: this is the way to pick it back up. The
          // composer reloads the message by id, so nothing beyond the id is
          // passed and the stored body, recipients and attachments all return.
          msg.isDraft ? el('button', { class: 'icon-btn', title: 'Edit', 'aria-label': 'Edit draft', onClick: () => navigate(`compose?draft=${msg.id}&mailbox=${mailboxId}`) }, icon('pencil')) : null,
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
          // Re-fetches just this message. Worth its own control because the
          // reader is the one place where staleness is invisible: a reply that
          // arrived, a flag changed on another device, or a thread that grew all
          // show as the state you left them in until something navigates.
          el('button', { class: 'icon-btn', title: 'Refresh', 'aria-label': 'Refresh this message', onClick: () => refresh() }, icon('refresh')),
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
        // `mountMessageFrame` owns the sandbox tokens, the theme and the
        // sizing; the reader just places it. The comment that used to live
        // here — claiming the frame sizes itself from its content — was the
        // bug: without allow-same-origin this page cannot read into it, so
        // nothing could size it, and every body sat in a 150px strip.
        bodyFrame = mountMessageFrame(msg.bodyHtml, body);
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

  return () => {
    popShortcuts();
    bodyFrame?.destroy();
  };
}