// @vitest-environment jsdom
/**
 * The signed-in shell.
 *
 * The shell is assembled by app.js rather than exported as a component, so these
 * tests boot the real entry point against a stubbed network and assert on the
 * DOM it produces. That is the only way to catch the class of bug the skip link
 * used to be: the app routes on the hash fragment, so any in-page anchor in the
 * chrome is a navigation unless something stops it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

import {
  defaultRoutes,
  resetDom,
  stubApi,
  waitFor,
} from './helpers/view-harness.js';

/** The container index.html provides, since app.js mounts into it by id. */
function documentShell() {
  document.body.innerHTML = '<div id="root"></div>';
}

/** Boot app.js for real: stub the network, fire DOMContentLoaded, wait for boot. */
async function bootApp(routes = {}) {
  vi.resetModules();
  const api = stubApi(defaultRoutes(routes));
  documentShell();
  await import('../apps/web/js/app.js');
  document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await waitFor('.skip-link');
  return api;
}

beforeEach(() => {
  resetDom();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('skip link', () => {
  it('is the first focusable element in the shell', async () => {
    await bootApp();

    const skip = document.querySelector('.skip-link');
    const focusable = [...document.querySelectorAll(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )];

    expect(skip.textContent).toBe('Skip to mail');
    expect(focusable[0]).toBe(skip);
  });

  it('stays off-screen until focused, so it never shifts the layout', async () => {
    await bootApp();

    // Asserted against the stylesheet source rather than jsdom's computed style,
    // which does not resolve an external stylesheet. The regression this guards
    // is a skip link that becomes permanently visible and pushes the whole shell
    // down 60px — the usual outcome of dropping the offset without the :focus
    // rule.
    const css = fs.readFileSync(path.join(ROOT, 'apps', 'web', 'css', 'app.css'), 'utf8');
    const rule = css.match(/\.skip-link\s*\{([^}]*)\}/)?.[1] ?? '';
    const focusRule = css.match(/\.skip-link:focus\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).toMatch(/top:\s*-\d/);
    expect(focusRule).toMatch(/top:\s*\d/);
  });

  it('does not navigate: activating it leaves the route and the URL alone', async () => {
    const api = await bootApp();

    // Settle on the inbox first, the way boot() does for a signed-in user.
    await waitFor('.msg-row');
    const hashBefore = window.location.hash;
    expect(hashBefore).toMatch(/inbox/);

    const skip = document.querySelector('.skip-link');
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    skip.dispatchEvent(event);

    // preventDefault is the whole point: without it the hash becomes
    // "#main-view", which the router reads as a route named "main-view" and
    // resolves to the default route, silently throwing the user out of the page
    // they were on.
    expect(event.defaultPrevented).toBe(true);
    expect(window.location.hash).toBe(hashBefore);

    // No re-render: the inbox is still there and no extra list request went out.
    const callsAfter = api.calls.length;
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(api.calls).toHaveLength(callsAfter);
    expect(document.querySelector('.msg-row')).not.toBeNull();
  });

  it('moves focus to the main landmark', async () => {
    await bootApp();
    await waitFor('.msg-row');

    document.querySelector('.skip-link').dispatchEvent(
      new window.MouseEvent('click', { bubbles: true, cancelable: true }),
    );

    const main = document.querySelector('#main-view');
    expect(document.activeElement).toBe(main);
    // Focusable without adding a tab stop.
    expect(main.tabIndex).toBe(-1);
    expect(main.tagName).toBe('MAIN');
  });

  it('points at a target that exists, and it is the main landmark', async () => {
    await bootApp();

    const href = document.querySelector('.skip-link').getAttribute('href');
    expect(href).toBe('#main-view');
    expect(document.querySelector(href).tagName).toBe('MAIN');
    expect(document.querySelectorAll('main')).toHaveLength(1);
  });
});

describe('shell chrome', () => {
  it('labels the main landmark', async () => {
    await bootApp();

    const main = document.querySelector('#main-view');
    expect(main.getAttribute('aria-label')).toBe('Mail');
  });

  it('gives every icon-only control an accessible name', async () => {
    await bootApp();
    await waitFor('.msg-row');

    // No icon may rely on a title attribute alone: `title` is not announced
    // reliably on a link, and the settings/admin links are links.
    const nameless = [...document.querySelectorAll('.topbar-right a, .topbar-right button')]
      .filter((node) => !(node.getAttribute('aria-label') || node.textContent.trim()));

    expect(nameless).toEqual([]);
  });

it('ships no emoji in the chrome', async () => {
    await bootApp();
    await waitFor('.msg-row');

    // Asserted that the region was actually found first: an empty node list
    // would pass this test for the wrong reason.
    expect(document.querySelector('.topbar')).not.toBeNull();
    expect(document.querySelector('.skip-link')).not.toBeNull();

    // The ranges must sit inside one character class. As a union of
    // `(?:\u{1F300}-\u{1FAFF})` groups each side is a separate literal, so the
    // pattern matches nothing. The variation selector stays outside the class
    // because it is a combining mark.
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]|\u{FE0F}/u;

    const offenders = [...document.querySelectorAll('.topbar, .skip-link')]
      .filter((node) => emoji.test(node.textContent));

    expect(offenders).toEqual([]);
  });
});

describe('notifications bell', () => {
  const notes = {
    // Count first: its URL contains the substring the list pattern also matches.
    'action=notifications-count': { unread: 2 },
    'action=notifications-read': { read: 2 },
    'action=notifications': {
      unread: 2,
      notifications: [
        { id: 'ntf_1', kind: 'assigned', title: 'You were assigned a message', body: 'Quarterly numbers', entityType: 'message', entityId: 'msg_1', isRead: false, createdAt: new Date().toISOString() },
        { id: 'ntf_2', kind: 'mention', title: 'New mention', body: 'Hi', isRead: true, createdAt: new Date().toISOString() },
      ],
    },
  };

  it('shows the unread count on the bell', async () => {
    await bootApp(notes);
    const badge = await waitFor('.notif-badge');

    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('2');
    expect(document.querySelector('.notif-btn').getAttribute('aria-label')).toContain('2 unread');
  });

  it('hides the badge when there is nothing unread', async () => {
    await bootApp({ 'action=notifications-count': { unread: 0 } });
    await waitFor('.notif-btn');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(document.querySelector('.notif-badge').hidden).toBe(true);
  });

  it('opens a panel and lists the notifications', async () => {
    await bootApp(notes);
    await waitFor('.notif-btn');

    document.querySelector('.notif-btn').click();
    await waitFor('.notif-item');

    const items = document.querySelectorAll('.notif-item');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('You were assigned a message');
    expect(items[0].classList.contains('unread')).toBe(true);
  });

  it('marks everything read when asked', async () => {
    let read = false;
    const api = await bootApp({
      'action=notifications-count': () => ({ unread: read ? 0 : 2 }),
      'action=notifications-read': () => {
        read = true;
        return { read: 2 };
      },
      'action=notifications': () => ({
        unread: read ? 0 : 2,
        notifications: [
          { id: 'ntf_1', kind: 'assigned', title: 'You were assigned a message', isRead: read, createdAt: new Date().toISOString() },
        ],
      }),
    });
    await waitFor('.notif-btn');

    document.querySelector('.notif-btn').click();
    await waitFor('.notif-item');

    const markAll = [...document.querySelectorAll('.notif-panel button')].find((b) => b.textContent === 'Mark all read');
    markAll.click();
    await vi.waitFor(() => expect(api.calls.some((url) => url.includes('action=notifications-read'))).toBe(true));

    await vi.waitFor(() => expect(document.querySelector('.notif-badge').hidden).toBe(true));
  });
});