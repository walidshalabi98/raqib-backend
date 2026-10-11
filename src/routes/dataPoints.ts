import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { assertAssessmentInProject, assertIndicatorAccess, assertIndicatorsInProject, assertProjectAccess } from '../middleware/access';
import { authenticate } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { validationErrorBody } from '../services/dataPoints/fields';
import {
  BulkRowFields, completeDataPoint, parseBulkRowFields, parseDataPointFields, rowLabel,
} from '../services/dataPoints/validation';

const router = Router();

// GET /api/indicators/:id/data — Get data points for indicator (with trend)
router.get('/indicators/:id/data', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const indicator = await assertIndicatorAccess(req, req.params.id);

  const dataPoints = await prisma.dataPoint.findMany({
    where: { indicatorId: req.params.id },
    orderBy: { collectionDate: 'asc' },
    include: { creator: { select: { fullName: true } } },
  });

  // Compute trend
  const values = dataPoints
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
    dataPoints,
    trend,
    count: dataPoints.length,
  });
}));

// POST /api/indicators/:id/data — Add data point (optionally disaggregated by `breakdown`)
router.post('/indicators/:id/data', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const indicator = await assertIndicatorAccess(req, req.params.id);

  const fields = parseDataPointFields(req.body);
  if (fields.ok === false) {
    res.status(400).json(validationErrorBody(fields.errors));
    return;
  }
  const input = completeDataPoint(fields.data, indicator.unit);
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

  // Update indicator's current value
  await prisma.indicator.update({
    where: { id: req.params.id },
    data: { currentValue: dp.value },
  });

  res.status(201).json(dataPoint);
}));

// POST /api/projects/:id/data/bulk — Bulk import data (each row may carry a `breakdown`)
router.post('/projects/:id/data/bulk', authenticate, asyncHandler(async (req: Request, res: Response) => {
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

  // Breakdowns are checked against each indicator's unit (count units must add up to the value).
  const indicators = await prisma.indicator.findMany({
    where: { id: { in: Array.from(new Set(indicatorIds)) }, framework: { projectId: req.params.id } },
    select: { id: true, unit: true },
  });
  const unitById = new Map(indicators.map(ind => [ind.id, ind.unit]));
  const data: Prisma.DataPointCreateManyInput[] = [];
  rows.forEach((row, i) => {
    const input = completeDataPoint(row, unitById.get(row.indicatorId), rowLabel(i));
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

  const created = await prisma.dataPoint.createMany({ data });

  res.status(201).json({ count: created.count });
}));

export default router;
