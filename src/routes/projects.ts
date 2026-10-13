import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { assertProjectAccess } from '../middleware/access';
import { authenticate, authorize } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { validationErrorBody } from '../services/dataPoints/fields';
import { DOCUMENT_FIELDS, withTextLength } from './documents';
import { CURRENT_FRAMEWORK } from '../services/frameworks/current';
import { sortResultNodes } from '../services/indicators/hierarchy';
import { indicatorVisibilityWhere } from '../services/indicators/visibility';
import { parseProjectCreate, parseProjectUpdate } from '../services/projects/validation';

const router = Router();

// GET /api/projects
router.get('/', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const projects = await prisma.project.findMany({
    where: { organizationId: req.user!.organizationId },
    include: {
      _count: {
        select: { documents: true, frameworks: true, assessments: true, dataPoints: true },
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

// GET /api/projects/:id — donor viewers get the current framework's approved indicators only (spec §A1)
router.get('/:id', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
    include: {
      // The same document fields as GET /projects/:id/documents: never parsedText or fileUrl.
      documents: { select: DOCUMENT_FIELDS, orderBy: { uploadedAt: 'desc' } },
      // The current framework: the newest version whose AI generation did not fail.
      frameworks: {
        where: CURRENT_FRAMEWORK,
        orderBy: { version: 'desc' },
        take: 1,
        include: { indicators: { where: indicatorVisibilityWhere(req.user), orderBy: { sortOrder: 'asc' } } },
      },
      _count: {
        select: { assessments: true, dataPoints: true, qualitativeEntries: true, reports: true },
      },
    },
  });

  if (!project) throw new AppError(404, 'Project not found');
  res.json({ ...project, documents: await withTextLength(project.documents) });
}));

// PATCH /api/projects/:id — any subset of the create fields, plus status.
// Changing `sector` or `sectors` keeps the primary sector in `sectors`.
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

// GET /api/projects/:id/export - Export project data as JSON (for Excel conversion). Donor viewers get approved
// indicators only, with their data points (spec §A1). The beneficiary part is unchanged in Phase 4 (design 4.7,
// owner question 2).
router.get('/:id/export', authenticate, asyncHandler(async (req: Request, res: Response) => {
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
            where: indicatorVisibilityWhere(req.user),
            orderBy: { sortOrder: 'asc' },
            include: {
              result: { select: { code: true } },
              dataPoints: { orderBy: { collectionDate: 'desc' } },
            },
          },
        },
      },
      beneficiaries: {
        orderBy: { registrationDate: 'desc' },
        include: {
          services: { orderBy: { dateProvided: 'desc' } },
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
    }))
  );

  // Flatten beneficiaries with services
  const beneficiaries = project.beneficiaries.map(b => ({
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
    project: {
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
    },
    frameworks,
    indicators,
    beneficiaries,
    assessments: project.assessments,
    qualitativeEntries: project.qualitativeEntries,
    exportedAt: new Date().toISOString(),
  });
}));

// DELETE /api/projects/:id — Archive
router.delete('/:id', authenticate, authorize('org_admin', 'platform_admin'), asyncHandler(async (req: Request, res: Response) => {
  await assertProjectAccess(req, req.params.id);

  await prisma.project.update({
    where: { id: req.params.id },
    data: { status: 'archived' },
  });

  res.json({ message: 'Project archived' });
}));

export default router;
