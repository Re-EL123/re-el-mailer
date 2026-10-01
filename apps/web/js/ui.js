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

/** Relative time: "now", "4m", "3h", "2d", else a date. */
export function relTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function fullDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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

/** Show a transient toast. */
export function toast(message, kind = 'info') {
  let host = qs('#toasts');
  if (!host) {
    host = el('div', { id: 'toasts', class: 'toasts' });
    document.body.append(host);
  }
  const node = el('div', { class: `toast toast-${kind}`, text: message, role: 'status' });
  host.append(node);
  setTimeout(() => node.classList.add('toast-out'), 3200);
  setTimeout(() => node.remove(), 3800);
}

/** Simple confirm dialog built in-page (no native confirm for styling/tests). */
export function confirmDialog(message, { confirmText = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const close = (value) => {
      backdrop.remove();
      resolve(value);
    };
    backdrop.append(
      el(
        'div',
        { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        el('h3', { class: 'modal-title', text: message }),
        el(
          'div',
          { class: 'modal-actions' },
          el('button', { class: 'btn', onClick: () => close(false), text: 'Cancel' }),
          el('button', {
            class: danger ? 'btn btn-danger' : 'btn btn-primary',
            onClick: () => close(true),
            text: confirmText,
          }),
        ),
      ),
    );
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close(false);
    });
    document.body.append(backdrop);
  });
}