import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { authenticate, authorize } from '../middleware/auth';
import { AppError , asyncHandler } from '../middleware/errorHandler';
import { createWebhookToken } from '../services/webhookTokens';

const router = Router();

// GET /api/organizations/:id
router.get('/:id', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  if (id !== req.user!.organizationId) throw new AppError(404, 'Organization not found');

  const org = await prisma.organization.findUnique({
    where: { id },
    include: { _count: { select: { users: true, projects: true } } },
  });
  if (!org) throw new AppError(404, 'Organization not found');

  res.json(org);
}));

// PATCH /api/organizations/:id
router.patch('/:id', authenticate, authorize('org_admin', 'platform_admin'), asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  if (id !== req.user!.organizationId && req.user!.role !== 'platform_admin') {
    throw new AppError(404, 'Organization not found');
  }

  const { name, nameAr, logoUrl, contactEmail, contactPhone } = req.body;
  const org = await prisma.organization.update({
    where: { id },
    data: {
      ...(name !== undefined && { name }),
      ...(nameAr !== undefined && { nameAr }),
      ...(logoUrl !== undefined && { logoUrl }),
      ...(contactEmail !== undefined && { contactEmail }),
      ...(contactPhone !== undefined && { contactPhone }),
    },
  });

  res.json(org);
}));

// Webhook tokens: organisation admins create a token and paste it into the
// KoboToolbox REST service (or Manasati) as the X-Raqib-Webhook-Token header.
function assertOwnOrganization(req: Request): string {
  if (req.params.id !== req.user!.organizationId) throw new AppError(404, 'Organization not found');
  return req.params.id;
}

const tokenSummary = {
  id: true, tokenPrefix: true, createdAt: true, lastUsedAt: true, revokedAt: true,
  createdBy: { select: { fullName: true } },
} as const;

// GET /api/organizations/:id/webhook-tokens
router.get('/:id/webhook-tokens', authenticate, authorize('org_admin', 'platform_admin'), asyncHandler(async (req: Request, res: Response) => {
  const organizationId = assertOwnOrganization(req);
  const tokens = await prisma.webhookToken.findMany({
    where: { organizationId },
    select: tokenSummary,
    orderBy: { createdAt: 'desc' },
  });
  res.json(tokens);
}));

// POST /api/organizations/:id/webhook-tokens — Returns the plain token once
router.post('/:id/webhook-tokens', authenticate, authorize('org_admin', 'platform_admin'), asyncHandler(async (req: Request, res: Response) => {
  const organizationId = assertOwnOrganization(req);
  const { token, record } = await createWebhookToken(organizationId, req.user!.id);
  res.status(201).json({
    id: record.id,
    token,
    tokenPrefix: record.tokenPrefix,
    createdAt: record.createdAt,
    message: 'Copy this token now. It will not be shown again.',
  });
}));

// DELETE /api/organizations/:id/webhook-tokens/:tokenId — Revoke
router.delete('/:id/webhook-tokens/:tokenId', authenticate, authorize('org_admin', 'platform_admin'), asyncHandler(async (req: Request, res: Response) => {
  const organizationId = assertOwnOrganization(req);
  const result = await prisma.webhookToken.updateMany({
    where: { id: req.params.tokenId, organizationId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (result.count === 0) throw new AppError(404, 'Webhook token not found');
  res.json({ message: 'Webhook token revoked' });
}));

export default router;
