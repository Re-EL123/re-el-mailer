/**
 * Admin settings panel contract.
 *
 * `settings.list` and `settings.update` were fully implemented on the server and
 * had no caller anywhere in the app, so retention windows, send ceilings and the
 * password policy could only be changed by editing the database by hand.
 *
 * Two things had to be right for the panel not to mislead:
 *
 *   - jsonb preserves whatever type arrives. A number posted as "100" is stored
 *     as text, and every comparison against it afterwards is a string compare
 *     that quietly passes. So the panel coerces back to the stored type.
 *   - Most of these keys are inert. Only `company.*` (published to clients) and
 *     `retention.*` (read by the nightly maintenance run) are actually consulted
 *     at runtime; the send ceilings come from SEND_DAILY_LIMIT_*, the lockout
 *     from RATE_LIMIT_MAX_AUTH_ATTEMPTS, and checkPasswordPolicy() is called
 *     without a policy argument so it always uses its own defaults. The panel
 *     therefore renders the rest read-only instead of offering boxes that save
 *     without changing anything.
 */

import { describe, expect, it, vi } from 'vitest';

import { isSettingEnforced, parseSettingValue } from '../apps/web/js/views/admin.js';

/** The keys as the bootstrap migration creates them, with their real types. */
const REAL_SETTINGS = {
  'company.name': 'Re-EL Mailer',
  'company.tagline': 'Business email. Built for Re-EL.',
  'company.support_email': 'support@re-el.co.za',
  'company.website': 'https://re-el.co.za',
  'security.session_max': 5,
  'security.password_min': 10,
  'security.login_lockout': 10,
  'security.login_lockout_minutes': 15,
  'security.require_mixed_case_password': true,
  'security.require_number_password': true,
  'security.require_symbol_password': false,
  'limits.user_daily': 100,
  'limits.user_hourly': 25,
  'limits.admin_daily': 1000,
  'limits.admin_hourly': 250,
  'limits.domain_daily': 5000,
  'limits.max_recipients': 25,
  'limits.max_bcc': 50,
  'retention.trash_days': 30,
  'retention.spam_days': 30,
  'retention.audit_days': 730,
  'features.dark_mode': true,
  'features.pwa': true,
  'features.notifications': true,
};

describe('setting values keep the type the server stores', () => {
  it('coerces a number control back to a number', () => {
    expect(parseSettingValue('45', 30)).toBe(45);
    expect(typeof parseSettingValue('45', 30)).toBe('number');
  });

  it('never stores a number as a string, which would break comparisons', () => {
    const value = parseSettingValue('100', 25);
    expect(value).not.toBe('100');
    // jsonb would otherwise hold text and every later `>= limit` misbehave.
    expect(Number.isInteger(value)).toBe(true);
  });

  it('clearing a number sends null so the server falls back to its default', () => {
    expect(parseSettingValue('', 30)).toBeNull();
  });

  it('leaves an unparseable number at the current value rather than saving NaN', () => {
    expect(parseSettingValue('abc', 30)).toBe(30);
  });

  it('coerces a checkbox back to a boolean', () => {
    expect(parseSettingValue(true, false)).toBe(true);
    expect(parseSettingValue(false, true)).toBe(false);
  });

  it('keeps string settings as strings', () => {
    expect(parseSettingValue('Re-EL Mailer', 'Re-EL Mailer')).toBe('Re-EL Mailer');
    expect(parseSettingValue('New name', 'Old name')).toBe('New name');
  });
});

describe('only genuinely enforced settings are editable', () => {
  it('treats company and retention as enforced', () => {
    for (const key of Object.keys(REAL_SETTINGS).filter((k) => k.startsWith('company.') || k.startsWith('retention.'))) {
      expect(isSettingEnforced(key), `${key} is read at runtime`).toBe(true);
    }
  });

  it('treats security, limits and features as inert', () => {
    for (const key of Object.keys(REAL_SETTINGS).filter((k) => !k.startsWith('company.') && !k.startsWith('retention.'))) {
      expect(isSettingEnforced(key), `${key} is not read at runtime`).toBe(false);
    }
  });

  it('does not mark an unknown key enforced by prefix accident', () => {
    expect(isSettingEnforced('companysomething')).toBe(false);
    expect(isSettingEnforced('')).toBe(false);
  });
});

describe('the client can actually reach the settings endpoints', () => {
  it('exposes list and update', async () => {
    const { api } = await import('../apps/web/js/api.js');

    expect(typeof api.settings.list).toBe('function');
    expect(typeof api.settings.update).toBe('function');
  });
});

describe('the server rejects keys it does not know', () => {
  it('update rejects an undefined key instead of writing it', async () => {
    const getSettings = async () => ({});
    const listSettingDefinitions = async () => [{ key: 'retention.trash_days', description: 'x' }];
    const setSetting = async (key, value) => ({ key, value });

    vi.resetModules();
    vi.doMock('../packages/db/system.js', () => ({ getSettings, listSettingDefinitions, setSetting }));
    const { actions } = await import('../api/settings.js');

    await expect(
      actions.update.handler({
        session: { user: { id: 'usr_1', role: 'admin' } },
        body: { settings: { 'evil.key': 1 } },
        query: {},
        setHeader() {},
        log: { info() {}, warn() {}, error() {} },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('update accepts a known key and writes it', async () => {
    const written = [];
    vi.resetModules();
    vi.doMock('../packages/db/system.js', () => ({
      getSettings: async () => ({}),
      listSettingDefinitions: async () => [{ key: 'retention.trash_days', description: 'x' }],
      setSetting: async (key, value, userId) => {
        written.push({ key, value, userId });
        return { key, value };
      },
    }));
    const { actions } = await import('../api/settings.js');

    const result = await actions.update.handler({
      session: { user: { id: 'usr_1', role: 'admin' } },
      body: { settings: { 'retention.trash_days': 45 } },
      query: {},
      setHeader() {},
      log: { info() {}, warn() {}, error() {} },
    });

    expect(result.settings).toEqual({ 'retention.trash_days': 45 });
    expect(written).toEqual([{ key: 'retention.trash_days', value: 45, userId: 'usr_1' }]);
  });

  it('update refuses a manager, since only admins may write', async () => {
    vi.resetModules();
    const { actions } = await import('../api/settings.js');

    await expect(
      actions.update.handler({
        session: { user: { id: 'usr_1', role: 'manager' } },
        body: { settings: {} },
        query: {},
        setHeader() {},
        log: { info() {}, warn() {}, error() {} },
      }),
    ).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
  });
});