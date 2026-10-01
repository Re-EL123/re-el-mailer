#!/usr/bin/env node
/**
 * Static file server for the frontend during development.
 *
 * Serves `apps/web`, resolves `/` to `index.html`, and proxies `/api/*` to the
 * API dev server (default http://localhost:3000, where `vercel dev` runs) so the
 * SPA and the API share an origin and cookies behave as they do in production.
 *
 * Usage:
 *   npm run dev:api        # terminal 1 — vercel dev on :3000
 *   npm run dev:web        # terminal 2 — this, on :5173
 *
 * No dependencies: a plain node:http server.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../packages/shared/dotenv.js';

const WEB_ROOT = path.join(REPO_ROOT, 'apps', 'web');
const PORT = Number(process.env.PORT || 5173);
const API_TARGET = process.env.API_TARGET || 'http://localhost:3000';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function proxy(req, res) {
  const target = new URL(req.url, API_TARGET);
  const proxyReq = http.request(
    target,
    { method: req.method, headers: { ...req.headers, host: target.host } },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: { code: 'UPSTREAM', message: `API unreachable: ${err.message}` } }));
  });
  req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    proxy(req, res);
    return;
  }

  // Resolve the file, defaulting to index.html for SPA routes.
  // Containment is checked with path.relative rather than startsWith: the string
  // "/apps/web-evil" also startsWith "/apps/web", so a sibling directory would
  // pass the prefix test and be served.
  let filePath = path.resolve(WEB_ROOT, `.${decodeURIComponent(url.pathname)}`);
  const relative = path.relative(WEB_ROOT, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(WEB_ROOT, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
  // No caching in dev so edits show up immediately.
  headers['Cache-Control'] = 'no-store';

  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`Web dev server: http://localhost:${PORT}`);
  console.log(`Proxying /api/* → ${API_TARGET}`);
});