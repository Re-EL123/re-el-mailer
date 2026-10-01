/**
 * Transactional email links must point at real frontend routes.
 *
 * The frontend is a single page with a hash router, so an email containing
 * `/reset-password.html` links to nothing — and a link to `#/?token=…` lands on
 * the sign-in screen, because the reset view is only registered at `#/reset`.
 * Neither mistake fails a unit test, so it is checked here against the routes
 * the app actually registers.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

process.env.NODE_ENV = 'test';
process.env.APP_URL = 'https://mailer.re-el.co.za';
process.env.JWT_SECRET = 'test_jwt_secret_that_is_definitely_long_enough_to_pass_validation_0123456789';
process.env.SUPABASE_URL = 'https://project.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.RESEND_API_KEY = 're_test_key';
process.env.MAIL_FROM_EMAIL = 'sender@re-el.co.za';
process.env.MAIL_DOMAINS = 're-el.co.za';

/** Route names the frontend registers via `route('name', …)`. */
function registeredRoutes() {
  const source = fs.readFileSync(path.join(ROOT, 'apps', 'web', 'js', 'app.js'), 'utf8');
  const names = new Set();
  for (const match of source.matchAll(/\broute\(\s*'([^']*)'/g)) names.add(match[1]);
  return names;
}

/** Every `app.url`-relative link found in an email body. */
function emailLinks(html) {
  return [...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
}

/** The hash route a link addresses, e.g. '#/reset?token=x' → 'reset'. */
function hashRouteOf(link) {
  const hash = new URL(link).hash.replace(/^#\/?/, '');
  const pathPart = hash.split('?')[0];
  return pathPart.split('/').filter(Boolean)[0] ?? '';
}

describe('transactional email links', () => {
  let resetHtml = '';
  let welcomeHtml = '';
  const sent = [];

  beforeAll(async () => {
    // Capture payloads instead of calling Resend.
    globalThis.fetch = async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: 'test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const { sendPasswordReset, sendWelcome } = await import('../packages/mail/templates.js');
    await sendPasswordReset({ to: 'user@re-el.co.za', displayName: 'User', token: 'tok/123+xyz' });
    await sendWelcome({ to: 'user@re-el.co.za', displayName: 'User', temporaryPassword: 'temporary' });
    resetHtml = sent[0].html ?? '';
    welcomeHtml = sent[1].html ?? '';
  });

  it('renders both emails', () => {
    expect(resetHtml).not.toBe('');
    expect(welcomeHtml).not.toBe('');
  });

  it('never links to a multi-page frontend that does not exist', () => {
    for (const html of [resetHtml, welcomeHtml]) {
      expect(html).not.toMatch(/href="[^"]*\.html/);
    }
  });

  it('addresses routes the frontend actually registers', () => {
    const routes = registeredRoutes();
    expect(routes.has('reset')).toBe(true);

    for (const html of [resetHtml, welcomeHtml]) {
      for (const link of emailLinks(html)) {
        const expected = link.startsWith(process.env.APP_URL) ? null : 'external';
        if (expected === 'external') continue;
        expect(routes.has(hashRouteOf(link))).toBe(true);
      }
    }
  });

  it('sends the reset token on the reset route, where the token is read', () => {
    const link = emailLinks(resetHtml).find((l) => l.includes('token='));
    expect(link).toBeDefined();
    expect(hashRouteOf(link)).toBe('reset');
    expect(new URL(link).hash).toContain('token=tok%2F123%2Bxyz');
  });

  it('labels the footer link with the host it actually links to', () => {
    const host = new URL(process.env.APP_URL).host;
    expect(resetHtml).toContain(`<a href="${process.env.APP_URL}/">${host}</a>`);
  });
});