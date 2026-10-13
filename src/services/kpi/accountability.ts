/**
 * Accountability to affected populations (AAP/CHS) indicators for humanitarian projects (rule 19,
 * knowledge/kpi-assistant-spec.md §A4; design section 4.2, D11). Pure: no prisma, no env.
 *
 * Step 0 stub (Phase 4 contracts): constants and signatures are final; E2 implements the bodies.
 */

/**
 * The library's accountability (AAP/CHS) entries, by id. FS-06 and HE-04 also carry the tag 'accountability' but
 * are sector indicators; AC-06 counts people reached.
 */
export const ACCOUNTABILITY_IDS = ['AC-01', 'AC-02', 'AC-03', 'AC-04', 'AC-05'] as const;

/** Order in which rule 19 appends an accountability indicator (outcome-level AC entries). */
export const ACCOUNTABILITY_APPEND_ORDER = ['AC-01', 'AC-03', 'AC-04', 'AC-05'] as const;

/** id ∈ ACCOUNTABILITY_IDS (upper-cased). */
export function isAccountabilityEntry(_entry: { id: string }): boolean {
  throw new Error('Phase 4: not implemented (E2)');
}

/**
 * EN: feedback, complain(t|ts), accountab, consulted, treated with respect, priority needs;
 * AR: شكاو, ملاحظات, تغذية راجعة, مساءلة, احترام, التشاور.
 */
export function isAccountabilityText(_name: string, _nameAr?: string | null): boolean {
  throw new Error('Phase 4: not implemented (E2)');
}

/** libraryId set → isAccountabilityEntry({ id: libraryId }); libraryId null (custom) → isAccountabilityText. */
export function isAccountabilityIndicator(_i: { libraryId: string | null; name: string; nameAr?: string | null }): boolean {
  throw new Error('Phase 4: not implemented (E2)');
}
