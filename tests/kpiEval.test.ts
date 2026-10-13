import fs from 'fs';
import os from 'os';
import nodePath from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The KPI Assistant evaluation harness (knowledge/kpi-assistant-spec.md §A8; design section 10.4): assertion checkers,
 * the independent metrics, the summary and its target flags, the cases file, the fake model, the runner on all 8 real
 * cases, the report and the CLI (refusals, and --fake end to end with no database access). No network, no key, no
 * database: the Prisma client of this file is a trap that records any use.
 */

// tests/setup.ts answers runKpiPipeline with an empty result for route tests; the evaluation runs the real pipeline.
vi.unmock('../src/services/kpi/pipeline');

/** Every use of the Prisma client in this file (the evaluation must never touch a database; design 10.1, SDA-09). */
const { prismaUses, prismaTrap } = vi.hoisted(() => {
  const uses: string[] = [];
  const trap: unknown = new Proxy({}, {
    get(_target, property) {
      if (typeof property === 'symbol' || property === 'then') return undefined;
      uses.push(String(property));
      return new Proxy(() => undefined, {
        get: (_fn, inner) => (typeof inner === 'symbol' ? undefined : (...args: unknown[]) => { uses.push(`${String(property)}.${String(inner)}`); return Promise.reject(new Error(`database used in the evaluation (${args.length} args)`)); }),
        apply: () => { uses.push(`${String(property)}()`); return Promise.reject(new Error('database used in the evaluation')); },
      });
    },
  });
  return { prismaUses: uses, prismaTrap: trap };
});
vi.mock('../src/config/prisma', () => ({ prisma: prismaTrap, prismaLogLevels: () => ['warn'] }));

import { AiInvalidOutputError, AiRefusalError } from '../src/services/ai/errors';
import { NoopEmbeddingProvider } from '../src/services/ai/embeddingProviders';
import { configureAiClientForTests, resetAiClientForTests, setAiCallLogger, type AiCallRecord } from '../src/services/ai/client';
import { outputJsonSchema } from '../src/services/ai/outputSchema';
import { KPI_PROMPT_VERSION, KPI_SUGGESTIONS_SCHEMA, KPI_SYSTEM } from '../src/services/ai/prompts/kpi';
import { defaultModelCaller } from '../src/services/kpi/callModel';
import { runKpiPipeline } from '../src/services/kpi/pipeline';
import { fileLibrarySource } from '../src/services/kpi/librarySource';
import { loadLibraryFile } from '../src/services/library/load';
import type { KpiCallInfo, KpiPipelineDeps, ModelCaller, ValidatedSuggestion } from '../src/services/kpi/types';
import { checkAssertions, failAllAssertions } from '../src/services/kpi/eval/assertions';
import { caseToContext, firstOutcome, loadEvalCases, type EvalCase } from '../src/services/kpi/eval/cases';
import {
  FAKE_HALLUCINATED_VALUE, FAKE_KPI_MODEL, FAKE_UNKNOWN_LIBRARY_ID, accountabilityRequests, fakeKpiModelCaller, firstTargetFactNumber,
} from '../src/services/kpi/eval/fakeModel';
import {
  DEFAULT_EVAL_TARGETS, baselinesFromTargetSentences, evalPassed, hallucinatedTargets, summarise, thresholdsOutsideList, valueInFactsIndependent,
  type EvalCaseRun,
} from '../src/services/kpi/eval/metrics';
import { formatSummaryTable, formatTable, reportFileName, writeReport } from '../src/services/kpi/eval/report';
import { runEval } from '../src/services/kpi/eval/runner';
import {
  EVAL_DATABASE_PLACEHOLDER, EXIT_FAILED, EXIT_PASSED, EXIT_REFUSED, FAKE_EVAL_API_KEY, evalRefusal, parseEvalArgs, prepareEvalEnvironment, selectCases,
  systemPromptVersionOf,
} from '../scripts/eval-kpi';
import { fakeSdk, libraryEntry, rawFromEntry, rawMessage, suggestForLines, truncatedMessage } from './aiFakes';
import { kpiValidatedSuggestionFixture } from './helpers';

const { cases: CASES, version: CASES_VERSION } = loadEvalCases();
const caseById = (id: string): EvalCase => CASES.find(c => c.id === id)!;
const CASE_01 = caseById('CASE-01-GAZA-WASH-ECHO');
const CASE_02 = caseById('CASE-02-HEBRON-YOUTH-EU');

/** Looks like an Anthropic key to the placeholder check; built at runtime, it is no real key. */
const REAL_LOOKING_KEY = ['sk', 'ant', 'api03', 'Ev4'.repeat(30)].join('-');

/** A validated suggestion for result `code` (the shared fixture), with overrides. */
function vs(code: string, overrides: Partial<ValidatedSuggestion> = {}): ValidatedSuggestion {
  const level = code === 'G' ? 'impact' : code.includes('.') ? 'output' : 'outcome';
  return kpiValidatedSuggestionFixture({ id: code, code, level }, undefined, overrides);
}

function call(overrides: Partial<KpiCallInfo> = {}): KpiCallInfo {
  return {
    feature: 'kpi.suggest', tier: 'main', model: 'claude-sonnet-5-5', promptVersion: KPI_PROMPT_VERSION, resultCodes: ['O1'], outcome: 'success',
    inputTokens: 1000, outputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0.02, latencyMs: 8_000, aiCallId: null,
    ...overrides,
  };
}

function caseRun(overrides: Partial<EvalCaseRun> = {}): EvalCaseRun {
  return {
    id: 'CASE-X', error: null, suggestions: [vs('O1', { libraryId: 'WA-01', isCustom: false })], frameworkWarnings: [],
    assertions: [{ type: 'maxPerResult', key: null, passed: true, detail: '' }], rawCount: 1, hallucinatedBefore: 0, hallucinatedAfter: 0,
    baselinesFromTargetSentences: 0, thresholdsOutsideList: 0, candidateIdsByResult: { O1: ['WA-01'] }, calls: [call({ resultCodes: ['O1', 'O1.1'], latencyMs: 20_000 })],
    resultCalls: [call()], resultRawCount: 3,
    ...overrides,
  };
}

const fakeDeps = (callModel: ModelCaller = fakeKpiModelCaller()): KpiPipelineDeps => ({
  library: fileLibrarySource(), embeddings: new NoopEmbeddingProvider(), callModel, now: () => new Date(),
});

const quiet = () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
};

afterEach(() => {
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------ cases

describe('loadEvalCases and caseToContext', () => {
  it('loads the 8 cases of knowledge/kpi-eval-cases.json', () => {
    expect(CASES_VERSION).toBe('1.0.0');
    expect(CASES.map(c => c.id)).toEqual([
      'CASE-01-GAZA-WASH-ECHO', 'CASE-02-HEBRON-YOUTH-EU', 'CASE-03-JENIN-MHPSS-UNICEF', 'CASE-04-JORDAN-VALLEY-AGRI-GIZ',
      'CASE-05-GAZA-FOOD-WFP', 'CASE-06-NABLUS-EDUCATION', 'CASE-07-RAMALLAH-WEE', 'CASE-08-MUNICIPAL-GOVERNANCE',
    ]);
    expect(CASE_01.assertions).toMatchObject({ maxPerResult: 3, hasAccountabilityIndicator: true, mustIncludeLibraryIdForResult: { O1: ['WA-01', 'WA-02', 'WA-03'] } });
  });

  it('rejects a bad file: unknown assertion types, unknown parents, unknown result keys and unreadable files', () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'kpi-eval-cases-'));
    const write = (data: unknown) => {
      const file = nodePath.join(dir, `cases-${Math.random().toString(36).slice(2)}.json`);
      fs.writeFileSync(file, JSON.stringify(data));
      return file;
    };
    const base = JSON.parse(fs.readFileSync(nodePath.resolve(__dirname, '../knowledge/kpi-eval-cases.json'), 'utf8'));
    const withCase = (change: (c: any) => void) => {
      const copy = structuredClone(base);
      change(copy.cases[0]);
      return write(copy);
    };
    expect(() => loadEvalCases(withCase(c => { c.assertions.mustBeBrilliant = true; }))).toThrow(/assertions: Unrecognized key/);
    expect(() => loadEvalCases(withCase(c => { c.resultsChain[1].parentId = 'NOPE'; }))).toThrow(/names unknown result NOPE/);
    expect(() => loadEvalCases(withCase(c => { c.assertions.mustIncludeLibraryIdForResult = { O9: ['WA-01'] }; }))).toThrow(/O9: is not a result id/);
    expect(() => loadEvalCases(withCase(c => { c.project.donorType = 'martian'; }))).toThrow(/project\.donorType/);
    expect(() => loadEvalCases(withCase(c => { c.resultsChain[0].level = 'activity'; }))).toThrow(/resultsChain\.0\.level/);
    expect(() => loadEvalCases(write({ meta: { version: '1' }, cases: [] }))).toThrow(/at least one case/);
    expect(() => loadEvalCases(nodePath.join(dir, 'missing.json'))).toThrow(/Cannot read the evaluation cases \(missing\.json\): ENOENT/);
    fs.writeFileSync(nodePath.join(dir, 'broken.json'), '{ not json');
    expect(() => loadEvalCases(nodePath.join(dir, 'broken.json'))).toThrow(/Cannot read the evaluation cases/);
  });

  it('builds the case context: codes as ids, display order, fact kinds from cue words, one document text per excerpt, donor rules', () => {
    const ctx = caseToContext(CASE_01);
    expect(ctx.scope).toEqual({ type: 'framework' });
    expect(ctx.resultsChain.map(r => [r.id, r.code, r.level, r.parentId])).toEqual([
      ['G', 'G', 'impact', null], ['O1', 'O1', 'outcome', 'G'], ['O2', 'O2', 'outcome', 'G'], ['O1.1', 'O1.1', 'output', 'O1'], ['O2.1', 'O2.1', 'output', 'O2'],
    ]);
    expect(ctx.documentFacts).toEqual([{ documentId: 'doc1', fileName: 'proposal.pdf', excerpt: CASE_01.documentFacts[0].excerpt, kind: 'target' }]);
    expect(ctx.documentTexts).toEqual([{ documentId: 'doc1', fileName: 'proposal.pdf', text: CASE_01.documentFacts[0].excerpt }]);
    expect(ctx.donorRules).toMatchObject({ donorType: 'echo', maxIndicatorsPerResult: 3 });
    expect(ctx).toMatchObject({ existingIndicators: [], pendingSuggestions: [], alternativesFor: null, orgPreferences: { rejectedLibraryIds: [], preferredMethods: [] } });
    expect(ctx.project).toMatchObject({ id: CASE_01.id, humanitarian: true, startDate: '2026-11-01', endDate: '2027-10-31', targetBeneficiaries: 24000 });
    expect(caseToContext(CASE_01, { type: 'result', resultId: 'O1' }).scope).toEqual({ type: 'result', resultId: 'O1' });
    expect(firstOutcome(CASE_01)?.id).toBe('O1');
    expect(caseToContext(caseById('CASE-03-JENIN-MHPSS-UNICEF')).documentFacts).toEqual([]);
  });
});

// ------------------------------------------------------------------ metrics

describe('valueInFactsIndependent, hallucinatedTargets and baselinesFromTargetSentences', () => {
  const facts = (...excerpts: string[]) => excerpts.map(excerpt => ({ excerpt }));

  it('finds a value only where it stands alone (digits and separators), with Arabic-Indic digits normalised', () => {
    expect(valueInFactsIndependent('22', facts('The survey found 22.5% of households'))).toBe(false);
    expect(valueInFactsIndependent('22.5%', facts('The survey found 22.5% of households'))).toBe(true);
    expect(valueInFactsIndependent('4', facts('There are 42 schools'))).toBe(false);
    expect(valueInFactsIndependent('4', facts('distribute 4,000 hygiene kits'))).toBe(false);
    expect(valueInFactsIndependent('4,000', facts('distribute 4,000 hygiene kits'))).toBe(true);
    expect(valueInFactsIndependent('١٢', facts('١٢ مدرسة في المحافظة'))).toBe(true);
    expect(valueInFactsIndependent('12', facts('١٢ مدرسة في المحافظة'))).toBe(true);
    expect(valueInFactsIndependent('12.5%', facts('١٢٫٥٪ من الأسر'))).toBe(true);
    expect(valueInFactsIndependent('75', facts('the target is 75.'))).toBe(true);
    expect(valueInFactsIndependent('60%', facts('Target: 900 youth (50% women) complete training; 60% employed within six months.'))).toBe(true);
    expect(valueInFactsIndependent('', facts('anything 5'))).toBe(false);
    expect(valueInFactsIndependent('18', [])).toBe(false);
  });

  it('counts document targets and baselines whose value no fact holds, raw and validated alike', () => {
    const f = facts(CASE_01.documentFacts[0].excerpt);
    expect(hallucinatedTargets([
      { targetBasis: 'document', targetSuggestion: '18', baselineBasis: 'none', baselineSuggestion: '' },
      { targetBasis: 'document', targetSuggestion: '80%', baselineBasis: 'document', baselineSuggestion: '35%' },
      { targetBasis: 'method_only', targetSuggestion: '90', baselineBasis: 'none', baselineSuggestion: '' },
      { targetBasis: 'document', targetSuggestion: '', baselineBasis: 'document', baselineSuggestion: '  ' },
    ], f)).toBe(2);
  });

  it('counts document baselines taken from target-only sentences (CASE-01: "18" is a target)', () => {
    const f = facts(...CASE_01.documentFacts.map(x => x.excerpt));
    expect(baselinesFromTargetSentences([vs('O1.1', { baselineBasis: 'document', baselineSuggestion: '18' })], f)).toBe(1);
    // A sentence with a baseline word, or a value from a baseline sentence, is not counted.
    const mixed = facts('The 2025 baseline survey found 45% of households treat water; the target is 75% by 2027.');
    expect(baselinesFromTargetSentences([vs('O1', { baselineBasis: 'document', baselineSuggestion: '45%' })], mixed)).toBe(0);
    expect(baselinesFromTargetSentences([vs('O1', { baselineBasis: 'document', baselineSuggestion: '22%' })], facts('Currently 22% of households have soap.'))).toBe(0);
    expect(baselinesFromTargetSentences([vs('O1', { baselineBasis: 'document', baselineSuggestion: '٣٠' })], facts('سيتم تدريب ٣٠ معلمًا'))).toBe(1);
    expect(baselinesFromTargetSentences([vs('O1', { baselineBasis: 'none', baselineSuggestion: '' })], f)).toBe(0);
  });

  it('SPEC-2: counts the target of "from X to Y" and plans after "currently"; not the X of "from X to Y" or "up from X"', () => {
    const base = (value: string, ...excerpts: string[]) => baselinesFromTargetSentences([vs('O1', { baselineBasis: 'document', baselineSuggestion: value })], facts(...excerpts));
    const logframe = 'The target is to raise the share of households treating water from 30% at baseline to 60% by the end of 2027.';
    expect(base('60%', logframe)).toBe(1);
    expect(base('30%', logframe)).toBe(0);
    const upFrom = 'By the end of the project, 75% of households, up from 45% in the 2025 survey, will treat their drinking water.';
    expect(base('75%', upFrom)).toBe(1);
    expect(base('45%', upFrom)).toBe(0);
    expect(base('600', 'The organisation currently plans to train 600 young women and men in Hebron.')).toBe(1);
    expect(base('450', 'As of the end of year two, 450 graduates will have found work.')).toBe(1);
  });

  it('re-check SPEC-2: counts plans after a time cue without a comma; never a dated comparison point', () => {
    const base = (value: string, ...excerpts: string[]) => baselinesFromTargetSentences([vs('O1', { baselineBasis: 'document', baselineSuggestion: value })], facts(...excerpts));
    expect(base('450', 'As of the end of year two 450 graduates will have found work.')).toBe(1);
    expect(base('600', 'Currently 600 young people are planned to be trained.')).toBe(1);
    expect(base('600', 'The organisation currently intends to train 600 young people.')).toBe(1);
    expect(base('45%', 'Currently 45% of households have an acceptable FCS and the project will raise this to 70% by 2027.')).toBe(0);
    for (const text of [
      'By 2027, 75% of households will have acceptable FCS compared with 45% in 2025.',
      'By 2027, 75% of households will have acceptable FCS against 45% in 2025.',
      'The project will raise acceptable FCS to 75% (45% in 2025).',
      'Acceptable FCS was 45% in 2025 and the project will raise it to 75% by 2027.',
    ]) {
      expect(base('45%', text), text).toBe(0);
      expect(base('75%', text), text).toBe(1);
    }
  });

  it('SPEC-1: counts standard-threshold targets that are not a recognised threshold of their library entry', () => {
    expect(thresholdsOutsideList([
      vs('O1', { libraryId: 'WA-01', targetBasis: 'standard_threshold', targetSuggestion: '15' }),
      vs('O1', { libraryId: 'WA-01', targetBasis: 'standard_threshold', targetSuggestion: '20 l/p/d' }),
      vs('O1', { libraryId: 'FS-01', targetBasis: 'standard_threshold', targetSuggestion: '35' }),
      vs('O1', { libraryId: 'AC-01', targetBasis: 'standard_threshold', targetSuggestion: '2024' }),
      vs('O1', { libraryId: null, targetBasis: 'standard_threshold', targetSuggestion: '15' }),
      vs('O1', { libraryId: 'FS-01', targetBasis: 'method_only', targetSuggestion: '35' }),
    ])).toBe(3);
    const summary = summarise([caseRun({ thresholdsOutsideList: 2 })]);
    expect(summary).toMatchObject({ thresholdsOutsideList: 2, passed: { thresholds: false } });
    expect(evalPassed(summary)).toBe(false);
  });
});

describe('summarise and the target flags', () => {
  it('passes every target for a clean run', () => {
    const summary = summarise([caseRun(), caseRun({ id: 'CASE-Y' })]);
    expect(summary).toMatchObject({
      status: 'complete', incompleteReasons: [], caseCount: 2, calls: { success: 4, invalid: 0, truncated: 0, refused: 0, error: 0 },
      schemaValidity: 1, assertions: { passed: 2, total: 2, rate: 1 }, libraryUsage: 1, avgQuality: 100, costUsd: 0.08,
      outputTokensPerSuggestion: 300, resultLatency: { p50Ms: 8_000, maxMs: 8_000 }, batchLatency: { p50Ms: 20_000, maxMs: 20_000 },
    });
    expect(Object.values(summary.passed).every(Boolean)).toBe(true);
    expect(evalPassed(summary)).toBe(true);
  });

  it('counts a cut-off or invalid answer against schema validity, but not a refusal or an error (they make the run incomplete)', () => {
    const summary = summarise([caseRun({ calls: [call(), call({ outcome: 'truncated' }), call({ outcome: 'invalid' }), call({ outcome: 'refused' }), call({ outcome: 'error' })] })]);
    // success 2 (with the result-scope call) / (success 2 + invalid 1 + truncated 1).
    expect(summary.schemaValidity).toBe(0.5);
    expect(summary.passed.schemaValidity).toBe(false);
    expect(summary.status).toBe('incomplete');
    expect(summary.incompleteReasons).toEqual(['1 call(s) refused', '1 call(s) errored']);
  });

  it('library usage and quality count model suggestions only; appended accountability indicators are reported separately', () => {
    const run = caseRun({
      suggestions: [
        vs('O1', { libraryId: 'WA-01', isCustom: false, qualityScore: 70 }),
        vs('O1', { libraryId: null, qualityScore: 80 }),
        vs('O1', { libraryId: 'AC-01', isCustom: false, origin: 'appended_accountability', qualityScore: 100 }),
        // A result without candidates is outside the library-usage denominator.
        vs('O2', { libraryId: null, qualityScore: 90 }),
      ],
      candidateIdsByResult: { O1: ['WA-01'], O2: [] },
    });
    const summary = summarise([run]);
    expect(summary).toMatchObject({ libraryUsage: 0.5, modelSuggestions: 3, appendedAccountability: 1, avgQuality: 80, appendedAvgQuality: 100 });
    expect(summary.passed).toMatchObject({ library: false, quality: true });
    expect(summarise([caseRun({ suggestions: [vs('O1', { qualityScore: 79 })] })]).passed.quality).toBe(false);
  });

  it('flags assertions, hallucinations, baselines from targets and latency against the targets', () => {
    const run = caseRun({
      assertions: Array.from({ length: 10 }, (_, i) => ({ type: 'x', key: null, passed: i < 8, detail: '' })),
      hallucinatedBefore: 3, hallucinatedAfter: 1, baselinesFromTargetSentences: 1,
      resultCalls: [call({ latencyMs: 9_000 }), call({ latencyMs: 16_000 }), call({ latencyMs: 31_000 })],
    });
    const summary = summarise([run]);
    expect(summary.assertions).toEqual({ passed: 8, total: 10, rate: 0.8 });
    expect(summary).toMatchObject({ hallucinatedBefore: 3, hallucinatedAfter: 1, baselinesFromTargetSentences: 1, resultLatency: { p50Ms: 16_000, maxMs: 31_000 } });
    expect(summary.passed).toMatchObject({ assertions: false, hallucinated: false, baselines: false, latency: false });
    // The median alone passes when every call is under 30 s.
    expect(summarise([caseRun({ resultCalls: [call({ latencyMs: 14_000 }), call({ latencyMs: 29_000 })] })]).passed.latency).toBe(true);
    // --no-result-check: latency is not measured and does not fail the run.
    const unmeasured = summarise([caseRun({ resultCalls: [], resultRawCount: 0 })], DEFAULT_EVAL_TARGETS, { resultCheck: false });
    expect(unmeasured).toMatchObject({ latencyMeasured: false, outputTokensPerSuggestion: null, resultLatency: { p50Ms: null, maxMs: null } });
    expect(unmeasured.passed.latency).toBe(true);
    // Measured but without any result-scope call: no latency PASS.
    expect(summarise([caseRun({ resultCalls: [] })]).passed.latency).toBe(false);
  });

  it('a thrown case, a budget stop or a failed result makes the run incomplete, so it never exits 0', () => {
    const threw = summarise([caseRun(), caseRun({ id: 'CASE-Z', error: 'AiRefusalError: declined', suggestions: [], assertions: failAllAssertions(CASE_01, 'case failed') })]);
    expect(threw.status).toBe('incomplete');
    expect(threw.incompleteReasons).toContain('1 case(s) failed');
    expect(threw.assertions).toMatchObject({ passed: 1, total: 10 });
    expect(evalPassed(threw)).toBe(false);

    const budget = summarise([caseRun()], DEFAULT_EVAL_TARGETS, { budgetReachedAfter: 1 });
    expect(budget.incompleteReasons).toEqual(['budget reached after 1 case(s)']);
    expect(evalPassed(budget)).toBe(false);

    const emptyResult = summarise([caseRun({ frameworkWarnings: [{ code: 'result_empty', severity: 'warning', message: '', params: { code: 'O2.1' }, penalty: 0 }] })]);
    expect(emptyResult).toMatchObject({ status: 'incomplete', incompleteReasons: ['1 result(s) without suggestions'] });
    const failedResult = summarise([caseRun({ frameworkWarnings: [{ code: 'result_failed', severity: 'warning', message: '', params: { code: 'O2', reason: 'truncated' }, penalty: 0 }] })]);
    expect(failedResult.incompleteReasons).toEqual(['1 result(s) failed']);
    expect(summarise([]).incompleteReasons).toEqual(['no case ran']);
  });

  it('applies custom targets', () => {
    const summary = summarise([caseRun({ suggestions: [vs('O1', { libraryId: null, qualityScore: 75 })] })], { ...DEFAULT_EVAL_TARGETS, libraryUsage: 0, avgQuality: 70 });
    expect(summary.passed).toMatchObject({ library: true, quality: true });
  });
});

// ------------------------------------------------------------------ assertions

describe('checkAssertions', () => {
  const library = new Map(); // ids are not checked against the library in these cases
  const withAssertions = (assertions: EvalCase['assertions']): EvalCase => ({ ...CASE_01, assertions });
  const only = (c: EvalCase, suggestions: ValidatedSuggestion[]) => checkAssertions(c, suggestions, library);

  it('mustIncludeAnyLibraryIds and mustIncludeLibraryIdForResult (one result per key)', () => {
    const c = withAssertions({ mustIncludeAnyLibraryIds: ['PR-01', 'PR-02'], mustIncludeLibraryIdForResult: { O1: ['WA-01'], 'O1.1': ['WA-06', 'WA-04'] } });
    const passing = only(c, [vs('O2', { libraryId: 'PR-02' }), vs('O1', { libraryId: 'WA-01' }), vs('O1.1', { libraryId: 'WA-04' })]);
    expect(passing.map(r => [r.type, r.key, r.passed])).toEqual([
      ['mustIncludeAnyLibraryIds', null, true], ['mustIncludeLibraryIdForResult', 'O1', true], ['mustIncludeLibraryIdForResult', 'O1.1', true],
    ]);
    // WA-01 suggested for the wrong result does not count for O1.
    const failing = only(c, [vs('O1.1', { libraryId: 'WA-01' }), vs('O1', { libraryId: null })]);
    expect(failing.map(r => r.passed)).toEqual([false, false, false]);
    expect(failing[1].detail).toBe('none of WA-01 among 1 suggestion(s) for O1 (custom)');
  });

  it('levelsPresent and maxPerResult', () => {
    const c = withAssertions({ levelsPresent: ['impact', 'outcome', 'output'], maxPerResult: 2 });
    expect(only(c, [vs('G'), vs('O1'), vs('O1.1')]).every(r => r.passed)).toBe(true);
    const failing = only(c, [vs('O1'), vs('O1'), vs('O1'), vs('O1.1')]);
    expect(failing.map(r => [r.type, r.passed, r.detail])).toEqual([
      ['levelsPresent', false, 'missing impact'], ['maxPerResult', false, 'O1 has 3 (max 2)'],
    ]);
  });

  it('peopleIndicatorsHaveSex: people-level suggestions need sex or sex_of_household_head', () => {
    const c = withAssertions({ peopleIndicatorsHaveSex: true });
    expect(only(c, [vs('O1', { disaggregation: ['sex'] }), vs('O1', { name: 'Number of households with a latrine', disaggregation: ['sex_of_household_head'] })])[0].passed).toBe(true);
    expect(only(c, [vs('O1', { name: 'Number of water points rehabilitated', nameAr: 'عدد نقاط المياه', disaggregation: [] })])[0].passed).toBe(true);
    const failing = only(c, [vs('O1', { disaggregation: ['location'] })]);
    expect(failing[0]).toMatchObject({ passed: false, detail: '1 people-level suggestion(s) without sex: O1#1 (custom)' });
  });

  it('AI-5: peopleIndicatorsHaveSex uses its own people words, so families and adolescents without sex fail', () => {
    const c = withAssertions({ peopleIndicatorsHaveSex: true });
    for (const [name, nameAr] of [
      ['Number of displaced families receiving hygiene kits', 'عدد العائلات النازحة التي تلقت حقائب النظافة'],
      ['Number of adolescents attending hygiene sessions', 'عدد المراهقين الذين حضروا جلسات النظافة'],
      ['Number of IDPs reached', 'عدد النازحين الذين تم الوصول إليهم'],
    ]) {
      expect(only(c, [vs('O1', { name, nameAr, disaggregation: ['location'] })])[0].passed, name).toBe(false);
    }
  });

  it('SPEC-3: noTargetInName uses its own check, so names with a target value or a leading count fail', () => {
    const c = withAssertions({ noTargetInName: true });
    for (const name of ['Number of displaced households receiving food vouchers (target: 3,500)', '3,500 displaced households receiving food vouchers',
      'At least 3,500 households receive food vouchers', 'Number of youth trained, 500 by end of project',
      'Doubling the number of households with acceptable FCS']) {
      expect(only(c, [vs('O1', { name })])[0].passed, name).toBe(false);
    }
    expect(only(c, [vs('O1', { name: 'Number of households with acceptable FCS', nameAr: 'مضاعفة عدد الأسر ذات الاستهلاك الغذائي المقبول' })])[0].passed).toBe(false);
    expect(only(c, [vs('O1', { name: 'Reduced Coping Strategies Index (rCSI) score of target households' })])[0].passed).toBe(true);
    for (const e of loadLibraryFile().entries) expect(only(c, [vs('O1', { name: e.name, nameAr: e.nameAr })])[0].passed, e.id).toBe(true);
  });

  it('noTargetsWithoutBasis uses the independent match on the case facts (targets and baselines)', () => {
    const c = withAssertions({ noTargetsWithoutBasis: true });
    expect(only(c, [vs('O1.1', { targetBasis: 'document', targetSuggestion: '18' }), vs('O1', { targetBasis: 'method_only', targetSuggestion: '75' })])[0].passed).toBe(true);
    expect(only(c, [vs('O1.1', { targetBasis: 'document', targetSuggestion: '1' })])[0].passed).toBe(false);
    expect(only(c, [vs('O1.1', { baselineBasis: 'document', baselineSuggestion: '6' })])[0].passed).toBe(false);
  });

  it('noTargetInName: rule 3, but definitional thresholds pass ("at least 4 antenatal care visits")', () => {
    const c = withAssertions({ noTargetInName: true });
    expect(only(c, [vs('O1', { name: '% of pregnant women receiving at least 4 antenatal care visits' })])[0].passed).toBe(true);
    expect(only(c, [vs('O1', { name: 'Increase to 80% the households with safe water' })])[0].passed).toBe(false);
    expect(only(c, [vs('O1', { name: 'Households with safe water', nameAr: 'زيادة الأسر التي تحصل على المياه الآمنة' })])[0].passed).toBe(false);
  });

  it('hasAccountabilityIndicator follows the spec wording: any AC-* id or a custom accountability indicator; FS-06 and HE-04 alone fail', () => {
    const c = withAssertions({ hasAccountabilityIndicator: true });
    expect(only(c, [vs('O1', { libraryId: 'FS-06' }), vs('O1', { libraryId: 'HE-04' })])[0].passed).toBe(false);
    expect(only(c, [vs('O1', { libraryId: 'AC-06' })])[0].passed).toBe(true);
    expect(only(c, [vs('O1', { libraryId: 'ac-01' })])[0].passed).toBe(true);
    expect(only(c, [vs('O1', { libraryId: null, name: '% of assisted people who know how to make a complaint' })])[0].passed).toBe(true);
    expect(only(c, [vs('O1', { libraryId: null, name: 'Beneficiary rating', nameAr: 'نسبة المستفيدين الذين قدموا شكاوى' })])[0].passed).toBe(true);
    // Accountability wording on a library-linked sector indicator does not count.
    expect(only(c, [vs('O1', { libraryId: 'HE-04', name: '% of patients satisfied with feedback handling' })])[0].passed).toBe(false);
    expect(only(c, [])[0].passed).toBe(false);
  });

  it('AI-5: the validator\'s appended accountability indicator never passes hasAccountabilityIndicator or lifts the quality average', () => {
    const c = withAssertions({ hasAccountabilityIndicator: true, minQualityScoreAverage: 80 });
    const appendedOnly = only(c, [vs('O1', { libraryId: 'WA-02', qualityScore: 70 }), vs('O1', { libraryId: 'AC-01', origin: 'appended_accountability', qualityScore: 100 })]);
    expect(appendedOnly.map(r => [r.type, r.passed])).toEqual([['hasAccountabilityIndicator', false], ['minQualityScoreAverage', false]]);
    expect(appendedOnly[0].detail).toBe('the model suggested none; the validator appended AC-01');
    expect(appendedOnly[1].detail).toBe('average 70.0 (min 80)');
    expect(only(c, [vs('O1', { libraryId: 'AC-03', qualityScore: 90 })]).map(r => r.passed)).toEqual([true, true]);
  });

  it('arabicNamesPresent and minQualityScoreAverage', () => {
    const c = withAssertions({ arabicNamesPresent: true, minQualityScoreAverage: 80 });
    expect(only(c, [vs('O1', { qualityScore: 85 }), vs('O1', { qualityScore: 75 })]).map(r => r.passed)).toEqual([true, true]);
    const failing = only(c, [vs('O1', { nameAr: '' }), vs('O1', { nameAr: 'Water access', qualityScore: 50 })]);
    expect(failing.map(r => [r.type, r.passed])).toEqual([['arabicNamesPresent', false], ['minQualityScoreAverage', false]]);
    expect(failing[0].detail).toBe('2 suggestion(s) without an Arabic name: O1#1 (custom), O1#1 (custom)');
    expect(failing[1].detail).toBe('average 75.0 (min 80)');
    expect(only(c, [])).toEqual([
      { type: 'arabicNamesPresent', key: null, passed: true, detail: 'all 0 suggestion(s) pass' },
      { type: 'minQualityScoreAverage', key: null, passed: false, detail: 'no suggestions' },
    ]);
  });

  it('checks every assertion of a real case, and failAllAssertions reports the same types and keys as failed', () => {
    const results = checkAssertions(CASE_01, [], new Map());
    const failed = failAllAssertions(CASE_01, 'case failed');
    expect(failed.map(r => [r.type, r.key])).toEqual(results.map(r => [r.type, r.key]));
    expect(failed.every(r => !r.passed && r.detail === 'case failed')).toBe(true);
    expect(failed.map(r => r.type)).toEqual([
      'mustIncludeLibraryIdForResult', 'mustIncludeLibraryIdForResult', 'maxPerResult', 'peopleIndicatorsHaveSex', 'noTargetsWithoutBasis',
      'noTargetInName', 'hasAccountabilityIndicator', 'arabicNamesPresent', 'minQualityScoreAverage',
    ]);
  });
});

// ------------------------------------------------------------------ fake model and runner

describe('fakeKpiModelCaller', () => {
  it('reads the first target fact number of the prompt, skipping years', () => {
    expect(firstTargetFactNumber('DOCUMENT FACTS (…)\n[F1 target] proposal.pdf: "The action will rehabilitate 18 community water points and distribute 4,000 hygiene kits."')).toBe('18');
    expect(firstTargetFactNumber('[F1 baseline] a.pdf: "The 2025 survey found 45%."\n[F2 target] b.pdf: "By 2027, 75% of households."')).toBe('75');
    expect(firstTargetFactNumber('[F1 context] a.pdf: "12 municipalities"')).toBeNull();
  });

  it('suggests the top candidates of each result within its allowance (at most 3), never one library id twice, with no cost', async () => {
    quiet();
    const seen: Array<{ codes: string[]; ids: string[] }> = [];
    const fake = fakeKpiModelCaller();
    const spy: ModelCaller = async request => {
      const response = await fake(request);
      seen.push({ codes: request.meta.batch.map(r => r.code), ids: response.data.suggestions.map(s => s.libraryId ?? '') });
      for (const result of request.meta.batch) {
        const own = response.data.suggestions.filter(s => s.resultCode === result.code);
        expect(own.length).toBeLessThanOrEqual(Math.min(3, request.meta.allowances[result.id].max));
        // A candidate of the result, or the accountability id the prompt asks this result for (rule 19).
        const allowed = [...(request.meta.candidateIdsByResult[result.id] ?? []), ...(accountabilityRequests(request.user).get(result.code) ?? [])];
        for (const s of own) expect(allowed).toContain(s.libraryId);
      }
      expect(response).toMatchObject({ model: FAKE_KPI_MODEL, estimatedCostUsd: 0, aiCallId: null, usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } });
      expect(response.usage.outputTokens).toBe(Math.ceil(JSON.stringify(response.data).length / 4));
      return response;
    };
    await runKpiPipeline(caseToContext(CASE_01), fakeDeps(spy));
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) expect(new Set(call.ids).size).toBe(call.ids.length);
  });

  it('deals candidates in rounds, so a shared top candidate goes to the first result and the next one gets its own best', async () => {
    const [outcome, output] = caseToContext(CASE_01).resultsChain.filter(r => r.code === 'O1' || r.code === 'O1.1');
    const ids = ['WA-01', 'WA-02', 'WA-03', 'WA-04', 'WA-06'];
    const response = await fakeKpiModelCaller()({
      feature: 'kpi.suggest', tier: 'main', effort: 'low', maxTokens: 1, timeoutMs: 1, promptVersion: KPI_PROMPT_VERSION, system: '', user: '', context: {},
      meta: {
        scopeType: 'framework', batch: [outcome, output], candidates: ids.map(libraryEntry),
        candidateIdsByResult: { O1: ['WA-01', 'WA-02', 'WA-03'], 'O1.1': ['WA-01', 'WA-04', 'WA-02', 'WA-06'] },
        allowances: { O1: { min: 2, max: 4 }, 'O1.1': { min: 2, max: 2 } },
      },
    });
    expect(response.data.suggestions.map(s => [s.resultCode, s.libraryId])).toEqual([
      ['O1', 'WA-01'], ['O1', 'WA-02'], ['O1', 'WA-03'], ['O1.1', 'WA-04'], ['O1.1', 'WA-06'],
    ]);
  });

  it('refuses every call, or answers invalid output for a multi-result call only, on request', async () => {
    const refusing = fakeKpiModelCaller({ inject: { refuse: true } });
    const invalid = fakeKpiModelCaller({ inject: { invalid: true } });
    const meta = (n: number) => ({
      scopeType: 'framework' as const, batch: caseToContext(CASE_01).resultsChain.slice(0, n), candidateIdsByResult: {}, candidates: [], allowances: {},
    });
    const request = (n: number) => ({
      feature: 'kpi.suggest', tier: 'main' as const, effort: 'low' as const, maxTokens: 1, timeoutMs: 1, promptVersion: KPI_PROMPT_VERSION, system: '', user: '',
      context: {}, meta: meta(n),
    });
    await expect(refusing(request(1))).rejects.toBeInstanceOf(AiRefusalError);
    await expect(invalid(request(2))).rejects.toBeInstanceOf(AiInvalidOutputError);
    await expect(invalid(request(1))).resolves.toMatchObject({ data: { suggestions: [] } });
  });
});

describe('runEval', () => {
  beforeEach(quiet);

  it('runs all 8 real cases with the fake model: schema validity 100%, nothing hallucinated, a report for every case, every target met', async () => {
    const lines: string[] = [];
    const report = await runEval({
      cases: CASES, deps: fakeDeps(), maxUsd: 3, resultCheck: true, now: () => new Date('2026-10-13T08:00:00.000Z'), log: line => lines.push(line),
      info: { mode: 'fake', libraryVersion: '1.0.0', casesFile: { path: 'knowledge/kpi-eval-cases.json', version: CASES_VERSION } },
    });
    expect(report.cases.map(c => c.id)).toEqual(CASES.map(c => c.id));
    expect(report.cases.every(c => c.error === null && c.suggestions.length > 0 && c.calls.length > 0 && c.resultCalls.length === 1)).toBe(true);
    expect(report.summary).toMatchObject({ status: 'complete', schemaValidity: 1, hallucinatedAfter: 0, baselinesFromTargetSentences: 0, costUsd: 0 });
    expect(report.summary.assertions.rate!).toBeGreaterThanOrEqual(0.9);
    expect(evalPassed(report.summary)).toBe(true);
    expect(report).toMatchObject({
      startedAt: '2026-10-13T08:00:00.000Z', mode: 'fake', status: 'complete', promptVersion: KPI_PROMPT_VERSION, retrieval: 'keyword',
      libraryVersion: '1.0.0', casesFile: { version: '1.0.0' }, budgetReachedAfter: null, targets: DEFAULT_EVAL_TARGETS,
    });
    // CASE-01 (DG ECHO, humanitarian): at most 3 per result and an accountability indicator.
    const case01 = report.cases[0];
    expect(case01.assertions.filter(a => ['maxPerResult', 'hasAccountabilityIndicator'].includes(a.type)).every(a => a.passed)).toBe(true);
    // The fake follows the prompt's accountability request, so the model's own suggestion passes (not the appended one).
    expect(case01.suggestions.some(s => s.origin === 'model' && (s.libraryId ?? '').startsWith('AC-'))).toBe(true);
    // The report keeps no drafts (no reference-sheet text beyond the suggestion fields).
    expect(report.cases.every(c => c.suggestions.every(s => !('draft' in s)))).toBe(true);
    expect(lines).toHaveLength(8);
    expect(lines[0]).toMatch(/^\[KpiEval\] CASE-01-GAZA-WASH-ECHO: \d+ suggestion\(s\), \d+\/9 assertions, 3 call\(s\)$/);
  });

  it('a hallucinated document target is counted before validation and removed after it', async () => {
    const report = await runEval({ cases: [CASE_01, CASE_02], deps: fakeDeps(fakeKpiModelCaller({ inject: { hallucinatedTarget: true } })), maxUsd: 3, resultCheck: false, now: () => new Date(), log: () => {} });
    expect(report.summary.hallucinatedBefore).toBeGreaterThan(0);
    expect(report.summary.hallucinatedAfter).toBe(0);
    expect(report.cases.flatMap(c => c.suggestions).some(s => s.targetSuggestion === FAKE_HALLUCINATED_VALUE)).toBe(false);
  });

  it('a target fact copied as a document baseline never survives validation (CASE-01 "18")', async () => {
    const report = await runEval({ cases: [CASE_01], deps: fakeDeps(fakeKpiModelCaller({ inject: { baselineFromTarget: true } })), maxUsd: 3, resultCheck: false, now: () => new Date(), log: () => {} });
    expect(report.cases[0].rawCount).toBeGreaterThan(0);
    expect(report.cases[0].baselinesFromTargetSentences).toBe(0);
    expect(report.cases[0].suggestions.every(s => s.baselineBasis === 'none')).toBe(true);
  });

  it('an unknown library id and a target in the name are caught by validation and the assertions', async () => {
    const report = await runEval({
      cases: [CASE_01], deps: fakeDeps(fakeKpiModelCaller({ inject: { unknownLibraryId: true, targetInName: true } })), maxUsd: 3, resultCheck: false, now: () => new Date(), log: () => {},
    });
    const suggestions = report.cases[0].suggestions;
    expect(suggestions.some(s => s.libraryId === FAKE_UNKNOWN_LIBRARY_ID)).toBe(false);
    expect(suggestions.some(s => s.warnings.some(w => w.code === 'library_id_unknown'))).toBe(true);
    expect(report.cases[0].assertions.find(a => a.type === 'noTargetInName')?.passed).toBe(false);
  });

  it('invalid answers lower schema validity below 100%; refusals fail the cases and the run', async () => {
    const invalid = await runEval({ cases: [CASE_01], deps: fakeDeps(fakeKpiModelCaller({ inject: { invalid: true } })), maxUsd: 3, resultCheck: false, now: () => new Date(), log: () => {} });
    expect(invalid.summary.schemaValidity!).toBeLessThan(1);
    expect(invalid.summary.passed.schemaValidity).toBe(false);
    expect(invalid.cases[0].suggestions.length).toBeGreaterThan(0);

    const refused = await runEval({ cases: [CASE_01, CASE_02], deps: fakeDeps(fakeKpiModelCaller({ inject: { refuse: true } })), maxUsd: 3, resultCheck: true, now: () => new Date(), log: () => {} });
    expect(refused.cases.map(c => c.error)).toEqual([
      'AiRefusalError: The AI model declined the request (kpi.suggest).', 'AiRefusalError: The AI model declined the request (kpi.suggest).',
    ]);
    expect(refused.summary.calls.refused).toBeGreaterThan(0);
    expect(refused.status).toBe('incomplete');
    expect(refused.summary.assertions.passed).toBe(0);
  });

  it('stops starting new cases once the spend reaches the cap', async () => {
    const fake = fakeKpiModelCaller();
    const costly: ModelCaller = async request => ({ ...(await fake(request)), estimatedCostUsd: 1.5 });
    const lines: string[] = [];
    const report = await runEval({ cases: [CASE_01, CASE_02, CASES[2]], deps: fakeDeps(costly), maxUsd: 2, resultCheck: true, now: () => new Date(), log: line => lines.push(line) });
    expect(report.cases.map(c => c.id)).toEqual([CASE_01.id]);
    expect(report.budgetReachedAfter).toBe(1);
    expect(report.status).toBe('incomplete');
    expect(report.summary.costUsd).toBe(4.5);
    expect(lines.at(-1)).toMatch(/budget of US\$2 reached after 1 case\(s\)/);
    expect(evalPassed(report.summary)).toBe(false);
  });

  it('records a non-AI error with its class name only', async () => {
    const leaky: ModelCaller = async () => { throw new TypeError('secret 0599123456'); };
    const report = await runEval({ cases: [CASE_01], deps: fakeDeps(leaky), maxUsd: 3, resultCheck: false, now: () => new Date(), log: () => {} });
    expect(report.cases[0].error).toBe('TypeError (internal error)');
    expect(JSON.stringify(report)).not.toContain('0599123456');
  });
});

describe('the real client path', () => {
  afterEach(() => {
    resetAiClientForTests();
  });

  it('AI-4: a truncated batch counts its tokens and cost in the report and in the --max-usd budget', async () => {
    quiet();
    const records: AiCallRecord[] = [];
    // Multi-result calls are cut off (twice: the client retries at 2×); one-result calls answer with the first candidate.
    const sdk = fakeSdk(body => {
      const lines = suggestForLines(body.messages[0].content as string);
      if (lines.length > 1) return truncatedMessage(body.model);
      const answer = { suggestions: lines.flatMap(l => l.candidates.slice(0, 1).map(id => rawFromEntry(libraryEntry(id), l.code, { level: l.level as 'outcome' }))), frameworkWarnings: [] };
      return rawMessage(body.model, answer, { output: 200 });
    });
    configureAiClientForTests({ anthropic: sdk.client });
    setAiCallLogger(async record => { records.push(record); return null; });

    const report = await runEval({ cases: [CASE_01], deps: fakeDeps(defaultModelCaller), maxUsd: 3, resultCheck: false, now: () => new Date(), log: () => {} });
    const truncated = report.cases[0].calls.filter(c => c.outcome === 'truncated');
    expect(truncated.length).toBeGreaterThan(0);
    for (const call of truncated) {
      expect(call.outputTokens).toBe(12_000);
      expect(call.estimatedCostUsd).toBeGreaterThan(0);
    }
    const billed = records.reduce((n, r) => n + (r.estimatedCostUsd ?? 0), 0);
    expect(report.summary.costUsd).toBeCloseTo(billed, 6);
    expect(report.summary.costUsd).toBeGreaterThan(truncated.length * 0.1);

    // The budget check sees the truncated calls: a cap below their cost stops the next case.
    records.length = 0;
    const capped = await runEval({ cases: [CASE_01, CASE_02], deps: fakeDeps(defaultModelCaller), maxUsd: 0.1, resultCheck: false, now: () => new Date(), log: () => {} });
    expect(capped.budgetReachedAfter).toBe(1);
    expect(capped.cases).toHaveLength(1);
  });

  it('a kpi.suggest call goes through client.ts with output_config.format from KPI_SUGGESTIONS_SCHEMA; setAiCallLogger keeps it off the database', async () => {
    quiet();
    const records: AiCallRecord[] = [];
    const sdk = fakeSdk(() => rawMessage('claude-sonnet-5-5', { suggestions: [], frameworkWarnings: [] }, { output: 50 }));
    configureAiClientForTests({ anthropic: sdk.client });
    setAiCallLogger(async record => { records.push(record); return null; });

    await runKpiPipeline(caseToContext(CASE_01, { type: 'result', resultId: 'O1' }), fakeDeps(defaultModelCaller));

    expect(sdk.sent).toHaveLength(1);
    const body = sdk.sent[0].body;
    expect(body.output_config.format).toEqual({ type: 'json_schema', schema: outputJsonSchema(KPI_SUGGESTIONS_SCHEMA) });
    expect(body.system[1]).toEqual({ type: 'text', text: KPI_SYSTEM });
    expect(records).toEqual([expect.objectContaining({ feature: 'kpi.suggest', promptVersion: KPI_PROMPT_VERSION, status: 'success', outputTokens: 50 })]);
    expect(prismaUses).toEqual([]);

    // null restores the database logger (writeAiCall): with the trapped client the write fails, the call still succeeds.
    setAiCallLogger(null);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runKpiPipeline(caseToContext(CASE_01, { type: 'result', resultId: 'O1' }), fakeDeps(defaultModelCaller));
    expect(records).toHaveLength(1);
    expect(prismaUses).toContain('aiCall.create');
    prismaUses.length = 0;
  });
});

// ------------------------------------------------------------------ report

describe('report', () => {
  it('names the file after the start time and writes it into the directory', () => {
    expect(reportFileName(new Date('2026-10-13T08:00:00.000Z'))).toBe('2026-10-13T08-00-00-000Z.json');
    const dir = nodePath.join(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'kpi-eval-')), 'nested');
    const summary = summarise([caseRun()]);
    const report = {
      startedAt: '2026-10-13T08:00:00.000Z', finishedAt: '2026-10-13T08:01:00.000Z', mode: 'fake' as const, status: summary.status, promptVersion: KPI_PROMPT_VERSION,
      systemPromptVersion: 'system-v1-ab12cd', models: { main: 'm', fast: 'f' }, retrieval: 'keyword' as const, libraryVersion: '1.0.0',
      casesFile: { path: 'knowledge/kpi-eval-cases.json', version: '1.0.0' }, budgetReachedAfter: null,
      cases: [{ ...caseRun(), suggestions: caseRun().suggestions.map(({ draft: _d, ...rest }) => rest) }], summary, targets: DEFAULT_EVAL_TARGETS,
    };
    const file = writeReport(dir, report);
    expect(file).toBe(nodePath.join(dir, '2026-10-13T08-00-00-000Z.json'));
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(report);

    const table = formatSummaryTable(report);
    expect(table.split('\n')[0]).toBe('KPI Assistant evaluation · prompt kpi-v1 · system system-v1-ab12cd · main m · fast f · retrieval keyword · library 1.0.0 · mode fake');
    expect(table).toMatch(/^case\s+suggestions\s+assertions\s+library use\s+avg quality\s+hallucinated \(raw→final\)\s+base←target\s+cost USD\s+result s\s+batch s\s+out tok\/sugg$/m);
    expect(table).toMatch(/^CASE-X\s+1 \(\+0 AC\)\s+1\/1\s+100%\s+100\s+0→0\s+0\s+0\.04\s+8\.0\s+20\.0\s+300$/m);
    expect(table).toMatch(/^total\s+1 \(\+0 AC\)\s+1\/1 100%\s+100%\s+100\s+0→0\s+0\s+0\.04\s+p50 8\.0 \/ max 8\.0/m);
    expect(table).toMatch(/^target\s+≥ 90%\s+≥ 70%\s+≥ 80\s+final 0\s+0\s+—\s+p50 < 15, max < 30$/m);
    expect(table).toContain('result complete · schema validity 100% PASS · assertions PASS · library PASS · hallucinated PASS · baselines PASS · thresholds 0 PASS · quality PASS · latency PASS');
    expect(formatTable(['a', 'bb'], [['1', '2'], ['333', '4']])).toBe('a    bb\n---  --\n1    2\n333  4');
  });
});

// ------------------------------------------------------------------ CLI

describe('scripts/eval-kpi: arguments and refusals', () => {
  it('parses the options strictly', () => {
    expect(parseEvalArgs([])).toEqual({ yes: false, fake: false, cases: [], maxUsd: 3, embeddings: false, resultCheck: true, out: 'eval-results', help: false });
    expect(parseEvalArgs(['--fake', '--case', 'A', '--case', 'B', '--max-usd', '1.5', '--no-result-check', '--out', 'tmp/x'])).toEqual({
      yes: false, fake: true, cases: ['A', 'B'], maxUsd: 1.5, embeddings: false, resultCheck: false, out: 'tmp/x', help: false,
    });
    expect(parseEvalArgs(['--yes', '--embeddings', '-h'])).toMatchObject({ yes: true, embeddings: true, help: true });
    expect(() => parseEvalArgs(['--everything'])).toThrow(/Unknown option/);
    expect(() => parseEvalArgs(['CASE-01'])).toThrow();
    expect(() => parseEvalArgs(['--max-usd', '0'])).toThrow(/positive number/);
    expect(() => parseEvalArgs(['--max-usd', 'lots'])).toThrow(/positive number/);
    expect(() => parseEvalArgs(['--out', ' '])).toThrow(/directory/);
  });

  it('refuses in production, a fake run with embeddings, the real run without a real key or without --yes, and embeddings without a Voyage key', () => {
    const args = (argv: string[]) => parseEvalArgs(argv);
    expect(evalRefusal(args(['--fake']), { NODE_ENV: 'production' })).toMatch(/NODE_ENV is "production"/);
    expect(evalRefusal(args(['--fake', '--embeddings']), { VOYAGE_API_KEY: 'pa-x' })).toMatch(/cannot be combined with --fake/);
    expect(evalRefusal(args(['--yes']), {})).toMatch(/^Refusing to run: ANTHROPIC_API_KEY is not set\./);
    expect(evalRefusal(args(['--yes']), { ANTHROPIC_API_KEY: 'sk-ant-test-not-a-real-key' })).toMatch(/looks like a placeholder/);
    expect(evalRefusal(args(['--yes']), { ANTHROPIC_API_KEY: FAKE_EVAL_API_KEY })).toMatch(/looks like a placeholder/);
    expect(evalRefusal(args([]), { ANTHROPIC_API_KEY: REAL_LOOKING_KEY })).toBe('Refusing to run: this calls the real Anthropic API; about US$1-2 for all 8 cases; re-run with --yes.');
    expect(evalRefusal(args(['--yes', '--embeddings']), { ANTHROPIC_API_KEY: REAL_LOOKING_KEY, VOYAGE_API_KEY: ' ' })).toMatch(/--embeddings needs VOYAGE_API_KEY/);
    expect(evalRefusal(args(['--yes']), { ANTHROPIC_API_KEY: REAL_LOOKING_KEY })).toBeNull();
    expect(evalRefusal(args(['--fake']), {})).toBeNull();
    // A key of another provider is refused, and the key is never echoed.
    const otherProvider = evalRefusal(args(['--yes']), { ANTHROPIC_API_KEY: 'sk-proj-abcdefghijklmnopqrstuvwxyz' });
    expect(otherProvider).toMatch(/^Refusing to run: ANTHROPIC_API_KEY does not look like an Anthropic API key/);
    expect(otherProvider).not.toContain('abcdefghij');
  });

  it('always replaces the database URLs; fills missing JWT secrets; the fake mode gets a placeholder key and a closed port', () => {
    const environment: Record<string, string | undefined> = {
      DATABASE_URL: 'postgresql://raqib:secret@db.example.supabase.co:5432/postgres', DIRECT_URL: 'postgresql://x', JWT_SECRET: 'short', ANTHROPIC_API_KEY: REAL_LOOKING_KEY,
      JWT_REFRESH_SECRET: 'r'.repeat(40),
    };
    prepareEvalEnvironment({ fake: false }, environment);
    expect(environment).toMatchObject({ DATABASE_URL: EVAL_DATABASE_PLACEHOLDER, DIRECT_URL: EVAL_DATABASE_PLACEHOLDER, ANTHROPIC_API_KEY: REAL_LOOKING_KEY, JWT_REFRESH_SECRET: 'r'.repeat(40) });
    expect(environment.JWT_SECRET!.length).toBeGreaterThanOrEqual(32);
    prepareEvalEnvironment({ fake: true }, environment);
    expect(environment).toMatchObject({ ANTHROPIC_API_KEY: FAKE_EVAL_API_KEY, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' });
  });

  it('takes the system prompt version from the AiCall records (null when no call reached the client)', () => {
    expect(systemPromptVersionOf([])).toBeNull();
    expect(systemPromptVersionOf([{ systemPromptVersion: null }, { systemPromptVersion: 'system-v1-ab12cd' }])).toBe('system-v1-ab12cd');
  });

  it('selects cases by id and names unknown ids', () => {
    expect(selectCases(CASES, [])).toHaveLength(8);
    expect(selectCases(CASES, ['CASE-02-HEBRON-YOUTH-EU', 'CASE-01-GAZA-WASH-ECHO']).map(c => c.id)).toEqual(['CASE-01-GAZA-WASH-ECHO', 'CASE-02-HEBRON-YOUTH-EU']);
    expect(() => selectCases(CASES, ['CASE-99'])).toThrow(/unknown case CASE-99/);
  });
});

describe('scripts/eval-kpi: run in-process', () => {
  const KEYS = ['DATABASE_URL', 'DIRECT_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'NODE_ENV', 'VOYAGE_API_KEY'];
  let saved: Record<string, string | undefined>;
  let out: string[];
  let err: string[];
  let dir: string;
  const io = () => ({ log: (line: string) => out.push(line), error: (line: string) => err.push(line) });

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
    out = [];
    err = [];
    dir = nodePath.join(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'kpi-eval-cli-')), 'results');
    prismaUses.length = 0;
    quiet();
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetAiClientForTests();
  });

  async function freshCli() {
    // A fresh module registry: the configuration is loaded by the CLI, after it has replaced DATABASE_URL.
    vi.resetModules();
    return import('../scripts/eval-kpi');
  }

  it('refuses with one line, exit code 2 and nothing written', async () => {
    const { runEvalCli } = await freshCli();
    expect(await runEvalCli(['--out', dir], io())).toBe(EXIT_REFUSED); // the test key is a placeholder
    expect(await runEvalCli(['--fake', '--bogus'], io())).toBe(EXIT_REFUSED);
    expect(await runEvalCli(['--fake', '--case', 'CASE-99', '--out', dir], io())).toBe(EXIT_REFUSED);
    process.env.NODE_ENV = 'production';
    expect(await runEvalCli(['--fake', '--out', dir], io())).toBe(EXIT_REFUSED);
    process.env.NODE_ENV = 'test';
    process.env.ANTHROPIC_API_KEY = REAL_LOOKING_KEY;
    expect(await runEvalCli(['--out', dir], io())).toBe(EXIT_REFUSED);
    expect(err).toHaveLength(5);
    expect(err[0]).toMatch(/^Refusing to run: ANTHROPIC_API_KEY looks like a placeholder/);
    expect(err[1]).toMatch(/^Refusing to run: Unknown option '--bogus'/);
    expect(err[2]).toMatch(/unknown case CASE-99/);
    expect(err[3]).toMatch(/NODE_ENV is "production"/);
    expect(err[4]).toMatch(/re-run with --yes/);
    expect(err.every(line => !line.includes('\n'))).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(process.env.DATABASE_URL).toBe(saved.DATABASE_URL);
    expect(await runEvalCli(['--help'], io())).toBe(EXIT_PASSED);
    expect(out.join('\n')).toContain('npm run eval:kpi -- --fake');
  });

  it('--fake runs every case end to end with the database URL replaced and no database access', async () => {
    process.env.DATABASE_URL = 'postgresql://raqib:secret@db.example.supabase.co:5432/postgres';
    process.env.DIRECT_URL = process.env.DATABASE_URL;
    const { runEvalCli } = await freshCli();

    expect(await runEvalCli(['--fake', '--out', dir], io())).toBe(EXIT_PASSED);
    expect(err).toEqual([]);
    const { env } = await import('../src/config/env');
    expect(env.databaseUrl).toBe(EVAL_DATABASE_PLACEHOLDER);
    expect(process.env.DIRECT_URL).toBe(EVAL_DATABASE_PLACEHOLDER);
    expect(prismaUses).toEqual([]);

    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/);
    const report = JSON.parse(fs.readFileSync(nodePath.join(dir, files[0]), 'utf8'));
    expect(report).toMatchObject({
      mode: 'fake', status: 'complete', promptVersion: KPI_PROMPT_VERSION, models: { main: FAKE_KPI_MODEL, fast: FAKE_KPI_MODEL }, retrieval: 'keyword',
      libraryVersion: '1.0.0', casesFile: { path: nodePath.join('knowledge', 'kpi-eval-cases.json'), version: '1.0.0' },
    });
    // The fake model gets no system prompt: no version to report (scripts never load the shared prompt themselves).
    expect(report.systemPromptVersion).toBeNull();
    expect(report.cases).toHaveLength(8);
    const printed = out.join('\n');
    expect(printed).toContain('KPI Assistant evaluation · prompt kpi-v1');
    expect(printed).toContain('mode fake');
    expect(printed).toMatch(/^result complete · schema validity 100% PASS/m);
    expect(printed).toContain(`Saved ${nodePath.join(dir, files[0])}`);
    // No secret of the preset URL is printed.
    expect(printed).not.toContain('secret');
  });

  it('the real mode goes through client.ts (fake SDK): AiCall records stay in memory, the configured models and the system prompt version are reported, no database', async () => {
    process.env.DATABASE_URL = 'postgresql://raqib:secret@db.example.supabase.co:5432/postgres';
    process.env.ANTHROPIC_API_KEY = REAL_LOOKING_KEY;
    const { runEvalCli, prepareEvalEnvironment: prepare } = await freshCli();
    // The client of the fresh registry loads the configuration, so the placeholder must be in place first.
    prepare({ fake: false });
    const client = await import('../src/services/ai/client');
    // A well-behaved model: per SUGGEST FOR line its first two candidates, copied from the library.
    const sdk = fakeSdk(body => {
      const first = body.messages[0].content;
      const user = typeof first === 'string' ? first : first.map((block: { text?: string }) => block.text ?? '').join('');
      const suggestions = suggestForLines(user).flatMap(line => line.candidates.slice(0, 2)
        .map(id => rawFromEntry(libraryEntry(id), line.code, { level: line.level as 'impact' | 'outcome' | 'output' })));
      return rawMessage('claude-sonnet-5-5', { suggestions, frameworkWarnings: [] }, { output: 300 });
    });
    client.configureAiClientForTests({ anthropic: sdk.client });
    try {
      const code = await runEvalCli(['--yes', '--case', 'CASE-07-RAMALLAH-WEE', '--out', dir], io());
      expect(err).toEqual([]);
      const [file] = fs.readdirSync(dir);
      const report = JSON.parse(fs.readFileSync(nodePath.join(dir, file), 'utf8'));
      expect(report).toMatchObject({ mode: 'real', status: 'complete', models: { main: client.resolveModel('main'), fast: client.resolveModel('fast') } });
      expect(report.systemPromptVersion).toMatch(/^system-v1-[0-9a-f]+$/);
      const calls = [...report.cases[0].calls, ...report.cases[0].resultCalls];
      expect(sdk.sent).toHaveLength(calls.length);
      expect(calls.every((c: KpiCallInfo) => c.outcome === 'success' && c.feature === 'kpi.suggest' && c.aiCallId === null)).toBe(true);
      expect(report.summary.costUsd).toBeGreaterThan(0);
      expect(report.cases[0].suggestions.length).toBeGreaterThan(0);
      expect(out).toContain(`AI calls logged in memory (no database): ${calls.length}`);
      expect(prismaUses).toEqual([]);
      expect(code).toBe(report.summary.status === 'complete' && Object.values(report.summary.passed).every(Boolean) ? EXIT_PASSED : EXIT_FAILED);
    } finally {
      client.resetAiClientForTests();
    }
  });

  it('--case runs only the named case and --no-result-check skips the latency run; the exit code follows the targets', async () => {
    const { runEvalCli } = await freshCli();
    const code = await runEvalCli(['--fake', '--case', 'CASE-01-GAZA-WASH-ECHO', '--no-result-check', '--out', dir], io());
    expect([EXIT_PASSED, EXIT_FAILED]).toContain(code);
    const [file] = fs.readdirSync(dir);
    const report = JSON.parse(fs.readFileSync(nodePath.join(dir, file), 'utf8'));
    expect(report.cases.map((c: { id: string }) => c.id)).toEqual(['CASE-01-GAZA-WASH-ECHO']);
    expect(report.summary.latencyMeasured).toBe(false);
    expect(code).toBe(report.summary.status === 'complete' && Object.values(report.summary.passed).every(Boolean) ? EXIT_PASSED : EXIT_FAILED);
  });
});
