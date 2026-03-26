import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { AppError , asyncHandler } from '../middleware/errorHandler';

const router = Router();

// POST /api/webhooks/manasati — Receive data from Manasati panel
router.post('/manasati', asyncHandler(async (req: Request, res: Response) => {
  const { projectId, indicators } = req.body;
  if (!projectId || !Array.isArray(indicators)) {
    throw new AppError(400, 'projectId and indicators array are required');
  }

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new AppError(404, 'Project not found');

  let imported = 0;
  for (const item of indicators) {
    const indicator = await prisma.indicator.findFirst({
      where: {
        frameworkId: item.frameworkId || undefined,
        indicatorText: { contains: item.indicatorMatch || '' },
      },
    });

    if (indicator) {
      await prisma.dataPoint.create({
        data: {
          indicatorId: indicator.id,
          projectId,
          value: String(item.value),
          collectionDate: new Date(item.date || new Date()),
          collectionMethod: 'secondary_data',
          dataSource: 'Manasati',
          geographicArea: item.area,
          createdBy: item.userId || project.organizationId, // fallback
        },
      });
      imported++;
    }
  }

  res.json({ message: `Imported ${imported} data points from Manasati`, count: imported });
}));

// POST /api/webhooks/kobotoolbox — Receive data from KoboToolbox
router.post('/kobotoolbox', asyncHandler(async (req: Request, res: Response) => {
  const submission = req.body;

  // KoboToolbox sends form submissions as flat JSON
  // Map fields based on configured mapping
  const projectId = submission._project_id || submission.project_id;
  if (!projectId) {
    throw new AppError(400, 'project_id is required in submission');
  }

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new AppError(404, 'Project not found');

  // Store as qualitative entry if it's a qualitative submission
  if (submission._type === 'qualitative') {
    await prisma.qualitativeEntry.create({
      data: {
        projectId,
        entryType: submission.entry_type || 'field_notes',
        title: submission.title || `KoboToolbox Submission ${submission._id}`,
        content: JSON.stringify(submission),
        location: submission._geolocation ? `${submission._geolocation[0]}, ${submission._geolocation[1]}` : undefined,
        dateConducted: new Date(submission._submission_time || new Date()),
      },
    });

    res.json({ message: 'Qualitative entry created from KoboToolbox' });
    return;
  }

  // Otherwise, try to map to data points
  const mappings = submission._indicator_mappings || {};
  let imported = 0;

  for (const [field, indicatorId] of Object.entries(mappings)) {
    if (submission[field] !== undefined) {
      await prisma.dataPoint.create({
        data: {
          indicatorId: indicatorId as string,
          projectId,
          value: String(submission[field]),
          collectionDate: new Date(submission._submission_time || new Date()),
          collectionMethod: 'hh_survey',
          dataSource: 'KoboToolbox',
          geographicArea: submission._geolocation ? `${submission._geolocation[0]}, ${submission._geolocation[1]}` : undefined,
          createdBy: project.organizationId, // system import
        },
      });
      imported++;
    }
  }

  res.json({ message: `Imported ${imported} data points from KoboToolbox`, count: imported });
}));

export default router;
