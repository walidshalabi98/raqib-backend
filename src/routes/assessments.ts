import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { assertAssessmentAccess, assertProjectAccess } from '../middleware/access';
import { authenticate, authorize } from '../middleware/auth';
import { hasStaffRole } from '../middleware/roles';
import { AppError , asyncHandler } from '../middleware/errorHandler';
import { aiLimiter } from '../middleware/rateLimit';
import { generateAutoAssessment } from '../services/ai/assessmentGenerator';
import { safeErrorSummary } from '../services/ai/errors';
import { toDonorAssessment } from '../services/privacy/donorView';

const router = Router();

// GET /api/projects/:id/assessments — donor viewers get toDonorAssessment: never scopeDescription (the AI
// assessment, written from transcript excerpts), the price or the report location (SECURITY_SETUP §8.3).
router.get('/projects/:id/assessments', authenticate, asyncHandler(async (req: Request, res: Response) => {
  await assertProjectAccess(req, req.params.id);

  const assessments = await prisma.assessment.findMany({
    where: { projectId: req.params.id },
    include: {
      _count: { select: { dataPoints: true, qualitativeEntries: true } },
    },
    orderBy: { requestedAt: 'desc' },
  });
  res.json(hasStaffRole(req.user) ? assessments : assessments.map(toDonorAssessment));
}));

// POST /api/projects/:id/assessments — Request new assessment
router.post('/projects/:id/assessments', authenticate, authorize('org_admin', 'platform_admin', 'me_officer'), aiLimiter, asyncHandler(async (req: Request, res: Response) => {
  await assertProjectAccess(req, req.params.id);

  const { type, scopeDescription, sampleSize, methodsIncluded } = req.body;
  if (!type) throw new AppError(400, 'Assessment type is required');

  const autoGenerate = req.body.autoGenerate !== false; // default: AI generates

  const assessment = await prisma.assessment.create({
    data: {
      projectId: req.params.id,
      type,
      scopeDescription: scopeDescription || `AI-generated ${type} assessment`,
      sampleSize,
      methodsIncluded: methodsIncluded || [],
    },
  });

  // Trigger AI auto-assessment generation
  if (autoGenerate) {
    generateAutoAssessment(assessment.id, req.params.id, type).catch(err => {
      console.error(`Auto-assessment generation failed for ${assessment.id}: ${safeErrorSummary(err)}`);
    });
  }

  res.status(201).json({ ...assessment, autoGenerating: autoGenerate });
}));

// PATCH /api/assessments/:id — Update status
router.patch('/assessments/:id', authenticate, authorize('org_admin', 'platform_admin'), asyncHandler(async (req: Request, res: Response) => {
  await assertAssessmentAccess(req, req.params.id);

  const { status, priceUsd, startedAt, deliveredAt, reportUrl } = req.body;

  const updated = await prisma.assessment.update({
    where: { id: req.params.id },
    data: {
      ...(status !== undefined && { status }),
      ...(priceUsd !== undefined && { priceUsd }),
      ...(startedAt !== undefined && { startedAt: new Date(startedAt) }),
      ...(deliveredAt !== undefined && { deliveredAt: new Date(deliveredAt) }),
      ...(reportUrl !== undefined && { reportUrl }),
    },
  });

  res.json(updated);
}));

// GET /api/assessments/:id/report — Get AI-generated assessment report. Donor viewers get `report: null`: the
// report is unreviewed AI output written from transcript excerpts, and assessments have no approval step yet.
router.get('/assessments/:id/report', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const assessment = await assertAssessmentAccess(req, req.params.id);

  let report = null;
  if (assessment.scopeDescription && hasStaffRole(req.user)) {
    try { report = JSON.parse(assessment.scopeDescription); } catch { report = null; }
  }

  res.json({
    assessmentId: assessment.id,
    status: assessment.status,
    type: assessment.type,
    report,
    deliveredAt: assessment.deliveredAt,
  });
}));

// GET /api/assessments/:id/estimate — Price estimate
router.get('/assessments/:id/estimate', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const assessment = await assertAssessmentAccess(req, req.params.id);

  // Simple pricing model based on methods and sample size
  const basePrices: Record<string, number> = {
    baseline: 5000,
    midterm: 4000,
    endline: 5000,
    fgd_round: 1500,
    kii_round: 1200,
    observation_round: 800,
    survey_round: 2000,
  };

  const basePrice = basePrices[assessment.type] || 2000;
  const methodCount = Array.isArray(assessment.methodsIncluded) ? (assessment.methodsIncluded as string[]).length : 1;
  const sampleMultiplier = assessment.sampleSize ? Math.max(1, assessment.sampleSize / 100) : 1;

  const estimate = Math.round(basePrice * methodCount * sampleMultiplier);

  res.json({
    assessmentId: assessment.id,
    estimatedPriceUsd: estimate,
    breakdown: {
      basePrice,
      methodCount,
      sampleMultiplier: sampleMultiplier.toFixed(2),
    },
  });
}));

export default router;
