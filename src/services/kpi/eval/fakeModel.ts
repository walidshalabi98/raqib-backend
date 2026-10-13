/**
 * A deterministic fake ModelCaller for `npm run eval:kpi -- --fake` and the tests (knowledge/kpi-assistant-spec.md §A8;
 * design section 10.2): per result the top min(allowance.max, 3) candidates, each library id for one result only
 * (dealt in rounds) → rawSuggestionFromLibrary;
 * outputTokens = ceil(answer JSON length / 4) as a latency proxy, other tokens 0; cost 0. No key, no network, no
 * database: it reads only request.meta (and, for the baselineFromTarget fault, the DOCUMENT FACTS lines of the prompt).
 */
import { AiInvalidOutputError, AiRefusalError } from '../../ai/errors';
import type { KpiModelAnswer, KpiRawSuggestion } from '../../ai/prompts/kpi';
import type { KpiLibraryEntry, KpiModelRequest, ModelCaller } from '../types';
import { rawSuggestionFromLibrary } from '../validate';

/** Faults the fake can inject to prove the validator and the metrics catch them. */
export type FakeModelInjection = 'targetInName' | 'unknownLibraryId' | 'hallucinatedTarget' | 'baselineFromTarget' | 'invalid' | 'refuse';

/** The model id the fake reports (never a real model id). */
export const FAKE_KPI_MODEL = 'fake-kpi-model';
/** Suggestions per result the fake writes at most (design 10.2). */
export const FAKE_SUGGESTIONS_PER_RESULT = 3;
/** The rationale of every fake suggestion (no numbers, so rule x5 keeps it). */
export const FAKE_RATIONALE = 'A standard library indicator that measures this result directly. Suggested by the fake evaluation model.';
/** A value no case fact contains (the hallucinatedTarget fault). */
export const FAKE_HALLUCINATED_VALUE = '9137';
/** A library id that does not exist (the unknownLibraryId fault). */
export const FAKE_UNKNOWN_LIBRARY_ID = 'ZZ-99';

const YEAR = /^(19|20)\d\d$|^2100$/;

/**
 * The first number of the first [target] line of DOCUMENT FACTS in the prompt (years skipped), or null: what a model
 * that copies a target sentence's number as a baseline would write (the baselineFromTarget fault, design 10.4).
 */
export function firstTargetFactNumber(user: string): string | null {
  for (const match of user.matchAll(/^\[F\d+ target\] .*?: "(.*)"$/gm)) {
    for (const token of match[1].match(/[0-9٠-٩]+(?:[.,٫٬][0-9٠-٩]+)*/g) ?? []) {
      if (!YEAR.test(token)) return token;
    }
  }
  return null;
}

/**
 * The fake's answer for one request: up to min(allowance.max, 3) candidates per result of the batch, each library id
 * used for one result only (one library indicator measures one result, as the prompt asks; D12). Candidates are dealt
 * in rounds, like a model that first gives every result its best-fitting indicator: in each round every result, in batch
 * order, takes its highest-ranked candidate not used yet. Suggestions are listed per result in batch order.
 */
function answerFor(request: KpiModelRequest): KpiModelAnswer {
  const byId = new Map<string, KpiLibraryEntry>(request.meta.candidates.map(e => [e.id, e]));
  const used = new Set<string>();
  const picks = new Map<string, string[]>(request.meta.batch.map(r => [r.id, []]));
  const maxOf = (resultId: string) => Math.max(0, Math.min(request.meta.allowances[resultId]?.max ?? 0, FAKE_SUGGESTIONS_PER_RESULT));
  for (let round = 0; round < FAKE_SUGGESTIONS_PER_RESULT; round += 1) {
    for (const result of request.meta.batch) {
      const own = picks.get(result.id) as string[];
      if (own.length >= maxOf(result.id)) continue;
      const next = (request.meta.candidateIdsByResult[result.id] ?? []).find(id => byId.has(id) && !used.has(id));
      if (next === undefined) continue;
      used.add(next);
      own.push(next);
    }
  }
  const suggestions: KpiRawSuggestion[] = request.meta.batch.flatMap(result =>
    (picks.get(result.id) as string[]).map(id => rawSuggestionFromLibrary(byId.get(id) as KpiLibraryEntry, result, FAKE_RATIONALE)));
  return { suggestions, frameworkWarnings: [] };
}

/** Applies the content faults to the first suggestion of the answer. */
function inject(answer: KpiModelAnswer, request: KpiModelRequest, faults: Partial<Record<FakeModelInjection, boolean>>): KpiModelAnswer {
  const first = answer.suggestions[0];
  if (!first) return answer;
  const changed: KpiRawSuggestion = { ...first };
  if (faults.targetInName) changed.name = `${first.name} (increase to 80%)`;
  if (faults.unknownLibraryId) changed.libraryId = FAKE_UNKNOWN_LIBRARY_ID;
  if (faults.hallucinatedTarget) {
    changed.targetSuggestion = FAKE_HALLUCINATED_VALUE;
    changed.targetBasis = 'document';
  }
  if (faults.baselineFromTarget) {
    const value = firstTargetFactNumber(request.user);
    if (value) {
      changed.baselineSuggestion = value;
      changed.baselineBasis = 'document';
    }
  }
  return { ...answer, suggestions: [changed, ...answer.suggestions.slice(1)] };
}

/**
 * The fake ModelCaller (design 10.2). Faults (opts.inject):
 * - targetInName / unknownLibraryId / hallucinatedTarget / baselineFromTarget change the first suggestion of every
 *   answer (a direction and a percentage in the name; library id ZZ-99; a document target no fact contains; the first
 *   number of a target fact copied as a document baseline);
 * - invalid: every call for more than one result throws AiInvalidOutputError (the pipeline then retries each result
 *   alone, and those calls answer), so schema validity drops below 100% while the run still finishes;
 * - refuse: every call throws AiRefusalError.
 * Usage: outputTokens = ceil(answer JSON length / 4), other tokens 0; estimatedCostUsd 0; latency measured.
 */
export function fakeKpiModelCaller(opts: { inject?: Partial<Record<FakeModelInjection, boolean>> } = {}): ModelCaller {
  const faults = opts.inject ?? {};
  return async request => {
    const started = Date.now();
    if (faults.refuse) throw new AiRefusalError(request.feature, null);
    if (faults.invalid && request.meta.batch.length > 1) {
      throw new AiInvalidOutputError(request.feature, ['suggestions[0].unit: not one of the allowed values']);
    }
    const data = inject(answerFor(request), request, faults);
    return {
      data,
      model: FAKE_KPI_MODEL,
      usage: { inputTokens: 0, outputTokens: Math.ceil(JSON.stringify(data).length / 4), cacheReadTokens: 0, cacheWriteTokens: 0 },
      estimatedCostUsd: 0,
      aiCallId: null,
      latencyMs: Math.max(0, Date.now() - started),
    };
  };
}
