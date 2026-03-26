import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { authenticate } from '../middleware/auth';
import { AppError , asyncHandler } from '../middleware/errorHandler';

const router = Router();

// GET /api/projects/:id/qualitative
router.get('/projects/:id/qualitative', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
  });
  if (!project) throw new AppError(404, 'Project not found');

  const entries = await prisma.qualitativeEntry.findMany({
    where: { projectId: req.params.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json(entries);
}));

// POST /api/projects/:id/qualitative — Add entry
router.post('/projects/:id/qualitative', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
  });
  if (!project) throw new AppError(404, 'Project not found');

  const {
    entryType, title, content, participants, location,
    dateConducted, facilitator, assessmentId, attachments,
  } = req.body;

  if (!entryType || !title || !content) {
    throw new AppError(400, 'entryType, title, and content are required');
  }

  const entry = await prisma.qualitativeEntry.create({
    data: {
      projectId: req.params.id,
      entryType,
      title,
      content,
      participants,
      location,
      dateConducted: dateConducted ? new Date(dateConducted) : undefined,
      facilitator,
      assessmentId,
      attachments,
    },
  });

  res.status(201).json(entry);
}));

// GET /api/qualitative/:id — Get full entry with themes
router.get('/qualitative/:id', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const entry = await prisma.qualitativeEntry.findUnique({
    where: { id: req.params.id },
    include: { project: true, assessment: true },
  });

  if (!entry || entry.project.organizationId !== req.user!.organizationId) {
    throw new AppError(404, 'Entry not found');
  }

  res.json(entry);
}));

// POST /api/qualitative/:id/code — Trigger AI thematic coding
router.post('/qualitative/:id/code', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const entry = await prisma.qualitativeEntry.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });

  if (!entry || entry.project.organizationId !== req.user!.organizationId) {
    throw new AppError(404, 'Entry not found');
  }

  // Thematic coding runs inline (no Redis/BullMQ needed)
  // TODO: Add AI thematic coding service
  res.status(202).json({ entryId: req.params.id, status: 'processing' });
}));

export default router;
