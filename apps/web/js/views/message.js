/**
 * Reading pane: a single message plus its thread, with reply/forward shortcuts
 * and attachment downloads via short-lived signed URLs.
 */

import { api } from '../api.js';
import { displayName, el, fullDate, formatBytes, mount, toast } from '../ui.js';
import { navigate, refresh } from '../router.js';

function headerLine(label, value) {
  if (!value || (Array.isArray(value) && value.length === 0)) return null;
  const text = Array.isArray(value) ? value.map(displayName).join(', ') : displayName(value);
  return el('div', { class: 'hdr' }, el('span', { class: 'hdr-label', text: label }), el('span', { class: 'hdr-value', text }));
}

export async function renderMessage(container, ctx) {
  const id = ctx.params[0];
  const mailboxId = ctx.query.mailbox;

  const body = el('div', { class: 'reader-body' }, el('div', { class: 'loading', text: 'Loading message…' }));
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

  async function load() {
    try {
      const data = await api.mail.get(id, mailboxId);
      const msg = data.message;

      mount(
        head,
        el(
          'div',
          { class: 'reader-toolbar' },
          el('button', { class: 'icon-btn', text: '←', title: 'Back', onClick: () => history.back() }),
          el('button', { class: 'icon-btn', text: msg.isStarred ? '★' : '☆', title: 'Star', onClick: async () => {
            await api.mail.star([msg.id], !msg.isStarred, mailboxId); refresh();
          } }),
          el('button', { class: 'icon-btn', text: '🗑', title: 'Trash', onClick: async () => {
            await api.mail.trash([msg.id], mailboxId); navigate('inbox');
          } }),
          el('button', { class: 'icon-btn', text: '↩', title: 'Reply', onClick: () => navigate(`compose?reply=${msg.id}&mailbox=${mailboxId}`) }),
          el('button', { class: 'icon-btn', text: '→', title: 'Forward', onClick: () => navigate(`compose?forward=${msg.id}&mailbox=${mailboxId}`) }),
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
            el('h4', { text: `Attachments (${msg.attachments.length})` }),
            ...msg.attachments.map((att) =>
              el('button', { class: 'attach-chip', title: att.filename, onClick: () => openAttachment(att) },
                el('span', { text: '📎' }), el('span', { text: att.filename }),
                el('span', { class: 'muted small', text: formatBytes(att.sizeBytes) }),
              ),
            ),
          ),
        );
      }

      if (data.thread?.length > 1) {
        body.append(
          el('div', { class: 'thread' },
            el('h4', { text: `Thread (${data.thread.length})` }),
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
    }
  }

  mount(container, el('div', { class: 'reader' }, head, body));
  await load();
}