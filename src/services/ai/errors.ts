/**
 * Typed errors thrown by the AI client (src/services/ai/client.ts).
 *
 * Messages never contain prompt text or model output (they may hold document
 * text or personal data); they name the feature and what went wrong.
 */

export class AiError extends Error {
  constructor(
    message: string,
    /** Feature that made the call, e.g. "framework.indicators". */
    public readonly feature: string,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

/** The model (or its safety classifiers) declined the request: stop_reason "refusal". */
export class AiRefusalError extends AiError {
  constructor(
    feature: string,
    /** stop_details.category from the API (e.g. "cyber"), or null when none was given. */
    public readonly category: string | null,
  ) {
    super(`The AI model declined the request (${feature}${category ? `, category ${category}` : ''}).`, feature);
    this.name = 'AiRefusalError';
  }
}

/**
 * The answer was cut off: at max_tokens even after one retry with a higher limit, or because
 * the prompt and answer filled the model's context window (no retry: more tokens cannot help).
 */
export class AiOutputTruncatedError extends AiError {
  constructor(
    feature: string,
    /** Output token limit of the last request. */
    public readonly maxTokens: number,
    /** API stop_reason that cut the answer off. */
    public readonly stopReason: 'max_tokens' | 'model_context_window_exceeded' = 'max_tokens',
  ) {
    super(
      stopReason === 'model_context_window_exceeded'
        ? `The AI answer was cut off because the model's context window is full (${feature}).`
        : `The AI answer was cut off at ${maxTokens} tokens (${feature}).`,
      feature,
    );
    this.name = 'AiOutputTruncatedError';
  }
}

/** The answer was not valid JSON or did not match the schema. `issues` lists paths and problems, never values. */
export class AiInvalidOutputError extends AiError {
  constructor(feature: string, public readonly issues: string[]) {
    super(`The AI answer did not match the expected format (${feature}): ${issues.slice(0, 5).join('; ') || 'not valid JSON'}.`, feature);
    this.name = 'AiInvalidOutputError';
  }
}

/** The API request failed: a non-retryable error (e.g. 400, 401), or retries were exhausted (429, 5xx, timeouts, network). */
export class AiRequestError extends AiError {
  constructor(
    feature: string,
    /** HTTP status, or null for network errors and timeouts. */
    public readonly status: number | null,
    /** Whether the failure was retryable (and retries ran out). */
    public readonly retryable: boolean,
    /** Number of attempts made. */
    public readonly attempts: number,
  ) {
    super(`The AI request failed (${feature}${status ? `, HTTP ${status}` : ''}${retryable ? `, after ${attempts} attempts` : ''}).`, feature);
    this.name = 'AiRequestError';
  }
}

/**
 * One line about a failed AI job that is safe to log: the AiError message (built without
 * prompt or answer text) or, for any other error, only its class name, because database and
 * library errors can echo stored values (CLAUDE.md rules 3 and 5).
 */
export function safeErrorSummary(err: unknown): string {
  if (err instanceof AiError) return `${err.name}: ${err.message}`;
  if (err instanceof Error) return err.name || 'Error';
  return 'unknown error';
}
