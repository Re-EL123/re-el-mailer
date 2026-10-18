/**
 * The theme's relationship with the browser's own controls.
 *
 * `color-scheme` decides the palette the browser paints for controls it draws
 * itself — buttons, checkboxes, select popups, scrollbars. It has to follow the
 * app's [data-theme], not `prefers-color-scheme`: a user whose OS is dark but
 * whose mail theme is light otherwise gets dark native controls (white glyphs)
 * on the light surface behind them. That is exactly how the admin tabs came out
 * white-on-white, and it cannot be caught in jsdom, which resolves no UA
 * stylesheets — so it is asserted against the CSS source.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(ROOT, 'apps', 'web', 'css', 'app.css'), 'utf8');

/** The declarations inside the first rule whose selector matches `selector`. */
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('color-scheme follows the app theme', () => {
  it('declares a light scheme on the root', () => {
    expect(rule(':root')).toMatch(/color-scheme:\s*light/);
  });

  it('switches to a dark scheme with the dark theme', () => {
    expect(rule("[data-theme='dark']")).toMatch(/color-scheme:\s*dark/);
  });
});

describe('buttons that the browser draws itself', () => {
  it('give the admin tabs an explicit text colour', () => {
    // Without this they fall back to the UA ButtonText colour, which the
    // color-scheme fix handles — but an explicit value keeps them legible even
    // if the theme attribute has not been applied yet.
    expect(rule('.admin-tab-btn')).toMatch(/color:\s*var\(--text\)/);
  });
});
