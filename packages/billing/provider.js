/**
 * Billing provider adapter (PayFast).
 *
 * One narrow interface — `configured`, `createCheckout`, `verifySignature`,
 * `parseWebhook`, `confirmNotification`, `validateSourceIp` — with a PayFast
 * implementation and a `none` implementation for self-hosted deployments that do
 * not sell subscriptions. Everything above this layer (the entitlements, the
 * workspace plan) is provider-agnostic.
 *
 * PayFast is different in shape from a typical REST gateway and the difference
 * matters:
 *
 *   • Checkout is not an API call that returns a redirect URL. You build a signed
 *     HTML form and POST it to PayFast, so `createCheckout` returns the action
 *     and the signed fields for the browser to submit.
 *   • The signature is an MD5 of a URL-encoded `name=value` string, not an HMAC
 *     over the raw bytes. Values are trimmed, spaces become `+`, and the hex is
 *     upper-case. A configured passphrase is appended as `&passphrase=…` and
 *     salts the hash.
 *   • The webhook (ITN) is form-encoded and carries its own `signature` field.
 *     Verification is four checks: recompute the signature, confirm the source
 *     IP, confirm the amount, and POST the payload back to PayFast's validate
 *     endpoint which must answer `VALID`. The last one is the authoritative one:
 *     only PayFast can confirm that it issued this exact payload.
 *
 * Docs: https://developers.payfast.co.za/docs
 */

import crypto from 'node:crypto';
import { billing as billingConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { AppError, Codes } from '../shared/errors.js';

const HOST = {
  live: 'www.payfast.co.za',
  sandbox: 'sandbox.payfast.co.za',
};

/** PayFast's published egress ranges for ITN callbacks. */
const PAYFAST_IP_RANGES = [
  '197.97.145.144/28',
  '41.74.179.192/27',
  '102.216.36.0/28',
  '102.216.36.128/28',
  '144.126.193.139/32',
];

/** URL-encode a signature value the way PayFast does: trimmed, spaces as `+`. */
export function encodeSignatureValue(value) {
  return encodeURIComponent(String(value).trim()).replace(/%20/g, '+');
}

/**
 * Build the string that PayFast hashes.
 *
 * `skipBlank` mirrors the two documented call sites: the checkout signature
 * omits empty fields, but the ITN signature includes every posted field except
 * `signature` (PayFast sends many empty ones, and dropping them would change the
 * hash).
 */
export function payfastSignatureString(fields, { passphrase = null, skipBlank = true } = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(fields || {})) {
    if (key === 'signature') continue;
    if (value === undefined || value === null) continue;
    if (skipBlank && value === '') continue;
    parts.push(`${key}=${encodeSignatureValue(value)}`);
  }
  let str = parts.join('&');
  if (passphrase) str += `&passphrase=${encodeSignatureValue(passphrase)}`;
  return str;
}

/** MD5 hex of the PayFast signature string. */
export function payfastSignature(fields, options) {
  return crypto.createHash('md5').update(payfastSignatureString(fields, options)).digest('hex');
}

/** Constant-time hex comparison. */
function sameHex(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** `a.b.c.d` → 32-bit unsigned int, or null when not a dotted quad. */
function ipv4ToInt(ip) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim());
  if (!match) return null;
  let value = 0;
  for (let i = 1; i <= 4; i += 1) {
    const octet = Number(match[i]);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/** True when `ip` falls inside the CIDR `cidr` (e.g. "10.0.0.0/8"). */
export function ipv4InCidr(ip, cidr) {
  const addr = ipv4ToInt(ip);
  if (addr === null) return false;
  const [base, bitsRaw] = String(cidr).split('/');
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const bits = Number(bitsRaw ?? 32);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (addr & mask) === (baseInt & mask);
}

/** True when the caller's IP is one of PayFast's published ITN sources. */
export function payfastIpAllowed(ip) {
  return PAYFAST_IP_RANGES.some((range) => ipv4InCidr(ip, range));
}

/** Provider used when billing is switched off. Always "not configured". */
const noneProvider = {
  name: 'none',
  configured: false,
  async createCheckout() {
    throw new AppError(Codes.VALIDATION_ERROR, 'Billing is not configured on this deployment.', 400);
  },
  verifySignature() {
    return false;
  },
  parseWebhook() {
    return null;
  },
  async confirmNotification() {
    return false;
  },
  validateSourceIp() {
    return false;
  },
};

/** Payment status from an ITN → our internal status and event type. */
const ITN_STATUS = {
  COMPLETE: { type: 'payment_succeeded', status: 'active' },
  FAILED: { type: 'payment_failed', status: 'past_due' },
  PENDING: { type: 'payment_pending', status: 'pending' },
  CANCELLED: { type: 'subscription_canceled', status: 'canceled' },
};

const payfastProvider = {
  name: 'payfast',

  get configured() {
    return Boolean(billingConfig.merchantId() && billingConfig.merchantKey());
  },

  /** The PayFast endpoint for the current mode. */
  get host() {
    return billingConfig.sandbox() ? HOST.sandbox : HOST.live;
  },

  /**
   * Build a signed checkout form.
   *
   * Returns `{ actionUrl, fields, reference }`; the caller renders the fields as
   * hidden inputs and POSTs them. PayFast only settles ZAR, so no currency is
   * sent.
   *
   * @param {object} options
   * @param {string} options.email customer email (required by PayFast)
   * @param {number} options.amountMinor price in minor units (cents)
   * @param {string} [options.reference] idempotent reference (`m_payment_id`)
   * @param {object} [options.metadata] echoed back on the ITN via custom fields
   * @param {string} [options.returnUrl]
   * @param {string} [options.cancelUrl]
   * @param {string} [options.notifyUrl]
   * @param {boolean} [options.recurring] create a subscription
   */
  async createCheckout({
    email,
    amountMinor,
    reference,
    metadata = {},
    returnUrl,
    cancelUrl,
    notifyUrl,
    recurring = false,
    nameFirst,
    nameLast,
    itemName,
  }) {
    if (!this.configured) {
      throw new AppError(Codes.VALIDATION_ERROR, 'Billing is not configured on this deployment.', 400);
    }

    const fields = {
      merchant_id: billingConfig.merchantId(),
      merchant_key: billingConfig.merchantKey(),
      return_url: returnUrl,
      cancel_url: cancelUrl,
      notify_url: notifyUrl,
      name_first: nameFirst,
      name_last: nameLast,
      email_address: email,
      m_payment_id: reference || `reel_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
      amount: (Number(amountMinor) / 100).toFixed(2),
      item_name: itemName || 'Re-EL Mailer plan',
      item_description: metadata.planId ? `Plan: ${metadata.planId}` : undefined,
      custom_str1: metadata.workspaceId,
      custom_str2: metadata.planId,
      custom_int1: metadata.seats,
    };

    // Recurring purchases need the passphrase set on the merchant account; the
    // monthly frequency (3) is PayFast's code for "every month".
    if (recurring) {
      fields.subscription_type = '1';
      fields.frequency = '3';
      fields.cycles = '0';
    }

    fields.signature = payfastSignature(fields, { passphrase: billingConfig.passphrase() });

    return {
      actionUrl: `https://${this.host}/eng/process`,
      fields,
      reference: fields.m_payment_id,
    };
  },

  /**
   * Recompute the ITN signature over every posted field except `signature`,
   * including the passphrase, and compare in constant time.
   */
  verifySignature(fields) {
    const passphrase = billingConfig.passphrase();
    const expected = payfastSignature(fields, { passphrase, skipBlank: false });
    return sameHex(expected, fields?.signature);
  },

  /** Normalise an ITN into `{ eventId, type, status, … }`, or null if unhandled. */
  parseWebhook(fields) {
    const mapped = ITN_STATUS[String(fields?.payment_status || '').toUpperCase()];
    if (!mapped) return null;

    return {
      eventId: fields.pf_payment_id || fields.m_payment_id || null,
      type: mapped.type,
      status: mapped.status,
      reference: fields.m_payment_id || null,
      customer: fields.email_address || null,
      customerRef: fields.token || null,
      providerRef: fields.token || fields.pf_payment_id || null,
      amountGross: fields.amount_gross != null ? Number(fields.amount_gross) : null,
      metadata: {
        workspaceId: fields.custom_str1 || null,
        planId: fields.custom_str2 || null,
        seats: fields.custom_int1 || null,
      },
      raw: fields,
    };
  },

  /**
   * The authoritative check: hand the payload back to PayFast and require the
   * literal answer `VALID`. The parameter string is the same one used for the
   * signature, minus the passphrase (PayFast validates the posted data).
   */
  async confirmNotification(fields) {
    const body = payfastSignatureString(fields, { skipBlank: false });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`https://${this.host}/eng/query/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      });
      const text = (await response.text().catch(() => '')).trim();
      if (text !== 'VALID') {
        logger.warn('PayFast ITN validation did not return VALID', { status: response.status });
        return false;
      }
      return true;
    } catch (err) {
      logger.warn('PayFast ITN validation request failed', { error: err?.message });
      return false;
    } finally {
      clearTimeout(timer);
    }
  },

  validateSourceIp(ip) {
    return payfastIpAllowed(ip);
  },
};

/** The active provider. Unknown names fall back to `none` so a typo cannot bill. */
export function billingProvider() {
  return billingConfig.provider() === 'payfast' ? payfastProvider : noneProvider;
}
