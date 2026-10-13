import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { assertProjectAccess } from '../middleware/access';
import { authenticate, authorize } from '../middleware/auth';
import { hasStaffRole, STAFF_ROLES } from '../middleware/roles';
import { AppError , asyncHandler } from '../middleware/errorHandler';
import { aiLimiter } from '../middleware/rateLimit';
import { analyzeProjectRisks } from '../services/ai/riskAnalyzer';
import {
  donorDataPointWhere, donorReportWhere, isRespondentLevel, mergeDonorAreas, NOT_RESPONDENT_LEVEL_WHERE, RESPONDENT_LEVEL_WHERE,
  toDonorDataPoint, toDonorSurveyAggregates,
} from '../services/privacy/donorView';

const router = Router();

// The current framework of a project: the newest version whose AI generation did not fail.
const CURRENT_FRAMEWORK = { where: { generationError: null }, orderBy: { version: 'desc' }, take: 1 } as const;

// GET /api/projects/:id/dashboard — Aggregated dashboard data
router.get('/projects/:id/dashboard', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
    include: {
      frameworks: {
        ...CURRENT_FRAMEWORK,
        include: {
          indicators: {
            include: {
              // The 10 most recent rows the caller is shown one by one (donors: never KoboToolbox rows).
              dataPoints: {
                where: donorDataPointWhere(req.user),
                orderBy: { collectionDate: 'desc' },
                take: 10,
              },
            },
          },
        },
      },
    },
  });
  if (!project) throw new AppError(404, 'Project not found');
  // Donor viewers (any role without staff rights, SECURITY_SETUP §8.3): data points without notes, attachments,
  // author or unlisted areas; KoboToolbox rows (one respondent each) only as released monthly aggregates, never
  // one by one, and never in a count.
  const staff = hasStaffRole(req.user);

  const framework = project.frameworks[0];
  const indicators = framework?.indicators || [];

  // Indicator status summary
  const statusCounts = {
    on_track: 0,
    at_risk: 0,
    off_track: 0,
    not_started: 0,
    completed: 0,
  };
  indicators.forEach(ind => { statusCounts[ind.status]++; });

  // Level breakdown
  const levelCounts = { impact: 0, outcome: 0, output: 0, activity: 0 };
  indicators.forEach(ind => { levelCounts[ind.level]++; });

  // Donors: respondent-level rows of these indicators, aggregated per released month (all of them, not only the last 10).
  const surveyRows = staff ? [] : await prisma.dataPoint.findMany({
    where: { indicatorId: { in: indicators.map(ind => ind.id) }, ...RESPONDENT_LEVEL_WHERE },
    select: { indicatorId: true, value: true, collectionDate: true, createdAt: true },
    orderBy: { collectionDate: 'asc' },
  });
  const unitOf = new Map(indicators.map(ind => [ind.id, ind.unit]));
  const surveyAggregates = toDonorSurveyAggregates(surveyRows, id => unitOf.get(id));

  // Trend data per indicator
  const trends = indicators.map(ind => ({
    indicatorId: ind.id,
    indicatorText: ind.indicatorText,
    level: ind.level,
    status: ind.status,
    baselineValue: ind.baselineValue,
    targetValue: ind.targetValue,
    currentValue: ind.currentValue,
    dataPoints: ind.dataPoints.filter(dp => staff || !isRespondentLevel(dp)).map(dp => ({
      value: dp.value,
      date: dp.collectionDate,
    })),
    ...(!staff && { surveyAggregates: surveyAggregates.filter(a => a.indicatorId === ind.id) }),
  }));

  // Geographic data (donors: rows they are shown one by one only, grouped by listed place)
  const geoData = await prisma.dataPoint.groupBy({
    by: ['geographicArea'],
    where: { projectId: req.params.id, geographicArea: { not: null }, ...donorDataPointWhere(req.user) },
    _count: { id: true },
  });
  const geographic = geoData.map(g => ({ area: g.geographicArea, dataPointCount: g._count.id }));

  // Recent data points (donors: never respondent-level rows)
  const recentData = await prisma.dataPoint.findMany({
    where: { projectId: req.params.id, ...(!staff && NOT_RESPONDENT_LEVEL_WHERE) },
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: {
      indicator: { select: { indicatorText: true } },
      creator: { select: { fullName: true } },
    },
  });

  // Assessment summary
  const assessments = await prisma.assessment.findMany({
    where: { projectId: req.params.id },
    orderBy: { requestedAt: 'desc' },
  });

  res.json({
    project: {
      id: project.id,
      name: project.name,
      status: project.status,
      sector: project.sector,
      donor: project.donor,
      startDate: project.startDate,
      endDate: project.endDate,
      targetBeneficiaries: project.targetBeneficiaries,
    },
    framework: framework ? {
      id: framework.id,
      version: framework.version,
      status: framework.status,
      totalIndicators: indicators.length,
    } : null,
    indicatorStatus: statusCounts,
    indicatorLevels: levelCounts,
    trends,
    geographic: staff ? geographic : mergeDonorAreas(geographic),
    recentActivity: staff ? recentData : recentData.map(toDonorDataPoint),
    assessments: assessments.map(a => ({
      id: a.id,
      type: a.type,
      status: a.status,
      requestedAt: a.requestedAt,
    })),
  });
}));

// GET /api/dashboard/overview — Org-level overview
router.get('/overview', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.user!.organizationId;

  const projects = await prisma.project.findMany({
    where: { organizationId: orgId },
    include: {
      frameworks: {
        ...CURRENT_FRAMEWORK,
        include: {
          indicators: { select: { id: true, indicatorText: true, status: true } },
        },
      },
      // Counts of what the caller can see: donors count published reports only and no KoboToolbox rows.
      _count: {
        select: {
          assessments: true,
          reports: { where: donorReportWhere(req.user) },
          dataPoints: { where: donorDataPointWhere(req.user) },
        },
      },
    },
  });

  const summary = projects.map(p => {
    const indicators = p.frameworks[0]?.indicators || [];
    const statusCounts = {
      on_track: indicators.filter(i => i.status === 'on_track').length,
      at_risk: indicators.filter(i => i.status === 'at_risk').length,
      off_track: indicators.filter(i => i.status === 'off_track').length,
      not_started: indicators.filter(i => i.status === 'not_started').length,
      completed: indicators.filter(i => i.status === 'completed').length,
    };

    return {
      id: p.id,
      name: p.name,
      sector: p.sector,
      donor: p.donor,
      status: p.status,
      startDate: p.startDate,
      endDate: p.endDate,
      totalIndicators: indicators.length,
      indicatorStatus: statusCounts,
      assessmentCount: p._count.assessments,
      reportCount: p._count.reports,
      dataPointCount: p._count.dataPoints,
    };
  });

  // Off-track alerts: indicators of each project's current framework only (never of older or failed versions).
  const alerts = projects
    .flatMap(p => (p.frameworks[0]?.indicators ?? [])
      .filter(ind => ind.status === 'off_track')
      .map(ind => ({ indicatorId: ind.id, indicatorText: ind.indicatorText, projectName: p.name })))
    .slice(0, 10);

  res.json({
    totalProjects: projects.length,
    activeProjects: projects.filter(p => p.status === 'active').length,
    projects: summary,
    alerts,
  });
}));

// GET /api/dashboard/projects/:id/risks — AI Risk Analysis (staff only: it runs a model on every request, and its
// output is not reviewed; staff share their conclusions in reports)
router.get('/projects/:id/risks', authenticate, authorize(...STAFF_ROLES), aiLimiter, asyncHandler(async (req: Request, res: Response) => {
  await assertProjectAccess(req, req.params.id);

  const risks = await analyzeProjectRisks(req.params.id);
  res.json({ projectId: req.params.id, risks, analyzedAt: new Date().toISOString() });
}));

export default router;
