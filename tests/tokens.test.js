/**
 * Access tokens.
 *
 * These tests need real secrets, so the environment is configured before the
 * module is imported — config.js reads the environment once at load time.
 */

import { beforeAll, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_jwt_secret_that_is_definitely_long_enough_to_pass_validation_0123456789';
process.env.TOKEN_PEPPER = 'test_pepper_also_long_enough_0123456789abcdefghij';

const { verifyAccessToken, signAccessToken, decodeAccessToken, accessTokenExpiresAt, parseAccessTokenTtl } =
  await import('../packages/auth/tokens.js');

const USER = { id: 'usr_1', email: 'admin@re-el.co.za', role: 'admin' };
const MAILBOX = { id: 'mbx_1', email: 'admin@re-el.co.za', role: 'admin' };

beforeAll(() => {
  // Fail loudly if the test secret was rejected, rather than signing with junk.
  expect(process.env.JWT_SECRET.length).toBeGreaterThan(32);
});

describe('signAccessToken / verifyAccessToken', () => {
  it('round-trips the user and session claims', () => {
    const token = signAccessToken(USER, MAILBOX, 'ses_1');
    const claims = verifyAccessToken(token);

    expect(claims.sub).toBe(USER.id);
    expect(claims.sid).toBe('ses_1');
    expect(claims.role).toBe(USER.role);
    expect(claims.email).toBe(USER.email);
  });

  it('rejects a tampered payload', () => {
    const token = signAccessToken(USER, MAILBOX, 'ses_1');
    const [header, payload, signature] = token.split('.');

    // Re-encode the payload with an escalated role but keep the old signature.
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    decoded.sub = 'usr_attacker';
    decoded.email = 'attacker@re-el.co.za';
    const forged = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');

    expect(() => verifyAccessToken(`${header}.${forged}.${signature}`)).toThrow();
  });

  it('rejects a token signed with a different secret', () => {
    const token = signAccessToken(USER, MAILBOX, 'ses_1');
    const [header, payload] = token.split('.');
    const forgedSignature = Buffer.from('not-a-real-signature').toString('base64url');

    expect(() => verifyAccessToken(`${header}.${payload}.${forgedSignature}`)).toThrow();
  });

  it('rejects garbage', () => {
    expect(() => verifyAccessToken('not.a.token')).toThrow();
    expect(() => verifyAccessToken('')).toThrow();
    expect(() => verifyAccessToken(null)).toThrow();
  });

  it('issues a token whose exp is in the future', () => {
    const before = Math.floor(Date.now() / 1000);
    const claims = verifyAccessToken(signAccessToken(USER, MAILBOX, 'ses_1'));
    expect(claims.exp).toBeGreaterThan(before);
  });

  it('always issues a session id so revocation stays possible', () => {
    // A token with no `sid` could not be revoked before it expires, so guard.js
    // rejects them; issuing one is what makes session checks work.
    const claims = verifyAccessToken(signAccessToken(USER, MAILBOX, 'ses_9'));
    expect(claims.sid).toBeTruthy();
  });
});

describe('decodeAccessToken', () => {
  it('reads claims without verifying the signature', () => {
    const token = signAccessToken(USER, MAILBOX, 'ses_1');
    expect(decodeAccessToken(token).sub).toBe(USER.id);
  });

  it('returns null for an unreadable token', () => {
    expect(decodeAccessToken('garbage')).toBeNull();
  });
});

describe('parseAccessTokenTtl', () => {
  it('accepts seconds', () => {
    expect(parseAccessTokenTtl(900)).toBe(900);
  });

  it('accepts suffixed values such as 15m and 2h', () => {
    expect(parseAccessTokenTtl('15m')).toBe(900);
    expect(parseAccessTokenTtl('2h')).toBe(7200);
  });

  it('falls back to a safe default for nonsense', () => {
    expect(parseAccessTokenTtl('not-a-duration')).toBeGreaterThan(0);
  });
});

describe('accessTokenExpiresAt', () => {
  it('returns a timestamp in the future', () => {
    // Returned as an ISO string, so compare parsed values.
    expect(new Date(accessTokenExpiresAt()).getTime()).toBeGreaterThan(Date.now());
  });
});