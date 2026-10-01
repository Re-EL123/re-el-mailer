/**
 * Rate limiting.
 *
 * Counters live in Postgres (`rate_limits`) rather than in process memory: a
 * serverless instance cache is not shared between concurrent invocations, so an
 * in-memory limiter under-counts by however many instances are warm.
 *
 * Buckets are keyed by action + actor (user id when known, otherwise client IP)
 * so one noisy user cannot exhaust a shared budget, and a single unauthenticated
 * IP cannot lock out everyone behind the same NAT.
 */

import { rateLimit as config, app as appConfig } from '../shared/config.js';
import { AppError, Codes } from '../shared/errors.js';
import { hitRateLimit } from '../db/system.js';
import { clientIp } from '../auth/guard.js';

/** Build the bucket key for a request. */
export function bucketKeyFor(action, req, session = null) {
  const actor = session?.user?.id || session?.claims?.sub || clientIp(req) || 'anonymous';
  return `${action}:${actor}`;
}

/**
 * Consume one unit from a bucket.
 * @returns {Promise<{allowed: boolean, remaining: number, resetAt: string, retryAfterSeconds: number, count: number}>}
 */
export async function consume(key, limit, windowSeconds = config.windowSeconds) {
  if (!config.enabled) {
    return { allowed: true, remaining: limit, resetAt: new Date().toISOString(), retryAfterSeconds: 0, count: 0 };
  }
  return hitRateLimit(key, { limit, windowSeconds });
}

/**
 * Assert that a request is within its rate limit.
 * @throws {AppError} 429 with Retry-After and X-RateLimit-* headers
 */
export async function enforce({ action, req, session = null, limit, windowSeconds = config.windowSeconds }) {
  const key = bucketKeyFor(action, req, session);
  const result = await consume(key, limit ?? config.maxRequests, windowSeconds);

  if (!result.allowed) {
    throw new AppError(Codes.RATE_LIMITED, undefined, 429, {
      headers: {
        'Retry-After': String(result.retryAfterSeconds),
        'X-RateLimit-Limit': String(limit ?? config.maxRequests),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': result.resetAt,
      },
      details: { retryAfterSeconds: result.retryAfterSeconds },
    });
  }

  return {
    key,
    ...result,
    headers: {
      'X-RateLimit-Limit': String(limit ?? config.maxRequests),
      'X-RateLimit-Remaining': String(result.remaining),
      'X-RateLimit-Reset': result.resetAt,
    },
  };
}

/**
 * A very cheap in-process limiter for the paths that must not touch the
 * database at all: health checks and static-asset probes. Per-instance by
 * design — it is a courtesy, not a control.
 */
const memoryBuckets = new Map();

export function enforceMemory(action, limit = 60, windowSeconds = 60) {
  const key = `${action}:${process.pid}`;
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const entry = memoryBuckets.get(key);

  if (!entry || now - entry.start >= windowMs) {
    memoryBuckets.set(key, { start: now, count: 1 });
    return { allowed: true, remaining: limit - 1 };
  }

  entry.count += 1;
  if (memoryBuckets.size > 1000) memoryBuckets.clear();
  return { allowed: entry.count <= limit, remaining: Math.max(0, limit - entry.count) };
}

/** Named limits used across the API. */
export const limits = {
  default: () => config.maxRequests,
  auth: () => config.maxAuthAttempts,
  send: () => config.maxSend,
  search: () => config.maxSearch,
  webhook: () => 600,
  bodyLimit: () => appConfig.maxBodyBytes,
};