/**
 * Which results a KPI run suggests for, how many suggestions each may get and which library ids no run
 * may suggest (knowledge/kpi-assistant-spec.md §A4 steps 1–2, rule 17; design section 4.2, D5, D10).
 * Pure: no prisma, no env (tests/kpiPurity.test.ts).
 *
 * Step 0 stub (Phase 4 contracts): signatures are final; E2 implements the bodies.
 */
import type { ContextResult, ProjectContext } from './types';

/**
 * Results the run suggests for, in every scope only those whose allowance max > 0 (chain order): framework →
 * every impact/outcome/output; result → [that result] or []; alternatives → [the source's result] or []. []
 * means nothing to suggest: requests answer 422 nothing_to_suggest before a run exists, and runKpiPipeline
 * returns an empty result without any model call (defence in depth).
 */
export function scopedResults(_ctx: ProjectContext): ContextResult[] {
  throw new Error('Phase 4: not implemented (E2)');
}

/**
 * min/max suggestions for a result (D10):
 * - framework: [levelMin, levelMax − existing on that result]; result: [levelMin, levelMax];
 * - alternatives: ALTERNATIVES_RANGE for both bounds (they replace the source, so the level maximum does not apply);
 * - then, when donorRules.maxIndicatorsPerResult is set: max = min(max, cap − existing on that result), where for
 *   alternatives of an existing indicator on that result the source is not counted (it is being replaced);
 * - max ≥ 0; min = min(range minimum, max).
 */
export function allowanceFor(_result: ContextResult, _ctx: ProjectContext): { min: number; max: number } {
  throw new Error('Phase 4: not implemented (E2)');
}

/**
 * Library ids no run may suggest: org rejections, libraryIds of existing indicators on the same result (all
 * results for framework scope), and for alternatives the source's libraryId and pending libraryIds of that result.
 */
export function exclusionsFor(_ctx: ProjectContext, _resultId?: string): Set<string> {
  throw new Error('Phase 4: not implemented (E2)');
}
