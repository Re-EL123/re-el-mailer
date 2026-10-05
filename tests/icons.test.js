// @vitest-environment jsdom
/**
 * Icon set tests.
 *
 * The emoji these replaced failed in ways no snapshot would have caught: they
 * rendered at different sizes per platform, ignored the theme's text colour, and
 * were announced as content. These assertions pin the properties that make an
 * icon correct — decorative to assistive tech, inheriting colour, valid SVG — and
 * one test greps the shipped views so an emoji cannot quietly come back.
 */

import { describe, expect, it } from 'vitest';

import { ICONS, icon, iconNames } from '../apps/web/js/icons.js';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const WEB = path.join(import.meta.dirname, '..', 'apps', 'web', 'js');

describe('icon()', () => {
  it('builds a real SVG element, not an HTML one', () => {
    const node = icon('star');
    expect(node.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(node.tagName.toLowerCase()).toBe('svg');
    expect(node.querySelectorAll('path').length).toBeGreaterThan(0);
  });

  it('is hidden from assistive technology by default', () => {
    // The wrapping button carries the name; without aria-hidden a screen reader
    // announces the path data after the label.
    expect(icon('star').getAttribute('aria-hidden')).toBe('true');
    expect(icon('star').getAttribute('focusable')).toBe('false');
  });

  it('inherits colour from its container instead of hard-coding one', () => {
    const node = icon('trash');
    expect(node.getAttribute('fill')).toBe('none');
    expect(node.getAttribute('stroke')).toBe('currentColor');
    for (const path of node.querySelectorAll('path')) {
      const stroke = path.getAttribute('stroke');
      if (stroke !== null) expect(stroke).toBe('currentColor');
    }
  });

  it('uses a stroke width of 2 so icons sit consistently on the grid', () => {
    expect(icon('back').getAttribute('stroke-width')).toBe('2');
    expect(icon('back', { strokeWidth: 1.5 }).getAttribute('stroke-width')).toBe('1.5');
  });

  it('sizes from the viewBox on a 24x24 grid', () => {
    expect(icon('back').getAttribute('viewBox')).toBe('0 0 24 24');
    expect(icon('back', { size: 20 }).getAttribute('width')).toBe('20');
    expect(icon('back', { size: 20 }).getAttribute('height')).toBe('20');
  });

  it('applies an optional class', () => {
    expect(icon('back', { class: 'x' }).getAttribute('class')).toBe('x');
    expect(icon('back').hasAttribute('class')).toBe(false);
  });

  it('throws on an unknown name rather than rendering nothing', () => {
    // A silent empty node would render an invisible button and be very hard to
    // find later, so this is deliberately loud.
    expect(() => icon('does-not-exist')).toThrow(/Unknown icon/);
  });
});

describe('the icon set', () => {
  it('draws every icon from defined path data', () => {
    for (const [name, shapes] of Object.entries(ICONS)) {
      expect(shapes.length, `${name} has shapes`).toBeGreaterThan(0);
      for (const shape of shapes) {
        expect(shape.d, `${name} shape has path data`).toMatch(/^[Mm]/);
        expect(shape.d).not.toMatch(/NaN|undefined/);
      }
    }
  });

  it('only uses round caps, so shapes stay on one optical weight', () => {
    for (const name of iconNames()) {
      const node = icon(name);
      expect(node.getAttribute('stroke-linecap'), name).toBe('round');
      expect(node.getAttribute('stroke-linejoin'), name).toBe('round');
    }
  });

  it('reserves filled paths to the variants that need a solid fill', () => {
    // starFilled and the theme toggle's lit half are solid by design; the tag's
    // punch hole is filled so it reads as a hole rather than a stray dot. Any
    // other filled path would break the outline look of the toolbar.
    const solid = iconNames().filter((name) =>
      icon(name).querySelectorAll('path[fill="currentColor"]').length > 0,
    );
    expect(solid.sort()).toEqual(['starFilled', 'tag', 'theme']);
  });
});

describe('the shipped views', () => {
  it('contain no emoji used as iconography', () => {
    // Covers pictographic ranges plus arrows and dingbats the toolbars used.
    // Written as a union of ranges rather than one class: the emoji
    // presentation selectors and variation selectors are combining characters,
    // and a character class containing them is a silent footgun.
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]|\u{FE0F}/u;
    const offenders = [];

    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.js')) continue;

        const source = readFileSync(full, 'utf8');
        // Strip comments: prose is allowed to mention the emoji it replaced.
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
        for (const [index, line] of code.split('\n').entries()) {
          if (!emoji.test(line)) continue;

          // The one sanctioned exception: keys.js prints ↑/↓ in the shortcut
          // reference, where the arrow *is* the content rather than a stand-in
          // for an icon.
          if (path.relative(WEB, full) === 'keys.js') continue;

          offenders.push(`${path.relative(WEB, full)}:${index + 1} ${line.trim()}`);
        }
      }
    };

    walk(WEB);
    expect(offenders).toEqual([]);
  });
});