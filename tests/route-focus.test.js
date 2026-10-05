// @vitest-environment jsdom
/**
 * Post-navigation focus.
 *
 * The router moves focus after every route change so that a keyboard or screen
 * reader user is not left focused on a link that no longer exists. The subtlety
 * this file pins down is that a heading is not focusable by default: calling
 * focus() on one is silently a no-op, so the router has to make it a
 * programmatic focus target first, without putting it back in the tab order.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { moveFocusToView } from '../apps/web/js/router.js';

function view(html) {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.append(container);
  return container;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('moveFocusToView', () => {
  it('focuses the view heading and makes it programmatically focusable', () => {
    const container = view('<h2>Label</h2>');

    moveFocusToView(container);

    const heading = container.querySelector('h2');
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(heading);
  });

  it('keeps the heading out of the tab order', () => {
    // tabindex="-1" is focusable programmatically and unreachable by Tab, which
    // is exactly what a route change wants: announced, but not a tab stop in the
    // middle of the document.
    const container = view('<h2>Label</h2>');

    moveFocusToView(container);

    expect(container.querySelector('h2').tabIndex).toBe(-1);
  });

  it('respects a tabindex the view chose itself', () => {
    const container = view('<h2 tabindex="0">Label</h2>');

    moveFocusToView(container);

    expect(container.querySelector('h2').getAttribute('tabindex')).toBe('0');
    expect(document.activeElement).toBe(container.querySelector('h2'));
  });

  it('takes the first heading in document order', () => {
    // Document order, not selector order: the first heading is the one that
    // labels the region, and a view that puts an h2 above its h1 has asked for
    // that h2 to be read first.
    const container = view('<h2>Section</h2><h1>Label</h1>');

    moveFocusToView(container);

    expect(document.activeElement).toBe(container.querySelector('h2'));
  });

  it('falls back to the container when the view has no heading', () => {
    const container = view('<p>No heading here.</p>');

    moveFocusToView(container);

    expect(container.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(container);
  });

  it('ignores a container that is not in the document', () => {
    const container = document.createElement('div');
    container.innerHTML = '<h2>Detached</h2>';

    expect(() => moveFocusToView(container)).not.toThrow();
    expect(container.querySelector('h2').hasAttribute('tabindex')).toBe(false);
  });

  it('ignores a missing container', () => {
    expect(() => moveFocusToView(null)).not.toThrow();
  });
});