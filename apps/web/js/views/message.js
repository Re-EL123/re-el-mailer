/**
 * Reading pane: a single message plus its thread, with reply/forward shortcuts
 * and attachment downloads via short-lived signed URLs.
 */

import { api } from '../api.js';
import { matchCid, mountMessageFrame, resolveInlineImages } from '../body-frame.js';
import { displayName, el, formatBytes, fullAddress, fullDate, mount, skeletonCards, toast } from '../ui.js';
import { icon } from '../icons.js';
import { navigate, refresh } from '../router.js';
import { pushShortcuts } from '../keys.js';

/**
 * Length of the "real" text in a sanitised body, ignoring whitespace.
 *
 * Damage detection: a body whose text was stripped at ingest still holds its
 * full element structure (a styled table with empty cells), so an empty text
 * length is the only way to tell it from a normal body.
 */
function visibleTextLength(html) {
  if (!html) return 0;
  // bodyHtml is already sanitised, and a <template>'s content is inert, so
  // this never runs handlers or scripts in the reader's document.
  const host = document.createElement('template');
  host.innerHTML = html;
  return (host.content.textContent || '').replace(/\s/g, '').length;
}

/**
 * Turn the raw string of a plain-text body into safe reader nodes:
 *
 * - http(s) / www / email addresses become real links (mailto: for the last).
 * - An exporter's link suitcase — `display<http://…>`, `name<mailto:…>` — comes
 *   out as one clean link using the explicit href, not the literal text.
 * - Footnote links — `Go to My Account [1]` with `[1] https://…` at the foot —
 *   become one link on the label, and the reference list is folded away.
 * - `[cid:token]` inline-image references become placeholders the reader
 *   hydrates into the attachment image once a signed URL is available.
 * - `**bold**` / `*italic*` are honoured, so emphasis is not shown as asterisks.
 *
 * Everything emitted is built with `el`, so user content is text, never markup.
 */
const LINK_SOURCE = [
  '([^\\s<]+)\\s*<(https?://[^>\\s]+|mailto:[^>\\s]+|tel:[^>\\s]+|ftp://[^>\\s]+)>', // 1,2: display<href> suitcase
  '\\[cid:([^\\]]+)\\]',      // 3: inline image token
  '\\*\\*([^*]+)\\*\\*',      // 4: **bold**
  '\\*([^*\\n]+)\\*',         // 5: *italic*
  '\\[(\\d+)\\]',             // 6: footnote marker
  '<(https?://[^>\\s]+|mailto:[^>\\s]+)>', // 7: <url> with nothing around it
  '(https?://[^\\s<>"\')]+)', // 8: bare url
  '(www\\.[^\\s<>"\')]+)',    // 9: bare www
  '([a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,})', // 10: bare email
];
const LINK_RE = new RegExp(LINK_SOURCE.join('|'), 'gi');

/** Keep a balanced closing bracket; drop punctuation glued onto a URL. */
function trimUrl(url) {
  let end = url.length;
  while (end > 0 && /[.,;:!?]/.test(url[end - 1])) end -= 1;
  while (end > 0 && /["')\]}»]/.test(url[end - 1])) {
    const open = { ')': '(', ']': '[', '}': '{', '»': '«', '"': '"', "'": "'" }[url[end - 1]];
    if (url.slice(0, end).lastIndexOf(open) !== -1) break;
    end -= 1;
  }
  return url.slice(0, end);
}

const link = (text, href) => el('a', { class: 'autolink', href, target: '_blank', rel: 'noopener', text });

/** Does `text` already hold something the linkifier links on its own? */
function hasInlineLink(text) {
  return /(https?:\/\/|www\.|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i.test(text);
}

/** Is the reference URL an image the reader should show rather than link? */
function looksLikeImage(url) {
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif)([?#].*)?$/i.test(url);
}

/**
 * Recover the intended target from a footnote definition.
 *
 * Some mailers (Odoo among them) emit the *format string* instead of the value:
 * `…/web/'mailto:%s' % info@x.co.za` or `…/web/'%s' % http://x`. Recover the
 * value, then accept it only if it is a scheme the reader is willing to link.
 *
 * @returns {string | null}
 */
function cleanReferenceUrl(value) {
  let url = String(value || '').trim().replace(/^<+|>+$/g, '').trim();
  const mailto = /'mailto:%s'\s*%\s*(\S+)\s*$/.exec(url);
  const subst = mailto ? null : /'%s'\s*%\s*(\S+)\s*$/.exec(url);
  if (mailto) url = `mailto:${mailto[1]}`;
  else if (subst) url = subst[1];
  url = url.replace(/[)>.,;:]+$/, '');
  return /^(https?:|mailto:|tel:)/i.test(url) ? url : null;
}

/**
 * Pull a plain-text body's footnote block out of the flow.
 *
 * A definition is a `[n] <url>` line; a reference is only "real" when the body
 * actually uses `[n]` somewhere else, so a plain list of numbered URLs is never
 * mistaken for footnotes and hidden. Markers left alone on their own line are
 * attached to the line above them, which is where the label is.
 *
 * @returns {{lines: string[], refs: Map<number, string>}}
 */
function resolveReferences(text) {
  const raw = String(text ?? '').split(/\r?\n/).map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const defs = new Map();
  for (const line of raw) {
    const def = /^\s*\[(\d+)\]\s+(\S.*?)\s*$/.exec(line);
    if (!def) continue;
    const url = cleanReferenceUrl(def[2]);
    if (url) defs.set(Number(def[1]), url);
  }
  if (!defs.size) return { lines: raw, refs: new Map() };

  const used = new Set();
  for (const line of raw) {
    const def = /^\s*\[(\d+)\]\s+/.exec(line);
    const scan = def ? line.slice(def[0].length) : line;
    for (const marker of scan.matchAll(/\[(\d+)\]/g)) {
      if (defs.has(Number(marker[1]))) used.add(Number(marker[1]));
    }
  }
  if (!used.size) return { lines: raw, refs: new Map() };

  const refs = new Map();
  for (const n of used) refs.set(n, defs.get(n));

  const kept = raw.filter((line) => {
    const def = /^\s*\[(\d+)\]\s+(\S.*?)\s*$/.exec(line);
    return !(def && refs.has(Number(def[1])));
  });

  const lines = [];
  for (const line of kept) {
    const marker = /^\s*\[(\d+)\]\s*$/.exec(line);
    if (marker && refs.has(Number(marker[1])) && lines.length && lines[lines.length - 1].trim()) {
      lines[lines.length - 1] = `${lines[lines.length - 1]} [${marker[1]}]`;
      continue;
    }
    lines.push(line);
  }
  return { lines, refs };
}

function linkify(text, refs, attachments) {
  const nodes = [];
  let last = 0;
  for (const match of text.matchAll(LINK_RE)) {
    const full = match[0];
    const [, display, suiteHref, cidToken, boldText, italicText, marker, angleHref, bareUrl, www, email] = match;
    if (match.index > last) nodes.push(document.createTextNode(text.slice(last, match.index)));

    if (suiteHref) {
      nodes.push(link(display, suiteHref));
    } else if (angleHref) {
      nodes.push(link(angleHref, angleHref));
    } else if (cidToken) {
      const att = attachments && matchCid(cidToken, attachments);
      const isImage = att && /^image\//.test(att.mimeType || '');
      if (isImage) {
        const span = el('span', { class: 'reader-cid', 'data-cid': cidToken, title: att.filename });
        span.append(document.createTextNode(full));
        nodes.push(span);
      } else {
        nodes.push(document.createTextNode(full));
      }
    } else if (boldText !== undefined) {
      nodes.push(el('strong', {}, ...linkify(boldText, refs, attachments)));
    } else if (italicText !== undefined) {
      nodes.push(el('em', {}, ...linkify(italicText, refs, attachments)));
    } else if (marker !== undefined) {
      const href = refs?.get(Number(marker));
      nodes.push(href ? link(`[${marker}]`, href) : document.createTextNode(full));
    } else {
      const raw = bareUrl || www || email;
      const clean = trimUrl(raw) || raw;
      // www and email need a scheme only the linkifier can supply; a bare URL
      // is already self-addressing. Such hrefs are derived from text that the
      // regex above pinned to http(s)/mailto, so nothing else can slip through.
      const href = bareUrl ? clean : (www ? `https://${clean}` : `mailto:${clean}`);
      nodes.push(link(clean, href));
    }
    last = match.index + full.length;
  }
  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
  return nodes;
}

/**
 * Linkify one line, first collapsing `Main label [1]` into a single link on the
 * label (or an inline image when the reference is one). A label that already
 * carries a URL or address is left to the general pass, marker and all.
 */
function linkifyLine(line, refs, attachments) {
  const trailing = /^(.*\S)\s*\[(\d+)\]$/.exec(line);
  if (trailing && refs?.has(Number(trailing[2]))) {
    const href = refs.get(Number(trailing[2]));
    const label = trailing[1].replace(/^[\s|>•\-*]+/, '').replace(/[*\s]+$/, '').trim();
    if (!hasInlineLink(label)) {
      if (looksLikeImage(href)) {
        return [el('img', { class: 'reader-inline-img', src: href, alt: label || 'image', loading: 'lazy' })];
      }
      return [link(label || href, href)];
    }
    // The label already carries its own link or address: drop the bare marker
    // rather than trailing the line with a second, redundant link.
    return linkify(label, refs, attachments);
  }
  return linkify(line, refs, attachments);
}

/**
 * Format a plain-text body for the reader.
 *
 * Text bodies are split on blank lines into paragraphs, which gives an email
 * rhythm instead of one long wall (and preserves any internal line breaks).
 * Form-submission services send a Key/Value report — the same rows as their
 * HTML table, as "label line, blank line, value line" pairs — which reads
 * terribly as prose, so a run of such pairs is rendered as a real table.
 * Footnote references, links, emphasis and `[cid:…]` inline images are all
 * resolved from the plain text.
 *
 * Returns an array of DOM nodes.
 */
export function formatTextBody(text, attachments) {
  const { lines, refs } = resolveReferences(text);

  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (!line.trim()) {
      if (current.length) { blocks.push(current); current = []; }
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current);

  const paragraph = (block) => {
    const p = el('p', { class: 'reader-para' });
    block.forEach((line, i) => {
      if (i) p.append(document.createTextNode('\n'));
      for (const node of linkifyLine(line, refs, attachments)) p.append(node);
    });
    return p;
  };
  const cell = (value, scope) => {
    const th = scope === 'row';
    const node = el(th ? 'th' : 'td', th ? { scope: 'row' } : {});
    for (const part of linkifyLine(value, refs, attachments)) node.append(part);
    return node;
  };

  // A Key/Value pair is exactly two lines: a short label, then its value. A
  // report is a run of at least two of them in a row. Report labels are single
  // tokens (name, company_website), never a sentence fragment, so a key must
  // be one whitespace-free word or the detector would turn any short two-line
  // paragraph into a table.
  const isPair = (block) => block.length === 2
    && /^[^\s.,;!?:()]{1,40}$/.test(block[0])
    && block[1].length <= 500
    && block[1].trim() !== '';
  const firstPair = blocks.findIndex(isPair);
  let reportStart = -1;
  let reportEnd = -1;
  if (firstPair !== -1) {
    let count = 0;
    let i = firstPair;
    while (i < blocks.length && isPair(blocks[i])) { count += 1; i += 1; }
    if (count >= 2) { reportStart = firstPair; reportEnd = i; }
  }

  if (reportStart === -1) {
    return blocks.map((block) => paragraph(block));
  }

  const parts = [];
  for (let i = 0; i < reportStart; i += 1) parts.push(paragraph(blocks[i]));

  const tableBody = el('tbody');
  for (let i = reportStart; i < reportEnd; i += 1) {
    const [key, value] = blocks[i];
    tableBody.append(el('tr', {}, cell(key, 'row'), cell(value)));
  }
  parts.push(el('table', { class: 'reader-report' }, tableBody));

  for (let i = reportEnd; i < blocks.length; i += 1) parts.push(paragraph(blocks[i]));
  return parts;
}

/**
 * Swap `reader-cid` placeholders (inline-image references in a text body) for
 * the real attachment image. Unresolvable references keep their bracket text.
 */
async function hydrateTextCids(holder, attachments, messageId, mailboxId) {
  for (const span of [...holder.querySelectorAll('.reader-cid')]) {
    const att = matchCid(span.dataset.cid, attachments);
    if (!att) continue;
    try {
      const data = await api.mail.attachmentUrl(att.id, messageId, true, mailboxId);
      span.replaceWith(el('img', { class: 'attach-img', src: data.url, alt: att.filename }));
    } catch {
      // Leave the bracket text: an offline-friendly fallback beats a broken icon.
    }
  }
}

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
    if (msg.bodyHtml && (visibleTextLength(msg.bodyHtml) > 0 || !msg.bodyText)) {
      // `mountMessageFrame` owns the sandbox tokens, the light content canvas
      // and the sizing; the reader just places it. The comment that used to
      // live here — claiming the frame sizes itself from its content — was the
      // bug: without allow-same-origin this page cannot read into it, so
      // nothing could size it, and every body sat in a 150px strip.
      // `cid:` image references are resolved to signed URLs first so a
      // sender's inline logo actually renders instead of an empty box.
      const resolvedHtml = await resolveInlineImages(
        msg.bodyHtml,
        msg.attachments,
        (attId) => api.mail.attachmentUrl(attId, id, true, mailboxId).then((data) => data.url),
      );
      bodyFrame = mountMessageFrame(resolvedHtml, body);
    } else if (msg.bodyText) {
      const textParts = formatTextBody(msg.bodyText, msg.attachments);
      if (textParts.length) {
        const holder = el('div', { class: 'reader-text-body' }, ...textParts);
        body.append(holder);
        hydrateTextCids(holder, msg.attachments, id, mailboxId);
      } else {
        body.append(el('p', { class: 'muted', text: 'This message has no readable text.' }));
      }
    } else {
      body.append(el('p', { class: 'muted', text: 'This message has no body.' }));
    }

      if (msg.attachments?.length) {
        const chips = [];
        msg.attachments.forEach((att) => {
          const isImage = /^image\//.test(att.mimeType || '');
          const chip = el('button', { class: 'attach-chip', title: att.filename, onClick: () => openAttachment(att) },
            isImage ? el('img', { class: 'attach-preview', alt: '' }) : icon('paperclip'),
            el('span', { class: 'attach-name', text: att.filename }),
            el('span', { class: 'muted small', text: formatBytes(att.sizeBytes) }),
          );
          chips.push({ chip, att, isImage });
        });
        body.append(
          el('div', { class: 'attachments' },
            el('h3', { text: `Attachments (${msg.attachments.length})` }),
            ...chips.map(({ chip }) => chip),
          ),
        );

        // Image attachments preview themselves: fetch each signed URL and let
        // it load into the chip. A failed fetch leaves the icon placeholder.
        for (const { chip, att, isImage } of chips) {
          if (!isImage) continue;
          const img = chip.firstElementChild;
          try {
            const data = await api.mail.attachmentUrl(att.id, id, true, mailboxId);
            img.src = data.url;
          } catch {
            img.replaceWith(icon('paperclip'));
          }
        }
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