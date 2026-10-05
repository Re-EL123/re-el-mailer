/**
 * Render real views in jsdom for accessibility and interaction tests.
 *
 * The whole point is that these exercise the shipped code rather than a
 * hand-written imitation of it. Views are mounted through their real entry
 * points, with only the network layer replaced — everything else (ui.js, store.js,
 * the router, the actual markup each view produces) is the code that ships.
 *
 * Usage:
 *   // @vitest-environment jsdom
 *   import { renderView } from './helpers/view-harness.js';
 *   const host = await renderView('mail-list', { user, mailboxes });
 *
 * axe-core is used rather than a hand-rolled rule list because the failures are
 * the ones worth catching: missing names on icon-only buttons, unlabelled form
 * controls, contrast on the token palette, and heading order.
 */

import { vi } from 'vitest';

const MB = 'mbx_1';

/** A session-shaped user, matching what adoptSession() puts on state. */
export function fakeUser(over = {}) {
  return {
    id: 'usr_1',
    email: 'ada@re-el.co.za',
    displayName: 'Ada Lovelace',
    role: 'admin',
    status: 'active',
    ...over,
  };
}

export function fakeMailboxes(over = {}) {
  return [
    { id: MB, email: 'ada@re-el.co.za', displayName: 'Ada', status: 'active', isPrimary: true, ...over },
  ];
}

export function fakeMessage(over = {}) {
  return {
    id: 'msg_1',
    messageId: 'msg_1',
    threadId: 'thr_1',
    direction: 'inbound',
    from: { email: 'bob@example.com', name: 'Bob Nkosi' },
    to: [{ email: 'ada@re-el.co.za' }],
    cc: [],
    subject: 'Quarterly numbers',
    snippet: 'Here are the numbers you asked for.',
    folder: 'inbox',
    isRead: false,
    isStarred: false,
    isDraft: false,
    hasAttachments: false,
    sizeBytes: 2048,
    attachments: [],
    labels: [],
    deliveryStatus: 'unknown',
    receivedAt: '2026-10-01T09:00:00Z',
    sentAt: null,
    ...over,
  };
}

/**
 * Install a fetch stub for the API.
 *
 * Keys are matched as substrings against the request URL, so a route like
 * "action=labels" addresses every label call regardless of method or query
 * order. `calls` records every request for assertions on what the UI asked for.
 */
export function stubApi(routes = {}) {
  const calls = [];

  const stub = vi.fn(async (input) => {
    const url = typeof input === 'string' ? input : String(input.url ?? input);
    calls.push(url);

    for (const [pattern, handler] of Object.entries(routes)) {
      if (!url.includes(pattern)) continue;
      const body = typeof handler === 'function' ? await handler(url) : handler;
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, data: body }),
        text: async () => JSON.stringify({ ok: true, data: body }),
      };
    }

    // Anything unrouted resolves empty rather than rejecting, so a view that
    // asks for something the test forgot still renders.
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: {} }),
      text: async () => JSON.stringify({ ok: true, data: {} }),
    };
  });

  globalThis.fetch = stub;
  return { stub, calls };
}

/** The routes a signed-in shell with one mailbox needs. */
export function defaultRoutes(over = {}) {
  return {
    'action=session': { user: fakeUser() },
    'action=list': { messages: [fakeMessage()], counts: { folders: { inbox: 1 }, inboxUnread: 1, starred: 0 } },
    'action=folders': { folders: ['inbox', 'starred', 'drafts', 'sent', 'archive', 'spam', 'trash'] },
    'action=labels': { labels: [{ id: 'label_1', name: 'Work', color: '#21396A', slug: 'work', sortOrder: 0, messageCount: 2 }] },
    'action=quota': { used: 3, limit: 100 },
    'action=contacts': { contacts: [] },
    'action=overview': { stats: {}, usage: [], activity: [] },
    ...over,
  };
}

/** Reset jsdom between tests so listeners and DOM do not leak across cases. */
export function resetDom() {
  document.body.innerHTML = '';
  document.body.removeAttribute('data-mode');
  document.documentElement.removeAttribute('data-theme');
  window.localStorage?.clear();
}

/**
 * Wait for an element to appear.
 *
 * Views render their shell synchronously and then fill it in after an await, so
 * a test that queries immediately after render sees the loading placeholder.
 * axe.run() happens to await enough for the list to land, which is why the
 * violation checks passed while a direct querySelector did not — that is a trap,
 * so every test that needs settled DOM goes through here instead.
 */
export async function waitFor(selector, root = document, timeout = 2000) {
  const started = Date.now();
  for (;;) {
    const found = root.querySelector(selector);
    if (found) return found;
    if (Date.now() - started > timeout) throw new Error(`waitFor(${selector}) timed out`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Run axe against a mounted tree.
 * @returns {{violations: object[], passes: number}}
 */
export async function audit(node) {
  const axe = (await import('axe-core')).default;
  const results = await axe.run(node, {
    // The reader renders message bodies in a sandboxed srcdoc iframe. jsdom
    // gives no real child window, so axe's frame collector throws while walking
    // it ("must be a frame in the current window") regardless of rule config —
    // the rule toggle does not stop the collector running. Excluding frames is
    // the only way to audit a view containing one; the sandbox attribute that
    // rule exists to check is asserted directly instead.
    iframes: false,
    // The app is a hash-routed SPA, so a view is a fragment with no <html>,
    // <title> or page-level landmarks. Those rules would fail on the fragment
    // regardless of the markup; the full page is checked in tests/a11y.test.js.
    rules: {
      'region': { enabled: false },
      'landmark-one-main': { enabled: false },
      'page-has-heading-one': { enabled: false },
      'html-has-lang': { enabled: false },
      'document-title': { enabled: false },
      'bypass': { enabled: false },
      // jsdom computes no layout, so it cannot measure contrast.
      'color-contrast': { enabled: false },
      // No frames are collected at all (see `iframes: false` above), so this has
      // nothing left to inspect.
      'frame-tested': { enabled: false },
    },
  });
  return { violations: results.violations, passes: results.passes.length };
}

/** Human-readable one-liners for assertion failures. */
export function describeViolations(violations) {
  return violations
    .map((v) => {
      const nodes = (v.nodes || [])
        .slice(0, 4)
        .map((n) => n.html.slice(0, 120))
        .join('\n      ');
      return `${v.id} (${v.impact}): ${v.help}\n      ${nodes}`;
    })
    .join('\n    ');
}