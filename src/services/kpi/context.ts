/**
 * buildProjectContext: everything one KPI run knows about the project (knowledge/kpi-assistant-spec.md §A3; design
 * sections 1.3 and 4.3). Every query is scoped to the organisation (CLAUDE.md rule 1) and every free text is redacted
 * (CLAUDE.md rule 5): no beneficiary data, names, phone or ID numbers reach the context.
 *
 * Step 0 stub (Phase 4 contracts): KpiContextError and the signatures are final; E3 implements the bodies.
 */
import type { DonorType, PrismaClient, Sector } from '@prisma/client';
import type { ResultNodePlan, SourceDocument, VerifiedFigure } from '../ai/frameworkNormalize';
import type { KpiScope, OrgPreferences, ProjectContext } from './types';

/** The project, framework or scope target is gone ('not_found') or no longer current ('stale'). Messages are safe (no stored text). */
export class KpiContextError extends Error {
  constructor(readonly code: 'not_found' | 'stale', message: string) {
    super(message);
    this.name = 'KpiContextError';
  }
}

/**
 * DB path: everything scoped to organizationId (defence in depth) and to frameworkId; every free text redacted.
 * withDocuments false (request preview, section 7.2): documentFacts/documentTexts [] and no parsedText is loaded.
 */
export async function buildProjectContext(_db: PrismaClient, _input: { organizationId: string; projectId: string; frameworkId: string; scope: KpiScope; now: Date },
  _options?: { withDocuments?: boolean }): Promise<ProjectContext> {
  throw new Error('Phase 4: not implemented (E3)');
}

/** Code collisions after codeKey get " (2)", " (3)" … in chain order (pure; exported for tests). */
export function uniqueResultCodes<T extends { code: string }>(_results: readonly T[]): T[] {
  throw new Error('Phase 4: not implemented (E3)');
}

/**
 * Framework generation path: ids = codes, existing indicators [], facts from verified figures, documentTexts = the
 * generator's redacted SourceDocuments.
 */
export function contextFromGeneration(_input: {
  project: { id: string; name: string; sectors: Sector[]; donor: string; donorType: DonorType; startDate: string; endDate: string;
             geographicScope: string | null; targetBeneficiaries: number | null; humanitarian: boolean; description: string | null };
  /** Activities skipped. */
  plan: readonly ResultNodePlan[];
  verifiedFigures: readonly VerifiedFigure[];
  documents: readonly SourceDocument[];
  orgPreferences: OrgPreferences;
}): ProjectContext {
  throw new Error('Phase 4: not implemented (E3)');
}
