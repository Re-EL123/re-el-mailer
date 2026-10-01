/**
 * Webhook signature verification.
 *
 * The HMAC is computed over the exact bytes the provider sent. Re-serialising the
 * parsed body would change key order and whitespace and produce a different
 * digest, so these tests pin the "raw bytes only" contract: a signature valid for
 * the original bytes must not validate a re-serialised equivalent.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  assertWebhookSignature,
  signWebhookPayload,
  verifyWebhookSignature,
} from '../packages/http/signature.js';

const SECRET = 'whsec_test_secret_0123456789abcdef';

afterEach(() => {
  vi.useRealTimers();
});

// `signWebhookPayload` already returns the three header names.
const headersFor = (signed) => ({ ...signed });

describe('verifyWebhookSignature', () => {
  it('accepts a correctly signed body', () => {
    const payload = JSON.stringify({ type: 'inbound', to: ['hi@re-el.co.za'] });
    const signed = signWebhookPayload({ rawBody: payload, secret: SECRET });

    const result = verifyWebhookSignature({
      rawBody: payload,
      headers: headersFor(signed),
      secret: SECRET,
    });

    expect(result).toEqual({ verified: true });
  });

  it('accepts a Buffer body byte-for-byte', () => {
    const payload = Buffer.from(JSON.stringify({ to: 'hi@re-el.co.za' }), 'utf8');
    const signed = signWebhookPayload({ rawBody: payload, secret: SECRET });

    const result = verifyWebhookSignature({
      rawBody: payload,
      headers: headersFor(signed),
      secret: SECRET,
    });

    expect(result).toEqual({ verified: true });
  });

  it('rejects a tampered body', () => {
    const payload = JSON.stringify({ to: 'victim@re-el.co.za' });
    const signed = signWebhookPayload({ rawBody: payload, secret: SECRET });

    const result = verifyWebhookSignature({
      rawBody: JSON.stringify({ to: 'attacker@re-el.co.za' }),
      headers: headersFor(signed),
      secret: SECRET,
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  it('does not accept a re-serialised equivalent body', () => {
    // Same data, different key order. A framework that parsed and re-encoded the
    // body before verifying would wrongly accept this.
    const original = JSON.stringify({ b: 2, a: 1 });
    const signed = signWebhookPayload({ rawBody: original, secret: SECRET });

    const result = verifyWebhookSignature({
      rawBody: JSON.stringify({ a: 1, b: 2 }),
      headers: headersFor(signed),
      secret: SECRET,
    });

    expect(result.verified).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const payload = JSON.stringify({ to: 'a@re-el.co.za' });
    const signed = signWebhookPayload({ rawBody: payload, secret: 'whsec_a_different_secret' });

    const result = verifyWebhookSignature({
      rawBody: payload,
      headers: headersFor(signed),
      secret: SECRET,
    });

    expect(result.verified).toBe(false);
  });

  it('rejects missing signature headers', () => {
    const result = verifyWebhookSignature({
      rawBody: JSON.stringify({ to: 'a@re-el.co.za' }),
      headers: {},
      secret: SECRET,
    });

    expect(result).toEqual({ verified: false, reason: 'missing_signature_headers' });
  });

  it('rejects an unparseable timestamp', () => {
    const payload = JSON.stringify({ to: 'a@re-el.co.za' });
    const signed = signWebhookPayload({ rawBody: payload, secret: SECRET });

    const result = verifyWebhookSignature({
      rawBody: payload,
      headers: { ...headersFor(signed), 'svix-timestamp': 'not-a-number' },
      secret: SECRET,
    });

    expect(result).toEqual({ verified: false, reason: 'invalid_timestamp' });
  });

  it('rejects a timestamp outside the tolerance window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const payload = JSON.stringify({ to: 'a@re-el.co.za' });
    const signed = signWebhookPayload({ rawBody: payload, secret: SECRET });

    // 10 minutes later, with the default 5 minute tolerance.
    vi.setSystemTime(new Date('2026-01-01T00:10:00Z'));

    const result = verifyWebhookSignature({
      rawBody: payload,
      headers: headersFor(signed),
      secret: SECRET,
      toleranceSeconds: 300,
    });

    expect(result).toEqual({ verified: false, reason: 'timestamp_outside_tolerance' });
  });

  it('honours allowStale for replayed deliveries', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const payload = JSON.stringify({ to: 'a@re-el.co.za' });
    const signed = signWebhookPayload({ rawBody: payload, secret: SECRET });

    vi.setSystemTime(new Date('2026-01-01T02:00:00Z'));

    const result = verifyWebhookSignature({
      rawBody: payload,
      headers: headersFor(signed),
      secret: SECRET,
      allowStale: true,
    });

    expect(result).toEqual({ verified: true });
  });

  it('rejects when no secret is configured', () => {
    const result = verifyWebhookSignature({
      rawBody: '{}',
      headers: {
        'svix-id': 'msg_1',
        'svix-timestamp': String(Math.floor(Date.now() / 1000)),
        'svix-signature': 'v1,abc',
      },
      secret: '',
    });

    expect(result).toEqual({ verified: false, reason: 'no_secret_configured' });
  });

  it('rejects a signature with an unsupported version prefix', () => {
    const payload = JSON.stringify({ to: 'a@re-el.co.za' });
    const result = verifyWebhookSignature({
      rawBody: payload,
      headers: {
        'svix-id': 'msg_1',
        'svix-timestamp': String(Math.floor(Date.now() / 1000)),
        'svix-signature': 'v0,abc',
      },
      secret: SECRET,
    });

    expect(result).toEqual({ verified: false, reason: 'no_matching_signature_version' });
  });

  it('matches any one signature when the header lists several (rotation)', () => {
    const payload = JSON.stringify({ to: 'a@re-el.co.za' });
    const current = signWebhookPayload({ rawBody: payload, secret: SECRET });
    const previous = signWebhookPayload({ rawBody: payload, secret: 'whsec_previous' });

    const result = verifyWebhookSignature({
      rawBody: payload,
      headers: {
        ...headersFor(current),
        'svix-signature': `${previous['svix-signature']} ${current['svix-signature']}`,
      },
      secret: SECRET,
    });

    expect(result).toEqual({ verified: true });
  });

  it('throws a 401 AppError via assertWebhookSignature', () => {
    const payload = JSON.stringify({ to: 'a@re-el.co.za' });
    const signed = signWebhookPayload({ rawBody: payload, secret: SECRET });

    let thrown;
    try {
      assertWebhookSignature({ rawBody: 'tampered', headers: headersFor(signed), secret: SECRET });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect(thrown.status).toBe(401);
  });

  it('returns true from assertWebhookSignature when valid', () => {
    const payload = JSON.stringify({ to: 'a@re-el.co.za' });
    const signed = signWebhookPayload({ rawBody: payload, secret: SECRET });

    expect(
      assertWebhookSignature({ rawBody: payload, headers: headersFor(signed), secret: SECRET }),
    ).toBe(true);
  });
});