/**
 * Surviving a bad connection.
 *
 * Two separate failures used to look like an authentication problem, and both
 * cost the user their place in the app:
 *
 *   1. A request that never reached the server (offline, a reset connection, a
 *      headerless platform error page) surfaced as a CORS failure with a null
 *      status. boot() could not tell that apart from a rejected session, so it
 *      rendered the sign-in form — reading as "you have been logged out" every
 *      time the connection wobbled.
 *
 *   2. There was no retry at all, so a single dropped request failed the whole
 *      screen load on a connection that was merely slow.
 *
 * Retries are deliberately limited to safe requests and 5xx. Replaying a POST
 * after it was actually accepted could send a second email, and a silent
 * duplicate is worse than a visible failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

/** A response that never arrived: the browser reports this as a null status. */
function networkDrop() {
  return new TypeError('Failed to fetch');
}

async function loadApi() {
  return import('../apps/web/js/api.js');
}

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock;
  globalThis.window = { location: { origin: 'https://mailer.re-el.co.za' } };
  globalThis.window.__REEL_CONFIG__ = { apiBase: 'https://api.mail.re-el.co.za/api' };
  globalThis.localStorage = {
    store: new Map(),
    getItem(k) { return this.store.get(k) ?? null; },
    setItem(k, v) { this.store.set(k, v); },
    removeItem(k) { this.store.delete(k); },
  };
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Let the client's backoff timers fire without waiting in real time. */
async function settle(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5000);
  }
}

describe('retrying a request that never landed', () => {
  it('retries a GET after a dropped connection and succeeds', async () => {
    const api = await loadApi();
    fetchMock.mockRejectedValueOnce(networkDrop());
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, data: { messages: [] } }));

    const pending = api.request('/mail', { query: { action: 'list' } });
    await settle();
    await expect(pending).resolves.toEqual({ messages: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps retrying through several drops before giving up', async () => {
    const api = await loadApi();
    fetchMock.mockRejectedValueOnce(networkDrop());
    fetchMock.mockRejectedValueOnce(networkDrop());
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, data: { ok: 1 } }));

    const pending = api.request('/mail', { query: { action: 'list' } });
    await settle(10);
    await expect(pending).resolves.toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reports a persistent outage as a connection problem, not an auth failure', async () => {
    const api = await loadApi();
    fetchMock.mockRejectedValue(networkDrop());

    const pending = api.request('/mail', { query: { action: 'list' } });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
    await settle(12);
    await assertion;
  });

  it('never retries a POST, which could duplicate a send', async () => {
    const api = await loadApi();
    fetchMock.mockRejectedValueOnce(networkDrop());

    const pending = api.request('/send', { method: 'POST', body: {} });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await settle();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('retrying a server-side failure', () => {
  it('retries a 503 even for a POST, because the server rejected it', async () => {
    const api = await loadApi();
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { ok: false, error: { message: 'busy' } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, data: { sent: true } }));

    const pending = api.request('/send', { method: 'POST', body: {} });
    await settle();
    await expect(pending).resolves.toEqual({ sent: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 401: the session needs refreshing, not repeating', async () => {
    const api = await loadApi();
    fetchMock.mockResolvedValue(jsonResponse(401, { ok: false, error: { code: 'AUTH_REQUIRED' } }));

    const pending = api.request('/mail', { query: { action: 'list' } });
    await expect(pending).rejects.toMatchObject({ status: 401 });
    // One 401, then the single refresh, then the retry: not an endless loop.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('stops retrying a 400 instead of hammering a request that cannot succeed', async () => {
    const api = await loadApi();
    fetchMock.mockResolvedValue(jsonResponse(400, { ok: false, error: { code: 'VALIDATION_ERROR' } }));

    await expect(api.request('/mail', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});