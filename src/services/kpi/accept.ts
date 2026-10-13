/**
 * Accept (and edit & accept) a KPI suggestion: one transaction that creates the indicator through the normal
 * indicator validation and records the decision (knowledge/kpi-assistant-spec.md §A1, §A6; design section 8.1, D5).
 * The caller has loaded the suggestion with assertKpiSuggestionAccess (CLAUDE.md rule 1).
 *
 * Step 0 stub (Phase 4 contracts): signatures are final; E5 implements the bodies.
 */
import type { Prisma } from '@prisma/client';
import type { INDICATOR_INCLUDE } from '../indicators/selects';
import type { KpiSuggestionDto, KpiWarning } from './types';

/** `{ edits?: object }`; a non-object edits value → 400. */
export function parseAcceptBody(_body: unknown): { edits: Record<string, unknown> } {
  throw new Error('Phase 4: not implemented (E5)');
}

export async function acceptKpiSuggestion(_input: { suggestionId: string; organizationId: string; userId: string; body: unknown }):
  Promise<{ indicator: Prisma.IndicatorGetPayload<{ include: typeof INDICATOR_INCLUDE }>; suggestion: KpiSuggestionDto; warnings: KpiWarning[] }> {
  throw new Error('Phase 4: not implemented (E5)');
}
