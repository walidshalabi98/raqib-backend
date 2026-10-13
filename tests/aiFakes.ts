import Anthropic from '@anthropic-ai/sdk';
import type { AiSdkClient } from '../src/services/ai/client';
import { NoopEmbeddingProvider, type EmbeddingInputType, type EmbeddingProvider } from '../src/services/ai/embeddingProviders';
import { loadLibraryFile } from '../src/services/library/load';
import type {
  KpiLibraryEntry, KpiModelAnswer, KpiModelRequest, KpiModelResponse, KpiRawSuggestion, LibrarySource, ModelCaller,
} from '../src/services/kpi/types';

/**
 * Shared AI fakes for the Phase 4 tests (design section 3.1, E4): a fake Anthropic SDK for tests that run the real
 * client.ts (configureAiClientForTests), raw Messages API JSON builders, a fake ModelCaller for the KPI pipeline, fake and
 * no-op embedding providers and an in-memory library source built from knowledge/indicator-library.json. Nothing here
 * reaches the network or a database; every value is made up (no personal data, no real key).
 */

// ------------------------------------------------------------------ fake Anthropic SDK

export interface SentRequest {
  endpoint: 'messages' | 'beta.messages';
  body: Record<string, any>;
  options: { timeout?: number; maxRetries?: number } | undefined;
}

/** A queued reply: a raw response object, an Error to throw, or a function of the request body. */
export type SdkReply = Record<string, unknown> | Error | ((body: Record<string, any>, index: number) => unknown);

/**
 * A fake Anthropic client that records every request (deep copies) and answers with `replies` in order (a list), or
 * with `replies(body, index)` (a function, for concurrent calls whose order is not fixed). A thrown or returned Error is
 * thrown by `create`. An empty queue throws "unexpected request #n".
 */
export function fakeSdk(replies: SdkReply[] | ((body: Record<string, any>, index: number) => unknown)): { client: AiSdkClient; sent: SentRequest[] } {
  const sent: SentRequest[] = [];
  const queue = Array.isArray(replies) ? [...replies] : null;
  const create = (endpoint: SentRequest['endpoint']) => async (body: Record<string, any>, options?: SentRequest['options']) => {
    sent.push({ endpoint, body: structuredClone(body), options });
    const index = sent.length - 1;
    let reply: unknown;
    if (queue) {
      const next = queue.shift();
      if (next === undefined) throw new Error(`unexpected request #${sent.length}`);
      reply = typeof next === 'function' ? await next(body, index) : next;
    } else {
      reply = await (replies as (body: Record<string, any>, index: number) => unknown)(body, index);
    }
    if (reply instanceof Error) throw reply;
    return structuredClone(reply);
  };
  return { client: { messages: { create: create('messages') }, beta: { messages: { create: create('beta.messages') } } }, sent };
}

export interface Tokens { input: number; output: number; cacheWrite: number; cacheRead: number }

const DEFAULT_TOKENS: Tokens = { input: 1200, output: 400, cacheWrite: 0, cacheRead: 0 };

/** usage as the Messages API returns it (counts plus the cache breakdown and service fields). */
export function usageJson(t: Partial<Tokens> = {}, iterations: unknown[] | null = null) {
  const tokens = { ...DEFAULT_TOKENS, ...t };
  return {
    input_tokens: tokens.input,
    output_tokens: tokens.output,
    cache_creation_input_tokens: tokens.cacheWrite,
    cache_read_input_tokens: tokens.cacheRead,
    cache_creation: { ephemeral_5m_input_tokens: tokens.cacheWrite, ephemeral_1h_input_tokens: 0 },
    server_tool_use: null,
    service_tier: 'standard',
    inference_geo: 'global',
    speed: 'standard',
    output_tokens_details: null,
    fallback_credit: null,
    iterations,
  };
}

let messageCounter = 0;

/** A raw Messages API response holding a structured-output answer (thinking block omitted text, as the API sends it). */
export function rawMessage(model: string, answer: unknown, tokens: Partial<Tokens> = {}, extra: { stopReason?: string; category?: string | null } = {}) {
  messageCounter += 1;
  return {
    id: `msg_fake_${messageCounter}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [
      { type: 'thinking', thinking: '', signature: 'ZmFrZS1zaWduYXR1cmUtZm9yLXRlc3RzLW9ubHk=' },
      { type: 'text', text: typeof answer === 'string' ? answer : JSON.stringify(answer) },
    ],
    stop_reason: extra.stopReason ?? 'end_turn',
    stop_sequence: null,
    stop_details: extra.category === undefined ? null : { type: 'refusal', category: extra.category },
    container: null,
    context_management: null,
    usage: usageJson(tokens),
  };
}

/** A refused response (stop_reason "refusal"; content is never read). */
export function refusalMessage(model: string, category: string | null = null) {
  return { ...rawMessage(model, '', { output: 5 }, { stopReason: 'refusal', category }), content: [] };
}

/** A cut-off response (stop_reason "max_tokens"; the text is incomplete JSON). */
export function truncatedMessage(model: string) {
  return rawMessage(model, '{"suggestions":[{"resultCode":"O1"', { output: 6000 }, { stopReason: 'max_tokens' });
}

/** An SDK APIError with an HTTP status (e.g. 401, 429, 529), as the real client receives it. */
export function sdkError(status: number, headers: Record<string, string> = {}) {
  return Anthropic.APIError.generate(status, { type: 'error', error: { type: 'api_error', message: 'test' } }, 'test', new Headers(headers));
}

// ------------------------------------------------------------------ KPI prompt parsing (for fake answers)

/** The SUGGEST FOR lines of a KPI user message as { code, level, candidates } (design 6.2 format). */
export function suggestForLines(userMessage: string): Array<{ code: string; level: string; range: string; candidates: string[] }> {
  const section = userMessage.split('\n\n').find(block => block.startsWith('SUGGEST FOR\n'));
  if (!section) return [];
  return section.split('\n').slice(1).map(line => {
    const head = /^(.+?) \[(impact|outcome|output)\]: suggest (\S+)/.exec(line);
    const candidates = /· candidates: ([A-Z0-9, -]+?)(?: ·|$)/.exec(line)?.[1] ?? '';
    return {
      code: head?.[1] ?? '',
      level: head?.[2] ?? '',
      range: head?.[3] ?? '',
      candidates: candidates.split(',').map(s => s.trim()).filter(id => /^[A-Z]{2}-\d{2}$/.test(id)),
    };
  });
}

/** The section of a KPI user message that starts with `heading` (e.g. "CANDIDATES"), or ''. */
export function promptSection(userMessage: string, heading: string): string {
  return userMessage.split('\n\n').find(block => block.startsWith(heading)) ?? '';
}

// ------------------------------------------------------------------ KPI answers and the fake ModelCaller

/** A valid raw suggestion (WA-02 on O1, clean wording, a target-setting method); override any field. */
export function kpiRawSuggestionFixture(overrides: Partial<KpiRawSuggestion> = {}): KpiRawSuggestion {
  return {
    resultCode: 'O1',
    level: 'outcome',
    libraryId: 'WA-02',
    isCustom: false,
    customReason: '',
    name: '% of target households using at least a basic drinking water service',
    nameAr: 'نسبة الأسر المستهدفة التي تستخدم خدمة مياه شرب أساسية على الأقل',
    definition: 'Share of target households whose main drinking water comes from an improved source close to home.',
    unit: 'percent',
    numerator: 'Households on the basic or safely managed rung',
    denominator: 'All surveyed target households',
    direction: 'increase',
    disaggregation: ['sex_of_household_head', 'location'],
    method: 'hh_survey',
    frequency: 'biannual',
    meansOfVerification: 'Household survey using the JMP core questions on source and collection time',
    baselineSuggestion: '',
    baselineBasis: 'none',
    targetSuggestion: 'baseline + 10 percentage points',
    targetBasis: 'method_only',
    standardReferenceCode: null,
    rationale: 'Measures access to safe drinking water, which is what this outcome is about.',
    qualityNotes: [],
    confidence: 'high',
    ...overrides,
  };
}

/** A raw suggestion copied from a library entry for one result code (the shape a well-behaved model returns). */
export function rawFromEntry(entry: KpiLibraryEntry, resultCode: string, overrides: Partial<KpiRawSuggestion> = {}): KpiRawSuggestion {
  const calculation = (entry.calculation && typeof entry.calculation === 'object' ? entry.calculation : {}) as Record<string, unknown>;
  const percent = entry.unit === 'percent';
  return {
    resultCode,
    level: entry.level === 'activity' ? 'output' : entry.level,
    libraryId: entry.id,
    isCustom: false,
    customReason: '',
    name: entry.name,
    nameAr: entry.nameAr,
    definition: entry.definition,
    unit: entry.unit as KpiRawSuggestion['unit'],
    numerator: percent && typeof calculation.numerator === 'string' ? calculation.numerator : '',
    denominator: percent && typeof calculation.denominator === 'string' ? calculation.denominator : '',
    direction: entry.direction,
    disaggregation: [...entry.disaggregation],
    method: entry.methods[0] as KpiRawSuggestion['method'],
    frequency: entry.frequency,
    meansOfVerification: entry.meansOfVerification,
    baselineSuggestion: '',
    baselineBasis: 'none',
    targetSuggestion: 'baseline + 10 percentage points',
    targetBasis: 'method_only',
    standardReferenceCode: null,
    rationale: 'A standard indicator for this result.',
    qualityNotes: [],
    confidence: 'medium',
    ...overrides,
  };
}

/**
 * The answer a well-behaved model gives to a KPI request, built from request.meta: per batch result its first
 * `perResult` candidates (at most the allowance) not used for an earlier result of the batch (the prompt: never the same
 * candidate for two results), copied from the library, with the result's code.
 */
export function kpiAnswerFromMeta(request: KpiModelRequest, perResult = 2): KpiModelAnswer {
  const byId = new Map(request.meta.candidates.map(c => [c.id, c]));
  const used = new Set<string>();
  const suggestions = request.meta.batch.flatMap(result => {
    const max = Math.min(perResult, request.meta.allowances[result.id]?.max ?? perResult);
    const picked = (request.meta.candidateIdsByResult[result.id] ?? [])
      .filter(id => !used.has(id))
      .map(id => byId.get(id))
      .filter((e): e is KpiLibraryEntry => e !== undefined)
      .slice(0, max);
    for (const entry of picked) used.add(entry.id);
    return picked.map(entry => rawFromEntry(entry, result.code, { level: result.level }));
  });
  return { suggestions, frameworkWarnings: [] };
}

export interface FakeModelCaller {
  caller: ModelCaller;
  /** Every request, in the order the calls started. */
  requests: KpiModelRequest[];
  /** Most calls in flight at the same time. */
  maxInFlight: () => number;
}

/**
 * A fake ModelCaller (no client, no network): records requests, answers with `handler(request, index)` (default
 * kpiAnswerFromMeta). The handler may throw an AiError (AiRefusalError, AiOutputTruncatedError, …) like
 * generateStructured. `delayMs` keeps calls in flight (for concurrency tests).
 */
export function fakeModelCaller(handler: (request: KpiModelRequest, index: number) => KpiModelAnswer | Promise<KpiModelAnswer> = r => kpiAnswerFromMeta(r),
  opts: { model?: string; delayMs?: number; costUsd?: number | null; latencyMs?: number } = {}): FakeModelCaller {
  const requests: KpiModelRequest[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const caller: ModelCaller = async (request): Promise<KpiModelResponse> => {
    const index = requests.length;
    requests.push(request);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (opts.delayMs) await new Promise(resolve => setTimeout(resolve, opts.delayMs));
      const data = await handler(request, index);
      return {
        data,
        model: opts.model ?? (request.tier === 'fast' ? 'fake-fast-model' : 'fake-main-model'),
        usage: { inputTokens: 1000, outputTokens: Math.ceil(JSON.stringify(data).length / 4), cacheReadTokens: 0, cacheWriteTokens: 0 },
        estimatedCostUsd: opts.costUsd === undefined ? 0.01 : opts.costUsd,
        aiCallId: `fake-call-${index + 1}`,
        latencyMs: opts.latencyMs ?? 5,
      };
    } finally {
      inFlight -= 1;
    }
  };
  return { caller, requests, maxInFlight: () => maxInFlight };
}

// ------------------------------------------------------------------ embeddings

/** The no-op provider (no key): embed() returns null; retrieval uses keywords, near-duplicates compare text. */
export const noEmbeddings: EmbeddingProvider = new NoopEmbeddingProvider();

/** Dimensions of the fake vectors (the library column has 1024; the fake is small and only compared with itself). */
export const FAKE_EMBEDDING_DIMENSIONS = 64;

/** A deterministic bag-of-words vector: each lower-case word adds 1 to a hashed dimension; normalised. */
export function fakeVector(text: string, dimensions = FAKE_EMBEDDING_DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    let hash = 0;
    for (const ch of word) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
    vector[hash % dimensions] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map(v => v / norm);
}

export interface FakeEmbeddings extends EmbeddingProvider {
  /** Every embed() call (texts copied). */
  calls: Array<{ texts: string[]; inputType: EmbeddingInputType }>;
}

/**
 * An enabled fake provider (model "fake-embed"): embed() returns `vectorFor(text)` (default fakeVector), or throws
 * `fail`, or returns null with `returnNull`. Records every call.
 */
export function fakeEmbeddings(opts: { model?: string; vectorFor?: (text: string, inputType: EmbeddingInputType) => number[]; fail?: Error; returnNull?: boolean } = {}): FakeEmbeddings {
  const calls: FakeEmbeddings['calls'] = [];
  return {
    name: 'fake',
    model: opts.model ?? 'fake-embed',
    dimensions: FAKE_EMBEDDING_DIMENSIONS,
    enabled: true,
    calls,
    async embed(texts: string[], inputType: EmbeddingInputType) {
      calls.push({ texts: [...texts], inputType });
      if (opts.fail) throw opts.fail;
      if (opts.returnNull) return null as unknown as number[][];
      return texts.map(t => (opts.vectorFor ? opts.vectorFor(t, inputType) : fakeVector(t)));
    },
  };
}

// ------------------------------------------------------------------ library

let libraryCache: KpiLibraryEntry[] | null = null;

/** The 63 entries of knowledge/indicator-library.json as KpiLibraryEntry (standardFramework from standardReference.framework). */
export function libraryEntries(): KpiLibraryEntry[] {
  if (!libraryCache) {
    libraryCache = loadLibraryFile().entries.map(e => ({
      id: e.id, sector: e.sector, tags: e.tags, level: e.level, name: e.name, nameAr: e.nameAr, definition: e.definition,
      unit: e.unit, calculation: e.calculation, direction: e.direction, disaggregation: e.disaggregation, methods: e.methods,
      frequency: e.frequency, meansOfVerification: e.meansOfVerification, standardReference: e.standardReference,
      standardFramework: e.standardReference?.framework ?? null, isStandard: e.isStandard, notes: e.notes.trim() === '' ? null : e.notes,
    } satisfies KpiLibraryEntry));
  }
  return libraryCache.map(e => ({ ...e }));
}

/** One library entry by id (throws for an unknown id). */
export function libraryEntry(id: string): KpiLibraryEntry {
  const found = libraryEntries().find(e => e.id === id);
  if (!found) throw new Error(`no library entry ${id}`);
  return found;
}

/** An in-memory LibrarySource (no database): `entries` (default: the whole library) and stored vectors for `model`. */
export function memoryLibrarySource(entries: KpiLibraryEntry[] = libraryEntries(), vectors?: { model: string; byId: ReadonlyMap<string, number[]> }): LibrarySource {
  return {
    allEntries: async () => entries.map(e => ({ ...e })),
    vectors: async (model, ids) => {
      const out = new Map<string, number[]>();
      if (!vectors || vectors.model !== model) return out;
      for (const id of ids) {
        const v = vectors.byId.get(id);
        if (v) out.set(id, v);
      }
      return out;
    },
  };
}
