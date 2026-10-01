/**
 * Structured logger.
 *
 * One JSON line per event so Vercel function logs are searchable. Nothing here
 * ever receives a password, token, hash or full message body — callers pass
 * identifiers and counts, not content.
 */

import { env } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** Keys that must never be printed, even if a caller passes them by mistake. */
const REDACT_KEYS = new Set([
  'password',
  'newpassword',
  'currentpassword',
  'passwordhash',
  'token',
  'accesstoken',
  'refreshtoken',
  'resettoken',
  'authorization',
  'cookie',
  'apikey',
  'resendapikey',
  'secret',
  'jwt',
  'bodyhtml',
  'bodytext',
  'rawmime',
  'html',
]);

const MAX_STRING = 512;

function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '[deep]';
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => redact(entry, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value).slice(0, 40)) {
      out[key] = REDACT_KEYS.has(key.toLowerCase()) ? '[redacted]' : redact(entry, depth + 1);
    }
    return out;
  }
  return String(value);
}

function emit(level, message, context) {
  if (LEVELS[level] < LEVELS[env.logLevel]) return;

  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(context ? redact(context) : null),
  };

  const serialised = JSON.stringify(line);
  if (level === 'error' || level === 'warn') console.error(serialised);
  else console.log(serialised);
}

export const logger = {
  debug: (message, context) => emit('debug', message, context),
  info: (message, context) => emit('info', message, context),
  warn: (message, context) => emit('warn', message, context),
  error: (message, context) => emit('error', message, context),

  /**
   * Log an error for diagnosis without leaking it to the client.
   * The stack goes to the log; the caller gets a generic AppError.
   */
  exception: (message, err, context) =>
    emit('error', message, {
      ...context,
      error: err instanceof Error ? err.message : String(err),
      code: err?.code,
      stack: env.logLevel === 'debug' && err instanceof Error ? err.stack : undefined,
    }),

  /** Child logger that stamps every line with a shared context. */
  child(boundContext) {
    return {
      debug: (message, context) => emit('debug', message, { ...boundContext, ...context }),
      info: (message, context) => emit('info', message, { ...boundContext, ...context }),
      warn: (message, context) => emit('warn', message, { ...boundContext, ...context }),
      error: (message, context) => emit('error', message, { ...boundContext, ...context }),
      exception: (message, err, context) =>
        emit('error', message, { ...boundContext, ...context, error: err?.message ?? String(err) }),
    };
  },
};