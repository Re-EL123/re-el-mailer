/**
 * Hash router.
 *
 * The router's contract matters for more than navigation: the app swaps between
 * the auth container and the mail shell container without reloading, so a
 * second `startRouter` call must not attach a second listener (each view would
 * render twice) and a container swap must still paint the current route.
 *
 * router.js touches `window` and nothing else, so a small stub is enough — no
 * DOM environment is required.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function makeLocation(hash = '') {
  return { hash, replace: vi.fn((next) => { location.hash = next; }) };
}

let location;
let listeners;

beforeEach(() => {
  vi.resetModules();
  location = makeLocation('#/inbox');
  listeners = new Map();
  globalThis.window = {
    get location() {
      return location;
    },
    addEventListener: (type, fn) => {
      listeners.set(type, [...(listeners.get(type) || []), fn]);
    },
    removeEventListener: (type, fn) => {
      listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn));
    },
  };
});

afterEach(() => {
  delete globalThis.window;
});

function container() {
  return { textContent: '', closest: (selector) => (selector === '.shell' ? { className: 'shell' } : null) };
}

async function load() {
  const router = await import('../apps/web/js/router.js');
  return router;
}

describe('startRouter', () => {
  it('renders the matching route into the container', async () => {
    const router = await load();
    const seen = [];
    router.route('inbox', (c, ctx) => { seen.push(ctx.name); });
    router.route('settings', (c, ctx) => { seen.push(ctx.name); });

    const target = container();
    router.startRouter(target);
    await vi.waitFor(() => expect(seen).toEqual(['inbox']));
  });

  it('parses params and query from the hash', async () => {
    location.hash = '#/message/msg_42?mailbox=mbx_1&tab=raw';
    const router = await load();
    let ctx = null;
    router.route('message', (c, context) => { ctx = context; });

    router.startRouter(container());
    await vi.waitFor(() => expect(ctx).not.toBeNull());
    expect(ctx.name).toBe('message');
    expect(ctx.params).toEqual(['msg_42']);
    expect(ctx.query).toEqual({ mailbox: 'mbx_1', tab: 'raw' });
  });

  it('attaches exactly one hashchange listener across repeated calls', async () => {
    const router = await load();
    let renders = 0;
    router.route('inbox', () => { renders += 1; });

    const first = container();
    router.startRouter(first);
    await vi.waitFor(() => expect(renders).toBe(1));

    // Same container again: nothing new to paint, but still one listener.
    router.startRouter(first);
    expect(listeners.get('hashchange')).toHaveLength(1);
    expect(renders).toBe(1);

    // A different container (the auth → shell swap) must paint once.
    router.startRouter(container());
    await vi.waitFor(() => expect(renders).toBe(2));
    expect(listeners.get('hashchange')).toHaveLength(1);

    for (const fn of listeners.get('hashchange')) fn();
    await vi.waitFor(() => expect(renders).toBe(3));
    expect(listeners.get('hashchange')).toHaveLength(1);
  });

  it('runs the previous view cleanup exactly once per navigation', async () => {
    const router = await load();
    const cleanup = vi.fn();
    router.route('inbox', () => cleanup);
    router.route('settings', () => cleanup);

    router.startRouter(container());
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(0));

    router.navigate('settings');
    for (const fn of listeners.get('hashchange')) fn();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));

    for (const fn of listeners.get('hashchange')) fn();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(2));
  });

  it('survives a view that throws', async () => {
    const router = await load();
    router.route('inbox', () => { throw new Error('boom'); });
    const target = container();
    router.startRouter(target);
    await vi.waitFor(() => expect(target.textContent).toMatch(/Something went wrong/));
  });
});

describe('navigate', () => {
  it('defaults to the inbox when a signed-in shell starts without a hash', async () => {
    location.hash = '';
    const router = await load();
    router.route('inbox', () => {});
    router.startRouter(container());
    expect(location.replace).toHaveBeenCalledWith('#/inbox');
  });

  it('leaves the hash alone on the public surface so sign-in shows', async () => {
    location.hash = '';
    const router = await load();
    let rendered = 0;
    router.route('', () => { rendered += 1; });
    const publicShell = { textContent: '', closest: () => null };
    router.startRouter(publicShell);
    await vi.waitFor(() => expect(rendered).toBe(1));
    expect(location.replace).not.toHaveBeenCalled();
  });

  it('honours replace and non-replace navigation', async () => {
    const router = await load();
    router.route('inbox', () => {});
    router.startRouter(container());

    router.navigate('settings');
    expect(location.hash).toBe('#/settings');
    expect(location.replace).not.toHaveBeenCalled();

    router.navigate('archive', { replace: true });
    expect(location.replace).toHaveBeenCalledWith('#/archive');
  });
});

describe('setRouterContainer', () => {
  it('renders into the new container after a shell swap', async () => {
    const router = await load();
    const targets = [];
    router.route('inbox', (c) => { targets.push(c); });

    router.startRouter(container());
    await vi.waitFor(() => expect(targets).toHaveLength(1));

    const next = container();
    router.setRouterContainer(next);
    await vi.waitFor(() => expect(targets).toHaveLength(2));
    expect(targets[1]).toBe(next);
    expect(listeners.get('hashchange')).toHaveLength(1);
  });
});