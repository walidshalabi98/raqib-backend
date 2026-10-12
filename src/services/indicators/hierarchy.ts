import { IndicatorLevel } from '@prisma/client';

/**
 * Results-chain hierarchy (knowledge/me-foundations.md §1):
 * impact > outcome > output > activity. A result's parent is optional; when
 * present it must be exactly one level above (an outcome's parent is the
 * impact, an output's parent an outcome, an activity's parent an output).
 * An impact never has a parent.
 */
export const LEVEL_RANK: Record<IndicatorLevel, number> = {
  impact: 0,
  outcome: 1,
  output: 2,
  activity: 3,
};

/** Levels from the top of the results chain to the bottom. */
export const LEVELS_TOP_DOWN: IndicatorLevel[] = (Object.keys(LEVEL_RANK) as IndicatorLevel[])
  .sort((a, b) => LEVEL_RANK[a] - LEVEL_RANK[b]);

/** The level a parent of `child` must have, or null when the level never has a parent (impact). */
export function parentLevelOf(child: IndicatorLevel): IndicatorLevel | null {
  return LEVELS_TOP_DOWN[LEVEL_RANK[child] - 1] ?? null;
}

/** True when a result at level `child` may sit under a parent at level `parent` (null = no parent). */
export function isValidParentLevel(child: IndicatorLevel, parent: IndicatorLevel | null): boolean {
  if (parent === null) return true;
  return LEVEL_RANK[parent] === LEVEL_RANK[child] - 1;
}

/** A sentence explaining why `parent` cannot hold `child`, for 400 responses. */
export function parentLevelProblem(child: IndicatorLevel, parent: IndicatorLevel): string {
  const expected = parentLevelOf(child);
  if (!expected) return `An impact result cannot have a parent result (the parent is an ${parent}).`;
  // Every level name starts with a vowel, hence "an".
  return `An ${child} result must sit under an ${expected} result, not under an ${parent} result.`;
}

/**
 * "Level fits the result" (knowledge/me-foundations.md §2 rule 5): an indicator
 * linked to a result has that result's level. `requested` is the level the
 * indicator would have (undefined: not chosen), `resultLevel` the level of the
 * result it measures (null/undefined: not linked). Returns the level to use
 * (the result's when none was chosen; undefined when there is no result and no
 * level) or the 400 message when they differ.
 */
export function levelForResult(
  requested: IndicatorLevel | undefined,
  resultLevel: IndicatorLevel | null | undefined,
): { ok: true; level: IndicatorLevel | undefined } | { ok: false; message: string } {
  if (!resultLevel) return { ok: true, level: requested };
  if (requested === undefined || requested === resultLevel) return { ok: true, level: resultLevel };
  return { ok: false, message: `level must match the result it measures (${resultLevel})` };
}

type Sortable = { level: IndicatorLevel; sortOrder: number; code: string };

/** Order: level (impact, outcome, output, activity), then sortOrder, then code (O2 before O10). */
export function compareResultNodes(a: Sortable, b: Sortable): number {
  return (
    LEVEL_RANK[a.level] - LEVEL_RANK[b.level]
    || a.sortOrder - b.sortOrder
    || a.code.localeCompare(b.code, 'en', { numeric: true, sensitivity: 'base' })
  );
}

/** Returns a new array of results in display order (see compareResultNodes). */
export function sortResultNodes<T extends Sortable>(nodes: T[]): T[] {
  return [...nodes].sort(compareResultNodes);
}
