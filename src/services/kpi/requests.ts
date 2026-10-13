/**
 * POST /api/projects/:id/kpi-suggestions and the alternatives alias: body, scope ids, preview and the request
 * checks in their fixed order (knowledge/kpi-assistant-spec.md §A6; design sections 4.5 and 7.2, D6, D20, D21).
 * Every id is checked against the caller's organisation and the project's current framework (CLAUDE.md rule 1).
 */
import type { Request, Response } from 'express';
import type { KpiSuggestion, Prisma, PrismaClient, Project } from '@prisma/client';
import { z } from 'zod';
import { env } from '../../config/env';
import { budgetCostUsd, getModelInfo, MODELS } from '../ai/models';
import { prisma } from '../../config/prisma';
import { AppError } from '../../middleware/errorHandler';
import { STAFF_ROLES } from '../../middleware/roles';
import { findCurrentFramework } from '../frameworks/current';
import { sortResultNodes } from '../indicators/hierarchy';
import { kpiAssistantStatus } from './availability';
import { buildProjectContext, KpiContextError } from './context';
import { KPI_SYNC_WAIT_MS, startKpiRun, toRunDto, toSuggestionDto, waitForRun } from './runs';
import { allowanceFor, scopedResults } from './scope';
import type { KpiRunDto, KpiScope, KpiSuggestionDto, ProjectContext } from './types';

/**
 * Roles that may use the KPI Assistant: the staff roles (src/middleware/roles.ts; docs/SECURITY_SETUP.md §8), so a
 * donor viewer never sees raw suggestions (spec §A1) and never spends AI budget. tests/roles.test.ts checks that
 * every KPI route carries exactly these roles.
 */
export const KPI_ROLES = STAFF_ROLES;
/** More scoped results than this → 422 too_many_results (D20). */
export const KPI_MAX_RESULTS_PER_RUN = 40;

/** The parsed request body (design 7.3): exactly one id for alternatives; unknown keys stripped. */
export type KpiRequestBody = { scope: 'framework' } | { scope: 'result'; resultId: string }
  | { scope: 'alternatives'; indicatorId: string } | { scope: 'alternatives'; suggestionId: string };

const id = (name: string) => z.string({ required_error: 'is required', invalid_type_error: 'must be a string' })
  .trim()
  .min(1, `${name} is required`)
  .max(100, `${name} is too long`);

const scopeSchema = z.object({
  scope: z.enum(['framework', 'result', 'alternatives'], {
    errorMap: () => ({ message: 'scope must be one of: framework, result, alternatives' }),
  }),
}, { invalid_type_error: 'the request body must be a JSON object', required_error: 'the request body must be a JSON object' });
const resultSchema = z.object({ resultId: id('resultId') });
const alternativesSchema = z.object({ indicatorId: id('indicatorId').optional(), suggestionId: id('suggestionId').optional() });

function firstIssue(error: z.ZodError, field?: string): string {
  const issue = error.issues[0];
  const path = issue?.path.join('.') || field;
  if (!issue) return 'Invalid request.';
  return path && !issue.message.startsWith(path) ? `${path} ${issue.message}` : issue.message;
}

/**
 * The request body (design 7.3; zod v3): `{ scope: 'framework' }`, `{ scope: 'result', resultId }`,
 * `{ scope: 'alternatives', indicatorId }` or `{ scope: 'alternatives', suggestionId }` (D6). Unknown keys are stripped;
 * alternatives need exactly one id. Throws AppError 400 naming the problem.
 */
export function parseKpiRequestBody(body: unknown): KpiRequestBody {
  const scoped = scopeSchema.safeParse(body ?? undefined);
  if (!scoped.success) throw new AppError(400, `Invalid request: ${firstIssue(scoped.error)}`);
  const { scope } = scoped.data;
  if (scope === 'framework') return { scope };
  if (scope === 'result') {
    const parsed = resultSchema.safeParse(body);
    if (!parsed.success) throw new AppError(400, `Invalid request: ${firstIssue(parsed.error, 'resultId')}`);
    return { scope, resultId: parsed.data.resultId };
  }
  const parsed = alternativesSchema.safeParse(body);
  if (!parsed.success) throw new AppError(400, `Invalid request: ${firstIssue(parsed.error)}`);
  const { indicatorId, suggestionId } = parsed.data;
  if ((indicatorId === undefined) === (suggestionId === undefined)) {
    throw new AppError(400, 'Invalid request: alternatives need exactly one of indicatorId or suggestionId');
  }
  return indicatorId !== undefined ? { scope, indicatorId } : { scope, suggestionId: suggestionId as string };
}

const NOT_SUGGESTABLE_ACTIVITY = 'Indicators are suggested for impacts, outcomes and outputs, not for activities.';
const LINK_FIRST = 'Link the indicator to a result first.';

/**
 * Checks body ids against the project's current framework: any id that is not in it (another organisation, another
 * project of the same organisation, an older version) → 400; activity → 422 not_suggestable; indicator without a result
 * → 422 not_suggestable ("Link the indicator to a result first."; D21). `via: 'alias'` (id from the path, access already
 * checked): an indicator of an older framework version → 409 stale instead of 400 (design 7.1, m11). A suggestion must be
 * pending or rejected (D6).
 */
export async function resolveScope(db: Prisma.TransactionClient | PrismaClient, frameworkId: string, projectId: string,
  body: ReturnType<typeof parseKpiRequestBody>, via: 'body' | 'alias' = 'body'): Promise<KpiScope> {
  if (body.scope === 'framework') return { type: 'framework' };

  if (body.scope === 'result') {
    const result = await db.resultNode.findFirst({
      where: { id: body.resultId, frameworkId, framework: { projectId } },
      select: { id: true, level: true },
    });
    if (!result) throw new AppError(400, "resultId is not a result of this project's current framework");
    if (result.level === 'activity') throw new AppError(422, NOT_SUGGESTABLE_ACTIVITY, 'not_suggestable');
    return { type: 'result', resultId: result.id };
  }

  if ('indicatorId' in body) {
    const indicator = await db.indicator.findFirst({
      where: { id: body.indicatorId, framework: { projectId } },
      select: { id: true, frameworkId: true, resultId: true, result: { select: { level: true } } },
    });
    if (!indicator || indicator.frameworkId !== frameworkId) {
      if (indicator && via === 'alias') {
        throw new AppError(409, 'This indicator belongs to an older version of the framework. Open the current framework and try again.', 'stale');
      }
      throw new AppError(400, "indicatorId is not an indicator of this project's current framework");
    }
    if (!indicator.resultId || !indicator.result) throw new AppError(422, LINK_FIRST, 'not_suggestable');
    if (indicator.result.level === 'activity') throw new AppError(422, NOT_SUGGESTABLE_ACTIVITY, 'not_suggestable');
    return { type: 'alternatives', indicatorId: indicator.id, suggestionId: null };
  }

  const suggestion = await db.kpiSuggestion.findFirst({
    where: { id: body.suggestionId, projectId, frameworkId, status: { in: ['pending', 'rejected'] } },
    select: { id: true, resultId: true },
  });
  if (!suggestion) throw new AppError(400, "suggestionId is not a pending or rejected suggestion of this project's current framework");
  if (!suggestion.resultId) throw new AppError(422, 'The result of this suggestion no longer exists.', 'not_suggestable');
  return { type: 'alternatives', indicatorId: null, suggestionId: suggestion.id };
}

/**
 * Organisation's AI spend over the last 24 h (index on organizationId, createdAt; D20): SUM(AiCall.estimatedCostUsd),
 * failing closed for calls the price table cannot price (CC-07): a call with no estimate, or whose requested or served
 * model has no price in models.ts (a new AI_MODEL_MAIN, a server-side fallback to an unlisted model), counts at the
 * highest known rates for all its tokens (budgetCostUsd) when that is more than its stored estimate. So an unpriced model
 * can never keep the organisation under its budget; the stored estimates themselves stay unchanged (no guess is stored).
 */
export async function organisationSpendUsd(db: Prisma.TransactionClient | PrismaClient, organizationId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const where = { organizationId, createdAt: { gte: since } };
  const { _sum } = await db.aiCall.aggregate({ where, _sum: { estimatedCostUsd: true } });
  const priced = Object.keys(MODELS);
  const doubtful = await db.aiCall.findMany({
    where: { ...where, OR: [{ estimatedCostUsd: null }, { model: { notIn: priced } }, { servedModel: { notIn: priced } }] },
    select: { model: true, servedModel: true, estimatedCostUsd: true, inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true },
  });
  let extra = 0;
  for (const call of doubtful) {
    const stored = call.estimatedCostUsd === null ? null : Number(call.estimatedCostUsd.toString());
    const unpriced = stored === null || getModelInfo(call.model) === null || (call.servedModel !== null && getModelInfo(call.servedModel) === null);
    if (!unpriced) continue; // a dated snapshot id of a priced model
    extra += Math.max(0, budgetCostUsd(call) - (stored ?? 0));
  }
  const total = (_sum.estimatedCostUsd === null ? 0 : Number(_sum.estimatedCostUsd.toString())) + extra;
  return Math.round(total * 1_000_000) / 1_000_000;
}

/** Why a scope has nothing to suggest (422 nothing_to_suggest `details.reason`; design 7.1, m4/SDA-12). */
export type NothingToSuggestReason = 'no_results' | 'level_cap' | 'donor_cap';

/**
 * The reason `scopedResults(ctx)` is empty (pure): no impact, outcome or output in scope → no_results; results exist but
 * every allowance is 0 → donor_cap when the results would have room without the donor cap, else level_cap (D5, D10).
 */
export function nothingToSuggestReason(ctx: ProjectContext): NothingToSuggestReason {
  const { scope } = ctx;
  const targetId = scope.type === 'result' ? scope.resultId : ctx.alternativesFor?.resultId;
  const inScope = scope.type === 'framework' ? ctx.resultsChain : ctx.resultsChain.filter(r => r.id === targetId);
  if (inScope.length === 0) return 'no_results';
  if (ctx.donorRules.maxIndicatorsPerResult === null) return 'level_cap';
  const withoutCap: ProjectContext = { ...ctx, donorRules: { ...ctx.donorRules, maxIndicatorsPerResult: null } };
  return inScope.some(r => allowanceFor(r, withoutCap).max > 0) ? 'donor_cap' : 'level_cap';
}

const NOTHING_TO_SUGGEST_MESSAGES: Record<NothingToSuggestReason, string> = {
  no_results: 'Nothing to suggest: add an impact, outcome or output to the results chain first.',
  level_cap: 'Nothing to suggest: every result in scope already has the most indicators its level allows.',
  donor_cap: 'Nothing to suggest: every result in scope already has the most indicators the donor allows.',
};

/** Builds a KpiContextError into the request's answer: stale → 409 stale; not_found → 422 not_suggestable. */
function contextErrorToAppError(err: KpiContextError): AppError {
  return err.code === 'stale' ? new AppError(409, err.message, 'stale') : new AppError(422, err.message, 'not_suggestable');
}

/**
 * Suggestions in results-chain order (impact, outcome, output, then sortOrder and code: sortResultNodes), then oldest
 * first, then rank: cards of one result stay together and ranked (spec §A1 "a short ranked list per outcome and
 * output"). Rows whose result was deleted come last. Pure; `resultOrder` maps result id → chain position.
 */
export function sortSuggestionRows<T extends Pick<KpiSuggestion, 'resultId' | 'createdAt' | 'sortOrder' | 'id'>>(rows: readonly T[], resultOrder: ReadonlyMap<string, number>): T[] {
  const position = (row: T) => (row.resultId !== null && resultOrder.has(row.resultId) ? resultOrder.get(row.resultId) as number : Number.MAX_SAFE_INTEGER);
  return [...rows].sort((a, b) => position(a) - position(b)
    || a.createdAt.getTime() - b.createdAt.getTime()
    || a.sortOrder - b.sortOrder
    || a.id.localeCompare(b.id));
}

/** Result id → position in the framework's results chain (sortResultNodes order). */
export async function resultOrderFor(frameworkId: string): Promise<Map<string, number>> {
  const nodes = await prisma.resultNode.findMany({ where: { frameworkId }, select: { id: true, level: true, sortOrder: true, code: true } });
  return new Map(sortResultNodes(nodes).map((node, index) => [node.id, index]));
}

/** `{ run, suggestions }` of a run (every suggestion of the run, any status, chain order), for the POST and GET run routes. */
export async function runWithSuggestions(runId: string, now: Date = new Date()): Promise<{ run: KpiRunDto; suggestions: KpiSuggestionDto[] }> {
  const [run, suggestions] = await Promise.all([
    prisma.kpiSuggestionRun.findUniqueOrThrow({ where: { id: runId } }),
    prisma.kpiSuggestion.findMany({ where: { runId } }),
  ]);
  const order = await resultOrderFor(run.frameworkId);
  return { run: toRunDto(run, now), suggestions: sortSuggestionRows(suggestions, order).map(toSuggestionDto) };
}

/**
 * Shared by POST /projects/:id/kpi-suggestions and POST /indicators/:id/alternative (section 7.2). The route has
 * already loaded `project` through the organisation access check (step 1: 404 before anything costs money). Then:
 * 2 body (400) → 3 archived project (409 project_archived) → 4 current framework (409 no_framework) → 5 scope ids
 * (400 / 409 stale / 422 not_suggestable) → 6 preview without documents: nothing in scope (422 nothing_to_suggest with
 * details.reason) or more than KPI_MAX_RESULTS_PER_RUN results (422 too_many_results) → 7 no real key (503
 * ai_not_configured) or the organisation's daily AI budget spent (429 budget_reached) → 8 startKpiRun (409
 * run_in_progress, details.runId) → 9 framework scope 202 `{ run }`; otherwise wait up to KPI_SYNC_WAIT_MS: finished →
 * 200 `{ run, suggestions }`, else 202 `{ run }` (the client polls GET /api/kpi-suggestion-runs/:id).
 */
export async function handleKpiRequest(req: Request, res: Response, project: Project, body: unknown, via: 'body' | 'alias' = 'body'): Promise<void> {
  if (!req.user) throw new AppError(401, 'Not authenticated');
  const organizationId = req.user.organizationId;

  const parsed = parseKpiRequestBody(body);
  if (project.status === 'archived') {
    throw new AppError(409, 'This project is archived; KPI suggestions are not available for it.', 'project_archived');
  }
  const framework = await findCurrentFramework(prisma, project.id);
  if (!framework) throw new AppError(409, 'This project has no framework yet. Create or generate one first.', 'no_framework');
  const scope = await resolveScope(prisma, framework.id, project.id, parsed, via);

  let ctx: ProjectContext;
  try {
    ctx = await buildProjectContext(prisma, { organizationId, projectId: project.id, frameworkId: framework.id, scope, now: new Date() },
      { withDocuments: false });
  } catch (err) {
    if (err instanceof KpiContextError) throw contextErrorToAppError(err);
    throw err;
  }
  const results = scopedResults(ctx);
  if (results.length === 0) {
    const reason = nothingToSuggestReason(ctx);
    throw new AppError(422, NOTHING_TO_SUGGEST_MESSAGES[reason], 'nothing_to_suggest', { reason });
  }
  if (results.length > KPI_MAX_RESULTS_PER_RUN) {
    throw new AppError(422, `Suggest KPIs for one result at a time; this framework has ${results.length} results.`, 'too_many_results',
      { count: results.length, max: KPI_MAX_RESULTS_PER_RUN });
  }

  if (!kpiAssistantStatus().aiConfigured) {
    throw new AppError(503, 'AI suggestions are not set up yet.', 'ai_not_configured');
  }
  const budget = env.aiOrgDailyBudgetUsd;
  if (budget > 0 && await organisationSpendUsd(prisma, organizationId, new Date()) >= budget) {
    throw new AppError(429, "Your organisation has used today's AI budget. Try again tomorrow.", 'budget_reached', { budgetUsd: budget });
  }

  const { run, done } = await startKpiRun({ projectId: project.id, organizationId, frameworkId: framework.id, scope, requestedBy: req.user.id });
  if (scope.type === 'framework') {
    res.status(202).json({ run: toRunDto(run, new Date()) });
    return;
  }
  const finished = await waitForRun(done, KPI_SYNC_WAIT_MS);
  const answer = await runWithSuggestions(run.id);
  if (finished && answer.run.status !== 'running') {
    res.status(200).json(answer);
    return;
  }
  res.status(202).json({ run: answer.run });
}
