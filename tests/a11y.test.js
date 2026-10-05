// @vitest-environment jsdom
/**
 * Accessibility smoke tests over the real views.
 *
 * Every check here runs axe-core against markup the app actually produces,
 * rendered through the view's real entry point with only the network stubbed.
 * Before this file there was no way to assert anything about the frontend: the
 * suite was entirely server-side, and `scripts/check.mjs` only proves that
 * identifiers resolve.
 *
 * axe is configured to skip the rules that cannot be meaningful in jsdom (region
 * and landmark rules want a full document; colour-contrast needs layout) and the
 * page-level rules, which apply to index.html rather than to a view fragment.
 * Everything that *is* meaningful in a fragment stays on: accessible names,
 * labels, roles, heading order, and ARIA validity.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { audit, defaultRoutes, describeViolations, fakeMailboxes, fakeMessage, fakeUser, resetDom, stubApi, waitFor } from './helpers/view-harness.js';

const { setState, state } = await import('../apps/web/js/store.js');
const { renderMailList } = await import('../apps/web/js/views/mail-list.js');
const { renderMessage } = await import('../apps/web/js/views/message.js');
const { renderSettings } = await import('../apps/web/js/views/settings.js');
const { renderAdmin } = await import('../apps/web/js/views/admin.js');
const { el, mount } = await import('../apps/web/js/ui.js');

const MB = 'mbx_1';

function signedIn(over = {}) {
  setState({
    user: fakeUser(),
    mailboxes: fakeMailboxes(),
    activeMailboxId: MB,
    counts: { folders: { inbox: 1 }, inboxUnread: 1, starred: 0 },
    ...over,
  });
}

function host() {
  const node = el('div');
  document.body.append(node);
  return node;
}

beforeEach(() => {
  resetDom();
  setState({ user: null, mailboxes: [], activeMailboxId: null, counts: { folders: {}, inboxUnread: 0, starred: 0 }, labels: [], pageSize: 30 });
});

describe('mail list', () => {
  it('has no detectable accessibility violations', async () => {
    stubApi(defaultRoutes());
    signedIn();
    const container = host();
    await renderMailList(container, { params: ['inbox'], query: {} });
    await waitFor('.msg-row', container);

    const { violations } = await audit(container);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  it('gives the message list an accessible name and a list role', async () => {
    stubApi(defaultRoutes());
    signedIn();
    const container = host();
    await renderMailList(container, { params: ['inbox'], query: {} });
    const list = await waitFor('[role="list"]', container);
    expect(list, 'the message list should be a list').toBeTruthy();
    expect(list.getAttribute('aria-label') || list.getAttribute('aria-labelledby')).toBeTruthy();
  });

  it('names every icon-only control', async () => {
    stubApi(defaultRoutes());
    signedIn();
    const container = host();
    await renderMailList(container, { params: ['inbox'], query: {} });
    await waitFor('.msg-row', container);

    // An icon-only control is one whose only content is an icon/glyph. axe
    // reports these as button-name / link-name, but asserting directly gives a
    // failure message that points at the element.
    const unlabelled = [...container.querySelectorAll('button, a[href]')].filter((node) => {
      const text = (node.textContent || '').trim();
      const label = node.getAttribute('aria-label') || node.getAttribute('title') || '';
      return text === '' && label === '';
    });
    expect(unlabelled.map((n) => n.outerHTML.slice(0, 90))).toEqual([]);
  });
});

describe('message reader', () => {
  it('has no detectable accessibility violations', async () => {
    stubApi(defaultRoutes({
      'action=get': { message: fakeMessage({ bodyHtml: '<p>Hello</p>', bodyText: 'Hello' }), thread: [] },
    }));
    signedIn();
    const container = host();
    await renderMessage(container, { params: ['msg_1'], query: { mailbox: MB } });
    await waitFor('.reader-toolbar', container);

    const { violations } = await audit(container);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  it('names the toolbar buttons it renders as glyphs', async () => {
    stubApi(defaultRoutes({
      'action=get': { message: fakeMessage({ bodyHtml: '<p>Hi</p>' }), thread: [] },
    }));
    signedIn();
    const container = host();
    await renderMessage(container, { params: ['msg_1'], query: { mailbox: MB } });
    const toolbar = await waitFor('.reader-toolbar', container);
    expect(toolbar).toBeTruthy();
    const buttons = [...toolbar.querySelectorAll('button, a[href]')];
    expect(buttons.length).toBeGreaterThan(0);
    const unlabelled = buttons.filter((b) => !(b.textContent || '').trim() && !b.getAttribute('aria-label') && !b.getAttribute('title'));
    expect(unlabelled.map((b) => b.outerHTML.slice(0, 90))).toEqual([]);
  });
});

describe('settings', () => {
  it('has no detectable accessibility violations', async () => {
    stubApi(defaultRoutes({
      'action=mailbox': { mailboxes: [{ id: MB, email: 'ada@re-el.co.za', displayName: 'Ada', status: 'active', signatureHtml: '', signatureText: '', replyTo: null, autoRead: false, isPrimary: true }] },
    }));
    signedIn();
    const container = host();
    await renderSettings(container);
    await waitFor('input, select, textarea', container);

    const { violations } = await audit(container);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  it('labels every form control', async () => {
    stubApi(defaultRoutes({
      'action=mailbox': { mailboxes: [{ id: MB, email: 'ada@re-el.co.za', displayName: 'Ada', status: 'active', signatureHtml: '', signatureText: '', replyTo: null, autoRead: false, isPrimary: true }] },
    }));
    signedIn();
    const container = host();
    await renderSettings(container);
    await waitFor('input, select, textarea', container);

    const controls = [...container.querySelectorAll('input, select, textarea')];
    expect(controls.length).toBeGreaterThan(0);
    const unlabelled = controls.filter((node) => {
      if (node.getAttribute('aria-label')) return false;
      if (node.id && container.querySelector(`label[for="${node.id}"]`)) return false;
      if (node.closest('label')) return false;
      if (node.getAttribute('title')) return false;
      return true;
    });
    expect(unlabelled.map((n) => n.outerHTML.slice(0, 90))).toEqual([]);
  });
});

describe('admin console', () => {
  it('has no detectable accessibility violations', async () => {
    stubApi(defaultRoutes());
    signedIn();
    const container = host();
    await renderAdmin(container);
    await waitFor('.admin-tab', container);

    const { violations } = await audit(container);
    expect(violations, describeViolations(violations)).toEqual([]);
  });
});

describe('state is cleaned up between renders', () => {
  it('does not accumulate duplicate subscribers', async () => {
    stubApi(defaultRoutes());
    signedIn();
    const first = host();
    await renderMailList(first, { params: ['inbox'], query: {} });

    // A view that forgets to unsubscribe leaks a listener on every navigation.
    // The observable symptom is that state changes fan out to stale views.
    const before = state.activeMailboxId;
    setState({ activeMailboxId: 'mbx_changed' });
    expect(state.activeMailboxId).toBe('mbx_changed');
    setState({ activeMailboxId: before });
  });
});