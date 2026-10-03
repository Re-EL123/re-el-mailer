/**
 * Resend HTTP client.
 *
 * Resend's official SDK is a thin fetch wrapper with no timeout, no retry and no
 * error normalisation. This is deliberately small and does four things the SDK
 * does not:
 *
 *   1. applies a timeout, because a serverless invocation has a wall-clock limit
 *      and a hung socket would burn it;
 *   2. retries idempotent reads (and nothing else) on 429/5xx/network failure;
 *   3. turns provider error bodies into AppError with a stable `code`, so the
 *      client never has to parse Resend's messages;
 *   4. never logs the API key or the full request body.
 */

import { mail as mailConfig } from '../shared/config.js';
import { AppError, Codes } from '../shared/errors.js';
import { logger } from '../shared/logger.js';

const RESEND_BASE = 'https://api.resend.com';
const DEFAULT_TIMEOUT_MS = 15_000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Sleep, for the backoff between retries. */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Map a Resend error body onto our error taxonomy.
 * Resend returns `{ statusCode, message, name }`.
 */
function toAppError(status, body) {
  const message = typeof body?.message === 'string' ? body.message : '';
  const text = message.toLowerCase();

  // 401 and 403 are different problems with different fixes, and they were
  // collapsed into one sentence that named neither. Resend answers 401 when the
  // key itself is wrong, expired or revoked, and 403 when the key is valid but
  // not allowed to send. The provider's own message is passed through, the way
  // the 422 and 429 branches already do, because the operator reading the
  // console is the one who can act on it.
  if (status === 401) {
    return new AppError(Codes.AUTH_INVALID, 'The mail provider rejected the API key.', 502, {
      cause: new Error(message || 'resend 401'),
      details: { provider: 'resend', providerMessage: message || null, hint: 'Check RESEND_API_KEY in the deployed environment.' },
    });
  }
  if (status === 403) {
    return new AppError(Codes.AUTH_INVALID, 'The mail provider refused permission for that API key.', 502, {
      cause: new Error(message || 'resend 403'),
      details: { provider: 'resend', providerMessage: message || null, hint: 'The key may be restricted without sending access, or belong to another account.' },
    });
  }
  if (status === 422 && (text.includes('domain') || text.includes('from'))) {
    return new AppError(Codes.VALIDATION_ERROR, 'The sending address is not verified with the mail provider.', 400, {
      details: { provider: 'resend', providerMessage: message },
    });
  }
  if (status === 429) {
    return new AppError(Codes.RATE_LIMITED, 'The mail provider is rate limiting this account.', 502, {
      headers: body?.retryAfter ? { 'Retry-After': String(body.retryAfter) } : {},
      details: { providerMessage: message },
    });
  }
  if (status >= 500) {
    return new AppError(Codes.UPSTREAM_ERROR, 'The mail provider is temporarily unavailable.', 502, {
      cause: new Error(message || `resend ${status}`),
    });
  }
  return new AppError(Codes.UPSTREAM_ERROR, 'The mail provider could not send that message.', 502, {
    cause: new Error(message || `resend ${status}`),
    details: { providerStatus: status, providerMessage: message },
  });
}

/**
 * Call the Resend API.
 *
 * @param {string} path e.g. '/emails'
 * @param {object} options
 * @param {'GET'|'POST'|'PATCH'|'DELETE'} [options.method='POST']
 * @param {object} [options.body]
 * @param {boolean} [options.idempotent=false] enables retries — only safe for reads
 * @param {number} [options.attempts=3]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<any>} parsed JSON response
 */
export async function resendFetch(path, { method = 'POST', body, idempotent = false, attempts = 3, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const apiKey = mailConfig.apiKey();
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${RESEND_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 're-el-mailer/1.0',
        },
        ...(body === undefined ? null : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { message: text.slice(0, 500) };
        }
      }

      if (response.ok) return parsed;

      const error = toAppError(response.status, parsed);
      lastError = error;

      const canRetry = idempotent && RETRYABLE_STATUS.has(response.status) && attempt < attempts;
      if (!canRetry) throw error;

      const retryAfter = Number.parseInt(response.headers.get('retry-after') || '', 10);
      await wait(Number.isFinite(retryAfter) ? retryAfter * 1000 : 2 ** attempt * 250);
    } catch (err) {
      clearTimeout(timer);

      if (err instanceof AppError) {
        const canRetry = idempotent && err.status === 502 && attempt < attempts;
        if (canRetry) {
          await wait(2 ** attempt * 250);
          continue;
        }
        throw err;
      }

      // AbortError, DNS failure, socket hangup.
      lastError = new AppError(Codes.UPSTREAM_ERROR, 'The mail provider could not be reached.', 502, {
        cause: err,
      });
      if (!idempotent || attempt >= attempts) throw lastError;
      logger.warn('Resend request failed, retrying', { path, attempt, error: err?.message });
      await wait(2 ** attempt * 250);
      continue;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new AppError(Codes.UPSTREAM_ERROR, 'The mail provider could not be reached.', 502);
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

/**
 * Send one email.
 * @returns {Promise<{id: string}>}
 */
export async function sendEmail(payload) {
  const result = await resendFetch('/emails', { method: 'POST', body: payload });
  if (!result?.id) {
    throw new AppError(Codes.UPSTREAM_ERROR, 'The mail provider accepted the message but returned no id.', 502, {
      details: { payloadKeys: Object.keys(payload) },
    });
  }
  return { id: result.id };
}

/** Fetch a sent email's current status. */
export async function getEmail(id) {
  return resendFetch(`/emails/${encodeURIComponent(id)}`, { method: 'GET', idempotent: true });
}

/** Batch-send. Used by admin campaigns. */
export async function batchSend(payloads) {
  return resendFetch('/emails/batch', { method: 'POST', body: payloads });
}

/** Suppress a bouncing address (hard bounce or complaint). */
export async function suppressContact(email, reason = 'hard_bounce') {
  return resendFetch('/contacts', { method: 'POST', body: { email, unsubscribed: true }, idempotent: true });
}

export async function removeSuppression(email) {
  return resendFetch(`/contacts/${encodeURIComponent(email)}`, { method: 'DELETE', idempotent: true });
}

export async function listSuppressions() {
  return resendFetch('/contacts', { method: 'GET', idempotent: true });
}

/** Domains and their verification status, for the admin screen. */
export async function listDomains() {
  return resendFetch('/domains', { method: 'GET', idempotent: true });
}

export async function createDomain({ name, region }) {
  return resendFetch('/domains', { method: 'POST', body: { name, ...(region ? { region } : {}) } });
}

export async function getDomain(id) {
  return resendFetch(`/domains/${encodeURIComponent(id)}`, { method: 'GET', idempotent: true });
}

/** API keys are only ever listed, never created from here. */
export async function listApiKeys() {
  return resendFetch('/api-keys', { method: 'GET', idempotent: true });
}

export async function verifySender(email) {
  return resendFetch(`/emails/${encodeURIComponent(email)}`, { method: 'GET', idempotent: true });
}