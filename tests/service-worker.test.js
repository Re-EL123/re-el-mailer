/**
 * Service worker cache busting.
 *
 * A frontend fix deployed, GitHub Actions went green, the file was verifiably
 * present on the CDN — and the user still saw the old behaviour, including the
 * old error message. The service worker served them the previous build.
 *
 * The cache name was a constant that never changed, so no deploy evicted
 * anything, and stale-while-revalidate returned the cached copy before refreshing
 * in the background. Neither fault is visible to curl or CI: the file was never
 * wrong on the server, only in the browser.
 *
 * The worst case is a returning visitor whose service worker script is unchanged
 * by a deploy, because a byte-identical worker is never reinstalled and so never
 * re-precaches. Only a network-first fetch reaches them at all. These tests run
 * the real worker against in-memory CacheStorage so that is checked rather than
 * discovered by the user.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://mailer.re-el.co.za';

/** Cache keys are absolute, as in the browser. */
const keyOf = (request) => new URL(typeof request === 'string' ? request : request.url, `${ORIGIN}/`).toString();

/** Minimal Cache Storage: name → Map<url, response>. */
function makeCaches(seed = {}) {
  const store = new Map();
  for (const [name, entries] of Object.entries(seed)) store.set(name, new Map(entries));
  return {
    store,
    async open(name) {
      if (!store.has(name)) store.set(name, new Map());
      const map = store.get(name);
      return {
        async put(request, response) {
          map.set(keyOf(request), response);
        },
        async addAll(urls) {
          for (const url of urls) map.set(keyOf(url), await globalThis.fetch(new Request(keyOf(url))));
        },
        async match(request) {
          return map.get(keyOf(request));
        },
      };
    },
    async keys() {
      return [...store.keys()];
    },
    async delete(name) {
      return store.delete(name);
    },
    async match(request) {
      const key = keyOf(request);
      for (const map of store.values()) if (map.has(key)) return map.get(key);
      return undefined;
    },
  };
}

let listeners = {};

/**
 * Load the worker with the given shell contents.
 *
 * `runInstall: false` models the returning visitor: the worker script is
 * byte-identical to the one already installed, so the browser installs nothing
 * and no precache is refreshed.
 */
async function bootWorker({ contents = {}, existingCaches = {}, runInstall = true } = {}) {
  listeners = {};
  const caches = makeCaches(existingCaches);
  const fetched = [];

  const self = {
    location: new URL(`${ORIGIN}/service-worker.js`),
    clients: { claim: vi.fn(async () => {}) },
    skipWaiting: vi.fn(async () => {}),
    addEventListener: (type, handler) => {
      listeners[type] = handler;
    },
  };

  vi.stubGlobal('self', self);
  vi.stubGlobal('caches', caches);
  vi.stubGlobal('fetch', vi.fn(async (request) => {
    const url = keyOf(request);
    fetched.push(url);
    if (url.startsWith('https://api.')) return new Response('{}', { status: 200 });
    const body = contents[url.replace(`${ORIGIN}/`, '')] ?? `body for ${url}`;
    return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
  }));

  vi.resetModules();
  await import('../apps/web/service-worker.js');

  if (runInstall) {
    await runListener('install');
    await runListener('activate');
  }

  return { caches, fetched, self };
}

function runListener(type) {
  let settled;
  listeners[type]({ waitUntil: (p) => { settled = p; } });
  return settled;
}

const SHELL_URLS = [
  `${ORIGIN}/`,
  `${ORIGIN}/index.html`,
  `${ORIGIN}/js/api.js`,
];

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('service worker cache versioning', () => {
  it('names the cache after the shell contents, not a fixed string', async () => {
    const { caches } = await bootWorker();
    const names = await caches.keys();

    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^re-el-mailer-[0-9a-f]{16}$/);
    // The constant that caused this in the first place must not come back.
    expect(names).not.toContain('re-el-mailer-v1');
  });

  it('produces a different cache when any shell file changes', async () => {
    const before = await bootWorker({ contents: { 'js/api.js': 'v1' } });
    const beforeName = (await before.caches.keys())[0];

    // A deploy that changes one file, as every one of today's fixes did.
    const after = await bootWorker({ contents: { 'js/api.js': 'v2' } });
    const afterNames = await after.caches.keys();

    expect(afterNames[0]).not.toBe(beforeName);
  });

  it('is stable when nothing changed', async () => {
    const contents = { 'js/api.js': 'same' };
    const first = await bootWorker({ contents });
    const second = await bootWorker({ contents });

    expect((await second.caches.keys())[0]).toBe((await first.caches.keys())[0]);
  });

  it('evicts the previous deploy on activate', async () => {
    const { caches } = await bootWorker({
      existingCaches: {
        're-el-mailer-v1': [[`${ORIGIN}/js/api.js`, new Response('ancient')]],
      },
    });

    expect(await caches.keys()).not.toContain('re-el-mailer-v1');
    const [name] = await caches.keys();
    expect(caches.store.get(name).get(`${ORIGIN}/js/api.js`)).toBeDefined();
  });

  it('precaches the shell so a first visit still works offline', async () => {
    const { caches, fetched } = await bootWorker();
    const [name] = await caches.keys();

    for (const url of SHELL_URLS) {
      expect(caches.store.get(name).has(url)).toBe(true);
    }
    expect(fetched.some((url) => url.endsWith('/js/api.js'))).toBe(true);
  });
});

describe('service worker freshness', () => {
  /** Serve a request through the worker's fetch handler. */
  async function handleFetch(url, { mode = 'same-origin', ...init } = {}) {
    const request = new Request(url, init);
    // "navigate" is browser-only and rejected by Node's Request constructor.
    Object.defineProperty(request, 'mode', { value: mode });
    let settled;
    listeners.fetch({
      request,
      respondWith: (p) => { settled = p; },
    });
    if (!settled) return { handled: false };
    return { handled: true, response: await settled };
  }

  it('serves new code to a returning visitor whose worker is unchanged', async () => {
    // The exact situation that stranded the user: the new file was on the CDN,
    // the cached copy was the old build, and because the worker script itself did
    // not change there was no install to re-precache. Only network-first reaches
    // them.
    await bootWorker({
      runInstall: false,
      existingCaches: {
        're-el-mailer-v1': [[`${ORIGIN}/js/api.js`, new Response('OLD CODE')]],
      },
      contents: { 'js/api.js': 'NEW CODE' },
    });

    const { handled, response } = await handleFetch(`${ORIGIN}/js/api.js`);
    expect(handled).toBe(true);
    expect(await response.text()).toBe('NEW CODE');
  });

  it('serves the same content from cache when the network later fails', async () => {
    // Network-first must not mean cache-hostile: whatever was served online is
    // what a later offline load gets.
    await bootWorker({ contents: { 'js/api.js': 'CACHED CODE' } });
    await handleFetch(`${ORIGIN}/js/api.js`);

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    const { response } = await handleFetch(`${ORIGIN}/js/api.js`);
    expect(await response.text()).toBe('CACHED CODE');
  });

  it('serves the cached shell for a navigation while offline', async () => {
    await bootWorker({ contents: { 'index.html': '<html>shell</html>' } });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));

    const { response } = await handleFetch(`${ORIGIN}/some/deep/route`, { mode: 'navigate' });
    expect(await response.text()).toBe('<html>shell</html>');
  });

  it('never intercepts API traffic', async () => {
    await bootWorker();
    const { handled } = await handleFetch('https://api.mail.re-el.co.za/api/mail?action=list');

    // Mail must always be fetched live; a stale list would be shown as current.
    expect(handled).toBe(false);
  });
});
