import { Router, Request, Response } from 'express';
import { UserRole } from '@prisma/client';
import { prisma } from '../config/prisma';
import { authenticate, authorize } from '../middleware/auth';
import { AppError , asyncHandler } from '../middleware/errorHandler';
import { issueTemporaryPassword } from '../services/auth/passwords';
import { emailMatches } from '../services/auth/accounts';
import { sendAdminResetEmail, sendInviteEmail } from '../utils/email';
import { normalizeEmail } from '../utils/emailAddress';

const router = Router();

/**
 * How a new password reaches the person (docs/SECURITY_SETUP.md §9). When the email went out, it carries a
 * single-use link to choose a password, and the answer holds no password (`emailSent: true`). Otherwise
 * (email off, or the email failed) the answer carries the temporary password once, for the admin to hand over
 * (`temporaryPassword`, with `Cache-Control: no-store`), so the account never ends up with a password nobody
 * knows. It is never logged or written to the audit log.
 */
function temporaryPasswordAnswer(res: Response, emailSent: boolean, password: string): { emailSent: boolean; temporaryPassword?: string } {
  if (emailSent) return { emailSent: true };
  res.set('Cache-Control', 'no-store');
  return { emailSent: false, temporaryPassword: password };
}

// Only a platform admin may grant the platform_admin role; org admins manage their own organisation's roles.
function assertAssignableRole(req: Request, role: string): void {
  if (role === 'platform_admin' && req.user!.role !== 'platform_admin') {
    throw new AppError(403, 'Only a platform admin can assign the platform admin role');
  }
}

/**
 * Only a platform admin may change, remove or reset the password of a platform admin. Checked on every route that
 * acts on another user, so an org admin cannot first demote a platform admin (PATCH) and then reset their password.
 */
function assertCanManage(req: Request, target: { role: UserRole }, refusal: string): void {
  if (target.role === 'platform_admin' && req.user!.role !== 'platform_admin') throw new AppError(403, refusal);
}

// GET /api/users — List users in org
router.get('/', authenticate, authorize('org_admin', 'platform_admin'), asyncHandler(async (req: Request, res: Response) => {
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
}));

// POST /api/users/invite
router.post('/invite', authenticate, authorize('org_admin', 'platform_admin'), asyncHandler(async (req: Request, res: Response) => {
  const { email: rawEmail, fullName, fullNameAr, role } = req.body ?? {};
  const text = (value: unknown): value is string => typeof value === 'string' && value !== '';
  const email = text(rawEmail) ? normalizeEmail(rawEmail) : '';
  if (!email || !text(fullName) || !text(role)) throw new AppError(400, 'Email, fullName, and role are required');
  if (!(Object.values(UserRole) as string[]).includes(role)) throw new AppError(400, 'Unknown role');
  assertAssignableRole(req, role);

  const existing = await prisma.user.findFirst({ where: { email: emailMatches(email) }, select: { id: true } });
  if (existing) throw new AppError(409, 'A user with this email already exists');

  const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.user!.organizationId } });
  const temporary = await issueTemporaryPassword({ email, organizationName: org.name });

  const user = await prisma.user.create({
    data: {
      email,
      fullName,
      fullNameAr,
      role: role as UserRole,
      passwordHash: temporary.passwordHash,
      organizationId: req.user!.organizationId,
    },
    select: { id: true, email: true, fullName: true, role: true, createdAt: true, languagePref: true },
  });

  const { languagePref, ...created } = user;
  const emailSent = await sendInviteEmail({ id: user.id, email: user.email, passwordHash: temporary.passwordHash, languagePref }, org.name);
  res.status(201).json({ ...created, ...temporaryPasswordAnswer(res, emailSent, temporary.password) });
}));

// POST /api/users/:id/reset-password — an admin sets a new temporary password for another user of the organisation
router.post('/:id/reset-password', authenticate, authorize('org_admin', 'platform_admin'), asyncHandler(async (req: Request, res: Response) => {
  // Organisation first: another organisation's user answers 404, whatever their role.
  const target = await prisma.user.findFirst({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
    include: { organization: true },
  });
  if (!target) throw new AppError(404, 'User not found');
  if (target.id === req.user!.id) {
    throw new AppError(400, 'Use Change password for your own account.', 'use_change_password');
  }
  assertCanManage(req, target, "Only a platform admin can reset a platform admin's password");

  const temporary = await issueTemporaryPassword({
    email: target.email, passwordHash: target.passwordHash, organizationName: target.organization.name,
  });
  // The old password, every reset link and every session issued for it stop working (they carry the old
  // hash's fingerprint).
  await prisma.user.update({ where: { id: target.id }, data: { passwordHash: temporary.passwordHash } });

  const emailSent = await sendAdminResetEmail({
    id: target.id, email: target.email, passwordHash: temporary.passwordHash, languagePref: target.languagePref,
  });
  res.json({ id: target.id, ...temporaryPasswordAnswer(res, emailSent, temporary.password) });
}));

// PATCH /api/users/:id
router.patch('/:id', authenticate, authorize('org_admin', 'platform_admin'), asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;

  // Ensure user belongs to same org
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target || target.organizationId !== req.user!.organizationId) {
    throw new AppError(404, 'User not found');
  }

  assertCanManage(req, target, "Only a platform admin can change a platform admin's account");
  const { fullName, fullNameAr, role, languagePref } = req.body;
  if (role !== undefined) assertAssignableRole(req, role);
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
}));

// DELETE /api/users/:id — Deactivate
router.delete('/:id', authenticate, authorize('org_admin', 'platform_admin'), asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target || target.organizationId !== req.user!.organizationId) {
    throw new AppError(404, 'User not found');
  }
  if (id === req.user!.id) throw new AppError(400, 'Cannot deactivate yourself');
  assertCanManage(req, target, 'Only a platform admin can remove a platform admin');

  // The user's own notifications go with them (Notification.userId has no cascade): without this, a donor viewer
  // told about a published report could never be removed, and would keep read access.
  await prisma.$transaction([
    prisma.notification.deleteMany({ where: { userId: id } }),
    prisma.user.delete({ where: { id } }),
  ]);
  res.json({ message: 'User deactivated' });
}));

export default router;
