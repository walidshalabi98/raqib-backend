import { createHash, timingSafeEqual } from 'crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../config/env';
import { AuthUser } from '../types/express';

export function generateAccessToken(user: AuthUser): string {
  return jwt.sign(user, env.jwtSecret, { expiresIn: '15m' });
}

/** The audience of refresh tokens only: an access token or a reset token never carries it. */
export const REFRESH_TOKEN_AUDIENCE = 'raqib:refresh';

/** How long a refresh token works; every refresh issues a new one. */
export const REFRESH_TOKEN_LIFETIME = '7d';

/**
 * A refresh token for the user's current password hash: signed with JWT_REFRESH_SECRET, for the refresh
 * audience, with the password fingerprint (`pwd`). /api/auth/refresh refuses it once the password changes
 * (change password, a reset link, an admin reset), so a password change ends every session within the
 * 15 minutes an access token lasts.
 */
export function generateRefreshToken(user: { id: string; passwordHash: string }): string {
  return jwt.sign(
    { id: user.id, pwd: passwordFingerprint(user.passwordHash) },
    env.jwtRefreshSecret,
    { expiresIn: REFRESH_TOKEN_LIFETIME, audience: REFRESH_TOKEN_AUDIENCE, algorithm: 'HS256' },
  );
}

const refreshTokenClaims = z.object({
  id: z.string().uuid(),
  pwd: z.string().regex(/^[0-9a-f]{16}$/),
});

/** The claims a session token carries: the user and the fingerprint of the password hash it was issued for. */
export interface PasswordBoundClaims {
  id: string;
  pwd: string;
}

/**
 * The claims of a valid, unexpired refresh token: HS256 with JWT_REFRESH_SECRET, the refresh audience, a uuid
 * and a password fingerprint, and no `purpose` claim. Anything else throws a JsonWebTokenError (or
 * TokenExpiredError): an access token, a reset token, a refresh token from before fingerprints, or a token
 * signed with the other secret. Call passwordMatches with the user's current hash before using it.
 */
export function verifyRefreshToken(token: string): PasswordBoundClaims {
  const payload = jwt.verify(token, env.jwtRefreshSecret, { audience: REFRESH_TOKEN_AUDIENCE, algorithms: ['HS256'] });
  if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'purpose')) {
    throw new jwt.JsonWebTokenError('Invalid refresh token');
  }
  const parsed = refreshTokenClaims.safeParse(payload);
  if (!parsed.success) throw new jwt.JsonWebTokenError('Invalid refresh token');
  return { id: parsed.data.id, pwd: parsed.data.pwd };
}

/** The audience of password-reset tokens only (RFC 8725 §3.12): an access token never carries it. */
export const RESET_TOKEN_AUDIENCE = 'raqib:password-reset';

/**
 * The first 16 hex characters of SHA-256(passwordHash). A reset token carries the fingerprint of the password
 * hash it was issued for, so it stops working once the password changes: after the reset it was used for, or
 * any other change. The fingerprint is of the bcrypt hash, never of the password.
 */
export function passwordFingerprint(passwordHash: string): string {
  return createHash('sha256').update(passwordHash, 'utf8').digest('hex').slice(0, 16);
}

/** Lifetime of a link from "Forgot password?". */
export const RESET_LINK_LIFETIME = '1h';
/**
 * Lifetime of a set-password link in an invitation or an admin's reset email (email on): longer, because the
 * person did not ask for it and may read it a day or two later. It is single-use like every reset link.
 */
export const SET_PASSWORD_LINK_LIFETIME = '72h';

/**
 * A password-reset token for the user's current password hash (one hour by default). It stops working once
 * the password changes, so it works once.
 */
export function generateResetToken(
  user: { id: string; passwordHash: string },
  expiresIn: typeof RESET_LINK_LIFETIME | typeof SET_PASSWORD_LINK_LIFETIME = RESET_LINK_LIFETIME,
): string {
  return jwt.sign(
    { id: user.id, purpose: 'reset', pwd: passwordFingerprint(user.passwordHash) },
    env.jwtSecret,
    { expiresIn, audience: RESET_TOKEN_AUDIENCE, algorithm: 'HS256' },
  );
}

const resetTokenClaims = z.object({
  id: z.string().uuid(),
  purpose: z.literal('reset'),
  pwd: z.string().regex(/^[0-9a-f]{16}$/),
});

export type ResetTokenClaims = PasswordBoundClaims;

/**
 * The claims of a valid, unexpired reset token: signed with the API secret, for the reset audience, with the
 * reset purpose and a password fingerprint. Anything else throws a JsonWebTokenError (or TokenExpiredError).
 * Call passwordMatches with the user's current hash before using it: a valid token may already be spent.
 */
export function verifyResetToken(token: string): ResetTokenClaims {
  const payload = jwt.verify(token, env.jwtSecret, { audience: RESET_TOKEN_AUDIENCE, algorithms: ['HS256'] });
  const parsed = resetTokenClaims.safeParse(payload);
  if (!parsed.success) throw new jwt.JsonWebTokenError('Invalid reset token');
  return { id: parsed.data.id, pwd: parsed.data.pwd };
}

/** True when the token (reset or refresh) was issued for this password hash (compared in constant time). */
export function passwordMatches(claims: PasswordBoundClaims, passwordHash: string): boolean {
  const expected = Buffer.from(passwordFingerprint(passwordHash), 'utf8');
  const given = Buffer.from(claims.pwd, 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}
