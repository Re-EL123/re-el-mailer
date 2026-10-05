#!/usr/bin/env node
/**
 * Project-wide static check.
 *
 *   1. Every JavaScript file parses.
 *   2. Every relative import resolves to a file that exists.
 *   3. The Vercel function count stays at or below the Hobby limit of 12.
 *   4. Every API function default-exports a handler.
 *   5. No API key, JWT or connection string appears in the frontend.
 *   6. Required project files exist.
 *
 * Usage: npm run check   (aliased as `npm run lint` and `npm run typecheck`)
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_FUNCTIONS = 12;
const SKIP_DIRS = new Set(['node_modules', '.git', '.vercel', 'coverage', 'dist', '.cache']);

let errors = 0;
let warnings = 0;

const fail = (message) => {
  errors += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${message}`);
};
const warn = (message) => {
  warnings += 1;
  console.warn(`  \x1b[33m!\x1b[0m ${message}`);
};
const pass = (message) => console.log(`  \x1b[32m✓\x1b[0m ${message}`);
const relative = (file) => path.relative(ROOT, file) || path.basename(file);

function walk(dir, predicate, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, predicate, out);
    } else if (entry.isFile() && predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

const isJs = (file) => file.endsWith('.js');

// ─── 1. Syntax ───────────────────────────────────────────────────────────────

console.log('\n\x1b[1m1. JavaScript syntax\x1b[0m');

/**
 * Parse a file without executing it.
 *
 * Node's own parser does the work, in a short-lived `node --check` child
 * process. Everything in this repository is ESM — the server code because
 * package.json sets `"type": "module"`, the frontend because it loads with
 * `<script type="module">` — and Node's parser handles `import`/`export` in
 * both. A frontend file that happens to be a classic script (no import/export)
 * still parses as a module, so one code path covers the whole tree.
 */
function checkSyntax(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    const message = (result.stderr || '').split('\n').find((line) => /Error/.test(line)) || 'parse error';
    throw new Error(message.trim());
  }
}

const jsFiles = walk(ROOT, isJs);
let syntaxOk = 0;
for (const file of jsFiles) {
  try {
    checkSyntax(file);
    syntaxOk += 1;
  } catch (err) {
    fail(`${relative(file)}: ${err.message}`);
  }
}
if (syntaxOk === jsFiles.length) pass(`${jsFiles.length} files parsed`);

// ─── 2. Imports resolve ──────────────────────────────────────────────────────

console.log('\n\x1b[1m2. Relative imports\x1b[0m');
const STATIC_IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"](\.[^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g;
let importCount = 0;
let missing = 0;

for (const file of jsFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const specifiers = [
    ...[...source.matchAll(STATIC_IMPORT_RE)].map((m) => m[1]),
    ...[...source.matchAll(DYNAMIC_IMPORT_RE)].map((m) => m[1]),
  ];
  for (const specifier of specifiers) {
    importCount += 1;
    if (!fs.existsSync(path.resolve(path.dirname(file), specifier))) {
      fail(`${relative(file)} → ${specifier} (not found)`);
      missing += 1;
    }
  }
}
if (missing === 0) pass(`${importCount} relative imports resolve`);

// ─── 3. Vercel function budget ───────────────────────────────────────────────

console.log('\n\x1b[1m3. Vercel function budget\x1b[0m');
const apiDir = path.join(ROOT, 'api');
const functions = fs.existsSync(apiDir)
  ? fs.readdirSync(apiDir).filter((name) => name.endsWith('.js')).map((name) => name.replace(/\.js$/, ''))
  : [];

if (functions.length === 0) fail('no serverless functions found in api/');
else if (functions.length > MAX_FUNCTIONS) fail(`${functions.length} functions exceeds the Hobby limit of ${MAX_FUNCTIONS}`);
else pass(`${functions.length} / ${MAX_FUNCTIONS} functions: ${functions.sort().join(', ')}`);

for (const name of functions) {
  const source = fs.readFileSync(path.join(apiDir, `${name}.js`), 'utf8');
  if (!/export\s+default\s+/.test(source)) fail(`api/${name}.js has no default export`);
}

// The functions are deployed unbundled: each .func ships api/, packages/ and
// node_modules/, so the whole repo has to be uploaded. That is also why the
// static output directory must be an explicit, near-empty path — otherwise
// Vercel serves the entire source tree (schema.sql, docs/security.md and all)
// from the API domain. Both mistakes were made here once; both are cheap to
// reintroduce, so both are checked.
console.log('\n\x1b[1m3b. Vercel static output\x1b[0m');
const vercelConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

if (vercelConfig.buildCommand === null || vercelConfig.buildCommand === undefined) {
  fail('vercel.json leaves buildCommand unset; Vercel then auto-runs the package.json "build" script and then demands a public/ directory');
} else if (vercelConfig.buildCommand === '') {
  pass('vercel.json disables the build step (buildCommand: "")');
} else {
  pass(`vercel.json buildCommand: ${vercelConfig.buildCommand}`);
}

const outputDirectory = vercelConfig.outputDirectory;
if (!outputDirectory) {
  fail('vercel.json has no outputDirectory; Vercel publishes the repository root as static files, exposing schema.sql and docs/ on the API domain');
} else if (!fs.existsSync(path.join(ROOT, outputDirectory))) {
  fail(`vercel.json outputDirectory "${outputDirectory}" does not exist in the repository`);
} else {
  const entries = fs
    .readdirSync(path.join(ROOT, outputDirectory), { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => e.name);
  if (entries.length === 0) pass(`outputDirectory "${outputDirectory}" exists and is empty`);
  else fail(`outputDirectory "${outputDirectory}" would publish ${entries.join(', ')} on the API domain; it should hold nothing but dotfiles`);
}

// A CNAME only helps if the hostname it pins matches what the docs and .env
// example tell operators to configure, or every cookie and CORS origin is off.
const cnamePath = path.join(ROOT, 'apps', 'web', 'CNAME');
if (fs.existsSync(cnamePath)) {
  const cname = fs.readFileSync(cnamePath, 'utf8').trim();
  const envText = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const appUrl = (/^APP_URL=(.*)$/m.exec(envText) || [])[1]?.trim();
  if (!cname) fail('apps/web/CNAME is empty');
  else if (appUrl && new URL(appUrl).host !== cname) {
    fail(`apps/web/CNAME is ${cname} but .env.example sets APP_URL=${appUrl}; the two must agree`);
  } else {
    pass(`apps/web/CNAME (${cname}) matches APP_URL (${appUrl})`);
  }
}

// ─── 4. Frontend secret scan ─────────────────────────────────────────────────

console.log('\n\x1b[1m4. Frontend secret scan\x1b[0m');
const SECRET_PATTERNS = [
  [/\bre_[A-Za-z0-9]{16,}/, 'Resend API key'],
  [/service[_-]?role[_-]?key\s*[:=]\s*['"][^'"]{8,}/i, 'Supabase service role key'],
  [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, 'JWT'],
  [/postgres(ql)?:\/\/[^\s'"`]+:[^\s'"@]+@/i, 'database URL with a password'],
  [/\b(JWT_SECRET|RESEND_API_KEY|DATABASE_URL)\s*[:=]\s*['"][^'"]+/, 'server secret literal'],
];

let secretHits = 0;
for (const file of walk(path.join(ROOT, 'apps'), (f) => /\.(js|html|json|css|webmanifest|svg)$/.test(f))) {
  const source = fs.readFileSync(file, 'utf8');
  for (const [pattern, label] of SECRET_PATTERNS) {
    if (pattern.test(source)) {
      fail(`${relative(file)} appears to contain a ${label}`);
      secretHits += 1;
    }
  }
}
if (secretHits === 0) pass('no keys, tokens or connection strings in apps/');

// ─── 4b. Text-safe source ────────────────────────────────────────────────────

// A raw control byte inside a regex literal is legal JavaScript and passes every
// syntax check, but it makes the file binary to grep, git diff and every editor
// — so the file silently drops out of review and search. Both occurrences were
// character classes written with real bytes instead of \x escapes.
console.log('\n\x1b[1m4b. Text-safe source files\x1b[0m');
const TEXT_EXT = /\.(js|mjs|cjs|json|md|sql|css|html|webmanifest|svg|yml|yaml)$/;
let binaryFiles = 0;
for (const file of walk(ROOT, (f) => TEXT_EXT.test(f) && f !== '.env.example')) {
  const bytes = fs.readFileSync(file);
  const offenders = bytes.filter((b) => b < 9 || (b > 13 && b < 32) || b === 127);
  if (offenders.length > 0) {
    const line = bytes.slice(0, bytes.indexOf(offenders[0])).toString('utf8').split('\n').length;
    fail(`${relative(file)} contains ${offenders.length} raw control byte(s) (first on line ${line}); write them as \\x escapes`);
    binaryFiles += 1;
  }
}
if (binaryFiles === 0) pass('no raw control bytes in source files');

// ─── 5. Required files ───────────────────────────────────────────────────────

console.log('\n\x1b[1m5. Project files\x1b[0m');
const required = [
  'package.json',
  'vercel.json',
  '.env.example',
  '.gitignore',
  'README.md',
  'database/schema.sql',
  'docs/architecture.md',
  'docs/security.md',
  'docs/deployment.md',
  'apps/web/manifest.json',
  'apps/web/service-worker.js',
];
for (const rel of required) {
  if (fs.existsSync(path.join(ROOT, rel))) pass(rel);
  else fail(`missing ${rel}`);
}

// Documentation that names a command which does not exist is worse than no
// documentation: `npm run migrate` reads perfectly and exits non-zero. Four such
// names were documented while the scripts were `db:migrate`, `db:reset`,
// `db:seed`, `dev:web` and `build`.
console.log('\n\x1b[1m5b. Documented commands exist\x1b[0m');
const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
let badCommands = 0;
for (const rel of ['README.md', 'docs/deployment.md', 'docs/architecture.md', 'docs/security.md']) {
  const docPath = path.join(ROOT, rel);
  if (!fs.existsSync(docPath)) continue;
  const source = fs.readFileSync(docPath, 'utf8');
  for (const match of source.matchAll(/\bnpm run ([a-z][a-z0-9:_-]*)/g)) {
    if (!Object.hasOwn(scripts, match[1])) {
      fail(`${rel} says \`npm run ${match[1]}\`, which is not a script in package.json`);
      badCommands += 1;
    }
  }
}
if (badCommands === 0) {
  pass(`every documented npm script exists (${Object.keys(scripts).length} defined)`);
}

if (fs.existsSync(path.join(ROOT, '.env'))) {
  warn('.env exists locally — confirm it stays untracked (it is gitignored)');
}

// ─── 6. Environment contract ─────────────────────────────────────────────────

console.log('\n\x1b[1m6. Environment contract\x1b[0m');

// Every key the config module reads must appear in .env.example. An undocumented
// tunable is one nobody sets on the deployment that needs it — and, worse, one
// whose default silently differs in production.
const configSource = fs.readFileSync(path.join(ROOT, 'packages', 'shared', 'config.js'), 'utf8');
const readKeys = new Set(
  [...configSource.matchAll(/\bas(?:Bool|Int|Str|List)\(\s*'([A-Z0-9_]+)'/g)].map((m) => m[1]),
);
const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
const documentedKeys = new Set(
  [...envExample.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]),
);

const undocumented = [...readKeys].filter((key) => !documentedKeys.has(key)).sort();
if (undocumented.length === 0) pass(`all ${readKeys.size} config keys are documented in .env.example`);
else for (const key of undocumented) fail(`config reads ${key} but .env.example does not document it`);

const emptyRequired = [...envExample.matchAll(/^([A-Z0-9_]+)=\s*$/gm)]
  .map((m) => m[1])
  .filter((key) => !/^(RESEND_API_KEY|JWT_SECRET|SUPABASE_SERVICE_ROLE_KEY|DATABASE_URL|CRON_SECRET|RESEND_INBOUND_WEBHOOK_SECRET|RESEND_EVENT_WEBHOOK_SECRET|HEALTHCHECK_TOKEN|MAIL_REPLY_TO|INBOUND_AUTO_READ_SENDERS|MAIL_FROM_EMAIL)$/.test(key));
// Values left blank are secrets or deployment-specific; a blank default for
// anything else would silently ship a placeholder.
if (emptyRequired.length === 0) pass('no unintended blank values in .env.example');
else for (const key of emptyRequired) fail(`.env.example leaves ${key} blank; give it a default or a comment saying why`);

// ─── 7. Static asset references ──────────────────────────────────────────────

console.log('\n\x1b[1m7. Static asset references\x1b[0m');

// A typo'd icon path breaks install and offline caching but no test would notice,
// so verify every local asset named by the manifest, the service worker and the
// HTML entry actually exists on disk.
const WEB = path.join(ROOT, 'apps', 'web');
const assetRefs = [];

const manifestPath = path.join(WEB, 'manifest.json');
if (fs.existsSync(manifestPath)) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    fail(`apps/web/manifest.json is not valid JSON: ${err.message}`);
  }
  for (const icon of manifest?.icons ?? []) {
    if (icon.src) assetRefs.push({ from: 'manifest.json', ref: icon.src });

// Every <link rel="...icon"> and og/twitter image in index.html. These are the
// assets a home-screen shortcut or a link preview actually loads, and none of
// them are referenced anywhere else, so nothing else would notice one going
// missing.
{
  const htmlPath = path.join(WEB, 'index.html');
  const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '';
  for (const match of html.matchAll(/<link[^>]+rel="[^"]*icon"[^>]+href="([^"]+)"/g)) {
    assetRefs.push({ from: 'index.html', ref: match[1] });
  }
  for (const match of html.matchAll(/<meta[^>]+(?:property|name)="(?:og:image|twitter:image)"[^>]+content="([^"]+)"/g)) {
    // Only the local ones; absolute CDN URLs are not in this repository.
    if (!/^https?:/i.test(match[1])) assetRefs.push({ from: 'index.html', ref: match[1] });
  }
}
  }
}

const swPath = path.join(WEB, 'service-worker.js');
if (fs.existsSync(swPath)) {
  const swSource = fs.readFileSync(swPath, 'utf8');
  const precache = swSource.match(/PRECACHE\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? '';
  for (const match of precache.matchAll(/['"]([^'"]+)['"]/g)) {
    const ref = match[1];
    if (ref === './' || /^[a-z]+:\/\//i.test(ref)) continue;
    assetRefs.push({ from: 'service-worker.js', ref });
  }
}

const indexPath = path.join(WEB, 'index.html');
if (fs.existsSync(indexPath)) {
  const html = fs.readFileSync(indexPath, 'utf8');
  for (const match of html.matchAll(/(?:href|src)="(?!https?:|data:|#|mailto:)([^"]+)"/g)) {
    assetRefs.push({ from: 'index.html', ref: match[1] });
  }
}

let missingAssets = 0;
for (const { from, ref } of assetRefs) {
  const target = path.resolve(WEB, ref.split(/[?#]/)[0]);
  const rel = path.relative(WEB, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    fail(`${from} references ${ref}, which escapes apps/web`);
    missingAssets += 1;
  } else if (!fs.existsSync(target)) {
    fail(`${from} references missing asset ${ref}`);
    missingAssets += 1;
  }
}
if (missingAssets === 0) pass(`${assetRefs.length} local asset references resolve`);

// …and the other direction: every module under apps/web/js must be precached, or
// the app cannot boot offline. A new file that nobody adds to SHELL otherwise only
// shows up as a broken install.
const precached = new Set(
  [...(fs.existsSync(swPath) ? fs.readFileSync(swPath, 'utf8') : '').matchAll(/['"]\.\/(js\/[^'"]+)['"]/g)].map(
    (m) => m[1],
  ),
);

// Sources that are bundled into a precached file are never loaded by the browser,
// so requiring them in the precache list would be wrong: it would force shipping
// two copies of the same code.
const BUNDLED_SOURCES = new Set(['js/editor-entry.js']);

const unprecached = walk(path.join(WEB, 'js'), isJs)
  .map((file) => path.relative(WEB, file).split(path.sep).join('/'))
  .filter((rel) => !precached.has(rel))
  .filter((rel) => !BUNDLED_SOURCES.has(rel))
  .sort();
if (unprecached.length === 0) pass(`all ${precached.size} precached modules exist and every module is listed`);
else for (const rel of unprecached) fail(`${rel} is not in the service worker precache list`);

// ─── 7. No undefined identifiers ─────────────────────────────────────────────

console.log('\n\x1b[1m7. ESLint (no-undef across app, API and scripts)\x1b[0m');
{
  // The Pages job runs this script with no `npm install`, so devDependencies are
  // absent there. Treating a missing ESLint as a failure blocked every frontend
  // deploy; the CI workflow installs them and is where the gate belongs.
  const eslintBin = path.join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
  if (!fs.existsSync(eslintBin)) {
    warn('eslint is not installed (devDependencies absent) — skipped; CI enforces this');
  } else {
    const lint = spawnSync(process.execPath, [eslintBin, '.'], { encoding: 'utf8', cwd: ROOT });
    if (lint.status === 0) {
      pass('every identifier resolves; lint clean');
    } else {
      const output = `${lint.stdout || ''}${lint.stderr || ''}`.trim();
      fail(`eslint reported problems (a missing import only fails at runtime):\n${output}`);
    }
  }
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(
  `\n${errors === 0 ? '\x1b[32mAll checks passed\x1b[0m' : `\x1b[31m${errors} error(s)\x1b[0m`}` +
    `${warnings ? `, \x1b[33m${warnings} warning(s)\x1b[0m` : ''}\n`,
);
process.exit(errors === 0 ? 0 : 1);