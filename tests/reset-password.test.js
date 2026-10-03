/**
 * Password reset.
 *
 * The forced-password-change endpoint turned out to be unreachable because the
 * handler read `policy.ok` from a function that returns `{ valid, errors }`, so
 * every password was rejected. reset-password had the identical defect and no
 * test at all, which means nobody resetting a forgotten password would ever have
 * learned why it failed.
 *
 * These tests use the real checkPasswordPolicy rather than a stub. The stub is
 * what hid the defect in the first place: it answered { ok: true }, a shape the
 * real function never produces.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const findPasswordResetByHash = vi.fn();
const updateUser = vi.fn();
const hashPassword = vi.fn();
const verifyPassword = vi.fn();
const revokeAllSessions = vi.fn();

vi.mock('../packages/db/users.js', () => ({
  findPasswordResetByHash: (...a) => findPasswordResetByHash(...a),
  updateUser: (...a) => updateUser(...a),
  createPasswordReset: vi.fn(),
  findByEmail: vi.fn(),
  recordLogin: vi.fn(),
  recordFailedLogin: vi.fn(),
  findCredentialById: vi.fn(),
}));
vi.mock('../packages/db/system.js', () => ({
  audit: vi.fn(),
  listActiveSessions: vi.fn(),
  revokeSessionById: vi.fn(),
  revokeAllSessions: (...a) => revokeAllSessions(...a),
  findActiveSessionById: vi.fn(),
  touchSession: vi.fn(),
}));
// checkPasswordPolicy stays real: see the note above.
vi.mock('../packages/auth/passwords.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    hashPassword: (...a) => hashPassword(...a),
    verifyPassword: (...a) => verifyPassword(...a),
  };
});

async function loadHandler() {
  const mod = await import('../api/auth.js');
  return mod.actions.reset.handler;
}

function ctx(password = 'Fresh-Pass2') {
  return { body: { token: 'reset-token', password } };
}

beforeEach(() => {
  vi.resetModules();
  findPasswordResetByHash.mockReset();
  updateUser.mockReset();
  hashPassword.mockReset();
  verifyPassword.mockReset();
  revokeAllSessions.mockReset();

  findPasswordResetByHash.mockResolvedValue({ id: 'prst_1', user_id: 'usr_1' });
  hashPassword.mockResolvedValue('$2b$10$newhash');
});

describe('password reset', () => {
  it('sets the new password when the policy accepts it', async () => {
    const reset = await loadHandler();
    const result = await reset(ctx());

    expect(result).toBeDefined();
    expect(updateUser).toHaveBeenCalledWith('usr_1', {
      passwordHash: '$2b$10$newhash',
      mustChangePassword: false,
    });
  });

  it('rejects a password the policy refuses', async () => {
    const reset = await loadHandler();
    await expect(reset(ctx('NoDigitsHereAtAll'))).rejects.toThrow('Include at least one number.');

    expect(updateUser).not.toHaveBeenCalled();
  });

  it('reports an expired or unknown reset link', async () => {
    findPasswordResetByHash.mockResolvedValue(null);
    const reset = await loadHandler();

    await expect(reset(ctx())).rejects.toThrow(/invalid or has expired/i);
    expect(updateUser).not.toHaveBeenCalled();
  });
});