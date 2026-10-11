import { Request } from 'express';
import { prisma } from '../config/prisma';
import { AppError } from './errorHandler';

/**
 * Organisation isolation helpers. Every route that takes an id for a
 * project-owned resource must load it through one of these, so a user can
 * only ever reach records of their own organisation. Resources of another
 * organisation are reported as 404 (never 403) so ids cannot be probed.
 */

function orgId(req: Request): string {
  if (!req.user) throw new AppError(401, 'Not authenticated');
  return req.user.organizationId;
}

export async function assertProjectAccess(req: Request, projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, organizationId: orgId(req) },
  });
  if (!project) throw new AppError(404, 'Project not found');
  return project;
}

export async function assertFrameworkAccess(req: Request, frameworkId: string) {
  const framework = await prisma.framework.findFirst({
    where: { id: frameworkId, project: { organizationId: orgId(req) } },
    include: { project: true },
  });
  if (!framework) throw new AppError(404, 'Framework not found');
  return framework;
}

export async function assertIndicatorAccess(req: Request, indicatorId: string) {
  const indicator = await prisma.indicator.findFirst({
    where: { id: indicatorId, framework: { project: { organizationId: orgId(req) } } },
    include: { framework: { include: { project: true } } },
  });
  if (!indicator) throw new AppError(404, 'Indicator not found');
  return indicator;
}

export async function assertDocumentAccess(req: Request, documentId: string) {
  const document = await prisma.document.findFirst({
    where: { id: documentId, project: { organizationId: orgId(req) } },
    include: { project: true },
  });
  if (!document) throw new AppError(404, 'Document not found');
  return document;
}

export async function assertAssessmentAccess(req: Request, assessmentId: string) {
  const assessment = await prisma.assessment.findFirst({
    where: { id: assessmentId, project: { organizationId: orgId(req) } },
    include: { project: true },
  });
  if (!assessment) throw new AppError(404, 'Assessment not found');
  return assessment;
}

export async function assertQualitativeAccess(req: Request, entryId: string) {
  const entry = await prisma.qualitativeEntry.findFirst({
    where: { id: entryId, project: { organizationId: orgId(req) } },
    include: { project: true, assessment: true },
  });
  if (!entry) throw new AppError(404, 'Entry not found');
  return entry;
}

export async function assertReportAccess(req: Request, reportId: string) {
  const report = await prisma.report.findFirst({
    where: { id: reportId, project: { organizationId: orgId(req) } },
    include: { project: true },
  });
  if (!report) throw new AppError(404, 'Report not found');
  return report;
}

export async function assertBeneficiaryAccess(req: Request, beneficiaryId: string) {
  const beneficiary = await prisma.beneficiary.findFirst({
    where: { id: beneficiaryId, project: { organizationId: orgId(req) } },
    include: { project: true },
  });
  if (!beneficiary) throw new AppError(404, 'Beneficiary not found');
  return beneficiary;
}

/**
 * Checks ids supplied in a request body (not the URL) that must belong to the
 * same project, e.g. an indicatorId on a data point or an assessmentId on a
 * qualitative entry. Throws 400 so a foreign id cannot be attached.
 */
export async function assertIndicatorsInProject(projectId: string, indicatorIds: string[]): Promise<void> {
  const unique = Array.from(new Set(indicatorIds.filter(Boolean)));
  if (unique.length === 0) return;
  const count = await prisma.indicator.count({
    where: { id: { in: unique }, framework: { projectId } },
  });
  if (count !== unique.length) throw new AppError(400, 'One or more indicators do not belong to this project');
}

export async function assertAssessmentInProject(projectId: string, assessmentId: string | null | undefined): Promise<void> {
  if (!assessmentId) return;
  const assessment = await prisma.assessment.findFirst({ where: { id: assessmentId, projectId } });
  if (!assessment) throw new AppError(400, 'Assessment does not belong to this project');
}

export async function assertResultAccess(req: Request, resultId: string) {
  const result = await prisma.resultNode.findFirst({
    where: { id: resultId, framework: { project: { organizationId: orgId(req) } } },
    include: { framework: { include: { project: true } } },
  });
  if (!result) throw new AppError(404, 'Result not found');
  return result;
}
