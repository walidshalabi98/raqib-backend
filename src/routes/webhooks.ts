import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { AppError , asyncHandler } from '../middleware/errorHandler';
import { assertIndicatorsInProject } from '../middleware/access';
import { authenticateWebhook, logWebhookRejection } from '../middleware/webhookAuth';
import { normaliseValue } from '../services/dataPoints/validation';

const router = Router();

// Every webhook needs a valid organisation token (X-Raqib-Webhook-Token).
router.use(authenticateWebhook);

/** Loads a project only if it belongs to the organisation that owns the webhook token. */
async function findTokenProject(req: Request, projectId: unknown) {
  if (typeof projectId !== 'string' || !projectId) return null;
  const project = await prisma.project.findFirst({
    where: { id: projectId, organizationId: req.webhook!.organizationId },
  });
  if (!project) logWebhookRejection(req, 'project_not_in_organization', { organizationId: req.webhook!.organizationId });
  return project;
}

// POST /api/webhooks/manasati — Receive data from Manasati panel
router.post('/manasati', asyncHandler(async (req: Request, res: Response) => {
  const { projectId, indicators } = req.body;
  if (!projectId || !Array.isArray(indicators)) {
    throw new AppError(400, 'projectId and indicators array are required');
  }

  const project = await findTokenProject(req, projectId);
  if (!project) throw new AppError(404, 'Project not found');

  let imported = 0;
  for (const item of indicators) {
    if (!item?.indicatorMatch) continue;
    const indicator = await prisma.indicator.findFirst({
      where: {
        framework: { projectId: project.id },
        ...(item.frameworkId && { frameworkId: item.frameworkId }),
        indicatorText: { contains: String(item.indicatorMatch) },
      },
    });

    if (indicator) {
      await prisma.dataPoint.create({
        data: {
          indicatorId: indicator.id,
          projectId: project.id,
          value: normaliseValue(String(item.value)),
          collectionDate: new Date(item.date || new Date()),
          collectionMethod: 'secondary_data',
          dataSource: 'Manasati',
          geographicArea: item.area,
          createdBy: req.webhook!.userId,
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

  const project = await findTokenProject(req, projectId);
  if (!project) throw new AppError(404, 'Project not found');

  // Store as qualitative entry if it's a qualitative submission
  if (submission._type === 'qualitative') {
    await prisma.qualitativeEntry.create({
      data: {
        projectId: project.id,
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

  // Otherwise, try to map to data points. Mapped indicators must belong to this project.
  const mappings: Record<string, string> = submission._indicator_mappings || {};
  await assertIndicatorsInProject(project.id, Object.values(mappings).map(String));
  let imported = 0;

  for (const [field, indicatorId] of Object.entries(mappings)) {
    if (submission[field] !== undefined) {
      await prisma.dataPoint.create({
        data: {
          indicatorId: String(indicatorId),
          projectId: project.id,
          value: normaliseValue(String(submission[field])),
          collectionDate: new Date(submission._submission_time || new Date()),
          collectionMethod: 'hh_survey',
          dataSource: 'KoboToolbox',
          geographicArea: submission._geolocation ? `${submission._geolocation[0]}, ${submission._geolocation[1]}` : undefined,
          createdBy: req.webhook!.userId,
        },
      });
      imported++;
    }
  }

  res.json({ message: `Imported ${imported} data points from KoboToolbox`, count: imported });
}));

export default router;
