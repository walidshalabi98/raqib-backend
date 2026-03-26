import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { prisma } from '../config/prisma';
import { authenticate, authorize } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { sendInviteEmail } from '../utils/email';

const router = Router();

// GET /api/users — List users in org
router.get('/', authenticate, authorize('org_admin', 'platform_admin'), async (req: Request, res: Response) => {
  const users = await prisma.user.findMany({
    where: { organizationId: req.user!.organizationId },
    select: {
      id: true,
      email: true,
      fullName: true,
      fullNameAr: true,
      role: true,
      languagePref: true,
      createdAt: true,
      lastLogin: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json(users);
});

// POST /api/users/invite
router.post('/invite', authenticate, authorize('org_admin', 'platform_admin'), async (req: Request, res: Response) => {
  const { email, fullName, fullNameAr, role } = req.body;
  if (!email || !fullName || !role) throw new AppError(400, 'Email, fullName, and role are required');

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new AppError(409, 'A user with this email already exists');

  const tempPassword = crypto.randomBytes(8).toString('hex');
  const passwordHash = await bcrypt.hash(tempPassword, 12);

  const org = await prisma.organization.findUnique({ where: { id: req.user!.organizationId } });

  const user = await prisma.user.create({
    data: {
      email,
      fullName,
      fullNameAr,
      role,
      passwordHash,
      organizationId: req.user!.organizationId,
    },
    select: { id: true, email: true, fullName: true, role: true, createdAt: true },
  });

  await sendInviteEmail(email, org!.name, tempPassword);
  res.status(201).json(user);
});

// PATCH /api/users/:id
router.patch('/:id', authenticate, authorize('org_admin', 'platform_admin'), async (req: Request, res: Response) => {
  const { id } = req.params;

  // Ensure user belongs to same org
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target || target.organizationId !== req.user!.organizationId) {
    throw new AppError(404, 'User not found');
  }

  const { fullName, fullNameAr, role, languagePref } = req.body;
  const updated = await prisma.user.update({
    where: { id },
    data: {
      ...(fullName !== undefined && { fullName }),
      ...(fullNameAr !== undefined && { fullNameAr }),
      ...(role !== undefined && { role }),
      ...(languagePref !== undefined && { languagePref }),
    },
    select: { id: true, email: true, fullName: true, fullNameAr: true, role: true, languagePref: true },
  });

  res.json(updated);
});

// DELETE /api/users/:id — Deactivate
router.delete('/:id', authenticate, authorize('org_admin', 'platform_admin'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target || target.organizationId !== req.user!.organizationId) {
    throw new AppError(404, 'User not found');
  }
  if (id === req.user!.id) throw new AppError(400, 'Cannot deactivate yourself');

  await prisma.user.delete({ where: { id } });
  res.json({ message: 'User deactivated' });
});

export default router;
