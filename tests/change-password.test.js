/**
 * Forced password change.
 *
 * Every account create-admin provisions lands on the change-password screen with
 * `must_change_password` set. That screen could not be completed: the handler
 * read `password_hash` off `ctx.session.user`, which is the *public* user
 * projection and has no such column, so bcrypt compared against `undefined` and
 * rejected the correct password with "Your current password is not correct." The
 * account was permanently stuck on its first screen.
 *
 * The session guard loads the user through findById, which selects PUBLIC_COLUMNS
 * only, so the hash has to be fetched explicitly. These tests pin the session user
 * to that public shape — no password_hash — so the gap cannot reopen silently.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const findCredentialById = vi.fn();
const updateUser = vi.fn();
const verifyPassword = vi.fn();
const hashPassword = vi.fn();
const checkPasswordPolicy = vi.fn();
const revokeAllSessions = vi.fn();

vi.mock('../packages/db/users.js', () => ({
  findCredentialById: (...a) => findCredentialById(...a),
  updateUser: (...a) => updateUser(...a),
  createPasswordReset: vi.fn(),
  findPasswordResetByHash: vi.fn(),
  findByEmail: vi.fn(),
  recordLogin: vi.fn(),
  recordFailedLogin: vi.fn(),
}));
vi.mock('../packages/db/system.js', () => ({
  audit: vi.fn(),
  listActiveSessions: vi.fn(),
  revokeSessionById: vi.fn(),
  revokeAllSessions: (...a) => revokeAllSessions(...a),
  findActiveSessionById: vi.fn(),
  touchSession: vi.fn(),
}));
vi.mock('../packages/auth/passwords.js', () => ({
  hashPassword: (...a) => hashPassword(...a),
  verifyPassword: (...a) => verifyPassword(...a),
  checkPasswordPolicy: (...a) => checkPasswordPolicy(...a),
}));
vi.mock('../packages/auth/tokens.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    issueSessionPair: vi.fn(),
    createRefreshSession: vi.fn(),
    rotateRefreshToken: vi.fn(),
  };
});

async function loadHandler() {
  const mod = await import('../api/auth.js');
  return mod.actions['change-password'].handler;
}

/** Exactly the columns findById returns — deliberately no password_hash. */
function sessionUser() {
  return {
    id: 'usr_1',
    email: 'admin@re-el.co.za',
    display_name: null,
    role: 'admin',
    status: 'active',
    must_change_password: true,
    last_login_at: null,
  };
}

function ctx(overrides = {}) {
  return {
    session: { user: sessionUser(), sessionId: 'ses_1' },
    body: {
      currentPassword: 'Generated-Pass1',
      newPassword: 'Fresh-Pass2',
      revokeOtherSessions: true,
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  findCredentialById.mockReset();
  updateUser.mockReset();
  verifyPassword.mockReset();
  hashPassword.mockReset();
  checkPasswordPolicy.mockReset();
  revokeAllSessions.mockReset();

  findCredentialById.mockResolvedValue({ ...sessionUser(), password_hash: '$2b$10$storedhash' });
  // Only the current password matches; the reuse check must come back false or
  // the handler correctly refuses a "new" password it has seen before.
  verifyPassword.mockImplementation(async (plaintext) => plaintext === 'Generated-Pass1');
  checkPasswordPolicy.mockReturnValue({ ok: true });
  hashPassword.mockResolvedValue('$2b$10$newhash');
});

describe('forced password change', () => {
  it('verifies against the stored hash, not the session user', async () => {
    const changePassword = await loadHandler();
    const result = await changePassword(ctx());

    expect(result.changed).toBe(true);
    // The comparison must run against a real hash, never undefined.
    expect(findCredentialById).toHaveBeenCalledWith('usr_1');
    expect(verifyPassword).toHaveBeenCalledWith('Generated-Pass1', '$2b$10$storedhash');
    expect(sessionUser()).not.toHaveProperty('password_hash');
  });

  it('clears the forced-change flag', async () => {
    const changePassword = await loadHandler();
    await changePassword(ctx());

    expect(updateUser).toHaveBeenCalledWith('usr_1', {
      passwordHash: '$2b$10$newhash',
      mustChangePassword: false,
    });
    expect(revokeAllSessions).toHaveBeenCalledWith('usr_1', 'password_changed', 'ses_1');
  });

  it('still reports a genuinely wrong current password', async () => {
    // Guards against "fixing" it by accepting anything.
    verifyPassword.mockResolvedValue(false);
    const changePassword = await loadHandler();

    await expect(changePassword(ctx())).rejects.toThrow(/current password is not correct/i);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('rejects a session whose user no longer exists', async () => {
    findCredentialById.mockResolvedValue(null);
    const changePassword = await loadHandler();

    await expect(changePassword(ctx())).rejects.toThrow(/no longer valid/i);
    expect(verifyPassword).not.toHaveBeenCalled();
  });
});
