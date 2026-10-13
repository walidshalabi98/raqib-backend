/**
 * KPI Assistant evaluation cases (knowledge/kpi-eval-cases.json; knowledge/kpi-assistant-spec.md §A8; design
 * section 10.2). Fictional projects; no personal data. Loaded with zod v3; unknown assertion types are rejected.
 *
 * Step 0 stub (Phase 4 contracts): types and signatures are final; E6 implements the bodies.
 */
import type { DonorType, Sector } from '@prisma/client';
import type { KpiScope, ProjectContext, SuggestableLevel } from '../types';

/** The assertion types of kpi-eval-cases.json meta.assertionTypes (each optional per case). */
export interface EvalAssertions {
  mustIncludeAnyLibraryIds?: string[];
  /** Key = result id (= code) of the case. */
  mustIncludeLibraryIdForResult?: Record<string, string[]>;
  levelsPresent?: SuggestableLevel[];
  maxPerResult?: number;
  peopleIndicatorsHaveSex?: boolean;
  noTargetsWithoutBasis?: boolean;
  noTargetInName?: boolean;
  hasAccountabilityIndicator?: boolean;
  arabicNamesPresent?: boolean;
  minQualityScoreAverage?: number;
}

/** A case's project, as in the JSON. */
export interface EvalCaseProject {
  name: string;
  sectors: Sector[];
  donor: string;
  donorType: DonorType;
  /** YYYY-MM-DD. */
  startDate: string;
  endDate: string;
  geographicScope: string | null;
  targetBeneficiaries: number | null;
  humanitarian: boolean;
  description: string | null;
}

export interface EvalCase {
  id: string;
  project: EvalCaseProject;
  /** ids are the result codes (e.g. "O1.1"). */
  resultsChain: Array<{ id: string; level: SuggestableLevel; text: string; parentId: string | null }>;
  documentFacts: Array<{ documentId: string; fileName: string; excerpt: string }>;
  assertions: EvalAssertions;
}

/** zod v3; unknown assertion types rejected. Default path: knowledge/kpi-eval-cases.json. */
export function loadEvalCases(_path?: string): { version: string; cases: EvalCase[] } {
  throw new Error('Phase 4: not implemented (E6)');
}

/**
 * ids = codes; facts kind = factKind(excerpt) (documentFacts.ts); documentTexts = one DocumentText per excerpt (the case
 * facts are whole sentences); donorRulesFor; empty prefs. Default scope: framework.
 */
export function caseToContext(_c: EvalCase, _scope?: KpiScope): ProjectContext {
  throw new Error('Phase 4: not implemented (E6)');
}
