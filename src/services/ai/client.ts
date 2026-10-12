/**
 * The only module that talks to the Anthropic API (CLAUDE.md rule 4, BUILD_GUIDE Phase 3).
 *
 * CONTRACT (other modules depend on these exports; keep the names and shapes):
 * - generateStructured(params) → StructuredResult<T>
 * - resolveModel(tier) → model id from AI_MODEL_MAIN / AI_MODEL_FAST
 * - AiMessage, ModelTier, AiEffort, AiCallContext, GenerateStructuredParams, StructuredResult
 * Errors are the typed classes in ./errors.
 *
 * STATUS: contract stub. The implementation (structured outputs, retries, timeouts,
 * max_tokens retry, refusal handling, prompt caching of the shared system prompt,
 * AiCall logging) is being written; until then generateStructured throws.
 */
import type * as z from 'zod/v4';
import { env } from '../../config/env';

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
   * zod/v4 schema of the answer. Sent as output_config.format (JSON schema via the SDK's
   * zodOutputFormat) and used again to validate the parsed answer. The root must be an object;
   * keep every property required (use "" or null for unknown values) and avoid transforms.
   */
  schema: S;
  /** Output token limit (thinking counts towards it). On stop_reason "max_tokens" the call is retried once with a higher limit. */
  maxTokens: number;
  /** Version of the feature prompt, e.g. "framework-indicators-v4"; stored on the AiCall row. */
  promptVersion: string;
  /** Reasoning effort; default "medium". */
  effort?: AiEffort;
  /** Request timeout in ms; default AI_REQUEST_TIMEOUT_MS (60 000). Long generations (whole frameworks) pass more. */
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
  /** Model that produced the answer (response.model; may differ from the requested one after a server-side fallback). */
  model: string;
  promptVersion: string;
  /** Token usage summed over every attempt of this call. */
  usage: AiUsage;
  /** Estimated cost in USD, or null when the model's price is unknown. */
  estimatedCostUsd: number | null;
  /** Id of the AiCall row, or null when logging failed (logging never fails the call). */
  aiCallId: string | null;
}

/** Model id for a tier, from the validated env (never hard-coded in services). */
export function resolveModel(tier: ModelTier): string {
  return tier === 'fast' ? env.aiModelFast : env.aiModelMain;
}

/**
 * Calls the model with structured outputs and returns the validated answer.
 * Throws AiRefusalError, AiOutputTruncatedError, AiInvalidOutputError or AiRequestError (./errors).
 */
export async function generateStructured<S extends z.ZodType>(params: GenerateStructuredParams<S>): Promise<StructuredResult<z.infer<S>>> {
  throw new Error(`generateStructured is not implemented yet (${params.feature})`);
}
