/**
 * Central configuration.
 *
 * Every environment variable the server needs is read exactly once, here.
 * `required()` throws so a misconfigured deployment fails loudly at the first
 * request instead of silently degrading — and so a missing JWT_SECRET can never
 * fall back to a hardcoded default.
 */

import { loadEnvFile } from './dotenv.js';

loadEnvFile();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `Missing environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function optional(name, fallback = undefined) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return value;
}

function asInt(name, fallback) {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, received "${raw}"`);
  }
  return parsed;
}

function asBool(name, fallback = false) {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function asList(name, fallback = []) {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function asEnum(name, allowed, fallback) {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (!allowed.includes(value)) {
    throw new Error(`Environment variable ${name} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

// ─── Environment ─────────────────────────────────────────────────────────────

export const env = {
  nodeEnv: optional('NODE_ENV', 'development'),
  isProduction: optional('NODE_ENV', 'development') === 'production',
  logLevel: asEnum('LOG_LEVEL', ['debug', 'info', 'warn', 'error', 'silent'], 'info'),
};

// ─── App ─────────────────────────────────────────────────────────────────────

export const app = {
  name: 'Re-EL Mailer',
  url: (optional('APP_URL', 'http://localhost:3000') || 'http://localhost:3000').replace(/\/+$/, ''),
  allowedOrigins: (() => {
    const explicit = asList('ALLOWED_ORIGINS');
    const fromAppUrl = optional('APP_URL');
    const combined = [...explicit];
    if (fromAppUrl) combined.push(fromAppUrl.replace(/\/+$/, ''));
    if (combined.length === 0) combined.push('http://localhost:3000', 'http://localhost:5173');
    return [...new Set(combined)];
  })(),
  /** Maximum JSON body size accepted by any endpoint (bytes). */
  maxBodyBytes: asInt('MAX_BODY_BYTES', 1_048_576),
};

// ─── Database ────────────────────────────────────────────────────────────────

export const database = {
  url: () => required('DATABASE_URL'),
  directUrl: () => optional('DIRECT_URL', process.env.DATABASE_URL),
  ssl: asBool('DATABASE_SSL', true),
  rejectUnauthorized: asBool('DATABASE_SSL_REJECT_UNAUTHORIZED', false),
  maxConnections: asInt('DATABASE_POOL_MAX', 5),
  statementTimeoutMs: asInt('DATABASE_STATEMENT_TIMEOUT_MS', 8_000),
  connectionTimeoutMs: asInt('DATABASE_CONNECTION_TIMEOUT_MS', 8_000),
  idleTimeoutMs: asInt('DATABASE_IDLE_TIMEOUT_MS', 10_000),
};

/**
 * Shared secret Vercel Cron presents as `Authorization: Bearer …`. When it is
 * unset the maintenance endpoint refuses to run from cron, so an unconfigured
 * deployment can never be driven by an unauthenticated caller.
 */
export const cron = {
  secret: () => optional('CRON_SECRET'),
};

// ─── Supabase (Storage) ──────────────────────────────────────────────────────

export const supabase = {
  url: () => required('SUPABASE_URL'),
  serviceRoleKey: () => required('SUPABASE_SERVICE_ROLE_KEY'),
};

// ─── Authentication ──────────────────────────────────────────────────────────

export const auth = {
  jwtSecret: () => required('JWT_SECRET'),
  accessTokenTtl: optional('ACCESS_TOKEN_TTL', '15m'),
  refreshTokenTtlDays: asInt('REFRESH_TOKEN_TTL_DAYS', 30),
  cookieSecure: asBool('COOKIE_SECURE', env.isProduction),
  cookieSameSite: asEnum('COOKIE_SAMESITE', ['lax', 'strict', 'none'], 'lax'),
  cookieName: optional('REFRESH_COOKIE_NAME', 'reel_refresh'),
  passwordResetTtlMinutes: asInt('PASSWORD_RESET_TTL_MINUTES', 30),
  /** Issuer / audience for access tokens. */
  issuer: 're-el-mailer',
  audience: 're-el-mailer-app',
  bcryptRounds: asInt('BCRYPT_ROUNDS', 12),

  /**
   * Return the raw password-reset token in the API response so the flow can be
   * exercised without an email provider.
   *
   * Deliberately NOT inferred from NODE_ENV. The forgot-password endpoint is
   * unauthenticated, so a token in that response is a reset of anybody's
   * account. It used to be gated on `!env.isProduction`, and production had
   * NODE_ENV=development set in its environment — which left the token in the
   * response for every active address on a live deployment. A wrong NODE_ENV
   * should never be able to open this, so it needs its own flag, defaulting off.
   */
  exposeResetTokens: asBool('DEV_EXPOSE_RESET_TOKENS', false),
};

// ─── Mail / Resend ───────────────────────────────────────────────────────────

export const mail = {
  apiKey: () => required('RESEND_API_KEY'),
  fromEmail: optional('MAIL_FROM_EMAIL', 'akani@re-el.co.za'),
  fromName: optional('MAIL_FROM_NAME', 'Re-EL Mailer'),
  replyTo: optional('MAIL_REPLY_TO', ''),
  bounceAddress: optional('MAIL_BOUNCE_ADDRESS', ''),
  domains: asList('MAIL_DOMAINS', ['re-el.co.za']),
  inboundWebhookSecret: () => optional('RESEND_INBOUND_WEBHOOK_SECRET'),
  eventWebhookSecret: () => optional('RESEND_EVENT_WEBHOOK_SECRET'),
  dailyLimitUser: asInt('SEND_DAILY_LIMIT_USER', 100),
  hourlyLimitUser: asInt('SEND_HOURLY_LIMIT_USER', 25),
  dailyLimitAdmin: asInt('SEND_DAILY_LIMIT_ADMIN', 1000),
  hourlyLimitAdmin: asInt('SEND_HOURLY_LIMIT_ADMIN', 250),
  dailyLimitDomain: asInt('SEND_DAILY_LIMIT_DOMAIN', 5000),
  maxRecipients: asInt('SEND_MAX_RECIPIENTS', 25),
  maxBcc: asInt('SEND_MAX_RECIPIENTS_BCC', 50),
  maxSubjectLength: asInt('SEND_MAX_SUBJECT_LENGTH', 200),
  maxBodyBytes: asInt('SEND_MAX_BODY_BYTES', 512_000),
  storeRawMime: asBool('STORE_RAW_MIME', false),
  inboundMaxBytes: asInt('INBOUND_MAX_BYTES', 26_214_400),
  inboundAutoReadSenders: asList('INBOUND_AUTO_READ_SENDERS'),
  attachmentBucket: optional('ATTACHMENT_BUCKET', 'mail-attachments'),
  attachmentMaxBytes: asInt('ATTACHMENT_MAX_BYTES', 10_485_760),
  /** Delay between Resend calls to stay inside provider rate limits. */
  requestDelayMs: asInt('RESEND_REQUEST_DELAY_MS', 0),
};

// ─── Rate limiting ───────────────────────────────────────────────────────────

export const rateLimit = {
  enabled: asBool('RATE_LIMIT_ENABLED', true),
  windowSeconds: asInt('RATE_LIMIT_WINDOW_SECONDS', 60),
  maxRequests: asInt('RATE_LIMIT_MAX_REQUESTS', 120),
  maxAuthAttempts: asInt('RATE_LIMIT_MAX_AUTH_ATTEMPTS', 10),
  maxSend: asInt('RATE_LIMIT_MAX_SEND', 30),
  maxSearch: asInt('RATE_LIMIT_MAX_SEARCH', 90),
};

// ─── Health ──────────────────────────────────────────────────────────────────

export const health = {
  token: () => optional('HEALTHCHECK_TOKEN'),
};

/**
 * Fail fast on startup when a required secret is missing. Called by the CLI
 * scripts and by /api/health?action=diag so problems surface early.
 */
export function assertProductionConfig() {
  const missing = [];
  for (const [name, getter] of [
    ['DATABASE_URL', database.url],
    ['SUPABASE_URL', supabase.url],
    ['SUPABASE_SERVICE_ROLE_KEY', supabase.serviceRoleKey],
    ['JWT_SECRET', auth.jwtSecret],
    ['RESEND_API_KEY', mail.apiKey],
  ]) {
    try {
      getter();
    } catch {
      missing.push(name);
    }
  }

  const weakSecret = process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32;
  return { missing, weakSecret: Boolean(weakSecret) };
}