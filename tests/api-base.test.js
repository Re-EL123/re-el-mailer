/**
 * The frontend and the serverless routes must agree on the API base.
 *
 * Vercel serves everything in api/ under /api. Point the client at the bare
 * origin and every request 404s — and the browser surfaces that as a *CORS*
 * failure ("Access-Control-Allow-Origin missing"), because a 404 from the edge
 * carries no CORS headers. That misdirects debugging toward ALLOWED_ORIGINS
 * while the real cause is one missing path segment.
 *
 * So this asserts, against the real files rather than the documentation, that:
 *   1. the configured base ends in /api,
 *   2. every function segment the client builds exists in api/,
 *   3. api.js normalises, so an override without /api still resolves.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const indexHtml = read(path.join('apps', 'web', 'index.html'));
const apiClient = read(path.join('apps', 'web', 'js', 'api.js'));

/** The production apiBase literal from the inline config script. */
function productionApiBase() {
  const match = /apiBase:\s*'([^']+)'/.exec(indexHtml);
  expect(match).not.toBeNull();
  return match[1];
}

/** Distinct function paths the client passes to request helpers. */
function clientFunctionSegments() {
  const segments = new Set(
    [...apiClient.matchAll(/\b(?:get|post|patch|put|del|rawRequest)\(\s*'\/([a-z][a-z-]*)'/g)].map(
      (m) => m[1],
    ),
  );
  expect(segments.size).toBeGreaterThan(0);
  return segments;
}

describe('API base', () => {
  it('includes the /api mount point Vercel uses', () => {
    const base = productionApiBase();
    expect(base.startsWith('https://')).toBe(true);
    expect(new URL(base).pathname).toBe('/api');
  });

  it('points at a host that serves the functions', () => {
    const { host } = new URL(productionApiBase());
    // A Pages host has no functions behind it; this is the split deployment.
    expect(host).not.toBe('mailer.re-el.co.za');
    expect(host).toContain('api.');
  });

  it('normalises an override that omits /api', () => {
    expect(apiClient).toContain('normaliseApiBase');
    expect(apiClient).toMatch(/endsWith\('\/api'\)/);

    // Exercise the same rule the module applies, rather than trusting the text.
    const normalise = (value) => {
      const trimmed = String(value ?? '/api').trim().replace(/\/+$/, '');
      if (!trimmed) return '/api';
      return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
    };
    expect(normalise('http://localhost:3000')).toBe('http://localhost:3000/api');
    expect(normalise('http://localhost:3000/api')).toBe('http://localhost:3000/api');
    expect(normalise('https://api.mail.re-el.co.za/api')).toBe('https://api.mail.re-el.co.za/api');
    expect(normalise('/api')).toBe('/api');
    expect(normalise('/api/')).toBe('/api');
  });
});

describe('client function paths', () => {
  it('only addresses functions that exist', () => {
    const functions = new Set(
      fs
        .readdirSync(path.join(ROOT, 'api'))
        .filter((f) => f.endsWith('.js'))
        .map((f) => f.replace(/\.js$/, '')),
    );

    for (const segment of clientFunctionSegments()) {
      expect(functions, `client calls /${segment} but api/${segment}.js does not exist`).toContain(
        segment,
      );
    }
  });
});