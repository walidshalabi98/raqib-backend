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
 * The signed-in user from a verified token payload, or null when the payload is not an access token.
 * Access tokens must carry an organisation and a role; a token with a `purpose` claim (a password-reset
 * token) is refused. Only the five claims are kept.
 */
export function accessTokenUser(payload: unknown): AuthUser | null {
  if (!payload || typeof payload !== 'object' || Object.prototype.hasOwnProperty.call(payload, 'purpose')) return null;
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
    payload = jwt.verify(token, env.jwtSecret);
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

export function authorize(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ message: 'Not authenticated' });
      return;
    }
    if (roles.length > 0 && !roles.includes(req.user.role)) {
      res.status(403).json({ message: 'Insufficient permissions' });
      return;
    }
    next();
  };
}
