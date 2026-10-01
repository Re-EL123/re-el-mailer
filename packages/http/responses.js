/**
 * Response helpers.
 *
 * Every endpoint returns the same envelope so the client has one code path:
 *   success → { ok: true,  data: <payload> }
 *   failure → { ok: false, error: { code, message, details? } }
 *
 * `requestId` is echoed in both so a user can quote it in a support request and
 * it can be found in the function logs.
 */

import { randomUUID } from 'node:crypto';
import { AppError, Codes, MESSAGES } from '../shared/errors.js';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** Attach the standard security headers to every API response. */
export function baseHeaders(requestId) {
  return {
    'Content-Type': JSON_CONTENT_TYPE,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'X-Request-Id': requestId,
  };
}

/** Write a JSON response. */
export function sendJson(res, status, payload, { headers = {}, requestId = randomUUID() } = {}) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { ...baseHeaders(requestId), ...headers });
  res.end(JSON.stringify(payload));
}

/** Write a success envelope. */
export function sendData(res, data, { status = 200, headers = {}, requestId } = {}) {
  sendJson(res, status, { ok: true, data, ...(requestId ? { requestId } : {}) }, { headers, requestId });
}

/**
 * Write an error envelope.
 *
 * Only `AppError` messages reach the client. Anything else becomes a generic
 * 500 so driver errors and provider payloads never leak.
 */
export function sendError(res, err, { requestId = randomUUID(), headers = {} } = {}) {
  const appError = err instanceof AppError ? err : new AppError(Codes.INTERNAL_ERROR, MESSAGES[Codes.INTERNAL_ERROR], 500);

  const body = {
    ok: false,
    error: {
      code: appError.code,
      message: appError.expose ? appError.message : MESSAGES[Codes.INTERNAL_ERROR],
      ...(appError.details !== undefined ? { details: appError.details } : null),
    },
    requestId,
  };

  sendJson(res, appError.status, body, { headers: { ...headers, ...appError.headers }, requestId });
}

/** 204 with no body. */
export function sendNoContent(res, headers = {}) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(204, headers);
  res.end();
}

/**
 * Standard error responses for the few cases the pipeline handles itself,
 * before any endpoint code runs.
 */
export const canned = {
  methodNotAllowed: (res, allowed, requestId) =>
    sendJson(
      res,
      405,
      { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'That method is not supported here.' }, requestId },
      { headers: { Allow: allowed.join(', ') }, requestId },
    ),

  notFound: (res, requestId) =>
    sendJson(
      res,
      404,
      { ok: false, error: { code: 'NOT_FOUND', message: MESSAGES[Codes.NOT_FOUND] }, requestId },
      { requestId },
    ),

  payloadTooLarge: (res, limit, requestId) =>
    sendJson(
      res,
      413,
      {
        ok: false,
        error: {
          code: Codes.PAYLOAD_TOO_LARGE,
          message: `That request exceeds the ${Math.round(limit / 1024)} KB limit.`,
        },
        requestId,
      },
      { requestId },
    ),

  unsupportedMediaType: (res, requestId) =>
    sendJson(
      res,
      415,
      {
        ok: false,
        error: { code: Codes.UNSUPPORTED_MEDIA_TYPE, message: MESSAGES[Codes.UNSUPPORTED_MEDIA_TYPE] },
        requestId,
      },
      { requestId },
    ),
};