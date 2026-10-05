/**
 * Editor bundle build.
 *
 * The rest of the frontend is unbundled ES modules loaded straight by the
 * browser. ProseMirror, the editor engine TipTap is built on, is a different
 * situation: it is a large CommonJS/ESM dependency graph with circular imports
 * between its own modules, which a browser cannot load as native modules. So
 * exactly one thing is bundled — the editor — and everything else stays as it
 * was.
 *
 * Bundling only the editor is what keeps this cheap. The whole app is still
 * served as individual files with no build step, no hashing and no manifest; the
 * editor is a single generated file under js/vendor that is imported by the
 * composer and precached like any other module.
 *
 * Output is committed, not ignored. The app has to work from a plain static
 * deploy with no Node step, and an unbundled browser cannot be asked to resolve
 * a dependency graph at runtime.
 */

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'apps', 'web', 'js', 'vendor', 'editor.bundle.js');
const ENTRY = path.join(ROOT, 'apps', 'web', 'js', 'editor-entry.js');

async function main() {
  const before = await stat(OUT).catch(() => null);

  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'esm',
    // Target matches the browsers the app already claims to support in
    // service-worker.js; esbuild will not down-level further than this.
    target: ['chrome111', 'firefox111', 'safari16'],
    minify: true,
    sourcemap: false,
    // TipTap's own code logs development warnings through this global; leaving
    // it undefined makes the browser print an error per event rather than
    // silently doing nothing.
    define: { 'process.env.NODE_ENV': '"production"' },
    legalComments: 'none',
    outfile: OUT,
    logLevel: 'warning',
    metafile: true,
  });

  const after = await stat(OUT);
  const kb = (after.size / 1024).toFixed(1);

  if (before?.size === after.size) {
    console.log(`editor bundle unchanged (${kb} KB)`);
    return;
  }

  const inputs = Object.keys(result.metafile.inputs).filter((file) => !file.includes('node_modules'));
  console.log(`editor bundle rebuilt: ${kb} KB from ${Object.keys(result.metafile.inputs).length} modules`);
  if (inputs.length) console.log(`  app modules: ${inputs.join(', ')}`);
}

main().catch((err) => {
  console.error('Editor build failed:', err.message);
  process.exit(1);
});