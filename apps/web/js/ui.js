/**
 * Tiny DOM + formatting helpers.
 *
 * The app builds DOM directly rather than pulling in a framework: every screen
 * here is a list, a form or a reader, and `innerHTML` is avoided entirely in
 * favour of `el()` so message content can never be injected as markup.
 */

/** Create an element. `props.text` sets textContent (never innerHTML). */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;

    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value; // only for trusted, static markup
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') {
      node[key] = value;
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }

  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(node, ...children) {
  clear(node);
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function qs(selector, scope = document) {
  return scope.querySelector(selector);
}

/**
 * Coarse relative time for list rows: "now", "4 min", "3 hr", "2 days", then a date.
 *
 * Built on Intl.RelativeTimeFormat rather than hand-rolled string interpolation,
 * which is what the `{min}m` version did. That version could not be localised at
 * all, and its own arithmetic was wrong in a way nobody noticed: it rounded to
 * whole units, so a message 89 minutes old showed as "1h" and one 23 hours old
 * showed as "23h" next to a two-day-old message reading "2d".
 *
 * The ladder stops at a week because past that a date is more useful than a
 * count, and at that range a relative time stops being informative.
 */
const RELATIVE_UNITS = [
  ['year', 31536000],
  ['month', 2592000],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

/** Short relative form used in dense list rows. */
const RELATIVE_STYLE = { numeric: 'auto', style: 'narrow' };

export function relTime(iso, now = Date.now()) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';

  // Truncated, not rounded: rounding pushed a message into the next unit before
  // it had actually been there for long enough to deserve it.
  const seconds = (then - now) / 1000;
  const magnitude = Math.abs(seconds);

  if (magnitude < 45) return new Intl.RelativeTimeFormat(undefined, RELATIVE_STYLE).format(0, 'second');

  const formatter = new Intl.RelativeTimeFormat(undefined, RELATIVE_STYLE);
  for (const [unit, size] of RELATIVE_UNITS) {
    if (magnitude >= size) return formatter.format(Math.trunc(seconds / size), unit);
  }
  return formatter.format(Math.trunc(seconds / 60), 'minute');
}

/**
 * Full, unabbreviated relative time, for tooltips and the reader header.
 *
 * Uses a separate formatter because the narrow style renders "4 min ago" in the
 * list but is still cryptic in a title attribute, where there is no surrounding
 * context and space is not scarce.
 */
export function relTimeLong(iso, now = Date.now()) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(
    Math.round((then - now) / 60000),
    'minute',
  );
}

export function fullDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** Exact local time, for the reader's Date header where the hour matters. */
export function preciseDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(date);
}

export function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

/** "Ada Lovelace" from {name, email}, falling back to the address. */
export function displayName(person) {
  if (!person) return '';
  if (typeof person === 'string') return person;
  return person.name || person.email || '';
}

/**
 * "Ada Lovelace <ada@example.com>" — displayName with the address kept.
 *
 * displayName drops the address because compact rows need the space, but a
 * reading pane is where you verify who is actually on the other end, and a name
 * alone is exactly what a forged From line hands you. This is the same person
 * with the part displayName omits.
 */
export function fullAddress(person) {
  if (typeof person === 'string') return person;
  const name = (person?.name || '').trim();
  const email = (person?.email || '').trim();
  if (!name) return email;
  return email ? `${name} <${email}>` : name;
}

export function initials(person) {
  const name = displayName(person).trim();
  if (!name) return '?';
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] || '')
    .join('')
    .toUpperCase();
}

/** Debounce for search-as-you-type. */
export function debounce(fn, ms = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Loading placeholder.
 *
 * Shaped like the content it stands in for so the layout does not jump when the
 * real thing arrives, and hidden from assistive tech because the region it sits
 * in announces the load separately — a screen reader reading "loading" once per
 * skeleton row is worse than not being told at all.
 *
 * @param {{rows?: number, class?: string}} [opts]
 */
export function skeletonList({ rows = 5, class: cls = '' } = {}) {
  const host = el('div', { class: `skeleton-list ${cls}`.trim(), 'aria-hidden': 'true' });
  for (let i = 0; i < rows; i += 1) {
    host.append(
      el(
        'div',
        { class: 'skeleton-row' },
        el('div', { class: 'skeleton skeleton-avatar' }),
        el(
          'div',
          { class: 'skeleton-lines' },
          // Alternating widths so the placeholder reads as text, not as bars.
          el('div', { class: 'skeleton skeleton-line', style: { width: `${45 + (i % 3) * 15}%` } }),
          el('div', { class: 'skeleton skeleton-line', style: { width: `${30 + (i % 2) * 20}%` } }),
        ),
        el('div', { class: 'skeleton skeleton-date' }),
      ),
    );
  }
  return host;
}

/** Card-shaped placeholder for settings and admin panels. */
export function skeletonCards({ count = 2, lines = 3 } = {}) {
  const host = el('div', { 'aria-hidden': 'true' });
  for (let i = 0; i < count; i += 1) {
    host.append(
      el(
        'div',
        { class: 'skeleton-card' },
        el('div', { class: 'skeleton skeleton-card-title' }),
        ...Array.from({ length: lines }, (_, n) =>
          el('div', { class: 'skeleton skeleton-block', style: { width: `${90 - n * 12}%` } }),
        ),
      ),
    );
  }
  return host;
}

/**
 * Announce a state change without moving focus.
 *
 * A polite live region, created on first use and then reused: inserting and
 * removing the region itself means some screen readers miss the announcement,
 * because the change they need to report happens on the region that just
 * disappeared.
 */
export function announce(message) {
  let region = qs('#live-region');
  if (!region) {
    region = el('div', {
      id: 'live-region',
      class: 'sr-only',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true',
    });
    document.body.append(region);
  }
  // Clearing first guarantees a change is observed even when the same message
  // is announced twice in a row.
  region.textContent = '';
  region.textContent = message;
}

/** Show a transient toast. */
export function toast(message, kind = 'info') {
  let host = qs('#toasts');
  if (!host) {
    // The host is the live region, not each toast: one region reused across
    // toasts is what screen readers handle reliably. A fresh role="status" per
    // toast node is announced inconsistently, because the node is created and
    // destroyed while the message is being spoken.
    host = el('div', { id: 'toasts', class: 'toasts', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false' });
    document.body.append(host);
  }
  const node = el('div', { class: `toast toast-${kind}`, text: message });
  host.append(node);
  setTimeout(() => node.classList.add('toast-out'), 3200);
  setTimeout(() => node.remove(), 3800);
}

/** Simple confirm dialog built in-page (no native confirm for styling/tests). */
/**
 * Copy text to the clipboard, resolving to whether it actually worked.
 *
 * The result is returned rather than thrown because a silent failure is worse
 * than an error here: someone copying a one-time password has to be able to
 * trust that it is on their clipboard, so the caller reports the outcome.
 */
export async function copyText(text) {
  const value = String(text ?? '');
  if (!value) return false;

  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // No permission, or not a secure context: try the legacy path below.
  }

  try {
    const area = el('textarea', { value, style: { position: 'fixed', top: '0', opacity: '0' } });
    document.body.append(area);
    area.select();
    const copied = document.execCommand?.('copy');
    area.remove();
    return Boolean(copied);
  } catch {
    return false;
  }
}

/**
 * A modal confirmation, built in-page.
 *
 * The parts that matter for a keyboard user are easy to omit and impossible to
 * notice when testing by hand: focus has to move into the dialog, stay inside it
 * while it is open, and return to the control that opened it on close. Escape
 * cancels, which is the near-universal expectation.
 */
export function confirmDialog(message, { confirmText = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const backdrop = el('div', { class: 'modal-backdrop' });
    const titleId = 'confirm-dialog-title';

    const cancelBtn = el('button', { class: 'btn', text: 'Cancel' });
    const confirmBtn = el('button', {
      class: danger ? 'btn btn-danger' : 'btn btn-primary',
      text: confirmText,
    });

    const dialog = el(
      'div',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      el('h3', { class: 'modal-title', id: titleId, text: message }),
      el('div', { class: 'modal-actions' }, cancelBtn, confirmBtn),
    );

    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      backdrop.remove();
      document.removeEventListener('keydown', onKeydown, true);
      // Returning focus is what stops a keyboard user being dumped at the top of
      // the document after confirming something.
      opener?.focus?.();
      resolve(value);
    };

    cancelBtn.addEventListener('click', () => close(false));
    confirmBtn.addEventListener('click', () => close(true));
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close(false);
    });

    function onKeydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(false);
        return;
      }
      if (event.key !== 'Tab') return;

      // Trap Tab inside the dialog. Without this, Tab walks out into the page
      // behind a modal that is visually covering it.
      const focusable = [...dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeydown, true);
    backdrop.append(dialog);
    document.body.append(backdrop);

    // Cancel first: it is the safe choice, so it is the one a reflex reaches.
    cancelBtn.focus();
  });
}