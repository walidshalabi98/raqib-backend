import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { authenticate } from '../middleware/auth';
import { AppError , asyncHandler } from '../middleware/errorHandler';

const router = Router();

// GET /api/projects/:id/dashboard — Aggregated dashboard data
router.get('/projects/:id/dashboard', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, organizationId: req.user!.organizationId },
    include: {
      frameworks: {
        orderBy: { version: 'desc' },
        take: 1,
        include: {
          indicators: {
            include: {
              dataPoints: {
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

  // Trend data per indicator
  const trends = indicators.map(ind => ({
    indicatorId: ind.id,
    indicatorText: ind.indicatorText,
    level: ind.level,
    status: ind.status,
    baselineValue: ind.baselineValue,
    targetValue: ind.targetValue,
    currentValue: ind.currentValue,
    dataPoints: ind.dataPoints.map(dp => ({
      value: dp.value,
      date: dp.collectionDate,
    })),
  }));

  // Geographic data
  const geoData = await prisma.dataPoint.groupBy({
    by: ['geographicArea'],
    where: { projectId: req.params.id, geographicArea: { not: null } },
    _count: { id: true },
  });

  // Recent data points
  const recentData = await prisma.dataPoint.findMany({
    where: { projectId: req.params.id },
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
    geographic: geoData.map(g => ({
      area: g.geographicArea,
      dataPointCount: g._count.id,
    })),
    recentActivity: recentData,
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
        orderBy: { version: 'desc' },
        take: 1,
        include: {
          indicators: { select: { status: true } },
        },
      },
      _count: { select: { assessments: true, reports: true, dataPoints: true } },
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

  // Off-track alerts
  const offTrackIndicators = await prisma.indicator.findMany({
    where: {
      status: 'off_track',
      framework: { project: { organizationId: orgId } },
    },
    include: {
      framework: { include: { project: { select: { name: true } } } },
    },
    take: 10,
  });

  res.json({
    totalProjects: projects.length,
    activeProjects: projects.filter(p => p.status === 'active').length,
    projects: summary,
    alerts: offTrackIndicators.map(ind => ({
      indicatorId: ind.id,
      indicatorText: ind.indicatorText,
      projectName: ind.framework.project.name,
    })),
  });
}));

export default router;
