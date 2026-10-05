/**
 * Keyboard shortcuts.
 *
 * The app had exactly one shortcut (Enter in the search box) and no way to
 * reach most actions without a pointer, which made it unusable with a keyboard
 * or a screen reader. This is a small layer over that: a global keydown
 * listener, a per-view context, and a chord buffer for two-key sequences.
 *
 * Deliberately hand-rolled rather than pulled in as a dependency. The whole
 * surface is a few hundred lines, and the hard part — never stealing a key from
 * a text field — is easier to get provably right and to test here than to
 * configure in a general-purpose library.
 *
 * Rules that matter, and are each covered by a test:
 *   • A shortcut never fires while focus is in a text field, a select, or a
 *     contenteditable (which includes the rich-text composer).
 *   • A shortcut never fires while a modifier other than the expected one is
 *     held, so browser and OS bindings keep working.
 *   • Views register and unregister handlers on render, so a handler for a view
 *     that is no longer on screen cannot fire.
 */

import { el } from './ui.js';
import { icon } from './icons.js';

const DEFAULT_CHORD_MS = 1200;

/** Layered scopes, last registered wins. Views push on render and pop on exit. */
const scopes = [];

/** Buffered first key of a two-key sequence, e.g. the `g` in `g` then `i`. */
let chord = null;
let chordTimer = null;
let installed = false;
let helpOpen = null;

/**
 * Is the user typing?
 *
 * Anything text-entry-shaped counts, including contenteditable (the composer)
 * and the sandboxed reader iframe, which jsdom and real browsers both report
 * with isContentEditable.
 */
export function isTypingTarget(target) {
  if (!target || typeof target !== 'object') return false;

  // A focused element inside an iframe reports as the iframe's document body.
  if (target.tagName === 'BODY' && target.ownerDocument !== document) return true;

  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    // Buttons and checkboxes are inputs but are never typed into.
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'image', 'file'].includes(
      target.type,
    );
  }
  if (target.isContentEditable) return true;
  if (target.closest?.('[contenteditable="true"], [contenteditable=""]')) return true;

  // A shortcut is meaningless while a dialog is up, except the ones a dialog
  // handles itself (Escape, and ? to close the help).
  if (target.closest?.('[role="dialog"], dialog[open]')) return true;
  return false;
}

/**
 * Normalise a KeyboardEvent into a match key.
 * @returns {string} e.g. 'j', 'shift+?', 'mod+k', 'escape'
 */
export function eventKey(event) {
  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push('mod');
  if (event.altKey) parts.push('alt');
  // Shift only distinguishes a printable *letter or digit*. Shift+ArrowDown is
  // still "down", and punctuation arrives in its shifted form already: '?' is
  // reported as '?' with shiftKey true, not as '/' with shift, so adding a shift
  // prefix there would make the same key match two different specs.
  if (event.shiftKey && /^[a-z0-9]$/i.test(event.key)) parts.push('shift');

  let key = event.key;
  if (key === ' ') key = 'space';
  else if (key === 'Escape') key = 'escape';
  else if (key === 'Enter') key = 'enter';
  else if (key === 'Backspace') key = 'backspace';
  else if (key === 'ArrowUp') key = 'up';
  else if (key === 'ArrowDown') key = 'down';
  else if (key === 'ArrowLeft') key = 'left';
  else if (key === 'ArrowRight') key = 'right';
  else if (key === '/') key = 'slash';
  else if (key === '?') key = 'question';
  else if (key === '#') key = 'hash';
  else key = key.toLowerCase();

  parts.push(key);
  return parts.join('+');
}

/**
 * Register shortcuts for a view.
 *
 * @param {string} scope Name for diagnostics, e.g. 'mail-list'.
 * @param {Record<string, Function>} map Key spec to handler. A key spec may be a
 *   two-key sequence written as 'g i'; its handler receives the event.
 * @returns {() => void} Call on teardown to remove this scope.
 */
export function pushShortcuts(scope, map) {
  const entry = { scope, map };
  scopes.push(entry);
  return () => {
    const index = scopes.indexOf(entry);
    if (index >= 0) scopes.splice(index, 1);
  };
}

/** Look up a single-key binding across the active scopes. */
function lookup(key) {
  for (let i = scopes.length - 1; i >= 0; i -= 1) {
    const handler = scopes[i].map[key];
    if (handler) return handler;
  }
  return null;
}

function clearChord() {
  chord = null;
  if (chordTimer) {
    clearTimeout(chordTimer);
    chordTimer = null;
  }
}

/**
 * Resolve an event to a handler and invoke it.
 *
 * Returns the key that was handled, or null. Exported so tests can drive it
 * directly instead of synthesizing trusted events.
 */
export function handleKey(event) {
  // Escape has to work everywhere: it is what closes a dialog, and it is the
  // documented way out of the help sheet.
  const raw = eventKey(event);

  if (helpOpen && (raw === 'escape' || raw === 'question' || raw === 'shift+slash')) {
    event.preventDefault?.();
    closeHelp();
    return raw;
  }

  if (isTypingTarget(event.target)) return null;

  // Anything with a modifier that is not part of the binding belongs to the
  // browser or the OS: leave it alone.
  const mod = raw.startsWith('mod+');
  const hasUnexpectedModifier =
    (!mod && (event.ctrlKey || event.metaKey || event.altKey)) || (mod && event.altKey);

  if (!hasUnexpectedModifier) {
    const single = raw.replace(/^(mod\+|alt\+|shift\+)/, '');
    const chordKey = chord ? `${chord} ${single}` : null;

    if (chordKey) {
      const chained = lookup(chordKey);
      clearChord();
      if (chained) {
        event.preventDefault?.();
        chained(event);
        return chordKey;
      }
    }

    const direct = lookup(raw);
    if (direct) {
      event.preventDefault?.();
      direct(event);
      return raw;
    }

    // Buffer the first key of any two-key sequence, so `g` waits for `i`.
    if (lookup(`${single} enter`) || hasAnyChordStartingWith(single)) {
      chord = single;
      if (chordTimer) clearTimeout(chordTimer);
      chordTimer = setTimeout(clearChord, DEFAULT_CHORD_MS);
    }
  }

  return null;
}

function hasAnyChordStartingWith(first) {
  for (const entry of scopes) {
    for (const spec of Object.keys(entry.map)) {
      if (spec.includes(' ') && spec.startsWith(`${first} `)) return true;
    }
  }
  return false;
}

/** Attach the listener once. Safe to call repeatedly. */
export function installShortcuts(target = window) {
  if (installed) return;
  installed = true;
  target.addEventListener('keydown', handleKey);
}

/** Remove the listener and drop every registered scope. Used by tests. */
export function uninstallShortcuts() {
  scopes.length = 0;
  clearChord();
  helpOpen?.remove();
  helpOpen = null;
}

/** Shortcut reference data, shared by the help sheet and its test. */
export const SHORTCUTS = [
  { group: 'Anywhere', keys: [['?'], ['c'], ['/'], ['g i'], ['g s'], ['g a'], ['g t'], ['g d'], ['Escape']] },
  { group: 'Message list', keys: [['j', '↓'], ['k', '↑'], ['x'], ['e'], ['#'], ['s'], ['u'], ['Enter']] },
  { group: 'Reading pane', keys: [['r'], ['a'], ['f'], ['s'], ['#'], ['u']] },
];

function renderKeys(keys) {
  return keys.map((key) => el('kbd', { text: key }));
}

/** Open the shortcut sheet. Opens the sheet for `?`; toggles if already open. */
export function toggleShortcutHelp() {
  if (helpOpen) {
    closeHelp();
    return false;
  }

  const backdrop = el('div', { class: 'modal-backdrop', id: 'shortcut-help' });
  const dialog = el(
    'div',
    {
      class: 'modal modal-wide',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'shortcut-help-title',
      tabindex: '-1',
    },
    el(
      'div',
      { class: 'modal-head' },
      el('h2', { class: 'modal-title', id: 'shortcut-help-title' }, icon('keyboard', { size: 18 }), el('span', { text: 'Keyboard shortcuts' })),
      el('button', {
        class: 'icon-btn',
        'aria-label': 'Close keyboard shortcuts',
        onClick: () => closeHelp(),
      }, icon('close')),
    ),
    el(
      'div',
      { class: 'shortcut-cols' },
      ...SHORTCUTS.map((section) =>
        el(
          'section',
          { class: 'shortcut-group' },
          el('h3', { class: 'shortcut-group-title', text: section.group }),
          el(
            'dl',
            { class: 'shortcut-list' },
            ...section.keys.map((keys) => [
              el('dt', {}, ...renderKeys(keys)),
              el('dd', { text: describe(keys) }),
            ]),
          ),
        ),
      ),
    ),
  );

  backdrop.append(dialog);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) closeHelp();
  });

  document.body.append(backdrop);
  helpOpen = backdrop;
  dialog.focus();
  return true;
}

const DESCRIPTIONS = {
  j: 'Next message',
  k: 'Previous message',
  x: 'Select message',
  e: 'Archive message',
  '#': 'Move to trash',
  s: 'Toggle star',
  u: 'Mark unread, or go back',
  Enter: 'Open message',
  r: 'Reply',
  a: 'Reply all',
  f: 'Forward',
  c: 'Compose',
  '/': 'Search mail',
  '?': 'This help',
  Escape: 'Close dialog',
  'g i': 'Go to inbox',
  'g s': 'Go to starred',
  'g a': 'Go to archive',
  'g t': 'Go to trash',
  'g d': 'Go to drafts',
};

function describe(keys) {
  // A two-key chord is one entry ('g i'); an arrow variant lists the canonical
  // key first ('j', '↓'), so either way the lookup key is the first element.
  return DESCRIPTIONS[keys[0]] || '—';
}

export function closeHelp() {
  helpOpen?.remove();
  helpOpen = null;
}

/** Current chord buffer, for tests. */
export function pendingChord() {
  return chord;
}