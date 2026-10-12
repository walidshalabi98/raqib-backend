import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_VOYAGE_MODEL,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MAX_RETRIES,
  EMBEDDING_RETRY_MAX_DELAY_MS,
  EMBEDDING_TIMEOUT_MS,
  EmbeddingError,
  NoopEmbeddingProvider,
  VOYAGE_EMBEDDINGS_URL,
  VOYAGE_MAX_BATCH,
  VoyageEmbeddingProvider,
  createEmbeddingProvider,
  embeddingRetryDelayMs,
  getEmbeddingProvider,
  parseEmbeddingResponse,
  toVectorLiteral,
  type VoyageProviderOptions,
} from '../src/services/ai/embeddings';
import { AiError } from '../src/services/ai/errors';
import * as embeddingProviders from '../src/services/ai/embeddingProviders';
import * as vectorHelpers from '../src/services/library/vector';

// Never the network: every test stubs global fetch. The texts below stand in for content
// that must never reach logs or error messages.
const SECRET_TEXT = 'Library text SENTINEL-7731 that must never be logged';
const API_KEY = 'pa-test-not-a-real-key-0123456789';

/** A vector whose first value identifies the text it was made for. */
const vectorFor = (n: number, dims = EMBEDDING_DIMENSIONS) => Array.from({ length: dims }, (_, i) => (i === 0 ? n : i / 1024));

function okResponse(vectors: number[][], options: { shuffle?: boolean } = {}): Response {
  const data = vectors.map((embedding, index) => ({ object: 'embedding', embedding, index }));
  if (options.shuffle) data.reverse();
  return new Response(JSON.stringify({ object: 'list', data, model: 'voyage-4', usage: { total_tokens: 10 } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Answers every request with one vector per input text (vector n for the n-th text overall). */
function echoFetch() {
  let served = 0;
  return vi.fn(async (_url: string, init: RequestInit) => {
    const { input } = JSON.parse(String(init.body)) as { input: string[] };
    return okResponse(input.map(() => vectorFor(served++)));
  });
}

function errorResponse(status: number, body: unknown = { detail: 'Something went wrong' }, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function provider(options: Partial<VoyageProviderOptions> = {}) {
  const sleep = vi.fn(async (_ms: number) => {});
  const voyage = new VoyageEmbeddingProvider({ apiKey: API_KEY, sleep, random: () => 0, ...options });
  return { voyage, sleep };
}

async function embedError(promise: Promise<unknown>): Promise<EmbeddingError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(EmbeddingError);
    return err as EmbeddingError;
  }
  throw new Error('expected an EmbeddingError');
}

const bodyOf = (fetchMock: ReturnType<typeof vi.fn>, call = 0) => JSON.parse(String((fetchMock.mock.calls[call][1] as RequestInit).body));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('VoyageEmbeddingProvider: request', () => {
  it('posts the texts to Voyage with the key, model, input type and 1024 dimensions', async () => {
    const fetchMock = stubFetch(echoFetch());
    const { voyage } = provider();

    const vectors = await voyage.embed(['first text', 'second text'], 'document');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(VOYAGE_EMBEDDINGS_URL);
    expect(VOYAGE_EMBEDDINGS_URL).toBe('https://api.voyageai.com/v1/embeddings');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(bodyOf(fetchMock)).toEqual({ input: ['first text', 'second text'], model: 'voyage-4', input_type: 'document', output_dimension: 1024 });
    expect(vectors).toEqual([vectorFor(0), vectorFor(1)]);
  });

  it('uses the query input type and a configured model', async () => {
    const fetchMock = stubFetch(echoFetch());
    const { voyage } = provider({ model: 'voyage-4-lite' });
    expect(voyage.model).toBe('voyage-4-lite');

    await voyage.embed(['Improved household food consumption'], 'query');
    expect(bodyOf(fetchMock)).toMatchObject({ model: 'voyage-4-lite', input_type: 'query', output_dimension: 1024 });
  });

  it('describes itself as an enabled 1024-dimension provider with a 60 s timeout and 3 retries', () => {
    const { voyage } = provider();
    expect(voyage).toMatchObject({ name: 'voyage', model: DEFAULT_VOYAGE_MODEL, dimensions: 1024, enabled: true, timeoutMs: 60_000, maxRetries: 3 });
    expect(DEFAULT_VOYAGE_MODEL).toBe('voyage-4');
    expect(EMBEDDING_TIMEOUT_MS).toBe(60_000);
    expect(EMBEDDING_MAX_RETRIES).toBe(3);
  });

  it('returns the vectors in input order when Voyage answers out of order', async () => {
    stubFetch(async () => okResponse([vectorFor(10), vectorFor(11), vectorFor(12)], { shuffle: true }));
    const { voyage } = provider();
    expect((await voyage.embed(['a', 'b', 'c'], 'document')).map(v => v[0])).toEqual([10, 11, 12]);
  });

  it('sends nothing for an empty list', async () => {
    const fetchMock = stubFetch(echoFetch());
    const { voyage } = provider();
    expect(await voyage.embed([], 'document')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects empty texts and unknown input types before sending anything', async () => {
    const fetchMock = stubFetch(echoFetch());
    const { voyage } = provider();

    const empty = await embedError(voyage.embed([SECRET_TEXT, '   '], 'document'));
    expect(empty.message).toBe('Embedding input [1] is empty');
    expect(empty.attempts).toBe(0);
    const badType = await embedError(voyage.embed(['text'], 'passage' as never));
    expect(badType.message).toMatch(/"document" or "query"/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('needs an API key', () => {
    expect(() => new VoyageEmbeddingProvider({ apiKey: '' })).toThrow(/VOYAGE_API_KEY/);
    expect(() => new VoyageEmbeddingProvider({ apiKey: '   ' })).toThrow(EmbeddingError);
  });
});

describe('VoyageEmbeddingProvider: batching', () => {
  it('sends at most 128 texts per request and keeps the overall order', async () => {
    const fetchMock = stubFetch(echoFetch());
    const { voyage } = provider();
    const texts = Array.from({ length: 300 }, (_, i) => `text ${i}`);

    const vectors = await voyage.embed(texts, 'document');

    expect(VOYAGE_MAX_BATCH).toBe(128);
    expect(fetchMock.mock.calls.map((_, i) => bodyOf(fetchMock, i).input.length)).toEqual([128, 128, 44]);
    expect(bodyOf(fetchMock, 1).input[0]).toBe('text 128');
    expect(bodyOf(fetchMock, 2).input[43]).toBe('text 299');
    expect(vectors).toHaveLength(300);
    expect(vectors.map(v => v[0])).toEqual(texts.map((_, i) => i));
  });

  it('accepts a smaller batch size but never a larger one', async () => {
    const small = stubFetch(echoFetch());
    await provider({ batchSize: 2 }).voyage.embed(['a', 'b', 'c', 'd', 'e'], 'document');
    expect(small).toHaveBeenCalledTimes(3);

    const large = stubFetch(echoFetch());
    const { voyage } = provider({ batchSize: 1000 });
    expect(voyage.batchSize).toBe(128);
    await voyage.embed(Array.from({ length: 129 }, (_, i) => `t${i}`), 'document');
    expect(large).toHaveBeenCalledTimes(2);
  });

  it('stops at the first batch that fails', async () => {
    let calls = 0;
    const fetchMock = stubFetch(async (_url, init) => {
      calls++;
      if (calls === 2) return errorResponse(400, { detail: 'Bad batch' });
      const { input } = JSON.parse(String(init.body)) as { input: string[] };
      return okResponse(input.map((_, i) => vectorFor(i)));
    });
    const err = await embedError(provider({ batchSize: 2 }).voyage.embed(['a', 'b', 'c', 'd', 'e'], 'document'));
    expect(err.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('VoyageEmbeddingProvider: retries', () => {
  it('retries a rate limit (429) and a server error (503) with exponential backoff', async () => {
    const answers = [errorResponse(429), errorResponse(503)];
    const echo = echoFetch();
    const fetchMock = stubFetch(async (url, init) => answers.shift() ?? echo(url, init));
    const { voyage, sleep } = provider();

    const vectors = await voyage.embed(['a', 'b'], 'document');

    expect(vectors).toEqual([vectorFor(0), vectorFor(1)]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
    // Every attempt sends the same request.
    expect(bodyOf(fetchMock, 2)).toEqual(bodyOf(fetchMock, 0));
  });

  it('honours Retry-After, capped at 30 s', async () => {
    const answers = [errorResponse(429, {}, { 'Retry-After': '5' }), errorResponse(429, {}, { 'Retry-After': '120' })];
    const echo = echoFetch();
    stubFetch(async (url, init) => answers.shift() ?? echo(url, init));
    const { voyage, sleep } = provider();

    await voyage.embed(['a'], 'document');
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5000, 30_000]);
  });

  it('gives up after 3 retries with a clear error', async () => {
    const fetchMock = stubFetch(async () => errorResponse(500, { detail: 'Internal server error' }));
    const { voyage, sleep } = provider();

    const err = await embedError(voyage.embed([SECRET_TEXT], 'document'));

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000]);
    expect(err).toBeInstanceOf(AiError);
    expect(err).toMatchObject({ status: 500, retryable: true, attempts: 4, feature: 'embeddings', name: 'EmbeddingError' });
    expect(err.message).toBe('Voyage embeddings request failed (HTTP 500: Internal server error) (gave up after 4 attempts)');
  });

  it('respects a smaller retry budget', async () => {
    const fetchMock = stubFetch(async () => errorResponse(502, '<html>Bad gateway</html>'));
    const err = await embedError(provider({ maxRetries: 0 }).voyage.embed(['a'], 'document'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err.message).toBe('Voyage embeddings request failed (HTTP 502) (gave up after 1 attempt)');
  });

  it('retries network failures', async () => {
    let failures = 2;
    const echo = echoFetch();
    const fetchMock = stubFetch(async (url, init) => {
      if (failures-- > 0) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code: 'ECONNRESET' }) });
      return echo(url, init);
    });
    expect(await provider().voyage.embed(['a'], 'query')).toEqual([vectorFor(0)]);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    stubFetch(async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code: 'ENOTFOUND' }) });
    });
    const err = await embedError(provider().voyage.embed(['a'], 'query'));
    expect(err).toMatchObject({ status: null, retryable: true, attempts: 4 });
    expect(err.message).toMatch(/network error: TypeError ENOTFOUND/);
  });

  it('does not retry a client error and shows Voyage\'s detail', async () => {
    const fetchMock = stubFetch(async () => errorResponse(400, { detail: 'Value error, output_dimension 1024 is not supported by model x.' }));
    const { voyage, sleep } = provider();

    const err = await embedError(voyage.embed([SECRET_TEXT], 'document'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(err).toMatchObject({ status: 400, retryable: false, attempts: 1 });
    expect(err.message).toBe('Voyage embeddings request failed (HTTP 400: Value error, output_dimension 1024 is not supported by model x.)');
  });

  it('reports a rejected key without echoing it', async () => {
    stubFetch(async () => errorResponse(401, { detail: `Provided API key ${API_KEY} is invalid` }));
    const err = await embedError(provider().voyage.embed(['a'], 'document'));
    expect(err.status).toBe(401);
    expect(err.message).toBe('Voyage rejected the API key (HTTP 401); check VOYAGE_API_KEY');
    expect(err.message).not.toContain(API_KEY);
  });
});

describe('VoyageEmbeddingProvider: timeout', () => {
  /** A fetch that never answers and fails only when its signal is aborted. */
  const hangingFetch = () => stubFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
  }));

  it('aborts a request that takes longer than the timeout, retries, then reports it', async () => {
    const fetchMock = hangingFetch();
    const { voyage, sleep } = provider({ timeoutMs: 20, maxRetries: 1 });

    const err = await embedError(voyage.embed(['a'], 'document'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal!.aborted).toBe(true);
    expect(err).toMatchObject({ status: null, retryable: true, attempts: 2 });
    expect(err.message).toBe('Voyage embeddings request timed out after 20 ms (gave up after 2 attempts)');
  });

  it('recovers when a retry answers in time', async () => {
    let first = true;
    const echo = echoFetch();
    stubFetch((url, init) => {
      if (!first) return echo(url, init);
      first = false;
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
      });
    });
    expect(await provider({ timeoutMs: 20 }).voyage.embed(['a'], 'document')).toEqual([vectorFor(0)]);
  });

  it('times out a response body that never finishes', async () => {
    stubFetch(async (_url, init) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
      }),
    }) as unknown as Response);
    const err = await embedError(provider({ timeoutMs: 20, maxRetries: 0 }).voyage.embed(['a'], 'document'));
    expect(err.message).toMatch(/timed out after 20 ms/);
  });
});

describe('VoyageEmbeddingProvider: response validation', () => {
  it('rejects a different number of vectors without retrying', async () => {
    const fetchMock = stubFetch(async () => okResponse([vectorFor(0)]));
    const err = await embedError(provider().voyage.embed(['a', 'b'], 'document'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err).toMatchObject({ retryable: false, attempts: 1 });
    expect(err.message).toBe('Voyage returned unusable embeddings: 1 embedding for 2 texts');
  });

  it('rejects vectors that do not have 1024 dimensions', async () => {
    stubFetch(async () => okResponse([vectorFor(0, 1023)]));
    const err = await embedError(provider().voyage.embed(['a'], 'document'));
    expect(err.message).toBe('Voyage returned unusable embeddings: vector 0 has 1023 dimensions (expected 1024)');
  });

  it('rejects values that are not finite numbers', async () => {
    for (const bad of [null, '0.5', Number.NaN, Number.POSITIVE_INFINITY]) {
      const vector: unknown[] = vectorFor(0);
      vector[7] = bad;
      stubFetch(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ data: [{ embedding: vector, index: 0 }] }) }) as unknown as Response);
      const err = await embedError(provider().voyage.embed(['a'], 'document'));
      expect(err.message, String(bad)).toBe('Voyage returned unusable embeddings: vector 0 contains a value that is not a finite number');
    }
  });

  it('rejects a body that is not JSON or has no data list', async () => {
    stubFetch(async () => new Response('<html>oops</html>', { status: 200 }));
    expect((await embedError(provider().voyage.embed(['a'], 'document'))).message).toBe('Voyage returned a response that is not JSON');

    stubFetch(async () => new Response(JSON.stringify({ embeddings: [] }), { status: 200 }));
    expect((await embedError(provider().voyage.embed(['a'], 'document'))).message).toMatch(/has no data list/);
  });

  it('parseEmbeddingResponse checks indexes', () => {
    const v = vectorFor(0);
    expect(parseEmbeddingResponse({ data: [{ embedding: v, index: 1 }, { embedding: vectorFor(5), index: 0 }] }, 2).map(x => x[0])).toEqual([5, 0]);
    expect(parseEmbeddingResponse({ data: [{ embedding: v }] }, 1)).toEqual([v]); // no index: position
    expect(() => parseEmbeddingResponse({ data: [{ embedding: v, index: 0 }, { embedding: v, index: 0 }] }, 2)).toThrow(/repeated index/);
    expect(() => parseEmbeddingResponse({ data: [{ embedding: v, index: 3 }] }, 1)).toThrow(/invalid or repeated index/);
    expect(() => parseEmbeddingResponse({ data: [{ index: 0 }] }, 1)).toThrow(/no vector for text 0/);
    expect(() => parseEmbeddingResponse(null, 1)).toThrow(/no data list/);
    expect(() => parseEmbeddingResponse({ data: [{ embedding: [1, 2], index: 0 }] }, 1, 2)).not.toThrow();
  });
});

describe('VoyageEmbeddingProvider: privacy', () => {
  it('never logs the texts and keeps them out of every error message', async () => {
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level => vi.spyOn(console, level).mockImplementation(() => {}));
    const failures = [
      async () => errorResponse(400, { detail: 'Invalid request' }),
      async () => errorResponse(503),
      async () => okResponse([vectorFor(0, 3)]),
      async () => {
        throw new TypeError('fetch failed');
      },
    ];
    for (const failure of failures) {
      stubFetch(failure);
      const err = await embedError(provider().voyage.embed([SECRET_TEXT], 'document'));
      expect(err.message).not.toContain('SENTINEL');
      expect(JSON.stringify(err)).not.toContain('SENTINEL');
    }
    stubFetch(echoFetch());
    await provider().voyage.embed([SECRET_TEXT], 'document');
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  });
});

describe('embeddingRetryDelayMs', () => {
  it('doubles from 1 s with up to 25% jitter and never exceeds 30 s', () => {
    expect([1, 2, 3, 4].map(n => embeddingRetryDelayMs(n, null, () => 0))).toEqual([1000, 2000, 4000, 8000]);
    expect(embeddingRetryDelayMs(1, null, () => 0.999)).toBeGreaterThan(750);
    expect(embeddingRetryDelayMs(1, null, () => 0.999)).toBeLessThan(1000);
    expect(embeddingRetryDelayMs(10, null, () => 0)).toBe(EMBEDDING_RETRY_MAX_DELAY_MS);
    expect(EMBEDDING_RETRY_MAX_DELAY_MS).toBe(30_000);
  });

  it('prefers Retry-After, capped at 30 s', () => {
    expect(embeddingRetryDelayMs(1, 2500)).toBe(2500);
    expect(embeddingRetryDelayMs(1, 0)).toBe(0);
    expect(embeddingRetryDelayMs(3, 90_000)).toBe(30_000);
  });
});

describe('NoopEmbeddingProvider', () => {
  it('is disabled, returns null and sends nothing', async () => {
    const fetchMock = stubFetch(echoFetch());
    const noop = new NoopEmbeddingProvider();
    expect(noop).toMatchObject({ name: 'none', model: null, dimensions: 1024, enabled: false, disabledReason: 'VOYAGE_API_KEY is not set' });
    expect(await noop.embed(['a', 'b'], 'document')).toBeNull();
    expect(await noop.embed([], 'query')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('can carry another reason', () => {
    expect(new NoopEmbeddingProvider('embeddings are switched off').disabledReason).toBe('embeddings are switched off');
  });
});

describe('getEmbeddingProvider', () => {
  it('uses Voyage when a key is set, with the configured model or voyage-4', () => {
    const configured = getEmbeddingProvider({ voyageApiKey: API_KEY, voyageModel: 'voyage-4-lite' });
    expect(configured).toBeInstanceOf(VoyageEmbeddingProvider);
    expect(configured).toMatchObject({ name: 'voyage', model: 'voyage-4-lite', enabled: true, dimensions: 1024 });

    expect(getEmbeddingProvider({ voyageApiKey: ` ${API_KEY} `, voyageModel: '  ' }).model).toBe('voyage-4');
    expect(getEmbeddingProvider({ voyageApiKey: API_KEY }).model).toBe('voyage-4');
  });

  it('sends the trimmed key', async () => {
    const fetchMock = stubFetch(echoFetch());
    await getEmbeddingProvider({ voyageApiKey: ` ${API_KEY}\n` }).embed(['a'], 'document');
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${API_KEY}` });
  });

  it('falls back to the no-op provider without a key', () => {
    for (const voyageApiKey of [undefined, null, '', '   ']) {
      const p = getEmbeddingProvider({ voyageApiKey, voyageModel: 'voyage-4' });
      expect(p).toBeInstanceOf(NoopEmbeddingProvider);
      expect(p.enabled).toBe(false);
    }
  });

  it('reads the environment by default (no VOYAGE_API_KEY in tests)', () => {
    expect(getEmbeddingProvider()).toBeInstanceOf(NoopEmbeddingProvider);
  });

  it('is createEmbeddingProvider with the app env; the providers are the env-free module\'s', () => {
    expect(createEmbeddingProvider({ voyageApiKey: API_KEY, voyageModel: ' voyage-4-lite ' })).toMatchObject({ name: 'voyage', model: 'voyage-4-lite' });
    expect(createEmbeddingProvider({ voyageApiKey: API_KEY })).toMatchObject({ model: 'voyage-4' });
    expect(createEmbeddingProvider({})).toBeInstanceOf(NoopEmbeddingProvider);
    expect(createEmbeddingProvider).toBe(embeddingProviders.createEmbeddingProvider);
    expect(VoyageEmbeddingProvider).toBe(embeddingProviders.VoyageEmbeddingProvider);
    expect(NoopEmbeddingProvider).toBe(embeddingProviders.NoopEmbeddingProvider);
    expect(EmbeddingError).toBe(embeddingProviders.EmbeddingError);
  });
});

describe('embedding providers without the API configuration (npm run seed:library)', () => {
  afterEach(() => {
    vi.doUnmock('../src/config/env');
    vi.resetModules();
  });

  it('load, with the library seed, without src/config/env.ts', async () => {
    vi.resetModules();
    // Loading the API configuration needs JWT secrets and ANTHROPIC_API_KEY; the library seed must not.
    vi.doMock('../src/config/env', () => {
      throw new Error('src/config/env.ts was loaded');
    });

    const providers = await import('../src/services/ai/embeddingProviders');
    const seedCli = await import('../src/services/library/seedCli');
    await import('../src/services/library/seed');
    await import('../src/services/library/embed');
    expect(providers.createEmbeddingProvider({})).toBeInstanceOf(providers.NoopEmbeddingProvider);
    expect(seedCli.runLibrarySeed).toEqual(expect.any(Function));
    // The check bites: the app's module does load the configuration.
    const failure = await import('../src/services/ai/embeddings').then(() => null, (err: Error) => err);
    expect(failure).toBeInstanceOf(Error);
    expect(`${failure?.message} ${String((failure as { cause?: unknown } | null)?.cause ?? '')}`).toMatch(/mocking a module|src\/config\/env\.ts was loaded/);
  });
});

describe('toVectorLiteral', () => {
  it('formats a vector for pgvector', () => {
    expect(toVectorLiteral([0.1, 0.2, -3, 0, 1e-7])).toBe('[0.1,0.2,-3,0,1e-7]');
    expect(toVectorLiteral(vectorFor(1))).toMatch(/^\[1,0\.0009765625,.*\]$/);
  });

  it('rejects empty vectors and values that are not finite numbers', () => {
    expect(() => toVectorLiteral([])).toThrow(/at least one number/);
    expect(() => toVectorLiteral([0.1, Number.NaN])).toThrow('Vector value [1] is not a finite number');
    expect(() => toVectorLiteral([Number.NEGATIVE_INFINITY])).toThrow(RangeError);
    expect(() => toVectorLiteral([0.1, '0.2' as unknown as number])).toThrow(/\[1\]/);
    expect(() => toVectorLiteral('[1,2]' as unknown as number[])).toThrow(RangeError);
  });

  it('is the same helper the library uses, with the column size', () => {
    expect(toVectorLiteral).toBe(vectorHelpers.toVectorLiteral);
    expect(EMBEDDING_DIMENSIONS).toBe(1024);
    expect(vectorHelpers.EMBEDDING_DIMENSIONS).toBe(1024);
  });
});
