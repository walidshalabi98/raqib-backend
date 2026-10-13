/**
 * Whether the KPI Assistant can call the model (GET /api/kpi-assistant/status; POST answers 503 ai_not_configured
 * without a real key, before any run row exists; knowledge/kpi-assistant-spec.md §A2; design sections 1.2 and 4.5).
 */
import { env } from '../../config/env';
import { apiKeyProblem } from '../ai/keyCheck';
import { getModelInfo } from '../ai/models';
import { KPI_PROMPT_VERSION } from '../ai/prompts/kpi';

/** What GET /api/kpi-assistant/status answers (the frontend shows "AI suggestions are not set up yet" when not configured). */
export interface KpiAssistantStatus {
  /** ANTHROPIC_API_KEY looks like a real key (apiKeyProblem finds nothing). */
  aiConfigured: boolean;
  /** Retrieval mode: Voyage vectors when VOYAGE_API_KEY is set, keyword matching otherwise (spec §A4 step 1). */
  embeddings: 'voyage' | 'none';
  promptVersion: string;
}

/**
 * aiConfigured = apiKeyProblem(env.anthropicApiKey) === null; embeddings = env.voyageApiKey ? 'voyage' : 'none';
 * promptVersion = KPI_PROMPT_VERSION (CLAUDE.md rule 4). Never exposes a key.
 */
export function kpiAssistantStatus(): KpiAssistantStatus {
  return {
    aiConfigured: apiKeyProblem(env.anthropicApiKey) === null,
    embeddings: env.voyageApiKey ? 'voyage' : 'none',
    promptVersion: KPI_PROMPT_VERSION,
  };
}

/**
 * The configured models (AI_MODEL_MAIN, AI_MODEL_FAST) that have no price (CC-07; D20): with a budget above 0, their
 * calls are stored with estimatedCostUsd null, and the daily budget counts them at the highest known rates
 * (organisationSpendUsd fails closed), so the budget is reached sooner than the real spend. Unique model ids, in the
 * order given; [] when the budget is off (0). src/index.ts warns at startup with this list.
 */
export function unpricedBudgetModels(budgetUsd: number, models: readonly string[]): string[] {
  if (!(budgetUsd > 0)) return [];
  return Array.from(new Set(models.filter(model => getModelInfo(model) === null)));
}

/** The startup warning for unpricedBudgetModels (model ids and the budget only), or null when every model is priced. */
export function budgetPricingWarning(budgetUsd: number, models: readonly string[]): string | null {
  const unpriced = unpricedBudgetModels(budgetUsd, models);
  if (unpriced.length === 0) return null;
  return `[KpiBudget] WARNING: AI_ORG_DAILY_BUDGET_USD is ${budgetUsd} but ${unpriced.join(', ')} has no price in src/services/ai/models.ts: `
    + 'its calls are stored without a cost and the daily budget counts them at the highest known rates. Add the model\'s prices to models.ts.';
}
