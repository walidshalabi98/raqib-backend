import { describe, expect, it } from 'vitest';
import { HIGHEST_KNOWN_PRICE, budgetCostUsd, estimateCostUsd, getModelInfo, MODELS, roundUsd, supportsEffort, supportsServerFallback, type TokenUsage } from '../src/services/ai/models';
import { budgetPricingWarning, unpricedBudgetModels } from '../src/services/kpi/availability';

const MILLION: TokenUsage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

function usage(partial: Partial<TokenUsage>): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...partial };
}

/** Cost of one million tokens of each kind, so the result reads as $/MTok. */
function perMTok(model: string) {
  return {
    input: estimateCostUsd(model, usage({ inputTokens: 1_000_000 })),
    output: estimateCostUsd(model, usage({ outputTokens: 1_000_000 })),
    cacheWrite: estimateCostUsd(model, usage({ cacheWriteTokens: 1_000_000 })),
    cacheRead: estimateCostUsd(model, usage({ cacheReadTokens: 1_000_000 })),
  };
}

describe('model table', () => {
  it.each([
    ['claude-opus-5-5', { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 }],
    ['claude-opus-5', { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 }],
    // The "default" fallback target for cyber-category refusals on Opus 5 / Opus 5.5.
    ['claude-opus-4-8', { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 }],
    ['claude-sonnet-5-5', { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 }],
    ['claude-sonnet-5', { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 }],
    ['claude-haiku-4-5', { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }],
  ])('prices %s per million tokens', (model, expected) => {
    expect(perMTok(model)).toEqual(expected);
  });

  it('prices claude-haiku-5-5 short prompts (up to 100K tokens)', () => {
    expect(estimateCostUsd('claude-haiku-5-5', usage({ inputTokens: 100_000 }))).toBe(0.01);
    expect(estimateCostUsd('claude-haiku-5-5', usage({ inputTokens: 50_000, outputTokens: 1_000_000 }))).toBe(0.505);
    expect(estimateCostUsd('claude-haiku-5-5', usage({ cacheWriteTokens: 80_000 }))).toBe(0.01); // 0.125 $/MTok
    expect(estimateCostUsd('claude-haiku-5-5', usage({ cacheReadTokens: 100_000 }))).toBe(0.001); // 0.01 $/MTok
  });

  it('prices claude-haiku-5-5 long prompts (over 100K tokens, cache included) at the higher tier', () => {
    expect(estimateCostUsd('claude-haiku-5-5', MILLION)).toBe(0.5);
    expect(estimateCostUsd('claude-haiku-5-5', usage({ inputTokens: 100_002 }))).toBe(0.050001);
    // 20K input + 90K cache read = 110K prompt tokens: input 0.50, cache read 0.05, output 2.50 $/MTok
    expect(estimateCostUsd('claude-haiku-5-5', usage({ inputTokens: 20_000, cacheReadTokens: 90_000, outputTokens: 1_000 }))).toBe(0.017);
    expect(estimateCostUsd('claude-haiku-5-5', usage({ inputTokens: 1_000, cacheWriteTokens: 200_000 }))).toBe(0.1255);
  });

  it('combines every kind of token in one estimate', () => {
    // claude-sonnet-5-5: (1000×2 + 500×10 + 2000×2.5 + 10000×0.2) / 1M
    expect(estimateCostUsd('claude-sonnet-5-5', usage({ inputTokens: 1000, outputTokens: 500, cacheWriteTokens: 2000, cacheReadTokens: 10000 }))).toBe(0.014);
  });

  it('rounds to 6 decimals', () => {
    expect(estimateCostUsd('claude-haiku-5-5', usage({ inputTokens: 3 }))).toBe(0);
    expect(estimateCostUsd('claude-sonnet-5-5', usage({ inputTokens: 1 }))).toBe(0.000002);
    expect(roundUsd(0.1234564)).toBe(0.123456);
    expect(roundUsd(0.1234566)).toBe(0.123457);
  });

  it('knows which models take effort and the server-side refusal fallback', () => {
    expect(supportsEffort('claude-sonnet-5-5')).toBe(true);
    expect(supportsEffort('claude-haiku-5-5')).toBe(true);
    expect(supportsEffort('claude-opus-5-5')).toBe(true);
    expect(supportsEffort('claude-haiku-4-5')).toBe(false);
    expect(supportsServerFallback('claude-sonnet-5-5')).toBe(true);
    expect(supportsServerFallback('claude-opus-5-5')).toBe(true);
    expect(supportsServerFallback('claude-opus-5')).toBe(true);
    expect(supportsEffort('claude-opus-4-8')).toBe(true);
    expect(supportsServerFallback('claude-opus-4-8')).toBe(false);
    expect(supportsServerFallback('claude-sonnet-5')).toBe(false);
    expect(supportsServerFallback('claude-haiku-5-5')).toBe(false);
    expect(supportsServerFallback('claude-haiku-4-5')).toBe(false);
  });

  it('treats unknown models as unpriced, without effort or fallback', () => {
    expect(getModelInfo('claude-unknown-9')).toBeNull();
    expect(getModelInfo(null)).toBeNull();
    expect(getModelInfo('')).toBeNull();
    expect(estimateCostUsd('claude-unknown-9', MILLION)).toBeNull();
    expect(estimateCostUsd(undefined, MILLION)).toBeNull();
    expect(supportsEffort('claude-unknown-9')).toBe(false);
    expect(supportsServerFallback('claude-unknown-9')).toBe(false);
  });

  it('matches a dated snapshot id to its alias', () => {
    expect(getModelInfo('claude-sonnet-5-5-20261001')).toBe(MODELS['claude-sonnet-5-5']);
    expect(estimateCostUsd('claude-opus-5-20260101', MILLION)).toBe(5);
  });
});

describe('the daily AI budget and unpriced models (CC-07)', () => {
  it('names the configured models the budget cannot count, only when a budget is set', () => {
    expect(unpricedBudgetModels(20, ['claude-sonnet-5-5', 'claude-haiku-5-5'])).toEqual([]);
    expect(unpricedBudgetModels(20, ['claude-sonnet-9-9', 'claude-haiku-5-5', 'claude-sonnet-9-9'])).toEqual(['claude-sonnet-9-9']);
    expect(unpricedBudgetModels(0, ['claude-sonnet-9-9'])).toEqual([]);
    expect(budgetPricingWarning(20, ['claude-sonnet-5-5', 'claude-haiku-5-5'])).toBeNull();
    const warning = budgetPricingWarning(20, ['claude-sonnet-9-9', 'claude-haiku-5-5']);
    expect(warning).toMatch(/^\[KpiBudget\] WARNING: AI_ORG_DAILY_BUDGET_USD is 20 but claude-sonnet-9-9 has no price/);
    expect(warning).toContain('the daily budget counts them at the highest known rates');
  });

  it('prices an unpriced call at the highest known rate of each token kind (fail closed, never stored)', () => {
    expect(HIGHEST_KNOWN_PRICE).toEqual({ input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 });
    expect(budgetCostUsd({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(5);
    expect(budgetCostUsd({ inputTokens: 100_000, outputTokens: 200_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 40_000 })).toBe(6.25);
    // Never below a priced model's own estimate for the same usage.
    const usage = { inputTokens: 300_000, outputTokens: 50_000, cacheReadTokens: 20_000, cacheWriteTokens: 10_000 };
    for (const model of Object.keys(MODELS)) expect(budgetCostUsd(usage)).toBeGreaterThanOrEqual(estimateCostUsd(model, usage) ?? 0);
  });
});
