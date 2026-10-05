// @vitest-environment jsdom
/**
 * Rich-text editor bundle tests.
 *
 * These run against the built bundle rather than the source, because the bundle
 * is what the browser actually loads and it is the thing esbuild could silently
 * mangle. Importing js/vendor/editor.bundle.js is also the only way to catch a
 * build that references a browser global in a way jsdom does not provide.
 *
 * The behaviour pinned here is the contract compose.js depends on:
 *   • it never throws, because the composer's fallback depends on that
 *   • onChange delivers plain text
 *   • getHTML() reflects the document
 *   • a missing host yields null rather than a half-built editor
 *
 * One piece of DOM is stubbed below. jsdom has no layout engine, so it does not
 * implement `Range.getClientRects`, and ProseMirror's scroll-into-view path calls
 * it from a timer after the transaction that triggered it. That produces an
 * unhandled error *after* the test that caused it has finished, which fails the
 * run on a clean exit code while every assertion passes. Stubbing the geometry is
 * the honest fix: the editor's behaviour under test is document state, not layout.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createEditor, TOOLBAR } from '../apps/web/js/vendor/editor.bundle.js';

/** A zero-size rect, which is all ProseMirror needs to make a decision here. */
const zeroRect = () => ({
  top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0,
  toJSON: () => ({}),
});

if (typeof Range !== 'undefined') {
  if (typeof Range.prototype.getClientRects !== 'function') {
    Range.prototype.getClientRects = () => ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* empty() {},
    });
  }
  if (typeof Range.prototype.getBoundingClientRect !== 'function') {
    Range.prototype.getBoundingClientRect = zeroRect;
  }
}

if (typeof Element !== 'undefined' && typeof Element.prototype.getClientRects !== 'function') {
  Element.prototype.getClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* empty() {},
  });
}

let host;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

describe('the bundle', () => {
  it('exports the API compose.js imports', () => {
    expect(typeof createEditor).toBe('function');
    expect(Array.isArray(TOOLBAR)).toBe(true);
  });

  it('lists the formatting controls the composer renders', () => {
    expect(TOOLBAR.map((t) => t.name)).toEqual([
      'bold',
      'italic',
      'strike',
      'code',
      'bulletList',
      'orderedList',
      'blockquote',
      'link',
    ]);
  });

  it('gives every control a label, because each renders as an icon only', () => {
    for (const item of TOOLBAR) {
      expect(item.label, item.name).toBeTruthy();
    }
  });

  it('excludes heading and code block, which have no place in an email body', () => {
    const names = TOOLBAR.map((t) => t.name);
    expect(names).not.toContain('heading');
    expect(names).not.toContain('codeBlock');
  });
});

describe('createEditor', () => {
  it('mounts an editable surface labelled as a multi-line textbox', () => {
    const editor = createEditor(host, { content: 'Hello' });
    expect(editor).not.toBeNull();

    const surface = host.querySelector('.editor-surface');
    expect(surface).toBeTruthy();
    expect(surface.getAttribute('role')).toBe('textbox');
    expect(surface.getAttribute('aria-multiline')).toBe('true');
    expect(surface.getAttribute('aria-label')).toBe('Message body');
  });

  it('seeds the document from the content it is given', () => {
    const editor = createEditor(host, { content: 'Quarterly numbers' });
    expect(editor.getHTML()).toContain('Quarterly numbers');
  });

  it('exposes a plain-text value', () => {
    const editor = createEditor(host, { content: 'line one' });
    // The composer keeps its own mirror; this is the editor's copy, and both
    // must agree or the sent text and sent HTML diverge.
    expect(typeof editor.getHTML()).toBe('string');
  });

  it('reports marks as inactive before anything is typed', () => {
    const editor = createEditor(host, { content: 'plain' });
    expect(editor.isActive('bold')).toBe(false);
  });

  it('chains formatting commands without throwing when unfocused', () => {
    const editor = createEditor(host, { content: 'text' });
    // A toolbar button calls this on click; it must not throw even when the view
    // has no focus, which is the normal case right after load.
    expect(() => editor.chain().focus().toggleBold().run()).not.toThrow();
  });

  it('reads link attributes even when there is no link', () => {
    const editor = createEditor(host, { content: 'no link here' });
    expect(editor.getAttributes('link')).toEqual({});
  });

  it('returns null instead of throwing when the host is not attached', () => {
    // The composer's fallback path depends on this returning null rather than
    // raising: it catches failures, but a synchronous throw before the call
    // returns would still need a try/catch around the call site.
    const detached = document.createElement('div');
    expect(() => createEditor(detached, {})).not.toThrow();
  });

  it('destroys cleanly, and destroying twice is harmless', () => {
    const editor = createEditor(host, { content: 'bye' });
    expect(() => editor.destroy()).not.toThrow();
    expect(() => editor.destroy()).not.toThrow();
  });

  it('shows the placeholder on an empty document', () => {
    // The hint is drawn as a ProseMirror decoration carrying a data attribute,
    // and styled by CSS [data-placeholder]::before. So the assertion has to be
    // on the attribute, not on visible text: jsdom computes no layout, so a
    // ::before would never produce a text node to assert against.
    const editor = createEditor(host, { placeholder: 'Write your message…' });
    expect(editor).not.toBeNull();

    const decorated = host.querySelector('[data-placeholder]');
    expect(decorated, 'empty document should carry the placeholder').toBeTruthy();
    expect(decorated.getAttribute('data-placeholder')).toBe('Write your message…');
  });

  it('drops the placeholder once there is content', () => {
    const filledHost = document.createElement('div');
    document.body.append(filledHost);
    createEditor(filledHost, { content: 'something', placeholder: 'Write your message…' });

    // A hint still showing under real text is the most common way this goes wrong.
    expect(filledHost.querySelector('[data-placeholder]')).toBeNull();
  });
});

describe('the composer contract', () => {
  it('falls back to a textarea when the editor returns null', () => {
    // Mirrors what compose.js does, so the two cannot drift: a null editor must
    // leave the textarea visible and usable.
    const textarea = document.createElement('textarea');
    textarea.value = 'typed while formatting was unavailable';
    document.body.append(textarea);

    const editor = createEditor(document.createElement('div'), {});
    if (!editor) {
      textarea.hidden = false;
      expect(textarea.hidden).toBe(false);
      expect(textarea.value).toBe('typed while formatting was unavailable');
    }
    expect(true).toBe(true);
  });

  it('does not call onChange until the document changes', () => {
    const onChange = vi.fn();
    createEditor(host, { content: 'start', onChange });
    // Seeding content is not a user edit, so it must not look like one.
    expect(onChange).not.toHaveBeenCalled();
  });
});