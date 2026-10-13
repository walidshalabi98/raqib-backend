/**
 * Reject a KPI suggestion with a reason (and an optional, redacted note) so later runs learn from it
 * (knowledge/kpi-assistant-spec.md §A1, §A5; design sections 8.2–8.3, D8, D9). The note is never sent to a model.
 *
 * Step 0 stub (Phase 4 contracts): signatures are final; E5 implements the bodies.
 */
import type { SuggestionRejectReason } from '@prisma/client';
import type { KpiSuggestionDto } from './types';

/** note ≤ 1000, redacted. */
export function parseRejectBody(_body: unknown): { reason: SuggestionRejectReason; note: string | null } {
  throw new Error('Phase 4: not implemented (E5)');
}

export async function rejectKpiSuggestion(_input: { suggestionId: string; organizationId: string; userId: string; body: unknown }): Promise<{ suggestion: KpiSuggestionDto }> {
  throw new Error('Phase 4: not implemented (E5)');
}
