/**
 * Runs the KPI evaluation cases through the same runKpiPipeline as production (knowledge/kpi-assistant-spec.md §A8;
 * design section 10.2): framework scope per case (assertions) plus one result-scope run for the first outcome
 * (latency), each case in its own try/catch, and no new case once the spend reaches maxUsd. Never touches a database:
 * the caller injects the library source, the embedding provider and the model caller. Logs carry ids and counts only.
 */
import { AiError, AiInvalidOutputError, AiOutputTruncatedError, AiRefusalError, safeErrorSummary } from '../../ai/errors';
import { KPI_PROMPT_VERSION } from '../../ai/prompts/kpi';
import { runKpiPipeline } from '../pipeline';
import type { KpiCallInfo, KpiLibraryEntry, KpiPipelineDeps, KpiPipelineResult, ModelCaller } from '../types';
import { checkAssertions, failAllAssertions } from './assertions';
import { caseToContext, firstOutcome, type EvalCase } from './cases';
import { DEFAULT_EVAL_TARGETS, baselinesFromTargetSentences, hallucinatedTargets, summarise, type EvalCaseRun, type EvalTargets } from './metrics';
import type { EvalReport } from './report';

/** What the report says about the run that the runner cannot know itself (the CLI fills it; design 10.3). */
export interface EvalRunInfo {
  mode: 'real' | 'fake';
  models: { main: string; fast: string };
  /** Shared system prompt version of the real calls (the CLI fills it from the AiCall records); null in fake mode. */
  systemPromptVersion: string | null;
  libraryVersion: string;
  casesFile: { path: string; version: string };
  /** Retrieval mode the deps were built for; the observed mode wins when a case ran. */
  retrieval: 'vector' | 'keyword';
  targets: EvalTargets;
}

const DEFAULT_INFO: EvalRunInfo = {
  mode: 'real',
  models: { main: 'unknown', fast: 'unknown' },
  systemPromptVersion: null,
  libraryVersion: 'unknown',
  casesFile: { path: '', version: '' },
  retrieval: 'keyword',
  targets: DEFAULT_EVAL_TARGETS,
};

function outcomeOf(err: unknown): KpiCallInfo['outcome'] {
  if (err instanceof AiOutputTruncatedError) return 'truncated';
  if (err instanceof AiInvalidOutputError) return 'invalid';
  if (err instanceof AiRefusalError) return 'refused';
  return 'error';
}

/**
 * Wraps the model caller to record every attempt, so a run that throws still reports its calls (outcomes for the
 * summary, cost for the budget). A successful pipeline run reports its own KpiCallInfo list instead.
 */
function recordingCaller(callModel: ModelCaller): { callModel: ModelCaller; calls: KpiCallInfo[] } {
  const calls: KpiCallInfo[] = [];
  const recorded: ModelCaller = async request => {
    const base = { feature: request.feature, tier: request.tier, promptVersion: request.promptVersion, resultCodes: request.meta.batch.map(r => r.code) };
    const started = Date.now();
    try {
      const response = await callModel(request);
      calls.push({
        ...base, model: response.model, outcome: 'success', inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens,
        cacheReadTokens: response.usage.cacheReadTokens, cacheWriteTokens: response.usage.cacheWriteTokens,
        estimatedCostUsd: response.estimatedCostUsd, latencyMs: response.latencyMs, aiCallId: response.aiCallId,
      });
      return response;
    } catch (err) {
      calls.push({
        ...base, model: null, outcome: outcomeOf(err), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        estimatedCostUsd: null, latencyMs: Math.max(0, Date.now() - started), aiCallId: null,
      });
      throw err;
    }
  };
  return { callModel: recorded, calls };
}

const cost = (calls: readonly KpiCallInfo[]) => calls.reduce((n, c) => n + (c.estimatedCostUsd ?? 0), 0);

/** The error stored on a case: the AiError class and message, otherwise only the class name (safeErrorSummary). */
const caseError = (err: unknown) => (err instanceof AiError ? safeErrorSummary(err) : `${safeErrorSummary(err)} (internal error)`);

/** One case: the framework-scope run with assertions, then (resultCheck) the result-scope run of the first outcome. */
async function runCase(c: EvalCase, deps: KpiPipelineDeps, library: ReadonlyMap<string, KpiLibraryEntry>, resultCheck: boolean):
  Promise<{ run: EvalCaseRun; retrieval: KpiPipelineResult['retrieval'] | null }> {
  const run: EvalCaseRun = {
    id: c.id, error: null, suggestions: [], frameworkWarnings: [], assertions: [], rawCount: 0, hallucinatedBefore: 0, hallucinatedAfter: 0,
    baselinesFromTargetSentences: 0, candidateIdsByResult: {}, calls: [], resultCalls: [], resultRawCount: 0,
  };
  let retrieval: KpiPipelineResult['retrieval'] | null = null;

  const framework = recordingCaller(deps.callModel);
  try {
    const result = await runKpiPipeline(caseToContext(c), { ...deps, callModel: framework.callModel });
    retrieval = result.retrieval;
    run.suggestions = result.suggestions;
    run.frameworkWarnings = result.frameworkWarnings;
    run.rawCount = result.raw.length;
    run.hallucinatedBefore = hallucinatedTargets(result.raw, c.documentFacts);
    run.hallucinatedAfter = hallucinatedTargets(result.suggestions, c.documentFacts);
    run.baselinesFromTargetSentences = baselinesFromTargetSentences(result.suggestions, c.documentFacts);
    run.candidateIdsByResult = result.candidateIdsByResult;
    run.calls = result.calls;
    run.assertions = checkAssertions(c, result.suggestions, library);
  } catch (err) {
    run.calls = framework.calls;
    run.error = caseError(err);
    run.assertions = failAllAssertions(c, 'case failed');
    return { run, retrieval };
  }

  const outcome = resultCheck ? firstOutcome(c) : null;
  if (outcome) {
    const single = recordingCaller(deps.callModel);
    try {
      const result = await runKpiPipeline(caseToContext(c, { type: 'result', resultId: outcome.id }), { ...deps, callModel: single.callModel });
      run.resultCalls = result.calls;
      run.resultRawCount = result.raw.length;
    } catch (err) {
      run.resultCalls = single.calls;
      run.error = `result-scope check failed: ${caseError(err)}`;
    }
  }
  return { run, retrieval };
}

/**
 * Runs the evaluation (spec §A8; design 10.2): per case (each in try/catch: an error is recorded on the case — class
 * name and AiError message only — and the next case runs) the framework-scope run, whose validated suggestions the
 * assertions check, and, unless resultCheck is false, one result-scope run for the first outcome (latency: the worst
 * realistic case, 2–4 suggestions). Stops starting new cases once the spend (Σ estimatedCostUsd) reaches maxUsd: the
 * report says "budget reached after N cases" and the status is incomplete. `info` fills the report fields the runner
 * cannot know (mode, models, versions, cases file).
 */
export async function runEval(input: { cases: EvalCase[]; deps: KpiPipelineDeps; maxUsd: number; resultCheck: boolean; now: () => Date;
  log: (line: string) => void; info?: Partial<EvalRunInfo> }): Promise<EvalReport> {
  const info: EvalRunInfo = { ...DEFAULT_INFO, ...input.info };
  const startedAt = input.now();
  const library = new Map((await input.deps.library.allEntries()).map(e => [e.id, e]));
  const runs: EvalCaseRun[] = [];
  const retrievals: Array<KpiPipelineResult['retrieval']> = [];
  let spent = 0;
  let budgetReachedAfter: number | null = null;

  for (const c of input.cases) {
    if (spent >= input.maxUsd) {
      budgetReachedAfter = runs.length;
      input.log(`[KpiEval] budget of US$${input.maxUsd} reached after ${runs.length} case(s) (spent US$${spent.toFixed(4)}); no new case starts`);
      break;
    }
    const { run, retrieval } = await runCase(c, input.deps, library, input.resultCheck);
    if (retrieval) retrievals.push(retrieval);
    spent += cost(run.calls) + cost(run.resultCalls);
    runs.push(run);
    const passed = run.assertions.filter(a => a.passed).length;
    input.log(run.error
      ? `[KpiEval] ${c.id}: ${run.error}; ${run.calls.length + run.resultCalls.length} call(s)`
      : `[KpiEval] ${c.id}: ${run.suggestions.length} suggestion(s), ${passed}/${run.assertions.length} assertions, ${run.calls.length + run.resultCalls.length} call(s)`);
  }

  const summary = summarise(runs, info.targets, { budgetReachedAfter, resultCheck: input.resultCheck });
  const retrieval = retrievals.length === 0 ? info.retrieval : retrievals.every(r => r === 'vector') ? 'vector' : 'keyword';
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: input.now().toISOString(),
    mode: info.mode,
    status: summary.status,
    promptVersion: KPI_PROMPT_VERSION,
    systemPromptVersion: info.systemPromptVersion,
    models: info.models,
    retrieval,
    libraryVersion: info.libraryVersion,
    casesFile: info.casesFile,
    budgetReachedAfter,
    cases: runs.map(run => ({ ...run, suggestions: run.suggestions.map(({ draft: _draft, ...rest }) => rest) })),
    summary,
    targets: info.targets,
  };
}
