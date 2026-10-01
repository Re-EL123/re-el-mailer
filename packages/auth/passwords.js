/**
 * Password hashing and policy enforcement.
 *
 * bcrypt only. Argon2id would be preferable where a native module is
 * acceptable, but bcryptjs is pure JavaScript and therefore safe on Vercel's
 * Node runtime and on any Node version — worth more than the memory-hardening
 * gain for an internal business mail platform. See docs/security.md.
 */

import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { auth as authConfig } from '../shared/config.js';
import { AppError, Codes } from '../shared/errors.js';

// ─── Common breached / guessable passwords ───────────────────────────────────
// A short blocklist plus the policy below is far more effective than length
// alone. Kept deliberately small; a full HIBP list would be fetched at build
// time in a larger deployment.

const BLOCKED_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd', 'passw0rd123',
  'qwerty', 'qwerty123', '12345678', '123456789', '1234567890',
  'letmein', 'welcome', 'welcome1', 'welcome123', 'admin', 'administrator',
  'iloveyou', 'monkey', 'dragon', 'sunshine', 'princess', 'football',
  'baseball', 'master', 'shadow', 'superman', 'trustno1', 'abc123',
  '111111', '000000', '654321', 'changeme', 'secret', 'letmein123',
]);

/** Sequences an attacker tries first on a business domain. */
const DOMAIN_PATTERNS = [
  /re-?el/i,
  /mailer/i,
  /company/i,
  /admin/i,
  /user/i,
];

// ─── Hashing ─────────────────────────────────────────────────────────────────

/** Hash a plaintext password with bcrypt. */
export async function hashPassword(plaintext, rounds = authConfig.bcryptRounds) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new AppError(Codes.VALIDATION_ERROR, 'A password is required.');
  }
  // bcrypt silently truncates beyond 72 bytes; reject rather than truncate.
  if (Buffer.byteLength(plaintext, 'utf8') > 72) {
    throw new AppError(
      Codes.VALIDATION_ERROR,
      'That password is too long. Use 72 characters or fewer.',
    );
  }
  return bcrypt.hash(plaintext, rounds);
}

/**
 * Verify a password against a stored hash.
 * Returns false (never throws) on any error so a corrupt hash row cannot crash
 * the login endpoint.
 */
export async function verifyPassword(plaintext, hash) {
  if (typeof plaintext !== 'string' || typeof hash !== 'string' || !hash) return false;
  try {
    return await bcrypt.compare(plaintext, hash);
  } catch {
    return false;
  }
}

/**
 * True when a stored hash should be upgraded (e.g. the bcrypt cost changed).
 */
export function needsRehash(hash, rounds = authConfig.bcryptRounds) {
  const match = /^\$2[aby]\$(\d{2})\$/.exec(String(hash || ''));
  if (!match) return true;
  return Number.parseInt(match[1], 10) < rounds;
}

// ─── Policy ──────────────────────────────────────────────────────────────────

/**
 * Validate a password against the configured policy.
 *
 * @param {string} password
 * @param {object} [policy]
 * @param {number} [policy.minLength=10]
 * @param {boolean} [policy.requireMixedCase=true]
 * @param {boolean} [policy.requireNumber=true]
 * @param {boolean} [policy.requireSymbol=false]
 * @param {string} [policy.email] the account email, to reject domain-derived secrets
 * @returns {{valid: boolean, errors: string[]}}
 */
export function checkPasswordPolicy(password, policy = {}) {
  const {
    minLength = 10,
    requireMixedCase = true,
    requireNumber = true,
    requireSymbol = false,
    email = '',
  } = policy;

  const errors = [];
  const value = typeof password === 'string' ? password : '';

  if (!value) {
    return { valid: false, errors: ['A password is required.'] };
  }
  if (value.length < minLength) {
    errors.push(`Use at least ${minLength} characters.`);
  }
  if (Buffer.byteLength(value, 'utf8') > 72) {
    errors.push('Use 72 characters or fewer.');
  }
  if (/\s/.test(value.trim())) {
    errors.push('Remove the spaces from your password.');
  }
  if (requireMixedCase && !(/[a-z]/.test(value) && /[A-Z]/.test(value))) {
    errors.push('Include an upper and a lower case letter.');
  }
  if (requireNumber && !/\d/.test(value)) {
    errors.push('Include at least one number.');
  }
  if (requireSymbol && !/[^A-Za-z0-9]/.test(value)) {
    errors.push('Include at least one symbol.');
  }

  const lowered = value.toLowerCase();
  if (BLOCKED_PASSWORDS.has(lowered) || BLOCKED_PASSWORDS.has(lowered.replace(/\d+$/, ''))) {
    errors.push('That password is too common.');
  }

  const localPart = String(email).split('@')[0];
  if (localPart && localPart.length >= 3 && lowered.includes(localPart.toLowerCase())) {
    errors.push('Do not reuse your email address in your password.');
  }
  if (DOMAIN_PATTERNS.some((pattern) => pattern.test(lowered))) {
    errors.push('Do not reuse your company name in your password.');
  }

  return { valid: errors.length === 0, errors };
}

/** Generate a compliant random password. Used when an admin creates a mailbox. */
export function generatePassword(length = 16) {
  const size = Math.max(12, Math.min(128, length));
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*';
  const bytes = crypto.randomBytes(size * 2);
  let out = '';
  for (let i = 0; out.length < size; i += 1) {
    const index = bytes[i % bytes.length] % alphabet.length;
    // Never start with a character that reads ambiguously in an email.
    if (i === 0 && '0O1lI'.includes(alphabet[index])) continue;
    out += alphabet[index];
  }
  // Guarantee the policy passes.
  out = `Aa1${out.slice(3)}`;
  return out;
}

/**
 * Rough strength score, 0–4, for the UI meter.
 * Deliberately coarse: it guides the user, it does not replace the server-side
 * policy check.
 */
export function scorePassword(password) {
  const value = String(password || '');
  if (!value) return 0;
  let score = 0;
  if (value.length >= 10) score += 1;
  if (value.length >= 14) score += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
  if (/\d/.test(value)) score += 1;
  if (/[^A-Za-z0-9]/.test(value)) score += 1;
  if (value.length < 8) score = 0;
  return Math.min(score, 4);
}