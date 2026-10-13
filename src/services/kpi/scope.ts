/**
 * Which results a KPI run suggests for, how many suggestions each may get and which library ids no run
 * may suggest (knowledge/kpi-assistant-spec.md §A4 steps 1–2, rule 17; me-foundations §2 "Number of indicators"
 * and DG ECHO cap; design section 4.2, D5, D9, D10, M5). Pure: no prisma, no env (tests/kpiPurity.test.ts).
 */
import { ALTERNATIVES_RANGE, LEVEL_SUGGESTION_RANGE } from './types';
import type { ContextResult, ProjectContext } from './types';

const upper = (id: string) => id.trim().toUpperCase();

/** The result an alternatives run replaces an indicator or suggestion of (null outside alternatives scope). */
function alternativesResultId(ctx: ProjectContext): string | null {
  return ctx.scope.type === 'alternatives' ? ctx.alternativesFor?.resultId ?? null : null;
}

/** The result a result or alternatives run is about (null for framework scope). */
function scopeResultId(ctx: ProjectContext): string | null {
  if (ctx.scope.type === 'result') return ctx.scope.resultId;
  return alternativesResultId(ctx);
}

/**
 * Results the run suggests for, in every scope only those whose allowance max > 0 (chain order): framework →
 * every impact/outcome/output; result → [that result] or []; alternatives → [the source's result] or []. []
 * means nothing to suggest: requests answer 422 nothing_to_suggest before a run exists, and runKpiPipeline
 * returns an empty result without any model call (defence in depth; design m4, M5).
 */
export function scopedResults(ctx: ProjectContext): ContextResult[] {
  const candidates = ctx.scope.type === 'framework'
    ? ctx.resultsChain
    : ctx.resultsChain.filter(r => r.id === scopeResultId(ctx));
  return candidates.filter(r => allowanceFor(r, ctx).max > 0);
}

/**
 * min/max suggestions for a result (spec §A4 step 2 counts; me-foundations §2 "Number of indicators"; D5, D10, M5):
 * - framework: [levelMin, levelMax − existing on that result]; result: [levelMin, levelMax];
 * - alternatives: ALTERNATIVES_RANGE for both bounds (they replace the source, so the level maximum does not apply);
 * - then, when donorRules.maxIndicatorsPerResult is set: max = min(max, cap − existing on that result), where for
 *   alternatives of an existing indicator on that result the source is not counted (it is being replaced);
 * - max ≥ 0; min = min(range minimum, max).
 */
export function allowanceFor(result: ContextResult, ctx: ProjectContext): { min: number; max: number } {
  const existing = ctx.existingIndicators.filter(i => i.resultId === result.id).length;
  const [rangeMin, rangeMax] = ctx.scope.type === 'alternatives' ? ALTERNATIVES_RANGE : LEVEL_SUGGESTION_RANGE[result.level];
  let max = ctx.scope.type === 'framework' ? rangeMax - existing : rangeMax;

  const cap = ctx.donorRules.maxIndicatorsPerResult;
  if (cap !== null) {
    const scope = ctx.scope;
    const replacesExisting = scope.type === 'alternatives' && scope.indicatorId !== null
      && ctx.existingIndicators.some(i => i.id === scope.indicatorId && i.resultId === result.id);
    max = Math.min(max, cap - (replacesExisting ? existing - 1 : existing));
  }

  max = Math.max(0, max);
  return { min: Math.min(rangeMin, max), max };
}

/**
 * Library ids no run may suggest (spec §A4 step 1 "exclude orgPreferences.rejectedLibraryIds"; D9, D12), upper case:
 * the organisation's rejections; libraryIds of existing indicators on the same result (every result of the framework
 * for framework scope: one library indicator measures one result); and for alternatives the source's libraryId and the
 * pending suggestions' libraryIds of that result. `resultId` defaults to the scoped result (result and alternatives).
 */
export function exclusionsFor(ctx: ProjectContext, resultId?: string): Set<string> {
  const out = new Set<string>(ctx.orgPreferences.rejectedLibraryIds.map(upper).filter(Boolean));
  const add = (id: string | null | undefined) => {
    if (id && id.trim()) out.add(upper(id));
  };

  if (ctx.scope.type === 'framework') {
    for (const indicator of ctx.existingIndicators) add(indicator.libraryId);
    return out;
  }

  const target = resultId ?? scopeResultId(ctx);
  for (const indicator of ctx.existingIndicators) {
    if (indicator.resultId === target) add(indicator.libraryId);
  }
  if (ctx.scope.type === 'alternatives') {
    add(ctx.alternativesFor?.libraryId);
    for (const pending of ctx.pendingSuggestions) {
      if (pending.resultId === target) add(pending.libraryId);
    }
  }
  return out;
}
