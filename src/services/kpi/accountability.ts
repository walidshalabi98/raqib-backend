/**
 * Accountability to affected populations (AAP/CHS) indicators for humanitarian projects (rule 19,
 * knowledge/kpi-assistant-spec.md §A4 steps 1 and 3; me-foundations §9 accountability to affected people; design section 4.2,
 * D11). Pure: no prisma, no env (tests/kpiPurity.test.ts).
 */

/**
 * The library's accountability (AAP/CHS) entries, by id. FS-06 and HE-04 also carry the tag 'accountability' but
 * are sector indicators; AC-06 counts people reached.
 */
export const ACCOUNTABILITY_IDS = ['AC-01', 'AC-02', 'AC-03', 'AC-04', 'AC-05'] as const;

/** Order in which rule 19 appends an accountability indicator (outcome-level AC entries). */
export const ACCOUNTABILITY_APPEND_ORDER = ['AC-01', 'AC-03', 'AC-04', 'AC-05'] as const;

const ACCOUNTABILITY_ID_SET: ReadonlySet<string> = new Set(ACCOUNTABILITY_IDS);

/** Spec §A4 step 1.4 and rule 19 (D11): id ∈ ACCOUNTABILITY_IDS (trimmed, upper-cased), never by tag. */
export function isAccountabilityEntry(entry: { id: string }): boolean {
  return ACCOUNTABILITY_ID_SET.has(entry.id.trim().toUpperCase());
}

/** English accountability wording (word starts; "accountab" covers accountability and accountable). */
const ACCOUNTABILITY_EN = /(?<!\p{L})(?:feedback|complaints?|accountab\p{L}*|consulted|treated with respect|priority needs)(?!\p{L})/iu;

/** Arabic text as compared: no diacritics or tatweel, alif with hamza or madda as bare alif, alif maqsura as yaa. */
function normaliseArabic(text: string): string {
  return text
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي');
}

/** Arabic accountability words (substrings after normaliseArabic): complaints, feedback, accountability, respect, consultation. */
const ACCOUNTABILITY_AR = ['شكاو', 'شكوي', 'ملاحظات', 'تغذية راجعة', 'مساءلة', 'احترام', 'التشاور'].map(normaliseArabic);

/**
 * Accountability wording in a custom indicator's name (rule 19, D11): EN feedback, complaint(s), accountab…, consulted,
 * treated with respect, priority needs; AR شكاوى/شكوى، ملاحظات، تغذية راجعة، مساءلة، احترام، التشاور.
 */
export function isAccountabilityText(name: string, nameAr?: string | null): boolean {
  if (ACCOUNTABILITY_EN.test(name.replace(/\s+/g, ' '))) return true;
  const arabic = normaliseArabic(`${name} ${nameAr ?? ''}`).replace(/\s+/g, ' ');
  return ACCOUNTABILITY_AR.some(word => arabic.includes(word));
}

/**
 * Rule 19 (D11): a library-linked indicator counts only by its id (isAccountabilityEntry: AC-01…AC-05, so FS-06, HE-04
 * and AC-06 never count, whatever their wording); a custom indicator (libraryId null or empty) counts by its wording
 * (isAccountabilityText).
 */
export function isAccountabilityIndicator(i: { libraryId: string | null; name: string; nameAr?: string | null }): boolean {
  const libraryId = i.libraryId?.trim() ?? '';
  return libraryId ? isAccountabilityEntry({ id: libraryId }) : isAccountabilityText(i.name, i.nameAr);
}
