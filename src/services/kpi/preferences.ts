/**
 * orgPreferences: what the organisation's past decisions on suggestions exclude or prefer (knowledge/kpi-assistant-spec.md
 * §A3 orgPreferences; BUILD_GUIDE Phase 4 criterion 4; design section 8.3, D9). The pure functions take decided rows;
 * loadOrgPreferences reads them, scoped to the organisation (CLAUDE.md rule 1).
 *
 * Step 0 stub (Phase 4 contracts): REJECTION_SCOPE, types and signatures are final; E3 implements the bodies.
 */
import type { CollectionMethod, DonorType, PrismaClient, SuggestionRejectReason, SuggestionStatus } from '@prisma/client';
import type { OrgPreferences } from './types';

/** Where a rejection excludes the library id (D9; owner sign-off). Every scope includes the project where it was rejected. */
export const REJECTION_SCOPE: Readonly<Record<SuggestionRejectReason, 'organisation' | 'donor' | 'project'>> = {
  not_relevant: 'organisation', too_costly_to_measure: 'organisation', other: 'organisation',
  donor_not_required: 'donor', duplicate: 'project', wording: 'project',
};

export interface PreferenceRow { libraryId: string | null; status: SuggestionStatus; rejectReason: SuggestionRejectReason | null;
  decidedAt: Date; projectId: string; donorType: DonorType; method: CollectionMethod }

/** Library ids whose latest decision that applies to the target project is a rejection (section 8.3). */
export function rejectedLibraryIdsFor(_rows: readonly PreferenceRow[], _target: { projectId: string; donorType: DonorType }): string[] {
  throw new Error('Phase 4: not implemented (E3)');
}

/** Methods with ≥ 3 accepts and an accept rate ≥ 0.6, by accepts desc, at most 3 (a soft hint for the model). */
export function preferredMethodsFrom(_rows: readonly PreferenceRow[]): CollectionMethod[] {
  throw new Error('Phase 4: not implemented (E3)');
}

/** The organisation's decided suggestions of the last 24 months → OrgPreferences for one project. */
export async function loadOrgPreferences(_db: Pick<PrismaClient, 'kpiSuggestion'>, _input: { organizationId: string; projectId: string; donorType: DonorType; now: Date }): Promise<OrgPreferences> {
  throw new Error('Phase 4: not implemented (E3)');
}
