import request from 'supertest';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Configured AI by default (the test key is a placeholder); one test switches it off to see the real 503.
const status = vi.hoisted(() => ({ configured: true }));
vi.mock('../src/services/kpi/availability', async importOriginal => {
  const original = await importOriginal<typeof import('../src/services/kpi/availability')>();
  return {
    ...original,
    kpiAssistantStatus: vi.fn(() => (status.configured ? { ...original.kpiAssistantStatus(), aiConfigured: true } : original.kpiAssistantStatus())),
  };
});
// A short synchronous wait, so the 202 path of result scope is quick to reach (design 11.2).
vi.mock('../src/services/kpi/runs', async importOriginal => ({ ...(await importOriginal<typeof import('../src/services/kpi/runs')>()), KPI_SYNC_WAIT_MS: 1500 }));
// The current-framework lookup stays real; one accept test creates a version between the two staleness checks.
vi.mock('../src/services/frameworks/current', async importOriginal => {
  const original = await importOriginal<typeof import('../src/services/frameworks/current')>();
  return { ...original, findCurrentFramework: vi.fn(original.findCurrentFramework) };
});

import app from '../src/app';
import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { findCurrentFramework } from '../src/services/frameworks/current';
import { seedLibrary } from '../src/services/library/seed';
import { parseAcceptBody, repeatsIndicator, siblingGroup } from '../src/services/kpi/accept';
import { emptyPipelineResult, runKpiPipeline } from '../src/services/kpi/pipeline';
import { parseRejectBody } from '../src/services/kpi/reject';
import { nothingToSuggestReason, organisationSpendUsd, parseKpiRequestBody, sortSuggestionRows } from '../src/services/kpi/requests';
import { KPI_RUN_STALE_MS } from '../src/services/kpi/runs';
import { scopedResults } from '../src/services/kpi/scope';
import type { KpiPipelineResult, ProjectContext, ValidatedSuggestion } from '../src/services/kpi/types';
import { parseSuggestionListQuery } from '../src/routes/kpiSuggestions';
import {
  createKpiRunRow, createKpiSuggestionRow, createOrgFixture, hasTestDatabase, kpiValidatedSuggestionFixture, OrgFixture, resetDatabase,
} from './helpers';

/**
 * KPI Assistant routes (knowledge/kpi-assistant-spec.md §A1, §A6; design sections 7 and 8): request checks in their
 * order, 200/202 paths, listing and polling, accept (mapping, edits, staleness, duplicates, sibling expiry, donor cap)
 * and reject. runKpiPipeline is mocked (tests/setup.ts); the run executor, context builder and persistence are real.
 */

const pipelineMock = vi.mocked(runKpiPipeline);
const currentMock = vi.mocked(findCurrentFramework);

type ResultRef = { id: string; code: string; level: 'impact' | 'outcome' | 'output' | 'activity' };

function suggestion(result: ResultRef, rank: number, name: string, extra: Partial<ValidatedSuggestion> = {}): ValidatedSuggestion {
  const base = kpiValidatedSuggestionFixture(result);
  return kpiValidatedSuggestionFixture(result, undefined, { rank, name, draft: { ...base.draft, indicatorText: name, ...extra.draft }, ...extra });
}

/** The pipeline answer for a context: `perResult` named suggestions for every scoped result. */
function answerFor(ctx: ProjectContext, perResult = 2): KpiPipelineResult {
  const suggestions = scopedResults(ctx).flatMap(r => Array.from({ length: perResult }, (_, i) => suggestion(r, i + 1, `Number of ${r.code} things ${i + 1}`)));
  return { ...emptyPipelineResult(), suggestions, model: 'served-model-1', calls: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

// ------------------------------------------------------------------ pure parsing

describe('request parsing (design 7.3)', () => {
  it('parses the four body shapes, strips unknown keys and needs exactly one id for alternatives', () => {
    expect(parseKpiRequestBody({ scope: 'framework', extra: 1 })).toEqual({ scope: 'framework' });
    expect(parseKpiRequestBody({ scope: 'result', resultId: ' r-1 ' })).toEqual({ scope: 'result', resultId: 'r-1' });
    expect(parseKpiRequestBody({ scope: 'alternatives', indicatorId: 'i-1' })).toEqual({ scope: 'alternatives', indicatorId: 'i-1' });
    expect(parseKpiRequestBody({ scope: 'alternatives', suggestionId: 's-1' })).toEqual({ scope: 'alternatives', suggestionId: 's-1' });
    for (const [body, message] of [
      [undefined, /JSON object/],
      [[], /JSON object/],
      [{}, /scope must be one of/],
      [{ scope: 'everything' }, /scope must be one of/],
      [{ scope: 'result' }, /resultId/],
      [{ scope: 'result', resultId: '  ' }, /resultId is required/],
      [{ scope: 'result', resultId: 42 }, /resultId/],
      [{ scope: 'alternatives' }, /exactly one of indicatorId or suggestionId/],
      [{ scope: 'alternatives', indicatorId: 'i', suggestionId: 's' }, /exactly one/],
    ] as const) {
      expect(() => parseKpiRequestBody(body), JSON.stringify(body)).toThrow(message);
    }
  });

  it('accept body: no body or no edits means none; anything but an object is refused', () => {
    expect(parseAcceptBody(undefined)).toEqual({ edits: {}, replaceSource: false });
    expect(parseAcceptBody({})).toEqual({ edits: {}, replaceSource: false });
    expect(parseAcceptBody({ edits: null })).toEqual({ edits: {}, replaceSource: false });
    expect(parseAcceptBody({ edits: { indicatorText: 'x' }, other: 1 })).toEqual({ edits: { indicatorText: 'x' }, replaceSource: false });
    expect(parseAcceptBody({ replaceSource: true })).toEqual({ edits: {}, replaceSource: true });
    expect(() => parseAcceptBody('x')).toThrow(/JSON object/);
    expect(() => parseAcceptBody({ edits: ['x'] })).toThrow(/edits must be an object/);
    expect(() => parseAcceptBody({ edits: 'x' })).toThrow(/edits must be an object/);
    expect(() => parseAcceptBody({ replaceSource: 'yes' })).toThrow(/replaceSource must be true or false/);
    // TQ-02: keys outside DRAFT_EDITABLE_KEYS are refused with their names.
    for (const key of ['status', 'currentValue', 'actualStartDate', 'actualEndDate', 'milestones', 'bad key']) {
      expect(() => parseAcceptBody({ edits: { indicatorText: 'x', [key]: 'y' } }), key).toThrow(expect.objectContaining({ statusCode: 400, code: 'not_editable', details: { keys: [key] } }));
    }
    // The server-set fields stay ignored (design 8.1).
    expect(parseAcceptBody({ edits: { provenance: 'manual', aiModel: 'x', promptVersion: 'y', phases: [], sortOrder: 2 } }).edits).toMatchObject({ provenance: 'manual' });
  });

  it('reject body: a known reason; the note is trimmed, at most 1000 characters, empty → null and redacted', () => {
    expect(parseRejectBody({ reason: 'wording' })).toEqual({ reason: 'wording', note: null });
    expect(parseRejectBody({ reason: 'other', note: '   ' })).toEqual({ reason: 'other', note: null });
    const redacted = parseRejectBody({ reason: 'other', note: ' Call the officer on 0599 123 456 about it ' });
    expect(redacted.note).not.toContain('0599');
    expect(redacted.note).toMatch(/^Call the officer on .+ about it$/);
    expect(parseRejectBody({ reason: 'other', note: 'x'.repeat(1000) }).note).toHaveLength(1000);
    expect(() => parseRejectBody({ reason: 'other', note: 'x'.repeat(1001) })).toThrow(/at most 1000/);
    expect(() => parseRejectBody({ reason: 'bad' })).toThrow(/reason must be one of/);
    expect(() => parseRejectBody({})).toThrow(/reason must be one of/);
    expect(() => parseRejectBody({ reason: 'other', note: 5 })).toThrow(/note must be text/);
    expect(() => parseRejectBody(undefined)).toThrow(/JSON object/);
  });

  it('list query: status pending by default, "all" or a status; anything else is refused', () => {
    expect(parseSuggestionListQuery({})).toEqual({ status: 'pending' });
    expect(parseSuggestionListQuery({ status: 'all', resultId: 'r', runId: 'x', frameworkId: 'f' })).toEqual({ status: 'all', resultId: 'r', runId: 'x', frameworkId: 'f' });
    expect(() => parseSuggestionListQuery({ status: 'maybe' })).toThrow(/status must be one of/);
  });
});

describe('accept helpers (design 8.1, m13)', () => {
  it('repeatsIndicator: same library id (any case) or same normalised name', () => {
    const onResult = [{ libraryId: 'WA-02', indicatorText: 'Number of hygiene kits distributed' }];
    expect(repeatsIndicator(onResult, { libraryId: 'wa-02', indicatorText: 'Other' })).toBe(true);
    expect(repeatsIndicator(onResult, { libraryId: null, indicatorText: ' number of HYGIENE kits, distributed ' })).toBe(true);
    expect(repeatsIndicator(onResult, { libraryId: 'WA-03', indicatorText: 'Number of water points' })).toBe(false);
    expect(repeatsIndicator([], { libraryId: 'WA-02', indicatorText: 'x' })).toBe(false);
  });

  it('siblingGroup: same result with the same library id or name, the source and its alternatives, or this row\'s alternatives', () => {
    const base = { libraryId: null, name: 'Unrelated', alternativeOfSuggestionId: null, alternativeOfIndicatorId: null };
    const pending = [
      { ...base, id: 'same-lib', resultId: 'r1', libraryId: 'WA-02' },
      { ...base, id: 'same-name', resultId: 'r1', name: 'Number of kits!' },
      { ...base, id: 'other-result', resultId: 'r2', libraryId: 'WA-02' },
      { ...base, id: 'source', resultId: 'r1' },
      { ...base, id: 'sibling-alt', resultId: 'r1', alternativeOfSuggestionId: 'source' },
      { ...base, id: 'my-alt', resultId: 'r3', alternativeOfSuggestionId: 'me' },
      { ...base, id: 'ind-alt', resultId: 'r1', alternativeOfIndicatorId: 'ind-9' },
      { ...base, id: 'me', resultId: 'r1', libraryId: 'WA-02' },
    ];
    const accepted = { id: 'me', resultIds: ['r1'], libraryId: 'wa-02', names: ['number of kits'], alternativeOfSuggestionId: 'source', alternativeOfIndicatorId: null };
    expect(siblingGroup(accepted, pending)).toEqual(['same-lib', 'same-name', 'source', 'sibling-alt', 'my-alt']);
    expect(siblingGroup({ ...accepted, alternativeOfSuggestionId: null, alternativeOfIndicatorId: 'ind-9', libraryId: null, names: [] }, pending))
      .toEqual(['my-alt', 'ind-alt']);
  });
});

describe('sortSuggestionRows', () => {
  it('orders by results-chain position, then oldest first, then rank; rows of a deleted result last', () => {
    const at = (s: number) => new Date(Date.UTC(2026, 9, 13, 8, 0, s));
    const rows = [
      { id: 'c', resultId: 'o2', createdAt: at(1), sortOrder: 1 },
      { id: 'd', resultId: null, createdAt: at(0), sortOrder: 1 },
      { id: 'b', resultId: 'o1', createdAt: at(1), sortOrder: 2 },
      { id: 'a', resultId: 'o1', createdAt: at(1), sortOrder: 1 },
      { id: 'e', resultId: 'o1', createdAt: at(0), sortOrder: 3 },
    ];
    const order = new Map([['o1', 0], ['o2', 1]]);
    expect(sortSuggestionRows(rows, order).map(r => r.id)).toEqual(['e', 'a', 'b', 'c', 'd']);
    expect(rows.map(r => r.id)).toEqual(['c', 'd', 'b', 'a', 'e']);
  });
});

describe('nothingToSuggestReason (design 7.1)', () => {
  const ctx = (extra: Partial<ProjectContext>): ProjectContext => ({
    project: {
      id: 'p', name: 'P', sectors: ['education'], donor: 'D', donorType: 'echo', startDate: '2026-01-01', endDate: '2027-12-31',
      geographicScope: null, targetBeneficiaries: null, humanitarian: false, description: null,
    },
    resultsChain: [{ id: 'o1', code: 'O1', level: 'outcome', text: 'Outcome', textAr: null, parentId: null }],
    scope: { type: 'framework' }, existingIndicators: [], pendingSuggestions: [], documentFacts: [], documentTexts: [],
    orgPreferences: { rejectedLibraryIds: [], preferredMethods: [] },
    donorRules: { donorType: 'echo', maxIndicatorsPerResult: 3, requiredFrameworks: [], libraryFrameworks: [], notes: [] },
    alternativesFor: null,
    ...extra,
  });
  const indicators = (n: number) => Array.from({ length: n }, (_, i) => ({
    id: `i${i}`, resultId: 'o1', name: `Indicator ${i}`, nameAr: null, level: 'outcome' as const, unit: null, libraryId: null, method: 'hh_survey' as const,
  }));

  it('no results, the level maximum or the donor cap', () => {
    expect(nothingToSuggestReason(ctx({ resultsChain: [] }))).toBe('no_results');
    expect(nothingToSuggestReason(ctx({ existingIndicators: indicators(4) }))).toBe('level_cap');
    expect(nothingToSuggestReason(ctx({ scope: { type: 'result', resultId: 'o1' }, existingIndicators: indicators(3) }))).toBe('donor_cap');
    const noCap = ctx({ existingIndicators: indicators(4) });
    expect(nothingToSuggestReason({ ...noCap, donorRules: { ...noCap.donorRules, maxIndicatorsPerResult: null } })).toBe('level_cap');
  });
});

// ------------------------------------------------------------------ routes

describe.skipIf(!hasTestDatabase)('KPI Assistant routes', () => {
  let fx: OrgFixture;
  let label = 0;
  const post = (path: string, body?: object, auth?: string) => request(app).post(path).set('Authorization', auth ?? fx.officerAuth).send(body);
  const get = (path: string, auth?: string) => request(app).get(path).set('Authorization', auth ?? fx.officerAuth);
  const suggestPath = () => `/api/projects/${fx.project.id}/kpi-suggestions`;
  const runCount = () => prisma.kpiSuggestionRun.count({ where: { projectId: fx.project.id } });

  /** Polls GET /api/kpi-suggestion-runs/:id until the run has finished. */
  async function pollUntilDone(runId: string) {
    let body: any;
    await vi.waitFor(async () => {
      const res = await get(`/api/kpi-suggestion-runs/${runId}`);
      expect(res.status).toBe(200);
      body = res.body;
      expect(body.run.status).not.toBe('running');
    }, { timeout: 10_000, interval: 50 });
    return body;
  }

  beforeAll(async () => {
    await resetDatabase();
    await seedLibrary(prisma, { logger: { warn: () => undefined } });
  });

  beforeEach(async () => {
    label += 1;
    fx = await createOrgFixture(`route${label}`);
    status.configured = true;
    pipelineMock.mockReset();
    currentMock.mockClear();
  });

  describe('POST /api/projects/:id/kpi-suggestions', () => {
    it('503 ai_not_configured when the key is a placeholder, before any run row exists', async () => {
      status.configured = false;
      const res = await post(suggestPath(), { scope: 'result', resultId: fx.result.id });
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ message: 'AI suggestions are not set up yet.', code: 'ai_not_configured' });
      expect(await runCount()).toBe(1);
      expect(pipelineMock).not.toHaveBeenCalled();
    });

    it('result scope answers 200 within the wait with suggestions for that result only', async () => {
      const o2 = await prisma.resultNode.create({ data: { frameworkId: fx.framework.id, level: 'outcome', code: 'O2', text: 'Outcome two' } });
      pipelineMock.mockImplementationOnce(async ctx => answerFor(ctx));
      const res = await post(suggestPath(), { scope: 'result', resultId: fx.result.id });
      expect(res.status).toBe(200);
      expect(res.body.run).toMatchObject({ scope: 'result', resultId: fx.result.id, status: 'completed', step: 'done', suggestionCount: 2, errorCode: null });
      expect(res.body.suggestions.map((s: any) => [s.resultId, s.sortOrder, s.status, s.suggestion.name])).toEqual([
        [fx.result.id, 1, 'pending', 'Number of O1 things 1'],
        [fx.result.id, 2, 'pending', 'Number of O1 things 2'],
      ]);
      expect(res.body.suggestions[0]).toMatchObject({ resultCode: 'O1', level: 'outcome', qualityBand: 'strong', origin: 'model', model: 'served-model-1' });
      expect(res.body.suggestions[0].draft).toMatchObject({ resultId: fx.result.id, indicatorText: 'Number of O1 things 1' });
      expect(res.body.suggestions.some((s: any) => s.resultId === o2.id)).toBe(false);
    });

    it('framework scope returns 202 and the run completes with suggestions ranked per result', async () => {
      await prisma.resultNode.create({ data: { frameworkId: fx.framework.id, level: 'output', code: 'O1.1', text: 'Output one', parentId: fx.result.id } });
      pipelineMock.mockImplementationOnce(async ctx => answerFor(ctx));
      const res = await post(suggestPath(), { scope: 'framework' });
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ run: expect.objectContaining({ scope: 'framework', status: 'running', resultId: null }) });
      expect(res.body.suggestions).toBeUndefined();
      const done = await pollUntilDone(res.body.run.id);
      expect(done.run).toMatchObject({ status: 'completed', suggestionCount: 4 });
      expect(done.suggestions.map((s: any) => [s.resultCode, s.sortOrder])).toEqual([['O1', 1], ['O1', 2], ['O1.1', 1], ['O1.1', 2]]);
    });

    it('result scope that takes longer than the wait answers 202; polling then sees it complete', async () => {
      const gate = deferred<KpiPipelineResult>();
      pipelineMock.mockImplementationOnce(async ctx => { await gate.promise; return answerFor(ctx, 1); });
      const res = await post(suggestPath(), { scope: 'result', resultId: fx.result.id });
      expect(res.status).toBe(202);
      expect(res.body.run).toMatchObject({ status: 'running', scope: 'result' });
      gate.resolve(emptyPipelineResult());
      const done = await pollUntilDone(res.body.run.id);
      expect(done.run.status).toBe('completed');
      expect(done.suggestions).toHaveLength(1);
    });

    it('alternatives of a suggestion (body) and of an indicator (alias route) run with the source in the scope', async () => {
      pipelineMock.mockImplementation(async ctx => answerFor(ctx, 2));
      const bySuggestion = await post(suggestPath(), { scope: 'alternatives', suggestionId: fx.kpiSuggestion.id });
      expect(bySuggestion.status).toBe(200);
      expect(bySuggestion.body.run).toMatchObject({ scope: 'alternatives', sourceSuggestionId: fx.kpiSuggestion.id, resultId: fx.result.id });
      expect(bySuggestion.body.suggestions.map((s: any) => s.alternativeOfSuggestionId)).toEqual([fx.kpiSuggestion.id, fx.kpiSuggestion.id]);
      expect(pipelineMock.mock.calls[0][0].scope).toEqual({ type: 'alternatives', indicatorId: null, suggestionId: fx.kpiSuggestion.id });

      const byIndicator = await post(`/api/indicators/${fx.indicator.id}/alternative`, { scope: 'framework', ignored: true });
      expect(byIndicator.status).toBe(200);
      expect(byIndicator.body.run).toMatchObject({ scope: 'alternatives', sourceIndicatorId: fx.indicator.id });
      expect(pipelineMock.mock.calls[1][0].scope).toEqual({ type: 'alternatives', indicatorId: fx.indicator.id, suggestionId: null });
      expect(pipelineMock.mock.calls[1][0].alternativesFor).toMatchObject({ kind: 'indicator', id: fx.indicator.id });
    });

    it('a rejected suggestion can get alternatives; an accepted one cannot (400)', async () => {
      pipelineMock.mockImplementation(async ctx => answerFor(ctx, 2));
      await prisma.kpiSuggestion.update({ where: { id: fx.kpiSuggestion.id }, data: { status: 'rejected', rejectReason: 'wording', decidedAt: new Date() } });
      expect((await post(suggestPath(), { scope: 'alternatives', suggestionId: fx.kpiSuggestion.id })).status).toBe(200);
      await prisma.kpiSuggestion.update({ where: { id: fx.kpiSuggestion.id }, data: { status: 'accepted' } });
      expect((await post(suggestPath(), { scope: 'alternatives', suggestionId: fx.kpiSuggestion.id })).status).toBe(400);
    });

    it('400 for a bad body; 404 for an unknown project (before the body is read)', async () => {
      expect((await post(suggestPath(), { scope: 'nope' })).status).toBe(400);
      expect((await post(suggestPath(), { scope: 'result' })).status).toBe(400);
      expect((await post(suggestPath(), { scope: 'alternatives', indicatorId: fx.indicator.id, suggestionId: fx.kpiSuggestion.id })).status).toBe(400);
      expect((await post('/api/projects/00000000-0000-0000-0000-000000000000/kpi-suggestions', { scope: 'nope' })).status).toBe(404);
      expect(await runCount()).toBe(1);
    });

    it('409 project_archived, 409 no_framework (the archived check comes first)', async () => {
      await prisma.project.update({ where: { id: fx.project.id }, data: { status: 'archived' } });
      const archived = await post(suggestPath(), { scope: 'framework' });
      expect(archived.status).toBe(409);
      expect(archived.body.code).toBe('project_archived');

      const bare = await prisma.project.create({
        data: { organizationId: fx.org.id, name: 'No framework', sector: 'health', donor: 'EU', donorType: 'eu', startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31') },
      });
      const none = await post(`/api/projects/${bare.id}/kpi-suggestions`, { scope: 'framework' });
      expect(none.status).toBe(409);
      expect(none.body.code).toBe('no_framework');
    });

    it('409 run_in_progress with the running run\'s id', async () => {
      const running = await createKpiRunRow({ projectId: fx.project.id, frameworkId: fx.framework.id, data: { status: 'running', finishedAt: null } });
      const res = await post(suggestPath(), { scope: 'result', resultId: fx.result.id });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'run_in_progress', details: { runId: running.id } });
      expect(pipelineMock).not.toHaveBeenCalled();
    });

    it('422 not_suggestable for an activity', async () => {
      const activity = await prisma.resultNode.create({ data: { frameworkId: fx.framework.id, level: 'activity', code: 'A1', text: 'Activity' } });
      const res = await post(suggestPath(), { scope: 'result', resultId: activity.id });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('not_suggestable');
    });

    it('422 nothing_to_suggest with the reason: no results, level maximum, donor cap; no run is created', async () => {
      const empty = await prisma.project.create({
        data: { organizationId: fx.org.id, name: 'Empty chain', sector: 'health', donor: 'EU', donorType: 'eu', startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31') },
      });
      await prisma.framework.create({ data: { projectId: empty.id, version: 1 } });
      const noResults = await post(`/api/projects/${empty.id}/kpi-suggestions`, { scope: 'framework' });
      expect(noResults.status).toBe(422);
      expect(noResults.body).toMatchObject({ code: 'nothing_to_suggest', details: { reason: 'no_results' } });

      for (let i = 0; i < 3; i++) {
        await prisma.indicator.create({
          data: { frameworkId: fx.framework.id, resultId: fx.result.id, indicatorText: `Extra ${i}`, level: 'outcome', dataCollectionMethod: 'hh_survey', frequency: 'quarterly', phases: [] },
        });
      }
      const levelCap = await post(suggestPath(), { scope: 'framework' });
      expect(levelCap.status).toBe(422);
      expect(levelCap.body.details).toEqual({ reason: 'level_cap' });

      await prisma.project.update({ where: { id: fx.project.id }, data: { donorType: 'echo' } });
      const donorCap = await post(suggestPath(), { scope: 'result', resultId: fx.result.id });
      expect(donorCap.status).toBe(422);
      expect(donorCap.body.details).toEqual({ reason: 'donor_cap' });
      expect(await runCount()).toBe(1);
    });

    it('422 too_many_results for more than 40 results in one framework run', async () => {
      await prisma.resultNode.createMany({
        data: Array.from({ length: 40 }, (_, i) => ({ frameworkId: fx.framework.id, level: 'output' as const, code: `O1.${i + 1}`, text: `Output ${i + 1}`, parentId: fx.result.id })),
      });
      const res = await post(suggestPath(), { scope: 'framework' });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'too_many_results', details: { count: 41, max: 40 }, message: 'Suggest KPIs for one result at a time; this framework has 41 results.' });
    });

    it('429 budget_reached once the organisation spent the daily AI budget; other organisations and older calls do not count', async () => {
      const other = await createOrgFixture(`budget${label}`);
      const aiCall = (organizationId: string, cost: number, createdAt = new Date()) => ({
        feature: 'document.analysis', model: 'm', promptVersion: 'v', status: 'success' as const, latencyMs: 1,
        estimatedCostUsd: new Prisma.Decimal(cost), organizationId, createdAt,
      });
      await prisma.aiCall.createMany({
        data: [aiCall(fx.org.id, 19.9), aiCall(other.org.id, 500), aiCall(fx.org.id, 100, new Date(Date.now() - 25 * 60 * 60 * 1000))],
      });
      pipelineMock.mockImplementation(async ctx => answerFor(ctx, 1));
      expect((await post(suggestPath(), { scope: 'result', resultId: fx.result.id })).status).toBe(200);

      await prisma.aiCall.create({ data: aiCall(fx.org.id, 0.2) });
      const res = await post(suggestPath(), { scope: 'result', resultId: fx.result.id });
      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({ code: 'budget_reached', details: { budgetUsd: 20 } });

      const budget = env.aiOrgDailyBudgetUsd;
      env.aiOrgDailyBudgetUsd = 0;
      try {
        expect((await post(suggestPath(), { scope: 'result', resultId: fx.result.id })).status).toBe(200);
      } finally {
        env.aiOrgDailyBudgetUsd = budget;
      }
    });

    it('CC-07 (re-check): calls of an unpriced model count at the highest known rates, so the budget still stops KPI requests', async () => {
      const call = (data: Partial<Prisma.AiCallCreateManyInput>): Prisma.AiCallCreateManyInput => ({
        feature: 'kpi.suggest', model: 'claude-sonnet-5-5', promptVersion: 'kpi-v2', status: 'success', latencyMs: 1, organizationId: fx.org.id, ...data,
      });
      // 600k output tokens of a model missing from models.ts, stored without a cost: 15 USD at the highest output rate (25/M).
      await prisma.aiCall.createMany({ data: [call({ model: 'claude-sonnet-9-9', estimatedCostUsd: null, outputTokens: 600_000 })] });
      expect(await organisationSpendUsd(prisma, fx.org.id, new Date())).toBeCloseTo(15, 6);
      pipelineMock.mockImplementation(async ctx => answerFor(ctx, 1));
      expect((await post(suggestPath(), { scope: 'result', resultId: fx.result.id })).status).toBe(200);

      // A server-side fallback to an unlisted model: the stored estimate (0.1) covers only the priced part; all 200k
      // output tokens count at 25/M (5 USD) instead, which reaches the 20 USD budget.
      await prisma.aiCall.createMany({ data: [call({ servedModel: 'claude-mystery-1', estimatedCostUsd: new Prisma.Decimal(0.1), outputTokens: 200_000 })] });
      expect(await organisationSpendUsd(prisma, fx.org.id, new Date())).toBeCloseTo(20, 6);
      const res = await post(suggestPath(), { scope: 'result', resultId: fx.result.id });
      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({ code: 'budget_reached' });
    });

    it('CC-07: a priced model (also as a dated snapshot id) counts at its stored estimate only', async () => {
      await prisma.aiCall.createMany({
        data: [
          { feature: 'kpi.suggest', model: 'claude-sonnet-5-5-20261001', promptVersion: 'kpi-v2', status: 'success', latencyMs: 1, organizationId: fx.org.id, estimatedCostUsd: new Prisma.Decimal(0.5), outputTokens: 1_000_000 },
          { feature: 'kpi.suggest', model: 'claude-haiku-5-5', servedModel: 'claude-haiku-5-5', promptVersion: 'kpi-v2', status: 'success', latencyMs: 1, organizationId: fx.org.id, estimatedCostUsd: new Prisma.Decimal(0.25), outputTokens: 500_000 },
        ],
      });
      expect(await organisationSpendUsd(prisma, fx.org.id, new Date())).toBeCloseTo(0.75, 6);
    });
  });

  describe('GET /api/projects/:id/kpi-suggestions and GET /api/kpi-suggestion-runs/:id', () => {
    it('lists pending suggestions of the current framework by default; status, result and run filters; deleted results hidden', async () => {
      const o2 = await prisma.resultNode.create({ data: { frameworkId: fx.framework.id, level: 'outcome', code: 'O2', text: 'Outcome two' } });
      const run = await createKpiRunRow({ projectId: fx.project.id, frameworkId: fx.framework.id, resultId: o2.id });
      const onO2 = await createKpiSuggestionRow({ run, suggestion: suggestion(o2, 1, 'Card on O2') });
      const rejected = await createKpiSuggestionRow({ run, suggestion: suggestion(o2, 2, 'Rejected card'), status: 'rejected', decision: { rejectReason: 'wording' } });

      const pending = await get(suggestPath());
      expect(pending.status).toBe(200);
      expect(pending.body.frameworkId).toBe(fx.framework.id);
      expect(pending.body.suggestions.map((s: any) => s.id).sort()).toEqual([fx.kpiSuggestion.id, onO2.id].sort());
      expect((await get(`${suggestPath()}?status=rejected`)).body.suggestions.map((s: any) => s.id)).toEqual([rejected.id]);
      expect((await get(`${suggestPath()}?status=all`)).body.suggestions).toHaveLength(3);
      expect((await get(`${suggestPath()}?resultId=${fx.result.id}`)).body.suggestions.map((s: any) => s.id)).toEqual([fx.kpiSuggestion.id]);
      expect((await get(`${suggestPath()}?runId=${run.id}&status=all`)).body.suggestions).toHaveLength(2);

      await prisma.resultNode.delete({ where: { id: o2.id } });
      expect((await get(suggestPath())).body.suggestions.map((s: any) => s.id)).toEqual([fx.kpiSuggestion.id]);
      expect((await get(`${suggestPath()}?status=maybe`)).status).toBe(400);
    });

    it('frameworkId must be a non-failed version of the project; a project without a framework lists nothing', async () => {
      const v2 = await prisma.framework.create({ data: { projectId: fx.project.id, version: 2 } });
      expect((await get(suggestPath())).body).toMatchObject({ frameworkId: v2.id, suggestions: [] });
      expect((await get(`${suggestPath()}?frameworkId=${fx.framework.id}`)).body.suggestions.map((s: any) => s.id)).toEqual([fx.kpiSuggestion.id]);
      const failed = await prisma.framework.create({ data: { projectId: fx.project.id, version: 3, generationError: 'failed' } });
      expect((await get(`${suggestPath()}?frameworkId=${failed.id}`)).status).toBe(400);
      const other = await createOrgFixture(`list${label}`);
      expect((await get(`${suggestPath()}?frameworkId=${other.framework.id}`)).status).toBe(400);

      const bare = await prisma.project.create({
        data: { organizationId: fx.org.id, name: 'Bare', sector: 'health', donor: 'EU', donorType: 'eu', startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31') },
      });
      expect((await get(`/api/projects/${bare.id}/kpi-suggestions`)).body).toEqual({ frameworkId: null, suggestions: [], activeRuns: [], latestFrameworkRun: null });
    });

    it('returns live runs as activeRuns (so progress resumes after a reload), stores stale ones as interrupted, and the latest framework run', async () => {
      const live = await createKpiRunRow({ projectId: fx.project.id, frameworkId: fx.framework.id, resultId: fx.result.id, data: { status: 'running', step: 'model', finishedAt: null } });
      const stale = await createKpiRunRow({
        projectId: fx.project.id, frameworkId: fx.framework.id,
        data: { status: 'running', finishedAt: null, updatedAt: new Date(Date.now() - KPI_RUN_STALE_MS - 60_000) },
      });
      const before = Date.now();
      const res = await get(suggestPath());
      expect(res.body.activeRuns.map((r: any) => [r.id, r.status, r.step])).toEqual([[live.id, 'running', 'model']]);
      // TQ-07: every run carries the server's clock, so a client measures the run's age without comparing clocks.
      const serverNow = Date.parse(res.body.activeRuns[0].serverNow);
      expect(serverNow).toBeGreaterThanOrEqual(before - 1000);
      expect(serverNow).toBeLessThanOrEqual(Date.now() + 1000);
      expect(Date.parse(res.body.latestFrameworkRun.serverNow)).toBe(serverNow);
      expect(res.body.latestFrameworkRun).toMatchObject({ id: stale.id, status: 'failed', errorCode: 'interrupted' });
      expect(await prisma.kpiSuggestionRun.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({ status: 'failed', errorCode: 'interrupted' });
    });

    it('GET run returns the run and every suggestion of it, any status; a stale run is reported failed / interrupted', async () => {
      await createKpiSuggestionRow({ run: fx.kpiRun, suggestion: suggestion(fx.result, 2, 'Rejected one'), status: 'rejected', decision: { rejectReason: 'duplicate' } });
      const res = await get(`/api/kpi-suggestion-runs/${fx.kpiRun.id}`);
      expect(res.status).toBe(200);
      expect(res.body.run).toMatchObject({ id: fx.kpiRun.id, status: 'completed', serverNow: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
      expect(res.body.suggestions.map((s: any) => s.status).sort()).toEqual(['pending', 'rejected']);

      const stale = await createKpiRunRow({ projectId: fx.project.id, frameworkId: fx.framework.id, data: { status: 'running', finishedAt: null, updatedAt: new Date(Date.now() - KPI_RUN_STALE_MS - 1000) } });
      expect((await get(`/api/kpi-suggestion-runs/${stale.id}`)).body.run).toMatchObject({ status: 'failed', errorCode: 'interrupted' });
    });
  });

  describe('POST /api/kpi-suggestions/:id/accept', () => {
    const accept = (id: string, body: object = {}) => post(`/api/kpi-suggestions/${id}/accept`, body);

    /** A library-linked suggestion (ED-02, SDG 4.1.1) on the fixture result. */
    async function librarySuggestion(name = '% of children in supported schools achieving minimum proficiency in reading') {
      const base = suggestion(fx.result, 1, name, { libraryId: 'ED-02', isCustom: false, customReason: '', standardReferenceCode: 'SDG 4.1.1 (aligned)' });
      return createKpiSuggestionRow({
        run: fx.kpiRun,
        suggestion: { ...base, draft: { ...base.draft, libraryId: 'ED-02', standardReferenceCode: 'SDG 4.1.1 (aligned)' } },
      });
    }

    it('accept creates an indicator with provenance ai_suggested, libraryId, standardReferenceCode, aiModel, promptVersion and resultId, every reference-sheet field filled or to be confirmed', async () => {
      const row = await librarySuggestion();
      const res = await accept(row.id);
      expect(res.status).toBe(201);
      expect(res.body.warnings).toEqual([]);
      expect(res.body.suggestion).toMatchObject({ id: row.id, status: 'accepted', decidedBy: fx.officer.id, indicatorId: res.body.indicator.id });
      const indicator = await prisma.indicator.findUniqueOrThrow({ where: { id: res.body.indicator.id } });
      expect(indicator).toMatchObject({
        frameworkId: fx.framework.id, resultId: fx.result.id, level: 'outcome', provenance: 'ai_suggested', libraryId: 'ED-02',
        standardReferenceCode: 'SDG 4.1.1 (aligned)', aiModel: row.model, promptVersion: 'kpi-v2', isApproved: false,
        indicatorText: '% of children in supported schools achieving minimum proficiency in reading', unit: 'percent', dataCollectionMethod: 'observation',
        baselineValue: null, baselineDate: null, targetValue: null, sortOrder: 1,
      });
      expect(indicator.startDate?.toISOString().slice(0, 10)).toBe('2026-01-01');
      expect(indicator.endDate?.toISOString().slice(0, 10)).toBe('2027-12-31');
      for (const field of ['indicatorTextAr', 'definition', 'meansOfVerification', 'baselineMethod', 'targetJustification', 'assumptions', 'responsibility', 'aiRationale'] as const) {
        expect(indicator[field], field).toEqual(expect.stringMatching(/\S/));
      }
      expect(indicator.calculation).toMatchObject({ numerator: expect.any(String), denominator: expect.any(String), rounding: 'To be confirmed by the M&E officer' });
      expect(indicator.disaggregation).toEqual(['sex', 'location']);
      expect(res.body.indicator.result).toMatchObject({ id: fx.result.id, code: 'O1' });

      const again = await accept(row.id);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('already_decided');
      expect((await post(`/api/kpi-suggestions/${row.id}/reject`, { reason: 'wording' })).status).toBe(409);
    });

    it('edits make it edited_accepted (server fields stay server-set); edits equal to the draft keep it accepted', async () => {
      const edited = await accept(fx.kpiSuggestion.id, { edits: { indicatorText: 'Share of observed teachers using learner-centred methods', provenance: 'manual', aiModel: 'x', targetValue: '60%' } });
      expect(edited.status).toBe(201);
      expect(edited.body.suggestion.status).toBe('edited_accepted');
      expect(await prisma.indicator.findUniqueOrThrow({ where: { id: edited.body.indicator.id } })).toMatchObject({
        indicatorText: 'Share of observed teachers using learner-centred methods', provenance: 'ai_suggested', aiModel: 'claude-sonnet-5-5', targetValue: '60%',
      });

      const row = await librarySuggestion();
      const same = await accept(row.id, { edits: { libraryId: 'ED-02', startDate: '2026-01-01' } });
      expect(same.status).toBe(201);
      expect(same.body.suggestion.status).toBe('accepted');
    });

    it('400 names failing edit fields and leaves the suggestion pending', async () => {
      const res = await accept(fx.kpiSuggestion.id, { edits: { level: 'nonsense', baselineDate: '2026-13-40' } });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/level/);
      expect(res.body.message).toMatch(/baselineDate/);
      expect((await accept(fx.kpiSuggestion.id, { edits: 'everything' })).status).toBe(400);
      expect((await prisma.kpiSuggestion.findUniqueOrThrow({ where: { id: fx.kpiSuggestion.id } })).status).toBe('pending');
    });

    it('409 stale (and expired) when a newer framework version exists, the result was deleted or its level changed', async () => {
      const levelChanged = await createKpiSuggestionRow({ run: fx.kpiRun, suggestion: suggestion(fx.result, 2, 'Level check') });
      await prisma.resultNode.update({ where: { id: fx.result.id }, data: { level: 'output' } });
      const res = await accept(levelChanged.id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('stale');
      expect((await prisma.kpiSuggestion.findUniqueOrThrow({ where: { id: levelChanged.id } })).status).toBe('expired');
      expect((await accept(levelChanged.id)).body.code).toBe('stale');
      await prisma.resultNode.update({ where: { id: fx.result.id }, data: { level: 'outcome' } });

      await prisma.framework.create({ data: { projectId: fx.project.id, version: 2 } });
      const newer = await accept(fx.kpiSuggestion.id);
      expect(newer.status).toBe(409);
      expect((await prisma.kpiSuggestion.findUniqueOrThrow({ where: { id: fx.kpiSuggestion.id } })).status).toBe('expired');
      expect(await prisma.indicator.count({ where: { provenance: 'ai_suggested', frameworkId: fx.framework.id } })).toBe(0);
    });

    it('409 stale when a framework version is created between the first check and the transaction (rolled back, then expired)', async () => {
      const { findCurrentFramework: real } = await vi.importActual<typeof import('../src/services/frameworks/current')>('../src/services/frameworks/current');
      currentMock
        .mockImplementationOnce(real)
        .mockImplementationOnce(async (db, projectId) => {
          await prisma.framework.create({ data: { projectId, version: 2 } });
          return real(db, projectId);
        });
      const res = await accept(fx.kpiSuggestion.id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('stale');
      expect(await prisma.kpiSuggestion.findUniqueOrThrow({ where: { id: fx.kpiSuggestion.id } })).toMatchObject({ status: 'expired', decidedAt: null, indicatorId: null });
      expect(await prisma.indicator.count({ where: { frameworkId: fx.framework.id } })).toBe(1);
    });

    it('409 duplicate when the result already has an indicator with the same library id or name', async () => {
      await prisma.indicator.update({ where: { id: fx.indicator.id }, data: { libraryId: 'ED-02' } });
      const row = await librarySuggestion();
      const res = await accept(row.id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('duplicate');
      expect((await prisma.kpiSuggestion.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('pending');

      const byName = await accept(fx.kpiSuggestion.id, { edits: { indicatorText: 'indicator ROUTE' + label } });
      expect(byName.status).toBe(409);
      expect(byName.body.code).toBe('duplicate');
    });

    it('expires the sibling group: same library id on the result, the source suggestion and its other alternatives', async () => {
      const lib = await librarySuggestion();
      const sameLibrary = await librarySuggestion('Another wording of the same library indicator');
      const alternative = await createKpiSuggestionRow({ run: fx.kpiRun, suggestion: suggestion(fx.result, 3, 'Alternative A'), data: { alternativeOfSuggestionId: fx.kpiSuggestion.id } });
      const otherAlternative = await createKpiSuggestionRow({ run: fx.kpiRun, suggestion: suggestion(fx.result, 4, 'Alternative B'), data: { alternativeOfSuggestionId: fx.kpiSuggestion.id } });
      const unrelated = await createKpiSuggestionRow({ run: fx.kpiRun, suggestion: suggestion(fx.result, 5, 'Unrelated card') });

      expect((await accept(lib.id)).status).toBe(201);
      expect((await prisma.kpiSuggestion.findUniqueOrThrow({ where: { id: sameLibrary.id } })).status).toBe('expired');

      expect((await accept(alternative.id)).status).toBe(201);
      const statuses = Object.fromEntries((await prisma.kpiSuggestion.findMany({ where: { runId: fx.kpiRun.id } })).map(s => [s.id, s.status]));
      expect(statuses[fx.kpiSuggestion.id]).toBe('expired');
      expect(statuses[otherAlternative.id]).toBe('expired');
      expect(statuses[unrelated.id]).toBe('pending');
    });

    it('TQ-01/CC-03: two siblings accepted at the same time give one 201 and one 409 (never a 500), and one indicator', async () => {
      for (let trial = 0; trial < 3; trial++) {
        const first = await librarySuggestion(`Sibling A ${trial}`);
        const second = await librarySuggestion(`Sibling B ${trial}`);
        const answers = await Promise.all([accept(first.id), accept(second.id)]);
        expect(answers.map(a => a.status).sort(), `trial ${trial}`).toEqual([201, 409]);
        expect(['already_decided', 'stale', 'duplicate']).toContain(answers.find(a => a.status === 409)!.body.code);
        expect(await prisma.indicator.count({ where: { frameworkId: fx.framework.id, libraryId: 'ED-02' } })).toBe(1);
        await prisma.indicator.deleteMany({ where: { frameworkId: fx.framework.id, libraryId: 'ED-02' } });
      }
    });

    it('CC-04: accept takes the project lock first, so it waits for a run that is saving its cards', async () => {
      const release = deferred<void>();
      const held = deferred<void>();
      const holder = prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`kpi-run:${fx.project.id}`}::text))`;
        held.resolve();
        await release.promise;
      }, { timeout: 20_000 });
      await held.promise;
      const answer = accept(fx.kpiSuggestion.id).then(r => r);
      await new Promise(resolve => setTimeout(resolve, 400));
      expect((await prisma.kpiSuggestion.findUniqueOrThrow({ where: { id: fx.kpiSuggestion.id } })).status).toBe('pending');
      release.resolve();
      await holder;
      expect((await answer).status).toBe(201);
    });

    it('SPEC-8: replaceSource replaces the indicator an alternative was suggested for; never one with data', async () => {
      const source = await prisma.indicator.create({
        data: { frameworkId: fx.framework.id, resultId: fx.result.id, indicatorText: 'Increase literacy to 80%', level: 'outcome', dataCollectionMethod: 'hh_survey', frequency: 'quarterly', phases: [] },
      });
      const alternative = await createKpiSuggestionRow({ run: fx.kpiRun, suggestion: suggestion(fx.result, 2, 'Share of pupils reading at grade level'), data: { alternativeOfIndicatorId: source.id } });
      const res = await accept(alternative.id, { replaceSource: true });
      expect(res.status).toBe(201);
      expect(res.body.replacedIndicatorId).toBe(source.id);
      expect(await prisma.indicator.findUnique({ where: { id: source.id } })).toBeNull();
      expect(await prisma.indicator.findUniqueOrThrow({ where: { id: res.body.indicator.id } })).toMatchObject({ indicatorText: 'Share of pupils reading at grade level' });

      // The fixture indicator holds a data point: refused, nothing changes.
      const withData = await createKpiSuggestionRow({ run: fx.kpiRun, suggestion: suggestion(fx.result, 3, 'Another reading measure'), data: { alternativeOfIndicatorId: fx.indicator.id } });
      const refused = await accept(withData.id, { replaceSource: true });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('source_has_data');
      expect(await prisma.indicator.findUnique({ where: { id: fx.indicator.id } })).not.toBeNull();
      expect((await prisma.kpiSuggestion.findUniqueOrThrow({ where: { id: withData.id } })).status).toBe('pending');
      // Without replaceSource both stay; a suggestion that is no alternative of an indicator cannot replace anything.
      expect((await accept(withData.id)).body.replacedIndicatorId).toBeNull();
      const plain = await createKpiSuggestionRow({ run: fx.kpiRun, suggestion: suggestion(fx.result, 4, 'Plain card') });
      expect((await accept(plain.id, { replaceSource: true })).status).toBe(400);
    });

    it('SPEC-8 (re-check): replacing the source expires its other alternatives first, so none becomes an extra indicator', async () => {
      const source = await prisma.indicator.create({
        data: { frameworkId: fx.framework.id, resultId: fx.result.id, indicatorText: 'Increase literacy to 80%', level: 'outcome', dataCollectionMethod: 'hh_survey', frequency: 'quarterly', phases: [] },
      });
      const a1 = await createKpiSuggestionRow({ run: fx.kpiRun, suggestion: suggestion(fx.result, 2, 'Share of pupils reading at grade level'), data: { alternativeOfIndicatorId: source.id } });
      const a2 = await createKpiSuggestionRow({ run: fx.kpiRun, suggestion: suggestion(fx.result, 3, 'Mean reading fluency score of pupils'), data: { alternativeOfIndicatorId: source.id } });
      const res = await accept(a1.id, { replaceSource: true });
      expect(res.status).toBe(201);
      expect(res.body.replacedIndicatorId).toBe(source.id);
      expect(await prisma.kpiSuggestion.findUniqueOrThrow({ where: { id: a2.id } })).toMatchObject({ status: 'expired' });
      for (const body of [{}, { replaceSource: true }]) {
        const again = await accept(a2.id, body);
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('stale');
      }
      const onResult = await prisma.indicator.findMany({ where: { resultId: fx.result.id, indicatorText: { in: ['Share of pupils reading at grade level', 'Mean reading fluency score of pupils', 'Increase literacy to 80%'] } } });
      expect(onResult.map(i => i.indicatorText)).toEqual(['Share of pupils reading at grade level']);
    });

    it('SPEC-8 (re-check): two alternatives of one indicator accepted at once with replaceSource: one 201, one 409, one indicator', async () => {
      for (let t = 0; t < 4; t++) {
        const source = await prisma.indicator.create({
          data: { frameworkId: fx.framework.id, resultId: fx.result.id, indicatorText: `Weak ${t}`, level: 'outcome', dataCollectionMethod: 'hh_survey', frequency: 'quarterly', phases: [] },
        });
        const a = await createKpiSuggestionRow({ run: fx.kpiRun, suggestion: suggestion(fx.result, 1, `Alt X ${t}`), data: { alternativeOfIndicatorId: source.id } });
        const b = await createKpiSuggestionRow({ run: fx.kpiRun, suggestion: suggestion(fx.result, 2, `Alt Y ${t}`), data: { alternativeOfIndicatorId: source.id } });
        const [r1, r2] = await Promise.all([
          post(`/api/kpi-suggestions/${a.id}/accept`, { replaceSource: true }, fx.officerAuth),
          post(`/api/kpi-suggestions/${b.id}/accept`, { replaceSource: true }, fx.adminAuth),
        ]);
        expect([r1.status, r2.status].sort()).toEqual([201, 409]);
        const left = await prisma.indicator.findMany({ where: { resultId: fx.result.id, indicatorText: { in: [`Alt X ${t}`, `Alt Y ${t}`, `Weak ${t}`] } } });
        expect(left).toHaveLength(1);
        expect(left[0].indicatorText).toMatch(/^Alt [XY] /);
      }
    });

    it('TQ-02: edits to fields the draft does not hold are refused (400 not_editable), never dropped silently', async () => {
      const res = await accept(fx.kpiSuggestion.id, { edits: { indicatorText: 'Edited name', status: 'on_track', currentValue: '12', milestones: [] } });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'not_editable', details: { keys: ['status', 'currentValue', 'milestones'] } });
      expect((await prisma.kpiSuggestion.findUniqueOrThrow({ where: { id: fx.kpiSuggestion.id } })).status).toBe('pending');
    });

    it('warns donor_cap_exceeded when the result now has more indicators than the donor allows (never blocks)', async () => {
      await prisma.project.update({ where: { id: fx.project.id }, data: { donorType: 'echo' } });
      for (let i = 0; i < 2; i++) {
        await prisma.indicator.create({
          data: { frameworkId: fx.framework.id, resultId: fx.result.id, indicatorText: `Existing ${i}`, level: 'outcome', dataCollectionMethod: 'hh_survey', frequency: 'quarterly', phases: [] },
        });
      }
      const res = await accept(fx.kpiSuggestion.id);
      expect(res.status).toBe(201);
      expect(res.body.warnings).toEqual([expect.objectContaining({ code: 'donor_cap_exceeded', params: { code: 'O1', cap: 3, count: 4 }, penalty: 0 })]);
      expect(res.body.replacedIndicatorId).toBeNull();

      // SPEC-8: an alternative that replaces its source does not add to the result's count.
      const source = await prisma.indicator.create({
        data: { frameworkId: fx.framework.id, resultId: fx.result.id, indicatorText: 'Weak indicator', level: 'outcome', dataCollectionMethod: 'hh_survey', frequency: 'quarterly', phases: [] },
      });
      const before = await prisma.indicator.count({ where: { frameworkId: fx.framework.id, resultId: fx.result.id } });
      const alternative = await createKpiSuggestionRow({ run: fx.kpiRun, suggestion: suggestion(fx.result, 2, 'Stronger replacement'), data: { alternativeOfIndicatorId: source.id } });
      const replaced = await accept(alternative.id, { replaceSource: true });
      expect(replaced.status).toBe(201);
      expect(replaced.body.warnings).toEqual([expect.objectContaining({ code: 'donor_cap_exceeded', params: { code: 'O1', cap: 3, count: before } })]);
    });
  });

  describe('POST /api/kpi-suggestions/:id/reject', () => {
    it('records the reason, the decider and a redacted note; a second decision answers 409', async () => {
      const res = await post(`/api/kpi-suggestions/${fx.kpiSuggestion.id}/reject`, { reason: 'too_costly_to_measure', note: 'Ask 0599 123 456 first' });
      expect(res.status).toBe(200);
      expect(res.body.suggestion).toMatchObject({ status: 'rejected', rejectReason: 'too_costly_to_measure', decidedBy: fx.officer.id });
      expect(res.body.suggestion.rejectNote).not.toContain('0599');
      const stored = await prisma.kpiSuggestion.findUniqueOrThrow({ where: { id: fx.kpiSuggestion.id } });
      expect(stored.rejectNote).not.toContain('0599');
      expect(stored.decidedAt).not.toBeNull();

      const again = await post(`/api/kpi-suggestions/${fx.kpiSuggestion.id}/reject`, { reason: 'other' });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('already_decided');
      expect((await post(`/api/kpi-suggestions/${fx.kpiSuggestion.id}/accept`, {})).body.code).toBe('already_decided');
    });

    it('400 for a missing or unknown reason and an overlong note', async () => {
      const path = `/api/kpi-suggestions/${fx.kpiSuggestion.id}/reject`;
      expect((await post(path, {})).status).toBe(400);
      expect((await post(path, { reason: 'meh' })).status).toBe(400);
      expect((await post(path, { reason: 'other', note: 'x'.repeat(1001) })).status).toBe(400);
      expect((await prisma.kpiSuggestion.findUniqueOrThrow({ where: { id: fx.kpiSuggestion.id } })).status).toBe('pending');
    });

    it('CC-05: reject takes the project lock, so a run saving its cards (which re-reads rejections) never misses it', async () => {
      const release = deferred<void>();
      const held = deferred<void>();
      const holder = prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`kpi-run:${fx.project.id}`}::text))`;
        held.resolve();
        await release.promise;
      }, { timeout: 20_000 });
      await held.promise;
      const answer = post(`/api/kpi-suggestions/${fx.kpiSuggestion.id}/reject`, { reason: 'not_relevant' }).then(r => r);
      await new Promise(resolve => setTimeout(resolve, 400));
      // While a save holds the lock, the rejection waits: the save's reload of the organisation's decisions stays true.
      expect((await prisma.kpiSuggestion.findUniqueOrThrow({ where: { id: fx.kpiSuggestion.id } })).status).toBe('pending');
      release.resolve();
      await holder;
      expect((await answer).status).toBe(200);
      expect((await prisma.kpiSuggestion.findUniqueOrThrow({ where: { id: fx.kpiSuggestion.id } })).status).toBe('rejected');
    });
  });

  describe('GET /api/frameworks/:id/indicator-quality and GET /api/kpi-assistant/status', () => {
    it('indicator-quality: a name with a target scores 85 (strong) with needsAlternatives true; info notes only → false', async () => {
      const withTarget = await prisma.indicator.create({
        data: {
          frameworkId: fx.framework.id, resultId: fx.result.id, indicatorText: 'Increase enrolment to 80%', indicatorTextAr: 'زيادة الالتحاق إلى 80%',
          level: 'outcome', dataCollectionMethod: 'document_review', frequency: 'annual', phases: [], unit: 'number', sortOrder: 5,
        },
      });
      const res = await get(`/api/frameworks/${fx.framework.id}/indicator-quality`);
      expect(res.status).toBe(200);
      const byId = Object.fromEntries(res.body.indicators.map((i: any) => [i.indicatorId, i]));
      expect(byId[withTarget.id]).toMatchObject({ qualityScore: 85, qualityBand: 'strong', needsAlternatives: true });
      expect(byId[withTarget.id].warnings.map((w: any) => w.code)).toContain('target_in_name');
      // The fixture indicator has no Arabic name: a warning without a penalty.
      expect(byId[fx.indicator.id]).toMatchObject({ qualityScore: 100, needsAlternatives: false });
      expect(byId[fx.indicator.id].warnings.map((w: any) => w.code)).toEqual(['arabic_name_missing']);
    });

    it('status reports whether the AI is configured, the retrieval mode and the prompt version', async () => {
      status.configured = false;
      expect((await get('/api/kpi-assistant/status')).body).toEqual({ aiConfigured: false, embeddings: 'none', promptVersion: 'kpi-v2' });
      expect((await get('/api/kpi-assistant/status', fx.adminAuth)).status).toBe(200);
    });
  });
});
