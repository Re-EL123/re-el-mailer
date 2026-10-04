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

describe('base64 signing secrets', () => {
  // Captured from a live Resend `email.received` delivery. Resend issues
  // `whsec_<base64>` secrets where the base64 payload is the actual HMAC key,
  // so the verifier must decode it rather than hash the literal prefix text.
  const RESEND_SECRET = 'whsec_+R9xWS1tTEwF6zjsYfx/2btm+QIzsdYP';
  const RESEND_BODY =
    '{"created_at":"2026-10-04T12:41:18.000Z","data":{"attachments":[],"bcc":[],"cc":[],"created_at":"2026-10-04T12:41:20.375Z","email_id":"db24eed0-ea98-4b09-9870-ee46b207665c","from":"noreply@re-el.co.za","message_id":"<010201a106eed8d0-55b7480b-cf3c-41c0-848b-602827357e6e-000000@eu-west-1.amazonses.com>","received_for":["info@re-el.co.za"],"subject":"Loopback diagnostics 3","to":["info@re-el.co.za"]},"type":"email.received"}';
  const RESEND_HEADERS = {
    'svix-id': 'msg_3KELG30MqJhvxWvDMaTT786kNQd',
    'svix-timestamp': '1791117686',
    'svix-signature': 'v1,MVbcr3ab7reQZV+zLSz0GKuyx+4TkkKj1KrxzNUHLSw=',
  };

  it('verifies a genuine Resend signature', () => {
    expect(
      verifyWebhookSignature({
        rawBody: RESEND_BODY,
        headers: RESEND_HEADERS,
        secret: RESEND_SECRET,
        allowStale: true,
      }),
    ).toEqual({ verified: true });
  });

  it('does not accept the signature produced by hashing the raw secret text', () => {
    const wrong = signWebhookPayload({
      rawBody: RESEND_BODY,
      id: RESEND_HEADERS['svix-id'],
      timestamp: Number(RESEND_HEADERS['svix-timestamp']),
      secret: Buffer.from(RESEND_SECRET, 'utf8'),
    });

    // Sanity check that the fixture really is base64 key material.
    expect(wrong['svix-signature']).not.toBe(RESEND_HEADERS['svix-signature']);

    expect(
      verifyWebhookSignature({
        rawBody: RESEND_BODY,
        headers: RESEND_HEADERS,
        secret: RESEND_SECRET,
        allowStale: true,
      }).verified,
    ).toBe(true);
  });

  it('round-trips its own signature for a base64 secret', () => {
    const payload = JSON.stringify({ type: 'email.received' });
    const signed = signWebhookPayload({ rawBody: payload, secret: RESEND_SECRET });

    expect(
      verifyWebhookSignature({ rawBody: payload, headers: signed, secret: RESEND_SECRET }).verified,
    ).toBe(true);
  });

  it('still treats a prefixed but non-base64 secret as raw bytes', () => {
    const payload = JSON.stringify({ type: 'email.received' });
    const signed = signWebhookPayload({ rawBody: payload, secret: 'whsec_not_base64_!!' });

    expect(
      verifyWebhookSignature({ rawBody: payload, headers: signed, secret: 'whsec_not_base64_!!' })
        .verified,
    ).toBe(true);
  });
});