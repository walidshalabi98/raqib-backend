import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { prisma } from '../config/prisma';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken, generateResetToken, verifyResetToken } from '../utils/tokens';
import { sendPasswordResetEmail } from '../utils/email';
import { AppError } from '../middleware/errorHandler';

const router = Router();

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) throw new AppError(400, 'Email and password are required');

  const user = await prisma.user.findUnique({
    where: { email },
    include: { organization: true },
  });

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new AppError(401, 'Invalid email or password');
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } });

  const authUser = {
    id: user.id,
    email: user.email,
    organizationId: user.organizationId,
    role: user.role,
    fullName: user.fullName,
  };

  const accessToken = generateAccessToken(authUser);
  const refreshToken = generateRefreshToken(user.id);

  res.json({
    accessToken,
    refreshToken,
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
});

// POST /api/auth/refresh
router.post('/refresh', async (req: Request, res: Response) => {
  const { refreshToken } = req.body;
  if (!refreshToken) throw new AppError(400, 'Refresh token is required');

  const { id } = verifyRefreshToken(refreshToken);
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new AppError(401, 'User not found');

  const authUser = {
    id: user.id,
    email: user.email,
    organizationId: user.organizationId,
    role: user.role,
    fullName: user.fullName,
  };

  const newAccessToken = generateAccessToken(authUser);
  const newRefreshToken = generateRefreshToken(user.id);

  res.json({ accessToken: newAccessToken, refreshToken: newRefreshToken });
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) throw new AppError(400, 'Email is required');

  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    const resetToken = generateResetToken(user.id);
    await sendPasswordResetEmail(email, resetToken);
  }

  // Always return success to prevent email enumeration
  res.json({ message: 'If an account exists with that email, a reset link has been sent.' });
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req: Request, res: Response) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) throw new AppError(400, 'Token and new password are required');
  if (newPassword.length < 8) throw new AppError(400, 'Password must be at least 8 characters');

  const { id } = verifyResetToken(token);
  const passwordHash = await bcrypt.hash(newPassword, 12);

  await prisma.user.update({ where: { id }, data: { passwordHash } });
  res.json({ message: 'Password has been reset successfully.' });
});

export default router;
