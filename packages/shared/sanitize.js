/**
 * HTML sanitiser and plain-text extractor.
 *
 * Why this exists: Re-EL Mailer renders HTML that arrived from the internet
 * (inbound mail, admin-authored templates). Rendering that unfiltered would
 * create a stored-XSS hole in the mailbox view, so every HTML body is passed
 * through `sanitizeHtml()` before it is stored *and* before it is returned.
 *
 * Approach: a small strict tokeniser with a tag/attribute allowlist. Anything
 * not explicitly allowed is dropped. Dangerous elements are dropped together
 * with their contents. No external parser is used, because adding one
 * (jsdom, sanitize-html) is a large dependency for a serverless bundle and the
 * strict-allowlist tokeniser is easier to audit.
 *
 * This is a defensive layer, not a security boundary on its own. The mailbox
 * body is additionally rendered inside a sandboxed container in the UI.
 */

// ─── Allowlists ──────────────────────────────────────────────────────────────

/** Tags that survive, with their text content. */
const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'blockquote', 'br',
  'caption', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div',
  'dl', 'dt', 'em', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'header', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'main', 'mark', 'nav', 'ol',
  'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'section', 'small', 'span',
  'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'time', 'tr', 'u', 'ul', 'var', 'wbr',
]);

/**
 * Elements dropped *with their contents* — their text is not safe or useful
 * to keep (script/style text is code; svg/math can carry script; form controls
 * can phish; head/meta can rewrite the document).
 */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'noscript', 'template', 'svg', 'math', 'form', 'input', 'button', 'select',
  'option', 'optgroup', 'textarea', 'fieldset', 'legend', 'link', 'meta', 'base',
  'head', 'title', 'audio', 'video', 'source', 'track', 'canvas', 'map', 'area',
  'dialog', 'portal', 'slot', 'plaintext', 'xmp', 'listing', 'marquee',
]);

/** Void elements: never emit a closing tag for them. */
const VOID_TAGS = new Set(['br', 'hr', 'img', 'col', 'wbr']);

/** Attributes allowed on every element. */
const GLOBAL_ATTRS = new Set(['title', 'dir', 'lang', 'style', 'class']);

/** Extra attributes allowed per tag. */
const TAG_ATTRS = {
  a: new Set(['href', 'name', 'target', 'rel', 'download']),
  img: new Set(['src', 'alt', 'width', 'height', 'srcset', 'sizes', 'loading', 'align']),
  td: new Set(['colspan', 'rowspan', 'align', 'valign', 'width', 'height', 'nowrap']),
  th: new Set(['colspan', 'rowspan', 'align', 'valign', 'width', 'height', 'scope', 'nowrap']),
  table: new Set(['cellpadding', 'cellspacing', 'border', 'align', 'width', 'bgcolor', 'summary']),
  col: new Set(['span', 'width', 'align', 'valign']),
  colgroup: new Set(['span', 'width', 'align', 'valign']),
  tr: new Set(['align', 'valign', 'bgcolor']),
  tbody: new Set(['align', 'valign']),
  thead: new Set(['align', 'valign']),
  tfoot: new Set(['align', 'valign']),
  ol: new Set(['start', 'reversed', 'type']),
  li: new Set(['value', 'type']),
  time: new Set(['datetime']),
  del: new Set(['datetime', 'cite']),
  ins: new Set(['datetime', 'cite']),
  blockquote: new Set(['cite']),
  q: new Set(['cite']),
  details: new Set(['open']),
  bdo: new Set([]),
  font: new Set([]),
};

/** Attributes whose value is a URL and therefore needs scheme validation. */
const URL_ATTRS = new Set(['href', 'src', 'srcset', 'cite', 'background', 'poster', 'longdesc']);

/** URL schemes permitted in markup. `cid:` resolves to an attachment in the UI. */
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel', 'cid', 'data']);

/** `data:` URLs are only allowed for these image types (never text/html). */
const SAFE_DATA_MEDIA = /^image\/(png|jpe?g|gif|webp|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)$/i;

/** Elements that add line breaks when converting HTML to text. */
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'div', 'dd', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul',
]);

// ─── Small helpers ───────────────────────────────────────────────────────────

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'",
};

function decodeEntities(value) {
  return String(value).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const code = Number.parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 9 || code > 0x10ffff) return '';
      // Never resurrect characters that could re-open markup.
      if (code === 60 || code === 62) return '';
      try {
        return String.fromCodePoint(code);
      } catch {
        return '';
      }
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

/** Strip control characters that browsers and mail clients ignore or mis-handle. */
function stripControlChars(value) {
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/** Remove characters that let `javascript:` hide behind whitespace or control codes. */
function normaliseUrlForCheck(value) {
  return stripControlChars(value)
    .replace(/&#[xX]?0*(?:3a|58);?/g, ':')
    .replace(/[\s\u00a0]+/g, '');
}

export function isSafeUrl(rawValue, { allowDataImage = true } = {}) {
  const cleaned = normaliseUrlForCheck(rawValue);
  if (!cleaned) return false;

  // Relative and fragment URLs are fine (they cannot execute).
  if (cleaned.startsWith('#') || cleaned.startsWith('/') || cleaned.startsWith('?')) return true;
  // Protocol-relative URLs are treated as https.
  if (cleaned.startsWith('//')) return true;

  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned);
  if (!schemeMatch) {
    // No scheme at all → relative path such as "folder/file.html".
    return !cleaned.includes(':');
  }

  const scheme = schemeMatch[1].toLowerCase();
  if (!SAFE_SCHEMES.has(scheme)) return false;

  if (scheme === 'data') {
    if (!allowDataImage) return false;
    // Match against `cleaned`, which still begins with "data:", so the regex
    // must not skip the prefix. Slicing first made the media type empty and let
    // `data:text/html,...` through as if it were an image.
    const meta = /^data:([^;,]*)/i.exec(cleaned);
    const media = meta ? meta[1].trim().toLowerCase() : '';
    // An empty media type is not an image; refuse rather than assume.
    return SAFE_DATA_MEDIA.test(media);
  }

  return true;
}

/**
 * Sanitise a `style="…"` attribute.
 * Removes expressions, behaviour bindings and url() pointing at script schemes.
 */
export function sanitizeStyle(value) {
  let css = stripControlChars(String(value ?? ''));
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/expression\s*\(/i.test(css)) return '';
  if (/-moz-binding|behaviou?r\s*:|@import/i.test(css)) return '';
  css = css.replace(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (match, _quote, url) => {
    const decoded = decodeEntities(url).trim();
    if (!decoded) return 'none';
    if (/^data:image\//i.test(decoded)) return match;
    if (/^https?:\/\//i.test(decoded)) return match;
    return 'none';
  });
  if (/javascript:|vbscript:|data:text\/html/i.test(css)) return '';
  return css.slice(0, 2_000);
}

// ─── Tokeniser ───────────────────────────────────────────────────────────────

/**
 * Split an attribute list from inside a tag body.
 * Handles quoted values containing `>`, which a naive regex splits incorrectly.
 */
function parseAttributes(source) {
  const attrs = [];
  const pattern = /([^\s=/>"']+)(\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1].toLowerCase();
    if (!name || name === '/') continue;
    const rawValue = match[4] ?? match[5] ?? match[6] ?? '';
    attrs.push({ name, value: decodeEntities(rawValue) });
  }
  return attrs;
}

/**
 * Find the index just past the closing tag of `tagName`, honouring nesting of
 * the same element name. Returns `input.length` when the element is never
 * closed, so the remainder of the document is dropped.
 */
function skipElement(input, tagName, fromIndex) {
  const lower = input.toLowerCase();
  const open = new RegExp(`<${tagName}\\b`, 'g');
  const close = new RegExp(`</${tagName}\\s*>`, 'g');
  let depth = 1;
  let cursor = fromIndex;

  while (cursor < input.length) {
    open.lastIndex = cursor;
    close.lastIndex = cursor;
    const nextOpen = open.exec(lower);
    const nextClose = close.exec(lower);

    if (!nextClose) return input.length;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      cursor = nextOpen.index + nextOpen[0].length;
      continue;
    }
    depth -= 1;
    if (depth === 0) return nextClose.index + nextClose[0].length;
    cursor = nextClose.index + nextClose[0].length;
  }
  return input.length;
}

/**
 * Sanitise an HTML fragment.
 *
 * @param {string} html
 * @param {object} [options]
 * @param {number} [options.maxLength=2_000_000] hard cap on output size
 * @returns {string} sanitised HTML
 */
export function sanitizeHtml(html, options = {}) {
  const maxLength = options.maxLength ?? 2_000_000;
  if (html === null || html === undefined) return '';

  let input = stripControlChars(String(html));
  // Remove comments (including downlevel-revealed conditional comments),
  // CDATA sections and processing instructions before tokenising.
  input = input.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  input = input.replace(/<\?[\s\S]*?\?>/g, '');

  const out = [];
  const openStack = [];
  let index = 0;
  let droppedDepth = 0;
  let totalLength = 0;
  let tagBudget = 5_000;

  const emit = (chunk) => {
    if (totalLength >= maxLength) return;
    const room = maxLength - totalLength;
    const slice = chunk.length > room ? chunk.slice(0, room) : chunk;
    out.push(slice);
    totalLength += slice.length;
  };

  while (index < input.length && totalLength < maxLength && tagBudget > 0) {
    const lt = input.indexOf('<', index);
    if (lt === -1) {
      if (droppedDepth === 0) emit(escapeHtml(input.slice(index)));
      break;
    }

    if (lt > index) {
      if (droppedDepth === 0) emit(escapeHtml(input.slice(index, lt)));
      index = lt;
    }

    // Find the end of the tag, respecting quoted attribute values.
    let cursor = lt + 1;
    let quote = null;
    let tagEnd = -1;
    while (cursor < input.length) {
      const char = input[cursor];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        tagEnd = cursor;
        break;
      }
      cursor += 1;
    }

    if (tagEnd === -1) {
      // Unterminated tag: treat the remainder as text.
      if (droppedDepth === 0) emit(escapeHtml(input.slice(lt)));
      break;
    }

    tagBudget -= 1;
    let body = input.slice(lt + 1, tagEnd);
    index = tagEnd + 1;

    if (body.startsWith('/')) {
      const name = body.slice(1).trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (DROP_WITH_CONTENT.has(name) || ALLOWED_TAGS.has(name)) {
        // Close elements until this one is matched, dropping unclosed children.
        while (openStack.length > 0) {
          const popped = openStack.pop();
          if (DROP_WITH_CONTENT.has(popped)) {
            droppedDepth = Math.max(0, droppedDepth - 1);
          } else {
            emit(`</${popped}>`);
          }
          if (popped === name) break;
        }
      }
      continue;
    }

    // Doctype, CDATA and other declarations are dropped.
    if (body.startsWith('!')) continue;

    const selfClosing = body.endsWith('/');
    if (selfClosing) body = body.slice(0, -1);
    const nameMatch = /^([a-zA-Z][a-zA-Z0-9:-]*)/.exec(body);
    if (!nameMatch) continue;

    const tagName = nameMatch[1].toLowerCase();
    if (tagName === 'font') continue; // deprecated, styling comes from class/style

    if (DROP_WITH_CONTENT.has(tagName)) {
      // Suppress output until the matching close tag (or to end of input).
      if (!selfClosing && !VOID_TAGS.has(tagName)) {
        index = skipElement(input, tagName, index);
        droppedDepth += 1;
        openStack.push(tagName);
      }
      continue;
    }

    if (!ALLOWED_TAGS.has(tagName)) continue;

    const attrs = parseAttributes(body.slice(nameMatch[0].length));
    const allowedExtra = TAG_ATTRS[tagName] || new Set();
    const renderedAttrs = [];
    let hasRelNoopener = false;

    for (const attr of attrs) {
      const attrName = attr.name;
      if (attrName.startsWith('on')) continue;              // event handlers
      if (attrName === 'id' || attrName.startsWith('data-') || attrName.startsWith('aria-')) {
        // Dropped deliberately: `id` enables DOM clobbering of the app shell.
        continue;
      }
      const allowed = GLOBAL_ATTRS.has(attrName) || allowedExtra.has(attrName);
      if (!allowed) continue;

      let value = stripControlChars(attr.value);
      if (URL_ATTRS.has(attrName) && !isSafeUrl(value)) continue;
      if (attrName === 'href' && value.toLowerCase().startsWith('target')) continue;
      if (attrName === 'style') {
        value = sanitizeStyle(value);
        if (!value) continue;
      }
      if (attrName === 'class') {
        // Email HTML uses long class names; keep them but bound the length.
        value = value.replace(/[^\w\s-]/g, '').trim().slice(0, 200);
        if (!value) continue;
      }
      if (attrName === 'rel') hasRelNoopener = true;
      renderedAttrs.push(`${attrName}="${escapeAttr(value)}"`);
    }

    // Links that open a new context must not hand the opener to the target.
    if (tagName === 'a' && renderedAttrs.some((a) => a.startsWith('target='))) {
      if (!hasRelNoopener) renderedAttrs.push('rel="noopener noreferrer nofollow"');
    }

    const attrString = renderedAttrs.length ? ` ${renderedAttrs.join(' ')}` : '';

    if (VOID_TAGS.has(tagName)) {
      emit(`<${tagName}${attrString}>`);
      continue;
    }

    if (selfClosing) {
      emit(`<${tagName}${attrString}></${tagName}>`);
      continue;
    }

    emit(`<${tagName}${attrString}>`);
    openStack.push(tagName);
  }

  // Close anything left open so the fragment cannot break the host document.
  while (openStack.length > 0) {
    const popped = openStack.pop();
    if (!DROP_WITH_CONTENT.has(popped)) emit(`</${popped}>`);
  }

  return out.join('');
}

// ─── HTML → text ─────────────────────────────────────────────────────────────

/**
 * Convert an HTML body to readable plain text, preserving block structure.
 * Used to populate `messages.body_text`, which is what full-text search and
 * snippets run against.
 */
export function htmlToText(html) {
  if (!html) return '';
  let working = stripControlChars(String(html))
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '');

  // Preserve paragraph/line structure before stripping remaining tags.
  working = working.replace(/<br\s*\/?>/gi, '\n');
  working = working.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|section|article)\s*>/gi, '\n');
  working = working.replace(/<li\b[^>]*>/gi, '\n• ');
  working = working.replace(/<\/(td|th)\s*>/gi, '\t');
  working = working.replace(/<hr\s*\/?>/gi, '\n----------\n');
  working = working.replace(/<[^>]+>/g, '');

  let text = decodeEntities(working);
  text = text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  // Remove long runs of unprintable whitespace.
  return text.replace(/\u00a0/g, ' ');
}

/** Collapse a body down to a single-line preview for list rows and snippets. */
export function makeSnippet(body, maxLength = 160) {
  const text = (body || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s>|*-]+/, '')
    .trim();
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Strip a Re: / Fwd: prefix chain down to the original subject. */
export function baseSubject(subject) {
  let value = String(subject || '').trim();
  let previous;
  do {
    previous = value;
    value = value.replace(/^\s*(re|fw|fwd|aw|sv|tr)\s*(\[\d+\])?\s*:\s*/i, '');
  } while (value !== previous);
  return value.trim();
}

/** Turn a subject into a URL/label-safe slug. */
export function slugify(value, maxLength = 40) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLength) || 'message';
}

/** Deterministic, collision-resistant colour from a string (avatar hues). */
export function hashHue(value) {
  let hash = 0;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) % 360;
  }
  return hash;
}