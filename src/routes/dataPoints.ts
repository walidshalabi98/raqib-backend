import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { assertAssessmentInProject, assertIndicatorAccess, assertIndicatorsInProject, assertProjectAccess } from '../middleware/access';
import { authenticate, authorize } from '../middleware/auth';
import { hasStaffRole } from '../middleware/roles';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { validationErrorBody } from '../services/dataPoints/fields';
import { canSeeIndicator } from '../services/indicators/visibility';
import {
  BulkRowFields, completeDataPoint, parseBulkRowFields, parseDataPointFields, rowLabel,
} from '../services/dataPoints/validation';
import { isRespondentLevel, NOT_RESPONDENT_LEVEL_WHERE, toDonorIndicatorData } from '../services/privacy/donorView';

const router = Router();

// GET /api/indicators/:id/data — Get data points for indicator (with trend). A donor viewer gets 404 for an
// unapproved indicator, as for another organisation's id (spec §A1; design section 4.7).
router.get('/indicators/:id/data', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const indicator = await assertIndicatorAccess(req, req.params.id);
  if (!canSeeIndicator(req.user, indicator)) throw new AppError(404, 'Indicator not found');

  const dataPoints = await prisma.dataPoint.findMany({
    where: { indicatorId: req.params.id },
    orderBy: { collectionDate: 'asc' },
    include: { creator: { select: { fullName: true } } },
  });
  // Donor viewers (SECURITY_SETUP §8.3): no notes, attachments, author or unlisted areas; KoboToolbox rows (one
  // respondent each) only as released monthly aggregates; the trend and count from what they are shown.
  const staff = hasStaffRole(req.user);
  const donor = staff ? null : toDonorIndicatorData(dataPoints, () => indicator.unit);
  const series = donor
    ? [
      ...donor.dataPoints.map(dp => ({ at: dp.collectionDate.toISOString().slice(0, 7), value: dp.value })),
      ...donor.surveyAggregates.filter(a => a.value !== null).map(a => ({ at: a.period, value: String(a.value) })),
    ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    : dataPoints.map(dp => ({ at: '', value: dp.value }));

  // Compute trend
  const values = series
    .map(dp => parseFloat(dp.value))
    .filter(v => !isNaN(v));

  let trend: 'increasing' | 'decreasing' | 'stable' | 'insufficient_data' = 'insufficient_data';
  if (values.length >= 2) {
    const recent = values.slice(-3);
    const diffs = recent.slice(1).map((v, i) => v - recent[i]);
    const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    if (avgDiff > 0.01) trend = 'increasing';
    else if (avgDiff < -0.01) trend = 'decreasing';
    else trend = 'stable';
  }

  res.json({
    indicator: {
      id: indicator.id,
      text: indicator.indicatorText,
      baselineValue: indicator.baselineValue,
      targetValue: indicator.targetValue,
      currentValue: indicator.currentValue,
      // Lets data entry show the right breakdown inputs (counts must add up to the value).
      unit: indicator.unit,
      disaggregation: indicator.disaggregation,
    },
    ...(donor
      ? { dataPoints: donor.dataPoints, surveyAggregates: donor.surveyAggregates, trend, count: donor.dataPoints.length }
      : { dataPoints, trend, count: dataPoints.length }),
  });
}));

// POST /api/indicators/:id/data — Add data point (optionally disaggregated by `breakdown`); donor viewers only read
router.post('/indicators/:id/data', authenticate, authorize('org_admin', 'platform_admin', 'me_officer'), asyncHandler(async (req: Request, res: Response) => {
  const indicator = await assertIndicatorAccess(req, req.params.id);

  const fields = parseDataPointFields(req.body);
  if (fields.ok === false) {
    res.status(400).json(validationErrorBody(fields.errors));
    return;
  }
  const input = completeDataPoint(fields.data, indicator);
  if (input.ok === false) {
    res.status(400).json(validationErrorBody(input.errors));
    return;
  }
  const dp = input.data;
  await assertAssessmentInProject(indicator.framework.project.id, dp.assessmentId);

  const dataPoint = await prisma.dataPoint.create({
    data: {
      indicatorId: req.params.id,
      projectId: indicator.framework.project.id,
      value: dp.value,
      collectionDate: dp.collectionDate,
      collectionMethod: dp.collectionMethod,
      dataSource: dp.dataSource,
      geographicArea: dp.geographicArea,
      notes: dp.notes,
      assessmentId: dp.assessmentId,
      attachments: dp.attachments,
      breakdown: dp.breakdown ?? undefined,
      createdBy: req.user!.id,
    },
  });

  // Update indicator's current value (numbers in the same canonical form as the data point), unless the row is
  // a KoboToolbox answer: the current value is a result, never one household's answer (SECURITY_SETUP §8.3).
  if (!isRespondentLevel(dataPoint)) {
    await prisma.indicator.update({
      where: { id: req.params.id },
      data: { currentValue: dp.value },
    });
  }

  res.status(201).json(dataPoint);
}));

// POST /api/projects/:id/data/bulk — Bulk import data (each row may carry a `breakdown`); donor viewers only read
router.post('/projects/:id/data/bulk', authenticate, authorize('org_admin', 'platform_admin', 'me_officer'), asyncHandler(async (req: Request, res: Response) => {
  await assertProjectAccess(req, req.params.id);

  const { dataPoints } = req.body;
  if (!Array.isArray(dataPoints) || dataPoints.length === 0) {
    throw new AppError(400, 'dataPoints array is required');
  }
  const missingIds = dataPoints
    .map((dp: { indicatorId?: unknown }, i: number) => (typeof dp?.indicatorId === 'string' && dp.indicatorId ? null : i + 1))
    .filter((row): row is number => row !== null);
  if (missingIds.length > 0) {
    throw new AppError(400, `Every data point needs an indicatorId (missing in row ${missingIds.slice(0, 10).join(', ')}${missingIds.length > 10 ? ', ...' : ''})`);
  }

  // Validate every row first so all problems are reported together, with their row number.
  const rows: BulkRowFields[] = [];
  const errors: string[] = [];
  dataPoints.forEach((raw: unknown, i: number) => {
    const row = parseBulkRowFields(raw, i);
    if (row.ok === true) rows.push(row.data);
    else errors.push(...row.errors);
  });
  if (errors.length > 0) {
    res.status(400).json(validationErrorBody(errors));
    return;
  }

  // Every referenced indicator and assessment must belong to this project.
  const indicatorIds = rows.map(r => r.indicatorId);
  await assertIndicatorsInProject(req.params.id, indicatorIds);
  for (const assessmentId of new Set(rows.map(r => r.assessmentId).filter(Boolean))) {
    await assertAssessmentInProject(req.params.id, assessmentId as string);
  }

  // Breakdowns are checked against each indicator's unit and text (count units must add up to the value).
  const indicators = await prisma.indicator.findMany({
    where: { id: { in: Array.from(new Set(indicatorIds)) }, framework: { projectId: req.params.id } },
    select: { id: true, unit: true, indicatorText: true },
  });
  const indicatorById = new Map(indicators.map(ind => [ind.id, ind]));
  const data: Prisma.DataPointCreateManyInput[] = [];
  rows.forEach((row, i) => {
    const input = completeDataPoint(row, indicatorById.get(row.indicatorId) ?? { unit: null }, rowLabel(i));
    if (input.ok === false) {
      errors.push(...input.errors);
      return;
    }
    const dp = input.data;
    data.push({
      indicatorId: row.indicatorId,
      projectId: req.params.id,
      value: dp.value,
      collectionDate: dp.collectionDate,
      collectionMethod: dp.collectionMethod,
      dataSource: dp.dataSource,
      geographicArea: dp.geographicArea,
      notes: dp.notes,
      assessmentId: dp.assessmentId,
      attachments: dp.attachments,
      breakdown: dp.breakdown ?? undefined,
      createdBy: req.user!.id,
    });
  });
  if (errors.length > 0) {
    res.status(400).json(validationErrorBody(errors));
    return;
  }

  const created = await prisma.$transaction(async tx => {
    const result = await tx.dataPoint.createMany({ data });
    // Each imported indicator's current value becomes its most recent result (by collection date): never a
    // KoboToolbox row, which is one household's answer (SECURITY_SETUP §8.3).
    for (const indicatorId of new Set(data.map(d => d.indicatorId))) {
      const latest = await tx.dataPoint.findFirst({
        where: { indicatorId, ...NOT_RESPONDENT_LEVEL_WHERE },
        orderBy: [{ collectionDate: 'desc' }, { createdAt: 'desc' }],
        select: { value: true },
      });
      if (latest) await tx.indicator.update({ where: { id: indicatorId }, data: { currentValue: latest.value } });
    }
    return result;
  });

  res.status(201).json({ count: created.count });
}));

export default router;
