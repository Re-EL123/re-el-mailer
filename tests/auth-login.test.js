/**
 * Login bookkeeping.
 *
 * A real account signed in four times and last_login_at was still null. The
 * forced-password-change branch returned before recordLogin(), and that branch is
 * exactly what create-admin produces — every generated-password account skips the
 * only place the timestamp was written. The field then reads "never signed in"
 * in the admin console no matter how often the user signs in, and the failed
 * attempt counter is never cleared on success for those accounts.
 *
 * The handler also records a brute-force counter, so this path is
 * security-relevant, not cosmetic.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const findByEmail = vi.fn();
const recordLogin = vi.fn();
const recordFailedLogin = vi.fn();
const verifyPassword = vi.fn();
const issueSessionPair = vi.fn();
const createRefreshSession = vi.fn();
const findMailboxById = vi.fn();
const listMailboxesForUser = vi.fn();
const audit = vi.fn();

vi.mock('../packages/db/users.js', () => ({
  findByEmail: (...a) => findByEmail(...a),
  recordLogin: (...a) => recordLogin(...a),
  recordFailedLogin: (...a) => recordFailedLogin(...a),
  createPasswordReset: vi.fn(),
  findPasswordResetByHash: vi.fn(),
  updateUser: vi.fn(),
}));
vi.mock('../packages/auth/passwords.js', () => ({
  hashPassword: vi.fn(),
  verifyPassword: (...a) => verifyPassword(...a),
  checkPasswordPolicy: vi.fn(),
}));
vi.mock('../packages/auth/tokens.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    issueSessionPair: (...a) => issueSessionPair(...a),
    createRefreshSession: (...a) => createRefreshSession(...a),
  };
});
vi.mock('../packages/db/mailboxes.js', () => ({
  findMailboxById: (...a) => findMailboxById(...a),
  listMailboxesForUser: (...a) => listMailboxesForUser(...a),
}));
vi.mock('../packages/db/system.js', () => ({ audit: (...a) => audit(...a) }));

function account(overrides = {}) {
  return {
    id: 'usr_1',
    email: 'admin@re-el.co.za',
    password_hash: 'hash',
    role: 'admin',
    status: 'active',
    must_change_password: false,
    locked_until: null,
    ...overrides,
  };
}

function ctx(body = {}) {
  return {
    body: { email: 'admin@re-el.co.za', password: 'whatever', ...body },
    ip: '203.0.113.7',
    requestId: 'req_1',
    headers: {},
    log: { info: vi.fn(), warn: vi.fn() },
    setHeader: vi.fn(),
    getHeader: vi.fn(),
  };
}

async function loadHandler() {
  const mod = await import('../api/auth.js');
  return mod.actions.login.handler;
}

beforeEach(() => {
  vi.resetModules();
  findByEmail.mockReset();
  recordLogin.mockReset();
  recordFailedLogin.mockReset();
  verifyPassword.mockReset();
  issueSessionPair.mockReset();
  createRefreshSession.mockReset();
  listMailboxesForUser.mockReset();
  verifyPassword.mockResolvedValue(true);
  issueSessionPair.mockResolvedValue({
    accessToken: 'token_abc',
    accessTokenExpiresIn: 900,
    refreshToken: 'refresh_abc',
    refreshExpiresAt: '2026-10-09T00:00:00Z',
  });
  createRefreshSession.mockResolvedValue({ id: 'ses_1' });
  listMailboxesForUser.mockResolvedValue([
    {
      id: 'mbx_1',
      email: 'admin@re-el.co.za',
      display_name: null,
      domain: 're-el.co.za',
      status: 'active',
      is_primary: true,
      quota_bytes: 5_000_000_000,
      storage_used_bytes: 0,
    },
  ]);
});

describe('login bookkeeping', () => {
  it('records the login on the normal path', async () => {
    findByEmail.mockResolvedValue(account());
    const login = await loadHandler();
    await login(ctx());
    expect(recordLogin).toHaveBeenCalledWith('usr_1');
  });

  it('records the login when a password change is forced', async () => {
    // The branch create-admin always takes. It must not be the one path that
    // leaves last_login_at null and the failed-attempt counter uncleared.
    findByEmail.mockResolvedValue(account({ must_change_password: true }));
    const login = await loadHandler();
    const result = await login(ctx());

    expect(recordLogin).toHaveBeenCalledWith('usr_1');
    expect(result.mustChangePassword).toBe(true);
  });

  it('does not record a login for a rejected password', async () => {
    findByEmail.mockResolvedValue(account());
    verifyPassword.mockResolvedValue(false);
    const login = await loadHandler();
    await expect(login(ctx())).rejects.toThrow();
    expect(recordLogin).not.toHaveBeenCalled();
  });

  it('does not record a login for a locked account', async () => {
    findByEmail.mockResolvedValue(account({ locked_until: '2999-01-01T00:00:00Z' }));
    const login = await loadHandler();
    await expect(login(ctx())).rejects.toThrow();
    expect(recordLogin).not.toHaveBeenCalled();
  });

  it('does not record a login for a disabled account', async () => {
    findByEmail.mockResolvedValue(account({ status: 'pending' }));
    const login = await loadHandler();
    await expect(login(ctx())).rejects.toThrow();
    expect(recordLogin).not.toHaveBeenCalled();
  });
});
/**
 * A rejected password reported "Your session is not valid. Please sign in
 * again." on the sign-in form. AUTH_INVALID carries that text because it is the
 * right description for an expired or tampered token, but on the login path it
 * is simply false — there is no session yet. Someone read it as a broken
 * session and went looking for one instead of retyping a password, which is
 * how eight wrong attempts turned into a near lockout.
 */
describe('rejected credential message', () => {
  beforeEach(() => {
    vi.resetModules();
    verifyPassword.mockResolvedValue(false);
  });

  it('names the credential problem when the password is wrong', async () => {
    findByEmail.mockResolvedValue(account());
    const login = await loadHandler();
    await expect(login(ctx())).rejects.toMatchObject({
      code: 'AUTH_INVALID',
      message: 'That email address and password do not match.',
    });
  });

  it('gives an unknown address the same wording, so it leaks nothing', async () => {
    findByEmail.mockResolvedValue(null);
    const login = await loadHandler();
    await expect(login(ctx())).rejects.toMatchObject({
      code: 'AUTH_INVALID',
      message: 'That email address and password do not match.',
    });
  });
});
