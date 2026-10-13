/**
 * Whether the KPI Assistant can call the model (GET /api/kpi-assistant/status; POST answers 503 ai_not_configured
 * without a real key, before any run row exists; knowledge/kpi-assistant-spec.md §A2; design sections 1.2 and 4.5).
 */
import { env } from '../../config/env';
import { apiKeyProblem } from '../ai/keyCheck';
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
