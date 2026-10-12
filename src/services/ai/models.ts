/**
 * What the AI client needs to know about each Claude model: prices (for the AiCall cost
 * estimate), whether it accepts output_config.effort, and whether it has the server-side
 * "default" refusal fallback. Only client.ts uses this table; services pick a tier
 * ('main' / 'fast'), never a model id (CLAUDE.md rule 4).
 *
 * Prices are USD per million tokens (Anthropic first-party API, checked October 2026).
 * An unknown model (e.g. a new id set in AI_MODEL_MAIN) gets no effort, no fallback and
 * no cost estimate rather than a guess (client.ts leaves its tokens out of the cost and logs
 * a warning). Every model a server-side fallback can route to must be listed here.
 */

export interface ModelPrice {
  /** Uncached input tokens. */
  input: number;
  output: number;
  /** 5-minute cache write (cache_creation_input_tokens). */
  cacheWrite: number;
  /** Cache read (cache_read_input_tokens). */
  cacheRead: number;
}

export interface ModelInfo {
  price: ModelPrice;
  /** Higher price tier for prompts above `promptTokens` (input + cache read + cache write of one request). */
  longPrompt?: { promptTokens: number; price: ModelPrice };
  /** Accepts output_config.effort. */
  supportsEffort: boolean;
  /** Accepts the server-side refusal fallback `fallbacks: "default"` (beta server-side-fallback-2026-07-01). */
  serverFallback: boolean;
}

/** Token counts of one API response (or a sum of responses). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const MODELS: Readonly<Record<string, ModelInfo>> = {
  'claude-opus-5-5': {
    price: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
    supportsEffort: true,
    serverFallback: true,
  },
  'claude-opus-5': {
    price: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
    supportsEffort: true,
    serverFallback: true,
  },
  // Anthropic's "default" fallback target for cyber-category refusals on Opus 5 and Opus 5.5:
  // it can serve a call made to those models, so its tokens need a price.
  'claude-opus-4-8': {
    price: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
    supportsEffort: true,
    serverFallback: false,
  },
  'claude-sonnet-5-5': {
    price: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
    supportsEffort: true,
    serverFallback: true,
  },
  'claude-sonnet-5': {
    price: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
    supportsEffort: true,
    serverFallback: false,
  },
  'claude-haiku-5-5': {
    // Cache write 1.25x and cache read 0.1x of the input rate, in both tiers.
    price: { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
    longPrompt: { promptTokens: 100_000, price: { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 } },
    supportsEffort: true,
    serverFallback: false,
  },
  'claude-haiku-4-5': {
    price: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
    supportsEffort: false,
    serverFallback: false,
  },
};

/** Looks a model up by id; a dated snapshot id ("…-20261001") falls back to its alias. */
export function getModelInfo(model: string | null | undefined): ModelInfo | null {
  if (!model) return null;
  return MODELS[model] ?? MODELS[model.replace(/-\d{8}$/, '')] ?? null;
}

export function supportsEffort(model: string): boolean {
  return getModelInfo(model)?.supportsEffort ?? false;
}

export function supportsServerFallback(model: string): boolean {
  return getModelInfo(model)?.serverFallback ?? false;
}

/**
 * Estimated cost in USD of ONE request's usage, rounded to 6 decimals (the AiCall column
 * is Decimal(12,6)); null when the model's price is unknown. The long-prompt tier is
 * chosen from that request's prompt size, so sum per-request estimates rather than
 * estimating summed usage.
 */
export function estimateCostUsd(model: string | null | undefined, usage: TokenUsage): number | null {
  const info = getModelInfo(model);
  if (!info) return null;
  const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const price = info.longPrompt && promptTokens > info.longPrompt.promptTokens ? info.longPrompt.price : info.price;
  const usd =
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheWriteTokens * price.cacheWrite +
      usage.cacheReadTokens * price.cacheRead) /
    1_000_000;
  return roundUsd(usd);
}

/** Rounds to 6 decimals (micro-dollars). */
export function roundUsd(usd: number): number {
  return Math.round(usd * 1_000_000) / 1_000_000;
}
