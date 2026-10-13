import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { assertProjectAccess, assertReportAccess } from '../middleware/access';
import { authenticate, authorize } from '../middleware/auth';
import { hasStaffRole } from '../middleware/roles';
import { AppError , asyncHandler } from '../middleware/errorHandler';
import { aiLimiter } from '../middleware/rateLimit';
import { generateReportNarrative } from '../services/ai/reportNarrative';
import { safeErrorSummary } from '../services/ai/errors';
import { donorCanSeeReport, donorReportWhere, toDonorReport } from '../services/privacy/donorView';

const router = Router();

// Donor viewers see published reports only, from an explicit field list: a draft holds an unreviewed AI
// narrative (for assessment reports, written from transcript excerpts). Hidden reports answer 404 like another
// organisation's id (SECURITY_SETUP §8.3).

// GET /api/projects/:id/reports
router.get('/projects/:id/reports', authenticate, asyncHandler(async (req: Request, res: Response) => {
  await assertProjectAccess(req, req.params.id);

  const reports = await prisma.report.findMany({
    where: { projectId: req.params.id, ...donorReportWhere(req.user) },
    orderBy: { generatedAt: 'desc' },
  });
  res.json(hasStaffRole(req.user) ? reports : reports.map(toDonorReport));
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
    console.error(`Report generation failed for ${report.id}: ${safeErrorSummary(err)}`);
  });

  res.status(202).json({ reportId: report.id, status: 'processing' });
}));

/** A report the caller may see: any for staff, published only for everyone else (404 otherwise). */
async function visibleReport(req: Request, id: string) {
  const report = await assertReportAccess(req, id);
  if (!hasStaffRole(req.user) && !donorCanSeeReport(report)) throw new AppError(404, 'Report not found');
  return report;
}

// GET /api/reports/:id
router.get('/reports/:id', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const report = await visibleReport(req, req.params.id);

  res.json(hasStaffRole(req.user) ? report : toDonorReport(report));
}));

// GET /api/reports/:id/status
router.get('/reports/:id/status', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const report = await visibleReport(req, req.params.id);

  res.json({
    reportId: report.id,
    status: report.fileUrl ? 'completed' : 'processing',
    ...(hasStaffRole(req.user) && { fileUrl: report.fileUrl }),
  });
}));

export default router;
