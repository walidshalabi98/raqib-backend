/**
 * Indicator name rules (rules 3–4 of knowledge/kpi-assistant-spec.md §A4 step 3; me-foundations §2: an indicator
 * never contains its target; design section 1.5 rows 3–4, D13). The only implementation of the directional
 * patterns once the Phase 3 indicatorAlternative.ts is removed. Pure: no prisma, no env.
 *
 * Step 0 stub (Phase 4 contracts): signatures are final; E2 implements the bodies.
 */

/** Rule 3: a target value or a direction in the name (EN or AR). Definitional thresholds ("at least 4") are not flagged. */
export function nameHasTargetOrDirection(_name: string, _nameAr?: string | null): boolean {
  throw new Error('Phase 4: not implemented (E2)');
}

/** Rule 4 (EN only): " and " / " and/or " / " or " joining two measurements. */
export function isDoubleBarrelled(_name: string): boolean {
  throw new Error('Phase 4: not implemented (E2)');
}

/** Lower case, `[^\p{L}\p{N}%]+` → space, trimmed (duplicate checks, rule 18). */
export function normalisedIndicatorName(_name: string): string {
  throw new Error('Phase 4: not implemented (E2)');
}
