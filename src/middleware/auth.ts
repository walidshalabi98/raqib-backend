import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../config/env';
import { UserRole } from '@prisma/client';
import { AuthUser } from '../types/express';

/** The claims of an access token (generateAccessToken): every one is required. */
const accessTokenClaims = z.object({
  id: z.string().uuid(),
  email: z.string().min(1),
  organizationId: z.string().uuid(),
  role: z.nativeEnum(UserRole),
  fullName: z.string(),
});

/**
 * Claims an access token never has: a password-reset token carries both, a refresh token an audience
 * (src/utils/tokens.ts).
 */
const NOT_ACCESS_CLAIMS = ['purpose', 'aud'] as const;

/**
 * The signed-in user from a verified token payload, or null when the payload is not an access token.
 * Access tokens must carry an organisation and a role; a token with a `purpose` or an audience (`aud`) claim,
 * such as a password-reset token, is refused. Only the five claims are kept.
 */
export function accessTokenUser(payload: unknown): AuthUser | null {
  if (!payload || typeof payload !== 'object') return null;
  if (NOT_ACCESS_CLAIMS.some(claim => Object.prototype.hasOwnProperty.call(payload, claim))) return null;
  const parsed = accessTokenClaims.safeParse(payload);
  if (!parsed.success) return null;
  const { id, email, organizationId, role, fullName } = parsed.data;
  return { id, email, organizationId, role, fullName };
}

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ message: 'Missing or invalid authorization header' });
    return;
  }

  const token = authHeader.split(' ')[1];
  let payload: unknown;
  try {
    payload = jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    res.status(401).json({ message: 'Invalid or expired token' });
    return;
  }
  const user = accessTokenUser(payload);
  if (!user) {
    res.status(401).json({ message: 'Invalid or expired token' });
    return;
  }
  req.user = user;
  next();
}

/** A role check, tagged with the roles it allows so tests/roles.test.ts can compare every route with its matrix entry. */
export type RoleGuard = ((req: Request, res: Response, next: NextFunction) => void) & { readonly allowedRoles: readonly UserRole[] };

/**
 * Refuses (403 "Insufficient permissions") any role not listed, including a missing role. At least one
 * role is required: there is no "empty list allows everyone" form. Put it straight after `authenticate`,
 * before multer and any rate limiter, so a refused request costs nothing.
 */
export function authorize(...roles: [UserRole, ...UserRole[]]): RoleGuard {
  if (roles.length === 0) throw new Error('authorize() needs at least one role');
  const allowedRoles: readonly UserRole[] = Object.freeze([...roles]);
  const roleGuard = (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ message: 'Not authenticated' });
      return;
    }
    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({ message: 'Insufficient permissions' });
      return;
    }
    next();
  };
  return Object.assign(roleGuard, { allowedRoles });
}
