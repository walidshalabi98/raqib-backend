/**
 * Assertion checkers of the KPI evaluation, one per type of kpi-eval-cases.json (knowledge/kpi-assistant-spec.md §A8;
 * design section 10.2). Checks run on the validated suggestions; noTargetsWithoutBasis uses the independent match of
 * metrics.ts, not the validator, so a validator bug shows up. Details carry ids, codes and counts only (no model text).
 */
import { isPeopleLevelIndicator } from '../../ai/frameworkNormalize';
import { isAccountabilityText } from '../accountability';
import { nameHasTargetOrDirection } from '../nameRules';
import type { KpiLibraryEntry, SuggestableLevel, ValidatedSuggestion } from '../types';
import { EVAL_ASSERTION_TYPES, type EvalCase } from './cases';
import { valueInFactsIndependent } from './metrics';

/** The outcome of one assertion of a case (spec §A8 assertion types; design 10.2). */
export interface AssertionResult {
  /** Assertion type, e.g. "maxPerResult". */
  type: string;
  /** Result code for per-result assertions (mustIncludeLibraryIdForResult), else null. */
  key: string | null;
  passed: boolean;
  /** Ids, codes and counts only (no model text). */
  detail: string;
}

const ARABIC_LETTER = /[\u0600-\u06FF]/;
/** How many failing suggestions a detail names before it says "…". */
const MAX_LISTED = 5;

/** A suggestion's label in details: result code, rank and library id (or "custom"). */
const label = (s: ValidatedSuggestion) => `${s.resultCode}#${s.rank} (${s.libraryId ?? 'custom'})`;

function listed(items: readonly string[]): string {
  return items.length <= MAX_LISTED ? items.join(', ') : `${items.slice(0, MAX_LISTED).join(', ')}, … (${items.length})`;
}

/** One result for an "every suggestion" rule: passed when no suggestion fails it. */
function everySuggestion(type: string, suggestions: readonly ValidatedSuggestion[], fails: (s: ValidatedSuggestion) => boolean, what: string): AssertionResult {
  const failing = suggestions.filter(fails).map(label);
  return {
    type,
    key: null,
    passed: failing.length === 0,
    detail: failing.length === 0 ? `all ${suggestions.length} suggestion(s) pass` : `${failing.length} ${what}: ${listed(failing)}`,
  };
}

const upper = (id: string | null) => (id ?? '').trim().toUpperCase();

/**
 * Checks every assertion of a case (spec §A8 assertion types, in the order of meta.assertionTypes):
 * - mustIncludeAnyLibraryIds: some suggestion's libraryId is in the list;
 * - mustIncludeLibraryIdForResult: one result per key; some suggestion of that result code has a listed libraryId;
 * - levelsPresent: every listed level appears; maxPerResult: no result code has more suggestions;
 * - peopleIndicatorsHaveSex: isPeopleLevelIndicator(name, nameAr) ⇒ sex or sex_of_household_head (me-foundations §2.7);
 * - noTargetsWithoutBasis: a document target or baseline must be found by valueInFactsIndependent in the case facts;
 * - noTargetInName: !nameHasTargetOrDirection (rule 3 without the definitional thresholds, D13);
 * - hasAccountabilityIndicator (spec wording): some libraryId starting with "AC-", or a custom indicator (libraryId
 *   null) with accountability wording (isAccountabilityText);
 * - arabicNamesPresent: every nameAr non-empty with an Arabic letter; minQualityScoreAverage: mean qualityScore ≥ n
 *   (no suggestions → failed).
 * `library` is the whole library (unknown ids in a case's lists are reported in the detail).
 */
export function checkAssertions(c: EvalCase, suggestions: readonly ValidatedSuggestion[], library: ReadonlyMap<string, KpiLibraryEntry>): AssertionResult[] {
  const a = c.assertions;
  const out: AssertionResult[] = [];
  const unknownIds = (ids: readonly string[]) => ids.filter(id => library.size > 0 && !library.has(id));
  const unknownNote = (ids: readonly string[]) => {
    const unknown = unknownIds(ids);
    return unknown.length > 0 ? ` (not in the library: ${unknown.join(', ')})` : '';
  };

  for (const type of EVAL_ASSERTION_TYPES) {
    switch (type) {
      case 'mustIncludeAnyLibraryIds': {
        if (!a.mustIncludeAnyLibraryIds) break;
        const wanted = new Set(a.mustIncludeAnyLibraryIds);
        const found = Array.from(new Set(suggestions.map(s => upper(s.libraryId)).filter(id => wanted.has(id))));
        out.push({
          type, key: null, passed: found.length > 0,
          detail: found.length > 0 ? `found ${found.join(', ')}` : `none of ${a.mustIncludeAnyLibraryIds.join(', ')} suggested${unknownNote(a.mustIncludeAnyLibraryIds)}`,
        });
        break;
      }
      case 'mustIncludeLibraryIdForResult': {
        for (const [code, ids] of Object.entries(a.mustIncludeLibraryIdForResult ?? {})) {
          const wanted = new Set(ids);
          const ofResult = suggestions.filter(s => s.resultCode === code);
          const found = Array.from(new Set(ofResult.map(s => upper(s.libraryId)).filter(id => wanted.has(id))));
          out.push({
            type, key: code, passed: found.length > 0,
            detail: found.length > 0
              ? `found ${found.join(', ')}`
              : `none of ${ids.join(', ')} among ${ofResult.length} suggestion(s) for ${code}${ofResult.length > 0 ? ` (${listed(ofResult.map(s => s.libraryId ?? 'custom'))})` : ''}${unknownNote(ids)}`,
          });
        }
        break;
      }
      case 'levelsPresent': {
        if (!a.levelsPresent) break;
        const present = new Set<SuggestableLevel>(suggestions.map(s => s.level));
        const missing = a.levelsPresent.filter(level => !present.has(level));
        out.push({ type, key: null, passed: missing.length === 0, detail: missing.length === 0 ? `all of ${a.levelsPresent.join(', ')} present` : `missing ${missing.join(', ')}` });
        break;
      }
      case 'maxPerResult': {
        if (a.maxPerResult === undefined) break;
        const counts = new Map<string, number>();
        for (const s of suggestions) counts.set(s.resultCode, (counts.get(s.resultCode) ?? 0) + 1);
        const over = Array.from(counts.entries()).filter(([, n]) => n > (a.maxPerResult as number)).map(([code, n]) => `${code} has ${n}`);
        const most = Math.max(0, ...counts.values());
        out.push({ type, key: null, passed: over.length === 0, detail: over.length === 0 ? `at most ${most} per result (max ${a.maxPerResult})` : `${listed(over)} (max ${a.maxPerResult})` });
        break;
      }
      case 'peopleIndicatorsHaveSex':
        if (a.peopleIndicatorsHaveSex) {
          out.push(everySuggestion(type, suggestions, s => isPeopleLevelIndicator(s.name, s.nameAr)
            && !s.disaggregation.includes('sex') && !s.disaggregation.includes('sex_of_household_head'), 'people-level suggestion(s) without sex'));
        }
        break;
      case 'noTargetsWithoutBasis':
        if (a.noTargetsWithoutBasis) {
          out.push(everySuggestion(type, suggestions, s =>
            (s.targetBasis === 'document' && !valueInFactsIndependent(s.targetSuggestion, c.documentFacts))
            || (s.baselineBasis === 'document' && !valueInFactsIndependent(s.baselineSuggestion, c.documentFacts)),
          'document value(s) not found in the case facts'));
        }
        break;
      case 'noTargetInName':
        if (a.noTargetInName) {
          out.push(everySuggestion(type, suggestions, s => nameHasTargetOrDirection(s.name, s.nameAr), 'name(s) with a target or direction'));
        }
        break;
      case 'hasAccountabilityIndicator': {
        if (!a.hasAccountabilityIndicator) break;
        const byId = suggestions.filter(s => upper(s.libraryId).startsWith('AC-')).map(s => upper(s.libraryId));
        const custom = suggestions.filter(s => s.libraryId === null && isAccountabilityText(s.name, s.nameAr));
        const passed = byId.length > 0 || custom.length > 0;
        out.push({
          type, key: null, passed,
          detail: passed
            ? [byId.length > 0 ? `library ${Array.from(new Set(byId)).join(', ')}` : '', custom.length > 0 ? `${custom.length} custom` : ''].filter(Boolean).join('; ')
            : 'no AC-* library id and no custom accountability indicator',
        });
        break;
      }
      case 'arabicNamesPresent':
        if (a.arabicNamesPresent) {
          out.push(everySuggestion(type, suggestions, s => (s.nameAr ?? '').trim() === '' || !ARABIC_LETTER.test(s.nameAr), 'suggestion(s) without an Arabic name'));
        }
        break;
      case 'minQualityScoreAverage': {
        if (a.minQualityScoreAverage === undefined) break;
        const average = suggestions.length === 0 ? null : suggestions.reduce((n, s) => n + s.qualityScore, 0) / suggestions.length;
        out.push({
          type, key: null, passed: average !== null && average >= a.minQualityScoreAverage,
          detail: average === null ? 'no suggestions' : `average ${average.toFixed(1)} (min ${a.minQualityScoreAverage})`,
        });
        break;
      }
    }
  }
  return out;
}

/**
 * Every assertion of a case reported as failed with `detail` (design 10.2: "a case that threw counts all its assertions
 * as failed"): the same types and keys checkAssertions would report.
 */
export function failAllAssertions(c: EvalCase, detail: string): AssertionResult[] {
  const out: AssertionResult[] = [];
  for (const type of EVAL_ASSERTION_TYPES) {
    if (type === 'mustIncludeLibraryIdForResult') {
      for (const code of Object.keys(c.assertions.mustIncludeLibraryIdForResult ?? {})) out.push({ type, key: code, passed: false, detail });
      continue;
    }
    const value = c.assertions[type];
    if (value === undefined || value === false) continue;
    out.push({ type, key: null, passed: false, detail });
  }
  return out;
}
