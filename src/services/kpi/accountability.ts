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

/**
 * English accountability-to-affected-people phrasing (me-foundations §9; CHS commitments 4 and 5). Phrases, not single
 * words: "feedback" or "complaints" alone also name routine process indicators ("post-distribution feedback forms
 * completed", "training feedback score"), which must not stand in for an accountability indicator.
 */
const ACCOUNTABILITY_EN: readonly RegExp[] = [
  /(?<!\p{L})accountab\p{L}*/iu,
  /(?<!\p{L})know(?:s|ing)?\s+how\s+to\s+(?:give|provide|make|submit|raise|share|file|lodge)\s+(?:\p{L}+\s+){0,3}?(?:feedback|complaints?)(?!\p{L})/iu,
  /(?<!\p{L})(?:feedback|complaints?)(?:\s+(?:and|or|&)\s+(?:feedback|complaints?))?\s+(?:response\s+)?(?:mechanisms?|channels?|systems?|box(?:es)?|hotlines?|desks?)(?!\p{L})/iu,
  /(?<!\p{L})cfms?(?!\p{L})/iu,
  /(?<!\p{L})complaints?(?:\s+(?:and|or|&)\s+feedback)?\s+(?:\p{L}+\s+){0,3}?(?:responded|answered|resolved|addressed|closed|followed\s+up|acted\s+on)(?!\p{L})/iu,
  /(?<!\p{L})(?:submitted|made|gave|lodged|filed|raised)\s+(?:a\s+)?(?:complaints?|feedback)(?!\p{L})/iu,
  /(?<!\p{L})consulted\s+(?:on|about|during|in|before)(?!\p{L})/iu,
  /(?<!\p{L})(?:treated\s+with\s+(?:dignity\s+and\s+)?respect|feel(?:s|ing)?\s+respected)(?!\p{L})/iu,
  /(?<!\p{L})(?:met|meets|meeting|addressed|address(?:es)?|matched|responded\s+to)\s+(?:\p{L}+\s+){0,2}?(?:priority|most\s+(?:important|urgent))\s+needs(?!\p{L})/iu,
];

/** Arabic text as compared: no diacritics or tatweel, alif with hamza or madda as bare alif, alif maqsura as yaa. */
function normaliseArabic(text: string): string {
  return text
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي');
}

/**
 * Arabic accountability phrasing (substrings after normaliseArabic): accountability; complaints and feedback
 * mechanisms, giving feedback or a complaint, complaints answered or handled; treated with respect; consulted; priority
 * needs met. Not the bare "ملاحظات" (also "observations", e.g. "الملاحظات الصفية") or "احترام".
 */
const ACCOUNTABILITY_AR = [
  'مساءلة', 'المساءلة',
  'آلية الشكاوى', 'آليات الشكاوى', 'آلية تقديم الشكاوى', 'آلية التغذية الراجعة', 'آليات التغذية الراجعة',
  'تقديم شكوى', 'تقديم الشكاوى', 'تقديم ملاحظة', 'تقديم الملاحظات', 'تقديم التغذية الراجعة',
  'قدموا شكاوى', 'قدموا شكوى', 'قدموا ملاحظات',
  'الشكاوى والملاحظات', 'الشكاوى التي تم', 'الرد على الشكاوى', 'معالجة الشكاوى',
  'عوملوا باحترام', 'معاملتهم باحترام', 'بكرامة واحترام',
  'تمت استشارتهم', 'التشاور مع',
  'احتياجاتهم ذات الأولوية', 'الاحتياجات ذات الأولوية',
].map(normaliseArabic);

/**
 * Accountability wording in a custom indicator's name (rule 19, D11): the phrases of ACCOUNTABILITY_EN (accountability;
 * knowing how to give feedback or complain; feedback or complaints mechanisms; complaints answered or resolved;
 * consulted on; treated with respect; priority needs met) or ACCOUNTABILITY_AR.
 */
export function isAccountabilityText(name: string, nameAr?: string | null): boolean {
  const english = name.replace(/\s+/g, ' ');
  if (ACCOUNTABILITY_EN.some(pattern => pattern.test(english))) return true;
  const arabic = normaliseArabic(`${name} ${nameAr ?? ''}`).replace(/\s+/g, ' ');
  return ACCOUNTABILITY_AR.some(phrase => arabic.includes(phrase));
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
