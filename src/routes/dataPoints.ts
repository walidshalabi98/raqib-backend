import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { authenticate } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

const router = Router();

// GET /api/indicators/:id/data — Get data points for indicator (with trend)
router.get('/indicators/:id/data', authenticate, async (req: Request, res: Response) => {
  const indicator = await prisma.indicator.findUnique({
    where: { id: req.params.id },
    include: { framework: { include: { project: true } } },
  });

  if (!indicator || indicator.framework.project.organizationId !== req.user!.organizationId) {
    throw new AppError(404, 'Indicator not found');
  }

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
    },
    dataPoints,
    trend,
    count: dataPoints.length,
  });
});

// POST /api/indicators/:id/data — Add data point
router.post('/indicators/:id/data', authenticate, async (req: Request, res: Response) => {
  const indicator = await prisma.indicator.findUnique({
    where: { id: req.params.id },
    include: { framework: { include: { project: true } } },
  });

  if (!indicator || indicator.framework.project.organizationId !== req.user!.organizationId) {
    throw new AppError(404, 'Indicator not found');
  }

  const { value, collectionDate, collectionMethod, dataSource, geographicArea, notes, assessmentId, attachments } = req.body;
  if (!value || !collectionDate || !collectionMethod) {
    throw new AppError(400, 'value, collectionDate, and collectionMethod are required');
  }

  const dataPoint = await prisma.dataPoint.create({
    data: {
      indicatorId: req.params.id,
      projectId: indicator.framework.project.id,
      value,
      collectionDate: new Date(collectionDate),
      collectionMethod,
      dataSource,
      geographicArea,
      notes,
      assessmentId,
      attachments,
      createdBy: req.user!.id,
    },
  });

  // Update indicator's current value
  await prisma.indicator.update({
    where: { id: req.params.id },
    data: { currentValue: value },
  });

  res.status(201).json(dataPoint);
});

// POST /api/projects/:id/data/bulk — Bulk import data
router.post('/projects/:id/data/bulk', authenticate, async (req: Request, res: Response) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
  });
  if (!project) throw new AppError(404, 'Project not found');

  const { dataPoints } = req.body;
  if (!Array.isArray(dataPoints) || dataPoints.length === 0) {
    throw new AppError(400, 'dataPoints array is required');
  }

  const created = await prisma.dataPoint.createMany({
    data: dataPoints.map((dp: {
      indicatorId: string;
      value: string;
      collectionDate: string;
      collectionMethod: string;
      dataSource?: string;
      geographicArea?: string;
      notes?: string;
      assessmentId?: string;
    }) => ({
      indicatorId: dp.indicatorId,
      projectId: req.params.id,
      value: dp.value,
      collectionDate: new Date(dp.collectionDate),
      collectionMethod: dp.collectionMethod,
      dataSource: dp.dataSource,
      geographicArea: dp.geographicArea,
      notes: dp.notes,
      assessmentId: dp.assessmentId,
      createdBy: req.user!.id,
    })),
  });

  res.status(201).json({ count: created.count });
});

export default router;
