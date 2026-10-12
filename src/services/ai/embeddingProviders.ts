/**
 * Embedding providers (BUILD_GUIDE Phase 3 task 6, kpi-assistant-spec §A4 "Embeddings").
 *
 * Anthropic has no embeddings model; its docs point to Voyage AI. The provider sits behind
 * EmbeddingProvider so it can be swapped, and every feature must work without it: with no
 * VOYAGE_API_KEY the no-op provider returns null and callers fall back to keyword search.
 *
 * Library entries are embedded with input type "document" (at seed time and on edit); result
 * statements are embedded with "query" at search time. Only reference text is embedded, never
 * personal data (CLAUDE.md rule 5). Texts are never logged and never appear in error messages.
 *
 * This module never loads the API configuration (src/config/env.ts): `npm run seed:library`
 * builds its provider from VOYAGE_API_KEY and VOYAGE_MODEL alone and runs with DATABASE_URL and
 * nothing else. The app uses getEmbeddingProvider() in embeddings.ts, which passes the validated env.
 */
import { EMBEDDING_DIMENSIONS } from '../library/vector';
import { AiError } from './errors';

// EMBEDDING_DIMENSIONS (1024, the library column) and toVectorLiteral live in library/vector.ts.
export { EMBEDDING_DIMENSIONS, toVectorLiteral } from '../library/vector';
export const DEFAULT_VOYAGE_MODEL = 'voyage-4';
export const VOYAGE_EMBEDDINGS_URL = 'https://api.voyageai.com/v1/embeddings';
/** Texts per Voyage request (kept well under Voyage's per-request text and token limits). */
export const VOYAGE_MAX_BATCH = 128;
export const EMBEDDING_TIMEOUT_MS = 60_000;
/** Retries after a rate limit (429), server error (5xx), timeout or network failure. */
export const EMBEDDING_MAX_RETRIES = 3;
/** Backoff: 1s · 2^(retry-1), with jitter, never more than 30s (also caps Retry-After). */
export const EMBEDDING_RETRY_BASE_DELAY_MS = 1_000;
export const EMBEDDING_RETRY_MAX_DELAY_MS = 30_000;

/** "document" for texts that are stored and searched; "query" for the search text. */
export type EmbeddingInputType = 'document' | 'query';

export interface EmbeddingProvider {
  /** Provider id for messages, e.g. "voyage" or "none". */
  readonly name: string;
  /** Embedding model, or null when the provider is disabled. */
  readonly model: string | null;
  /** Length of every vector (always EMBEDDING_DIMENSIONS for the library column). */
  readonly dimensions: number;
  /** False for the no-op provider: embed() returns null and callers use keyword search. */
  readonly enabled: boolean;
  /** Why the provider is disabled (for messages), e.g. "VOYAGE_API_KEY is not set". */
  readonly disabledReason?: string;
  /** One vector per text, in input order; null when the provider is disabled. Throws EmbeddingError on failure. */
  embed(texts: string[], inputType: EmbeddingInputType): Promise<number[][] | null>;
}

/** An embedding request failed or returned unusable vectors. Messages never contain the input texts. */
export class EmbeddingError extends AiError {
  constructor(
    message: string,
    /** HTTP status, or null for invalid input, network errors and timeouts. */
    public readonly status: number | null = null,
    /** Whether the failure was retryable (and retries ran out). */
    public readonly retryable = false,
    /** HTTP attempts made for the failing batch (0 when nothing was sent). */
    public readonly attempts = 0,
  ) {
    super(message, 'embeddings');
    this.name = 'EmbeddingError';
  }
}

/** Used when no embedding key is configured: embed() returns null, so callers use keyword search. */
export class NoopEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'none';
  readonly model = null;
  readonly dimensions = EMBEDDING_DIMENSIONS;
  readonly enabled = false;

  constructor(readonly disabledReason = 'VOYAGE_API_KEY is not set') {}

  async embed(_texts: string[], _inputType: EmbeddingInputType): Promise<null> {
    return null;
  }
}

export interface VoyageProviderOptions {
  apiKey: string;
  /** Voyage model (default voyage-4: multilingual, 1024 dimensions requested). */
  model?: string;
  /** Per-request timeout (default 60 s). */
  timeoutMs?: number;
  /** Retries per batch after 429, 5xx, timeouts and network errors (default 3). */
  maxRetries?: number;
  /** Texts per request (default and maximum VOYAGE_MAX_BATCH). */
  batchSize?: number;
  /** Test seam: waits between retries. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: jitter source. */
  random?: () => number;
}

/** Voyage AI embeddings over HTTPS (global fetch). */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'voyage';
  readonly model: string;
  readonly dimensions = EMBEDDING_DIMENSIONS;
  readonly enabled = true;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly batchSize: number;
  private readonly apiKey: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: VoyageProviderOptions) {
    if (!options.apiKey?.trim()) throw new EmbeddingError('VoyageEmbeddingProvider needs an API key (VOYAGE_API_KEY)');
    this.apiKey = options.apiKey.trim();
    this.model = options.model?.trim() || DEFAULT_VOYAGE_MODEL;
    this.timeoutMs = options.timeoutMs ?? EMBEDDING_TIMEOUT_MS;
    this.maxRetries = Math.max(0, options.maxRetries ?? EMBEDDING_MAX_RETRIES);
    this.batchSize = Math.min(Math.max(1, options.batchSize ?? VOYAGE_MAX_BATCH), VOYAGE_MAX_BATCH);
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  async embed(texts: string[], inputType: EmbeddingInputType): Promise<number[][]> {
    if (inputType !== 'document' && inputType !== 'query') {
      throw new EmbeddingError('Embedding input type must be "document" or "query"');
    }
    texts.forEach((text, i) => {
      if (typeof text !== 'string' || text.trim() === '') throw new EmbeddingError(`Embedding input [${i}] is empty`);
    });

    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += this.batchSize) {
      vectors.push(...(await this.embedBatch(texts.slice(start, start + this.batchSize), inputType)));
    }
    return vectors;
  }

  /** One batch: HTTP attempts with timeout, retries and backoff; the answer is validated before it is returned. */
  private async embedBatch(batch: string[], inputType: EmbeddingInputType): Promise<number[][]> {
    const body = JSON.stringify({ input: batch, model: this.model, input_type: inputType, output_dimension: this.dimensions });
    for (let attempt = 1; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let failure: { status: number | null; retryable: boolean; reason: string; retryAfterMs: number | null };
      try {
        const response = await fetch(VOYAGE_EMBEDDINGS_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body,
          signal: controller.signal,
        });
        if (response.ok) {
          let payload: unknown;
          try {
            payload = await response.json();
          } catch (err) {
            if (controller.signal.aborted) throw err;
            throw new EmbeddingError('Voyage returned a response that is not JSON', response.status, false, attempt);
          }
          return parseEmbeddingResponse(payload, batch.length, this.dimensions, attempt);
        }
        const status = response.status;
        failure = {
          status,
          retryable: status === 408 || status === 429 || status >= 500,
          reason: await describeHttpFailure(response),
          retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
        };
      } catch (err) {
        if (err instanceof EmbeddingError) throw err;
        failure = controller.signal.aborted
          ? { status: null, retryable: true, reason: `Voyage embeddings request timed out after ${this.timeoutMs} ms`, retryAfterMs: null }
          : { status: null, retryable: true, reason: `Voyage embeddings request failed (network error: ${errorName(err)})`, retryAfterMs: null };
      } finally {
        clearTimeout(timer);
      }

      if (!failure.retryable || attempt > this.maxRetries) {
        const suffix = failure.retryable ? ` (gave up after ${attempt} attempt${attempt === 1 ? '' : 's'})` : '';
        throw new EmbeddingError(`${failure.reason}${suffix}`, failure.status, failure.retryable, attempt);
      }
      await this.sleep(embeddingRetryDelayMs(attempt, failure.retryAfterMs, this.random));
    }
  }
}

/** Embedding settings: the app passes the validated env (src/config/env.ts); the library seed reads process.env. */
export interface EmbeddingSettings {
  voyageApiKey?: string | null;
  voyageModel?: string | null;
}

/** Voyage when a key is given (model voyageModel, default voyage-4), otherwise the no-op provider. */
export function createEmbeddingProvider(settings: EmbeddingSettings): EmbeddingProvider {
  const apiKey = settings.voyageApiKey?.trim();
  if (!apiKey) return new NoopEmbeddingProvider();
  return new VoyageEmbeddingProvider({ apiKey, model: settings.voyageModel?.trim() || DEFAULT_VOYAGE_MODEL });
}

/**
 * Validates a Voyage response ({ data: [{ embedding, index }] }) and returns the vectors in input
 * order. Throws EmbeddingError when the count, the indexes or any vector is wrong.
 */
export function parseEmbeddingResponse(payload: unknown, expectedCount: number, dimensions = EMBEDDING_DIMENSIONS, attempts = 1): number[][] {
  const fail = (problem: string) => new EmbeddingError(`Voyage returned unusable embeddings: ${problem}`, null, false, attempts);
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw fail('the response has no data list');
  if (data.length !== expectedCount) throw fail(`${data.length} embedding${data.length === 1 ? '' : 's'} for ${expectedCount} text${expectedCount === 1 ? '' : 's'}`);

  const vectors: number[][] = new Array(expectedCount);
  data.forEach((item, position) => {
    const index = (item as { index?: unknown } | null)?.index ?? position;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= expectedCount || vectors[index]) {
      throw fail(`invalid or repeated index at position ${position}`);
    }
    const embedding = (item as { embedding?: unknown } | null)?.embedding;
    if (!Array.isArray(embedding)) throw fail(`no vector for text ${index}`);
    if (embedding.length !== dimensions) throw fail(`vector ${index} has ${embedding.length} dimensions (expected ${dimensions})`);
    if (!embedding.every(v => typeof v === 'number' && Number.isFinite(v))) throw fail(`vector ${index} contains a value that is not a finite number`);
    vectors[index] = embedding as number[];
  });
  return vectors;
}

/** Delay before retry number `retry` (1-based): Retry-After when given, else exponential backoff with jitter; at most 30 s. */
export function embeddingRetryDelayMs(retry: number, retryAfterMs: number | null = null, random: () => number = Math.random): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, EMBEDDING_RETRY_MAX_DELAY_MS);
  const jitter = 1 - random() * 0.25;
  return Math.min(EMBEDDING_RETRY_BASE_DELAY_MS * 2 ** (retry - 1) * jitter, EMBEDDING_RETRY_MAX_DELAY_MS);
}

/** Retry-After in seconds or as an HTTP date, in ms; null when missing or unreadable. */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/**
 * "Voyage … (HTTP 400: detail)". Voyage error bodies are { detail: "…" } and describe the
 * request (model, limits), not its texts; the detail is shortened to one line of 200 characters.
 */
async function describeHttpFailure(response: Response): Promise<string> {
  if (response.status === 401 || response.status === 403) {
    return `Voyage rejected the API key (HTTP ${response.status}); check VOYAGE_API_KEY`;
  }
  let detail = '';
  try {
    const parsed = JSON.parse(await response.text());
    if (typeof parsed?.detail === 'string') detail = parsed.detail.replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch {
    // Not JSON (e.g. a proxy error page): the status is enough.
  }
  return `Voyage embeddings request failed (HTTP ${response.status}${detail ? `: ${detail}` : ''})`;
}

function errorName(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { cause?: { code?: unknown } }).cause?.code;
    return typeof code === 'string' ? `${err.name} ${code}` : err.name;
  }
  return typeof err;
}
