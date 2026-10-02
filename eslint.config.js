import js from '@eslint/js';
import globals from 'globals';

/**
 * The browser app is plain ES modules with no bundler, so nothing else notices a
 * missing import until the line runs. Four separate defects this week were
 * undefined identifiers in the frontend — a sign-in that reported a generic
 * failure because it read `data.session.accessToken`, and a send button that threw
 * `activeMailbox is not defined` — all of which passed every test, because the
 * tests stubbed the module instead of exercising it.
 *
 * `no-undef` catches that class at lint time, in every file, for free.
 */
export default [
  {
    ignores: ['node_modules/**', '.vercel/**', 'public/**', 'database/**'],
  },
  js.configs.recommended,
  {
    files: ['apps/web/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['api/**/*.js', 'packages/**/*.js', 'scripts/**/*.{js,mjs}', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // The service worker runs in a worker global scope: no `window`, plus
    // `self` and `caches`.
    files: ['apps/web/service-worker.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.serviceworker },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Filename sanitisation strips control characters and allows a hyphen inside
    // a character class; both patterns are the point of the code.
    files: ['packages/storage/attachments.js'],
    rules: { 'no-control-regex': 'off', 'no-useless-escape': 'off' },
  },
  {
    files: ['tests/**/*.js'],
    rules: { 'no-unused-vars': 'off' },
  },
];
