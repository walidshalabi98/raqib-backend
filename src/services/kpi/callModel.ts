/**
 * Model calls of a KPI run (knowledge/kpi-assistant-spec.md §A4 step 2; design sections 4.4 and 6.3, D19, D20):
 * batches of ≤ 4 results, 3 concurrent per run, ≤ 6 in flight per process, a call budget and a run deadline; cut-off,
 * invalid and refused batches are split per result. Every call goes through generateStructured (CLAUDE.md rule 4).
 *
 * Step 0 stub (Phase 4 contracts): constants and signatures are final; E4 implements the bodies.
 */
import type { AiCallContext } from '../ai/client';
import type { AiError } from '../ai/errors';
import type { RetrievalResult } from './retrieve';
import type { ContextResult, KpiCallInfo, KpiPipelineDeps, KpiRawSuggestion, ModelCaller, ProjectContext } from './types';

export const KPI_BATCH_MAX_RESULTS = 4;
export const KPI_BATCH_CONCURRENCY = 3;
/** Model calls in flight across every KPI run and framework generation in this process (module-level semaphore). */
export const KPI_MAX_CONCURRENT_CALLS = 6;
export const KPI_MAX_CALLS_PER_RUN = 20;
export const KPI_RUN_DEADLINE_MS = 10 * 60_000;

/** generateStructured with KPI_SUGGESTIONS_SCHEMA; measures latency with Date.now(). */
export const defaultModelCaller: ModelCaller = async () => {
  throw new Error('Phase 4: not implemented (E4)');
};

/** Chain order; an outcome travels with its outputs; ≤ KPI_BATCH_MAX_RESULTS results per batch. */
export function planBatches(_results: readonly ContextResult[]): ContextResult[][] {
  throw new Error('Phase 4: not implemented (E4)');
}

/** Why a scoped result got no model answer (becomes a result_failed warning). */
export type KpiFailedResultReason = 'invalid' | 'truncated' | 'refused' | 'unavailable' | 'deadline' | 'call_budget';

/**
 * Runs the batches of one KPI run. AiRequestError 401/403 is rethrown at once; other failures go to failedResults
 * and the original AiError is kept as lastError (nothing is wrapped).
 */
export async function callModelForResults(_ctx: ProjectContext, _retrieval: RetrievalResult, _deps: Pick<KpiPipelineDeps, 'callModel' | 'now'>,
  _opts: { feature?: string; callContext?: AiCallContext; onBatchDone?: () => void | Promise<void>; deadlineAt: number; maxCalls: number }):
  Promise<{ suggestions: KpiRawSuggestion[]; modelWarnings: string[]; calls: KpiCallInfo[];
            failedResults: Array<{ resultId: string; reason: KpiFailedResultReason }>;
            lastError: AiError | null; model: string | null }> {
  throw new Error('Phase 4: not implemented (E4)');
}
