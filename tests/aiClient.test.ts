import Anthropic from '@anthropic-ai/sdk';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import * as z from 'zod/v4';
import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import {
  type AiCallLogger,
  type AiCallRecord,
  type AiSdkClient,
  configureAiClientForTests,
  describeIssues,
  generateStructured,
  type GenerateStructuredParams,
  MAX_TOKENS_CEILING,
  REFUSAL_FALLBACK_BETA,
  resetAiClientForTests,
  resolveModel,
  retryDelayMs,
} from '../src/services/ai/client';
import { AiInvalidOutputError, AiOutputTruncatedError, AiRefusalError, AiRequestError, safeErrorSummary } from '../src/services/ai/errors';
import { outputJsonSchema } from '../src/services/ai/outputSchema';
import { loadSharedSystemPrompt } from '../src/services/ai/prompts/system';
import { structuredOutputSchemaProblems } from './aiSchemaHelpers';
import { hasTestDatabase, resetDatabase } from './helpers';

// Prompt and answer markers: none of them may reach the AiCall row, logs or error messages.
const PROMPT_MARKER = 'PROMPT-MARKER-7f3a';
const ANSWER_MARKER = 'ANSWER-MARKER-91c2';

const answerSchema = z.object({
  title: z.string(),
  score: z.number().nullable(),
  level: z.enum(['outcome', 'output']),
  items: z.array(z.object({ name: z.string() })),
});
const validAnswer = { title: `Water access ${ANSWER_MARKER}`, score: null, level: 'outcome', items: [{ name: 'Litres per person per day' }] };

type FakeResponse = Record<string, unknown>;

function response(overrides: FakeResponse = {}): FakeResponse {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    stop_reason: 'end_turn',
    stop_details: null,
    content: [{ type: 'text', text: JSON.stringify(validAnswer) }],
    usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ...overrides,
  };
}

function apiError(status: number, headers: Record<string, string> = {}) {
  return Anthropic.APIError.generate(status, { type: 'error', error: { type: 'api_error', message: 'test' } }, 'test', new Headers(headers));
}

type CreateMock = Mock<(body: any, options?: { timeout?: number; maxRetries?: number }) => Promise<unknown>>;
let create: CreateMock;
let betaCreate: CreateMock;
let sleep: Mock<(ms: number) => Promise<void>>;
let logCall: Mock<AiCallLogger>;
let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
const savedEnv = { ...env };

/** Queue responses (objects) or errors (Error instances) for whichever create the client uses. */
function queue(fn: CreateMock, ...items: Array<FakeResponse | Error>) {
  for (const item of items) {
    if (item instanceof Error) fn.mockRejectedValueOnce(item);
    else fn.mockResolvedValueOnce(item);
  }
}

function params(overrides: Partial<GenerateStructuredParams<typeof answerSchema>> = {}): GenerateStructuredParams<typeof answerSchema> {
  return {
    feature: 'test.feature',
    model: 'fast',
    system: `Feature instructions ${PROMPT_MARKER}`,
    messages: [{ role: 'user', content: `Project context ${PROMPT_MARKER}` }],
    schema: answerSchema,
    maxTokens: 4000,
    promptVersion: 'test-v1',
    ...overrides,
  };
}

function loggedRecords(): AiCallRecord[] {
  return logCall.mock.calls.map(call => call[0] as AiCallRecord);
}

function onlyRecord(): AiCallRecord {
  expect(logCall).toHaveBeenCalledTimes(1);
  return loggedRecords()[0];
}

function expectNoPromptOrAnswerText(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  expect(text).not.toContain(PROMPT_MARKER);
  expect(text).not.toContain(ANSWER_MARKER);
}

beforeEach(() => {
  create = vi.fn();
  betaCreate = vi.fn();
  sleep = vi.fn(async () => undefined);
  logCall = vi.fn(async () => 'aicall-1');
  const anthropic: AiSdkClient = { messages: { create }, beta: { messages: { create: betaCreate } } };
  configureAiClientForTests({ anthropic, sleep, logCall, random: () => 0 });
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  resetAiClientForTests();
  Object.assign(env, savedEnv);
  vi.restoreAllMocks();
});

describe('resolveModel', () => {
  it('reads the model ids from the env', () => {
    expect(resolveModel('main')).toBe('claude-sonnet-5-5');
    expect(resolveModel('fast')).toBe('claude-haiku-5-5');
    env.aiModelMain = 'claude-opus-5-5';
    expect(resolveModel('main')).toBe('claude-opus-5-5');
  });
});

describe('safeErrorSummary', () => {
  it('keeps AiError messages (built without prompt or answer text) and only the class name otherwise', () => {
    expect(safeErrorSummary(new AiRefusalError('report.narrative', 'cyber'))).toBe('AiRefusalError: The AI model declined the request (report.narrative, category cyber).');
    expect(safeErrorSummary(new AiRequestError('qualitative.coding', 429, true, 4))).toBe('AiRequestError: The AI request failed (qualitative.coding, HTTP 429, after 4 attempts).');
    const dbError = new TypeError(`Unique constraint failed on value ${PROMPT_MARKER}`);
    expect(safeErrorSummary(dbError)).toBe('TypeError');
    expect(safeErrorSummary(`raw ${PROMPT_MARKER}`)).toBe('unknown error');
  });
});

describe('outputJsonSchema', () => {
  it('keeps enum and const (the SDK transform would move them into the description)', () => {
    const shared = z.enum(['a', 'b']);
    const schema = z.object({
      level: z.enum(['outcome', 'output']).describe('Result level'),
      unit: z.enum(['number', 'percentage']).nullable(),
      kind: z.literal('figure'),
      rows: z.array(z.object({ method: z.enum(['survey', 'records']), first: shared, second: shared })),
      note: z.string().min(3),
    });
    const sent = outputJsonSchema(schema) as any;

    expect(sent.type).toBe('object');
    expect(sent.additionalProperties).toBe(false);
    expect(sent).not.toHaveProperty('$schema');
    expect(sent).not.toHaveProperty('description');
    expect(sent.properties.level).toEqual({ type: 'string', description: 'Result level', enum: ['outcome', 'output'] });
    expect(sent.properties.unit).toEqual({ anyOf: [{ type: 'string', enum: ['number', 'percentage'] }, { type: 'null' }] });
    expect(sent.properties.kind).toEqual({ type: 'string', const: 'figure' });
    expect(sent.properties.rows.items.properties.method).toEqual({ type: 'string', enum: ['survey', 'records'] });
    expect(sent.properties.rows.items.additionalProperties).toBe(false);
    // Keywords structured outputs do not support still go into the description (and are checked by zod).
    expect(sent.properties.note).toEqual({ type: 'string', description: '{minLength: 3}' });
    expect(JSON.stringify(sent)).not.toContain('{enum:');
    expect(JSON.stringify(sent)).not.toContain('{const:');
    // A reused schema becomes a $ref; its definition keeps the enum too.
    expect(sent.properties.rows.items.properties.first).toEqual({ $ref: '#/$defs/__schema0' });
    expect(sent.$defs).toEqual({ __schema0: { type: 'string', enum: ['a', 'b'] } });
  });

  it('does not change the zod schema or the answers it accepts', () => {
    const schema = z.object({ level: z.enum(['outcome', 'output']) });
    outputJsonSchema(schema);
    expect(schema.safeParse({ level: 'outcome' }).success).toBe(true);
    expect(schema.safeParse({ level: 'activity' }).success).toBe(false);
    expect(outputJsonSchema(schema)).toEqual(outputJsonSchema(schema));
  });
});

describe('generateStructured: request', () => {
  it('sends the fast model with the cached shared system prompt, the JSON schema and effort (no fallback for Haiku)', async () => {
    queue(create, response({ model: 'claude-haiku-5-5' }));
    await generateStructured(params({ effort: 'low' }));

    expect(betaCreate).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    const [body, options] = create.mock.calls[0];
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.max_tokens).toBe(4000);
    expect(body.system).toEqual([
      { type: 'text', text: loadSharedSystemPrompt().text, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: `Feature instructions ${PROMPT_MARKER}` },
    ]);
    expect(body.system[0].text).toContain('## 12. Privacy rules');
    expect(body.messages).toEqual([{ role: 'user', content: `Project context ${PROMPT_MARKER}` }]);
    expect(body.output_config).toEqual({
      format: { type: 'json_schema', schema: outputJsonSchema(answerSchema) },
      effort: 'low',
    });
    expect(body.output_config.format.schema.additionalProperties).toBe(false);
    // The allowed values are enforced by the API, not just described to the model.
    expect(body.output_config.format.schema.properties.level).toEqual({ type: 'string', enum: ['outcome', 'output'] });
    expect(body).not.toHaveProperty('betas');
    expect(body).not.toHaveProperty('fallbacks');
    expect(options).toEqual({ timeout: 60000, maxRetries: 0 });
  });

  it('never sends sampling parameters or a thinking configuration', async () => {
    queue(betaCreate, response());
    await generateStructured(params({ model: 'main' }));
    const [body] = betaCreate.mock.calls[0];
    for (const key of ['temperature', 'top_p', 'top_k', 'thinking', 'stream']) expect(body).not.toHaveProperty(key);
  });

  it('uses the beta endpoint with the server-side "default" refusal fallback for the main model', async () => {
    queue(betaCreate, response());
    await generateStructured(params({ model: 'main', timeoutMs: 300000 }));

    expect(create).not.toHaveBeenCalled();
    const [body, options] = betaCreate.mock.calls[0];
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body.betas).toEqual([REFUSAL_FALLBACK_BETA]);
    expect(REFUSAL_FALLBACK_BETA).toBe('server-side-fallback-2026-07-01');
    expect(body.fallbacks).toBe('default');
    expect(body.output_config.effort).toBe('medium');
    expect(options).toEqual({ timeout: 300000, maxRetries: 0 });
  });

  it('skips the fallback when AI_REFUSAL_FALLBACK is off', async () => {
    env.aiRefusalFallback = 'off';
    queue(create, response());
    await generateStructured(params({ model: 'main' }));
    expect(betaCreate).not.toHaveBeenCalled();
    const [body] = create.mock.calls[0];
    expect(body).not.toHaveProperty('betas');
    expect(body).not.toHaveProperty('fallbacks');
  });

  it('leaves out effort (and the fallback) for models that do not support them', async () => {
    env.aiModelFast = 'claude-haiku-4-5';
    env.aiModelMain = 'claude-unknown-9';
    queue(create, response({ model: 'claude-haiku-4-5' }), response({ model: 'claude-unknown-9' }));
    await generateStructured(params({ model: 'fast', effort: 'high' }));
    await generateStructured(params({ model: 'main' }));
    expect(create.mock.calls[0][0].output_config).not.toHaveProperty('effort');
    expect(create.mock.calls[1][0].output_config).not.toHaveProperty('effort');
    expect(create.mock.calls[1][0]).not.toHaveProperty('fallbacks');
    expect(betaCreate).not.toHaveBeenCalled();
  });

  it('sends only the shared system block when the feature has no instructions', async () => {
    queue(create, response());
    await generateStructured(params({ system: undefined }));
    expect(create.mock.calls[0][0].system).toHaveLength(1);
  });

  it('uses AI_REQUEST_TIMEOUT_MS when the call gives no timeout', async () => {
    env.aiRequestTimeoutMs = 15000;
    queue(create, response());
    await generateStructured(params());
    expect(create.mock.calls[0][1]).toEqual({ timeout: 15000, maxRetries: 0 });
  });
});

describe('generateStructured: answers', () => {
  it('returns the validated answer, served model, usage, cost and AiCall id', async () => {
    queue(betaCreate, response({
      model: 'claude-opus-5',
      usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 10000, cache_creation_input_tokens: 2000 },
    }));
    const result = await generateStructured(params({ model: 'main', context: { organizationId: 'org-1', projectId: 'project-1' } }));

    expect(result.data).toEqual(validAnswer);
    expect(result.model).toBe('claude-opus-5'); // served after a server-side fallback
    expect(result.promptVersion).toBe('test-v1');
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 10000, cacheWriteTokens: 2000 });
    // claude-opus-5: (1000×5 + 500×25 + 2000×6.25 + 10000×0.5) / 1M
    expect(result.estimatedCostUsd).toBe(0.035);
    expect(result.aiCallId).toBe('aicall-1');

    const record = onlyRecord();
    expect(record).toMatchObject({
      feature: 'test.feature',
      model: 'claude-sonnet-5-5',
      servedModel: 'claude-opus-5',
      promptVersion: 'test-v1',
      systemPromptVersion: loadSharedSystemPrompt().version,
      status: 'success',
      stopReason: 'end_turn',
      errorType: null,
      attempts: 1,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 10000,
      cacheWriteTokens: 2000,
      estimatedCostUsd: 0.035,
      organizationId: 'org-1',
      projectId: 'project-1',
    });
    expect(record.latencyMs).toBeGreaterThanOrEqual(0);
    expectNoPromptOrAnswerText(record);
  });

  it('measures latency over the whole call', async () => {
    let clock = 1000;
    configureAiClientForTests({ now: () => clock });
    create.mockImplementationOnce(async () => {
      clock += 250;
      return response();
    });
    await generateStructured(params());
    expect(onlyRecord().latencyMs).toBe(250);
  });

  it('ignores thinking, redacted thinking and fallback blocks and joins the text blocks', async () => {
    const json = JSON.stringify(validAnswer);
    queue(create, response({
      content: [
        { type: 'thinking', thinking: '{"not": "the answer"}', signature: 'sig' },
        { type: 'redacted_thinking', data: 'opaque' },
        { type: 'fallback', from: { model: 'claude-sonnet-5-5' }, to: { model: 'claude-opus-5' } },
        { type: 'text', text: json.slice(0, 20) },
        { type: 'text', text: json.slice(20) },
      ],
    }));
    const result = await generateStructured(params());
    expect(result.data).toEqual(validAnswer);
  });

  it('treats null cache counts as 0 and returns a null cost for an unknown served model', async () => {
    queue(create, response({ model: 'claude-unknown-9', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null, cache_creation_input_tokens: null } }));
    const result = await generateStructured(params());
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(result.estimatedCostUsd).toBeNull();
    expect(onlyRecord().estimatedCostUsd).toBeNull();
  });

  it('rejects malformed JSON with AiInvalidOutputError and no answer text', async () => {
    queue(create, response({ content: [{ type: 'text', text: `{"title": "${ANSWER_MARKER}", ` }] }));
    const error = await generateStructured(params()).catch(e => e);
    expect(error).toBeInstanceOf(AiInvalidOutputError);
    expect(error.issues).toEqual(['root: not valid JSON']);
    expect(error.feature).toBe('test.feature');
    expectNoPromptOrAnswerText(error.message);
    const record = onlyRecord();
    expect(record).toMatchObject({ status: 'invalid_output', errorType: 'AiInvalidOutputError', stopReason: 'end_turn', attempts: 1, inputTokens: 1000 });
  });

  it('rejects an empty answer', async () => {
    queue(create, response({ content: [] }));
    const error = await generateStructured(params()).catch(e => e);
    expect(error).toBeInstanceOf(AiInvalidOutputError);
    expect(error.issues).toEqual(['root: empty answer']);
  });

  it('rejects an answer that does not match the schema, listing paths without values', async () => {
    const bad = { title: 42, score: `${ANSWER_MARKER}`, level: `level-${ANSWER_MARKER}`, items: [{ name: { secret: ANSWER_MARKER } }], extra: ANSWER_MARKER };
    queue(create, response({ content: [{ type: 'text', text: JSON.stringify(bad) }] }));
    const error = await generateStructured(params()).catch(e => e);

    expect(error).toBeInstanceOf(AiInvalidOutputError);
    expect(error.issues).toEqual(expect.arrayContaining([
      'title: expected string',
      'score: expected number',
      'level: not one of the allowed values',
      'items[0].name: expected string',
    ]));
    expectNoPromptOrAnswerText(error.issues);
    expectNoPromptOrAnswerText(error.message);
    expect(onlyRecord().status).toBe('invalid_output');
  });

  it('rejects a JSON answer that is not an object', async () => {
    queue(create, response({ content: [{ type: 'text', text: '"just a string"' }] }));
    const error = await generateStructured(params()).catch(e => e);
    expect(error.issues).toEqual(['root: expected object']);
  });
});

describe('generateStructured: max_tokens', () => {
  it('retries once with twice the limit and a doubled timeout, then succeeds', async () => {
    queue(create, response({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"title": "cut' }] }), response());
    const result = await generateStructured(params({ maxTokens: 4000, timeoutMs: 30000 }));

    expect(result.data).toEqual(validAnswer);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0].max_tokens).toBe(8000);
    expect(create.mock.calls[1][1]).toEqual({ timeout: 60000, maxRetries: 0 });
    expect(result.usage.inputTokens).toBe(2000);
    expect(result.usage.outputTokens).toBe(1000);
    expect(onlyRecord()).toMatchObject({ status: 'success', attempts: 2, inputTokens: 2000, stopReason: 'end_turn' });
  });

  it('caps the retry limit at 64000 tokens', async () => {
    queue(create, response({ stop_reason: 'max_tokens' }), response());
    await generateStructured(params({ maxTokens: 40000 }));
    expect(create.mock.calls[1][0].max_tokens).toBe(MAX_TOKENS_CEILING);
  });

  it('throws AiOutputTruncatedError when the retry is cut off too', async () => {
    queue(create, response({ stop_reason: 'max_tokens' }), response({ stop_reason: 'max_tokens' }));
    const error = await generateStructured(params({ maxTokens: 4000 })).catch(e => e);
    expect(error).toBeInstanceOf(AiOutputTruncatedError);
    expect(error.maxTokens).toBe(8000);
    expect(create).toHaveBeenCalledTimes(2);
    expect(onlyRecord()).toMatchObject({ status: 'max_tokens', stopReason: 'max_tokens', errorType: 'AiOutputTruncatedError', attempts: 2, outputTokens: 1000 });
  });

  it('does not retry when the limit is already at the ceiling', async () => {
    queue(create, response({ stop_reason: 'max_tokens' }));
    const error = await generateStructured(params({ maxTokens: MAX_TOKENS_CEILING })).catch(e => e);
    expect(error).toBeInstanceOf(AiOutputTruncatedError);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('generateStructured: refusals', () => {
  function refusal(category: string | null): FakeResponse {
    const r = response({ stop_reason: 'refusal', stop_details: category === null ? null : { type: 'refusal', category, explanation: 'declined' } });
    Object.defineProperty(r, 'content', { get: () => { throw new Error('the content of a refused response must not be read'); } });
    return r;
  }

  it('throws AiRefusalError with the category without reading the content', async () => {
    queue(betaCreate, refusal('cyber'));
    const error = await generateStructured(params({ model: 'main' })).catch(e => e);
    expect(error).toBeInstanceOf(AiRefusalError);
    expect(error.category).toBe('cyber');
    expect(betaCreate).toHaveBeenCalledTimes(1);
    expect(onlyRecord()).toMatchObject({ status: 'refusal', stopReason: 'refusal', errorType: 'AiRefusalError', attempts: 1, inputTokens: 1000 });
  });

  it('uses a null category when the API gives no stop details', async () => {
    queue(create, refusal(null));
    const error = await generateStructured(params()).catch(e => e);
    expect(error).toBeInstanceOf(AiRefusalError);
    expect(error.category).toBeNull();
  });

  it('handles a refusal on the max_tokens retry', async () => {
    queue(create, response({ stop_reason: 'max_tokens' }), refusal('bio'));
    const error = await generateStructured(params()).catch(e => e);
    expect(error).toBeInstanceOf(AiRefusalError);
    expect(onlyRecord()).toMatchObject({ status: 'refusal', attempts: 2 });
  });
});

describe('generateStructured: retries', () => {
  it.each([429, 529, 500, 503, 408, 409])('retries HTTP %i with backoff and then succeeds', async status => {
    queue(create, apiError(status), apiError(status), response());
    const result = await generateStructured(params());
    expect(result.data).toEqual(validAnswer);
    expect(create).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(c => c[0])).toEqual([1000, 2000]);
    expect(onlyRecord()).toMatchObject({ status: 'success', attempts: 3, inputTokens: 1000 });
  });

  it('retries network errors', async () => {
    queue(create, new Anthropic.APIConnectionError({ message: 'socket hang up' }), response());
    await generateStructured(params());
    expect(create).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('honours retry-after-ms and retry-after, capped at 30 seconds', async () => {
    queue(create, apiError(429, { 'retry-after-ms': '1500' }), apiError(429, { 'retry-after': '3' }), apiError(529, { 'retry-after': '120' }), response());
    await generateStructured(params());
    expect(sleep.mock.calls.map(c => c[0])).toEqual([1500, 3000, 30000]);
  });

  it('retries a timeout at most once', async () => {
    queue(create, new Anthropic.APIConnectionTimeoutError(), new Anthropic.APIConnectionTimeoutError(), response());
    const error = await generateStructured(params()).catch(e => e);
    expect(error).toBeInstanceOf(AiRequestError);
    expect(error).toMatchObject({ status: null, retryable: true, attempts: 2 });
    expect(create).toHaveBeenCalledTimes(2);
    expect(onlyRecord()).toMatchObject({ status: 'error', errorType: 'APIConnectionTimeoutError', attempts: 2, servedModel: null, stopReason: null });
  });

  it('succeeds after one timeout', async () => {
    queue(create, new Anthropic.APIConnectionTimeoutError(), response());
    await expect(generateStructured(params())).resolves.toMatchObject({ data: validAnswer });
  });

  it.each([400, 401, 403, 404, 413, 422])('does not retry HTTP %i', async status => {
    queue(create, apiError(status), response());
    const error = await generateStructured(params()).catch(e => e);
    expect(error).toBeInstanceOf(AiRequestError);
    expect(error).toMatchObject({ status, retryable: false, attempts: 1, feature: 'test.feature' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(onlyRecord()).toMatchObject({ status: 'error', attempts: 1, inputTokens: 0 });
  });

  it('follows the x-should-retry header', async () => {
    queue(create, apiError(500, { 'x-should-retry': 'false' }));
    await expect(generateStructured(params())).rejects.toMatchObject({ status: 500, retryable: false, attempts: 1 });

    queue(create, apiError(400, { 'x-should-retry': 'true' }), response());
    await expect(generateStructured(params())).resolves.toMatchObject({ data: validAnswer });
  });

  it('throws AiRequestError after AI_MAX_RETRIES retries', async () => {
    queue(create, apiError(529), apiError(529), apiError(529), apiError(529), response());
    const error = await generateStructured(params()).catch(e => e);
    expect(error).toBeInstanceOf(AiRequestError);
    expect(error).toMatchObject({ status: 529, retryable: true, attempts: 4 });
    expect(sleep.mock.calls.map(c => c[0])).toEqual([1000, 2000, 4000]);
    expect(onlyRecord()).toMatchObject({ status: 'error', errorType: 'InternalServerError', attempts: 4 });
  });

  it('does not retry at all when AI_MAX_RETRIES is 0', async () => {
    env.aiMaxRetries = 0;
    queue(create, apiError(429), response());
    await expect(generateStructured(params())).rejects.toMatchObject({ status: 429, retryable: true, attempts: 1 });
  });

  it('wraps unexpected errors as a non-retryable AiRequestError', async () => {
    queue(create, new TypeError('boom'));
    const error = await generateStructured(params()).catch(e => e);
    expect(error).toBeInstanceOf(AiRequestError);
    expect(error).toMatchObject({ status: null, retryable: false, attempts: 1 });
    expect(onlyRecord().errorType).toBe('TypeError');
  });

  it('sums usage and cost over the max_tokens retry and HTTP retries', async () => {
    queue(create,
      response({ stop_reason: 'max_tokens', model: 'claude-haiku-5-5', usage: { input_tokens: 1000, output_tokens: 4000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
      apiError(529),
      response({ model: 'claude-haiku-5-5', usage: { input_tokens: 1000, output_tokens: 3000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }));
    const result = await generateStructured(params());
    expect(result.usage).toEqual({ inputTokens: 2000, outputTokens: 7000, cacheReadTokens: 0, cacheWriteTokens: 0 });
    // claude-haiku-5-5 short prompts: (2000×0.10 + 7000×0.50) / 1M
    expect(result.estimatedCostUsd).toBe(0.0037);
    expect(onlyRecord()).toMatchObject({ attempts: 3, status: 'success' });
  });
});

describe('retryDelayMs', () => {
  it('backs off exponentially with jitter and a 30 second cap', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(n => retryDelayMs(n, undefined, () => 0))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(retryDelayMs(1, undefined, () => 1)).toBe(750);
    expect(retryDelayMs(3, undefined, () => 0.5)).toBe(3500);
  });

  it('reads retry-after as seconds or an HTTP date, ignoring invalid values', () => {
    expect(retryDelayMs(1, apiError(429, { 'retry-after': '0' }), () => 0)).toBe(0);
    expect(retryDelayMs(1, apiError(429, { 'retry-after': 'soon' }), () => 0)).toBe(1000);
    expect(retryDelayMs(1, apiError(429, { 'retry-after-ms': '-5' }), () => 0)).toBe(1000);
    const inTwoSeconds = new Date(Date.now() + 2000).toUTCString();
    const delay = retryDelayMs(1, apiError(429, { 'retry-after': inTwoSeconds }), () => 0);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(2000);
  });
});

describe('describeIssues', () => {
  it('formats paths and never includes values', () => {
    const result = answerSchema.safeParse({ title: ANSWER_MARKER, score: 1, level: 'output', items: [{}, { name: 3 }] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(describeIssues(result.error.issues)).toEqual(['items[0].name: expected string', 'items[1].name: expected string']);
    }
    const strict = z.strictObject({ a: z.string().min(2) }).safeParse({ a: 'x', [ANSWER_MARKER]: 1 });
    if (!strict.success) {
      const issues = describeIssues(strict.error.issues);
      expect(issues).toEqual(expect.arrayContaining(['a: too small (minimum 2)', 'root: 1 unexpected key(s)']));
      expectNoPromptOrAnswerText(issues);
    }
  });
});

describe('generateStructured: logging', () => {
  it('writes exactly one AiCall row per call for every outcome', async () => {
    queue(create, response());
    await generateStructured(params());
    queue(create, response({ content: [{ type: 'text', text: 'nope' }] }));
    await generateStructured(params()).catch(() => {});
    queue(create, apiError(401));
    await generateStructured(params()).catch(() => {});
    expect(loggedRecords().map(r => r.status)).toEqual(['success', 'invalid_output', 'error']);
  });

  it('logs one console line with numbers only', async () => {
    queue(create, response({ model: 'claude-haiku-5-5' }));
    await generateStructured(params());
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const line = String(infoSpy.mock.calls[0][0]);
    expect(line).toContain('test.feature');
    expect(line).toContain('in=1000');
    expect(line).toContain('out=500');
    expect(line).toMatch(/latencyMs=\d+/);
    // claude-haiku-5-5: (1000×0.10 + 500×0.50) / 1M
    expect(line).toContain('costUsd=0.00035');
    expectNoPromptOrAnswerText(line);
  });

  it('still returns the answer when writing the AiCall row fails', async () => {
    logCall.mockRejectedValueOnce(new Error(`database down ${PROMPT_MARKER}`));
    queue(create, response());
    const result = await generateStructured(params());
    expect(result.data).toEqual(validAnswer);
    expect(result.aiCallId).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expectNoPromptOrAnswerText(warnSpy.mock.calls[0]);
  });

  it('keeps the original error when writing the AiCall row fails', async () => {
    logCall.mockRejectedValueOnce(new Error('database down'));
    queue(create, apiError(400));
    await expect(generateStructured(params())).rejects.toBeInstanceOf(AiRequestError);
  });
});

describe('answer schema used in these tests', () => {
  it('is suitable for structured outputs', () => {
    expect(structuredOutputSchemaProblems(answerSchema)).toEqual([]);
  });
});

describe.skipIf(!hasTestDatabase)('generateStructured: AiCall table', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  beforeEach(() => {
    // Real logger (prisma.aiCall.create); fake SDK only.
    resetAiClientForTests();
    configureAiClientForTests({ anthropic: { messages: { create }, beta: { messages: { create: betaCreate } } }, sleep });
  });

  it('stores ids and numbers, never prompt or answer text', async () => {
    const org = await prisma.organization.create({
      data: { name: 'AI Org', type: 'local_ngo', country: 'Palestine', city: 'Ramallah', contactEmail: 'ai@example.org' },
    });
    queue(betaCreate, response({ usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 } }));
    const result = await generateStructured(params({ model: 'main', context: { organizationId: org.id } }));

    expect(result.aiCallId).toEqual(expect.any(String));
    const row = await prisma.aiCall.findUniqueOrThrow({ where: { id: result.aiCallId! } });
    expect(row).toMatchObject({
      feature: 'test.feature',
      model: 'claude-sonnet-5-5',
      servedModel: 'claude-sonnet-5-5',
      promptVersion: 'test-v1',
      systemPromptVersion: loadSharedSystemPrompt().version,
      status: 'success',
      stopReason: 'end_turn',
      errorType: null,
      attempts: 1,
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 5000,
      cacheWriteTokens: 0,
      organizationId: org.id,
      projectId: null,
    });
    // (1200×2 + 300×10 + 5000×0.2) / 1M
    expect(row.estimatedCostUsd?.toString()).toBe('0.0064');
    expectNoPromptOrAnswerText(row);
  });

  it('stores failed calls too', async () => {
    queue(create, apiError(400));
    await generateStructured(params({ feature: 'test.failure' })).catch(() => {});
    const rows = await prisma.aiCall.findMany({ where: { feature: 'test.failure' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'error', errorType: 'BadRequestError', attempts: 1, servedModel: null, inputTokens: 0 });
  });

  it('does not fail the call when the row cannot be written (unknown organisation)', async () => {
    queue(create, response());
    const result = await generateStructured(params({ context: { organizationId: '00000000-0000-0000-0000-000000000000' } }));
    expect(result.data).toEqual(validAnswer);
    expect(result.aiCallId).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });
});
