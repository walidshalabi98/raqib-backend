/**
 * KPI suggestion runs: the status row the UI polls, the in-process executor with its heartbeat and deadline, conflict
 * checks under a per-project advisory lock, and the DTOs (knowledge/kpi-assistant-spec.md §A6; design sections 4.5
 * and 7.4, D3).
 *
 * A run executes in the API process (D3: the same pattern as framework generation). Every write the executor makes is
 * conditional on `status: 'running'`, so a run that was marked interrupted (SIGTERM, or 15 minutes without a heartbeat)
 * is never flipped back by a late writer. Logs hold ids, counts and safe error summaries only (CLAUDE.md rules 3, 5).
 */
import { Prisma } from '@prisma/client';
import type { KpiSuggestion, KpiSuggestionRun, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError } from '../../middleware/errorHandler';
import {
  AiError, AiInvalidOutputError, AiOutputTruncatedError, AiRefusalError, AiRequestError, safeErrorSummary,
} from '../ai/errors';
import { findCurrentFramework } from '../frameworks/current';
import { buildProjectContext, KpiContextError } from './context';
import { productionPipelineDeps } from './deps';
import { normalisedIndicatorName } from './nameRules';
import { KpiPipelineError, runKpiPipeline } from './pipeline';
import { qualityBand, warning } from './validate';
import type {
  KpiErrorCode, KpiPipelineDeps, KpiPipelineResult, KpiRunDto, KpiRunStep, KpiScope, KpiSuggestionDto, KpiWarning,
  SuggestableLevel, SuggestionOrigin, ValidatedSuggestion,
} from './types';

/** How long POST waits for a result or alternatives run before answering 202 (design 7.2 step 9, 7.4; spec §A6 "< 20 s"). */
export const KPI_SYNC_WAIT_MS = 20_000;
/** Timer: touches updatedAt while executeKpiRun runs in this process. */
export const KPI_HEARTBEAT_MS = 30_000;
/** No heartbeat for 15 min (30 missed beats) → reported failed/interrupted. */
export const KPI_RUN_STALE_MS = 15 * 60_000;

/** Interactive transactions of the KPI Assistant (run creation, persistence, accept): wait ≤ 10 s, run ≤ 30 s. */
export const KPI_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

/** Safe message of a run marked interrupted (SIGTERM, or no heartbeat for KPI_RUN_STALE_MS; design 7.4). */
export const INTERRUPTED_RUN_MESSAGE = 'The suggestion run was interrupted (the server restarted or stopped responding). Try again.';
const INTERNAL_RUN_MESSAGE = 'Suggestions could not be prepared because of an internal error. Try again.';

/**
 * What a run executor needs (design 4.5): the Prisma client, a factory for the pipeline dependencies (production:
 * productionPipelineDeps) and the clock used for heartbeats and stale checks.
 */
export interface KpiRunDeps { db: PrismaClient; pipeline: () => KpiPipelineDeps; now: () => Date }

type Db = Prisma.TransactionClient | PrismaClient;

/** Run ids executing in this process (heartbeat owners). */
const active = new Set<string>();

/** The run was marked failed meanwhile (interrupted or stale): its results are discarded, nothing more is written. */
class RunNoLongerRunning extends Error {
  constructor() {
    super('run no longer running');
    this.name = 'RunNoLongerRunning';
  }
}

/**
 * pg_advisory_xact_lock(hashtext('kpi-run:' || projectId)): serialises run creation and persistence per project until
 * the transaction ends (design 7.2 step 8, SDA-04). Two simultaneous POSTs can no longer both pass the conflict check.
 */
async function lockProject(tx: Prisma.TransactionClient, projectId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`kpi-run:${projectId}`}::text))`;
}

/** The result the scope is about (result scope: that result; alternatives: the source's result; framework: null). */
async function scopeResultId(db: Db, scope: KpiScope): Promise<string | null> {
  if (scope.type === 'result') return scope.resultId;
  if (scope.type === 'framework') return null;
  if (scope.indicatorId !== null) {
    return (await db.indicator.findUnique({ where: { id: scope.indicatorId }, select: { resultId: true } }))?.resultId ?? null;
  }
  return (await db.kpiSuggestion.findUnique({ where: { id: scope.suggestionId }, select: { resultId: true } }))?.resultId ?? null;
}

/** KpiScope from the run row's columns; KpiContextError not_found when the scoped result or source is gone. */
function scopeOfRun(run: Pick<KpiSuggestionRun, 'scope' | 'resultId' | 'sourceIndicatorId' | 'sourceSuggestionId'>): KpiScope {
  if (run.scope === 'framework') return { type: 'framework' };
  if (run.scope === 'result') {
    if (!run.resultId) throw new KpiContextError('not_found', 'The result of this request no longer exists.');
    return { type: 'result', resultId: run.resultId };
  }
  if (run.sourceIndicatorId) return { type: 'alternatives', indicatorId: run.sourceIndicatorId, suggestionId: null };
  if (run.sourceSuggestionId) return { type: 'alternatives', indicatorId: null, suggestionId: run.sourceSuggestionId };
  throw new KpiContextError('not_found', 'The indicator or suggestion of this request no longer exists.');
}

/**
 * Takes pg_advisory_xact_lock(hashtext('kpi-run:' || projectId)) in a transaction, re-checks findConflictingRun (409
 * run_in_progress, `details.runId`) and creates the row; then starts executeKpiRun (never rejects `done`). The caller
 * has checked organisation access and resolved the scope ids against the project's current framework (requests.ts).
 * Design 4.5 and 7.2 step 8.
 */
export async function startKpiRun(input: { projectId: string; organizationId: string; frameworkId: string; scope: KpiScope; requestedBy: string },
  deps: Partial<KpiRunDeps> = {}): Promise<{ run: KpiSuggestionRun; done: Promise<void> }> {
  const d: KpiRunDeps = { db: prisma, pipeline: productionPipelineDeps, now: () => new Date(), ...deps };
  const { projectId, frameworkId, scope } = input;
  const run = await d.db.$transaction(async tx => {
    await lockProject(tx, projectId);
    const resultId = await scopeResultId(tx, scope);
    const conflict = await findConflictingRun(tx, { projectId, frameworkId, scope, resultId }, d.now());
    if (conflict) {
      throw new AppError(409, 'Suggestions are already being prepared for this framework or result. Wait for them to finish.',
        'run_in_progress', { runId: conflict.id });
    }
    const now = d.now();
    return tx.kpiSuggestionRun.create({
      data: {
        projectId,
        frameworkId,
        scope: scope.type,
        resultId,
        sourceIndicatorId: scope.type === 'alternatives' ? scope.indicatorId : null,
        sourceSuggestionId: scope.type === 'alternatives' ? scope.suggestionId : null,
        status: 'running',
        step: 'context',
        requestedBy: input.requestedBy,
        updatedAt: now,
      },
    });
  }, KPI_TRANSACTION_OPTIONS);
  console.log(`[KpiRun] ${run.id} started (project ${projectId}, scope ${scope.type})`);
  const done = executeKpiRun(run.id, d).catch(err => {
    console.error(`[KpiRun] ${run.id} executor error: ${safeErrorSummary(err)}`);
  });
  return { run, done };
}

/** Totals of the model calls of a run (stored on the run row). Cost is null when any call's cost is unknown. */
export function callTotals(calls: KpiPipelineResult['calls']): { inputTokens: number; outputTokens: number; estimatedCostUsd: number | null } {
  let inputTokens = 0;
  let outputTokens = 0;
  let cost: number | null = 0;
  for (const call of calls) {
    inputTokens += call.inputTokens;
    outputTokens += call.outputTokens;
    cost = cost === null || call.estimatedCostUsd === null ? null : cost + call.estimatedCostUsd;
  }
  return { inputTokens, outputTokens, estimatedCostUsd: cost };
}

/** What KpiSuggestion.payload stores: the suggestion without warnings, qualityScore and qualityBand (columns; design 5.1). */
export function storedPayload(s: ValidatedSuggestion): Omit<ValidatedSuggestion, 'warnings' | 'qualityScore' | 'qualityBand'> {
  const { warnings: _warnings, qualityScore: _score, qualityBand: _band, ...payload } = s;
  return payload;
}

/** Keys identifying an indicator on a result for de-duplication: (result, library id) and (result, normalised name). */
function duplicateKeys(resultId: string | null, libraryId: string | null, name: string): string[] {
  if (!resultId) return [];
  const keys: string[] = [];
  if (libraryId && libraryId.trim()) keys.push(`${resultId}|lib|${libraryId.trim().toUpperCase()}`);
  const normalised = normalisedIndicatorName(name);
  if (normalised) keys.push(`${resultId}|name|${normalised}`);
  return keys;
}

const payloadName = (payload: unknown): string => {
  const name = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>).name : null;
  return typeof name === 'string' ? name : '';
};

/** A suggestion dropped while saving: its result was deleted meanwhile, or it repeats an indicator or a pending card. */
export interface PersistenceDrop { resultCode: string; name: string; reason: 'result_deleted' | 'duplicate' }

/**
 * The persistence plan of a finished pipeline (design 4.5; pure, exported for tests):
 * - suggestions whose result no longer exists are dropped;
 * - pending suggestions this run expires: created before the run started, never alternatives (alternativeOf* set), only
 *   for result/framework runs (alternatives runs expire nothing), and only on results that keep at least one new
 *   suggestion (results the run skipped or that failed keep their cards; SDA-11);
 * - suggestions matching (result, library id) or (result, normalised name) of a current indicator or of a pending
 *   suggestion this run does not expire are dropped (overlapping runs never leave duplicate cards);
 * - the kept suggestions are re-ranked 1..n per result in their order.
 */
export function planPersistence(input: {
  suggestions: readonly ValidatedSuggestion[];
  scopeType: KpiScope['type'];
  runCreatedAt: Date;
  liveResultIds: ReadonlySet<string>;
  indicators: ReadonlyArray<{ resultId: string | null; libraryId: string | null; indicatorText: string }>;
  pending: ReadonlyArray<{ id: string; resultId: string | null; libraryId: string | null; payload: unknown; createdAt: Date;
    alternativeOfIndicatorId: string | null; alternativeOfSuggestionId: string | null }>;
}): { kept: ValidatedSuggestion[]; expireIds: string[]; dropped: PersistenceDrop[] } {
  const dropped: PersistenceDrop[] = [];
  const live = input.suggestions.filter(s => {
    if (input.liveResultIds.has(s.resultId)) return true;
    dropped.push({ resultCode: s.resultCode, name: s.name, reason: 'result_deleted' });
    return false;
  });

  const expirable = input.scopeType === 'alternatives' ? [] : input.pending.filter(p => p.resultId !== null
    && p.createdAt.getTime() < input.runCreatedAt.getTime()
    && p.alternativeOfIndicatorId === null && p.alternativeOfSuggestionId === null);
  const expirableIds = new Set(expirable.map(p => p.id));

  const taken = new Set<string>();
  for (const i of input.indicators) for (const key of duplicateKeys(i.resultId, i.libraryId, i.indicatorText)) taken.add(key);
  for (const p of input.pending) {
    if (expirableIds.has(p.id)) continue;
    for (const key of duplicateKeys(p.resultId, p.libraryId, payloadName(p.payload))) taken.add(key);
  }

  const kept = live.filter(s => {
    if (!duplicateKeys(s.resultId, s.libraryId, s.name).some(key => taken.has(key))) return true;
    dropped.push({ resultCode: s.resultCode, name: s.name, reason: 'duplicate' });
    return false;
  });

  const ranks = new Map<string, number>();
  const reRanked = kept.map(s => {
    const rank = (ranks.get(s.resultId) ?? 0) + 1;
    ranks.set(s.resultId, rank);
    return rank === s.rank ? s : { ...s, rank };
  });
  const withNew = new Set(reRanked.map(s => s.resultId));
  const expireIds = expirable.filter(p => p.resultId !== null && withNew.has(p.resultId)).map(p => p.id);
  return { kept: reRanked, expireIds, dropped };
}

/** Longest name quoted in a warning parameter. */
const MAX_WARNING_NAME_CHARS = 60;

/**
 * near_duplicate framework warnings for suggestions dropped while saving because they repeat an indicator or a pending
 * card created meanwhile (rule 18 at save time). Names are the validated (redacted) suggestion names, clipped.
 */
export function persistenceWarnings(dropped: readonly PersistenceDrop[]): KpiWarning[] {
  return dropped
    .filter(d => d.reason === 'duplicate')
    .map(d => {
      const name = d.name.trim();
      return warning('near_duplicate', { name: name.length > MAX_WARNING_NAME_CHARS ? `${name.slice(0, MAX_WARNING_NAME_CHARS - 1)}…` : name });
    });
}

/**
 * Executes one run in this process (design 4.5): registers it in activeRunIds() and starts a KPI_HEARTBEAT_MS timer that
 * touches updatedAt (so a live run is never reported stale however long one model call takes); step 'context' →
 * buildProjectContext → runKpiPipeline (onStep stores the step, onProgress touches updatedAt) → step 'saving' → one
 * interactive transaction under the project's advisory lock: conditional claim (a run marked interrupted meanwhile is
 * rolled back and its results discarded), current-framework re-check (else failed 'stale'), planPersistence, createMany,
 * expiry, conditional completion with counts, token and cost sums. Any error → failed with errorCodeFor(err)
 * (conditional on running). Never throws.
 */
export async function executeKpiRun(runId: string, deps: KpiRunDeps): Promise<void> {
  const { db } = deps;
  const startedAt = Date.now();
  active.add(runId);
  const touch = async (data: Prisma.KpiSuggestionRunUpdateManyMutationInput = {}): Promise<number> => {
    const { count } = await db.kpiSuggestionRun.updateMany({ where: { id: runId, status: 'running' }, data: { ...data, updatedAt: deps.now() } });
    return count;
  };
  const timer = setInterval(() => {
    touch().catch(err => console.warn(`[KpiRun] ${runId} heartbeat failed: ${safeErrorSummary(err)}`));
  }, KPI_HEARTBEAT_MS);
  timer.unref?.();
  const setStep = async (step: KpiRunStep): Promise<void> => {
    if ((await touch({ step })) === 0) throw new RunNoLongerRunning();
  };

  try {
    const run = await db.kpiSuggestionRun.findUnique({ where: { id: runId }, include: { project: { select: { organizationId: true } } } });
    if (!run || run.status !== 'running') return;
    const { projectId, frameworkId } = run;
    const organizationId = run.project.organizationId;

    await setStep('context');
    const ctx = await buildProjectContext(db, { organizationId, projectId, frameworkId, scope: scopeOfRun(run), now: deps.now() });
    const result = await runKpiPipeline(ctx, deps.pipeline(), {
      onStep: step => setStep(step),
      onProgress: async () => { await touch(); },
      callContext: { organizationId, projectId },
    });
    await setStep('saving');

    const saved = await db.$transaction(async tx => {
      await lockProject(tx, projectId);
      const claimed = await tx.kpiSuggestionRun.updateMany({ where: { id: runId, status: 'running' }, data: { step: 'saving', updatedAt: deps.now() } });
      if (claimed.count === 0) throw new RunNoLongerRunning();
      const current = await findCurrentFramework(tx, projectId);
      if (current?.id !== frameworkId) {
        throw new KpiContextError('stale', 'A newer framework version was created while suggestions were prepared; they were not saved.');
      }

      const resultIds = Array.from(new Set(result.suggestions.map(s => s.resultId)));
      const [liveResults, indicators, pending] = await Promise.all([
        tx.resultNode.findMany({ where: { id: { in: resultIds }, frameworkId, level: { not: 'activity' } }, select: { id: true } }),
        tx.indicator.findMany({ where: { frameworkId, resultId: { in: resultIds } }, select: { resultId: true, libraryId: true, indicatorText: true } }),
        tx.kpiSuggestion.findMany({
          where: { frameworkId, status: 'pending', resultId: { in: resultIds } },
          select: { id: true, resultId: true, libraryId: true, payload: true, createdAt: true, alternativeOfIndicatorId: true, alternativeOfSuggestionId: true },
        }),
      ]);
      const plan = planPersistence({
        suggestions: result.suggestions,
        scopeType: run.scope,
        runCreatedAt: run.createdAt,
        liveResultIds: new Set(liveResults.map(r => r.id)),
        indicators,
        pending,
      });

      const model = result.model ?? 'unknown';
      if (plan.kept.length > 0) {
        await tx.kpiSuggestion.createMany({
          data: plan.kept.map(s => ({
            projectId,
            frameworkId,
            runId,
            resultId: s.resultId,
            level: s.level,
            sortOrder: s.rank,
            payload: storedPayload(s) as unknown as Prisma.InputJsonValue,
            qualityScore: s.qualityScore,
            warnings: s.warnings as unknown as Prisma.InputJsonValue,
            libraryId: s.libraryId,
            isCustom: s.isCustom,
            method: s.method,
            status: 'pending' as const,
            model,
            promptVersion: result.promptVersion,
            alternativeOfIndicatorId: run.sourceIndicatorId,
            alternativeOfSuggestionId: run.sourceSuggestionId,
          })),
        });
      }
      const expired = plan.expireIds.length === 0 ? 0 : (await tx.kpiSuggestion.updateMany({
        where: { id: { in: plan.expireIds }, status: 'pending' },
        data: { status: 'expired' },
      })).count;

      const totals = callTotals(result.calls);
      const finishedAt = deps.now();
      const completed = await tx.kpiSuggestionRun.updateMany({
        where: { id: runId, status: 'running' },
        data: {
          status: 'completed',
          step: 'done',
          suggestionCount: plan.kept.length,
          frameworkWarnings: [...result.frameworkWarnings, ...persistenceWarnings(plan.dropped)] as unknown as Prisma.InputJsonValue,
          retrieval: result.retrieval,
          model: result.model,
          promptVersion: result.promptVersion,
          modelCalls: result.calls.length,
          embeddingCalls: result.embeddingCalls,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          estimatedCostUsd: totals.estimatedCostUsd === null ? null : new Prisma.Decimal(totals.estimatedCostUsd.toFixed(6)),
          latencyMs: Date.now() - startedAt,
          finishedAt,
          updatedAt: finishedAt,
        },
      });
      if (completed.count === 0) throw new RunNoLongerRunning();
      return { created: plan.kept.length, expired, dropped: plan.dropped.length };
    }, KPI_TRANSACTION_OPTIONS);
    console.log(`[KpiRun] ${runId} completed: ${saved.created} suggestions, ${saved.expired} expired, ${saved.dropped} dropped, ${result.calls.length} model calls`);
  } catch (err) {
    if (err instanceof RunNoLongerRunning) {
      console.warn(`[KpiRun] ${runId} no longer running; results discarded`);
      return;
    }
    const failure = errorCodeFor(err);
    try {
      const finishedAt = deps.now();
      await db.kpiSuggestionRun.updateMany({
        where: { id: runId, status: 'running' },
        data: { status: 'failed', errorCode: failure.errorCode, error: failure.message, finishedAt, updatedAt: finishedAt, latencyMs: Date.now() - startedAt },
      });
    } catch (writeErr) {
      console.error(`[KpiRun] ${runId} could not store its failure: ${safeErrorSummary(writeErr)}`);
    }
    console.error(`[KpiRun] ${runId} failed (${failure.errorCode}): ${safeErrorSummary(err)}`);
  } finally {
    clearInterval(timer);
    active.delete(runId);
  }
}

/** Run ids executing in this process (heartbeat owners); the SIGTERM handler in src/index.ts marks them failed/interrupted. */
export function activeRunIds(): string[] {
  return Array.from(active);
}

/**
 * Marks these runs failed with errorCode 'interrupted' when they are still running (design 7.4: a process that receives
 * SIGTERM marks its own running runs at once). Returns how many rows changed.
 */
export async function markRunsInterrupted(db: PrismaClient, runIds: readonly string[]): Promise<number> {
  if (runIds.length === 0) return 0;
  const now = new Date();
  const { count } = await db.kpiSuggestionRun.updateMany({
    where: { id: { in: [...runIds] }, status: 'running' },
    data: { status: 'failed', errorCode: 'interrupted', error: INTERRUPTED_RUN_MESSAGE, finishedAt: now, updatedAt: now },
  });
  return count;
}

/** SIGTERM: marks every run executing in this process interrupted (src/index.ts). Returns how many rows changed. */
export async function interruptActiveRuns(db: PrismaClient = prisma): Promise<number> {
  return markRunsInterrupted(db, activeRunIds());
}

const KPI_ERROR_CODES: ReadonlySet<string> = new Set<KpiErrorCode>([
  'ai_not_configured', 'ai_refused', 'ai_unavailable', 'ai_invalid_output', 'interrupted', 'stale', 'internal',
]);

/**
 * The failure to report for a run (design 7.4): a stored failure (status failed: its errorCode and safe message), or
 * 'interrupted' for a run still marked running whose heartbeat (updatedAt) is older than KPI_RUN_STALE_MS; null for a
 * live or completed run.
 */
export function runFailure(run: Pick<KpiSuggestionRun, 'status' | 'updatedAt' | 'errorCode' | 'error'>, now: Date): { errorCode: KpiErrorCode; message: string } | null {
  if (run.status === 'failed') {
    const errorCode = run.errorCode && KPI_ERROR_CODES.has(run.errorCode) ? run.errorCode as KpiErrorCode : 'internal';
    return { errorCode, message: run.error ?? (errorCode === 'interrupted' ? INTERRUPTED_RUN_MESSAGE : INTERNAL_RUN_MESSAGE) };
  }
  if (run.status === 'running' && now.getTime() - run.updatedAt.getTime() > KPI_RUN_STALE_MS) {
    return { errorCode: 'interrupted', message: INTERRUPTED_RUN_MESSAGE };
  }
  return null;
}

/**
 * Safe messages only (design 4.5): AiRefusalError → ai_refused; AiRequestError 401/403 → ai_not_configured; other
 * AiRequestError → ai_unavailable; AiOutputTruncatedError / AiInvalidOutputError → ai_invalid_output; KpiPipelineError →
 * its code; KpiContextError stale or not_found → stale (the project, framework, scoped result or alternatives source
 * was changed or deleted between the request and the run: a changed framework, not a server fault); anything else →
 * internal. AiError and KpiContextError messages never hold
 * prompt, model or document text, so they are kept; any other error gets a fixed message (it could echo stored values).
 */
export function errorCodeFor(err: unknown): { errorCode: KpiErrorCode; message: string } {
  if (err instanceof KpiPipelineError) return { errorCode: err.code, message: err.message };
  if (err instanceof AiRefusalError) return { errorCode: 'ai_refused', message: err.message };
  if (err instanceof AiRequestError) {
    return { errorCode: err.status === 401 || err.status === 403 ? 'ai_not_configured' : 'ai_unavailable', message: err.message };
  }
  if (err instanceof AiOutputTruncatedError || err instanceof AiInvalidOutputError) return { errorCode: 'ai_invalid_output', message: err.message };
  if (err instanceof AiError) return { errorCode: 'internal', message: err.message };
  if (err instanceof KpiContextError) return { errorCode: 'stale', message: err.message };
  return { errorCode: 'internal', message: INTERNAL_RUN_MESSAGE };
}

/** True when `done` settled within `ms` (the POST waits up to KPI_SYNC_WAIT_MS for result and alternatives runs). */
export async function waitForRun(done: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([done.then(() => true, () => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Running runs whose heartbeat is younger than KPI_RUN_STALE_MS (stale runs are reported interrupted and ignored). */
function liveRunWhere(now: Date): Prisma.KpiSuggestionRunWhereInput {
  return { status: 'running', updatedAt: { gte: new Date(now.getTime() - KPI_RUN_STALE_MS) } };
}

/**
 * Conflicts (section 7.2 step 8): a running framework run blocks every new run of the project's framework; a running
 * result or alternatives run blocks a framework run and another run for the same result. Stale runs are ignored.
 * `resultId` is the result a result or alternatives run is about (the alternatives source's result).
 */
export async function findConflictingRun(db: Prisma.TransactionClient | PrismaClient,
  where: { projectId: string; frameworkId: string; scope: KpiScope; resultId: string | null }, now: Date): Promise<KpiSuggestionRun | null> {
  const blockers: Prisma.KpiSuggestionRunWhereInput[] = [{ scope: 'framework' }];
  if (where.scope.type === 'framework') blockers.push({ scope: { in: ['result', 'alternatives'] } });
  else if (where.resultId) blockers.push({ scope: { in: ['result', 'alternatives'] }, resultId: where.resultId });
  return db.kpiSuggestionRun.findFirst({
    where: { projectId: where.projectId, frameworkId: where.frameworkId, ...liveRunWhere(now), OR: blockers },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Stores failed/interrupted on the project's running runs without a heartbeat for KPI_RUN_STALE_MS (called by the
 * suggestion list, design 7.1 and 7.4); returns the count.
 */
export async function markStaleRuns(db: Prisma.TransactionClient | PrismaClient, projectId: string, now: Date): Promise<number> {
  const { count } = await db.kpiSuggestionRun.updateMany({
    where: { projectId, status: 'running', updatedAt: { lt: new Date(now.getTime() - KPI_RUN_STALE_MS) } },
    data: { status: 'failed', errorCode: 'interrupted', error: INTERRUPTED_RUN_MESSAGE, finishedAt: now },
  });
  return count;
}

const RUN_STEPS: ReadonlySet<string> = new Set<KpiRunStep>(['context', 'retrieval', 'model', 'validation', 'saving', 'done']);
const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? value as T[] : []);
const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

/**
 * The run as the API returns it (KpiRunDto, design 4.1 and 7.3): a run still marked running without a heartbeat for
 * KPI_RUN_STALE_MS is reported failed/interrupted (runFailure). No cost or token columns (server-side only).
 */
export function toRunDto(run: KpiSuggestionRun, now: Date): KpiRunDto {
  const failure = runFailure(run, now);
  return {
    id: run.id,
    projectId: run.projectId,
    frameworkId: run.frameworkId,
    scope: run.scope,
    resultId: run.resultId,
    sourceIndicatorId: run.sourceIndicatorId,
    sourceSuggestionId: run.sourceSuggestionId,
    status: failure ? 'failed' : run.status,
    step: RUN_STEPS.has(run.step) ? run.step as KpiRunStep : 'context',
    errorCode: failure?.errorCode ?? null,
    message: failure?.message ?? null,
    frameworkWarnings: asArray<KpiWarning>(run.frameworkWarnings),
    suggestionCount: run.suggestionCount,
    retrieval: run.retrieval === 'vector' || run.retrieval === 'keyword' ? run.retrieval : null,
    model: run.model,
    promptVersion: run.promptVersion,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    finishedAt: iso(run.finishedAt),
  };
}

/** Payload keys that are DTO columns (or never shown on a card), so `suggestion` holds the card fields only. */
const NON_CARD_KEYS = ['warnings', 'qualityScore', 'qualityBand', 'draft', 'resultId', 'resultCode', 'level', 'libraryId', 'isCustom', 'origin'] as const;

/**
 * A suggestion as the API returns it (KpiSuggestionDto, design 4.1 and 7.3): columns, qualityBand from the stored score,
 * the card fields of the payload as `suggestion` and the server-built `draft` (what accept creates).
 */
export function toSuggestionDto(row: KpiSuggestion): KpiSuggestionDto {
  const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? row.payload as Record<string, unknown> : {};
  const suggestion: Record<string, unknown> = { ...payload };
  for (const key of NON_CARD_KEYS) delete suggestion[key];
  const origin: SuggestionOrigin = payload.origin === 'appended_accountability' ? 'appended_accountability' : 'model';
  return {
    id: row.id,
    runId: row.runId,
    projectId: row.projectId,
    frameworkId: row.frameworkId,
    resultId: row.resultId,
    resultCode: typeof payload.resultCode === 'string' ? payload.resultCode : '',
    level: (row.level === 'activity' ? 'output' : row.level) as SuggestableLevel,
    sortOrder: row.sortOrder,
    status: row.status,
    qualityScore: row.qualityScore,
    qualityBand: qualityBand(row.qualityScore),
    warnings: asArray<KpiWarning>(row.warnings),
    libraryId: row.libraryId,
    isCustom: row.isCustom,
    origin,
    model: row.model,
    promptVersion: row.promptVersion,
    alternativeOfIndicatorId: row.alternativeOfIndicatorId,
    alternativeOfSuggestionId: row.alternativeOfSuggestionId,
    indicatorId: row.indicatorId,
    createdAt: row.createdAt.toISOString(),
    decidedAt: iso(row.decidedAt),
    decidedBy: row.decidedBy,
    rejectReason: row.rejectReason,
    rejectNote: row.rejectNote,
    suggestion: suggestion as KpiSuggestionDto['suggestion'],
    draft: payload.draft as KpiSuggestionDto['draft'],
  };
}
