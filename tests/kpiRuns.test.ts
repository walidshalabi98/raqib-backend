import type { KpiSuggestion, KpiSuggestionRun } from '@prisma/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/config/prisma';
import { AppError, appErrorBody } from '../src/middleware/errorHandler';
import { isKpiRunPoll, organisationKey, userKey } from '../src/middleware/rateLimit';
import { AiInvalidOutputError, AiOutputTruncatedError, AiRefusalError, AiRequestError } from '../src/services/ai/errors';
import { seedLibrary } from '../src/services/library/seed';
import { KpiContextError } from '../src/services/kpi/context';
import { emptyPipelineResult, KpiPipelineError, runKpiPipeline } from '../src/services/kpi/pipeline';
import {
  activeRunIds, callTotals, errorCodeFor, executeKpiRun, findConflictingRun, interruptActiveRuns, INTERRUPTED_RUN_MESSAGE,
  KPI_HEARTBEAT_MS, KPI_RUN_STALE_MS, markRunsInterrupted, markStaleRuns, persistenceWarnings, planPersistence, runFailure,
  startKpiRun, storedPayload, toRunDto, toSuggestionDto, waitForRun,
} from '../src/services/kpi/runs';
import type { KpiCallInfo, KpiPipelineDeps, KpiPipelineOptions, KpiPipelineResult, KpiScope, ProjectContext, ValidatedSuggestion } from '../src/services/kpi/types';
import {
  createKpiRunRow, createKpiSuggestionRow, createOrgFixture, hasTestDatabase, kpiValidatedSuggestionFixture, OrgFixture, resetDatabase,
} from './helpers';

/**
 * KPI suggestion runs (design sections 4.5 and 7.4, D3): conflicts under the advisory lock, the in-process executor with
 * its heartbeat, conditional writes, the persistence transaction, error codes and DTOs. runKpiPipeline is mocked by
 * tests/setup.ts; each test sets its answer.
 */

const pipelineMock = vi.mocked(runKpiPipeline);
const unusedDeps = () => ({}) as KpiPipelineDeps;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function pipelineResult(suggestions: ValidatedSuggestion[], extra: Partial<KpiPipelineResult> = {}): KpiPipelineResult {
  return { ...emptyPipelineResult(), suggestions, model: 'served-model-1', ...extra };
}

function call(extra: Partial<KpiCallInfo> = {}): KpiCallInfo {
  return {
    feature: 'kpi.suggest', tier: 'main', model: 'served-model-1', promptVersion: 'kpi-v1', resultCodes: ['O1'], outcome: 'success',
    inputTokens: 1000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0.02, latencyMs: 900, aiCallId: null,
    ...extra,
  };
}

type ResultRef = { id: string; code: string; level: 'impact' | 'outcome' | 'output' | 'activity' };

/** A validated suggestion for `result` with its own name (and optionally a library id). */
function suggestion(result: ResultRef, rank: number, name: string, extra: Partial<ValidatedSuggestion> = {}): ValidatedSuggestion {
  const base = kpiValidatedSuggestionFixture(result);
  return kpiValidatedSuggestionFixture(result, undefined, { rank, name, draft: { ...base.draft, indicatorText: name }, ...extra });
}

const runRow = (extra: Partial<KpiSuggestionRun> = {}): KpiSuggestionRun => ({
  id: 'run-1', projectId: 'p-1', frameworkId: 'f-1', scope: 'result', resultId: 'r-1', sourceIndicatorId: null, sourceSuggestionId: null,
  status: 'running', step: 'model', errorCode: null, error: null, frameworkWarnings: [], suggestionCount: 0, retrieval: null, model: null,
  promptVersion: null, modelCalls: 0, embeddingCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: null, latencyMs: null,
  requestedBy: 'u-1', createdAt: new Date('2026-10-13T08:00:00Z'), updatedAt: new Date('2026-10-13T08:00:10Z'), finishedAt: null,
  ...extra,
});

// ------------------------------------------------------------------ pure rules

describe('errorCodeFor (safe messages only)', () => {
  it('maps every AI error class and the context and pipeline errors to a run error code', () => {
    expect(errorCodeFor(new AiRefusalError('kpi.suggest', null))).toEqual({ errorCode: 'ai_refused', message: 'The AI model declined the request (kpi.suggest).' });
    expect(errorCodeFor(new AiRequestError('kpi.suggest', 401, false, 1)).errorCode).toBe('ai_not_configured');
    expect(errorCodeFor(new AiRequestError('kpi.suggest', 403, false, 1)).errorCode).toBe('ai_not_configured');
    expect(errorCodeFor(new AiRequestError('kpi.suggest', 529, true, 4)).errorCode).toBe('ai_unavailable');
    expect(errorCodeFor(new AiRequestError('kpi.suggest', null, true, 2)).errorCode).toBe('ai_unavailable');
    expect(errorCodeFor(new AiOutputTruncatedError('kpi.suggest', 6000)).errorCode).toBe('ai_invalid_output');
    expect(errorCodeFor(new AiInvalidOutputError('kpi.suggest', ['suggestions.0.unit: invalid'])).errorCode).toBe('ai_invalid_output');
    expect(errorCodeFor(new KpiPipelineError('ai_unavailable', 'kpi.suggest', 'The AI did not answer in time (kpi.suggest).')))
      .toEqual({ errorCode: 'ai_unavailable', message: 'The AI did not answer in time (kpi.suggest).' });
    expect(errorCodeFor(new KpiContextError('stale', 'A newer framework version exists.'))).toEqual({ errorCode: 'stale', message: 'A newer framework version exists.' });
    // Deleted between the request and the run: the framework changed, not a server fault (integration decision).
    expect(errorCodeFor(new KpiContextError('not_found', 'The result no longer exists.'))).toEqual({ errorCode: 'stale', message: 'The result no longer exists.' });
  });

  it('never repeats the message of any other error (it could echo stored values)', () => {
    const out = errorCodeFor(new Error('duplicate key (name)=(Gaza 0599 123 456)'));
    expect(out.errorCode).toBe('internal');
    expect(out.message).not.toContain('0599');
    expect(errorCodeFor('boom').errorCode).toBe('internal');
  });
});

describe('runFailure and toRunDto (design 7.4)', () => {
  const now = new Date('2026-10-13T08:30:00Z');

  it('reports a stored failure, an unknown stored code as internal, and nothing for live or completed runs', () => {
    expect(runFailure(runRow({ status: 'failed', errorCode: 'ai_refused', error: 'declined' }), now)).toEqual({ errorCode: 'ai_refused', message: 'declined' });
    expect(runFailure(runRow({ status: 'failed', errorCode: 'something_else', error: null }), now)?.errorCode).toBe('internal');
    expect(runFailure(runRow({ status: 'failed', errorCode: 'interrupted', error: null }), now)).toEqual({ errorCode: 'interrupted', message: INTERRUPTED_RUN_MESSAGE });
    expect(runFailure(runRow({ status: 'completed' }), now)).toBeNull();
    expect(runFailure(runRow({ updatedAt: new Date(now.getTime() - KPI_RUN_STALE_MS + 1000) }), now)).toBeNull();
  });

  it('reports a running run without a heartbeat for 15 minutes as failed / interrupted', () => {
    const stale = runRow({ updatedAt: new Date(now.getTime() - KPI_RUN_STALE_MS - 1) });
    expect(runFailure(stale, now)).toEqual({ errorCode: 'interrupted', message: INTERRUPTED_RUN_MESSAGE });
    expect(toRunDto(stale, now)).toMatchObject({ status: 'failed', errorCode: 'interrupted', message: INTERRUPTED_RUN_MESSAGE });
  });

  it('maps the columns of a run and hides cost and token columns', () => {
    const dto = toRunDto(runRow({
      status: 'completed', step: 'done', retrieval: 'keyword', model: 'm', promptVersion: 'kpi-v1', suggestionCount: 3,
      frameworkWarnings: [{ code: 'result_cap' }], finishedAt: new Date('2026-10-13T08:00:14Z'), inputTokens: 999,
    }), now);
    expect(dto).toEqual({
      id: 'run-1', projectId: 'p-1', frameworkId: 'f-1', scope: 'result', resultId: 'r-1', sourceIndicatorId: null, sourceSuggestionId: null,
      status: 'completed', step: 'done', errorCode: null, message: null, frameworkWarnings: [{ code: 'result_cap' }], suggestionCount: 3,
      retrieval: 'keyword', model: 'm', promptVersion: 'kpi-v1', createdAt: '2026-10-13T08:00:00.000Z', updatedAt: '2026-10-13T08:00:10.000Z',
      finishedAt: '2026-10-13T08:00:14.000Z',
    });
    expect(toRunDto(runRow({ frameworkWarnings: { not: 'an array' }, step: 'weird', retrieval: 'other' }), now))
      .toMatchObject({ frameworkWarnings: [], step: 'context', retrieval: null });
  });
});

describe('toSuggestionDto', () => {
  it('splits the stored payload into the card fields and the draft; the band comes from the stored score', () => {
    const v = kpiValidatedSuggestionFixture({ id: 'r-1', code: 'O1', level: 'outcome' });
    const row: KpiSuggestion = {
      id: 's-1', projectId: 'p-1', frameworkId: 'f-1', runId: 'run-1', resultId: 'r-1', level: 'outcome', sortOrder: 2,
      payload: storedPayload(v) as never, qualityScore: 75, warnings: v.warnings as never, libraryId: null, isCustom: true, method: 'observation',
      alternativeOfIndicatorId: null, alternativeOfSuggestionId: null, status: 'pending', model: 'm', promptVersion: 'kpi-v1',
      createdAt: new Date('2026-10-13T08:00:00Z'), decidedAt: null, decidedBy: null, rejectReason: null, rejectNote: null, indicatorId: null,
    };
    const dto = toSuggestionDto(row);
    expect(dto).toMatchObject({ id: 's-1', resultCode: 'O1', level: 'outcome', qualityScore: 75, qualityBand: 'review', origin: 'model', sortOrder: 2 });
    expect(dto.draft).toEqual(v.draft);
    expect(dto.suggestion.name).toBe(v.name);
    for (const key of ['draft', 'warnings', 'qualityScore', 'qualityBand', 'resultId', 'resultCode', 'level', 'libraryId', 'isCustom', 'origin']) {
      expect(dto.suggestion, key).not.toHaveProperty(key);
    }
    expect(storedPayload(v)).not.toHaveProperty('warnings');
    expect(storedPayload(v)).not.toHaveProperty('qualityScore');
    expect(storedPayload(v)).not.toHaveProperty('qualityBand');
    expect(toSuggestionDto({ ...row, payload: { ...storedPayload(v), origin: 'appended_accountability' } as never }).origin).toBe('appended_accountability');
  });
});

describe('planPersistence (design 4.5: dedupe, expiry, re-rank)', () => {
  const o1 = { id: 'r-o1', code: 'O1', level: 'outcome' as const };
  const o2 = { id: 'r-o2', code: 'O2', level: 'outcome' as const };
  const runCreatedAt = new Date('2026-10-13T08:00:00Z');
  const before = new Date('2026-10-12T08:00:00Z');
  const after = new Date('2026-10-13T08:00:05Z');
  const pendingRow = (id: string, resultId: string, name: string, extra: Record<string, unknown> = {}) => ({
    id, resultId, libraryId: null as string | null, payload: { name }, createdAt: before, alternativeOfIndicatorId: null as string | null,
    alternativeOfSuggestionId: null as string | null, ...extra,
  });

  it('expires older pending cards only on results that get new suggestions; alternatives cards never', () => {
    const plan = planPersistence({
      suggestions: [suggestion(o1, 1, 'Number of new things')],
      scopeType: 'framework', runCreatedAt, liveResultIds: new Set([o1.id, o2.id]), indicators: [],
      pending: [
        pendingRow('old-o1', o1.id, 'Old card on O1'),
        pendingRow('old-o2', o2.id, 'Old card on O2'),
        pendingRow('alt-o1', o1.id, 'Alternative on O1', { alternativeOfSuggestionId: 'x' }),
        pendingRow('newer-o1', o1.id, 'Card of an overlapping run', { createdAt: after }),
      ],
    });
    expect(plan.kept.map(s => s.name)).toEqual(['Number of new things']);
    expect(plan.expireIds).toEqual(['old-o1']);
  });

  it('alternatives runs expire nothing', () => {
    const plan = planPersistence({
      suggestions: [suggestion(o1, 1, 'Number of new things')], scopeType: 'alternatives', runCreatedAt, liveResultIds: new Set([o1.id]),
      indicators: [], pending: [pendingRow('old-o1', o1.id, 'Old card on O1')],
    });
    expect(plan.expireIds).toEqual([]);
    expect(plan.kept).toHaveLength(1);
  });

  it('drops suggestions that repeat an indicator or a card the run does not expire (library id or normalised name), and re-ranks', () => {
    const plan = planPersistence({
      suggestions: [
        suggestion(o1, 1, 'Water points functional', { libraryId: 'WA-03', isCustom: false }),
        suggestion(o1, 2, 'Number of NEW   things!'),
        suggestion(o1, 3, 'Hygiene kits distributed'),
        suggestion(o2, 1, 'Something else entirely'),
      ],
      scopeType: 'result', runCreatedAt, liveResultIds: new Set([o1.id, o2.id]),
      indicators: [{ resultId: o1.id, libraryId: 'wa-03', indicatorText: 'Functional water points' }],
      pending: [
        pendingRow('newer', o1.id, 'number of new things', { createdAt: after }),
        pendingRow('old', o2.id, 'Something else entirely'),
      ],
    });
    expect(plan.kept.map(s => [s.name, s.rank])).toEqual([['Hygiene kits distributed', 1], ['Something else entirely', 1]]);
    expect(plan.dropped).toEqual([
      { resultCode: 'O1', name: 'Water points functional', reason: 'duplicate' },
      { resultCode: 'O1', name: 'Number of NEW   things!', reason: 'duplicate' },
    ]);
    // The old card on O2 has the same name, but this run replaces it (it is expired, not compared).
    expect(plan.expireIds).toEqual(['old']);
  });

  it('drops suggestions whose result was deleted, and does not expire cards of results that got nothing new', () => {
    const plan = planPersistence({
      suggestions: [suggestion(o1, 1, 'Number of new things')], scopeType: 'result', runCreatedAt, liveResultIds: new Set(),
      indicators: [], pending: [pendingRow('old-o1', o1.id, 'Old card')],
    });
    expect(plan.kept).toEqual([]);
    expect(plan.dropped).toEqual([{ resultCode: 'O1', name: 'Number of new things', reason: 'result_deleted' }]);
    expect(plan.expireIds).toEqual([]);
  });

  it('turns duplicates dropped at save time into near_duplicate warnings with a clipped name', () => {
    const warnings = persistenceWarnings([
      { resultCode: 'O1', name: 'x'.repeat(80), reason: 'duplicate' },
      { resultCode: 'O1', name: 'gone', reason: 'result_deleted' },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: 'near_duplicate', severity: 'warning', penalty: 0 });
    expect(String(warnings[0].params.name)).toHaveLength(60);
  });
});

describe('small helpers', () => {
  it('AppError bodies: { message } as before, plus code and details only when set (design 7)', () => {
    expect(appErrorBody(new AppError(404, 'Project not found'))).toEqual({ message: 'Project not found' });
    expect(appErrorBody(new AppError(409, 'Busy', 'run_in_progress', { runId: 'r-1' }))).toEqual({ message: 'Busy', code: 'run_in_progress', details: { runId: 'r-1' } });
    expect(appErrorBody(new AppError(503, 'Not set up', 'ai_not_configured'))).toEqual({ message: 'Not set up', code: 'ai_not_configured' });
  });

  it('callTotals sums tokens and cost; an unknown cost makes the total unknown', () => {
    expect(callTotals([])).toEqual({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 });
    expect(callTotals([call(), call({ inputTokens: 500, outputTokens: 100, estimatedCostUsd: 0.005 })]))
      .toEqual({ inputTokens: 1500, outputTokens: 400, estimatedCostUsd: expect.closeTo(0.025, 10) });
    expect(callTotals([call(), call({ estimatedCostUsd: null })]).estimatedCostUsd).toBeNull();
  });

  it('waitForRun is true when the run settles in time, false otherwise', async () => {
    expect(await waitForRun(Promise.resolve(), 50)).toBe(true);
    expect(await waitForRun(new Promise<void>(() => undefined), 20)).toBe(false);
    expect(await waitForRun(Promise.reject(new Error('x')), 50)).toBe(true);
  });

  it('rate limits: run polls skip the per-IP limiter; KPI keys are per user and per organisation', () => {
    expect(isKpiRunPoll({ method: 'GET', originalUrl: '/api/kpi-suggestion-runs/abc' })).toBe(true);
    expect(isKpiRunPoll({ method: 'GET', originalUrl: '/api/kpi-suggestion-runs/abc?x=1' })).toBe(true);
    expect(isKpiRunPoll({ method: 'POST', originalUrl: '/api/kpi-suggestion-runs/abc' })).toBe(false);
    expect(isKpiRunPoll({ method: 'GET', originalUrl: '/api/kpi-suggestion-runs/abc/other' })).toBe(false);
    expect(isKpiRunPoll({ method: 'GET', originalUrl: '/api/projects/p/kpi-suggestions' })).toBe(false);
    const req = { user: { id: 'u-1', organizationId: 'o-1' }, ip: '10.0.0.1' } as never;
    expect(userKey(req)).toBe('u-1');
    expect(organisationKey(req)).toBe('org:o-1');
    const anonymous = { ip: '10.0.0.1' } as never;
    expect(userKey(anonymous)).toBe(organisationKey(anonymous));
  });
});

// ------------------------------------------------------------------ database

describe.skipIf(!hasTestDatabase)('KPI runs on the database', () => {
  let fx: OrgFixture;
  const deps = (now: () => Date = () => new Date()) => ({ db: prisma, pipeline: unusedDeps, now });
  const resultScope = (): KpiScope => ({ type: 'result', resultId: fx.result.id });
  const start = (scope: KpiScope, now?: () => Date) => startKpiRun(
    { projectId: fx.project.id, organizationId: fx.org.id, frameworkId: fx.framework.id, scope, requestedBy: fx.officer.id }, deps(now),
  );
  const runOf = (id: string) => prisma.kpiSuggestionRun.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    await resetDatabase();
    await seedLibrary(prisma, { logger: { warn: () => undefined } });
  });

  let label = 0;
  beforeEach(async () => {
    label += 1;
    fx = await createOrgFixture(`run${label}`);
    pipelineMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('findConflictingRun (design 7.2 step 8)', () => {
    const conflict = (scope: KpiScope, resultId: string | null) => findConflictingRun(prisma, { projectId: fx.project.id, frameworkId: fx.framework.id, scope, resultId }, new Date());
    const running = (data: Parameters<typeof createKpiRunRow>[0]['data'] & object, resultId: string | null) => createKpiRunRow({
      projectId: fx.project.id, frameworkId: fx.framework.id, resultId, data: { status: 'running', step: 'model', finishedAt: null, ...data },
    });

    it('a running framework run blocks every new run; a running result run blocks a framework run and the same result only', async () => {
      const other = await prisma.resultNode.create({ data: { frameworkId: fx.framework.id, level: 'output', code: 'O1.1', text: 'Output', parentId: fx.result.id } });
      expect(await conflict({ type: 'framework' }, null)).toBeNull();

      const resultRun = await running({ scope: 'result' }, fx.result.id);
      expect((await conflict({ type: 'framework' }, null))?.id).toBe(resultRun.id);
      expect((await conflict(resultScope(), fx.result.id))?.id).toBe(resultRun.id);
      expect((await conflict({ type: 'alternatives', indicatorId: fx.indicator.id, suggestionId: null }, fx.result.id))?.id).toBe(resultRun.id);
      expect(await conflict({ type: 'result', resultId: other.id }, other.id)).toBeNull();

      await prisma.kpiSuggestionRun.update({ where: { id: resultRun.id }, data: { status: 'completed' } });
      const frameworkRun = await running({ scope: 'framework' }, null);
      expect((await conflict({ type: 'result', resultId: other.id }, other.id))?.id).toBe(frameworkRun.id);
      expect((await conflict({ type: 'framework' }, null))?.id).toBe(frameworkRun.id);
    });

    it('ignores stale runs (no heartbeat for 15 minutes) and runs of another framework version', async () => {
      await running({ scope: 'framework', updatedAt: new Date(Date.now() - KPI_RUN_STALE_MS - 60_000) }, null);
      expect(await conflict({ type: 'framework' }, null)).toBeNull();
      const v2 = await prisma.framework.create({ data: { projectId: fx.project.id, version: 2 } });
      await createKpiRunRow({ projectId: fx.project.id, frameworkId: v2.id, data: { status: 'running', finishedAt: null } });
      expect(await conflict({ type: 'framework' }, null)).toBeNull();
    });
  });

  it('two simultaneous starts: one run is created, the other answers 409 run_in_progress with its id (advisory lock)', async () => {
    const gate = deferred<KpiPipelineResult>();
    pipelineMock.mockImplementation(() => gate.promise);
    const results = await Promise.allSettled([start({ type: 'framework' }), start({ type: 'framework' })]);
    const created = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof start>>> => r.status === 'fulfilled');
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(AppError);
    expect(refused[0].reason).toMatchObject({ statusCode: 409, code: 'run_in_progress', details: { runId: created[0].value.run.id } });
    expect(await prisma.kpiSuggestionRun.count({ where: { projectId: fx.project.id, status: 'running' } })).toBe(1);
    gate.resolve(pipelineResult([]));
    await created[0].value.done;
    expect(await runOf(created[0].value.run.id)).toMatchObject({ status: 'completed', step: 'done', suggestionCount: 0 });
  });

  it('result scope: persists ranked pending suggestions with the run totals and expires the result\'s older pending cards', async () => {
    const seen: { ctx?: ProjectContext; opts?: KpiPipelineOptions } = {};
    pipelineMock.mockImplementationOnce(async (ctx, _deps, opts) => {
      seen.ctx = ctx;
      seen.opts = opts;
      await opts?.onStep?.('retrieval');
      await opts?.onStep?.('model');
      await opts?.onProgress?.({ batchesDone: 1, batchesTotal: 1 });
      await opts?.onStep?.('validation');
      return pipelineResult(
        [suggestion(fx.result, 1, 'Number of schools with a functioning parents committee'), suggestion(fx.result, 2, 'Number of teachers trained in inclusive education')],
        {
          retrieval: 'keyword', embeddingCalls: 0, calls: [call(), call({ estimatedCostUsd: 0.01, inputTokens: 200, outputTokens: 50 })],
          frameworkWarnings: [{ code: 'keyword_fallback', severity: 'info', message: 'm', params: {}, penalty: 0 }],
        },
      );
    });
    const { run, done } = await start(resultScope());
    expect(run).toMatchObject({ status: 'running', scope: 'result', resultId: fx.result.id, step: 'context', requestedBy: fx.officer.id });
    expect(activeRunIds()).toContain(run.id);
    await done;
    expect(activeRunIds()).not.toContain(run.id);

    expect(seen.ctx?.scope).toEqual(resultScope());
    expect(seen.opts?.callContext).toEqual({ organizationId: fx.org.id, projectId: fx.project.id });
    const stored = await runOf(run.id);
    expect(stored).toMatchObject({
      status: 'completed', step: 'done', suggestionCount: 2, retrieval: 'keyword', model: 'served-model-1', promptVersion: 'kpi-v1',
      modelCalls: 2, embeddingCalls: 0, inputTokens: 1200, outputTokens: 350, errorCode: null,
    });
    expect(Number(stored.estimatedCostUsd)).toBeCloseTo(0.03, 6);
    expect(stored.latencyMs).toBeGreaterThanOrEqual(0);
    expect(stored.finishedAt).not.toBeNull();
    expect(stored.frameworkWarnings).toEqual([{ code: 'keyword_fallback', severity: 'info', message: 'm', params: {}, penalty: 0 }]);

    const rows = await prisma.kpiSuggestion.findMany({ where: { runId: run.id }, orderBy: { sortOrder: 'asc' } });
    expect(rows.map(r => [r.sortOrder, r.status, r.model, r.promptVersion, r.level, r.method, r.isCustom])).toEqual([
      [1, 'pending', 'served-model-1', 'kpi-v1', 'outcome', 'observation', true],
      [2, 'pending', 'served-model-1', 'kpi-v1', 'outcome', 'observation', true],
    ]);
    expect(rows[0].payload).not.toHaveProperty('warnings');
    expect(rows[0].payload).toMatchObject({ name: 'Number of schools with a functioning parents committee', rank: 1, resultCode: 'O1' });
    expect(rows[0].warnings).toEqual(kpiValidatedSuggestionFixture(fx.result).warnings);
    expect(rows[0].qualityScore).toBe(100);
    // The fixture's older pending card on O1 is replaced.
    expect((await prisma.kpiSuggestion.findUniqueOrThrow({ where: { id: fx.kpiSuggestion.id } })).status).toBe('expired');
  });

  it('framework scope: results the run skipped keep their cards; alternatives cards are never expired; model "unknown" without a served model', async () => {
    const o2 = await prisma.resultNode.create({ data: { frameworkId: fx.framework.id, level: 'outcome', code: 'O2', text: 'Outcome two' } });
    const otherRun = await createKpiRunRow({ projectId: fx.project.id, frameworkId: fx.framework.id, resultId: o2.id });
    const o2Card = await createKpiSuggestionRow({ run: otherRun, suggestion: suggestion(o2, 1, 'Card on O2') });
    const alternative = await createKpiSuggestionRow({
      run: otherRun, suggestion: suggestion(fx.result, 1, 'Alternative card on O1'), data: { alternativeOfIndicatorId: fx.indicator.id },
    });
    pipelineMock.mockResolvedValueOnce(pipelineResult([suggestion(fx.result, 1, 'Fresh card on O1')], { model: null }));
    const { run, done } = await start({ type: 'framework' });
    await done;
    const statuses = Object.fromEntries((await prisma.kpiSuggestion.findMany({ where: { projectId: fx.project.id } })).map(s => [s.id, s.status]));
    expect(statuses[fx.kpiSuggestion.id]).toBe('expired');
    expect(statuses[o2Card.id]).toBe('pending');
    expect(statuses[alternative.id]).toBe('pending');
    const created = await prisma.kpiSuggestion.findFirstOrThrow({ where: { runId: run.id } });
    expect(created).toMatchObject({ model: 'unknown', alternativeOfIndicatorId: null, alternativeOfSuggestionId: null });
    expect(await runOf(run.id)).toMatchObject({ status: 'completed', scope: 'framework', resultId: null, suggestionCount: 1 });
  });

  it('alternatives scope: stores the source on the run and on each suggestion, and expires nothing', async () => {
    pipelineMock.mockResolvedValueOnce(pipelineResult([suggestion(fx.result, 1, 'Alternative one'), suggestion(fx.result, 2, 'Alternative two')]));
    const { run, done } = await start({ type: 'alternatives', indicatorId: null, suggestionId: fx.kpiSuggestion.id });
    expect(run).toMatchObject({ scope: 'alternatives', resultId: fx.result.id, sourceSuggestionId: fx.kpiSuggestion.id, sourceIndicatorId: null });
    await done;
    const rows = await prisma.kpiSuggestion.findMany({ where: { runId: run.id } });
    expect(rows.map(r => r.alternativeOfSuggestionId)).toEqual([fx.kpiSuggestion.id, fx.kpiSuggestion.id]);
    expect((await prisma.kpiSuggestion.findUniqueOrThrow({ where: { id: fx.kpiSuggestion.id } })).status).toBe('pending');
  });

  it('drops a suggestion that repeats an indicator (library id) or a card created meanwhile, with a near_duplicate warning', async () => {
    await prisma.indicator.update({ where: { id: fx.indicator.id }, data: { libraryId: 'ED-01' } });
    pipelineMock.mockImplementationOnce(async () => {
      // An overlapping run saved a card with the same name after this run started.
      const overlapping = await createKpiRunRow({ projectId: fx.project.id, frameworkId: fx.framework.id, resultId: fx.result.id });
      await createKpiSuggestionRow({ run: overlapping, suggestion: suggestion(fx.result, 1, 'Number of learners enrolled') });
      return pipelineResult([
        suggestion(fx.result, 1, 'Library repeat', { libraryId: 'ED-01', isCustom: false }),
        suggestion(fx.result, 2, 'Number of learners enrolled'),
        suggestion(fx.result, 3, 'Number of classrooms rehabilitated'),
      ]);
    });
    const { run, done } = await start(resultScope());
    await done;
    const rows = await prisma.kpiSuggestion.findMany({ where: { runId: run.id } });
    expect(rows.map(r => [(r.payload as { name: string }).name, r.sortOrder])).toEqual([['Number of classrooms rehabilitated', 1]]);
    const stored = await runOf(run.id);
    expect(stored.suggestionCount).toBe(1);
    expect((stored.frameworkWarnings as Array<{ code: string; params: { name: string } }>).map(w => [w.code, w.params.name])).toEqual([
      ['near_duplicate', 'Library repeat'], ['near_duplicate', 'Number of learners enrolled'],
    ]);
  });

  it('a newer framework version created during the run → failed with errorCode stale and nothing saved', async () => {
    pipelineMock.mockImplementationOnce(async () => {
      await prisma.framework.create({ data: { projectId: fx.project.id, version: 2 } });
      return pipelineResult([suggestion(fx.result, 1, 'Would be stale')]);
    });
    const { run, done } = await start(resultScope());
    await done;
    expect(await runOf(run.id)).toMatchObject({ status: 'failed', errorCode: 'stale', suggestionCount: 0 });
    expect(await prisma.kpiSuggestion.count({ where: { runId: run.id } })).toBe(0);
    expect((await prisma.kpiSuggestion.findUniqueOrThrow({ where: { id: fx.kpiSuggestion.id } })).status).toBe('pending');
  });

  it('a result deleted during a framework run: its suggestions are dropped, the others saved', async () => {
    const o2 = await prisma.resultNode.create({ data: { frameworkId: fx.framework.id, level: 'outcome', code: 'O2', text: 'Outcome two' } });
    pipelineMock.mockImplementationOnce(async () => {
      await prisma.resultNode.delete({ where: { id: o2.id } });
      return pipelineResult([suggestion(fx.result, 1, 'Kept card'), suggestion(o2, 1, 'Card of a deleted result')]);
    });
    const { run, done } = await start({ type: 'framework' });
    await done;
    const rows = await prisma.kpiSuggestion.findMany({ where: { runId: run.id } });
    expect(rows.map(r => (r.payload as { name: string }).name)).toEqual(['Kept card']);
  });

  it.each([
    ['ai_refused', new AiRefusalError('kpi.suggest', null), 'The AI model declined the request (kpi.suggest).'],
    ['ai_unavailable', new KpiPipelineError('ai_unavailable', 'kpi.suggest', 'The AI did not answer in time (kpi.suggest).'), 'The AI did not answer in time (kpi.suggest).'],
    ['ai_not_configured', new AiRequestError('kpi.suggest', 401, false, 1), 'The AI request failed (kpi.suggest, HTTP 401).'],
  ] as const)('a pipeline failure is stored as %s with its safe message', async (code, err, message) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    pipelineMock.mockRejectedValueOnce(err);
    const { run, done } = await start(resultScope());
    await done;
    expect(await runOf(run.id)).toMatchObject({ status: 'failed', errorCode: code, error: message, suggestionCount: 0 });
    expect(errors.mock.calls.flat().join('\n')).toContain(`[KpiRun] ${run.id} failed (${code})`);
    errors.mockRestore();
  });

  it('an unexpected error is stored as internal without its message', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    pipelineMock.mockRejectedValueOnce(new Error('value (name)=(Gaza 0599 123 456)'));
    const { run, done } = await start(resultScope());
    await done;
    const stored = await runOf(run.id);
    expect(stored).toMatchObject({ status: 'failed', errorCode: 'internal' });
    expect(stored.error).not.toContain('0599');
    expect(errors.mock.calls.flat().join('\n')).not.toContain('0599');
    errors.mockRestore();
  });

  it('SIGTERM: interruptActiveRuns marks this process\'s running runs interrupted; the late executor never flips them back', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gate = deferred<KpiPipelineResult>();
    pipelineMock.mockImplementationOnce(async (_ctx, _deps, opts) => {
      await opts?.onStep?.('model');
      return gate.promise;
    });
    const { run, done } = await start(resultScope());
    await vi.waitFor(async () => expect((await runOf(run.id)).step).toBe('model'));
    expect(activeRunIds()).toEqual([run.id]);

    expect(await interruptActiveRuns(prisma)).toBe(1);
    expect(await runOf(run.id)).toMatchObject({ status: 'failed', errorCode: 'interrupted', error: INTERRUPTED_RUN_MESSAGE });
    gate.resolve(pipelineResult([suggestion(fx.result, 1, 'Late card')]));
    await done;
    expect(await runOf(run.id)).toMatchObject({ status: 'failed', errorCode: 'interrupted', suggestionCount: 0 });
    expect(await prisma.kpiSuggestion.count({ where: { runId: run.id } })).toBe(0);
    expect(warn.mock.calls.flat().join('\n')).toContain(`[KpiRun] ${run.id} no longer running; results discarded`);
    expect(activeRunIds()).toEqual([]);
    expect(await markRunsInterrupted(prisma, [])).toBe(0);
    warn.mockRestore();
  });

  it('a step write on a run marked interrupted stops the pipeline (no further model calls)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let reachedModel = false;
    pipelineMock.mockImplementationOnce(async (_ctx, _deps, opts) => {
      await prisma.kpiSuggestionRun.updateMany({ where: { projectId: fx.project.id, status: 'running' }, data: { status: 'failed', errorCode: 'interrupted' } });
      await opts?.onStep?.('model');
      reachedModel = true;
      return pipelineResult([]);
    });
    const { run, done } = await start(resultScope());
    await done;
    expect(reachedModel).toBe(false);
    expect(await runOf(run.id)).toMatchObject({ status: 'failed', errorCode: 'interrupted' });
    warn.mockRestore();
  });

  it('the heartbeat timer keeps a slow run fresh however long one model call takes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let clock = new Date();
    const gate = deferred<KpiPipelineResult>();
    pipelineMock.mockImplementationOnce(async (_ctx, _deps, opts) => {
      await opts?.onStep?.('model');
      return gate.promise;
    });
    const { run, done } = await start(resultScope(), () => clock);
    await vi.waitFor(async () => expect((await runOf(run.id)).step).toBe('model'));

    // 20 minutes in one model call: without the timer the run would look interrupted.
    clock = new Date(clock.getTime() + 20 * 60_000);
    expect(toRunDto(await runOf(run.id), clock).status).toBe('failed');
    vi.advanceTimersByTime(KPI_HEARTBEAT_MS);
    await vi.waitFor(async () => expect((await runOf(run.id)).updatedAt.getTime()).toBe(clock.getTime()));
    expect(toRunDto(await runOf(run.id), clock)).toMatchObject({ status: 'running', errorCode: null });
    expect(await markStaleRuns(prisma, fx.project.id, clock)).toBe(0);

    gate.resolve(pipelineResult([]));
    await done;
    expect((await runOf(run.id)).status).toBe('completed');
  });

  it('markStaleRuns stores failed / interrupted on this project\'s runs without a heartbeat only', async () => {
    const old = new Date(Date.now() - KPI_RUN_STALE_MS - 60_000);
    const stale = await createKpiRunRow({ projectId: fx.project.id, frameworkId: fx.framework.id, data: { status: 'running', finishedAt: null, updatedAt: old } });
    const fresh = await createKpiRunRow({ projectId: fx.project.id, frameworkId: fx.framework.id, resultId: fx.result.id, data: { status: 'running', finishedAt: null } });
    const other = await createOrgFixture(`other${label}`);
    const otherStale = await createKpiRunRow({ projectId: other.project.id, frameworkId: other.framework.id, data: { status: 'running', finishedAt: null, updatedAt: old } });

    expect(await markStaleRuns(prisma, fx.project.id, new Date())).toBe(1);
    expect(await runOf(stale.id)).toMatchObject({ status: 'failed', errorCode: 'interrupted', error: INTERRUPTED_RUN_MESSAGE });
    expect((await runOf(fresh.id)).status).toBe('running');
    expect((await runOf(otherStale.id)).status).toBe('running');
  });

  it('executeKpiRun leaves a run that is no longer running alone', async () => {
    const finished = await createKpiRunRow({ projectId: fx.project.id, frameworkId: fx.framework.id, resultId: fx.result.id });
    await executeKpiRun(finished.id, deps());
    expect(pipelineMock).not.toHaveBeenCalled();
    expect(await runOf(finished.id)).toMatchObject({ status: 'completed', updatedAt: finished.updatedAt });
  });
});
