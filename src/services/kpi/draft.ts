/**
 * The indicator an accepted suggestion becomes (knowledge/kpi-assistant-spec.md §A1 "accept in one click", §A5;
 * me-foundations §3 reference sheet; design sections 4.2 and 8.1). Accept and framework generation use the same
 * mapping. Pure: no prisma, no env.
 *
 * Step 0 stub (Phase 4 contracts): DRAFT_EDITABLE_KEYS and the signatures are final; E2 implements the bodies.
 */
import type { IndicatorCreatePayload } from '../ai/frameworkNormalize';
import type { IndicatorCreateInput } from '../indicators/validation';
import type { IndicatorDraft } from './types';

/**
 * IndicatorCreatePayload → IndicatorDraft (dates to YYYY-MM-DD; drops frameworkId, sortOrder, provenance, aiModel,
 * promptVersion, phases, milestones). startDate/endDate = the project dates (m15; editable on accept).
 */
export function indicatorDraftFromPayload(_payload: IndicatorCreatePayload, _resultId: string,
  _dates: { startDate: string | null; endDate: string | null }): IndicatorDraft {
  throw new Error('Phase 4: not implemented (E2)');
}

const EDITABLE_KEYS = [
  'indicatorText', 'indicatorTextAr', 'level', 'resultId', 'libraryId', 'standardReferenceCode', 'definition', 'unit',
  'calculation', 'direction', 'disaggregation', 'dataCollectionMethod', 'frequency', 'meansOfVerification',
  'baselineValue', 'baselineDate', 'baselineMethod', 'targetValue', 'targetJustification', 'intermediateTargets',
  'assumptions', 'responsibility', 'startDate', 'endDate', 'aiRationale',
] as const satisfies readonly (keyof IndicatorDraft)[];

/** Compile-time check: every IndicatorDraft key is editable (a new draft key must be added above). */
type MissingEditableKey = Exclude<keyof IndicatorDraft, (typeof EDITABLE_KEYS)[number]>;
const _everyDraftKeyIsEditable: [MissingEditableKey] extends [never] ? true : never = true;

/** Keys a client may change on accept: every IndicatorDraft key (provenance, status, currentValue, sortOrder never). */
export const DRAFT_EDITABLE_KEYS: readonly (keyof IndicatorDraft)[] = EDITABLE_KEYS;

/**
 * Merges edits (only DRAFT_EDITABLE_KEYS; others stripped) over the draft and parses once with parseIndicatorCreate
 * (throws AppError 400 naming every failing field).
 */
export function draftToCreateInput(_draft: IndicatorDraft, _edits?: Record<string, unknown>): IndicatorCreateInput {
  throw new Error('Phase 4: not implemented (E2)');
}

/** Edited keys whose parsed value differs from the draft's parsed value (decides edited_accepted). */
export function editedFields(_draft: IndicatorDraft, _edits: Record<string, unknown>): string[] {
  throw new Error('Phase 4: not implemented (E2)');
}
