import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { assertIndicatorAccess } from '../middleware/access';
import { authenticate, authorize } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { aiLimiter, kpiOrgLimiter } from '../middleware/rateLimit';
import { levelForResult } from '../services/indicators/hierarchy';
import { assertIndicatorReferences } from '../services/indicators/references';
import { INDICATOR_INCLUDE } from '../services/indicators/selects';
import { parseIndicatorUpdate, provenanceAfterUpdate, toIndicatorUpdateData } from '../services/indicators/validation';
import { handleKpiRequest, KPI_ROLES } from '../services/kpi/requests';

const router = Router();

// PATCH /api/indicators/:id — any subset of the indicator and reference-sheet fields.
// Provenance is set by the server; a linked indicator's level must match its result's level.
router.patch('/:id', authenticate, authorize('org_admin', 'platform_admin', 'me_officer'), asyncHandler(async (req: Request, res: Response) => {
  const indicator = await assertIndicatorAccess(req, req.params.id);
  const input = parseIndicatorUpdate(req.body);
  const { result } = await assertIndicatorReferences(indicator.frameworkId, input);
  const data = toIndicatorUpdateData(input);

  // Level fits the result (knowledge/me-foundations.md §2 rule 5), checked whenever the update sets either.
  if (input.level !== undefined || input.resultId !== undefined) {
    const resultId = input.resultId === undefined ? indicator.resultId : input.resultId;
    const resultLevel = result?.level ?? (resultId
      ? (await prisma.resultNode.findUnique({ where: { id: resultId }, select: { level: true } }))?.level
      : null);
    // As on create, a newly linked result sets the level when none is sent.
    const fit = levelForResult(input.level ?? (input.resultId === undefined ? indicator.level : undefined), resultLevel);
    if (fit.ok === false) throw new AppError(400, fit.message);
    if (fit.level !== undefined && fit.level !== indicator.level) data.level = fit.level;
  }

  const provenance = provenanceAfterUpdate(indicator.provenance, input.libraryId === undefined ? indicator.libraryId : input.libraryId);
  if (provenance !== indicator.provenance) data.provenance = provenance;

  const updated = await prisma.indicator.update({
    where: { id: indicator.id },
    data,
    include: INDICATOR_INCLUDE,
  });

  res.json(updated);
}));

// POST /api/indicators/:id/alternative — KPI Assistant alternatives for this indicator (alias of
// POST /api/projects/:id/kpi-suggestions with { scope: 'alternatives', indicatorId }; design 7.1). The request body
// is ignored. An indicator of an older framework version answers 409 stale; one without a result 422 not_suggestable.
router.post('/:id/alternative', authenticate, authorize(...KPI_ROLES), aiLimiter, kpiOrgLimiter, asyncHandler(async (req: Request, res: Response) => {
  const indicator = await assertIndicatorAccess(req, req.params.id);
  await handleKpiRequest(req, res, indicator.framework.project, { scope: 'alternatives', indicatorId: indicator.id }, 'alias');
}));

// PATCH /api/indicators/:id/approve
router.patch('/:id/approve', authenticate, authorize('org_admin', 'platform_admin'), asyncHandler(async (req: Request, res: Response) => {
  await assertIndicatorAccess(req, req.params.id);

  const updated = await prisma.indicator.update({
    where: { id: req.params.id },
    data: { isApproved: true },
    include: INDICATOR_INCLUDE,
  });

  res.json(updated);
}));

// DELETE /api/indicators/:id
router.delete('/:id', authenticate, authorize('org_admin', 'platform_admin', 'me_officer'), asyncHandler(async (req: Request, res: Response) => {
  await assertIndicatorAccess(req, req.params.id);

  await prisma.indicator.delete({ where: { id: req.params.id } });
  res.json({ message: 'Indicator deleted' });
}));

export default router;
