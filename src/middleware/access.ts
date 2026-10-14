import { Request } from 'express';
import type { KpiSuggestion, KpiSuggestionRun, Project, ProjectStatus } from '@prisma/client';
import { prisma } from '../config/prisma';
import { AppError } from './errorHandler';

/**
 * Organisation isolation helpers. Every route that takes an id for a
 * project-owned resource must load it through one of these, so a user can
 * only ever reach records of their own organisation. Resources of another
 * organisation are reported as 404 (never 403) so ids cannot be probed.
 *
 * They are also where an archived project becomes read-only (owner decision of 13 October 2026): a write
 * request (POST, PUT, PATCH, DELETE) that reaches a resource of an archived project through any of these
 * helpers (KPI suggestions and suggestion runs included) answers 409 `project_archived`; reads are unaffected. Only the routes that act on the archive state
 * itself pass `{ allowArchived: true }` to assertProjectAccess: restore and permanent delete (and archive, which
 * answers its own 409 `project_already_archived`). The webhooks resolve a project from the token's organisation
 * and apply the same rule with assertProjectWritable.
 */

/** The caller's organisation. No user, or a user without an organisation, is 401: never an unscoped query. */
function orgId(req: Request): string {
  const organizationId = req.user?.organizationId;
  if (typeof organizationId !== 'string' || !organizationId) throw new AppError(401, 'Not authenticated');
  return organizationId;
}

/** Requests that read. Everything else (POST, PUT, PATCH, DELETE, or a method missing) counts as a write. */
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export const PROJECT_ARCHIVED_MESSAGE = 'This project is archived. Restore it to make changes.';
export const PROJECT_ARCHIVED_CODE = 'project_archived';

/** 409 `project_archived` for a write request (POST, PUT, PATCH, DELETE) to a resource of an archived project. */
export function assertProjectWritable(req: Pick<Request, 'method'>, project: { status: ProjectStatus }): void {
  if (project.status !== 'archived') return;
  const method = typeof req.method === 'string' ? req.method.toUpperCase() : '';
  if (!READ_METHODS.has(method)) throw new AppError(409, PROJECT_ARCHIVED_MESSAGE, PROJECT_ARCHIVED_CODE);
}

export interface ProjectAccessOptions {
  /**
   * Skip the archived read-only rule. Only for POST /api/projects/:id/restore and DELETE /api/projects/:id
   * (and POST /api/projects/:id/archive, which refuses an archived project with its own code).
   */
  allowArchived?: boolean;
}

export async function assertProjectAccess(req: Request, projectId: string, options: ProjectAccessOptions = {}) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, organizationId: orgId(req) },
  });
  if (!project) throw new AppError(404, 'Project not found');
  if (!options.allowArchived) assertProjectWritable(req, project);
  return project;
}

export async function assertFrameworkAccess(req: Request, frameworkId: string) {
  const framework = await prisma.framework.findFirst({
    where: { id: frameworkId, project: { organizationId: orgId(req) } },
    include: { project: true },
  });
  if (!framework) throw new AppError(404, 'Framework not found');
  assertProjectWritable(req, framework.project);
  return framework;
}

export async function assertIndicatorAccess(req: Request, indicatorId: string) {
  const indicator = await prisma.indicator.findFirst({
    where: { id: indicatorId, framework: { project: { organizationId: orgId(req) } } },
    include: { framework: { include: { project: true } } },
  });
  if (!indicator) throw new AppError(404, 'Indicator not found');
  assertProjectWritable(req, indicator.framework.project);
  return indicator;
}

export async function assertDocumentAccess(req: Request, documentId: string) {
  const document = await prisma.document.findFirst({
    where: { id: documentId, project: { organizationId: orgId(req) } },
    include: { project: true },
  });
  if (!document) throw new AppError(404, 'Document not found');
  assertProjectWritable(req, document.project);
  return document;
}

export async function assertAssessmentAccess(req: Request, assessmentId: string) {
  const assessment = await prisma.assessment.findFirst({
    where: { id: assessmentId, project: { organizationId: orgId(req) } },
    include: { project: true },
  });
  if (!assessment) throw new AppError(404, 'Assessment not found');
  assertProjectWritable(req, assessment.project);
  return assessment;
}

export async function assertQualitativeAccess(req: Request, entryId: string) {
  const entry = await prisma.qualitativeEntry.findFirst({
    where: { id: entryId, project: { organizationId: orgId(req) } },
    include: { project: true, assessment: true },
  });
  if (!entry) throw new AppError(404, 'Entry not found');
  assertProjectWritable(req, entry.project);
  return entry;
}

export async function assertReportAccess(req: Request, reportId: string) {
  const report = await prisma.report.findFirst({
    where: { id: reportId, project: { organizationId: orgId(req) } },
    include: { project: true },
  });
  if (!report) throw new AppError(404, 'Report not found');
  assertProjectWritable(req, report.project);
  return report;
}

export async function assertBeneficiaryAccess(req: Request, beneficiaryId: string) {
  const beneficiary = await prisma.beneficiary.findFirst({
    where: { id: beneficiaryId, project: { organizationId: orgId(req) } },
    include: { project: true },
  });
  if (!beneficiary) throw new AppError(404, 'Beneficiary not found');
  assertProjectWritable(req, beneficiary.project);
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
  assertProjectWritable(req, result.framework.project);
  return result;
}

/**
 * A KPI suggestion run of the caller's organisation, with its project (GET /api/kpi-suggestion-runs/:id;
 * knowledge/kpi-assistant-spec.md §A6 "All routes check that the project belongs to req.user.organizationId").
 * 404 "Run not found" for another organisation's run, as for every other resource. A write to a run of an archived
 * project answers 409 project_archived (no such route today; reads are unaffected).
 */
export async function assertKpiRunAccess(req: Request, runId: string): Promise<KpiSuggestionRun & { project: Project }> {
  const run = await prisma.kpiSuggestionRun.findFirst({
    where: { id: runId, project: { organizationId: orgId(req) } },
    include: { project: true },
  });
  if (!run) throw new AppError(404, 'Run not found');
  assertProjectWritable(req, run.project);
  return run;
}

/**
 * A KPI suggestion of the caller's organisation, with its project (POST /api/kpi-suggestions/:id/accept|reject;
 * spec §A6). 404 "Suggestion not found" for another organisation's suggestion; accepting or rejecting a suggestion of
 * an archived project answers 409 project_archived (the suggestion stays pending until the project is restored).
 */
export async function assertKpiSuggestionAccess(req: Request, suggestionId: string): Promise<KpiSuggestion & { project: Project }> {
  const suggestion = await prisma.kpiSuggestion.findFirst({
    where: { id: suggestionId, project: { organizationId: orgId(req) } },
    include: { project: true },
  });
  if (!suggestion) throw new AppError(404, 'Suggestion not found');
  assertProjectWritable(req, suggestion.project);
  return suggestion;
}
