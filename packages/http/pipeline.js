/**
 * The request pipeline every serverless function shares.
 *
 * One place for the whole cross-cutting sequence, so no endpoint can forget a
 * step:
 *
 *   requestId → CORS/preflight → method check → body limit → content type →
 *   action resolution → authentication → authorisation → rate limit →
 *   validation → handler → success/error envelope
 *
 * Endpoints are declared as an `actions` map keyed by the `?action=` query
 * parameter, which is what keeps the deployment inside the 12-function Vercel
 * limit.
 */

import { randomUUID } from 'node:crypto';
import { app } from '../shared/config.js';
import { AppError, Codes, toAppError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';
import { applyCors, handlePreflight } from './cors.js';
import { parseJsonBody } from './body.js';
import { enforce, limits } from './rate-limit.js';
import { canned, sendData, sendError, sendJson } from './responses.js';
import { clientIp, requireAdmin, requireSession, userAgent } from '../auth/guard.js';
import { isManager } from '../auth/guard.js';

/**
 * @typedef {object} ActionDefinition
 * @property {string|string[]} method
 * @property {(ctx: object) => Promise<any>} handler
 * @property {'none'|'session'} [auth='none']
 * @property {string[]} [roles] require one of these roles
 * @property {number} [rateLimit] per-window request cap
 * @property {number} [rateLimitWindow] window in seconds
 * @property {import('zod').ZodType} [schema] validate `ctx.body`
 * @property {number} [bodyLimit]
 * @property {'json'|'raw'|'multipart'|'none'} [body='json']
 * @property {boolean} [allowLargeJson] opt in to a bodyLimit above the global JSON cap (signature-authenticated webhooks only)
 * @property {(ctx: object) => object} [headers] extra response headers
 */

/**
 * Build a Vercel-compatible handler.
 *
 * @param {object} options
 * @param {string} options.name function name, used in logs
 * @param {Record<string, ActionDefinition>} options.actions
 * @param {string} [options.defaultAction]
 * @param {boolean} [options.writeAudit=true] log a success audit entry per action
 * @returns {(req: object, res: object) => Promise<void>}
 */
export function createHandler({ name, actions, defaultAction = null, audit = {} }) {
  const allowedMethods = new Set();
  for (const [actionName, definition] of Object.entries(actions)) {
    const methods = Array.isArray(definition.method) ? definition.method : [definition.method];
    methods.forEach((method) => allowedMethods.add(method.toUpperCase()));
    if (!definition.method || !definition.handler) {
      throw new Error(`api/${name}.js action "${actionName}" needs a method and a handler`);
    }
  }

  /** @returns {(req: object, res: object) => Promise<void>} */
  return async function handler(req, res) {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const actionName = String(req.query?.action || defaultAction || '').trim();

    const context = {
      requestId,
      function: name,
      action: actionName,
      req,
      res,
      query: req.query || {},
      params: req.params || {},
      body: {},
      rawBody: null,
      session: null,
      ip: clientIp(req),
      userAgent: userAgent(req),
      log: logger.child({ fn: name, action: actionName, rid: requestId }),
      // Handlers set response headers here (Set-Cookie, Location, …) instead of
      // returning them, so the envelope shape stays a single value everywhere.
      responseHeaders: {},
      setHeader(field, value) {
        if (this.responseHeaders[field] === undefined) {
          this.responseHeaders[field] = value;
        } else if (Array.isArray(this.responseHeaders[field])) {
          this.responseHeaders[field].push(value);
        } else {
          this.responseHeaders[field] = [this.responseHeaders[field], value];
        }
        return this;
      },
    };

    try {
      // ── CORS ─────────────────────────────────────────────────────────────
      if (handlePreflight(req, res)) return;
      const originAllowed = applyCors(req, res);
      if (!originAllowed) {
        logger.warn('Rejected cross-origin request', { fn: name, origin: req.headers?.origin });
        sendJson(
          res,
          403,
          { ok: false, error: { code: 'ORIGIN_NOT_ALLOWED', message: 'This origin is not allowed.' }, requestId },
          { requestId },
        );
        return;
      }

      // ── Method + action ──────────────────────────────────────────────────
      const method = String(req.method || 'GET').toUpperCase();
      if (!allowedMethods.has(method)) {
        canned.methodNotAllowed(res, [...allowedMethods], requestId);
        return;
      }

      const definition = actions[actionName] || (defaultAction ? actions[defaultAction] : null);
      if (!definition) {
        if (defaultAction) {
          canned.notFound(res, requestId);
          return;
        }
        sendError(
          res,
          new AppError(
            Codes.BAD_REQUEST,
            actionName
              ? `"${actionName}" is not a supported action for this endpoint.`
              : 'An action is required, for example ?action=list.',
            400,
            { details: { supported: Object.keys(actions).sort() } },
          ),
          { requestId },
        );
        return;
      }

      const methods = (Array.isArray(definition.method) ? definition.method : [definition.method]).map((m) =>
        m.toUpperCase(),
      );
      if (!methods.includes(method)) {
        canned.methodNotAllowed(res, methods, requestId);
        return;
      }

      // ── Body ─────────────────────────────────────────────────────────────
      const bodyLimit = definition.bodyLimit ?? limits.bodyLimit();
      const declaredLength = Number.parseInt(req.headers['content-length'] || '', 10);
      if (Number.isFinite(declaredLength) && declaredLength > bodyLimit) {
        canned.payloadTooLarge(res, bodyLimit, requestId);
        return;
      }

      const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      // A JSON body may not exceed the global cap unless the action explicitly
      // opts in (webhooks are signature-authenticated and legitimately larger).
      if (
        bodyLimit > app.maxBodyBytes &&
        contentType === 'application/json' &&
        !definition.allowLargeJson
      ) {
        throw new AppError(Codes.PAYLOAD_TOO_LARGE, undefined, 413);
      }

      if (definition.body === 'json') {
        context.body = await parseJsonBody(req, { limit: bodyLimit });
      } else if (definition.body === 'none') {
        context.body = {};
      }
      // 'raw' and 'multipart' bodies are parsed by the handler itself.

      // ── Authentication ───────────────────────────────────────────────────
      if (definition.auth === 'session') {
        context.session = await requireSession(req);
      }

      // ── Authorisation ────────────────────────────────────────────────────
      if (definition.roles?.length) {
        if (!context.session) throw new AppError(Codes.AUTH_REQUIRED, undefined, 401);
        const role = context.session.user.role;
        const satisfied = definition.roles.some((allowed) =>
          allowed === 'manager' ? isManager(context.session.user) : allowed === role,
        );
        if (!satisfied) {
          throw new AppError(
            definition.roles.includes('admin') ? Codes.ADMIN_REQUIRED : Codes.FORBIDDEN,
            undefined,
            403,
          );
        }
        if (definition.roles.includes('admin')) requireAdmin(context.session);
      }

      // ── Validation ───────────────────────────────────────────────────────
      // Before the rate limiter on purpose: a malformed request is rejected
      // without spending a database round trip, and validation cannot be used to
      // evade a limit because it never reaches the handler.
      if (definition.schema) {
        const parsed = definition.schema.safeParse(context.body);
        if (!parsed.success) {
          throw new AppError(Codes.VALIDATION_ERROR, undefined, 400, {
            details: parsed.error.issues.map((issue) => ({
              field: issue.path?.join('.') || '(root)',
              message: issue.message,
            })),
          });
        }
        context.body = parsed.data;
      }

      // ── Rate limit ───────────────────────────────────────────────────────
      let rateHeaders = {};
      if (definition.rateLimit !== undefined && definition.rateLimit !== null) {
        const result = await enforce({
          action: `${name}:${actionName}`,
          req,
          session: context.session,
          limit: definition.rateLimit,
          windowSeconds: definition.rateLimitWindow,
        });
        rateHeaders = result.headers;
      }

      // ── Handler ──────────────────────────────────────────────────────────
      const data = await definition.handler(context);

      const responseHeaders = {
        ...rateHeaders,
        ...context.responseHeaders,
        ...(typeof definition.headers === 'function' ? definition.headers(context) : {}),
      };

      // Audit entries declared per action are written after a successful run.
      const auditRule = audit[actionName];
      if (auditRule) {
        const { audit: writeAudit } = await import('../db/system.js');
        await writeAudit({
          actorId: context.session?.user?.id ?? null,
          actorEmail: context.session?.user?.email ?? null,
          action: auditRule.action,
          entityType: auditRule.entityType ?? null,
          entityId: typeof auditRule.entityId === 'function' ? auditRule.entityId(data, context) : (data?.id ?? null),
          ip: context.ip,
          userAgent: context.userAgent,
          metadata: typeof auditRule.metadata === 'function' ? auditRule.metadata(data, context) : auditRule.metadata ?? {},
        });
      }

      if (res.headersSent || res.writableEnded) return;
      if (data === undefined) {
        res.writeHead(204, responseHeaders);
        res.end();
        return;
      }
      sendData(res, data, { status: definition.status || 200, headers: responseHeaders, requestId });
    } catch (err) {
      const appError = toAppError(err);
      const durationMs = Date.now() - startedAt;

      if (appError.status >= 500) {
        logger.exception(`${name}?action=${actionName} failed`, appError.cause || err, {
          requestId,
          durationMs,
          ip: context.ip,
          userId: context.session?.user?.id,
        });
      } else {
        logger.warn(`${name}?action=${actionName} rejected`, {
          requestId,
          code: appError.code,
          status: appError.status,
          durationMs,
        });
      }

      sendError(res, appError, {
        requestId,
        headers: appError.status === 429 ? appError.headers : {},
      });
    }
  };
}

/**
 * Helper for endpoints that also accept a REST-style path (e.g. /api/mail?id=x).
 * Reads a query parameter and validates its presence.
 */
export function requireQuery(ctx, name, { maxLength = 200 } = {}) {
  const value = ctx.query[name];
  if (value === undefined || value === null || value === '') {
    throw new AppError(Codes.VALIDATION_ERROR, `The "${name}" parameter is required.`);
  }
  return String(value).slice(0, maxLength);
}

/** Coerce a query parameter to a bounded integer. */
export function queryInt(ctx, name, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = null } = {}) {
  const raw = ctx.query[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/** Coerce a query parameter to a boolean. */
export function queryBool(ctx, name, fallback = false) {
  const raw = ctx.query[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}