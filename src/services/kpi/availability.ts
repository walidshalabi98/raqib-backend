/**
 * Whether the KPI Assistant can call the model (GET /api/kpi-assistant/status; POST answers 503 ai_not_configured
 * without a real key; design sections 1.2 and 4.5).
 *
 * Step 0 stub (Phase 4 contracts): the signature is final; E5 implements the body.
 */

/** aiConfigured = apiKeyProblem(env.anthropicApiKey) === null; embeddings = env.voyageApiKey ? 'voyage' : 'none'. */
export function kpiAssistantStatus(): { aiConfigured: boolean; embeddings: 'voyage' | 'none'; promptVersion: string } {
  throw new Error('Phase 4: not implemented (E5)');
}
