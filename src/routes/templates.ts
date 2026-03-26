import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { authenticate, authorize } from '../middleware/auth';
import { AppError , asyncHandler } from '../middleware/errorHandler';

const router = Router();

// GET /api/templates
router.get('/', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const { sector, level, method } = req.query;

  const templates = await prisma.mETemplate.findMany({
    where: {
      ...(sector && { sector: sector as any }),
      ...(level && { level: level as any }),
      ...(method && { recommendedMethod: method as any }),
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json(templates);
}));

// POST /api/templates
router.post('/', authenticate, authorize('platform_admin'), asyncHandler(async (req: Request, res: Response) => {
  const {
    sector, indicatorText, indicatorTextAr, level,
    recommendedMethod, recommendedFrequency, typicalTarget,
    benchmarkPalestine, donorRelevance, tags,
  } = req.body;

  if (!sector || !indicatorText || !level || !recommendedMethod || !recommendedFrequency) {
    throw new AppError(400, 'sector, indicatorText, level, recommendedMethod, and recommendedFrequency are required');
  }

  const template = await prisma.mETemplate.create({
    data: {
      sector,
      indicatorText,
      indicatorTextAr,
      level,
      recommendedMethod,
      recommendedFrequency,
      typicalTarget,
      benchmarkPalestine,
      donorRelevance,
      tags,
    },
  });

  res.status(201).json(template);
}));

// POST /api/templates/bulk-import
router.post('/bulk-import', authenticate, authorize('platform_admin'), asyncHandler(async (req: Request, res: Response) => {
  const { templates } = req.body;
  if (!Array.isArray(templates) || templates.length === 0) {
    throw new AppError(400, 'templates array is required');
  }

  const created = await prisma.mETemplate.createMany({
    data: templates.map((t: any) => ({
      sector: t.sector,
      indicatorText: t.indicatorText,
      indicatorTextAr: t.indicatorTextAr,
      level: t.level,
      recommendedMethod: t.recommendedMethod,
      recommendedFrequency: t.recommendedFrequency,
      typicalTarget: t.typicalTarget,
      benchmarkPalestine: t.benchmarkPalestine,
      donorRelevance: t.donorRelevance,
      tags: t.tags,
    })),
  });

  res.status(201).json({ count: created.count });
}));

// PATCH /api/templates/:id
router.patch('/:id', authenticate, authorize('platform_admin'), asyncHandler(async (req: Request, res: Response) => {
  const template = await prisma.mETemplate.findUnique({ where: { id: req.params.id } });
  if (!template) throw new AppError(404, 'Template not found');

  const updated = await prisma.mETemplate.update({
    where: { id: req.params.id },
    data: req.body,
  });
  res.json(updated);
}));

// DELETE /api/templates/:id
router.delete('/:id', authenticate, authorize('platform_admin'), asyncHandler(async (req: Request, res: Response) => {
  const template = await prisma.mETemplate.findUnique({ where: { id: req.params.id } });
  if (!template) throw new AppError(404, 'Template not found');

  await prisma.mETemplate.delete({ where: { id: req.params.id } });
  res.json({ message: 'Template deleted' });
}));

export default router;
