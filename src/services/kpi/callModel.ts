/**
 * Model calls of a KPI run (knowledge/kpi-assistant-spec.md §A4 step 2: tiers, structured outputs, "max_tokens → retry
 * once with a higher limit or split by result", "refusal → friendly error"; design sections 4.4 and 6.3, D19, D20):
 * batches of ≤ 4 results (an outcome travels with its outputs), 3 concurrent per run, ≤ 6 in flight per process, a call
 * budget and a run deadline. A cut-off, invalid or refused batch is split per result; a result that still fails gets a
 * result_failed warning and the run continues. Every call goes through generateStructured (CLAUDE.md rule 4) via the
 * injected ModelCaller; logs carry ids and counts only.
 */
import { generateStructured, type AiCallContext } from '../ai/client';
import { AiError, AiInvalidOutputError, AiOutputTruncatedError, AiRefusalError, AiRequestError } from '../ai/errors';
import { codeKey } from '../ai/frameworkNormalize';
import {
  KPI_CALLS, KPI_FEATURES, KPI_PROMPT_VERSION, KPI_SUGGESTIONS_SCHEMA, KPI_SYSTEM, buildKpiUserMessage,
} from '../ai/prompts/kpi';
import { MAX_CANDIDATES_PER_CALL, type RankedCandidate, type RetrievalResult } from './retrieve';
import { allowanceFor, scopedResults } from './scope';
import type {
  ContextResult, KpiCallInfo, KpiLibraryEntry, KpiModelRequest, KpiPipelineDeps, KpiRawSuggestion, KpiScopeType, ModelCaller,
  ProjectContext,
} from './types';

export const KPI_BATCH_MAX_RESULTS = 4;
export const KPI_BATCH_CONCURRENCY = 3;
/** Model calls in flight across every KPI run and framework generation in this process (module-level semaphore). */
export const KPI_MAX_CONCURRENT_CALLS = 6;
export const KPI_MAX_CALLS_PER_RUN = 20;
export const KPI_RUN_DEADLINE_MS = 10 * 60_000;

/**
 * generateStructured with KPI_SUGGESTIONS_SCHEMA (spec §A4 step 2 "structured outputs"; CLAUDE.md rule 4): the request's
 * tier, effort, token limit, timeout, prompt version and AiCall context; measures latency with Date.now(). Throws the
 * client's AiRefusalError, AiOutputTruncatedError, AiInvalidOutputError or AiRequestError unchanged.
 */
export const defaultModelCaller: ModelCaller = async request => {
  const started = Date.now();
  const result = await generateStructured({
    feature: request.feature,
    model: request.tier,
    effort: request.effort,
    system: request.system,
    messages: [{ role: 'user', content: request.user }],
    schema: KPI_SUGGESTIONS_SCHEMA,
    maxTokens: request.maxTokens,
    promptVersion: request.promptVersion,
    timeoutMs: request.timeoutMs,
    context: request.context,
  });
  return {
    data: result.data,
    model: result.model,
    usage: result.usage,
    estimatedCostUsd: result.estimatedCostUsd,
    aiCallId: result.aiCallId,
    latencyMs: Math.max(0, Date.now() - started),
  };
};

// ------------------------------------------------------------------ process-wide call slots (D20)

/** A counting semaphore; a released slot passes straight to the next waiter (first come, first served). */
class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  /** Resolves with a release function once a slot is free; releasing twice is harmless. */
  acquire(): Promise<() => void> {
    return new Promise(resolve => {
      const grant = () => {
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.release();
        });
      };
      if (this.active < this.limit) {
        this.active += 1;
        grant();
      } else {
        this.waiting.push(grant);
      }
    });
  }

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active -= 1;
  }
}

const callSlots = new Semaphore(KPI_MAX_CONCURRENT_CALLS);

/** KPI model calls in flight in this process and calls waiting for a slot (D20; for tests and diagnostics). */
export function kpiCallSlots(): { inFlight: number; queued: number } {
  return { inFlight: callSlots.inFlight, queued: callSlots.queued };
}

// ------------------------------------------------------------------ batches, call settings, candidates

/**
 * Batches of a run (design 4.4, D19): chain order; an outcome travels with its outputs (outputs whose outcome is not in
 * scope travel with their siblings); a group larger than KPI_BATCH_MAX_RESULTS is cut into chunks; groups are packed in
 * order into batches of at most KPI_BATCH_MAX_RESULTS results, never splitting a group that fits in one batch.
 */
export function planBatches(results: readonly ContextResult[]): ContextResult[][] {
  const ids = new Set(results.map(r => r.id));
  const grouped = new Set<string>();
  const groups: ContextResult[][] = [];
  for (const result of results) {
    if (grouped.has(result.id)) continue;
    // An output whose outcome is in scope is picked up by that outcome.
    if (result.level === 'output' && result.parentId !== null && ids.has(result.parentId)) continue;
    const group = [result];
    grouped.add(result.id);
    const together = (other: ContextResult) => result.level === 'outcome'
      ? other.level === 'output' && other.parentId === result.id
      : result.level === 'output' && result.parentId !== null && other.level === 'output' && other.parentId === result.parentId;
    for (const other of results) {
      if (!grouped.has(other.id) && together(other)) {
        group.push(other);
        grouped.add(other.id);
      }
    }
    groups.push(group);
  }

  const chunks = groups.flatMap(group => {
    const out: ContextResult[][] = [];
    for (let i = 0; i < group.length; i += KPI_BATCH_MAX_RESULTS) out.push(group.slice(i, i + KPI_BATCH_MAX_RESULTS));
    return out;
  });
  const batches: ContextResult[][] = [];
  let current: ContextResult[] = [];
  for (const chunk of chunks) {
    if (current.length + chunk.length > KPI_BATCH_MAX_RESULTS) {
      batches.push(current);
      current = [];
    }
    current = [...current, ...chunk];
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Call settings of one call (design 6.3): alternatives scope → KPI_CALLS.alternatives (fast tier); a call for one result
 * (result scope, or a one-result batch or split retry in framework scope) → KPI_CALLS.result; 2–4 results →
 * KPI_CALLS.batch.
 */
export function callConfigFor(scopeType: KpiScopeType, batchSize: number): (typeof KPI_CALLS)[keyof typeof KPI_CALLS] {
  if (scopeType === 'alternatives') return KPI_CALLS.alternatives;
  return batchSize <= 1 ? KPI_CALLS.result : KPI_CALLS.batch;
}

/**
 * Candidates of one call (design 4.4): the union of the batch results' ranked candidates (an entry ranked for two
 * results keeps its best score) plus the accountability entries, at most MAX_CANDIDATES_PER_CALL: the lowest scores
 * are dropped first, accountability entries are kept. Order: per result in batch order, best first, then the
 * accountability entries not listed yet. candidateIdsByResult keeps each result's own order.
 */
export function candidatesForBatch(batch: readonly ContextResult[], retrieval: Pick<RetrievalResult, 'byResult' | 'accountability'>):
  { candidates: KpiLibraryEntry[]; candidateIdsByResult: Record<string, string[]> } {
  const accountability = dedupeById(retrieval.accountability).slice(0, MAX_CANDIDATES_PER_CALL);
  const accountabilityIds = new Set(accountability.map(e => e.id));
  const best = new Map<string, { entry: KpiLibraryEntry; score: number }>();
  for (const result of batch) {
    for (const ranked of retrieval.byResult.get(result.id) ?? []) {
      const known = best.get(ranked.entry.id);
      if (!known || ranked.score > known.score) best.set(ranked.entry.id, ranked);
    }
  }
  const room = MAX_CANDIDATES_PER_CALL - accountability.length;
  const kept = new Set(Array.from(best.values())
    .filter(c => !accountabilityIds.has(c.entry.id))
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    .slice(0, Math.max(0, room))
    .map(c => c.entry.id));
  for (const id of accountabilityIds) kept.add(id);

  const candidateIdsByResult: Record<string, string[]> = {};
  const listed = new Map<string, KpiLibraryEntry>();
  for (const result of batch) {
    const ids: string[] = [];
    for (const ranked of retrieval.byResult.get(result.id) ?? []) {
      if (!kept.has(ranked.entry.id) || ids.includes(ranked.entry.id)) continue;
      ids.push(ranked.entry.id);
      if (!listed.has(ranked.entry.id)) listed.set(ranked.entry.id, best.get(ranked.entry.id)?.entry ?? ranked.entry);
    }
    candidateIdsByResult[result.id] = ids;
  }
  for (const entry of accountability) if (!listed.has(entry.id)) listed.set(entry.id, entry);
  return { candidates: Array.from(listed.values()), candidateIdsByResult };
}

/**
 * Candidates offered per result when a run has more than one batch (AI-2; D12: one library indicator measures one
 * result): batches run at the same time and each prompt shows only its own results, so the model cannot keep a candidate
 * to one result across batches. An entry ranked for results of different batches therefore stays only in the batch where
 * it scores best (ties: the earlier batch); within that batch it stays in every result's list (the prompt asks for one
 * result per candidate). Accountability entries (rule 19) are added to every call by candidatesForBatch, as before.
 * `exclude` (upper-case library ids) removes entries everywhere (a retry after the first answers: ids already kept).
 */
export function exclusiveCandidates(batches: readonly ContextResult[][], byResult: ReadonlyMap<string, RankedCandidate[]>,
  exclude: ReadonlySet<string> = new Set()): Map<string, RankedCandidate[]> {
  const owner = new Map<string, { batch: number; score: number }>();
  batches.forEach((batch, index) => {
    for (const result of batch) {
      for (const ranked of byResult.get(result.id) ?? []) {
        const known = owner.get(ranked.entry.id);
        if (!known || ranked.score > known.score) owner.set(ranked.entry.id, { batch: index, score: ranked.score });
      }
    }
  });
  const out = new Map<string, RankedCandidate[]>();
  for (const [resultId, list] of byResult) out.set(resultId, list.filter(c => !exclude.has(c.entry.id.toUpperCase())));
  if (batches.length > 1) {
    batches.forEach((batch, index) => {
      for (const result of batch) out.set(result.id, (out.get(result.id) ?? []).filter(c => owner.get(c.entry.id)?.batch === index));
    });
  }
  return out;
}

function dedupeById(entries: readonly KpiLibraryEntry[]): KpiLibraryEntry[] {
  const seen = new Set<string>();
  return entries.filter(e => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}

// ------------------------------------------------------------------ running the calls

/** Why a scoped result got no model answer (becomes a result_failed warning). */
export type KpiFailedResultReason = 'invalid' | 'truncated' | 'refused' | 'unavailable' | 'deadline' | 'call_budget';

/** One unit of work: the results of one call; `order` keeps the planned order (batch index, split index). */
interface Task { results: ContextResult[]; order: [number, number] }

const compareOrder = (a: readonly number[], b: readonly number[]) => a[0] - b[0] || a[1] - b[1];

/** A failed call's outcome on its KpiCallInfo. */
function outcomeOf(err: AiError): KpiCallInfo['outcome'] {
  if (err instanceof AiOutputTruncatedError) return 'truncated';
  if (err instanceof AiInvalidOutputError) return 'invalid';
  if (err instanceof AiRefusalError) return 'refused';
  return 'error';
}

/**
 * The KpiCallInfo of a failed call (AI-4): the usage, cost, AiCall id and served model the client attached to the error
 * (a truncated batch is billed for every token it produced), else zero tokens and an unknown cost.
 */
export function failedCallInfo(base: Pick<KpiCallInfo, 'feature' | 'tier' | 'promptVersion' | 'resultCodes'>, err: unknown, latencyMs: number): KpiCallInfo {
  const call = err instanceof AiError ? err.call : null;
  const outcome: KpiCallInfo['outcome'] = err instanceof AiError ? outcomeOf(err) : 'error';
  return {
    ...base, model: call?.model ?? null, outcome,
    inputTokens: call?.usage.inputTokens ?? 0, outputTokens: call?.usage.outputTokens ?? 0,
    cacheReadTokens: call?.usage.cacheReadTokens ?? 0, cacheWriteTokens: call?.usage.cacheWriteTokens ?? 0,
    estimatedCostUsd: call ? call.estimatedCostUsd : null, latencyMs, aiCallId: call?.aiCallId ?? null,
  };
}

/** A failed result's reason when the call cannot be split (any request failure after the client's own retries: unavailable). */
function reasonOf(err: AiError): KpiFailedResultReason {
  if (err instanceof AiOutputTruncatedError) return 'truncated';
  if (err instanceof AiInvalidOutputError) return 'invalid';
  if (err instanceof AiRefusalError) return 'refused';
  return 'unavailable';
}

/** Cut-off, invalid and refused answers are retried result by result (the problem is usually one result). */
const splittable = (err: AiError) => err instanceof AiOutputTruncatedError || err instanceof AiInvalidOutputError || err instanceof AiRefusalError;

/** A wrong or missing key: no further call can succeed. */
const isAuthFailure = (err: unknown) => err instanceof AiRequestError && (err.status === 401 || err.status === 403);

/**
 * Runs tasks with at most `concurrency` in flight; a worker may enqueue more tasks (they run next). Resolves when the
 * queue is empty and nothing is in flight; rejects at once on the first error (no new task starts; tasks in flight
 * finish on their own).
 */
function runQueue(initial: Task[], concurrency: number, worker: (task: Task, enqueue: (tasks: Task[]) => void) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const queue = [...initial];
    let running = 0;
    let stopped = false;
    const pump = () => {
      if (stopped) return;
      if (queue.length === 0 && running === 0) {
        resolve();
        return;
      }
      while (running < concurrency && queue.length > 0) {
        const task = queue.shift() as Task;
        running += 1;
        worker(task, more => queue.unshift(...more)).then(
          () => {
            running -= 1;
            pump();
          },
          err => {
            stopped = true;
            reject(err);
          },
        );
      }
    };
    pump();
  });
}

/**
 * Runs the batches of one KPI run (design 4.4; spec §A4 step 2). Scoped results (scopedResults) are planned with
 * planBatches and called KPI_BATCH_CONCURRENCY at a time through `deps.callModel`, each call waiting for one of the
 * KPI_MAX_CONCURRENT_CALLS process slots. Per call: candidates from candidatesForBatch, settings from callConfigFor,
 * user message from buildKpiUserMessage. Errors (the original AiError is kept as lastError; nothing is wrapped):
 * - AiOutputTruncatedError, AiInvalidOutputError or AiRefusalError on a multi-result batch → each result alone; on a
 *   single result → failedResults (truncated / invalid / refused);
 * - AiRequestError 401/403 → rethrown at once (the key is wrong; no further call); any other error that is not an
 *   AiError → rethrown (a bug, not a model failure);
 * - any other AiError (the client already retried 429, 5xx and timeouts) → the batch's results fail as unavailable;
 * - no call starts after deadlineAt or once maxCalls calls were made (splits included): the remaining results fail with
 *   deadline / call_budget. Calls in flight finish.
 * Every attempt is one KpiCallInfo. Suggestions for a scoped result outside the call's batch are dropped (that result
 * has its own call); suggestions with a code outside the scope are passed on for validation (rule x1).
 */
export async function callModelForResults(ctx: ProjectContext, retrieval: RetrievalResult, deps: Pick<KpiPipelineDeps, 'callModel' | 'now'>,
  opts: { feature?: string; callContext?: AiCallContext; onBatchDone?: () => void | Promise<void>; deadlineAt: number; maxCalls: number;
    /** The results to call for (default: every scoped result) and whether each gets its own call (a retry; AI-2). */
    results?: ContextResult[]; oneResultPerCall?: boolean;
    /** Upper-case library ids no call may offer (a retry: ids other results already keep). */
    excludeLibraryIds?: ReadonlySet<string> }):
  Promise<{ suggestions: KpiRawSuggestion[]; modelWarnings: string[]; calls: KpiCallInfo[];
            failedResults: Array<{ resultId: string; reason: KpiFailedResultReason }>;
            lastError: AiError | null; model: string | null }> {
  const scoped = scopedResults(ctx);
  const targets = opts.results ?? scoped;
  const plan = opts.oneResultPerCall ? targets.map(r => [r]) : planBatches(targets);
  // AI-2: an entry ranked in several batches is offered only in the batch where it ranks best.
  const offered: RetrievalResult = { ...retrieval, byResult: exclusiveCandidates(plan, retrieval.byResult, opts.excludeLibraryIds) };
  const feature = opts.feature ?? (ctx.scope.type === 'alternatives' ? KPI_FEATURES.alternatives : KPI_FEATURES.suggest);
  const scopedKeys = new Set(scoped.map(r => codeKey(r.code)));
  const answers: Array<{ order: [number, number]; suggestions: KpiRawSuggestion[]; warnings: string[] }> = [];
  const calls: Array<{ index: number; info: KpiCallInfo }> = [];
  const failed = new Map<string, KpiFailedResultReason>();
  let model: { index: number; value: string } | null = null;
  let lastError: AiError | null = null;
  let callsStarted = 0;
  let dropped = 0;

  const fail = (results: readonly ContextResult[], reason: KpiFailedResultReason) => {
    for (const r of results) if (!failed.has(r.id)) failed.set(r.id, reason);
  };

  const buildRequest = (results: ContextResult[]): KpiModelRequest => {
    const { candidates, candidateIdsByResult } = candidatesForBatch(results, offered);
    const allowances = Object.fromEntries(results.map(r => [r.id, allowanceFor(r, ctx)]));
    const config = callConfigFor(ctx.scope.type, results.length);
    return {
      feature,
      tier: config.tier,
      effort: config.effort,
      maxTokens: config.maxTokens,
      timeoutMs: config.timeoutMs,
      promptVersion: KPI_PROMPT_VERSION,
      system: KPI_SYSTEM,
      user: buildKpiUserMessage({ context: ctx, batch: results, candidateIdsByResult, candidates, allowances }),
      context: opts.callContext ?? {},
      meta: { scopeType: ctx.scope.type, batch: results, candidateIdsByResult, candidates, allowances },
    };
  };

  /** True (and the task's results failed) when no call may start: past the deadline or out of calls. */
  const stopped = (task: Task): boolean => {
    if (deps.now().getTime() >= opts.deadlineAt) fail(task.results, 'deadline');
    else if (callsStarted >= opts.maxCalls) fail(task.results, 'call_budget');
    else return false;
    return true;
  };

  const worker = async (task: Task, enqueue: (tasks: Task[]) => void): Promise<void> => {
    // Checked before waiting for a process slot (no wait for a call that may not start) and again once one is free.
    if (stopped(task)) return;
    const release = await callSlots.acquire();
    let called = false;
    try {
      if (stopped(task)) return;
      const index = callsStarted;
      callsStarted += 1;
      called = true;
      const request = buildRequest(task.results);
      const base = {
        feature, tier: request.tier, promptVersion: request.promptVersion, resultCodes: task.results.map(r => r.code),
      };
      const started = deps.now().getTime();
      try {
        const response = await deps.callModel(request);
        calls.push({
          index,
          info: {
            ...base, model: response.model, outcome: 'success',
            inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens,
            cacheReadTokens: response.usage.cacheReadTokens, cacheWriteTokens: response.usage.cacheWriteTokens,
            estimatedCostUsd: response.estimatedCostUsd, latencyMs: response.latencyMs, aiCallId: response.aiCallId,
          },
        });
        if (!model || index < model.index) model = { index, value: response.model };
        const batchKeys = new Set(task.results.map(r => codeKey(r.code)));
        const suggestions = (response.data.suggestions ?? []).filter(s => {
          const key = codeKey(s.resultCode ?? '');
          const keep = batchKeys.has(key) || !scopedKeys.has(key);
          if (!keep) dropped += 1;
          return keep;
        });
        answers.push({ order: task.order, suggestions, warnings: response.data.frameworkWarnings ?? [] });
      } catch (err) {
        if (err instanceof AiError) {
          calls.push({ index, info: failedCallInfo(base, err, Math.max(0, deps.now().getTime() - started)) });
        }
        if (isAuthFailure(err) || !(err instanceof AiError)) throw err;
        lastError = err;
        if (splittable(err) && task.results.length > 1) {
          enqueue(task.results.map((r, i) => ({ results: [r], order: [task.order[0], task.order[1] * 10 + i + 1] })));
        } else {
          fail(task.results, reasonOf(err));
        }
      }
    } finally {
      release();
    }
    if (called && opts.onBatchDone) {
      try {
        await opts.onBatchDone();
      } catch (err) {
        console.warn(`[KpiModel] progress callback failed (${(err as Error)?.name ?? 'Error'})`);
      }
    }
  };

  const tasks = plan.map((results, i): Task => ({ results, order: [i, 0] }));
  await runQueue(tasks, KPI_BATCH_CONCURRENCY, worker);

  if (dropped > 0) console.warn(`[KpiModel] ${feature}: ${dropped} suggestion(s) for a result of another batch dropped`);
  answers.sort((a, b) => compareOrder(a.order, b.order));
  const chain = new Map(ctx.resultsChain.map((r, i) => [r.id, i]));
  const failedResults = Array.from(failed.entries())
    .map(([resultId, reason]) => ({ resultId, reason }))
    .sort((a, b) => (chain.get(a.resultId) ?? 0) - (chain.get(b.resultId) ?? 0));
  return {
    suggestions: answers.flatMap(a => a.suggestions),
    modelWarnings: answers.flatMap(a => a.warnings),
    calls: calls.sort((a, b) => a.index - b.index).map(c => c.info),
    failedResults,
    lastError,
    model: (model as { index: number; value: string } | null)?.value ?? null,
  };
}
