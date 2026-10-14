import { Router, Request, Response } from 'express';
import { User } from '@prisma/client';
import { prisma } from '../config/prisma';
import { authenticate } from '../middleware/auth';
import { authLimiters } from '../middleware/rateLimit';
import {
  assertNewPassword,
  dummyPasswordHash,
  hashPassword,
  passwordIsCorrect,
  replacePasswordHash,
  verifySignIn,
} from '../services/auth/passwords';
import { findUserByEmail } from '../services/auth/accounts';
import {
  generateAccessToken,
  generateRefreshToken,
  passwordMatches,
  PasswordBoundClaims,
  verifyRefreshToken,
  verifyResetToken,
} from '../utils/tokens';
import { sendPasswordResetEmail } from '../utils/email';
import { normalizeEmail } from '../utils/emailAddress';
import { AppError, asyncHandler } from '../middleware/errorHandler';

const router = Router();

// Start making the sign-in dummy hash now, so the first unknown email is refused as fast as a wrong password.
void dummyPasswordHash();

/** Every way a reset link can fail answers the same: bad signature, wrong audience, expired, used, or superseded. */
const RESET_LINK_INVALID = 'This reset link is invalid or has expired, or it was already used. Ask for a new one.';
const resetLinkInvalid = () => new AppError(401, RESET_LINK_INVALID, 'reset_link_invalid');

/** Every way a refresh can fail answers the same: the web app then signs the user out. */
const SESSION_ENDED = 'Your session has ended. Sign in again.';
const sessionEnded = () => new AppError(401, SESSION_ENDED, 'session_ended');

const FORGOT_PASSWORD_ANSWER = 'If an account exists with that email, a reset link has been sent.';

/** A non-empty string from the request body, or undefined. */
function bodyString(body: unknown, field: string): string | undefined {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>)[field] : undefined;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * A new session for the user: a 15-minute access token and a 7-day refresh token bound to the current
 * password hash, so the next password change ends it (POST /refresh then answers 401).
 */
function sessionTokens(user: Pick<User, 'id' | 'email' | 'organizationId' | 'role' | 'fullName' | 'passwordHash'>) {
  return {
    accessToken: generateAccessToken({
      id: user.id,
      email: user.email,
      organizationId: user.organizationId,
      role: user.role,
      fullName: user.fullName,
    }),
    refreshToken: generateRefreshToken(user),
  };
}

// POST /api/auth/login — an unknown email and a wrong password take as long and answer the same
router.post('/login', authLimiters.signIn, asyncHandler(async (req: Request, res: Response) => {
  const email = bodyString(req.body, 'email');
  const password = bodyString(req.body, 'password');
  if (!email || !normalizeEmail(email) || !password) throw new AppError(400, 'Email and password are required');

  const found = await findUserByEmail(email);
  const user = await verifySignIn(found, password);
  if (!user) throw new AppError(401, 'Invalid email or password');

  await prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } });

  res.json({
    ...sessionTokens(user),
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      fullNameAr: user.fullNameAr,
      role: user.role,
      languagePref: user.languagePref,
      organization: {
        id: user.organization.id,
        name: user.organization.name,
        nameAr: user.organization.nameAr,
      },
    },
  });
}));

// POST /api/auth/refresh — refused once the password has changed since the refresh token was issued
router.post('/refresh', authLimiters.refresh, asyncHandler(async (req: Request, res: Response) => {
  const refreshToken = bodyString(req.body, 'refreshToken');
  if (!refreshToken) throw new AppError(400, 'Refresh token is required');

  let claims: PasswordBoundClaims;
  try {
    claims = verifyRefreshToken(refreshToken);
  } catch {
    throw sessionEnded();
  }
  const user = await prisma.user.findUnique({ where: { id: claims.id } });
  if (!user || !passwordMatches(claims, user.passwordHash)) throw sessionEnded();

  res.json(sessionTokens(user));
}));

// POST /api/auth/forgot-password — the same answer for known and unknown addresses
router.post(
  '/forgot-password',
  authLimiters.passwordReset,
  authLimiters.forgotPasswordPerEmail,
  asyncHandler(async (req: Request, res: Response) => {
    const email = bodyString(req.body, 'email');
    if (!email || !normalizeEmail(email)) throw new AppError(400, 'Email is required');

    const user = await findUserByEmail(email);
    if (user) {
      // Not awaited, so the answer takes as long for an unknown address. sendPasswordResetEmail never throws and,
      // without email, sends nothing and logs one line with the user id only.
      void sendPasswordResetEmail(user);
    }

    res.json({ message: FORGOT_PASSWORD_ANSWER });
  }),
);

// POST /api/auth/reset-password — single-use: the link stops working once the password changes
router.post('/reset-password', authLimiters.passwordReset, asyncHandler(async (req: Request, res: Response) => {
  const token = bodyString(req.body, 'token');
  const newPassword = bodyString(req.body, 'newPassword');
  if (!token || !newPassword) throw new AppError(400, 'Token and new password are required');

  let claims: PasswordBoundClaims;
  try {
    claims = verifyResetToken(token);
  } catch {
    throw resetLinkInvalid();
  }
  const user = await prisma.user.findUnique({ where: { id: claims.id }, include: { organization: true } });
  if (!user || !passwordMatches(claims, user.passwordHash)) throw resetLinkInvalid();

  await assertNewPassword(newPassword, {
    email: user.email, passwordHash: user.passwordHash, organizationName: user.organization.name,
  });
  const passwordHash = await hashPassword(newPassword);
  // Two requests with the same link: only the first replaces the hash it was issued for. Every session of the
  // account ends with the old hash (its refresh tokens carry the old fingerprint).
  if (!(await replacePasswordHash(user.id, user.passwordHash, passwordHash))) throw resetLinkInvalid();

  res.json({ message: 'Password has been reset successfully.' });
}));

// POST /api/auth/change-password — self-service for every role (signed in; the caller's own account only).
// Every other session of the account ends; the caller gets a new token pair, so this session continues.
router.post('/change-password', authenticate, authLimiters.changePassword, asyncHandler(async (req: Request, res: Response) => {
  const currentPassword = bodyString(req.body, 'currentPassword');
  const newPassword = bodyString(req.body, 'newPassword');
  if (!currentPassword || !newPassword) throw new AppError(400, 'Current password and new password are required');

  const user = await prisma.user.findFirst({
    where: { id: req.user!.id, organizationId: req.user!.organizationId },
    include: { organization: true },
  });
  if (!user) throw new AppError(401, 'Not authenticated');
  if (!(await passwordIsCorrect(currentPassword, user.passwordHash))) {
    throw new AppError(400, 'The current password is incorrect.', 'current_password_incorrect');
  }

  await assertNewPassword(newPassword, { email: user.email, currentPassword, organizationName: user.organization.name });
  const passwordHash = await hashPassword(newPassword);
  if (!(await replacePasswordHash(user.id, user.passwordHash, passwordHash))) {
    throw new AppError(409, 'Your password was changed meanwhile. Sign in again and retry.', 'password_changed_meanwhile');
  }

  res.set('Cache-Control', 'no-store');
  res.json(sessionTokens({ ...user, passwordHash }));
}));

export default router;
