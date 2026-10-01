/**
 * Application error taxonomy.
 *
 * Rules:
 *   - Every error surfaced to a client has a stable machine code.
 *   - Internal details (SQL text, stack traces, provider payloads) are logged
 *     server-side and never serialised into a response.
 *   - `toAppError()` collapses anything unknown into a generic 500 so an
 *     unexpected driver or Supabase error cannot leak internals to a browser.
 */

export const Codes = {
  // 400
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',

  // 401 / 403
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_INVALID: 'AUTH_INVALID',
  AUTH_EXPIRED: 'AUTH_EXPIRED',
  SESSION_REVOKED: 'SESSION_REVOKED',
  FORBIDDEN: 'FORBIDDEN',
  ADMIN_REQUIRED: 'ADMIN_REQUIRED',
  MAILBOX_FORBIDDEN: 'MAILBOX_FORBIDDEN',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',

  // 404 / 409
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  ALREADY_EXISTS: 'ALREADY_EXISTS',

  // 413 / 415 / 422
  ATTACHMENT_TOO_LARGE: 'ATTACHMENT_TOO_LARGE',
  UNSUPPORTED_ATTACHMENT: 'UNSUPPORTED_ATTACHMENT',
  MAILBOX_QUOTA_EXCEEDED: 'MAILBOX_QUOTA_EXCEEDED',

  // 429
  RATE_LIMITED: 'RATE_LIMITED',
  SEND_LIMIT_EXCEEDED: 'SEND_LIMIT_EXCEEDED',

  // 5xx
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  DATABASE_ERROR: 'DATABASE_ERROR',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  STORAGE_ERROR: 'STORAGE_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',
};

const STATUS_BY_CODE = {
  [Codes.VALIDATION_ERROR]: 400,
  [Codes.BAD_REQUEST]: 400,
  [Codes.UNSUPPORTED_MEDIA_TYPE]: 415,
  [Codes.PAYLOAD_TOO_LARGE]: 413,

  [Codes.AUTH_REQUIRED]: 401,
  [Codes.AUTH_INVALID]: 401,
  [Codes.AUTH_EXPIRED]: 401,
  [Codes.SESSION_REVOKED]: 401,
  [Codes.FORBIDDEN]: 403,
  [Codes.ADMIN_REQUIRED]: 403,
  [Codes.MAILBOX_FORBIDDEN]: 403,
  [Codes.ACCOUNT_LOCKED]: 423,
  [Codes.ACCOUNT_DISABLED]: 403,

  [Codes.NOT_FOUND]: 404,
  [Codes.CONFLICT]: 409,
  [Codes.ALREADY_EXISTS]: 409,

  [Codes.ATTACHMENT_TOO_LARGE]: 413,
  [Codes.UNSUPPORTED_ATTACHMENT]: 415,
  [Codes.MAILBOX_QUOTA_EXCEEDED]: 507,

  [Codes.RATE_LIMITED]: 429,
  [Codes.SEND_LIMIT_EXCEEDED]: 429,

  [Codes.INTERNAL_ERROR]: 500,
  [Codes.DATABASE_ERROR]: 500,
  [Codes.UPSTREAM_ERROR]: 502,
  [Codes.STORAGE_ERROR]: 502,
  [Codes.SERVICE_UNAVAILABLE]: 503,
  [Codes.SIGNATURE_INVALID]: 401,
};

/** Errors safe to show a user, with a human-readable default message. */
export const MESSAGES = {
  [Codes.VALIDATION_ERROR]: 'Some of the details provided are not valid.',
  [Codes.BAD_REQUEST]: 'That request could not be understood.',
  [Codes.UNSUPPORTED_MEDIA_TYPE]: 'That content type is not supported.',
  [Codes.PAYLOAD_TOO_LARGE]: 'That request was too large.',
  [Codes.AUTH_REQUIRED]: 'Please sign in to continue.',
  [Codes.AUTH_INVALID]: 'Your session is not valid. Please sign in again.',
  [Codes.AUTH_EXPIRED]: 'Your session has expired. Please sign in again.',
  [Codes.SESSION_REVOKED]: 'Your session has ended. Please sign in again.',
  [Codes.FORBIDDEN]: 'You do not have permission to do that.',
  [Codes.ADMIN_REQUIRED]: 'Administrator access is required.',
  [Codes.MAILBOX_FORBIDDEN]: 'You do not have access to that mailbox.',
  [Codes.ACCOUNT_LOCKED]: 'This account is temporarily locked.',
  [Codes.ACCOUNT_DISABLED]: 'This account has been disabled.',
  [Codes.NOT_FOUND]: 'That item could not be found.',
  [Codes.CONFLICT]: 'That change conflicts with the current state.',
  [Codes.ALREADY_EXISTS]: 'That already exists.',
  [Codes.ATTACHMENT_TOO_LARGE]: 'That attachment is too large.',
  [Codes.UNSUPPORTED_ATTACHMENT]: 'That file type cannot be attached.',
  [Codes.MAILBOX_QUOTA_EXCEEDED]: 'This mailbox has reached its storage quota.',
  [Codes.RATE_LIMITED]: 'Too many requests. Please slow down.',
  [Codes.SEND_LIMIT_EXCEEDED]: 'You have reached your sending limit.',
  [Codes.INTERNAL_ERROR]: 'Something went wrong on our side.',
  [Codes.DATABASE_ERROR]: 'A database error occurred.',
  [Codes.UPSTREAM_ERROR]: 'The email provider could not be reached.',
  [Codes.STORAGE_ERROR]: 'File storage is unavailable.',
  [Codes.SERVICE_UNAVAILABLE]: 'The service is temporarily unavailable.',
  [Codes.SIGNATURE_INVALID]: 'Invalid webhook signature.',
};

export class AppError extends Error {
  /**
   * @param {string} code    one of Codes
   * @param {string} [message] user-facing message (keep it non-technical)
   * @param {number} [status] override the default status for this code
   * @param {object} [options]
   * @param {unknown} [options.details] structured, non-sensitive detail
   * @param {unknown} [options.cause]  original error, logged but never sent
   * @param {Record<string,string>} [options.headers] extra response headers
   */
  constructor(code, message, status, options = {}) {
    super(message || MESSAGES[code] || 'Something went wrong.');
    this.name = 'AppError';
    this.code = code;
    this.status = status || STATUS_BY_CODE[code] || 500;
    this.details = options.details;
    this.cause = options.cause;
    this.headers = options.headers || {};
    this.expose = true;
  }
}

/** Convenience constructors for the errors used most often. */
export const badRequest = (message, details) =>
  new AppError(Codes.BAD_REQUEST, message, 400, { details });

export const validationError = (message, details) =>
  new AppError(Codes.VALIDATION_ERROR, message, 400, { details });

export const notFound = (message) => new AppError(Codes.NOT_FOUND, message);

export const forbidden = (message) => new AppError(Codes.FORBIDDEN, message);

export const unauthorized = (message, code = Codes.AUTH_REQUIRED) =>
  new AppError(code, message);

/**
 * Map any thrown value onto an AppError.
 * Zod issues become a field-level 400; Postgres constraint names become
 * readable conflicts; everything else becomes an opaque 500.
 */
export function toAppError(err) {
  if (err instanceof AppError) return err;

  if (err && err.name === 'ZodError' && Array.isArray(err.issues)) {
    return new AppError(Codes.VALIDATION_ERROR, MESSAGES[Codes.VALIDATION_ERROR], 400, {
      details: err.issues.map((issue) => ({
        field: issue.path?.join('.') || '(root)',
        message: issue.message,
      })),
      cause: err,
    });
  }

  const message = typeof err?.message === 'string' ? err.message : '';

  if (message === 'MAILBOX_QUOTA_EXCEEDED') {
    return new AppError(Codes.MAILBOX_QUOTA_EXCEEDED, undefined, 507, { cause: err });
  }

  // Postgres unique violation → conflict, without echoing the constraint SQL.
  if (err && (err.code === '23505' || /duplicate key value/i.test(message))) {
    return new AppError(Codes.ALREADY_EXISTS, undefined, 409, { cause: err });
  }
  if (err && (err.code === '23503' || /foreign key/i.test(message))) {
    return new AppError(Codes.CONFLICT, undefined, 409, { cause: err });
  }
  if (err && (err.code === '23514' || /check constraint/i.test(message))) {
    return new AppError(Codes.VALIDATION_ERROR, undefined, 400, { cause: err });
  }
  if (err && (err.code === '57014' || /statement timeout/i.test(message))) {
    return new AppError(Codes.SERVICE_UNAVAILABLE, MESSAGES[Codes.SERVICE_UNAVAILABLE], 503, {
      cause: err,
    });
  }
  if (err && (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === '57P01')) {
    return new AppError(Codes.DATABASE_ERROR, MESSAGES[Codes.DATABASE_ERROR], 503, { cause: err });
  }

  return new AppError(Codes.INTERNAL_ERROR, MESSAGES[Codes.INTERNAL_ERROR], 500, { cause: err });
}

/** True when the error is safe to serialise to the client. */
export function isClientSafe(err) {
  return err instanceof AppError && err.expose;
}