/**
 * Sandboxed frames for HTML message bodies.
 *
 * A message body is sender-controlled, so it is never mounted as live DOM: the
 * server sanitises it on ingest and on send, and this iframe is the
 * browser-enforced backstop if the sanitiser is ever wrong. That part is
 * unchanged by anything below.
 *
 * What this module fixes is the presentation, in two steps:
 *
 * 1. Height. A cross-origin frame with no `allow-same-origin` cannot be read by
 *    this page — `frame.contentDocument` is null — so nothing here can ask the
 *    frame how tall it is. An `<iframe>` with no height is a replaced element
 *    with a 150px intrinsic height, which is why long messages were trapped in a
 *    short box with a scrollbar inside it. So the height is measured in this
 *    document instead: the HTML is parsed with DOMParser, which creates an inert
 *    document that runs no scripts and fires no handlers, adopted into a hidden
 *    host, and read back. Only the resulting *number* ever crosses into the
 *    frame; the markup never runs here.
 *
 *    Images have no size until they load, so the first measurement is taken
 *    immediately (text is laid out already) and a second one follows once the
 *    images have settled. Both happen in the same hidden host, so the frame's
 *    own requests usually hit the warm cache rather than going out twice.
 *
 * 2. Canvas. Email content gets a light canvas in its own authored colours,
 *    the way mail clients render it. Letting the app's theme text colour bleed
 *    into the frame is what made styled boxes with invisible text: senders
 *    paint backgrounds but leave text colour to their `<style>` sheet, and
 *    whichever app theme was active clashed with the sender's background.
 */

import { el } from './ui.js';

/**
 * The only sandbox tokens the reader grants.
 *
 * Never add `allow-scripts` or `allow-same-origin`: on their own neither can do
 * anything here, but together they void the sandbox entirely and let sender
 * markup reach this page's origin.
 */
export const BODY_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

/** Smallest box a body is ever given, so a short message still looks like one. */
const MIN_HEIGHT = 140;

/**
 * Height used where there is no layout engine to read.
 *
 * jsdom has no layout, so `scrollHeight` is always 0 there. Treating 0 as "not
 * measured yet" rather than "empty" keeps the shipped value sensible instead of
 * pinning every test body to the minimum.
 */
const FALLBACK_HEIGHT = 320;

/** Longest to wait for the measuring pass's images before settling for text. */
const IMAGE_WAIT_MS = 2500;

const FONT = "font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

/**
 * Email content is rendered on a light canvas in its authored colours, the way
 * mail clients render it (and the way senders design for it). Forcing the
 * app's theme text colour onto the content was the hop too far: an email that
 * sets its own backgrounds but never its text colour (common — the colour is
 * in its `<style>` sheet) ended up with light text on its white cells in the
 * dark theme, or dark text on its dark hero blocks in the light one: styled
 * boxes with invisible text.
 */
const CANVAS = {
  background: '#ffffff',
  text: '#1b2233',
  link: '#1a5fb4',
  quote: '#4a5468',
  rule: '#d7deec',
};

/** The stylesheet inside the frame. */
function frameStyles() {
  const c = CANVAS;
  return `
    html, body { margin: 0; padding: 0; background: ${c.background}; color: ${c.text}; overflow-wrap: anywhere; }
    body { ${FONT}; padding: 4px 2px; }
    img { max-width: 100%; height: auto; }
    table { max-width: 100%; border-collapse: collapse; }
    td, th { word-break: break-word; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    a { color: ${c.link}; }
    blockquote { margin: 0 0 10px; padding-left: 12px; border-left: 3px solid ${c.rule}; color: ${c.quote}; }
    hr { border: 0; border-top: 1px solid ${c.rule}; margin: 12px 0; }
  `;
}

/** The frame document. */
function srcdoc(html) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<base target="_blank"><meta name="referrer" content="no-referrer">
<style>${frameStyles()}</style>
</head><body>${html}</body></html>`;
}

// ─── Readability ─────────────────────────────────────────────────────────────
//
// A sender's background colours survive sanitisation (inline `style` and the
// `bgcolor` attribute are kept) but the matching text colours usually live in
// the `<style>` sheet, and for anything stored before the sanitizer kept
// sheets — that is, mail already in the box — the sheet is gone for good. The
// frame's fallback text colour is then painted over the sender's own
// backgrounds: dark text on a dark cell reads as a "styled square with no
// text", and no server-side change can re-add what was never stored.
//
// So readability is enforced here, over whatever the sanitizer kept. For every
// run of text, the contrast between the colour it will actually render and the
// background the email painted behind it is checked, and a readable colour is
// forced wherever the pair would fail. This sits on the end of the pipeline, so
// it cannot know about a sheet the sanitizer dropped — and does not need to:
// backgrounds that read the email rely on are inline or bgcolor, making them
// the reliable signal to judge against.

const READABLE_RATIO = 3; // WCAG AA for large text; fixes always force ≥ 4.5:1
const DARK_BACKGROUND_LUMINANCE = 0.33;

const NAMED_COLORS = new Map([
  ['black', '#000000'], ['white', '#ffffff'], ['gray', '#808080'], ['grey', '#808080'],
  ['silver', '#c0c0c0'], ['maroon', '#800000'], ['red', '#ff0000'], ['purple', '#800080'],
  ['fuchsia', '#ff00ff'], ['green', '#008000'], ['lime', '#00ff00'], ['olive', '#808000'],
  ['yellow', '#ffff00'], ['navy', '#000080'], ['blue', '#0000ff'], ['teal', '#008080'],
  ['aqua', '#00ffff'], ['orange', '#ffa500'], ['crimson', '#dc143c'], ['brown', '#a52a2a'],
  ['gold', '#ffd700'], ['pink', '#ffc0cb'], ['chocolate', '#d2691e'], ['indigo', '#4b0082'],
  ['violet', '#ee82ee'], ['cyan', '#00ffff'],
]);

function clampRGB(n) { return n < 0 ? 0 : n > 255 ? 255 : Math.round(n); }

/** Parse a colour string (hex, rgb()/rgba(), named) into [r,g,b], else null. */
function parseColor(value) {
  if (!value) return null;
  let s = String(value).trim().toLowerCase();
  if (!s || s === 'transparent' || s === 'none' || s === 'initial' || s === 'inherit') return null;
  if (NAMED_COLORS.has(s)) s = NAMED_COLORS.get(s);

  let m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (m) {
    let hex = m[1];
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }

  m = /^rgba?\(([^)]*)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(',').map((part) => parseFloat(part.trim()));
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
      return [clampRGB(parts[0]), clampRGB(parts[1]), clampRGB(parts[2])];
    }
  }
  return null;
}

/** The first colour token in a CSS declaration value, else null. */
function firstColor(declaration) {
  const cleaned = String(declaration || '').replace(/url\([^)]*\)/g, '');
  const hex = /(#[0-9a-f]{3,8})\b/i.exec(cleaned);
  if (hex) return parseColor(hex[1]);
  const func = /rgba?\(([^)]*)\)/i.exec(cleaned);
  if (func) return parseColor(func[0]);
  for (const word of cleaned.split(/[,\s]+/)) {
    const lower = word.trim().toLowerCase();
    if (NAMED_COLORS.has(lower)) return parseColor(lower);
  }
  return null;
}

/** Parse `background`/`background-color` (background checked last) from a style attribute. */
function backgroundOf(styleText) {
  const colorRe = /(?:^|[;\s])background-color\s*:\s*([^;]*)/i;
  const bgRe = /(?:^|[;\s])background\s*:\s*([^;]*)/i;
  const m = colorRe.exec(String(styleText || '')) || bgRe.exec(String(styleText || ''));
  return m ? firstColor(m[1]) : null;
}

/** Parse the `color` declaration from a style attribute. */
function colorOf(styleText) {
  const m = /(?:^|[;\s])color\s*:\s*([^;]*)/i.exec(String(styleText || ''));
  return m ? firstColor(m[1]) : null;
}

/** Relative luminance (WCAG) of [r,g,b]. */
function relativeLuminance([r, g, b]) {
  const linear = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio of two [r,g,b] colours, from 1 (identical) to 21. */
function contrast([r1, g1, b1], [r2, g2, b2]) {
  const a = relativeLuminance([r1, g1, b1]);
  const b = relativeLuminance([r2, g2, b2]);
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** The background that will actually sit behind `element`'s text. */
function backgroundBehind(element) {
  let node = element;
  while (node) {
    if (node.nodeType === 1) {
      const bg = backgroundOf(node.getAttribute('style')) || parseColor(node.getAttribute('bgcolor'));
      if (bg) return bg;
    }
    node = node.parentElement;
  }
  return [255, 255, 255]; // the frame's light canvas
}

/** The text colour `element` will actually render: inline, inherited, or the frame default. */
function renderedColor(element) {
  let node = element;
  let insideLink = false;
  while (node) {
    if (node.nodeType === 1) {
      if (node.tagName.toLowerCase() === 'a') insideLink = true;
      const color = colorOf(node.getAttribute('style'));
      if (color) return color;
    }
    node = node.parentElement;
  }
  return insideLink ? [0x1a, 0x5f, 0xb4] : [0x1b, 0x22, 0x33];
}

/**
 * Force every run of email text to be legible against the background it sits
 * on, and return the body HTML with the fixes applied.
 *
 * Only elements holding text of their own are touched, so a single inline
 * `color` cascades to that text and its descendants. The change is appended to
 * the element's style attribute so it always wins over what was there, and the
 * result is used for both the frame and the measuring host, keeping their
 * layouts identical.
 */
export function ensureLegible(html) {
  const parsed = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');

  for (const element of parsed.body.querySelectorAll('*')) {
    const tag = element.tagName.toLowerCase();
    if (tag === 'style' || tag === 'script' || tag === 'noscript') continue;

    const hasText = [...element.childNodes].some(
      (node) => node.nodeType === 3 && /\S/.test(node.textContent || ''),
    );
    if (!hasText) continue;

    const background = backgroundBehind(element);
    const color = renderedColor(element);
    if (contrast(color, background) >= READABLE_RATIO) continue;

    const fix = relativeLuminance(background) < DARK_BACKGROUND_LUMINANCE ? '#ffffff' : '#1b2233';
    const existing = element.getAttribute('style');
    element.setAttribute('style', `${existing ? existing + ';' : ''}color:${fix}`);
  }

  return parsed.body.innerHTML;
}

/**
 * Strip anything that could execute, from a parsed document, before it is moved
 * into this one.
 *
 * This is the step that makes the measurement safe. Parsing with DOMParser is
 * inert by itself — the resulting document has no browsing context, so nothing
 * runs — but these nodes are about to be appended to a live document, where an
 * inline handler would fire and a script would run *at insertion*, before
 * anything after it in this function had a chance to help. Removing them while
 * they are still in the inert document means there is never a moment when the
 * live document holds them.
 *
 * Every removal here is layout-neutral, which is why it does not change the
 * number: a script contributes no box, an event handler contributes no box, and
 * a nested frame that cannot load anything contributes an empty one.
 */
function neutralise(root) {
  for (const node of [...root.querySelectorAll('script, link[rel~="stylesheet"], iframe, object, embed')]) {
    node.remove();
  }
  for (const node of root.querySelectorAll('*')) {
    for (const attribute of [...node.attributes]) {
      if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
    }
  }
}

/**
 * Build a hidden host holding `html` laid out at `width`.
 *
 * `visibility: hidden` rather than `display: none`: hidden boxes still lay out
 * and still load their images, which is the entire point of the host.
 */
function createMeasurer(html, width) {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.setAttribute('data-message-measurer', '');
  host.style.cssText = [
    'position:fixed',
    'top:0',
    'left:-100000px',
    `width:${Math.max(1, Math.round(width))}px`,
    'visibility:hidden',
    'pointer-events:none',
  ].join(';');

  const parsed = new DOMParser().parseFromString(
    `<!doctype html><html><head></head><body>${html || ''}</body></html>`,
    'text/html',
  );
  neutralise(parsed);

  /*
   * The shadow tree mirrors the frame document element for element: a stylesheet,
   * then a real <body>. Using <body> rather than a div matters — it is what the
   * email's own `body { ... }` rules match, so a sender who styles the body is
   * measured the way it renders, and a div would silently miss that.
   *
   * Both stylesheets go in as elements, in the frame's own order. An inline
   * `style` attribute on the body would beat every email rule on specificity and
   * change the number; as a sheet at the front it loses to theirs exactly as it
   * does in the frame.
   */
  const shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  const own = document.createElement('style');
  own.textContent = frameStyles();

  const body = document.createElement('body');
  shadow.append(own, body);

  // An email's own stylesheet is normally in the <head>, and dropping it would
  // make the measurement meaningless — a table sized by CSS would come out at a
  // different height than the frame actually renders it. Kept inside the shadow
  // root so it is scoped to this one tree and cannot reach the app. Styles at
  // body level (where the sanitizer re-emits them) are copied the same way, in
  // document order, so the frame and the measurer agree.
  for (const sheet of [...parsed.querySelectorAll('style')]) {
    body.append(sheet);
  }
  while (parsed.body.firstChild) body.append(parsed.body.firstChild);

  document.body.append(host);
  return { host, body };
}

/**
 * The laid-out height of a measuring host, in px.
 *
 * Margins are added back because `getBoundingClientRect` returns the border box
 * and an email that sets `body { margin: 40px }` is 80px taller than that.
 */
function readHeight(body) {
  const rect = body.getBoundingClientRect();

  // The border box is the part that comes from actual layout. A box that has
  // not been laid out at all measures 0, and that has to be told apart from a
  // narrow one: jsdom applies the user-agent `body { margin: 8px }` to
  // `getComputedStyle` while laying nothing out, so testing the *sum* below
  // would return 16 and pin every message to MIN_HEIGHT instead of falling
  // back.
  if (!Number.isFinite(rect.height) || rect.height <= 0) return FALLBACK_HEIGHT;

  const style = getComputedStyle(body);
  const margins = (Number.parseFloat(style.marginTop) || 0)
    + (Number.parseFloat(style.marginBottom) || 0);
  return rect.height + margins;
}

/** Resolve once every image in `root` has loaded, failed, or timed out. */
function imagesSettled(root, timeoutMs) {
  const pending = [...root.querySelectorAll('img')]
    .filter((img) => !img.complete)
    .map((img) => new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    }));

  if (!pending.length) return Promise.resolve();

  let timer = null;
  return Promise.race([
    Promise.all(pending),
    new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Attach a self-sizing HTML body frame to `host`.
 *
 * The element is returned immediately with a text-height estimate already
 * applied, so a body never appears inside an empty 150px strip while images are
 * still in flight.
 *
 * @param {string} html sanitised message body
 * @param {HTMLElement} host element to append the frame to
 * @returns {{frame: HTMLIFrameElement, element: HTMLElement, destroy: () => void}}
 */
export function mountMessageFrame(html, host) {
  const wrapper = el('div', { class: 'reader-html' });
  const frame = el('iframe', {
    class: 'reader-frame',
    title: 'Message body',
    sandbox: BODY_SANDBOX,
    referrerpolicy: 'no-referrer',
    loading: 'lazy',
  });
  wrapper.append(frame);
  host.append(wrapper);

  // Apply the readability pass once, to the copy both the frame and the
  // measuring host render. They must see byte-identical content or the height
  // would be measured on a different layout.
  const bodyHtml = ensureLegible(html);
  let destroyed = false;

  /** Read the current width of the frame's box, which is the wrapper's. */
  const frameWidth = () => wrapper.clientWidth || frame.clientWidth || 0;

  /**
   * Take one measurement and set the frame's height from it.
   *
   * Creates a host, measures, and (when `withImages`) keeps it alive until the
   * images have settled so the second reading is the accurate one. The host is
   * always removed afterwards — nothing but its number survives.
   */
  /** Clamp and write a measurement, unless the frame has gone away. */
  function setHeight(height) {
    if (destroyed) return;
    frame.style.height = `${Math.max(MIN_HEIGHT, Math.round(height))}px`;
  }

  async function applyHeight({ withImages = false } = {}) {
    if (destroyed) return;

    const { host: box, body: measured } = createMeasurer(bodyHtml, frameWidth());

    // Text is laid out already, so this reading is final for text-only bodies
    // and merely a good first estimate for the rest. It is written straight
    // through — before any await — so the frame is never left sitting at the
    // 150px intrinsic height of an unmeasured <iframe>.
    let height = readHeight(measured);
    setHeight(height);

    if (withImages) {
      await imagesSettled(measured, IMAGE_WAIT_MS);
      if (destroyed) {
        box.remove();
        return;
      }
      height = Math.max(height, readHeight(measured));
    }

    box.remove();
    setHeight(height);
  }

  // First paint: text already has a height, images do not, so measure now and
  // again once they are in.
  frame.srcdoc = srcdoc(bodyHtml);
  applyHeight({ withImages: true });

  // Re-measure when the frame's box changes. Emails are mostly fixed-width
  // tables, so a window narrower than the author's layout changes how they wrap
  // and therefore how tall they are.
  const onResize = () => applyHeight({ withImages: false });
  window.addEventListener('resize', onResize);

  return {
    frame,
    element: wrapper,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      window.removeEventListener('resize', onResize);
    },
  };
}
