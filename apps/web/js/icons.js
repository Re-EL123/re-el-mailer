/**
 * Inline SVG icon set.
 *
 * The toolbar used to render emoji (📎, 🗑, ↩) as iconography. That looks
 * inconsistent across platforms, cannot be recoloured to follow the theme, and
 * reads as content rather than decoration to a screen reader. These are drawn
 * with `currentColor` so they inherit button colour in both themes, and are
 * `aria-hidden` by default because the surrounding control carries the name.
 *
 * Icons are built with createElementNS rather than innerHTML: el() is
 * deliberately markup-free so message content can never be injected, and that
 * guarantee is worth keeping for the chrome too.
 *
 * Geometry is on a 24x24 grid with a 2px stroke, so `size` can be set freely
 * and a given icon lines up with its neighbours.
 */

const NS = 'http://www.w3.org/2000/svg';

/** Icons are arrays of shape descriptors; a bare string is a stroked path. */
function stroke(...d) {
  return d.map((path) => ({ d: path }));
}

/** Same as stroke(), but filled — for the solid half of the theme toggle. */
function filled(...d) {
  return d.map((path) => ({ d: path, fill: true }));
}

export const ICONS = {
  back: stroke('M19 12H5', 'm12 19-7-7 7-7'),
  forward: stroke('M5 12h14', 'm12 5 7 7-7 7'),
  reply: stroke('m9 17-5-5 5-5', 'M4 12h11a4 4 0 0 1 4 4v3'),
  replyAll: stroke('m7 17-5-5 5-5', 'M2 12h11a4 4 0 0 1 4 4v3', 'm12 17-5-5 5-5', 'M7 12h11a4 4 0 0 1 4 4v3'),

  trash: stroke(
    'M3 6h18',
    'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
    'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
    'M10 11v6',
    'M14 11v6',
  ),

  paperclip: stroke('m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48'),

  tag: [
    ...stroke('M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z'),
    ...filled('M7.5 8a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z'),
  ],

  star: stroke('M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.12 2.12 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.12 2.12 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.12 2.12 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.12 2.12 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.12 2.12 0 0 0 1.597-1.16z'),

  // Solid variant is used for a starred message, so the state is not carried by
  // fill alone (a screen reader also announces it via aria-pressed).
  starFilled: filled('M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.12 2.12 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.12 2.12 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.12 2.12 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.12 2.12 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.12 2.12 0 0 0 1.597-1.16z'),

  settings: [
    ...stroke(
      'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    ),
  ],

  wrench: stroke('M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z'),

  power: stroke('M12 2v10', 'M18.4 6.6a9 9 0 1 1-12.8 0'),

  theme: [
    ...stroke('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z'),
    ...filled('M12 3a9 9 0 0 1 0 18z'),
  ],

  search: stroke('m21 21-4.34-4.34', 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z'),

  plus: stroke('M5 12h14', 'M12 5v14'),

  close: stroke('M18 6 6 18', 'm6 6 12 12'),

  check: stroke('M20 6 9 17l-5-5'),

  chevronDown: stroke('m6 9 6 6 6-6'),

  upload: stroke('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm17 8-5-5-5 5', 'M12 3v12'),

  clock: stroke('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'),

  inbox: stroke('M22 12h-6l-2 3h-4l-2-3H2', 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'),

  send: stroke('M22 2 11 13', 'M22 2 15 22l-4-9-9-4z'),

  // Formatting toolbar.
  bold: stroke('M6 4h8a4 4 0 0 1 0 8H6z', 'M6 12h9a4 4 0 0 1 0 8H6z'),
  italic: stroke('M19 4h-9', 'M14 20H5', 'M15 4 9 20'),
  underline: stroke('M6 4v6a6 6 0 0 0 12 0V4', 'M4 21h16'),
  strike: stroke('M16 4H9a3 3 0 0 0-2.83 4', 'M14 12a4 4 0 0 1 0 8H6', 'M4 12h16'),
  code: stroke('m16 18 6-6-6-6', 'm8 6-6 6 6 6'),

  listBullet: stroke('M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'),
  listOrdered: stroke('M10 6h11', 'M10 12h11', 'M10 18h11', 'M4 6h1v4', 'M4 10h2', 'M6 18H4c0-1 2-2 2-3s-1-1.5-2-1'),
  quote: stroke('M3 21c3 0 7-1 7-8V5a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h3', 'M14 21c3 0 7-1 7-8V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h3'),

  link: stroke('M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'),

  undo: stroke('M3 7v6h6', 'M3 13a9 9 0 1 0 3-7.7L3 8'),
  redo: stroke('M21 7v6h-6', 'M21 13a9 9 0 1 1-3-7.7L21 8'),

  keyboard: stroke('M20 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z', 'M6 9h.01', 'M10 9h.01', 'M14 9h.01', 'M18 9h.01', 'M8 13h8'),
};

/**
 * Build an icon element.
 *
 * @param {keyof ICONS} name
 * @param {{size?: number, class?: string, strokeWidth?: number}} [opts]
 * @returns {SVGElement}
 */
export function icon(name, { size = 16, class: cls = '', strokeWidth = 2 } = {}) {
  const shapes = ICONS[name];
  if (!shapes) throw new Error(`Unknown icon: ${name}`);

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  // Decorative: the control wrapping it supplies the accessible name. Without
  // this, every icon-only button announces its path data as well.
  svg.setAttribute('aria-hidden', 'true');
  // Stops IE/Edge and some screen readers from treating it as focusable.
  svg.setAttribute('focusable', 'false');
  if (cls) svg.setAttribute('class', cls);

  for (const shape of shapes) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', shape.d);
    if (shape.fill) {
      path.setAttribute('fill', 'currentColor');
      path.setAttribute('stroke', 'none');
    }
    svg.append(path);
  }

  return svg;
}

/** Names available, for tests and for error messages. */
export function iconNames() {
  return Object.keys(ICONS).sort();
}