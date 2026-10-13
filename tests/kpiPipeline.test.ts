import { afterEach, describe, expect, it, vi } from 'vitest';

// tests/setup.ts may replace runKpiPipeline with a mock for the route tests; this file runs the real one.
vi.unmock('../src/services/kpi/pipeline');

import { env } from '../src/config/env';
import { configureAiClientForTests, resetAiClientForTests, resolveModel, type AiCallRecord } from '../src/services/ai/client';
import { DONOR_RULES } from '../src/services/ai/donorRules';
import { EmbeddingError, NoopEmbeddingProvider, VoyageEmbeddingProvider } from '../src/services/ai/embeddingProviders';
import { AiError, AiInvalidOutputError, AiOutputTruncatedError, AiRefusalError, AiRequestError } from '../src/services/ai/errors';
import { outputJsonSchema } from '../src/services/ai/outputSchema';
import { KPI_CALLS, KPI_PROMPT_VERSION, KPI_SUGGESTIONS_SCHEMA, KPI_SYSTEM } from '../src/services/ai/prompts/kpi';
import { loadSharedSystemPrompt } from '../src/services/ai/prompts/system';
import {
  KPI_BATCH_CONCURRENCY, KPI_BATCH_MAX_RESULTS, KPI_MAX_CALLS_PER_RUN, KPI_MAX_CONCURRENT_CALLS, KPI_RUN_DEADLINE_MS, callConfigFor,
  callModelForResults, candidatesForBatch, defaultModelCaller, exclusiveCandidates, kpiCallSlots, planBatches,
} from '../src/services/kpi/callModel';
import { QUERY_EMBEDDING_MAX_RETRIES, QUERY_EMBEDDING_TIMEOUT_MS, productionPipelineDeps, queryEmbeddingProvider } from '../src/services/kpi/deps';
import { EMPTY_PIPELINE_RESULT, KpiPipelineError, emptyPipelineResult, runKpiPipeline } from '../src/services/kpi/pipeline';
import type { RankedCandidate, RetrievalResult } from '../src/services/kpi/retrieve';
import type {
  ContextResult, KpiLibraryEntry, KpiModelAnswer, KpiModelRequest, KpiPipelineDeps, KpiRunStep, LibrarySource, ProjectContext,
} from '../src/services/kpi/types';
import {
  fakeEmbeddings, fakeModelCaller, fakeSdk, fakeVector, kpiAnswerFromMeta, libraryEntries, libraryEntry, memoryLibrarySource,
  noEmbeddings, rawFromEntry, rawMessage, refusalMessage, sdkError, suggestForLines, truncatedMessage,
} from './aiFakes';

/**
 * KPI model calls and pipeline (knowledge/kpi-assistant-spec.md §A4 steps 1–3; design sections 2, 4.4 and 6.3, D19,
 * D20): batches, concurrency, tiers and features per scope, splitting on truncation, invalid output and refusal,
 * failures, deadline and call budget, steps, near-duplicate embeddings, and one path through the real client with a
 * fake Anthropic SDK. No database, no network.
 */

// ------------------------------------------------------------------ fixtures (made-up projects, no personal data)

const r = (id: string, code: string, level: ContextResult['level'], text: string, parentId: string | null): ContextResult =>
  ({ id, code, level, text, textAr: null, parentId });

const RESULTS: ContextResult[] = [
  r('n-g', 'G', 'impact', 'Reduced risk of water-borne disease among displaced families', null),
  r('n-o1', 'O1', 'outcome', 'Displaced households have access to sufficient safe drinking water', 'n-g'),
  r('n-o2', 'O2', 'outcome', 'Displaced households practise key hygiene behaviours such as handwashing with soap', 'n-g'),
  r('n-o1.1', 'O1.1', 'output', 'Safe water delivered through water trucking to displacement sites', 'n-o1'),
  r('n-o1.2', 'O1.2', 'output', 'Community water points rehabilitated', 'n-o1'),
  r('n-o2.1', 'O2.1', 'output', 'Hygiene kits distributed to displaced households', 'n-o2'),
];

/** 1 impact + 6 outcomes with 3 outputs each: 7 batches (the impact alone, then one outcome with its outputs each). */
const BIG_CHAIN: ContextResult[] = [
  r('b-g', 'G', 'impact', 'Improved wellbeing of displaced families', null),
  ...Array.from({ length: 6 }, (_, i) => r(`b-o${i + 1}`, `O${i + 1}`, 'outcome', `Households have safe water and hygiene, area ${i + 1}`, 'b-g')),
  ...Array.from({ length: 6 }, (_, i) => Array.from({ length: 3 }, (_, j) =>
    r(`b-o${i + 1}.${j + 1}`, `O${i + 1}.${j + 1}`, 'output', `Water points rehabilitated, area ${i + 1} lot ${j + 1}`, `b-o${i + 1}`))).flat(),
];

function context(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    project: {
      id: 'p-1', name: 'Emergency water and hygiene for displaced families', sectors: ['wash'], donor: 'Example donor', donorType: 'other',
      startDate: '2026-11-01', endDate: '2027-10-31', geographicScope: 'Khan Younis governorate', targetBeneficiaries: 24000,
      humanitarian: false, description: 'Water trucking, water point rehabilitation and hygiene promotion.',
    },
    resultsChain: RESULTS,
    scope: { type: 'framework' },
    existingIndicators: [],
    pendingSuggestions: [],
    documentFacts: [],
    documentTexts: [],
    orgPreferences: { rejectedLibraryIds: [], preferredMethods: [] },
    donorRules: { donorType: 'other', ...DONOR_RULES.other },
    alternativesFor: null,
    ...overrides,
  };
}

const WASH = libraryEntries().filter(e => e.sector === 'wash');

/** Entries for retrievalFor: the WASH entries first, then the other non-accountability entries. */
const POOL = [...WASH, ...libraryEntries().filter(e => e.sector !== 'wash' && !e.id.startsWith('AC-'))];

/**
 * A retrieval result that offers every result the same 8 ranked entries (callModelForResults tests need no ranking);
 * the results of the O2 group get 8 others, so the two batches of RESULTS share no candidate (AI-2 keeps a shared one in
 * one batch only).
 */
function retrievalFor(ctx: ProjectContext, accountability: KpiLibraryEntry[] = []): RetrievalResult {
  const ranked: RankedCandidate[] = POOL.map((entry, i) => ({ entry, score: 1 - i / 100 }));
  const reversed: RankedCandidate[] = [...POOL].reverse().map((entry, i) => ({ entry, score: 1 - i / 100 }));
  return {
    method: 'keyword',
    byResult: new Map(ctx.resultsChain.map(res => [res.id, (res.id.startsWith('n-o2') ? reversed : ranked).slice(0, 8)])),
    accountability,
    library: new Map(libraryEntries().map(e => [e.id, e])),
    warnings: [],
  };
}

const opts = (overrides: Partial<Parameters<typeof callModelForResults>[3]> = {}) =>
  ({ deadlineAt: Date.now() + KPI_RUN_DEADLINE_MS, maxCalls: KPI_MAX_CALLS_PER_RUN, ...overrides });

const deps = (caller: KpiPipelineDeps['callModel'], overrides: Partial<KpiPipelineDeps> = {}): KpiPipelineDeps =>
  ({ library: memoryLibrarySource(), embeddings: noEmbeddings, callModel: caller, now: () => new Date(), ...overrides });

const codes = (results: readonly ContextResult[]) => results.map(x => x.code);

/** A handler that fails the calls whose batch matches `when` and answers the others like a well-behaved model. */
function failWhen(when: (request: KpiModelRequest) => boolean, error: () => Error) {
  return (request: KpiModelRequest): KpiModelAnswer => {
    if (when(request)) throw error();
    return kpiAnswerFromMeta(request);
  };
}

const multi = (request: KpiModelRequest) => request.meta.batch.length > 1;
const single = (code: string) => (request: KpiModelRequest) => request.meta.batch.length === 1 && request.meta.batch[0].code === code;

const savedEnv = { ...env };

afterEach(() => {
  resetAiClientForTests();
  vi.restoreAllMocks();
  Object.assign(env, savedEnv);
});

// ------------------------------------------------------------------ planBatches, settings, candidates

describe('planBatches (design 4.4: ≤ 4 results, an outcome travels with its outputs)', () => {
  it('packs the impact with the first outcome group and keeps every outcome with its outputs', () => {
    expect(planBatches(RESULTS).map(codes)).toEqual([['G', 'O1', 'O1.1', 'O1.2'], ['O2', 'O2.1']]);
  });

  it('cuts a group larger than 4 and never splits a group that fits', () => {
    const big = [
      r('a', 'O1', 'outcome', 'x', null),
      ...[1, 2, 3, 4, 5].map(i => r(`a${i}`, `O1.${i}`, 'output', 'x', 'a')),
      r('b', 'O2', 'outcome', 'x', null),
      r('b1', 'O2.1', 'output', 'x', 'b'),
    ];
    expect(planBatches(big).map(codes)).toEqual([['O1', 'O1.1', 'O1.2', 'O1.3'], ['O1.4', 'O1.5', 'O2', 'O2.1']]);
  });

  it('plans every result exactly once, ≤ 4 per batch, for a big framework', () => {
    const batches = planBatches(BIG_CHAIN);
    expect(batches).toHaveLength(7);
    expect(batches.every(b => b.length <= KPI_BATCH_MAX_RESULTS)).toBe(true);
    expect(batches.flat().map(x => x.id).sort()).toEqual(BIG_CHAIN.map(x => x.id).sort());
    for (const batch of batches.slice(1)) expect(batch.slice(1).every(o => o.parentId === batch[0].id)).toBe(true);
  });

  it('keeps outputs whose outcome is not in scope together, and a single result alone', () => {
    const orphans = [r('x1', 'O1.1', 'output', 'x', 'n-o1'), r('y1', 'O2.1', 'output', 'x', 'n-o2'), r('x2', 'O1.2', 'output', 'x', 'n-o1')];
    expect(planBatches(orphans).map(codes)).toEqual([['O1.1', 'O1.2', 'O2.1']]);
    expect(planBatches([RESULTS[1]]).map(codes)).toEqual([['O1']]);
    expect(planBatches([])).toEqual([]);
  });
});

describe('callConfigFor (design 6.3)', () => {
  it('fast tier for alternatives, the result settings for one result, the batch settings for 2–4', () => {
    expect(callConfigFor('alternatives', 1)).toBe(KPI_CALLS.alternatives);
    expect(callConfigFor('result', 1)).toBe(KPI_CALLS.result);
    expect(callConfigFor('framework', 1)).toBe(KPI_CALLS.result);
    expect(callConfigFor('framework', 4)).toBe(KPI_CALLS.batch);
  });
});

describe('candidatesForBatch (≤ 40 per call, accountability kept)', () => {
  it('unions the batch results\' candidates (best score kept), lists them per result and appends accountability entries', () => {
    const [a, b, c] = WASH;
    const retrieval = {
      byResult: new Map([['r1', [{ entry: a, score: 0.9 }, { entry: b, score: 0.5 }]], ['r2', [{ entry: b, score: 0.8 }, { entry: c, score: 0.4 }]]]),
      accountability: [libraryEntry('AC-01'), libraryEntry('AC-03')],
    };
    const out = candidatesForBatch([r('r1', 'O1', 'outcome', 'x', null), r('r2', 'O2', 'outcome', 'x', null)], retrieval);
    expect(out.candidates.map(e => e.id)).toEqual([a.id, b.id, c.id, 'AC-01', 'AC-03']);
    expect(out.candidateIdsByResult).toEqual({ r1: [a.id, b.id], r2: [b.id, c.id] });
  });

  it('drops the lowest scores first beyond 40 and always keeps the accountability entries', () => {
    const entries = libraryEntries().filter(e => !e.id.startsWith('AC-'));
    const batch = [1, 2, 3, 4].map(i => r(`r${i}`, `O${i}`, 'outcome', 'x', null));
    const byResult = new Map(batch.map((res, i) => [res.id, entries.slice(i * 12, i * 12 + 12).map((entry, j) => ({ entry, score: 1 - (i * 12 + j) / 100 }))]));
    const accountability = ['AC-01', 'AC-02', 'AC-03', 'AC-04', 'AC-05'].map(libraryEntry);
    const out = candidatesForBatch(batch, { byResult, accountability });
    expect(out.candidates).toHaveLength(40);
    expect(out.candidates.slice(-5).map(e => e.id)).toEqual(['AC-01', 'AC-02', 'AC-03', 'AC-04', 'AC-05']);
    // 35 places for 48 ranked entries: the 13 lowest scores (all of r4's and the last of r3's) are dropped
    expect([1, 2, 3, 4].map(i => out.candidateIdsByResult[`r${i}`].length)).toEqual([12, 12, 11, 0]);
    expect(out.candidates.map(e => e.id)).not.toContain(entries[35].id);
    expect(out.candidates.map(e => e.id)).toContain(entries[34].id);
  });
});

// ------------------------------------------------------------------ callModelForResults

describe('callModelForResults', () => {
  it('framework scope: one kpi.suggest call per batch with the batch settings, prompt and meta; suggestions in planned order', async () => {
    const ctx = context();
    const fake = fakeModelCaller();
    const out = await callModelForResults(ctx, retrievalFor(ctx), { callModel: fake.caller, now: () => new Date() },
      opts({ callContext: { organizationId: 'org-1', projectId: 'p-1' } }));
    expect(fake.requests).toHaveLength(2);
    const [first, second] = [...fake.requests].sort((a, b) => a.meta.batch[0].code.localeCompare(b.meta.batch[0].code));
    expect(codes(first.meta.batch)).toEqual(['G', 'O1', 'O1.1', 'O1.2']);
    expect(first).toMatchObject({
      feature: 'kpi.suggest', ...KPI_CALLS.batch, promptVersion: KPI_PROMPT_VERSION, system: KPI_SYSTEM,
      context: { organizationId: 'org-1', projectId: 'p-1' },
    });
    expect(first.meta.allowances).toEqual({ 'n-g': { min: 1, max: 2 }, 'n-o1': { min: 2, max: 4 }, 'n-o1.1': { min: 2, max: 3 }, 'n-o1.2': { min: 2, max: 3 } });
    expect(suggestForLines(first.user).map(l => l.code)).toEqual(['G', 'O1', 'O1.1', 'O1.2']);
    expect(codes(second.meta.batch)).toEqual(['O2', 'O2.1']);
    expect(out.suggestions.map(s => s.resultCode)).toEqual(['G', 'G', 'O1', 'O1', 'O1.1', 'O1.1', 'O1.2', 'O1.2', 'O2', 'O2', 'O2.1', 'O2.1']);
    expect(out.calls).toHaveLength(2);
    expect(out.calls[0]).toMatchObject({ feature: 'kpi.suggest', tier: 'main', model: 'fake-main-model', outcome: 'success', inputTokens: 1000, aiCallId: 'fake-call-1' });
    expect(out.failedResults).toEqual([]);
    expect(out.lastError).toBeNull();
    expect(out.model).toBe('fake-main-model');
  });

  it('the prompt of a batch holds only its results, their ancestors and sibling codes', async () => {
    const ctx = context();
    const fake = fakeModelCaller();
    await callModelForResults(ctx, retrievalFor(ctx), { callModel: fake.caller, now: () => new Date() }, opts());
    const second = fake.requests.find(q => q.meta.batch[0].code === 'O2')!;
    expect(second.user).toContain('Hygiene kits distributed');
    expect(second.user).not.toContain('Safe water delivered through water trucking');
    expect(second.user).toContain('siblings (not suggested for in this request): O1');
  });

  it('result scope uses the result settings; alternatives use kpi.alternatives on the fast tier; a feature override is kept', async () => {
    const resultCtx = context({ scope: { type: 'result', resultId: 'n-o1' } });
    const a = fakeModelCaller();
    await callModelForResults(resultCtx, retrievalFor(resultCtx), { callModel: a.caller, now: () => new Date() }, opts());
    expect(a.requests).toHaveLength(1);
    expect(a.requests[0]).toMatchObject({ feature: 'kpi.suggest', ...KPI_CALLS.result });
    expect(codes(a.requests[0].meta.batch)).toEqual(['O1']);

    const altCtx = context({
      scope: { type: 'alternatives', indicatorId: 'i-1', suggestionId: null },
      existingIndicators: [{ id: 'i-1', resultId: 'n-o1', name: 'Number of jerrycans', nameAr: null, level: 'outcome', unit: 'number', libraryId: null, method: 'document_review' }],
      alternativesFor: { kind: 'indicator', id: 'i-1', resultId: 'n-o1', name: 'Number of jerrycans', nameAr: null, definition: null, unit: 'number', method: 'document_review', libraryId: null, reason: 'requested', rejectReason: null, problems: [] },
    });
    const b = fakeModelCaller();
    await callModelForResults(altCtx, retrievalFor(altCtx), { callModel: b.caller, now: () => new Date() }, opts());
    expect(b.requests[0]).toMatchObject({ feature: 'kpi.alternatives', tier: 'fast', ...KPI_CALLS.alternatives });
    expect(b.requests[0].meta.allowances['n-o1']).toEqual({ min: 2, max: 3 });

    const c = fakeModelCaller();
    await callModelForResults(context(), retrievalFor(context()), { callModel: c.caller, now: () => new Date() }, opts({ feature: 'framework.indicators' }));
    expect(c.requests.every(q => q.feature === 'framework.indicators')).toBe(true);
  });

  it.each([
    ['truncated', () => new AiOutputTruncatedError('kpi.suggest', 24_000)],
    ['invalid', () => new AiInvalidOutputError('kpi.suggest', ['suggestions[0].unit: not one of the allowed values'])],
    ['refused', () => new AiRefusalError('kpi.suggest', null)],
  ] as const)('a %s batch is split per result; a result that still fails gets that reason, the others are kept', async (reason, error) => {
    const ctx = context();
    const fake = fakeModelCaller(failWhen(q => (multi(q) && q.meta.batch[0].code === 'G') || single('O1.1')(q), error));
    const out = await callModelForResults(ctx, retrievalFor(ctx), { callModel: fake.caller, now: () => new Date() }, opts());
    // batch 1 (4 results) + batch 2 + 4 single retries
    expect(fake.requests).toHaveLength(6);
    expect(out.failedResults).toEqual([{ resultId: 'n-o1.1', reason }]);
    expect(new Set(out.suggestions.map(s => s.resultCode))).toEqual(new Set(['G', 'O1', 'O1.2', 'O2', 'O2.1']));
    expect(out.calls.map(c => c.outcome).sort()).toEqual(['success', 'success', 'success', 'success', reason, reason].sort());
    expect(out.calls.find(c => c.outcome === reason)).toMatchObject({ model: null, inputTokens: 0, outputTokens: 0, estimatedCostUsd: null, aiCallId: null });
    expect(out.lastError?.name).toBe(error().name);
    expect(fake.requests.filter(q => q.meta.batch.length === 1).every(q => q.maxTokens === KPI_CALLS.result.maxTokens)).toBe(true);
  });

  it('an AiRequestError 401 or 403 is rethrown at once and no further call starts', async () => {
    for (const status of [401, 403]) {
      const ctx = context({ resultsChain: BIG_CHAIN });
      const thrown = new AiRequestError('kpi.suggest', status, false, 1);
      const fake = fakeModelCaller(() => { throw thrown; }, { delayMs: 5 });
      await expect(callModelForResults(ctx, retrievalFor(ctx), { callModel: fake.caller, now: () => new Date() }, opts())).rejects.toBe(thrown);
      expect(fake.requests.length).toBeLessThanOrEqual(KPI_BATCH_CONCURRENCY);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(fake.requests.length).toBeLessThanOrEqual(KPI_BATCH_CONCURRENCY);
    }
  });

  it('another AiRequestError (retries used up) fails only that batch, without a split; other batches are kept', async () => {
    const ctx = context();
    const thrown = new AiRequestError('kpi.suggest', 529, true, 4);
    const fake = fakeModelCaller(failWhen(q => q.meta.batch[0].code === 'O2', () => thrown));
    const out = await callModelForResults(ctx, retrievalFor(ctx), { callModel: fake.caller, now: () => new Date() }, opts());
    expect(fake.requests).toHaveLength(2);
    expect(out.failedResults).toEqual([{ resultId: 'n-o2', reason: 'unavailable' }, { resultId: 'n-o2.1', reason: 'unavailable' }]);
    expect(out.lastError).toBe(thrown);
    expect(new Set(out.suggestions.map(s => s.resultCode))).toEqual(new Set(['G', 'O1', 'O1.1', 'O1.2']));
  });

  it('an error that is not an AiError is rethrown (a bug, not a model failure)', async () => {
    const ctx = context({ scope: { type: 'result', resultId: 'n-o1' } });
    const fake = fakeModelCaller(() => { throw new TypeError('broken'); });
    await expect(callModelForResults(ctx, retrievalFor(ctx), { callModel: fake.caller, now: () => new Date() }, opts())).rejects.toBeInstanceOf(TypeError);
  });

  it('no call starts after the deadline: the remaining results fail with deadline', async () => {
    const ctx = context({ resultsChain: BIG_CHAIN });
    let clock = 0;
    const fake = fakeModelCaller(q => { clock += 1000; return kpiAnswerFromMeta(q); });
    const out = await callModelForResults(ctx, retrievalFor(ctx), { callModel: fake.caller, now: () => new Date(clock) }, opts({ deadlineAt: 500 }));
    expect(fake.requests).toHaveLength(1);
    expect(out.failedResults).toHaveLength(BIG_CHAIN.length - 1);
    expect(out.failedResults.every(f => f.reason === 'deadline')).toBe(true);
    expect(out.lastError).toBeNull();

    const late = fakeModelCaller();
    const none = await callModelForResults(ctx, retrievalFor(ctx), { callModel: late.caller, now: () => new Date(1000) }, opts({ deadlineAt: 500 }));
    expect(late.requests).toHaveLength(0);
    expect(none.failedResults).toHaveLength(BIG_CHAIN.length);
    expect(none.calls).toEqual([]);
  });

  it('the call budget counts split retries: the remaining results fail with call_budget', async () => {
    const ctx = context({ resultsChain: RESULTS.slice(0, 2).concat(RESULTS.slice(3, 5)) });
    const fake = fakeModelCaller(failWhen(multi, () => new AiOutputTruncatedError('kpi.suggest', 24_000)));
    const out = await callModelForResults(ctx, retrievalFor(ctx), { callModel: fake.caller, now: () => new Date() }, opts({ maxCalls: 2 }));
    expect(fake.requests).toHaveLength(2);
    expect(out.failedResults.map(f => f.reason)).toEqual(['call_budget', 'call_budget', 'call_budget']);
    expect(out.suggestions.every(s => s.resultCode === 'G')).toBe(true);
  });

  it('runs at most 3 calls at a time per run and at most 6 per process', async () => {
    const ctx = context({ resultsChain: BIG_CHAIN });
    const one = fakeModelCaller(undefined, { delayMs: 15 });
    await callModelForResults(ctx, retrievalFor(ctx), { callModel: one.caller, now: () => new Date() }, opts());
    expect(one.requests).toHaveLength(7);
    expect(one.maxInFlight()).toBe(KPI_BATCH_CONCURRENCY);

    const shared = fakeModelCaller(undefined, { delayMs: 25 });
    let queued = 0;
    const watcher = setInterval(() => { queued = Math.max(queued, kpiCallSlots().queued); }, 2);
    try {
      await Promise.all([1, 2, 3].map(() => callModelForResults(ctx, retrievalFor(ctx), { callModel: shared.caller, now: () => new Date() }, opts())));
    } finally {
      clearInterval(watcher);
    }
    expect(shared.requests).toHaveLength(21);
    expect(shared.maxInFlight()).toBe(KPI_MAX_CONCURRENT_CALLS);
    expect(queued).toBeGreaterThan(0);
    expect(kpiCallSlots()).toEqual({ inFlight: 0, queued: 0 });
  });

  it('drops suggestions for a scoped result of another batch and passes unknown codes on for validation (rule x1)', async () => {
    const ctx = context();
    const fake = fakeModelCaller(q => ({
      suggestions: [
        rawFromEntry(WASH[0], q.meta.batch[0].code),
        rawFromEntry(WASH[1], q.meta.batch[0].code === 'G' ? 'O2' : 'G'),
        rawFromEntry(WASH[2], 'Z9'),
      ],
      frameworkWarnings: [`note for ${q.meta.batch[0].code}`],
    }));
    const out = await callModelForResults(ctx, retrievalFor(ctx), { callModel: fake.caller, now: () => new Date() }, opts());
    expect(out.suggestions.map(s => s.resultCode)).toEqual(['G', 'Z9', 'O2', 'Z9']);
    expect(out.modelWarnings).toEqual(['note for G', 'note for O2']);
  });

  it('calls onBatchDone after every call; a failing callback does not fail the run', async () => {
    const ctx = context();
    const done = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const out = await callModelForResults(ctx, retrievalFor(ctx), { callModel: fakeModelCaller().caller, now: () => new Date() }, opts({ onBatchDone: done }));
    expect(done).toHaveBeenCalledTimes(2);
    expect(out.failedResults).toEqual([]);
  });
});

// ------------------------------------------------------------------ runKpiPipeline

describe('AI-2: library ids across batches, and results left without suggestions', () => {
  /** Every result ranks the same 8 entries the same way (the old fixture): only the earlier batch keeps them. */
  function sharedRetrieval(ctx: ProjectContext): RetrievalResult {
    const ranked: RankedCandidate[] = POOL.slice(0, 8).map((entry, i) => ({ entry, score: 1 - i / 100 }));
    return { ...retrievalFor(ctx), byResult: new Map(ctx.resultsChain.map(res => [res.id, ranked])) };
  }

  it('an entry ranked for results of two batches is offered only in the batch where it ranks best', async () => {
    const ctx = context();
    const fake = fakeModelCaller();
    await callModelForResults(ctx, sharedRetrieval(ctx), { callModel: fake.caller, now: () => new Date() }, opts());
    expect(fake.requests).toHaveLength(2);
    const offered = fake.requests.map(q => new Set(Object.values(q.meta.candidateIdsByResult).flat()));
    expect([...offered[0]].filter(id => offered[1].has(id))).toEqual([]);

    // The batch where the entry scores best keeps it; within a batch every result keeps its list.
    const [a, b] = POOL;
    const byResult = new Map<string, RankedCandidate[]>([
      ['n-o1', [{ entry: a, score: 0.5 }, { entry: b, score: 0.9 }]], ['n-o1.1', [{ entry: a, score: 0.4 }]],
      ['n-o2', [{ entry: a, score: 0.8 }, { entry: b, score: 0.3 }]],
    ]);
    const batches = [[RESULTS[1], RESULTS[3]], [RESULTS[2]]];
    const out = exclusiveCandidates(batches, byResult);
    expect(out.get('n-o1')!.map(c => c.entry.id)).toEqual([b.id]);
    expect(out.get('n-o1.1')!.map(c => c.entry.id)).toEqual([]);
    expect(out.get('n-o2')!.map(c => c.entry.id)).toEqual([a.id]);
    // One batch: nothing changes; excluded ids are removed everywhere.
    expect(exclusiveCandidates([[RESULTS[1], RESULTS[2]]], byResult).get('n-o2')!.map(c => c.entry.id)).toEqual([a.id, b.id]);
    expect(exclusiveCandidates([[RESULTS[1]]], byResult, new Set([b.id])).get('n-o1')!.map(c => c.entry.id)).toEqual([a.id]);
  });

  it('a framework result the model skipped gets one call of its own, without the ids other results keep', async () => {
    const fake = fakeModelCaller(request => {
      const answer = kpiAnswerFromMeta(request);
      return request.meta.batch.length > 1 ? { ...answer, suggestions: answer.suggestions.filter(x => x.resultCode !== 'O1.2') } : answer;
    });
    const out = await runKpiPipeline(context(), deps(fake.caller));
    // O1.2 (skipped by the model) and O2.1 (its keyword candidates are used by other results) get a call each.
    const retries = fake.requests.filter(q => q.meta.batch.length === 1);
    expect(retries.map(q => q.meta.batch[0].code)).toEqual(['O1.2', 'O2.1']);
    expect(retries[0]).toMatchObject({ feature: 'kpi.suggest', ...KPI_CALLS.result });
    const keptElsewhere = new Set(out.suggestions.filter(x => x.resultCode !== 'O1.2').map(x => x.libraryId));
    expect(retries[0].meta.candidateIdsByResult['n-o1.2'].length).toBeGreaterThan(0);
    expect(retries[0].meta.candidateIdsByResult['n-o1.2'].filter(id => keptElsewhere.has(id))).toEqual([]);
    expect(out.suggestions.some(x => x.resultCode === 'O1.2')).toBe(true);
    expect(out.calls).toHaveLength(fake.requests.length);
    expect(out.frameworkWarnings.filter(w => w.code === 'result_empty')).toEqual([]);
  });

  it('a result still without suggestions after its retry gets result_empty; the eval counts it as incomplete', async () => {
    const fake = fakeModelCaller(request => {
      const answer = kpiAnswerFromMeta(request);
      return { ...answer, suggestions: answer.suggestions.filter(x => x.resultCode !== 'O2.1') };
    });
    const out = await runKpiPipeline(context(), deps(fake.caller));
    expect(fake.requests.filter(q => q.meta.batch.length === 1).map(q => q.meta.batch[0].code)).toEqual(['O2.1']);
    expect(out.frameworkWarnings.filter(w => w.code === 'result_empty').map(w => w.params)).toEqual([{ code: 'O2.1' }]);
    expect(out.frameworkWarnings.filter(w => w.code === 'result_failed')).toEqual([]);
  });

  it('no retry without calls left, and none for result scope (an empty result is still reported)', async () => {
    const skipO12 = (request: KpiModelRequest) => {
      const answer = kpiAnswerFromMeta(request);
      return { ...answer, suggestions: answer.suggestions.filter(x => x.resultCode !== 'O1.2') };
    };
    const capped = fakeModelCaller(skipO12);
    const out = await runKpiPipeline(context(), deps(capped.caller), { maxCalls: 2 });
    expect(capped.requests).toHaveLength(2);
    expect(out.frameworkWarnings.filter(w => w.code === 'result_empty').map(w => w.params)).toEqual([{ code: 'O1.2' }, { code: 'O2.1' }]);

    const nothing = fakeModelCaller(() => ({ suggestions: [], frameworkWarnings: [] }));
    const result = await runKpiPipeline(context({ scope: { type: 'result', resultId: 'n-o1' } }), deps(nothing.caller));
    expect(nothing.requests).toHaveLength(1);
    expect(result.frameworkWarnings.filter(w => w.code === 'result_empty').map(w => w.params)).toEqual([{ code: 'O1' }]);
  });
});

describe('runKpiPipeline', () => {
  it('returns the empty result without retrieval, steps or a model call when nothing is in scope (design m4)', async () => {
    const library: LibrarySource = { allEntries: vi.fn(), vectors: vi.fn() };
    const fake = fakeModelCaller();
    const onStep = vi.fn();
    const echoFull = context({
      donorRules: { donorType: 'echo', ...DONOR_RULES.echo },
      scope: { type: 'alternatives', indicatorId: null, suggestionId: 's-1' },
      existingIndicators: [1, 2, 3].map(i => ({ id: `i-${i}`, resultId: 'n-o1', name: `Indicator ${i}`, nameAr: null, level: 'outcome' as const, unit: 'number', libraryId: null, method: 'document_review' as const })),
      alternativesFor: { kind: 'suggestion', id: 's-1', resultId: 'n-o1', name: 'x', nameAr: null, definition: null, unit: 'number', method: null, libraryId: null, reason: 'rejected', rejectReason: 'wording', problems: [] },
    });
    for (const ctx of [context({ scope: { type: 'result', resultId: 'not-in-chain' } }), echoFull]) {
      const out = await runKpiPipeline(ctx, deps(fake.caller, { library }), { onStep });
      expect(out).toEqual(emptyPipelineResult());
    }
    expect(fake.requests).toHaveLength(0);
    expect(library.allEntries).not.toHaveBeenCalled();
    expect(onStep).not.toHaveBeenCalled();
    expect(EMPTY_PIPELINE_RESULT).toEqual(emptyPipelineResult());
    expect(Object.isFrozen(EMPTY_PIPELINE_RESULT.suggestions)).toBe(true);
  });

  it('runs retrieval, model and validation in order and returns validated, ranked suggestions', async () => {
    const steps: KpiRunStep[] = [];
    const progress: Array<{ batchesDone: number; batchesTotal: number }> = [];
    const fake = fakeModelCaller();
    const out = await runKpiPipeline(context(), deps(fake.caller), {
      onStep: s => { steps.push(s); },
      onProgress: p => { progress.push(p); },
      callContext: { organizationId: 'org-1', projectId: 'p-1' },
    });
    expect(steps).toEqual(['retrieval', 'model', 'validation']);
    expect(progress.map(p => p.batchesTotal)).toEqual([2, 2]);
    expect(progress.map(p => p.batchesDone).sort()).toEqual([1, 2]);
    expect(out.retrieval).toBe('keyword');
    expect(out.promptVersion).toBe('kpi-v1');
    expect(out.model).toBe('fake-main-model');
    expect(out.embeddingCalls).toBe(0);
    // Two batch calls, then one call of its own for each result left without a suggestion (AI-2: here O2.1, whose
    // keyword candidates the first batch or O2 already uses).
    expect(fake.requests.slice(0, 2).map(q => q.meta.batch.length).sort()).toEqual([2, 4]);
    expect(fake.requests.slice(2).map(q => q.meta.batch.map(x => x.code))).toEqual([['O2.1']]);
    expect(out.calls).toHaveLength(fake.requests.length);
    expect(out.frameworkWarnings.filter(w => w.code === 'result_empty')).toEqual([]);
    expect(new Set(out.suggestions.map(x => x.resultCode))).toEqual(new Set(RESULTS.map(x => x.code)));
    expect(Object.keys(out.candidateIdsByResult).sort()).toEqual(RESULTS.map(x => x.id).sort());
    expect(out.raw.length).toBeGreaterThan(0);
    expect(out.suggestions.length).toBeGreaterThan(0);
    for (const s of out.suggestions) {
      expect(RESULTS.map(x => x.id)).toContain(s.resultId);
      expect(s.draft.resultId).toBe(s.resultId);
      expect(s.qualityScore).toBeGreaterThanOrEqual(0);
    }
    // rank is 1..n within each result
    const byResult = new Map<string, number[]>();
    for (const s of out.suggestions) byResult.set(s.resultId, [...(byResult.get(s.resultId) ?? []), s.rank]);
    for (const ranks of byResult.values()) expect(ranks).toEqual(ranks.map((_, i) => i + 1));
    // the candidates the model saw came from retrieval
    expect(fake.requests[0].meta.candidates.length).toBeGreaterThan(0);
  });

  it('adds result_failed warnings (code, reason) for failed results and keeps the others', async () => {
    const fake = fakeModelCaller(failWhen(q => q.meta.batch[0].code === 'O2', () => new AiRequestError('kpi.suggest', 529, true, 4)));
    const out = await runKpiPipeline(context(), deps(fake.caller));
    const failed = out.frameworkWarnings.filter(w => w.code === 'result_failed');
    expect(failed.map(w => w.params)).toEqual([{ code: 'O2', reason: 'unavailable' }, { code: 'O2.1', reason: 'unavailable' }]);
    expect(out.suggestions.some(s => s.resultCode === 'O2')).toBe(false);
    expect(out.suggestions.length).toBeGreaterThan(0);
  });

  it('when every result fails, rethrows the last original AiError unchanged (refusal message intact)', async () => {
    const refused = new AiRefusalError('framework.indicators', null);
    const fake = fakeModelCaller(() => { throw refused; });
    const err = await runKpiPipeline(context(), deps(fake.caller), { feature: 'framework.indicators' }).catch(e => e);
    expect(err).toBeInstanceOf(AiRefusalError);
    expect(err.message).toBe('The AI model declined the request (framework.indicators).');
    // 2 batches + 6 single retries, all refused
    expect(fake.requests).toHaveLength(8);
  });

  it('when no call was made (deadline or call budget before the first call), throws KpiPipelineError ai_unavailable', async () => {
    const fake = fakeModelCaller();
    for (const runOpts of [{ maxCalls: 0 }, { deadlineMs: -1 }]) {
      const err = await runKpiPipeline(context(), deps(fake.caller), runOpts).catch(e => e);
      expect(err).toBeInstanceOf(KpiPipelineError);
      expect(err).toBeInstanceOf(AiError);
      expect(err).toMatchObject({ code: 'ai_unavailable', feature: 'kpi.suggest', message: 'The AI did not answer in time (kpi.suggest).' });
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('near-duplicates: with embeddings, a reworded existing indicator is dropped (cosine ≥ 0.92); without, text only', async () => {
    const existingName = 'Average volume of water available per person per day in target households';
    const reworded = 'In target households, average volume of water available per day per person';
    const ctx = context({
      scope: { type: 'result', resultId: 'n-o1' },
      existingIndicators: [{ id: 'i-1', resultId: 'n-o2', name: existingName, nameAr: null, level: 'outcome', unit: 'litres_per_person_per_day', libraryId: null, method: 'hh_survey' }],
    });
    const answer = (): KpiModelAnswer => ({
      suggestions: [rawFromEntry(libraryEntry('WA-03'), 'O1', { libraryId: null, isCustom: true, customReason: 'Project wording.', name: reworded })],
      frameworkWarnings: [],
    });

    const embeddings = fakeEmbeddings();
    const withVectors = await runKpiPipeline(ctx, deps(fakeModelCaller(answer).caller, { embeddings }));
    expect(withVectors.suggestions).toHaveLength(0);
    expect(withVectors.frameworkWarnings.map(w => w.code)).toContain('near_duplicate');
    // the library has no vectors for the fake model, so retrieval made no call; one call for the names
    expect(withVectors.embeddingCalls).toBe(1);
    expect(embeddings.calls).toEqual([{ texts: [reworded, existingName], inputType: 'document' }]);
    expect(withVectors.retrieval).toBe('keyword');
    expect(withVectors.frameworkWarnings.map(w => w.code)).toContain('keyword_fallback');

    const textOnly = await runKpiPipeline(ctx, deps(fakeModelCaller(answer).caller));
    expect(textOnly.suggestions.map(s => s.name)).toEqual([reworded]);
    expect(textOnly.embeddingCalls).toBe(0);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = fakeEmbeddings({ fail: new EmbeddingError('Voyage embeddings request timed out after 8000 ms') });
    const fallback = await runKpiPipeline(ctx, deps(fakeModelCaller(answer).caller, { embeddings: failing }));
    expect(fallback.suggestions.map(s => s.name)).toEqual([reworded]);
    expect(fallback.embeddingCalls).toBe(1);
  });

  it('redacts suggestion names before they are embedded', async () => {
    const ctx = context({
      scope: { type: 'result', resultId: 'n-o1' },
      existingIndicators: [{ id: 'i-1', resultId: 'n-o2', name: 'Number of hygiene sessions held', nameAr: null, level: 'outcome', unit: 'number', libraryId: null, method: 'document_review' }],
    });
    const embeddings = fakeEmbeddings();
    const answer = (): KpiModelAnswer => ({
      suggestions: [rawFromEntry(libraryEntry('WA-03'), 'O1', { name: 'Households reached, contact 0599123456' })], frameworkWarnings: [],
    });
    await runKpiPipeline(ctx, deps(fakeModelCaller(answer).caller, { embeddings }));
    expect(JSON.stringify(embeddings.calls)).not.toContain('0599123456');
    expect(embeddings.calls[0].texts[0]).toContain('[phone removed]');
  });

  it('uses the vector path when every entry has a stored vector for the provider model, and counts every embed call', async () => {
    const entries = libraryEntries();
    const byId = new Map(entries.map(e => [e.id, fakeVector(`${e.name} ${e.definition}`)]));
    const embeddings = fakeEmbeddings();
    const ctx = context({
      existingIndicators: [{ id: 'i-1', resultId: 'n-o2', name: 'Number of hygiene sessions held', nameAr: null, level: 'outcome', unit: 'number', libraryId: null, method: 'document_review' }],
    });
    const out = await runKpiPipeline(ctx, deps(fakeModelCaller().caller, { embeddings, library: memoryLibrarySource(entries, { model: 'fake-embed', byId }) }));
    expect(out.retrieval).toBe('vector');
    expect(embeddings.calls.map(c => c.inputType)).toEqual(['query', 'document']);
    expect(out.embeddingCalls).toBe(2);
  });

  it('alternatives use the fast tier and never offer the source library id', async () => {
    const ctx = context({
      scope: { type: 'alternatives', indicatorId: 'i-1', suggestionId: null },
      existingIndicators: [{ id: 'i-1', resultId: 'n-o1', name: 'Average litres per person per day reach 15', nameAr: null, level: 'outcome', unit: 'litres_per_person_per_day', libraryId: 'WA-01', method: 'hh_survey' }],
      alternativesFor: { kind: 'indicator', id: 'i-1', resultId: 'n-o1', name: 'Average litres per person per day reach 15', nameAr: null, definition: null, unit: 'litres_per_person_per_day', method: 'hh_survey', libraryId: 'WA-01', reason: 'weak', rejectReason: null, problems: ['Move the target out of the name.'] },
    });
    const fake = fakeModelCaller();
    const out = await runKpiPipeline(ctx, deps(fake.caller));
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ feature: 'kpi.alternatives', tier: 'fast' });
    expect(fake.requests[0].meta.candidates.map(e => e.id)).not.toContain('WA-01');
    expect(out.suggestions.every(s => s.libraryId !== 'WA-01')).toBe(true);
    expect(out.suggestions.length).toBeLessThanOrEqual(3);
  });
});

// ------------------------------------------------------------------ through the real client (fake SDK)

describe('runKpiPipeline through the real client with a fake Anthropic SDK', () => {
  const SHARED = loadSharedSystemPrompt();

  /** Answers every KPI request from its SUGGEST FOR lines (two candidates per result). */
  function answerFromPrompt(body: Record<string, any>): KpiModelAnswer {
    const lines = suggestForLines(body.messages[0].content as string);
    return {
      suggestions: lines.flatMap(line => line.candidates.slice(0, 2).map(id => rawFromEntry(libraryEntry(id), line.code, { level: line.level as 'outcome' }))),
      frameworkWarnings: [],
    };
  }

  function logger() {
    const records: AiCallRecord[] = [];
    return { records, logCall: async (record: AiCallRecord) => { records.push(record); return `call-${records.length}`; } };
  }

  it('sends output_config.format from KPI_SUGGESTIONS_SCHEMA, the cached system prompt then KPI_SYSTEM, and the tier per scope', async () => {
    const sdk = fakeSdk(body => rawMessage(body.model, answerFromPrompt(body)));
    const log = logger();
    configureAiClientForTests({ anthropic: sdk.client, logCall: log.logCall });
    const out = await runKpiPipeline(context(), deps(defaultModelCaller), { callContext: { organizationId: 'org-1', projectId: 'p-1' } });

    // Two batches, then the AI-2 retry of a result left without a suggestion (one result per call).
    expect(sdk.sent.length).toBeGreaterThanOrEqual(2);
    expect(sdk.sent.slice(2).every(q => suggestForLines(q.body.messages[0].content).length === 1)).toBe(true);
    const schema = outputJsonSchema(KPI_SUGGESTIONS_SCHEMA);
    for (const request of sdk.sent) {
      expect(request.body.output_config.format).toEqual({ type: 'json_schema', schema });
      expect(request.body.system).toEqual([
        { type: 'text', text: SHARED.text, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: KPI_SYSTEM },
      ]);
      expect(request.body.model).toBe(resolveModel('main'));
      expect(request.body.messages).toHaveLength(1);
    }
    const sizes = sdk.sent.slice(0, 2).map(q => suggestForLines(q.body.messages[0].content).length).sort();
    expect(sizes).toEqual([2, 4]);
    const big = sdk.sent.find(q => suggestForLines(q.body.messages[0].content).length === 4)!;
    expect(big.body.max_tokens).toBe(KPI_CALLS.batch.maxTokens);
    expect(big.options?.timeout).toBe(KPI_CALLS.batch.timeoutMs);
    expect(log.records.map(x => [x.feature, x.promptVersion, x.status, x.organizationId, x.projectId]))
      .toEqual(sdk.sent.map(() => ['kpi.suggest', 'kpi-v1', 'success', 'org-1', 'p-1']));
    expect(out.model).toBe(resolveModel('main'));
    expect(out.calls.every(c => c.aiCallId?.startsWith('call-'))).toBe(true);
    expect(out.suggestions.length).toBeGreaterThan(0);

    const altSdk = fakeSdk(body => rawMessage(body.model, answerFromPrompt(body)));
    configureAiClientForTests({ anthropic: altSdk.client, logCall: logger().logCall });
    const altCtx = context({
      scope: { type: 'alternatives', indicatorId: null, suggestionId: 's-1' },
      alternativesFor: { kind: 'suggestion', id: 's-1', resultId: 'n-o1', name: 'Number of jerrycans', nameAr: null, definition: null, unit: 'number', method: 'document_review', libraryId: null, reason: 'rejected', rejectReason: 'not_relevant', problems: [] },
    });
    await runKpiPipeline(altCtx, deps(defaultModelCaller));
    expect(altSdk.sent).toHaveLength(1);
    expect(altSdk.sent[0].body.model).toBe(resolveModel('fast'));
    expect(altSdk.sent[0].body.max_tokens).toBe(KPI_CALLS.alternatives.maxTokens);
  });

  it('a batch cut off twice (the client retries at 2×) is split per result and the run completes', async () => {
    const sdk = fakeSdk(body => {
      const lines = suggestForLines(body.messages[0].content);
      return lines.length > 1 ? truncatedMessage(body.model) : rawMessage(body.model, answerFromPrompt(body));
    });
    configureAiClientForTests({ anthropic: sdk.client, logCall: logger().logCall });
    const ctx = context({ resultsChain: RESULTS.slice(0, 2).concat(RESULTS.slice(3, 4)) });
    const out = await runKpiPipeline(ctx, deps(defaultModelCaller));
    // 1 batch request + its 2× retry, then 3 single results (and any AI-2 retry of a result left without a suggestion)
    expect(sdk.sent.length).toBeGreaterThanOrEqual(5);
    expect(sdk.sent[1].body.max_tokens).toBe(2 * KPI_CALLS.batch.maxTokens);
    expect(out.calls.slice(0, 4).map(c => c.outcome)).toEqual(['truncated', 'success', 'success', 'success']);
    expect(out.calls.slice(4).every(c => c.outcome === 'success' && c.resultCodes.length === 1)).toBe(true);
    // AI-4: the truncated call is billed: its tokens (both attempts) and cost are on the call info, with its AiCall id.
    expect(out.calls[0]).toMatchObject({ outcome: 'truncated', outputTokens: 12_000, aiCallId: expect.stringMatching(/^call-/) });
    expect(out.calls[0].estimatedCostUsd).toBeGreaterThan(0);
    expect(out.frameworkWarnings.filter(w => w.code === 'result_failed')).toEqual([]);
    expect(new Set(out.raw.map(s => s.resultCode))).toEqual(new Set(['G', 'O1', 'O1.1']));
    expect(out.suggestions.length).toBeGreaterThan(0);
  });

  it('a refusal on the only result fails the run with the original AiRefusalError', async () => {
    const sdk = fakeSdk(body => refusalMessage(body.model, 'general_harms'));
    configureAiClientForTests({ anthropic: sdk.client, logCall: logger().logCall });
    const err = await runKpiPipeline(context({ scope: { type: 'result', resultId: 'n-o1' } }), deps(defaultModelCaller)).catch(e => e);
    expect(err).toBeInstanceOf(AiRefusalError);
    expect(err.message).toBe('The AI model declined the request (kpi.suggest, category general_harms).');
  });

  it('a 401 from the API stops the run at once', async () => {
    const sdk = fakeSdk(() => sdkError(401));
    configureAiClientForTests({ anthropic: sdk.client, logCall: logger().logCall });
    const err = await runKpiPipeline(context({ resultsChain: BIG_CHAIN }), deps(defaultModelCaller)).catch(e => e);
    expect(err).toBeInstanceOf(AiRequestError);
    expect(err.status).toBe(401);
    expect(sdk.sent.length).toBeLessThanOrEqual(KPI_BATCH_CONCURRENCY);
  });
});

// ------------------------------------------------------------------ production dependencies

describe('production pipeline dependencies (deps.ts)', () => {
  it('query embeddings: no Voyage key → the no-op provider; a key → Voyage with an 8 s timeout and 1 retry (SDA-17)', () => {
    env.voyageApiKey = '';
    expect(queryEmbeddingProvider()).toBeInstanceOf(NoopEmbeddingProvider);
    env.voyageApiKey = 'voyage-test-placeholder';
    env.voyageModel = 'voyage-4-lite';
    const provider = queryEmbeddingProvider() as VoyageEmbeddingProvider;
    expect(provider).toBeInstanceOf(VoyageEmbeddingProvider);
    expect(provider).toMatchObject({ model: 'voyage-4-lite', timeoutMs: QUERY_EMBEDDING_TIMEOUT_MS, maxRetries: QUERY_EMBEDDING_MAX_RETRIES });
    expect([QUERY_EMBEDDING_TIMEOUT_MS, QUERY_EMBEDDING_MAX_RETRIES]).toEqual([8_000, 1]);
  });

  it('wires the database library source, the query provider, the real model caller and the clock (nothing is queried)', () => {
    env.voyageApiKey = '';
    const d = productionPipelineDeps();
    expect(d.callModel).toBe(defaultModelCaller);
    expect(d.embeddings).toBeInstanceOf(NoopEmbeddingProvider);
    expect(typeof d.library.allEntries).toBe('function');
    expect(typeof d.library.vectors).toBe('function');
    expect(Math.abs(d.now().getTime() - Date.now())).toBeLessThan(1000);
  });
});
