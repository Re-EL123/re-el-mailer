/**
 * Resend client error mapping.
 *
 * `toAppError` decides what the console shows when the provider refuses a send,
 * and it had no coverage at all. The visible symptom was a single sentence,
 * "The mail provider rejected its credentials", covering both a key that is
 * wrong and a key that is valid but not allowed to send — two problems with
 * two different fixes, described as one thing that is neither.
 *
 * These tests drive real fetch responses through the client, so a provider
 * status cannot quietly collapse into the wrong instruction again.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_jwt_secret_that_is_definitely_long_enough_to_pass_validation_0123456789';
process.env.MAIL_DOMAINS = 're-el.co.za';
process.env.RESEND_API_KEY = 're_test_key_not_a_real_credential';

const { resendFetch } = await import('../packages/mail/resend.js');
const { AppError, Codes } = await import('../packages/shared/errors.js');

let fetchMock;

function providerResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([['retry-after', '1']]),
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function capture(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the provider call to reject');
}

describe('provider credential failures', () => {
  it('names an unusable API key, and passes the provider message through', async () => {
    fetchMock.mockResolvedValue(providerResponse(401, {
      statusCode: 401,
      name: 'validation_error',
      message: 'API key is invalid',
    }));

    const err = await capture(resendFetch('/emails', { body: { to: ['a@example.com'] } }));

    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe(Codes.AUTH_INVALID);
    // 401 is the key itself: wrong, expired or revoked.
    expect(err.message).toMatch(/API key/);
    expect(err.details.providerMessage).toBe('API key is invalid');
  });

  it('distinguishes a key that is valid but not permitted from an invalid key', async () => {
    fetchMock.mockResolvedValue(providerResponse(403, {
      statusCode: 403,
      name: 'restricted_api_key',
      message: 'API key is restricted',
    }));

    const err = await capture(resendFetch('/emails', { body: { to: ['a@example.com'] } }));

    expect(err.code).toBe(Codes.AUTH_INVALID);
    // The wording has to differ from the 401 case, or the operator is told to
    // check a key that is in fact working.
    expect(err.message).toMatch(/permission/i);
    expect(err.message).not.toMatch(/rejected the API key/);
    expect(err.details.providerMessage).toBe('API key is restricted');
  });

  it('reports an unverified sending address as a validation problem, not a credential one', async () => {
    fetchMock.mockResolvedValue(providerResponse(422, {
      statusCode: 422,
      name: 'missing_required_field',
      message: 'The from address must be one of your verified domains',
    }));

    const err = await capture(resendFetch('/emails', { body: { to: ['a@example.com'] } }));

    expect(err.code).toBe(Codes.VALIDATION_ERROR);
    expect(err.message).toMatch(/not verified/i);
    expect(err.status).toBe(400);
  });

  it('maps rate limiting and provider outages to their own codes', async () => {
    fetchMock.mockResolvedValue(providerResponse(429, { statusCode: 429, message: 'Too many requests' }));
    const limited = await capture(resendFetch('/emails', { body: {} }));
    expect(limited.code).toBe(Codes.RATE_LIMITED);

    fetchMock.mockResolvedValue(providerResponse(503, { statusCode: 503, message: 'Service unavailable' }));
    const outage = await capture(resendFetch('/emails', { body: {} }));
    expect(outage.code).toBe(Codes.UPSTREAM_ERROR);
  });
});

describe('provider request shape', () => {
  it('sends the key as a bearer token and never in the body', async () => {
    fetchMock.mockResolvedValue(providerResponse(200, { id: 'msg_1' }));

    await resendFetch('/emails', { body: { to: ['a@example.com'], from: 'me@re-el.co.za' } });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.Authorization).toBe('Bearer re_test_key_not_a_real_credential');
    expect(init.body).not.toContain('re_test_key');
  });

  it('does not retry a send, because the provider may already have accepted it', async () => {
    fetchMock.mockResolvedValue(providerResponse(401, { message: 'API key is invalid' }));

    await capture(resendFetch('/emails', { body: { to: ['a@example.com'] } }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});