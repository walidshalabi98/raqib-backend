import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { assertProjectAccess, assertReportAccess } from '../middleware/access';
import { authenticate, authorize } from '../middleware/auth';
import { AppError , asyncHandler } from '../middleware/errorHandler';
import { aiLimiter } from '../middleware/rateLimit';
import { generateReportNarrative } from '../services/ai/reportNarrative';

const router = Router();

// GET /api/projects/:id/reports
router.get('/projects/:id/reports', authenticate, asyncHandler(async (req: Request, res: Response) => {
  await assertProjectAccess(req, req.params.id);

  const reports = await prisma.report.findMany({
    where: { projectId: req.params.id },
    orderBy: { generatedAt: 'desc' },
  });
  res.json(reports);
}));

// POST /api/projects/:id/reports/generate — Generate report (async)
router.post('/projects/:id/reports/generate', authenticate, authorize('org_admin', 'platform_admin', 'me_officer'), aiLimiter, asyncHandler(async (req: Request, res: Response) => {
  await assertProjectAccess(req, req.params.id);

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

  // Generate report async inline (no Redis needed)
  generateReportNarrative(report.id, req.params.id).catch(err => {
    console.error('Report generation failed:', err.message);
  });

  res.status(202).json({ reportId: report.id, status: 'processing' });
}));

// GET /api/reports/:id
router.get('/reports/:id', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const report = await assertReportAccess(req, req.params.id);

  res.json(report);
}));

// GET /api/reports/:id/status
router.get('/reports/:id/status', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const report = await assertReportAccess(req, req.params.id);

  res.json({
    reportId: report.id,
    status: report.fileUrl ? 'completed' : 'processing',
    fileUrl: report.fileUrl,
  });
}));

export default router;
