import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { AuthUser } from '../types/express';

export function generateAccessToken(user: AuthUser): string {
  return jwt.sign(user, env.jwtSecret, { expiresIn: '15m' });
}

export function generateRefreshToken(userId: string): string {
  return jwt.sign({ id: userId }, env.jwtRefreshSecret, { expiresIn: '7d' });
}

export function verifyRefreshToken(token: string): { id: string } {
  return jwt.verify(token, env.jwtRefreshSecret) as { id: string };
}

export function generateResetToken(userId: string): string {
  return jwt.sign({ id: userId, purpose: 'reset' }, env.jwtSecret, { expiresIn: '1h' });
}

export function verifyResetToken(token: string): { id: string } {
  const payload = jwt.verify(token, env.jwtSecret) as { id: string; purpose: string };
  if (payload.purpose !== 'reset') throw new Error('Invalid token purpose');
  return { id: payload.id };
}
