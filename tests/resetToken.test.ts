import { createHash } from 'crypto';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { accessTokenUser } from '../src/middleware/auth';
import {
  generateAccessToken,
  generateRefreshToken,
  generateResetToken,
  passwordFingerprint,
  REFRESH_TOKEN_AUDIENCE,
  RESET_TOKEN_AUDIENCE,
  passwordMatches,
  SET_PASSWORD_LINK_LIFETIME,
  verifyRefreshToken,
  verifyResetToken,
} from '../src/utils/tokens';

/**
 * Reset tokens (owner-approved follow-up F1): own audience, reset purpose, single use through the hash
 * fingerprint. Refresh tokens (SR-1, SR-2): own secret and audience, bound to the password hash.
 */

const USER = { id: '11111111-2222-4333-8444-555555555555', passwordHash: '$2b$12$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ01234' };

describe('passwordFingerprint', () => {
  it('is the first 16 hex characters of SHA-256 of the password hash', () => {
    const expected = createHash('sha256').update(USER.passwordHash).digest('hex').slice(0, 16);
    expect(passwordFingerprint(USER.passwordHash)).toBe(expected);
    expect(passwordFingerprint(USER.passwordHash)).toMatch(/^[0-9a-f]{16}$/);
    expect(passwordFingerprint(`${USER.passwordHash}x`)).not.toBe(expected);
  });
});

describe('generateResetToken', () => {
  it('signs the id, the reset purpose and the fingerprint, for the reset audience, valid for one hour', () => {
    const payload = jwt.decode(generateResetToken(USER)) as Record<string, unknown>;
    expect(payload).toMatchObject({ id: USER.id, purpose: 'reset', pwd: passwordFingerprint(USER.passwordHash), aud: RESET_TOKEN_AUDIENCE });
    expect(RESET_TOKEN_AUDIENCE).toBe('raqib:password-reset');
    expect((payload.exp as number) - (payload.iat as number)).toBe(3600);
    // Never the hash itself, or anything else about the user.
    expect(JSON.stringify(payload)).not.toContain(USER.passwordHash);
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'id', 'purpose', 'pwd']);
  });

  it('a set-password link (invitation or admin reset with email on) lasts 72 hours and is verified the same way', () => {
    const token = generateResetToken(USER, SET_PASSWORD_LINK_LIFETIME);
    const payload = jwt.decode(token) as Record<string, number>;
    expect(payload.exp - payload.iat).toBe(72 * 3600);
    expect(verifyResetToken(token)).toEqual({ id: USER.id, pwd: passwordFingerprint(USER.passwordHash) });
  });
});

describe('verifyResetToken and passwordMatches', () => {
  const sign = (payload: object, options: jwt.SignOptions = {}) =>
    jwt.sign(payload, env.jwtSecret, { expiresIn: '1h', audience: RESET_TOKEN_AUDIENCE, ...options });
  const claims = { id: USER.id, purpose: 'reset', pwd: passwordFingerprint(USER.passwordHash) };

  it('accepts its own token and matches the hash it was issued for only', () => {
    const verified = verifyResetToken(generateResetToken(USER));
    expect(verified).toEqual({ id: USER.id, pwd: passwordFingerprint(USER.passwordHash) });
    expect(passwordMatches(verified, USER.passwordHash)).toBe(true);
    // After any password change (the reset it was used for, change password, an admin reset) it no longer matches.
    expect(passwordMatches(verified, '$2b$12$anotherhashanotherhashanotherhashanotherhashanother12')).toBe(false);
  });

  it('refuses a token without the reset audience (an old-style reset token)', () => {
    expect(() => verifyResetToken(jwt.sign(claims, env.jwtSecret, { expiresIn: '1h' }))).toThrow(/audience/);
    expect(() => verifyResetToken(sign(claims, { audience: 'raqib:access' }))).toThrow(/audience/);
  });

  it('refuses an access token', () => {
    const access = generateAccessToken({
      id: USER.id, email: 'x@example.org', organizationId: USER.id, role: 'me_officer', fullName: 'X',
    });
    expect(() => verifyResetToken(access)).toThrow(jwt.JsonWebTokenError);
  });

  it.each([
    ['another purpose', { ...claims, purpose: 'invite' }],
    ['no purpose', { id: USER.id, pwd: claims.pwd }],
    ['no fingerprint', { id: USER.id, purpose: 'reset' }],
    ['a fingerprint that is not 16 hex characters', { ...claims, pwd: 'abc' }],
    ['a user id that is not a UUID', { ...claims, id: 'admin' }],
  ])('refuses a token with %s', (_label, payload) => {
    expect(() => verifyResetToken(sign(payload))).toThrow(jwt.JsonWebTokenError);
  });

  it('refuses an expired token, another secret and another algorithm', () => {
    expect(() => verifyResetToken(sign(claims, { expiresIn: -10 }))).toThrow(jwt.TokenExpiredError);
    expect(() => verifyResetToken(jwt.sign(claims, 'another-secret-0123456789abcdef0123456789', { audience: RESET_TOKEN_AUDIENCE })))
      .toThrow(jwt.JsonWebTokenError);
    expect(() => verifyResetToken(jwt.sign(claims, env.jwtSecret, { audience: RESET_TOKEN_AUDIENCE, algorithm: 'HS512' })))
      .toThrow(jwt.JsonWebTokenError);
  });

  it('a fingerprint of another length never matches', () => {
    expect(passwordMatches({ id: USER.id, pwd: passwordFingerprint(USER.passwordHash).slice(0, 15) }, USER.passwordHash)).toBe(false);
  });
});

describe('a reset token is never an access token', () => {
  it('is refused by accessTokenUser: it has a purpose and an audience', () => {
    const payload = jwt.verify(generateResetToken(USER), env.jwtSecret);
    expect(accessTokenUser(payload)).toBeNull();
  });
});

describe('refresh tokens', () => {
  const OTHER_HASH = '$2b$12$anotherhashanotherhashanotherhashanotherhashanother12';
  const claims = { id: USER.id, pwd: passwordFingerprint(USER.passwordHash) };
  const signRefresh = (payload: object, options: jwt.SignOptions = {}) =>
    jwt.sign(payload, env.jwtRefreshSecret, { expiresIn: '7d', audience: REFRESH_TOKEN_AUDIENCE, ...options });

  it('carry the user id and the password fingerprint, for the refresh audience, for seven days', () => {
    const token = generateRefreshToken(USER);
    const payload = jwt.decode(token) as Record<string, unknown>;
    expect(payload).toMatchObject({ id: USER.id, pwd: passwordFingerprint(USER.passwordHash), aud: REFRESH_TOKEN_AUDIENCE });
    expect(REFRESH_TOKEN_AUDIENCE).toBe('raqib:refresh');
    expect((payload.exp as number) - (payload.iat as number)).toBe(7 * 24 * 3600);
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'id', 'pwd']);
    expect(JSON.stringify(payload)).not.toContain(USER.passwordHash);
  });

  it('match the password hash they were issued for only: any password change ends them', () => {
    const verified = verifyRefreshToken(generateRefreshToken(USER));
    expect(verified).toEqual(claims);
    expect(passwordMatches(verified, USER.passwordHash)).toBe(true);
    expect(passwordMatches(verified, OTHER_HASH)).toBe(false);
  });

  it('refuse a reset token and an access token, even with one value for both secrets (SR-2)', () => {
    const original = env.jwtRefreshSecret;
    try {
      env.jwtRefreshSecret = env.jwtSecret;
      const reset = generateResetToken(USER);
      const access = generateAccessToken({ id: USER.id, email: 'x@example.org', organizationId: USER.id, role: 'me_officer', fullName: 'X' });
      expect(() => verifyRefreshToken(reset)).toThrow(jwt.JsonWebTokenError);
      expect(() => verifyRefreshToken(access)).toThrow(jwt.JsonWebTokenError);
      // A token with the refresh audience but a purpose claim is refused too.
      expect(() => verifyRefreshToken(signRefresh({ ...claims, purpose: 'reset' }))).toThrow(jwt.JsonWebTokenError);
    } finally {
      env.jwtRefreshSecret = original;
    }
  });

  it.each([
    ['no audience (a refresh token from before fingerprints)', () => jwt.sign({ id: USER.id }, env.jwtRefreshSecret, { expiresIn: '7d' })],
    ['no fingerprint', () => signRefresh({ id: USER.id })],
    ['a fingerprint that is not 16 hex characters', () => signRefresh({ ...claims, pwd: 'abc' })],
    ['a user id that is not a UUID', () => signRefresh({ ...claims, id: 'admin' })],
    ['another audience', () => signRefresh(claims, { audience: RESET_TOKEN_AUDIENCE })],
    ['the access secret', () => jwt.sign(claims, env.jwtSecret, { expiresIn: '7d', audience: REFRESH_TOKEN_AUDIENCE })],
    ['another algorithm', () => signRefresh(claims, { algorithm: 'HS512' })],
  ])('refuse a token with %s', (_label, make) => {
    expect(() => verifyRefreshToken(make())).toThrow(jwt.JsonWebTokenError);
  });

  it('refuse an expired token', () => {
    expect(() => verifyRefreshToken(signRefresh(claims, { expiresIn: -10 }))).toThrow(jwt.TokenExpiredError);
  });

  it('are never access tokens: accessTokenUser refuses the audience', () => {
    expect(accessTokenUser(jwt.decode(generateRefreshToken(USER)))).toBeNull();
  });
});
