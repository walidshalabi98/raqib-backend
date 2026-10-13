import { Router, Request, Response } from 'express';
import type { QualitativeType } from '@prisma/client';
import { prisma } from '../config/prisma';
import { AppError , asyncHandler } from '../middleware/errorHandler';
import { assertIndicatorsInProject, assertProjectWritable } from '../middleware/access';
import { authenticateWebhook, logWebhookRejection } from '../middleware/webhookAuth';
import { normaliseValue } from '../services/dataPoints/validation';
import { describeRedactions, redactQualitativeFields, redactionTotal } from '../services/qualitative/redactEntry';
import { dateOf, EntryFieldError, entryTypeOf } from '../services/qualitative/entryFields';

const router = Router();

// Every webhook needs a valid organisation token (X-Raqib-Webhook-Token).
router.use(authenticateWebhook);

/**
 * Loads a project only if it belongs to the organisation that owns the webhook token. An archived project is
 * read-only: 409 project_archived, as for every write through the access helpers (nothing is imported).
 */
async function findTokenProject(req: Request, projectId: unknown) {
  if (typeof projectId !== 'string' || !projectId) return null;
  const project = await prisma.project.findFirst({
    where: { id: projectId, organizationId: req.webhook!.organizationId },
  });
  if (!project) {
    logWebhookRejection(req, 'project_not_in_organization', { organizationId: req.webhook!.organizationId });
    return null;
  }
  if (project.status === 'archived') {
    logWebhookRejection(req, 'project_archived', { organizationId: req.webhook!.organizationId, projectId: project.id });
    assertProjectWritable(req, project);
  }
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
    // Stored without phone numbers, ID numbers or email addresses, like typed notes (CLAUDE.md rule 5).
    // The fallback title is ours (KoboToolbox submission ids can have 9 digits) and is not redacted;
    // the content is the whole submission as JSON text, redacted as text. The entry type and date are
    // checked first: a value the database refuses would put the whole submission in its error message.
    let entryType: QualitativeType;
    let conductedOn: Date;
    try {
      entryType = entryTypeOf(submission.entry_type, 'entry_type', 'field_notes');
      conductedOn = dateOf(submission._submission_time, '_submission_time') ?? new Date();
    } catch (err) {
      if (err instanceof EntryFieldError) throw new AppError(400, err.message);
      throw err;
    }
    const { values: text, counts } = redactQualitativeFields({
      title: submission.title ? String(submission.title) : undefined,
      content: JSON.stringify(submission),
      location: submission._geolocation ? `${submission._geolocation[0]}, ${submission._geolocation[1]}` : undefined,
    });
    const entry = await prisma.qualitativeEntry.create({
      data: {
        projectId: project.id,
        entryType,
        title: text.title ?? `KoboToolbox Submission ${submission._id}`,
        content: text.content,
        location: text.location,
        dateConducted: conductedOn,
      },
    });
    // Ids and counts only: never the submission.
    if (redactionTotal(counts) > 0) console.log(`[Webhook] KoboToolbox qualitative entry ${entry.id}: ${describeRedactions(counts)}`);

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
