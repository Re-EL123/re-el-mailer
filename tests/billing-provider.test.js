/**
 * Billing provider adapter (PayFast).
 *
 * The security-relevant parts are pinned here: the signature string is built the
 * way PayFast specifies (field order preserved, trimmed values, spaces as `+`, a
 * trailing passphrase, MD5), an unknown provider name never falls through to a
 * live one, and only PayFast's published IPs may deliver an ITN.
 *
 * `fetch` is stubbed globally; nothing leaves the process.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test@localhost:5432/test';
process.env.JWT_SECRET = 'x'.repeat(48);
process.env.BILLING_CURRENCY = 'ZAR';
process.env.BILLING_PROVIDER = 'payfast';
process.env.PAYFAST_MERCHANT_ID = '10000100';
process.env.PAYFAST_MERCHANT_KEY = '46f0cd694581a';
process.env.PAYFAST_PASSPHRASE = 'jt7NOE43FZPn';
process.env.PAYFAST_SANDBOX = 'true';

const {
  billingProvider,
  payfastSignature,
  payfastSignatureString,
  payfastIpAllowed,
  ipv4InCidr,
  encodeSignatureValue,
} = await import('../packages/billing/provider.js');

const md5 = (value) => crypto.createHash('md5').update(value).digest('hex');

function textResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => body };
}

beforeEach(() => {
  process.env.BILLING_PROVIDER = 'payfast';
  process.env.PAYFAST_MERCHANT_ID = '10000100';
  process.env.PAYFAST_MERCHANT_KEY = '46f0cd694581a';
  process.env.PAYFAST_PASSPHRASE = 'jt7NOE43FZPn';
  process.env.PAYFAST_SANDBOX = 'true';
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('provider selection', () => {
  it('selects payfast when configured', () => {
    expect(billingProvider().name).toBe('payfast');
  });

  it('falls back to none for an unknown name so a typo cannot bill', () => {
    process.env.BILLING_PROVIDER = 'strpe';
    expect(billingProvider().name).toBe('none');
  });

  it('reports payfast as configured only with a merchant id and key', () => {
    process.env.PAYFAST_MERCHANT_KEY = '';
    expect(billingProvider().configured).toBe(false);
    process.env.PAYFAST_MERCHANT_KEY = '46f0cd694581a';
    expect(billingProvider().configured).toBe(true);
    process.env.PAYFAST_MERCHANT_ID = '';
    expect(billingProvider().configured).toBe(false);
  });

  it('targets the sandbox by default and the live host only when told to', () => {
    expect(billingProvider().host).toBe('sandbox.payfast.co.za');
    process.env.PAYFAST_SANDBOX = 'false';
    expect(billingProvider().host).toBe('www.payfast.co.za');
  });

  it('none never starts a checkout and trusts nothing', async () => {
    process.env.BILLING_PROVIDER = 'none';
    const provider = billingProvider();
    expect(provider.name).toBe('none');
    expect(provider.configured).toBe(false);
    await expect(provider.createCheckout({})).rejects.toThrow(/not configured/i);
    expect(provider.verifySignature({})).toBe(false);
    expect(provider.parseWebhook({ payment_status: 'COMPLETE' })).toBeNull();
    expect(provider.validateSourceIp('197.97.145.150')).toBe(false);
    expect(await provider.confirmNotification({})).toBe(false);
  });
});

describe('signature format', () => {
  it('preserves field order and appends the passphrase', () => {
    const fields = { merchant_id: '10000100', amount: '149.00' };
    expect(payfastSignatureString(fields, { passphrase: 'jt7NOE43FZPn' })).toBe(
      'merchant_id=10000100&amount=149.00&passphrase=jt7NOE43FZPn',
    );
  });

  it('trims values and encodes with upper-case hex and + for spaces', () => {
    expect(encodeSignatureValue('  Ada Lovelace  ')).toBe('Ada+Lovelace');
    expect(encodeSignatureValue('a/b')).toBe('a%2Fb');
    expect(payfastSignatureString({ item_name: 'Pro plan' })).toBe('item_name=Pro+plan');
  });

  it('skips blank values for checkout but keeps them for an ITN', () => {
    const fields = { a: '1', b: '', c: '3' };
    expect(payfastSignatureString(fields, { skipBlank: true })).toBe('a=1&c=3');
    expect(payfastSignatureString(fields, { skipBlank: false })).toBe('a=1&b=&c=3');
  });

  it('is an MD5 of the signature string', () => {
    const fields = { merchant_id: '10000100', amount: '149.00' };
    const expected = md5('merchant_id=10000100&amount=149.00&passphrase=jt7NOE43FZPn');
    expect(payfastSignature(fields, { passphrase: 'jt7NOE43FZPn' })).toBe(expected);
  });
});

describe('createCheckout', () => {
  const args = {
    email: 'ada@re-el.co.za',
    amountMinor: 14900,
    reference: 'reel_ref_1',
    metadata: { workspaceId: 'wsp_1', planId: 'team', seats: 2 },
    returnUrl: 'https://mailer.re-el.co.za/?billing=return',
    cancelUrl: 'https://mailer.re-el.co.za/?billing=return',
    notifyUrl: 'https://api.mail.re-el.co.za/api/billing?action=webhook',
    recurring: true,
    nameFirst: 'Ada',
    nameLast: 'Lovelace',
  };

  it('returns a signed form POST instead of a redirect url', async () => {
    const result = await billingProvider().createCheckout(args);

    expect(result.actionUrl).toBe('https://sandbox.payfast.co.za/eng/process');
    expect(result.reference).toBe('reel_ref_1');
    expect(result.fields).toMatchObject({
      merchant_id: '10000100',
      merchant_key: '46f0cd694581a',
      m_payment_id: 'reel_ref_1',
      amount: '149.00',
      email_address: 'ada@re-el.co.za',
      custom_str1: 'wsp_1',
      custom_str2: 'team',
      custom_int1: 2,
      subscription_type: '1',
      notify_url: 'https://api.mail.re-el.co.za/api/billing?action=webhook',
    });
    // The signature on the returned form verifies against the same fields.
    expect(billingProvider().verifySignature({ ...result.fields })).toBe(true);
  });

  it('does not call the network', async () => {
    await billingProvider().createCheckout(args);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('omits the empty optional fields from the signed string', async () => {
    const result = await billingProvider().createCheckout({ email: 'a@b.c', amountMinor: 100 });
    const signed = payfastSignatureString(result.fields, { passphrase: process.env.PAYFAST_PASSPHRASE });
    expect(signed).not.toMatch(/name_first=/);
    expect(signed).not.toMatch(/return_url=/);
    expect(result.fields.signature).toBe(md5(signed));
  });

  it('refuses to start a checkout without credentials', async () => {
    process.env.PAYFAST_MERCHANT_KEY = '';
    await expect(billingProvider().createCheckout(args)).rejects.toThrow(/not configured/i);
  });
});

describe('verifySignature (ITN)', () => {
  const fields = {
    m_payment_id: 'reel_ref_1',
    pf_payment_id: '1234',
    payment_status: 'COMPLETE',
    amount_gross: '149.00',
    email_address: 'ada@re-el.co.za',
    empty_field: '',
  };
  const signature = payfastSignature(fields, { passphrase: 'jt7NOE43FZPn', skipBlank: false });

  it('accepts PayFast’s MD5 over every field including blanks', () => {
    expect(billingProvider().verifySignature({ ...fields, signature })).toBe(true);
  });

  it('rejects a tampered amount or missing signature', () => {
    expect(billingProvider().verifySignature({ ...fields, amount_gross: '1.00', signature })).toBe(false);
    expect(billingProvider().verifySignature({ ...fields })).toBe(false);
  });
});

describe('parseWebhook', () => {
  const provider = billingProvider();

  it('maps COMPLETE to an active payment with our metadata', () => {
    const event = provider.parseWebhook({
      m_payment_id: 'reel_ref_1',
      pf_payment_id: '1234',
      payment_status: 'COMPLETE',
      amount_gross: '149.00',
      email_address: 'ada@re-el.co.za',
      token: 'tok_9',
      custom_str1: 'wsp_1',
      custom_str2: 'team',
      custom_int1: '2',
    });
    expect(event).toMatchObject({
      eventId: '1234',
      type: 'payment_succeeded',
      status: 'active',
      reference: 'reel_ref_1',
      customer: 'ada@re-el.co.za',
      providerRef: 'tok_9',
      amountGross: 149,
    });
    expect(event.metadata).toEqual({ workspaceId: 'wsp_1', planId: 'team', seats: '2' });
  });

  it('maps FAILED to past_due, CANCELLED to canceled and PENDING to pending', () => {
    expect(provider.parseWebhook({ payment_status: 'FAILED' })).toMatchObject({ type: 'payment_failed', status: 'past_due' });
    expect(provider.parseWebhook({ payment_status: 'CANCELLED' })).toMatchObject({ type: 'subscription_canceled', status: 'canceled' });
    expect(provider.parseWebhook({ payment_status: 'PENDING' })).toMatchObject({ type: 'payment_pending', status: 'pending' });
  });

  it('falls back to the payment id when there is no pf_payment_id', () => {
    const event = provider.parseWebhook({ payment_status: 'COMPLETE', m_payment_id: 'reel_ref_1' });
    expect(event.eventId).toBe('reel_ref_1');
  });

  it('returns null for a status we do not act on', () => {
    expect(provider.parseWebhook({ payment_status: 'SOMETHING_ELSE' })).toBeNull();
  });
});

describe('confirmNotification', () => {
  it('accepts only the literal VALID answer from the validate endpoint', async () => {
    globalThis.fetch.mockResolvedValue(textResponse('VALID'));
    const ok = await billingProvider().confirmNotification({ m_payment_id: 'reel_ref_1', payment_status: 'COMPLETE' });
    expect(ok).toBe(true);
    const [url, options] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://sandbox.payfast.co.za/eng/query/validate');
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(String(options.body)).not.toMatch(/passphrase/);
  });

  it('rejects anything other than VALID, including a network failure', async () => {
    globalThis.fetch.mockResolvedValueOnce(textResponse('INVALID'));
    expect(await billingProvider().confirmNotification({ a: '1' })).toBe(false);
    globalThis.fetch.mockRejectedValueOnce(new Error('offline'));
    expect(await billingProvider().confirmNotification({ a: '1' })).toBe(false);
  });
});

describe('source IP allowlist', () => {
  it('matches PayFast’s published ranges', () => {
    expect(payfastIpAllowed('197.97.145.150')).toBe(true);
    expect(payfastIpAllowed('41.74.179.200')).toBe(true);
    expect(payfastIpAllowed('102.216.36.5')).toBe(true);
    expect(payfastIpAllowed('102.216.36.140')).toBe(true);
    expect(payfastIpAllowed('144.126.193.139')).toBe(true);
  });

  it('rejects anything outside them', () => {
    expect(payfastIpAllowed('197.97.145.160')).toBe(false);
    expect(payfastIpAllowed('8.8.8.8')).toBe(false);
    expect(payfastIpAllowed('144.126.193.140')).toBe(false);
    expect(payfastIpAllowed('not-an-ip')).toBe(false);
  });

  it('computes CIDR membership', () => {
    expect(ipv4InCidr('10.0.0.5', '10.0.0.0/8')).toBe(true);
    expect(ipv4InCidr('11.0.0.5', '10.0.0.0/8')).toBe(false);
    expect(ipv4InCidr('10.1.2.3', '10.1.2.3/32')).toBe(true);
  });
});
