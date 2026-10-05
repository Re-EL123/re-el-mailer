// @vitest-environment jsdom
/**
 * Keyboard shortcut tests.
 *
 * The failure these guard against is the one that makes an app feel broken for
 * keyboard users: a global listener swallowing a keystroke that belonged to a
 * text field. So most of the file is about what must NOT fire, and the positive
 * cases are the ones that would be easy to break silently.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeHelp,
  eventKey,
  handleKey,
  installShortcuts,
  isTypingTarget,
  pendingChord,
  pushShortcuts,
  toggleShortcutHelp,
  uninstallShortcuts,
} from '../apps/web/js/keys.js';

beforeEach(() => {
  document.body.innerHTML = '';
  installShortcuts();
});

afterEach(() => {
  uninstallShortcuts();
  closeHelp();
});

/** A synthetic event shaped like the ones handleKey reads. */
function key(name, { target = document.body, ...rest } = {}) {
  const event = {
    key: name,
    target,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...rest,
  };
  return event;
}

describe('isTypingTarget', () => {
  it('recognises every text-entry element', () => {
    const input = document.createElement('input');
    const area = document.createElement('textarea');
    const select = document.createElement('select');
    document.body.append(input, area, select);

    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(area)).toBe(true);
    expect(isTypingTarget(select)).toBe(true);
  });

  it('does not treat buttons and checkboxes as typing', () => {
    // These are inputs by tag name but nothing is typed into them, so a shortcut
    // must still fire while one has focus.
    for (const type of ['button', 'checkbox', 'radio', 'submit', 'file']) {
      const node = document.createElement('input');
      node.type = type;
      expect(isTypingTarget(node), type).toBe(false);
    }
  });

  it('recognises a contenteditable composer', () => {
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const child = document.createElement('span');
    editor.append(child);
    document.body.append(editor);

    expect(isTypingTarget(editor)).toBe(true);
    expect(isTypingTarget(child)).toBe(true);
  });

  it('treats a body inside another document as typing', () => {
    // A focused element in the sandboxed reader iframe surfaces as that
    // iframe's document body; hijacking those keys would break mail reading.
    const other = document.implementation.createHTMLDocument('frame');
    expect(isTypingTarget(other.body)).toBe(true);
  });

  it('treats focus inside a dialog as typing', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const button = document.createElement('button');
    dialog.append(button);
    document.body.append(dialog);

    expect(isTypingTarget(button)).toBe(true);
  });

  it('is false for ordinary buttons and links', () => {
    const button = document.createElement('button');
    const link = document.createElement('a');
    document.body.append(button, link);
    expect(isTypingTarget(button)).toBe(false);
    expect(isTypingTarget(link)).toBe(false);
  });
});

describe('eventKey', () => {
  it('normalises single characters to lowercase', () => {
    expect(eventKey({ key: 'J' })).toBe('j');
  });

  it('collapses ctrl and meta into one modifier', () => {
    expect(eventKey({ key: 'k', ctrlKey: true })).toBe('mod+k');
    expect(eventKey({ key: 'k', metaKey: true })).toBe('mod+k');
  });

  it('gives punctuation stable names', () => {
    expect(eventKey({ key: '/' })).toBe('slash');
    // '?' arrives already shifted, so it needs no shift prefix of its own.
    expect(eventKey({ key: '?', shiftKey: true })).toBe('question');
    expect(eventKey({ key: '#' })).toBe('hash');
  });

  it('names the keys it moves focus with', () => {
    expect(eventKey({ key: 'Escape' })).toBe('escape');
    expect(eventKey({ key: 'Enter' })).toBe('enter');
    expect(eventKey({ key: 'ArrowDown' })).toBe('down');
    expect(eventKey({ key: ' ' })).toBe('space');
  });

  it('keeps shift for printable keys but not for named ones', () => {
    // Shift+ArrowDown is still "down"; Shift+A is "shift+a".
    expect(eventKey({ key: 'ArrowDown', shiftKey: true })).toBe('down');
    expect(eventKey({ key: 'A', shiftKey: true })).toBe('shift+a');
  });
});

describe('shortcut dispatch', () => {
  it('runs a registered handler', () => {
    const onJ = vi.fn();
    pushShortcuts('test', { j: onJ });

    const event = key('j');
    expect(handleKey(event)).toBe('j');
    expect(onJ).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('never fires while a text field has focus', () => {
    const onJ = vi.fn();
    pushShortcuts('test', { j: onJ });

    const input = document.createElement('input');
    document.body.append(input);

    expect(handleKey(key('j', { target: input }))).toBeNull();
    expect(onJ).not.toHaveBeenCalled();
  });

  it('still fires for a checkbox, which is an input but not typed into', () => {
    const onJ = vi.fn();
    pushShortcuts('test', { j: onJ });

    const box = document.createElement('input');
    box.type = 'checkbox';
    document.body.append(box);

    handleKey(key('j', { target: box }));
    expect(onJ).toHaveBeenCalledOnce();
  });

  it('leaves browser and OS bindings alone', () => {
    const onJ = vi.fn();
    pushShortcuts('test', { j: onJ });

    // Ctrl+J is "download page" in most browsers and must reach the browser.
    expect(handleKey(key('j', { ctrlKey: true }))).toBeNull();
    expect(handleKey(key('j', { metaKey: true }))).toBeNull();
    expect(handleKey(key('j', { altKey: true }))).toBeNull();
    expect(onJ).not.toHaveBeenCalled();
  });

  it('does not fire a bare key while mod is held for a mod binding', () => {
    const onMod = vi.fn();
    pushShortcuts('test', { 'mod+k': onMod });

    handleKey(key('k', { ctrlKey: true }));
    expect(onMod).toHaveBeenCalledOnce();

    onMod.mockClear();
    handleKey(key('k', { metaKey: true, altKey: true }));
    expect(onMod).not.toHaveBeenCalled();
  });

  it('gives the innermost scope priority, and falls back when it is popped', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    pushShortcuts('outer', { j: outer });
    const popInner = pushShortcuts('inner', { j: inner });

    handleKey(key('j'));
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();

    // Once the view that owned the inner scope is torn down, the outer scope is
    // reachable again rather than the shortcut going dead.
    popInner();
    handleKey(key('j'));
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).toHaveBeenCalledOnce();
  });

  it('stops firing once a view unregisters', () => {
    const onJ = vi.fn();
    const pop = pushShortcuts('test', { j: onJ });

    handleKey(key('j'));
    pop();
    handleKey(key('j'));

    expect(onJ).toHaveBeenCalledOnce();
  });

  it('does not fire the same binding twice when both an outer and inner scope have it', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    pushShortcuts('outer', { j: outer });
    pushShortcuts('inner', { j: inner });

    handleKey(key('j'));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).toHaveBeenCalledTimes(0);
  });
});

describe('two-key chords', () => {
  it('buffers the first key and fires on the second', () => {
    const onInbox = vi.fn();
    pushShortcuts('test', { 'g i': onInbox });

    handleKey(key('g'));
    expect(onInbox).not.toHaveBeenCalled();
    expect(pendingChord()).toBe('g');

    handleKey(key('i'));
    expect(onInbox).toHaveBeenCalledOnce();
    expect(pendingChord()).toBeNull();
  });

  it('clears the buffer when the second key does not complete the sequence', () => {
    const onInbox = vi.fn();
    const onArchive = vi.fn();
    pushShortcuts('test', { 'g i': onInbox, 'g a': onArchive });

    handleKey(key('g'));
    handleKey(key('z'));

    expect(onInbox).not.toHaveBeenCalled();
    expect(onArchive).not.toHaveBeenCalled();
    expect(pendingChord()).toBeNull();
  });

  it('does not buffer a key that starts no sequence', () => {
    pushShortcuts('test', { 'g i': vi.fn() });

    handleKey(key('x'));
    expect(pendingChord()).toBeNull();
  });

  it('does not buffer while typing', () => {
    pushShortcuts('test', { 'g i': vi.fn() });
    const input = document.createElement('input');
    document.body.append(input);

    handleKey(key('g', { target: input }));
    expect(pendingChord()).toBeNull();
  });
});

describe('the help sheet', () => {
  it('opens, is a labelled modal, and closes on Escape', () => {
    expect(toggleShortcutHelp()).toBe(true);

    const dialog = document.querySelector('#shortcut-help [role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    // Focus must land inside the dialog or a keyboard user is still behind it.
    expect(dialog.contains(document.activeElement) || document.activeElement === dialog).toBe(true);

    handleKey(key('Escape'));
    expect(document.querySelector('#shortcut-help')).toBeNull();
  });

  it('closes when the same shortcut is pressed again', () => {
    toggleShortcutHelp();
    expect(toggleShortcutHelp()).toBe(false);
    expect(document.querySelector('#shortcut-help')).toBeNull();
  });

  it('closes on backdrop click', () => {
    toggleShortcutHelp();
    document.querySelector('#shortcut-help').click();
    expect(document.querySelector('#shortcut-help')).toBeNull();
  });

  it('renders every advertised shortcut, so the sheet cannot drift from the code', () => {
    toggleShortcutHelp();
    const text = document.querySelector('#shortcut-help').textContent;

    for (const label of ['Next message', 'Compose', 'Reply', 'Search mail', 'Go to inbox']) {
      expect(text, label).toContain(label);
    }
  });
});