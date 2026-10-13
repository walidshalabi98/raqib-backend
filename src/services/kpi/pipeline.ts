/**
 * runKpiPipeline: retrieveCandidates → callModelForResults → validateAndScore (knowledge/kpi-assistant-spec.md §A4;
 * design sections 2 and 4.4). Never imports prisma or env: the run executor, framework generation and the eval inject
 * KpiPipelineDeps (library source, embedding provider, model caller, clock). Logs carry ids and counts only.
 */
import { AiError } from '../ai/errors';
import { KPI_FEATURES, KPI_PROMPT_VERSION } from '../ai/prompts/kpi';
import { redactPersonalData } from '../ai/redact';
import type { EmbeddingInputType, EmbeddingProvider } from '../ai/embeddingProviders';
import { KPI_MAX_CALLS_PER_RUN, KPI_RUN_DEADLINE_MS, callModelForResults, candidatesForBatch, planBatches } from './callModel';
import { normalisedIndicatorName } from './nameRules';
import { cosine, retrieveCandidates } from './retrieve';
import { allowanceFor, scopedResults } from './scope';
import { validateAndScore, warning, type SimilarityFn } from './validate';
import type {
  KpiErrorCode, KpiPipelineDeps, KpiPipelineOptions, KpiPipelineResult, KpiRawSuggestion, KpiWarning, ProjectContext,
} from './types';

/**
 * Pipeline failures that are not an AiError of the client. Extends AiError, so generationFailureMessage and
 * safeErrorSummary keep its (safe) message.
 */
export class KpiPipelineError extends AiError {
  constructor(readonly code: KpiErrorCode, feature: string, message: string) {
    super(message, feature);
    this.name = 'KpiPipelineError';
  }
}

/**
 * The result of a run with nothing to suggest (design m4: empty scope → no retrieval and no model call). A new object on
 * every call, so callers may change it.
 */
export function emptyPipelineResult(): KpiPipelineResult {
  return {
    suggestions: [], frameworkWarnings: [], retrieval: 'keyword', candidateIdsByResult: {}, raw: [], calls: [], model: null,
    promptVersion: KPI_PROMPT_VERSION, embeddingCalls: 0,
  };
}

/**
 * A frozen empty result for test doubles (tests/setup.ts mocks runKpiPipeline with it through importOriginal, design
 * 7.5). Production code uses emptyPipelineResult().
 */
export const EMPTY_PIPELINE_RESULT: KpiPipelineResult = deepFreeze(emptyPipelineResult());

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** Wraps a provider so every embed() call is counted (KpiPipelineResult.embeddingCalls, stored on the run; SDA-17). */
function countingProvider(provider: EmbeddingProvider): { provider: EmbeddingProvider; calls: () => number } {
  let calls = 0;
  const counted: EmbeddingProvider = {
    name: provider.name,
    model: provider.model,
    dimensions: provider.dimensions,
    enabled: provider.enabled,
    disabledReason: provider.disabledReason,
    embed: (texts: string[], inputType: EmbeddingInputType) => {
      calls += 1;
      return provider.embed(texts, inputType);
    },
  };
  return { provider: counted, calls: () => calls };
}

/** The key a name is embedded and looked up under (the validated name is the redacted, trimmed model name). */
const nameKey = (name: string) => normalisedIndicatorName(redactPersonalData(name ?? '').text);

/**
 * Rule 18 near-duplicates (spec §A4 step 3 "embedding cosine ≥ 0.92"; design 4.4): when the provider is enabled and
 * the framework has indicators, embeds (input 'document') the redacted English names of the model's suggestions and of
 * the existing indicators in one call and returns the cosine of two names, null for a name without a vector. Any
 * failure (EmbeddingError, null, a wrong count) → undefined: validation compares text only, the run goes on.
 */
async function nameSimilarity(ctx: ProjectContext, raw: readonly KpiRawSuggestion[], provider: EmbeddingProvider):
  Promise<SimilarityFn | undefined> {
  if (!provider.enabled || raw.length === 0 || ctx.existingIndicators.length === 0) return undefined;
  const texts = new Map<string, string>();
  for (const name of [...raw.map(s => s.name), ...ctx.existingIndicators.map(i => i.name)]) {
    const text = redactPersonalData(name ?? '').text.replace(/\s+/g, ' ').trim();
    const key = nameKey(text);
    if (key !== '' && !texts.has(key)) texts.set(key, text);
  }
  if (texts.size === 0) return undefined;
  try {
    const keys = Array.from(texts.keys());
    const vectors = await provider.embed(keys.map(k => texts.get(k) as string), 'document');
    if (!vectors || vectors.length !== keys.length) return undefined;
    const byKey = new Map(keys.map((k, i) => [k, vectors[i]]));
    return (a, b) => {
      const va = byKey.get(nameKey(a));
      const vb = byKey.get(nameKey(b));
      return va && vb && va.length === vb.length ? cosine(va, vb) : null;
    };
  } catch (err) {
    console.warn(`[KpiPipeline] near-duplicate embedding failed (${(err as Error)?.name ?? 'Error'}), text comparison only`);
    return undefined;
  }
}

/**
 * The KPI Assistant pipeline (spec §A4; design 2 and 4.4), with no database access:
 * 1. scopedResults(ctx) empty → emptyPipelineResult() (no retrieval, no model call; design m4);
 * 2. onStep('retrieval') → retrieveCandidates (library filter, vector or keyword ranking);
 * 3. onStep('model') → callModelForResults (deadline = start + deadlineMs, call budget maxCalls); when every scoped
 *    result failed, the last original AiError is rethrown unchanged (an AiRefusalError keeps its message), or, when no
 *    call was made at all, KpiPipelineError('ai_unavailable');
 * 4. onStep('validation') → near-duplicate similarity (embeddings when enabled, else text only) → validateAndScore;
 * 5. framework scope (AI-2): scoped results that did not fail but kept no suggestion get one more call each (within the
 *    call budget and deadline, without the library ids other results keep), then validation runs again over every answer;
 *    result_failed warnings (params code, reason) for failed results, result_empty for scoped results still without a
 *    suggestion, then the retrieval warnings.
 * Feature: opts.feature, else kpi.alternatives for alternatives scope and kpi.suggest otherwise.
 */
export async function runKpiPipeline(ctx: ProjectContext, deps: KpiPipelineDeps, opts: KpiPipelineOptions = {}): Promise<KpiPipelineResult> {
  const started = deps.now().getTime();
  const feature = opts.feature ?? (ctx.scope.type === 'alternatives' ? KPI_FEATURES.alternatives : KPI_FEATURES.suggest);
  const scoped = scopedResults(ctx);
  if (scoped.length === 0) {
    console.info(`[KpiPipeline] project ${ctx.project.id} scope=${ctx.scope.type}: nothing to suggest, no model call`);
    return emptyPipelineResult();
  }
  const embeddings = countingProvider(deps.embeddings);

  await opts.onStep?.('retrieval');
  const retrieval = await retrieveCandidates(ctx, { library: deps.library, embeddings: embeddings.provider });

  await opts.onStep?.('model');
  const batchesTotal = planBatches(scoped).length;
  let batchesDone = 0;
  const answer = await callModelForResults(ctx, retrieval, deps, {
    feature,
    callContext: opts.callContext,
    deadlineAt: started + (opts.deadlineMs ?? KPI_RUN_DEADLINE_MS),
    maxCalls: opts.maxCalls ?? KPI_MAX_CALLS_PER_RUN,
    onBatchDone: async () => {
      batchesDone += 1;
      await opts.onProgress?.({ batchesDone, batchesTotal: Math.max(batchesTotal, batchesDone) });
    },
  });
  const failedIds = new Set(answer.failedResults.map(f => f.resultId));
  if (scoped.every(r => failedIds.has(r.id))) {
    console.warn(`[KpiPipeline] project ${ctx.project.id} scope=${ctx.scope.type}: every result failed (${answer.calls.length} calls)`);
    if (answer.lastError) throw answer.lastError;
    throw new KpiPipelineError('ai_unavailable', feature, `The AI did not answer in time (${feature}).`);
  }

  await opts.onStep?.('validation');
  const candidateIds = new Set<string>();
  for (const batch of planBatches(scoped)) {
    for (const entry of candidatesForBatch(batch, retrieval).candidates) candidateIds.add(entry.id);
  }
  let suggestions = answer.suggestions;
  let modelWarnings = answer.modelWarnings;
  let similarity = await nameSimilarity(ctx, suggestions, embeddings.provider);
  const validate = () => validateAndScore({
    context: ctx,
    answer: { suggestions, frameworkWarnings: modelWarnings },
    deps: { library: retrieval.library, candidateIds, ...(similarity ? { similarity } : {}) },
  });
  let validated = validate();

  // AI-2: a framework result that the model skipped, or whose suggestions validation dropped (repeats of other results),
  // gets one more call of its own, without the library ids other results already keep; then validation runs again.
  const failedResults = [...answer.failedResults];
  const calls = [...answer.calls];
  const keptFor = (resultId: string) => validated.suggestions.some(x => x.resultId === resultId);
  const empty = () => scoped.filter(r => !failedIds.has(r.id) && allowanceFor(r, ctx).min > 0 && !keptFor(r.id));
  const retryFor = ctx.scope.type === 'framework' ? empty() : [];
  const callsLeft = (opts.maxCalls ?? KPI_MAX_CALLS_PER_RUN) - answer.calls.length;
  if (retryFor.length > 0 && callsLeft > 0) {
    const used = new Set(validated.suggestions.flatMap(x => (x.libraryId ? [x.libraryId.toUpperCase()] : [])));
    const retry = await callModelForResults(ctx, retrieval, deps, {
      feature,
      callContext: opts.callContext,
      deadlineAt: started + (opts.deadlineMs ?? KPI_RUN_DEADLINE_MS),
      maxCalls: callsLeft,
      results: retryFor,
      oneResultPerCall: true,
      excludeLibraryIds: used,
    });
    calls.push(...retry.calls);
    // A retry that fails leaves the first answers as they were (no result_failed for a result that had its call).
    if (retry.suggestions.length > 0) {
      suggestions = [...suggestions, ...retry.suggestions];
      modelWarnings = [...modelWarnings, ...retry.modelWarnings];
      similarity = await nameSimilarity(ctx, suggestions, embeddings.provider);
      validated = validate();
    }
    console.info(`[KpiPipeline] project ${ctx.project.id}: ${retryFor.length} result(s) without suggestions retried (${retry.calls.length} calls, ${retry.suggestions.length} raw)`);
  }

  const codeOf = new Map(ctx.resultsChain.map(r => [r.id, r.code]));
  const failedWarnings: KpiWarning[] = failedResults.map(f =>
    warning('result_failed', { code: codeOf.get(f.resultId) ?? f.resultId, reason: f.reason }));
  // A scoped result that should have suggestions and has none (and did not fail): say so (AI-2).
  const emptyWarnings: KpiWarning[] = empty().map(r => warning('result_empty', { code: r.code }));
  const candidateIdsByResult: Record<string, string[]> = {};
  for (const result of scoped) candidateIdsByResult[result.id] = (retrieval.byResult.get(result.id) ?? []).map(c => c.entry.id);

  console.info(
    `[KpiPipeline] project ${ctx.project.id} scope=${ctx.scope.type} results=${scoped.length} retrieval=${retrieval.method}`
      + ` calls=${calls.length} failed=${failedResults.length} empty=${emptyWarnings.length} raw=${suggestions.length}`
      + ` suggestions=${validated.suggestions.length} embeddingCalls=${embeddings.calls()}`,
  );
  return {
    suggestions: validated.suggestions,
    frameworkWarnings: [...validated.frameworkWarnings, ...failedWarnings, ...emptyWarnings, ...retrieval.warnings],
    retrieval: retrieval.method,
    candidateIdsByResult,
    raw: suggestions,
    calls,
    model: answer.model,
    promptVersion: KPI_PROMPT_VERSION,
    embeddingCalls: embeddings.calls(),
  };
}
