import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { assertProjectAccess } from '../middleware/access';
import { auditValues, markRequestAudited, PROJECT_VALUES, writeRequestAudit } from '../middleware/audit';
import { authenticate, authorize } from '../middleware/auth';
import { hasStaffRole } from '../middleware/roles';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { validationErrorBody } from '../services/dataPoints/fields';
import { DOCUMENT_FIELDS, withTextLength } from './documents';
import { sortResultNodes } from '../services/indicators/hierarchy';
import { parseProjectCreate, parseProjectUpdate } from '../services/projects/validation';
import {
  ALREADY_ARCHIVED, CONFIRM_NAME_MISMATCH, confirmNameMatches, DELETE_BLOCKED_MESSAGE, DELETE_TRANSACTION_OPTIONS, deleteProjectRows, lockProject,
  NOT_ARCHIVED, removeStoredFiles, restoreStatus,
} from '../services/projects/lifecycle';
import { loadBeneficiaryAggregates, toDonorBeneficiarySummary } from '../services/beneficiaries/donorSummary';
import {
  donorDataPointWhere, donorDocumentWhere, donorReportWhere, toDonorAssessment, toDonorDocument, toDonorIndicatorData,
  toDonorQualitativeEntry,
} from '../services/privacy/donorView';

const router = Router();

// GET /api/projects — the organisation's projects that are not archived; ?archived=true lists only the archived
// ones (any other value counts as false). Counts follow what the caller can see (SECURITY_SETUP §8.3): donor
// viewers count donor-visible documents and never KoboToolbox rows.
router.get('/', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const archived = req.query.archived === 'true';
  const projects = await prisma.project.findMany({
    where: { organizationId: req.user!.organizationId, status: archived ? 'archived' : { not: 'archived' } },
    include: {
      _count: {
        select: {
          documents: { where: donorDocumentWhere(req.user) },
          frameworks: true,
          assessments: true,
          dataPoints: { where: donorDataPointWhere(req.user) },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json(projects);
}));

// POST /api/projects
// Body: name, sector, donor, donorType, startDate, endDate (required), plus optional nameAr, description,
// budgetUsd, targetBeneficiaries, geographicScope, sectors (Sector[]; always includes `sector`) and humanitarian.
router.post('/', authenticate, authorize('org_admin', 'platform_admin'), asyncHandler(async (req: Request, res: Response) => {
  const parsed = parseProjectCreate(req.body);
  if (parsed.ok === false) {
    res.status(400).json(validationErrorBody(parsed.errors));
    return;
  }

  const project = await prisma.project.create({
    data: { ...parsed.data, organizationId: req.user!.organizationId },
  });

  res.status(201).json(project);
}));

// GET /api/projects/:id — also for an archived project (read-only view)
router.get('/:id', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
    include: {
      // The same document fields and the same donor filter as GET /projects/:id/documents: never parsedText or fileUrl.
      documents: { select: DOCUMENT_FIELDS, where: donorDocumentWhere(req.user), orderBy: { uploadedAt: 'desc' } },
      // The current framework: the newest version whose AI generation did not fail.
      frameworks: {
        where: { generationError: null },
        orderBy: { version: 'desc' },
        take: 1,
        include: { indicators: { orderBy: { sortOrder: 'asc' } } },
      },
      // Counts of what the caller can see: donors count no KoboToolbox rows and published reports only.
      _count: {
        select: {
          assessments: true,
          dataPoints: { where: donorDataPointWhere(req.user) },
          qualitativeEntries: true,
          reports: { where: donorReportWhere(req.user) },
        },
      },
    },
  });

  if (!project) throw new AppError(404, 'Project not found');
  const documents = await withTextLength(project.documents);
  // Donor viewers: no AI analysis (not reviewed) and no uploader names on documents (SECURITY_SETUP §8.3).
  res.json({ ...project, documents: hasStaffRole(req.user) ? documents : documents.map(toDonorDocument) });
}));

// PATCH /api/projects/:id — any subset of the create fields, plus status (never `archived`: archiving is
// POST /:id/archive, admins only). Changing `sector` or `sectors` keeps the primary sector in `sectors`.
// An archived project answers 409 project_archived (restore it first).
router.patch('/:id', authenticate, authorize('org_admin', 'platform_admin', 'me_officer'), asyncHandler(async (req: Request, res: Response) => {
  const current = await assertProjectAccess(req, req.params.id);

  const parsed = parseProjectUpdate(req.body, current);
  if (parsed.ok === false) {
    res.status(400).json(validationErrorBody(parsed.errors));
    return;
  }

  const updated = await prisma.project.update({
    where: { id: req.params.id },
    data: parsed.data,
  });

  res.json(updated);
}));

// GET /api/projects/:id/export - Export project data as JSON (for Excel conversion).
// Staff (audience 'staff'): everything, beneficiaries included. Everyone else (audience 'donor',
// personalData 'excluded'): every part built from an explicit field list (SECURITY_SETUP §8.3): no
// beneficiaries key, a beneficiary summary (small counts hidden, other counts rounded), data points without
// notes, attachments, author or unlisted areas, KoboToolbox rows as released monthly aggregates only,
// qualitative entries as type, month and participants only, and assessments without their AI text or price.
router.get('/:id/export', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const staff = hasStaffRole(req.user);
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
    include: {
      frameworks: {
        orderBy: { version: 'desc' },
        include: {
          resultNodes: {
            select: { id: true, code: true, level: true, text: true, textAr: true, parentId: true, sortOrder: true },
          },
          indicators: {
            orderBy: { sortOrder: 'asc' },
            include: {
              result: { select: { code: true } },
              dataPoints: { orderBy: { collectionDate: 'desc' } },
            },
          },
        },
      },
      assessments: { orderBy: { requestedAt: 'desc' } },
      qualitativeEntries: { orderBy: { createdAt: 'desc' } },
    },
  });

  if (!project) throw new AppError(404, 'Project not found');

  // Each framework with its results chain (impact > outcome > output > activity, in display order)
  // Every version, including failed AI generations (generationError set; they have no results or indicators).
  const frameworks = project.frameworks.map(fw => ({
    id: fw.id,
    version: fw.version,
    status: fw.status,
    generationError: fw.generationError,
    resultNodes: sortResultNodes(fw.resultNodes).map(node => ({
      id: node.id,
      code: node.code,
      level: node.level,
      text: node.text,
      textAr: node.textAr,
      parentId: node.parentId,
    })),
  }));

  // Flatten indicators with their reference sheets and data points for easy spreadsheet mapping
  const indicators = project.frameworks.flatMap(fw =>
    fw.indicators.map(ind => ({
      frameworkVersion: fw.version,
      frameworkStatus: fw.status,
      indicatorId: ind.id,
      indicatorText: ind.indicatorText,
      indicatorTextAr: ind.indicatorTextAr,
      level: ind.level,
      collectionMethod: ind.dataCollectionMethod,
      frequency: ind.frequency,
      baselineValue: ind.baselineValue,
      targetValue: ind.targetValue,
      currentValue: ind.currentValue,
      unit: ind.unit,
      status: ind.status,
      // Reference sheet (knowledge/me-foundations.md §3)
      frameworkId: fw.id,
      resultId: ind.resultId,
      resultCode: ind.result?.code ?? null,
      definition: ind.definition,
      calculation: ind.calculation,
      direction: ind.direction,
      disaggregation: ind.disaggregation,
      meansOfVerification: ind.meansOfVerification,
      baselineDate: ind.baselineDate,
      baselineMethod: ind.baselineMethod,
      targetJustification: ind.targetJustification,
      intermediateTargets: ind.intermediateTargets,
      assumptions: ind.assumptions,
      libraryId: ind.libraryId,
      standardReferenceCode: ind.standardReferenceCode,
      provenance: ind.provenance,
      ...(staff ? {
        dataPoints: ind.dataPoints.map(dp => ({
          id: dp.id,
          value: dp.value,
          collectionDate: dp.collectionDate,
          collectionMethod: dp.collectionMethod,
          dataSource: dp.dataSource,
          geographicArea: dp.geographicArea,
          notes: dp.notes,
          breakdown: dp.breakdown,
        })),
      } : toDonorIndicatorData(ind.dataPoints, () => ind.unit)),
    }))
  );

  const projectFields = {
    id: project.id,
    name: project.name,
    nameAr: project.nameAr,
    description: project.description,
    sector: project.sector,
    sectors: project.sectors,
    humanitarian: project.humanitarian,
    donor: project.donor,
    donorType: project.donorType,
    budgetUsd: project.budgetUsd,
    startDate: project.startDate,
    endDate: project.endDate,
    targetBeneficiaries: project.targetBeneficiaries,
    geographicScope: project.geographicScope,
    status: project.status,
  };

  if (!staff) {
    res.json({
      audience: 'donor',
      personalData: 'excluded',
      project: projectFields,
      frameworks,
      indicators,
      beneficiarySummary: toDonorBeneficiarySummary(await loadBeneficiaryAggregates(project.id)),
      qualitativeEntries: project.qualitativeEntries.map(toDonorQualitativeEntry),
      assessments: project.assessments.map(toDonorAssessment),
      exportedAt: new Date().toISOString(),
    });
    return;
  }

  // Staff only: beneficiaries with services, loaded after the role check so a donor request never reads them.
  const beneficiaryRows = await prisma.beneficiary.findMany({
    where: { projectId: project.id },
    orderBy: { registrationDate: 'desc' },
    include: {
      services: { orderBy: { dateProvided: 'desc' } },
    },
  });

  // Flatten beneficiaries with services
  const beneficiaries = beneficiaryRows.map(b => ({
    id: b.id,
    fullName: b.fullName,
    fullNameAr: b.fullNameAr,
    gender: b.gender,
    age: b.age,
    ageGroup: b.ageGroup,
    location: b.location,
    governorate: b.governorate,
    phoneNumber: b.phoneNumber,
    nationalId: b.nationalId,
    householdSize: b.householdSize,
    vulnerabilityTags: b.vulnerabilityTags,
    registrationDate: b.registrationDate,
    status: b.status,
    services: b.services.map(s => ({
      id: s.id,
      serviceType: s.serviceType,
      description: s.description,
      dateProvided: s.dateProvided,
      quantity: s.quantity,
      unit: s.unit,
      notes: s.notes,
    })),
  }));

  res.json({
    audience: 'staff',
    project: projectFields,
    frameworks,
    indicators,
    beneficiaries,
    assessments: project.assessments,
    qualitativeEntries: project.qualitativeEntries,
    exportedAt: new Date().toISOString(),
  });
}));

// POST /api/projects/:id/archive — Archive (org admins, platform admins): hidden from the project list, nothing is
// lost, read-only until restored. The audit row keeps the status before archiving (previousValue.status).
router.post('/:id/archive', authenticate, authorize('org_admin', 'platform_admin'), asyncHandler(async (req: Request, res: Response) => {
  // Not the read-only rule: an archived project answers its own 409 here.
  await assertProjectAccess(req, req.params.id, { allowArchived: true });

  const archived = await prisma.$transaction(async tx => {
    const locked = await lockProject(tx, req.params.id);
    if (!locked) throw new AppError(404, 'Project not found');
    if (locked.status === 'archived') throw new AppError(409, ALREADY_ARCHIVED.message, ALREADY_ARCHIVED.code);
    const project = await tx.project.update({ where: { id: locked.id }, data: { status: 'archived' } });
    await writeRequestAudit(tx, req, {
      status: 200,
      previousValue: { status: locked.status },
      values: auditValues(PROJECT_VALUES, project),
    });
    return project;
  });
  markRequestAudited(res);

  res.json(archived);
}));

// POST /api/projects/:id/restore — Restore an archived project (org admins, platform admins) to the status recorded
// by its latest archive audit row; without one: active with an approved framework, framework_review with any
// framework, else setup.
router.post('/:id/restore', authenticate, authorize('org_admin', 'platform_admin'), asyncHandler(async (req: Request, res: Response) => {
  await assertProjectAccess(req, req.params.id, { allowArchived: true });

  const restored = await prisma.$transaction(async tx => {
    const locked = await lockProject(tx, req.params.id);
    if (!locked) throw new AppError(404, 'Project not found');
    if (locked.status !== 'archived') throw new AppError(409, NOT_ARCHIVED.message, NOT_ARCHIVED.code);
    const { status, source } = await restoreStatus(tx, locked.id);
    const project = await tx.project.update({ where: { id: locked.id }, data: { status } });
    await writeRequestAudit(tx, req, {
      status: 200,
      previousValue: { status: locked.status },
      values: auditValues(PROJECT_VALUES, project),
      extra: { restoredFrom: source },
    });
    return project;
  });
  markRequestAudited(res);

  res.json(restored);
}));

// DELETE /api/projects/:id — Delete forever (org admins, platform admins), from any status. Body: { confirmName },
// which must be the project's name (trimmed, exact, same capitals); otherwise 400 confirm_name_mismatch and nothing
// is deleted. Every row of the project goes in one transaction (services/projects/lifecycle.ts), with its audit row
// (previousValue: name, status and the rows removed per table); the stored files of its documents are removed after
// the transaction commits, best effort. For test or mistaken projects: real projects are archived.
router.delete('/:id', authenticate, authorize('org_admin', 'platform_admin'), asyncHandler(async (req: Request, res: Response) => {
  const project = await assertProjectAccess(req, req.params.id, { allowArchived: true });
  const confirmName: unknown = req.body?.confirmName;
  if (!confirmNameMatches(confirmName, project.name)) {
    throw new AppError(400, CONFIRM_NAME_MISMATCH.message, CONFIRM_NAME_MISMATCH.code);
  }

  const { removed, storedFiles } = await prisma.$transaction(async tx => {
    const locked = await lockProject(tx, project.id);
    if (!locked) throw new AppError(404, 'Project not found');
    // Checked again on the locked row: the project may have been renamed meanwhile.
    if (!confirmNameMatches(confirmName, locked.name)) {
      throw new AppError(400, CONFIRM_NAME_MISMATCH.message, CONFIRM_NAME_MISMATCH.code);
    }
    const result = await deleteProjectRows(tx, locked);
    await writeRequestAudit(tx, req, {
      status: 200,
      previousValue: { name: locked.name, status: locked.status, removed: result.removed },
    });
    return result;
  }, DELETE_TRANSACTION_OPTIONS).catch(err => {
    // A row of another project refers to one of this project's rows (the API never creates one): the whole
    // transaction rolled back, nothing was deleted.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') throw new AppError(409, DELETE_BLOCKED_MESSAGE);
    throw err;
  });
  markRequestAudited(res);

  const files = await removeStoredFiles(storedFiles);
  res.json({
    deleted: true,
    removed: { ...removed, storageFilesRemoved: files.removed, storageFilesFailed: files.failed },
  });
}));

export default router;
