/**
 * Assertion checkers of the KPI evaluation, one per type of kpi-eval-cases.json (design section 10.2). Checks run on
 * the validated suggestions; noTargetsWithoutBasis uses the independent match of metrics.ts, not the validator.
 *
 * Step 0 stub (Phase 4 contracts): types and signatures are final; E6 implements the bodies.
 */
import type { KpiLibraryEntry, ValidatedSuggestion } from '../types';
import type { EvalCase } from './cases';

export interface AssertionResult {
  /** Assertion type, e.g. "maxPerResult". */
  type: string;
  /** Result code for per-result assertions (mustIncludeLibraryIdForResult), else null. */
  key: string | null;
  passed: boolean;
  /** Ids, codes and counts only (no model text). */
  detail: string;
}

export function checkAssertions(_c: EvalCase, _suggestions: readonly ValidatedSuggestion[], _library: ReadonlyMap<string, KpiLibraryEntry>): AssertionResult[] {
  throw new Error('Phase 4: not implemented (E6)');
}
