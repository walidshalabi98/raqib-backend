/**
 * The only module that talks to the Anthropic API (CLAUDE.md rule 4, BUILD_GUIDE Phase 3).
 *
 * CONTRACT (other modules depend on these exports; keep the names and shapes):
 * - generateStructured(params) → StructuredResult<T>
 * - resolveModel(tier) → model id from AI_MODEL_MAIN / AI_MODEL_FAST
 * - AiMessage, ModelTier, AiEffort, AiCallContext, GenerateStructuredParams, StructuredResult
 * Errors are the typed classes in ./errors.
 *
 * Every call:
 * - sends the shared system prompt (role + knowledge/me-foundations.md §1–12) first, marked
 *   for prompt caching, then the feature's own instructions;
 * - asks for structured output (output_config.format, JSON schema from the zod/v4 schema,
 *   see ./outputSchema), parses the text blocks and validates the answer again with the
 *   same schema;
 * - retries rate limits, overloads, server errors and network failures with exponential
 *   backoff (own loop; the SDK's retries are off), retries a cut-off answer once with a
 *   higher token limit, and turns refusals into AiRefusalError;
 * - counts and prices every attempt the API reports, including a declined attempt before a
 *   server-side fallback (usage.iterations), each at its own model's rates;
 * - writes exactly one AiCall row whatever the outcome, even when the system prompt or the
 *   answer schema cannot be built (ids, token counts, latency, cost; never prompt or answer
 *   text), and one console line with the same numbers.
 */
import Anthropic from '@anthropic-ai/sdk';
import type * as z from 'zod/v4';
import { type AiCallStatus, Prisma } from '@prisma/client';
import { AI_REQUEST_TIMEOUT_MAX_MS, env } from '../../config/env';
import { prisma } from '../../config/prisma';
import { AiInvalidOutputError, AiOutputTruncatedError, AiRefusalError, AiRequestError, type AiError } from './errors';
import { estimateCostUsd, roundUsd, supportsEffort, supportsServerFallback } from './models';
import { outputJsonSchema } from './outputSchema';
import { loadSharedSystemPrompt, type SharedSystemPrompt } from './prompts/system';

/** Which configured model to use: main = AI_MODEL_MAIN (default claude-sonnet-5-5), fast = AI_MODEL_FAST (default claude-haiku-5-5). */
export type ModelTier = 'main' | 'fast';

/** Reasoning effort sent as output_config.effort (only to models that support it). */
export type AiEffort = 'low' | 'medium' | 'high';

/** A plain-text conversation turn. Content must already be free of personal data (aggregates only; documents redacted). */
export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Who the call is for; stored on the AiCall row for cost attribution (ids only). */
export interface AiCallContext {
  organizationId?: string | null;
  projectId?: string | null;
}

export interface GenerateStructuredParams<S extends z.ZodType> {
  /** Stable feature id for logs and the AiCall table, e.g. "framework.indicators", "document.analysis". */
  feature: string;
  /** Model tier, resolved with resolveModel(). */
  model: ModelTier;
  /**
   * Feature-specific instructions. The client always sends the shared system prompt first
   * (role + knowledge/me-foundations.md §1–12, cached with prompt caching), then this text.
   */
  system?: string;
  /** Conversation; usually one user message holding the prompt. */
  messages: AiMessage[];
  /**
   * zod/v4 schema of the answer. Sent as output_config.format (JSON schema from
   * outputJsonSchema in ./outputSchema) and used again to validate the parsed answer. The root must be an object;
   * keep every property required (use "" or null for unknown values) and avoid transforms.
   */
  schema: S;
  /** Output token limit (thinking counts towards it). On stop_reason "max_tokens" the call is retried once with a higher limit. */
  maxTokens: number;
  /** Version of the feature prompt, e.g. "framework-indicators-v4"; stored on the AiCall row. */
  promptVersion: string;
  /** Reasoning effort; default "medium". */
  effort?: AiEffort;
  /** Request timeout in ms; default AI_REQUEST_TIMEOUT_MS (60 000), at most one hour. Long generations (whole frameworks) pass more. */
  timeoutMs?: number;
  /** Organisation and project the call is for (ids only). */
  context?: AiCallContext;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface StructuredResult<T> {
  /** The validated answer. */
  data: T;
  /**
   * Model that produced the answer: after a server-side fallback, `to.model` of the last
   * fallback block; otherwise response.model.
   */
  model: string;
  promptVersion: string;
  /** Token usage summed over every attempt of this call (declined attempts before a server-side fallback included). */
  usage: AiUsage;
  /**
   * Estimated cost in USD of every priced attempt, or null when no attempt's model has a known
   * price. Attempts on a model without a price are left out (with a warning in the log).
   */
  estimatedCostUsd: number | null;
  /** Id of the AiCall row, or null when logging failed (logging never fails the call). */
  aiCallId: string | null;
}

/** Highest output token limit used for the one retry after stop_reason "max_tokens". */
export const MAX_TOKENS_CEILING = 64_000;
/** Backoff: 1s · 2^(retry-1), with jitter, never more than 30s (also caps retry-after). */
export const RETRY_BASE_DELAY_MS = 1_000;
export const RETRY_MAX_DELAY_MS = 30_000;
/** A timed-out request is retried at most this many times per call (timeouts are slow and costly). */
export const MAX_TIMEOUT_RETRIES = 1;
/** Server-side refusal fallback ("default" routing by refusal category). */
export const REFUSAL_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Model id for a tier, from the validated env (never hard-coded in services). */
export function resolveModel(tier: ModelTier): string {
  return tier === 'fast' ? env.aiModelFast : env.aiModelMain;
}

// ---------------------------------------------------------------------------
// SDK seam: the minimal surface of the Anthropic client this module uses.

type CreateMessage = (body: any, options?: { timeout?: number; maxRetries?: number }) => Promise<unknown>;

/** The parts of the Anthropic client used here (tests pass a fake through configureAiClientForTests). */
export interface AiSdkClient {
  messages: { create: CreateMessage };
  beta: { messages: { create: CreateMessage } };
}

/** Token counts of a response, or of one entry of usage.iterations. */
interface SdkUsageCounts {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/**
 * One entry of usage.iterations (beta endpoint): usage per attempt, each with its own model.
 * After a server-side fallback: a 'message' entry per declined attempt and a
 * 'fallback_message' entry for the attempt that served the answer.
 */
interface SdkIterationUsage extends SdkUsageCounts {
  type?: string;
  model?: string | null;
}

/** The fields of a Messages API response this module reads. */
interface SdkResponse {
  model?: string;
  stop_reason?: string | null;
  stop_details?: { category?: string | null } | null;
  /** Text blocks hold the answer; a 'fallback' block marks where a fallback model took over (`to.model`). */
  content?: Array<{ type: string; text?: string; to?: { model?: string | null } | null }>;
  usage?: (SdkUsageCounts & { iterations?: SdkIterationUsage[] | null }) | null;
}

/** What is stored in the AiCall table (ids and numbers only). */
export interface AiCallRecord {
  feature: string;
  model: string;
  servedModel: string | null;
  promptVersion: string;
  systemPromptVersion: string | null;
  status: AiCallStatus;
  stopReason: string | null;
  errorType: string | null;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
  estimatedCostUsd: number | null;
  organizationId: string | null;
  projectId: string | null;
}

/** Writes one AiCall row and returns its id. */
export type AiCallLogger = (record: AiCallRecord) => Promise<string | null>;

interface Deps {
  anthropic: () => AiSdkClient;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  logCall: AiCallLogger;
  now: () => number;
}

let sdkClient: AiSdkClient | null = null;

function defaultAnthropic(): AiSdkClient {
  if (!sdkClient) {
    sdkClient = new Anthropic({ apiKey: env.anthropicApiKey, maxRetries: 0, timeout: env.aiRequestTimeoutMs }) as unknown as AiSdkClient;
  }
  return sdkClient;
}

/**
 * Default AiCall logger: one row in the AiCall table. When the project or organisation was
 * deleted while the call ran (foreign key error P2003), the row is written once more without
 * it, so the cost of the call is still recorded: without the project only when the error names
 * the project's foreign key alone (the organisation keeps the cost), otherwise without both.
 */
export async function writeAiCall(record: AiCallRecord): Promise<string | null> {
  try {
    const row = await prisma.aiCall.create({ data: record, select: { id: true } });
    return row.id;
  } catch (err) {
    const hasOwner = record.organizationId !== null || record.projectId !== null;
    if (!hasOwner || !(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003')) throw err;
    const failedKey = `${String(err.meta?.constraint ?? '')} ${String(err.meta?.field_name ?? '')}`;
    const projectOnly = record.projectId !== null && /projectId/.test(failedKey) && !/organizationId/.test(failedKey);
    const data = projectOnly ? { ...record, projectId: null } : { ...record, organizationId: null, projectId: null };
    console.warn(
      `[ai] ${record.feature}: the ${projectOnly ? 'project' : 'organisation or project'} of this call no longer exists; AiCall row kept without ${projectOnly ? 'it' : 'them'}`,
    );
    const row = await prisma.aiCall.create({ data, select: { id: true } });
    return row.id;
  }
}

const defaultDeps: Deps = {
  anthropic: defaultAnthropic,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  random: Math.random,
  logCall: writeAiCall,
  now: () => Date.now(),
};

let deps: Deps = { ...defaultDeps };

/**
 * Test seam: replace the SDK client, sleep, randomness, clock or AiCall logger.
 * Production code never calls this.
 */
export function configureAiClientForTests(overrides: {
  anthropic?: AiSdkClient;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  logCall?: AiCallLogger;
  now?: () => number;
}): void {
  const { anthropic, ...rest } = overrides;
  deps = { ...deps, ...rest, ...(anthropic ? { anthropic: () => anthropic } : {}) };
}

/**
 * For scripts that must not write to the API database (npm run eval:kpi; design section 4.6, knowledge/kpi-assistant-spec.md
 * §A8): replace the AiCall logger; null restores writeAiCall. Every call still logs its console line (ids and numbers only).
 */
export function setAiCallLogger(logger: AiCallLogger | null): void {
  deps = { ...deps, logCall: logger ?? writeAiCall };
}

/** Restores the real SDK client, timers and logger (and drops the cached SDK client). */
export function resetAiClientForTests(): void {
  deps = { ...defaultDeps };
  sdkClient = null;
}

// ---------------------------------------------------------------------------

/** Mutable bookkeeping for one generateStructured call; becomes the AiCall row. */
interface CallState {
  feature: string;
  /** Model id sent in the request. */
  model: string;
  attempts: number;
  timeoutRetries: number;
  usage: AiUsage;
  /** Sum of the cost estimates of the priced parts (a response, or one attempt of it after a server-side fallback). */
  cost: number;
  pricedParts: number;
  /** Parts left out of `cost` because their model has no known price. */
  unpricedParts: number;
  servedModel: string | null;
  stopReason: string | null;
}

/** The call's estimated cost: null only when nothing could be priced (an unknown model served every response). */
function callCost(state: CallState): number | null {
  return state.unpricedParts > 0 && state.pricedParts === 0 ? null : roundUsd(state.cost);
}

/** Thrown inside the retry loop; carries what the AiCall row and the AiRequestError need. */
class RequestFailure extends Error {
  constructor(
    readonly status: number | null,
    readonly retryable: boolean,
    /** The SDK (or other) error of the last attempt. */
    readonly original: unknown,
  ) {
    super('AI request failed');
  }
}

/**
 * Calls the model with structured outputs and returns the validated answer.
 * Throws AiRefusalError, AiOutputTruncatedError, AiInvalidOutputError or AiRequestError (./errors).
 */
export async function generateStructured<S extends z.ZodType>(params: GenerateStructuredParams<S>): Promise<StructuredResult<z.infer<S>>> {
  const started = deps.now();
  const model = resolveModel(params.model);
  let shared: SharedSystemPrompt | null = null;
  const state: CallState = {
    feature: params.feature,
    model,
    attempts: 0,
    timeoutRetries: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    cost: 0,
    pricedParts: 0,
    unpricedParts: 0,
    servedModel: null,
    stopReason: null,
  };

  const finish = async (status: AiCallStatus, errorType: string | null): Promise<string | null> => {
    const record: AiCallRecord = {
      feature: params.feature,
      model,
      servedModel: state.servedModel,
      promptVersion: params.promptVersion,
      systemPromptVersion: shared?.version ?? null,
      status,
      stopReason: state.stopReason,
      errorType,
      attempts: state.attempts,
      ...state.usage,
      latencyMs: Math.max(0, Math.round(deps.now() - started)),
      estimatedCostUsd: callCost(state),
      organizationId: params.context?.organizationId ?? null,
      projectId: params.context?.projectId ?? null,
    };
    logLine(record);
    try {
      return await deps.logCall(record);
    } catch (err) {
      console.warn(`[ai] could not write the AiCall row for ${params.feature}: ${(err as Error)?.name ?? 'Error'}`);
      return null;
    }
  };

  /** Writes the AiCall row of a failed call and attaches its usage and cost to the error that is then thrown (AI-4). */
  const failed = async <E extends AiError>(error: E, status: AiCallStatus, errorType: string | null): Promise<E> => {
    const aiCallId = await finish(status, errorType);
    error.call = { usage: { ...state.usage }, estimatedCostUsd: callCost(state), aiCallId, model: state.servedModel };
    return error;
  };

  // Built before any request, inside a try: a broken knowledge file or a schema the converter
  // cannot express still writes the AiCall row and throws a typed error (nothing is sent).
  let prepared: { systemText: string; outputSchema: Record<string, unknown> };
  try {
    shared = loadSharedSystemPrompt();
    prepared = { systemText: shared.text, outputSchema: outputJsonSchema(params.schema) };
  } catch (err) {
    throw await failed(new AiRequestError(params.feature, null, false, 0), 'error', errorName(err));
  }
  const { systemText, outputSchema } = prepared;
  const effort = params.effort ?? 'medium';
  const useFallback = env.aiRefusalFallback === 'default' && supportsServerFallback(model);
  const buildBody = (maxTokens: number) => ({
    model,
    max_tokens: maxTokens,
    system: [
      { type: 'text', text: systemText, cache_control: { type: 'ephemeral' } },
      ...(params.system ? [{ type: 'text', text: params.system }] : []),
    ],
    messages: params.messages.map(m => ({ role: m.role, content: m.content })),
    output_config: {
      format: { type: 'json_schema', schema: outputSchema },
      ...(supportsEffort(model) ? { effort } : {}),
    },
    ...(useFallback ? { betas: [REFUSAL_FALLBACK_BETA], fallbacks: 'default' } : {}),
  });

  let maxTokens = params.maxTokens;
  let timeoutMs = Math.min(params.timeoutMs ?? env.aiRequestTimeoutMs, AI_REQUEST_TIMEOUT_MAX_MS);
  let response: SdkResponse;
  try {
    response = await send(buildBody(maxTokens), timeoutMs, useFallback, state);
    const retryLimit = Math.min(2 * params.maxTokens, MAX_TOKENS_CEILING);
    if (response.stop_reason === 'max_tokens' && retryLimit > maxTokens) {
      maxTokens = retryLimit;
      timeoutMs = Math.min(timeoutMs * 2, AI_REQUEST_TIMEOUT_MAX_MS);
      response = await send(buildBody(maxTokens), timeoutMs, useFallback, state);
    }
  } catch (err) {
    const failure = err instanceof RequestFailure ? err : new RequestFailure(null, false, err);
    throw await failed(new AiRequestError(params.feature, failure.status, failure.retryable, state.attempts), 'error', errorName(failure.original));
  }

  // Refusal first: the content of a refused response is not read.
  if (response.stop_reason === 'refusal') {
    const error = new AiRefusalError(params.feature, response.stop_details?.category ?? null);
    throw await failed(error, 'refusal', error.name);
  }
  // Cut off: after the max_tokens retry, or because the context window is full (no retry:
  // more output tokens cannot help). Both are stored with status max_tokens and their stop reason.
  if (response.stop_reason === 'max_tokens' || response.stop_reason === 'model_context_window_exceeded') {
    const error = new AiOutputTruncatedError(params.feature, maxTokens, response.stop_reason);
    throw await failed(error, 'max_tokens', error.name);
  }

  const text = (response.content ?? [])
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Never include the parser message: it quotes part of the answer.
    const error = new AiInvalidOutputError(params.feature, [text.trim() ? 'root: not valid JSON' : 'root: empty answer']);
    throw await failed(error, 'invalid_output', error.name);
  }
  const result = params.schema.safeParse(parsed);
  if (!result.success) {
    const error = new AiInvalidOutputError(params.feature, describeIssues(result.error.issues));
    throw await failed(error, 'invalid_output', error.name);
  }

  const aiCallId = await finish('success', null);
  return {
    data: result.data as z.infer<S>,
    model: state.servedModel ?? model,
    promptVersion: params.promptVersion,
    usage: { ...state.usage },
    estimatedCostUsd: callCost(state),
    aiCallId,
  };
}

/**
 * One logical request: HTTP attempts with retries and backoff (at most AI_MAX_RETRIES
 * retries per request, and MAX_TIMEOUT_RETRIES timeouts per call). Adds usage and cost to `state`.
 */
async function send(body: Record<string, unknown>, timeoutMs: number, beta: boolean, state: CallState): Promise<SdkResponse> {
  const client = deps.anthropic();
  const options = { timeout: timeoutMs, maxRetries: 0 };
  let retries = 0;
  for (;;) {
    state.attempts += 1;
    try {
      const response = (await (beta ? client.beta.messages.create(body, options) : client.messages.create(body, options))) as SdkResponse;
      recordResponse(response, state);
      return response;
    } catch (err) {
      const { status, retryable, isTimeout } = classify(err);
      const allowed = retryable && retries < env.aiMaxRetries && (!isTimeout || state.timeoutRetries < MAX_TIMEOUT_RETRIES);
      if (!allowed) throw new RequestFailure(status, retryable, err);
      retries += 1;
      if (isTimeout) state.timeoutRetries += 1;
      await deps.sleep(retryDelayMs(retries, err));
    }
  }
}

/** Adds one response's usage, cost, served model and stop reason to `state`. */
function recordResponse(response: SdkResponse, state: CallState): void {
  // The content of a refused response is not read (see generateStructured).
  const servedModel = (response.stop_reason === 'refusal' ? null : fallbackTarget(response)) ?? response.model ?? null;
  state.servedModel = servedModel ?? state.servedModel;
  state.stopReason = response.stop_reason ?? null;
  for (const part of billedParts(response, servedModel, state.model)) {
    state.usage.inputTokens += part.usage.inputTokens;
    state.usage.outputTokens += part.usage.outputTokens;
    state.usage.cacheReadTokens += part.usage.cacheReadTokens;
    state.usage.cacheWriteTokens += part.usage.cacheWriteTokens;
    const cost = estimateCostUsd(part.model, part.usage);
    if (cost === null) {
      state.unpricedParts += 1;
      console.warn(`[ai] ${state.feature}: no price for model ${part.model ?? '(none)'}; its tokens are left out of the cost estimate`);
    } else {
      state.pricedParts += 1;
      state.cost += cost;
    }
  }
}

/**
 * The model that took over after a server-side fallback: `to.model` (always the canonical id)
 * of the last 'fallback' content block, or null when the response has none.
 */
function fallbackTarget(response: SdkResponse): string | null {
  const content = Array.isArray(response.content) ? response.content : [];
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const to = content[i]?.type === 'fallback' ? content[i].to?.model : null;
    if (typeof to === 'string' && to !== '') return to;
  }
  return null;
}

/**
 * What one response is billed for, as (model, tokens) parts. After a server-side fallback,
 * usage.iterations is the per-attempt record (the top-level usage covers only the attempt
 * that produced the returned message): every 'message' entry (a declined attempt; a missing
 * model means the requested one) and the 'fallback_message' entry (the serving attempt), each
 * priced at its own model's rates. The same holds for a refusal after which every fallback
 * declined too (several 'message' entries; this client uses no server tools, so each one is
 * an attempt). Otherwise the top-level usage at the served model's rates, so compaction or
 * advisor entries (never requested here) are not counted twice.
 */
function billedParts(response: SdkResponse, servedModel: string | null, requestedModel: string): Array<{ model: string | null; usage: AiUsage }> {
  const iterations = Array.isArray(response.usage?.iterations) ? response.usage.iterations : [];
  const attempts = iterations.filter(entry => entry?.type === 'message' || entry?.type === 'fallback_message');
  const fellBack = attempts.some(entry => entry.type === 'fallback_message') || (response.stop_reason === 'refusal' && attempts.length > 1);
  if (fellBack) {
    return attempts.map(entry => ({
      model: entry.model || (entry.type === 'fallback_message' ? servedModel : requestedModel),
      usage: tokenUsage(entry),
    }));
  }
  return [{ model: servedModel, usage: tokenUsage(response.usage) }];
}

function tokenUsage(counts: SdkUsageCounts | null | undefined): AiUsage {
  return {
    inputTokens: counts?.input_tokens ?? 0,
    outputTokens: counts?.output_tokens ?? 0,
    cacheReadTokens: counts?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: counts?.cache_creation_input_tokens ?? 0,
  };
}

/** Retry policy by SDK error class and HTTP status (never by message text). */
function classify(err: unknown): { status: number | null; retryable: boolean; isTimeout: boolean } {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return { status: null, retryable: true, isTimeout: true };
  if (err instanceof Anthropic.APIUserAbortError) return { status: null, retryable: false, isTimeout: false };
  if (err instanceof Anthropic.APIConnectionError) return { status: null, retryable: true, isTimeout: false };
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
    const status = err.status;
    const shouldRetry = header(err, 'x-should-retry');
    if (shouldRetry === 'true') return { status, retryable: true, isTimeout: false };
    if (shouldRetry === 'false') return { status, retryable: false, isTimeout: false };
    return { status, retryable: status === 408 || status === 409 || status === 429 || status >= 500, isTimeout: false };
  }
  return { status: null, retryable: false, isTimeout: false };
}

/** Delay before retry number `retry` (1-based): retry-after-ms / retry-after when given, else exponential backoff with jitter; at most 30s. */
export function retryDelayMs(retry: number, err?: unknown, random: () => number = deps.random): number {
  const retryAfter = retryAfterMs(err);
  if (retryAfter !== null) return Math.min(retryAfter, RETRY_MAX_DELAY_MS);
  const jitter = 1 - random() * 0.25;
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** (retry - 1) * jitter, RETRY_MAX_DELAY_MS);
}

function retryAfterMs(err: unknown): number | null {
  const ms = Number.parseFloat(header(err, 'retry-after-ms') ?? '');
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const value = header(err, 'retry-after');
  if (!value) return null;
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function header(err: unknown, name: string): string | null {
  const headers = (err as { headers?: unknown } | null)?.headers;
  if (!headers) return null;
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name);
  const value = (headers as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : null;
}

/**
 * "path: problem" strings for the AiInvalidOutputError and logs. Built from the issue code
 * and schema facts only, so no value from the answer (which may hold document text) leaks.
 */
export function describeIssues(issues: ReadonlyArray<z.core.$ZodIssue>): string[] {
  return issues.slice(0, 20).map(issue => {
    const path = issue.path.length ? issue.path.map(p => (typeof p === 'number' ? `[${p}]` : String(p))).join('.').replace(/\.\[/g, '[') : 'root';
    return `${path}: ${describeIssue(issue)}`;
  });
}

function describeIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return `expected ${issue.expected}`;
    case 'invalid_value':
      return 'not one of the allowed values';
    case 'unrecognized_keys':
      return `${issue.keys.length} unexpected key(s)`;
    case 'too_small':
      return `too small (minimum ${String(issue.minimum)})`;
    case 'too_big':
      return `too big (maximum ${String(issue.maximum)})`;
    case 'invalid_union':
      return 'does not match any allowed shape';
    default:
      return issue.code;
  }
}

function errorName(err: unknown): string {
  if (err instanceof Error) return err.constructor?.name || err.name || 'Error';
  return typeof err;
}

/** One line per call with numbers only (never prompt or answer text). */
function logLine(r: AiCallRecord): void {
  console.info(
    `[ai] ${r.feature} status=${r.status} model=${r.servedModel ?? r.model} attempts=${r.attempts}` +
      ` tokens in=${r.inputTokens} out=${r.outputTokens} cacheRead=${r.cacheReadTokens} cacheWrite=${r.cacheWriteTokens}` +
      ` latencyMs=${r.latencyMs} costUsd=${r.estimatedCostUsd ?? 'unknown'}`,
  );
}
