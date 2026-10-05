/**
 * API client.
 *
 * Wraps every call to the serverless API in one place so the rest of the app
 * never touches `fetch`, URLs or the response envelope.
 *
 *   • The base URL comes from `window.__REEL_CONFIG__.apiBase` (set in
 *     index.html) so the same bundle works on GitHub Pages (frontend) talking
 *     to a separate API origin.
 *   • Access tokens are held in memory only. The refresh token is an httpOnly
 *     cookie the browser sends automatically; it is never exposed to JS.
 *   • A 401 triggers exactly one refresh attempt and one retry of the original
 *     request, so an expired access token is invisible to callers. Concurrent
 *     401s share a single in-flight refresh.
 */

const config = (typeof window !== 'undefined' && window.__REEL_CONFIG__) || {};

/**
 * Vercel serves everything in api/ under /api, so the base must end there.
 *
 * Normalising in one place means an override like ?api=http://localhost:3000
 * still works. Left unnormalised, every request 404s at the edge — and the
 * browser reports a missing-path 404 as a CORS failure, which sends you
 * hunting through ALLOWED_ORIGINS instead of the one-character fix.
 */
function normaliseApiBase(value) {
  const trimmed = String(value ?? '/api').trim().replace(/\/+$/, '');
  if (!trimmed) return '/api';
  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
}

const API_BASE = normaliseApiBase(config.apiBase);

let accessToken = null;
let refreshPromise = null;
const listeners = new Set();

/** Subscribe to auth-state changes (login/logout). */
export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emitAuth(user) {
  for (const fn of listeners) {
    try {
      fn(user);
    } catch {
      /* a listener must not break auth */
    }
  }
}

export function getAccessToken() {
  return accessToken;
}

export function setAccessToken(token) {
  accessToken = token || null;
}

/** Error carrying the API's structured code/details so the UI can react. */
export class ApiError extends Error {
  constructor(message, { code = 'ERROR', status = 0, details = null, requestId = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.requestId = requestId;
  }
}

/**
 * Best user-facing message for a failure.
 *
 * A schema rejection arrives as VALIDATION_ERROR: `message` is the generic
 * "Some of the details provided are not valid." while the actionable reasons sit
 * in `details` as { field, message }. Displaying `message` alone told someone
 * failing the forced password change that details were invalid without naming
 * the field or the rule, even though the reason was on the wire the whole time.
 *
 * Prefers those specifics, and falls back to `message` for every other failure.
 */
export function describeApiError(err) {
  if (!(err instanceof ApiError)) return 'Something went wrong. Please try again.';
  const details = err.details;

  // Schema rejections: an array of { field, message } from the pipeline.
  if (Array.isArray(details)) {
    const issues = details.map((issue) => (typeof issue?.message === 'string' ? issue.message.trim() : '')).filter(Boolean);
    if (issues.length > 0) return issues.join(' ');
  }

  // Policy failures: checkPasswordPolicy reports { valid, errors: string[] },
  // not the issue-array shape, so the reason stayed hidden too.
  if (details && Array.isArray(details.errors)) {
    const rules = details.errors.filter((message) => typeof message === 'string' && message.trim());
    if (rules.length > 0) return rules.join(' ');
  }

  return err.message || 'Something went wrong. Please try again.';
}

function buildUrl(path, query) {
  const url = new URL(API_BASE + path, window.location.origin);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function parse(res) {
  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok || (payload && payload.ok === false)) {
    const err = payload?.error || {};
    throw new ApiError(err.message || `Request failed (${res.status})`, {
      code: err.code || 'ERROR',
      status: res.status,
      details: err.details ?? null,
      requestId: payload?.requestId ?? null,
    });
  }
  return payload?.data ?? null;
}

/** Methods safe to replay: a repeat either changes nothing or returns the same answer. */
const IDEMPOTENT = new Set(['GET', 'HEAD']);

/**
 * Retries for a request that never landed.
 *
 * A weak connection drops requests that the server never saw, so retrying is
 * free of duplicate-write risk on a GET. POSTs are deliberately excluded: a
 * resend of "send this message" or "save this draft" could produce a second
 * email, and a silent duplicate is worse than a visible failure. 5xx is retried
 * regardless of method, because the server rejecting a request is not the same
 * as accepting it twice.
 */
const RETRY_DELAYS_MS = [400, 1200, 3000];
const RETRYABLE_STATUS = new Set([500, 502, 503, 504, 429]);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function rawRequest(path, { method = 'GET', query, body, isForm = false, attempt = 0 } = {}) {
  const headers = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  let payloadBody;
  if (isForm) {
    payloadBody = body; // browser sets the multipart boundary
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payloadBody = JSON.stringify(body);
  }

  // `credentials: 'include'` is required for the refresh cookie to travel when
  // the API lives on a different origin than the Pages frontend.
  let res;
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      headers,
      body: payloadBody,
      credentials: 'include',
    });
  } catch (cause) {
    // A response that never arrived — offline, a reset connection, a headerless
    // platform error page — surfaces in the browser as a CORS failure with a null
    // status. Reporting that as "something went wrong" sends people looking at the
    // server when the request simply did not land.
    const err = new ApiError('Could not reach the server. Check your connection and try again.', {
      code: 'NETWORK_ERROR',
      status: 0,
      cause,
    });
    const canReplay = IDEMPOTENT.has(method) && attempt < RETRY_DELAYS_MS.length;
    if (canReplay) {
      // Jitter keeps a fleet of tabs from retrying in lockstep and re-creating
      // the burst that dropped them.
      await wait(RETRY_DELAYS_MS[attempt] + Math.random() * 250);
      return rawRequest(path, { method, query, body, isForm, attempt: attempt + 1 });
    }
    throw err;
  }

  if (RETRYABLE_STATUS.has(res.status) && attempt < RETRY_DELAYS_MS.length) {
    await wait(RETRY_DELAYS_MS[attempt] + Math.random() * 250);
    return rawRequest(path, { method, query, body, isForm, attempt: attempt + 1 });
  }

  return parse(res);
}

/** Refresh the access token, coalescing concurrent attempts. */
async function refresh() {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const data = await rawRequest('/auth', { method: 'POST', query: { action: 'refresh' } });
        // buildSessionPayload() returns `token`; only an older API nested it.
        accessToken = data?.session?.accessToken ?? data?.token ?? null;
        if (!accessToken) {
          throw new ApiError('AUTH_INVALID', 'The session could not be refreshed.');
        }
        return data;
      } catch (err) {
        // Only a rejection from the server invalidates the session. A request that
        // never landed — offline, a reset connection, a headerless platform error
        // page — arrives as a network error, and clearing the session on it turns
        // a momentary blip into a logout.
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          accessToken = null;
          emitAuth(null);
        }
        throw err;
      } finally {
        refreshPromise = null;
      }
    })();
  }
  return refreshPromise;
}

/**
 * Call the API. On 401 refresh once and retry.
 *
 * The refresh cookie is the only thing that survives a page load, since the
 * access token lives in memory. That makes `?action=session` the one auth path
 * that must attempt a refresh: a reload starts with no access token, so without
 * it the bootstrap call 401s, nothing retries, and every refresh dumps the user
 * back on the login screen despite a valid cookie. The remaining auth paths
 * (login, logout, refresh, forgot-password) are excluded to avoid refreshing
 * against a rejected password or in a loop.
 */
export async function request(path, { method = 'GET', query, body, isForm = false, retry = true } = {}) {
  try {
    return await rawRequest(path, { method, query, body, isForm });
  } catch (err) {
    const refreshable = path === '/auth' && query?.action === 'session';
    const isAuthPath = path.startsWith('/auth');
    if (err.status === 401 && retry && (!isAuthPath || refreshable)) {
      await refresh();
      return rawRequest(path, { method, query, body, isForm });
    }
    throw err;
  }
}

const get = (path, query) => request(path, { query });
const post = (path, body, query) => request(path, { method: 'POST', body, query });
const put = (path, body, query) => request(path, { method: 'PUT', body, query });
const del = (path, query) => request(path, { method: 'DELETE', query });

export const api = {
  // ── Auth ───────────────────────────────────────────────────────────────
  auth: {
    login: (email, password) => post('/auth', { email, password }, { action: 'login' }),
    logout: () => post('/auth', undefined, { action: 'logout' }),
    session: () => get('/auth', { action: 'session' }),
    sessions: () => get('/auth', { action: 'sessions' }),
    revokeSession: (sessionId) => post('/auth', { sessionId }, { action: 'revoke-session' }),
    preferences: () => get('/auth', { action: 'preferences' }),
    updatePreferences: (preferences) => post('/auth', { preferences }, { action: 'update-preferences' }),
    forgot: (email) => post('/auth', { email }, { action: 'forgot' }),
    reset: (token, password) => post('/auth', { token, password }, { action: 'reset' }),
    changePassword: (currentPassword, newPassword) =>
      post('/auth', { currentPassword, newPassword }, { action: 'change-password' }),
    refresh,
  },

  // ── Mail ───────────────────────────────────────────────────────────────
  mail: {
    list: (query) => get('/mail', { action: 'list', ...query }),
    get: (id, mailboxId) => get('/mail', { action: 'get', id, mailboxId }),
    thread: (threadId, mailboxId) => get('/mail', { action: 'thread', threadId, mailboxId }),
    search: (q, query) => get('/mail', { action: 'search', q, ...query }),
    star: (ids, isStarred, mailboxId) => post('/mail', { ids, isStarred, mailboxId }, { action: 'star' }),
    move: (ids, folder, mailboxId) => post('/mail', { ids, folder, mailboxId }, { action: 'move' }),
    markRead: (ids, isRead, mailboxId) => post('/mail', { ids, isRead, mailboxId }, { action: 'update' }),
    markAllRead: (folder, mailboxId) => post('/mail', { folder }, { action: 'mark-all-read', mailboxId }),
    trash: (ids, mailboxId) => post('/mail', { ids, mailboxId }, { action: 'trash' }),
    deleteForever: (ids, mailboxId) => post('/mail', { ids, mailboxId }, { action: 'delete' }),
    empty: (folder, mailboxId) => post('/mail', { folder }, { action: 'empty', mailboxId }),
    labels: (mailboxId) => get('/mail', { action: 'labels', mailboxId }),
    createLabel: (body, mailboxId) => post('/mail', body, { action: 'create-label', mailboxId }),
    updateLabel: (id, body, mailboxId) => put('/mail', body, { action: 'update-label', id, mailboxId }),
    deleteLabel: (id, mailboxId) => del('/mail', { action: 'delete-label', id, mailboxId }),
    messagesByLabel: (labelId, query) => get('/mail', { action: 'messages-by-label', labelId, ...query }),
    setLabels: (ids, labelIds, mailboxId) => post('/mail', { ids, labelIds, mailboxId }, { action: 'set-labels' }),
    contacts: (q, mailboxId) => get('/mail', { action: 'contacts', q, mailboxId }),
    quota: (mailboxId) => get('/mail', { action: 'quota', mailboxId }),
    folders: (mailboxId) => get('/mail', { action: 'folders', mailboxId }),
    saveDraft: (body) => request('/mail', { method: 'POST', body, query: { action: 'draft' } }),
    deleteDraft: (id, mailboxId) => del('/mail', { action: 'delete-draft', id, mailboxId }),
    attachmentUploadUrl: (payload) => request('/mail', { method: 'POST', body: JSON.stringify(payload), query: { action: 'attachment-upload-url' } }),
    attachmentComplete: (payload) => request('/mail', { method: 'POST', body: JSON.stringify(payload), query: { action: 'attachment-complete' } }),
    attachmentUrl: (id, messageId, inline, mailboxId) =>
      get('/mail', { action: 'attachment-url', id, messageId, inline: inline ? 1 : undefined, mailboxId }),
  },

  // ── Send ───────────────────────────────────────────────────────────────
  send: {
    send: (body) => post('/send', body, { action: 'send' }),
    reply: (id, mode, mailboxId) => get('/send', { action: 'reply', id, mode, mailboxId }),
    forward: (id, attachments, mailboxId) => get('/send', { action: 'forward', id, attachments: attachments ? 1 : undefined, mailboxId }),
    suggest: (q, mailboxId) => get('/send', { action: 'suggest', q, mailboxId }),
  },

  // ── Admin ──────────────────────────────────────────────────────────────
  admin: {
    overview: (days) => get('/admin', { action: 'overview', days }),
    users: (query) => get('/admin', { action: 'users', ...query }),
    createUser: (body) => post('/admin', body, { action: 'create-user' }),
    updateUser: (id, body) => put('/admin', body, { action: 'update-user', id }),
    deleteUser: (id) => del('/admin', { action: 'delete-user', id }),
    resetPassword: (id, body) => post('/admin', body, { action: 'reset-user-password', id }),
    mailboxes: (query) => get('/admin', { action: 'mailboxes', ...query }),
    createMailbox: (body) => post('/admin', body, { action: 'create-mailbox' }),
    updateMailbox: (id, body) => put('/admin', body, { action: 'update-mailbox', id }),
    deleteMailbox: (id) => del('/admin', { action: 'delete-mailbox', id }),
    domains: () => get('/admin', { action: 'domains' }),
    createDomain: (body) => post('/admin', body, { action: 'create-domain' }),
    updateDomain: (id, body) => put('/admin', body, { action: 'update-domain', id }),
    deleteDomain: (id) => del('/admin', { action: 'delete-domain', id }),
    routes: (domainId) => get('/admin', { action: 'routes', domainId }),
    createRoute: (domainId, body) => post('/admin', body, { action: 'create-route', domainId }),
    updateRoute: (id, body) => put('/admin', body, { action: 'update-route', id }),
    deleteRoute: (id) => del('/admin', { action: 'delete-route', id }),
    audit: (query) => get('/admin', { action: 'audit', ...query }),
  },

  // ── Settings ───────────────────────────────────────────────────────────
  settings: {
    app: () => get('/settings', { action: 'app' }),
    list: () => get('/settings', { action: 'list' }),
    update: (settings) => put('/settings', { settings }, { action: 'update' }),
    mailboxes: () => get('/settings', { action: 'mailbox' }),
    updateMailbox: (body, mailboxId) => put('/settings', body, { action: 'update-mailbox', mailboxId }),
    disconnect: () => post('/settings', undefined, { action: 'disconnect' }),
  },

  // ── Health ─────────────────────────────────────────────────────────────
  health: {
    ping: () => get('/health', { action: 'ping' }),
    status: () => get('/health', { action: 'status' }),
  },
};

export { API_BASE };