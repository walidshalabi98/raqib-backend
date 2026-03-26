import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { authenticate, authorize } from '../middleware/auth';
import { AppError , asyncHandler } from '../middleware/errorHandler';
import { getReportQueue } from '../jobs/queues';

const router = Router();

// GET /api/projects/:id/reports
router.get('/projects/:id/reports', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
  });
  if (!project) throw new AppError(404, 'Project not found');

  const reports = await prisma.report.findMany({
    where: { projectId: req.params.id },
    orderBy: { generatedAt: 'desc' },
  });
  res.json(reports);
}));

// POST /api/projects/:id/reports/generate — Generate report (async)
router.post('/projects/:id/reports/generate', authenticate, authorize('org_admin', 'platform_admin', 'me_officer'), asyncHandler(async (req: Request, res: Response) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
  });
  if (!project) throw new AppError(404, 'Project not found');

  const { type, title, donorFormat, periodStart, periodEnd } = req.body;
  if (!type || !title) throw new AppError(400, 'type and title are required');

  const report = await prisma.report.create({
    data: {
      projectId: req.params.id,
      type,
      title,
      donorFormat,
      periodStart: periodStart ? new Date(periodStart) : undefined,
      periodEnd: periodEnd ? new Date(periodEnd) : undefined,
    },
  });

  const queue = getReportQueue();
  const job = await queue.add('generate-report', {
    reportId: report.id,
    projectId: req.params.id,
  });

  res.status(202).json({ jobId: job.id, reportId: report.id, status: 'processing' });
}));

// GET /api/reports/:id
router.get('/reports/:id', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const report = await prisma.report.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });

  if (!report || report.project.organizationId !== req.user!.organizationId) {
    throw new AppError(404, 'Report not found');
  }

  res.json(report);
}));

// GET /api/reports/:id/status
router.get('/reports/:id/status', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const report = await prisma.report.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });

  if (!report || report.project.organizationId !== req.user!.organizationId) {
    throw new AppError(404, 'Report not found');
  }

  res.json({
    reportId: report.id,
    status: report.fileUrl ? 'completed' : 'processing',
    fileUrl: report.fileUrl,
  });
}));

export default router;
