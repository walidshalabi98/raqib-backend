import { describe, expect, it } from 'vitest';
import {
  applyDisclosureControl, CountInput, DisclosedCell, discloseCount, discloseLinkedTables, discloseTable,
  DISCLOSURE_MIN_CELL, DISCLOSURE_MIN_CELL_SENSITIVE, DISCLOSURE_ROUNDING_BASE, OTHER_KEY, possibleCounts,
  protectNearTotalRows, roundToBase,
} from '../src/services/privacy/disclosure';
import { BeneficiaryAggregates, toDonorBeneficiarySummary } from '../src/services/beneficiaries/donorSummary';

const EXCLUSIVE = { minCell: 5, exclusive: true, freeTextKeys: false };
const FREE = { minCell: 5, exclusive: true, freeTextKeys: true };
const SENSITIVE = { minCell: 10, exclusive: false, freeTextKeys: true };
const cells = (counts: Record<string, number>): CountInput[] => Object.entries(counts).map(([key, count]) => ({ key, count }));
const sum = (input: readonly CountInput[]) => input.reduce((a, c) => a + c.count, 0);
const hiddenKeys = (out: DisclosedCell[]) => out.filter(c => c.suppressed).map(c => c.key);
const shownCounts = (out: DisclosedCell[]) => out.map(c => c.count);
const run = (counts: Record<string, number>, options = EXCLUSIVE) => {
  const input = cells(counts);
  return applyDisclosureControl(input, sum(input), options);
};

/** Seeded linear congruential generator: the same tables on every run. */
function seeded(seed: number) {
  return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
}

function* compositions(total: number, parts: number): Generator<number[]> {
  if (parts === 1) { yield [total]; return; }
  for (let first = 0; first <= total; first++) for (const rest of compositions(total - first, parts - 1)) yield [first, ...rest];
}

describe('roundToBase and discloseCount', () => {
  it.each([[0, 0], [1, 0], [2, 0], [3, 5], [5, 5], [7, 5], [8, 10], [12, 10], [13, 15], [122, 120], [123, 125]])('rounds %i to %i', (n, r) => {
    expect(roundToBase(n)).toBe(r);
  });

  it.each([
    [0, { key: null, count: 0, suppressed: false }],
    [1, { key: null, count: null, suppressed: true }],
    [4, { key: null, count: null, suppressed: true }],
    [5, { key: null, count: 5, suppressed: false }],
    [7, { key: null, count: 5, suppressed: false }],
    [8, { key: null, count: 10, suppressed: false }],
    [122, { key: null, count: 120, suppressed: false }],
  ])('discloses a single count of %i', (count, expected) => {
    expect(discloseCount(count, DISCLOSURE_MIN_CELL)).toEqual(expected);
  });

  it('uses the sensitive minimum when asked', () => {
    expect(discloseCount(9, DISCLOSURE_MIN_CELL_SENSITIVE)).toEqual({ key: null, count: null, suppressed: true });
    expect(discloseCount(10, DISCLOSURE_MIN_CELL_SENSITIVE)).toEqual({ key: null, count: 10, suppressed: false });
  });

  it('refuses a minimum below the platform floor and bad counts', () => {
    expect(() => discloseCount(10, 3)).toThrow(/at least 5/);
    expect(() => discloseCount(-1, 5)).toThrow(/non-negative/);
    expect(() => discloseCount(1.5, 5)).toThrow(/non-negative/);
    expect(() => roundToBase(-5)).toThrow(/non-negative/);
  });
});

describe('possibleCounts', () => {
  it('bounds what a reader can work out from one published count', () => {
    expect(possibleCounts({ key: 'a', count: 0, suppressed: false }, 5)).toEqual([0, 0]);
    expect(possibleCounts({ key: 'a', count: null, suppressed: true }, 5)).toEqual([1, 4]);
    expect(possibleCounts({ key: 'a', count: 5, suppressed: false }, 5)).toEqual([5, 7]);
    expect(possibleCounts({ key: 'a', count: 10, suppressed: false }, 5)).toEqual([8, 12]);
    expect(possibleCounts({ key: 'a', count: 10, suppressed: false }, 10)).toEqual([10, 12]);
  });
});

describe('discloseTable', () => {
  it('shows zeros, hides 1 to 4 and rounds everything else to the nearest 5', () => {
    expect(discloseTable(cells({ a: 0, b: 1, c: 4, d: 5, e: 7, f: 8, g: 23 }), 48, EXCLUSIVE)).toEqual([
      { key: 'a', count: 0, suppressed: false },
      { key: 'b', count: null, suppressed: true },
      { key: 'c', count: null, suppressed: true },
      { key: 'd', count: 5, suppressed: false },
      { key: 'e', count: 5, suppressed: false },
      { key: 'f', count: 10, suppressed: false },
      { key: 'g', count: 25, suppressed: false },
    ]);
  });

  it('merges small free-text rows so a hidden row never shows its own label, and drops zero rows', () => {
    const out = discloseTable(cells({ Hebron: 30, Testvillage: 2, 'Name Typed': 1, Jenin: 0 }), 33, FREE);
    expect(out).toEqual([{ key: 'Hebron', count: 30, suppressed: false }, { key: OTHER_KEY, count: null, suppressed: true }]);
    const big = discloseTable(cells({ Hebron: 30, a: 3, b: 4 }), 37, FREE);
    expect(big).toEqual([{ key: 'Hebron', count: 30, suppressed: false }, { key: OTHER_KEY, count: 5, suppressed: false }]);
  });

  it('keeps the "not recorded" row and folds a typed "__other__" into the merged row', () => {
    const input: CountInput[] = [{ key: 'Hebron', count: 30 }, { key: OTHER_KEY, count: 6 }, { key: null, count: 2 }];
    const out = discloseTable(input, 38, FREE);
    expect(out).toEqual([
      { key: 'Hebron', count: 30, suppressed: false },
      { key: null, count: null, suppressed: true },
      { key: OTHER_KEY, count: 5, suppressed: false },
    ]);
  });

  it('sensitive tables: hides 1 to 9, and a row that almost everyone is in', () => {
    const out = discloseTable(cells({ disabled: 38, idp: 30, refugee: 40, chronic: 9, pss: 4 }), 40, SENSITIVE);
    expect(out).toEqual([
      { key: 'disabled', count: null, suppressed: true }, // 40 − 38 = 2 people without it
      { key: 'idp', count: 30, suppressed: false }, // 10 without it
      { key: 'refugee', count: 40, suppressed: false }, // everyone: nobody stands out
      { key: OTHER_KEY, count: 15, suppressed: false }, // 9 + 4 merged
    ]);
    expect(hiddenKeys(discloseTable(cells({ a: 31 }), 40, SENSITIVE))).toEqual(['a']); // 9 without it
  });

  it('refuses bad input', () => {
    expect(() => discloseTable(cells({ a: 10 }), 10, { ...EXCLUSIVE, minCell: 4 })).toThrow(/at least 5/);
    expect(() => discloseTable(cells({ a: 10 }), 10, { ...EXCLUSIVE, minCell: 5.5 })).toThrow();
    expect(() => discloseTable(cells({ a: -1, b: 11 }), 10, EXCLUSIVE)).toThrow(/non-negative/);
    expect(() => discloseTable(cells({ a: 1.5, b: 8.5 }), 10, EXCLUSIVE)).toThrow(/non-negative/);
    expect(() => discloseTable(cells({ a: 3, b: 20 }), 30, EXCLUSIVE)).toThrow(/add up/);
  });
});

describe('applyDisclosureControl: one table with its total', () => {
  it('leaves rounded counts and hidden small counts when nothing can be worked out', () => {
    expect(run({ a: 3, b: 20, c: 30 })).toEqual([
      { key: 'a', count: null, suppressed: true },
      { key: 'b', count: 20, suppressed: false },
      { key: 'c', count: 30, suppressed: false },
    ]);
  });

  // The cases that pinned a count under the earlier complementary suppression (SDC-1, SDC-2, SDC-3).
  it('age groups 1, 1, 1, 1, 20, 1, 0: the small groups stay hidden and cannot be pinned', () => {
    const out = run({ child_0_5: 1, child_6_11: 1, adolescent_12_17: 1, youth_18_24: 1, adult_25_59: 20, elderly_60_plus: 1, none: 0 });
    expect(shownCounts(out)).toEqual([null, null, null, null, 20, null, 0]);
    // Total 25 is shown as 25 (23 to 27), adults as 20 (18 to 22): the five small groups add up to 1 to 9.
    expect(discloseCount(25, 5).count).toBe(25);
  });

  it('status 30, 4, 6, 6: no complement is chosen, so the order of cells reveals nothing', () => {
    expect(shownCounts(run({ active: 30, completed: 4, dropped_out: 6, referred: 6 }))).toEqual([30, null, 5, 5]);
  });

  it('governorate Hebron 30, Bethlehem 5, Testvillage 1: the small row is merged and hidden', () => {
    expect(run({ Hebron: 30, Bethlehem: 5, Testvillage: 1 }, FREE)).toEqual([
      { key: 'Hebron', count: 30, suppressed: false },
      { key: 'Bethlehem', count: 5, suppressed: false },
      { key: OTHER_KEY, count: null, suppressed: true },
    ]);
  });

  it('hides a table whole, zeros included, when every figure sits at the edge of its range', () => {
    // 8, 8 and 1 add up to 17, shown as 15 (13 to 17); 8 is shown as 10 (8 to 12). Without the check the
    // hidden cell could only be 17 − 8 − 8 = 1.
    expect(shownCounts(run({ a: 8, b: 8, c: 1 }))).toEqual([null, null, null]);
    expect(run({ male: 4, female: 4, other: 0 })).toEqual([
      { key: 'male', count: null, suppressed: true },
      { key: 'female', count: null, suppressed: true },
      { key: 'other', count: null, suppressed: true },
    ]);
    // A free-text table hidden whole has no rows: each label would be a lower bound.
    expect(run({ Hebron: 8, Jenin: 8, Testvillage: 1 }, FREE)).toEqual([]);
  });

  it('shows nothing when the table had nothing left to hide', () => {
    // Both cells hidden already; 8 is shown as 10 (8 to 12), and two hidden cells hold at most 8.
    expect(run({ x: 4, y: 4 })).toEqual([{ key: 'x', count: null, suppressed: true }, { key: 'y', count: null, suppressed: true }]);
    const linked = discloseLinkedTables([{ cells: cells({ x: 4, y: 4 }), freeTextKeys: false }], 8);
    expect(linked).toMatchObject({ suppressedAll: true, total: { count: null, suppressed: true }, tables: [[]] });
  });

  it('hides a whole exclusive table whose total is below the minimum, zeros included', () => {
    expect(run({ female: 3, male: 0, other: 0 })).toEqual([
      { key: 'female', count: null, suppressed: true },
      { key: 'male', count: null, suppressed: true },
      { key: 'other', count: null, suppressed: true },
    ]);
  });

  it('shows an empty table as zeros', () => {
    expect(run({ male: 0, female: 0 })).toEqual([
      { key: 'male', count: 0, suppressed: false },
      { key: 'female', count: 0, suppressed: false },
    ]);
  });

  it('accepts a higher minimum', () => {
    expect(shownCounts(run({ a: 9, b: 12, c: 30 }, { ...EXCLUSIVE, minCell: 10 }))).toEqual([null, 10, 30]);
  });

  it('non-exclusive free-text tables: no rows when a near-total row would have a single possible value', () => {
    // Total 11 is shown as 10 (8 to 12); a hidden named row holds at least 10 and fewer than the total.
    expect(applyDisclosureControl(cells({ disabled: 10 }), 11, SENSITIVE)).toEqual([{ key: 'disabled', count: null, suppressed: true }]);
    expect(protectNearTotalRows([{ key: 'disabled', count: null, suppressed: true }], [11, 11], 10)).toEqual([]);
    expect(protectNearTotalRows([{ key: OTHER_KEY, count: null, suppressed: true }], [11, 11], 10)).toEqual([{ key: OTHER_KEY, count: null, suppressed: true }]);
  });
});

/**
 * A reader who knows the method: every true summary that gives the same published output is possible. For
 * each published output, each hidden cell must have at least two possible true values.
 */
function exhaustiveAttack(shape: readonly number[], maxTotal: number) {
  type Members = number[][][];
  const groups = new Map<string, { total: number | null; members: Members }>();
  const tablesFor = function* (total: number, sizes: readonly number[]): Generator<number[][]> {
    if (sizes.length === 0) { yield []; return; }
    for (const first of compositions(total, sizes[0])) for (const rest of tablesFor(total, sizes.slice(1))) yield [first, ...rest];
  };
  // True totals up to maxTotal + 2, so every output with a published total up to maxTotal is complete.
  for (let total = 0; total <= maxTotal + 2; total++) {
    for (const tables of tablesFor(total, shape)) {
      const out = discloseLinkedTables(tables.map(t => ({ cells: t.map((count, i) => ({ key: `k${i}`, count })), freeTextKeys: false })), total);
      const key = JSON.stringify([out.suppressedAll, out.total.count, out.tables.map(t => t.map(c => c.count))]);
      const group = groups.get(key) ?? { total: out.total.count, members: [] };
      group.members.push(tables);
      groups.set(key, group);
    }
  }
  const pinned: string[] = [];
  let hiddenChecked = 0;
  for (const [key, { total, members }] of groups) {
    const [suppressedAll, , tables] = JSON.parse(key) as [boolean, number | null, (number | null)[][]];
    if (suppressedAll || (total !== null && total > maxTotal)) continue;
    tables.forEach((row, t) => row.forEach((count, i) => {
      if (count !== null) return;
      hiddenChecked++;
      if (new Set(members.map(m => m[t][i])).size < 2) pinned.push(`${key} → ${JSON.stringify(members)}`);
    }));
  }
  return { pinned, hiddenChecked };
}

describe('no hidden count can be worked out exactly (exhaustive, reader knows the method)', () => {
  it.each([
    [[2], 60], [[3], 40], [[4], 26], [[2, 2], 30], [[3, 2], 22],
  ] as const)('tables %j, totals up to %i', (shape, maxTotal) => {
    const { pinned, hiddenChecked } = exhaustiveAttack(shape, maxTotal);
    expect(hiddenChecked).toBeGreaterThan(20);
    expect(pinned).toEqual([]);
  });
});

/** Every true count a published cell allows on its own (exclusive tables). */
function valuesOf(cell: DisclosedCell): number[] {
  if (cell.suppressed) return [1, 2, 3, 4];
  if (cell.count === 0) return [0];
  return [-2, -1, 0, 1, 2].map(d => cell.count! + d).filter(v => v >= DISCLOSURE_MIN_CELL && roundToBase(v) === cell.count);
}

/** Sums a table can reach, cell by cell (independent of the module's interval arithmetic). */
function reachable(options: number[][]): Set<number> {
  let sums = new Set([0]);
  for (const values of options) {
    const next = new Set<number>();
    for (const s of sums) for (const v of values) next.add(s + v);
    sums = next;
  }
  return sums;
}

describe('property: random summaries (sex, age group, governorate, status), reader combines every table', () => {
  it('leaves at least two possible values for every hidden count, shows only 0 or rounded counts of at least 5', () => {
    const random = seeded(20261013);
    const small = () => (random() < 0.35 ? 0 : random() < 0.6 ? 1 + Math.floor(random() * 4) : Math.floor(random() * 30));
    let hiddenSeen = 0;
    for (let n = 0; n < 400; n++) {
      const total = 5 + Math.floor(random() * 70);
      const split = (parts: number) => {
        const weights = Array.from({ length: parts }, small);
        const w = weights.reduce((a, b) => a + b, 0) || 1;
        const out = weights.map(x => Math.floor((x / w) * total));
        out[Math.floor(random() * parts)] += total - out.reduce((a, b) => a + b, 0);
        return out;
      };
      const villages = split(5);
      const inputs = [
        { cells: split(3).map((count, i) => ({ key: `sex${i}`, count })), freeTextKeys: false },
        { cells: split(7).map((count, i) => ({ key: i === 6 ? null : `age${i}`, count })), freeTextKeys: false },
        { cells: villages.map((count, i) => ({ key: i === 4 ? null : `village${i}`, count })), freeTextKeys: true },
        { cells: split(4).map((count, i) => ({ key: `status${i}`, count })), freeTextKeys: false },
      ];
      const out = discloseLinkedTables(inputs, total);
      if (out.suppressedAll) {
        expect(out.tables.every(t => t.length === 0)).toBe(true);
        continue;
      }
      expect(out.total.count! % DISCLOSURE_ROUNDING_BASE).toBe(0);
      expect(Math.abs(out.total.count! - total)).toBeLessThanOrEqual(2);
      for (const table of out.tables) {
        for (const cell of table) {
          expect(cell.suppressed).toBe(cell.count === null);
          if (!cell.suppressed && cell.count! > 0) {
            expect(cell.count! % DISCLOSURE_ROUNDING_BASE).toBe(0);
            expect(cell.count!).toBeGreaterThanOrEqual(DISCLOSURE_MIN_CELL);
          }
        }
      }
      // The reader: possible totals, then for each hidden cell of a table that still shows something, the
      // values that every other table and the rest of its own table can match.
      const totals = Array.from({ length: 5 }, (_, i) => out.total.count! - 2 + i).filter(t => t >= DISCLOSURE_MIN_CELL);
      const constraining = out.tables.filter(t => t.length > 0 && t.some(c => !c.suppressed));
      const reach = constraining.map(t => reachable(t.map(valuesOf)));
      const feasibleTotals = totals.filter(t => reach.every(r => r.has(t)));
      expect(feasibleTotals).toContain(total);
      constraining.forEach(table => {
        table.forEach((cell, ci) => {
          if (!cell.suppressed) return;
          hiddenSeen++;
          const rest = reachable(table.filter((_, k) => k !== ci).map(valuesOf));
          const possible = valuesOf(cell).filter(v => feasibleTotals.some(t => rest.has(t - v)));
          expect(possible.length, JSON.stringify({ inputs, total, table })).toBeGreaterThanOrEqual(2);
        });
      });
    }
    expect(hiddenSeen).toBeGreaterThan(100);
  });
});

describe('toDonorBeneficiarySummary', () => {
  const empty = (): BeneficiaryAggregates => ({
    total: 0, serviceCount: 0, byGender: [], byAgeGroup: [], byGovernorate: [], byStatus: [], byVulnerabilityTag: [], byServiceType: [],
  });
  const BASE = { audience: 'donor', minCell: 5, minCellSensitive: 10, roundingBase: 5, otherKey: OTHER_KEY };

  it('hides everything for a project with 1 to 4 beneficiaries', () => {
    const summary = toDonorBeneficiarySummary({
      ...empty(), total: 3, serviceCount: 12,
      byGender: [{ key: 'female', count: 3 }], byStatus: [{ key: 'active', count: 3 }], byAgeGroup: [{ key: null, count: 3 }], byGovernorate: [{ key: 'Hebron', count: 3 }],
    });
    expect(summary).toEqual({
      ...BASE, suppressedAll: true,
      total: { key: null, count: null, suppressed: true },
      serviceCount: { key: null, count: null, suppressed: true },
      byGender: [], byAgeGroup: [], byGovernorate: [], byStatus: [], byVulnerabilityTag: [], byServiceType: [],
    });
  });

  it('shows an empty project as zeros, with a fixed set of keys', () => {
    const summary = toDonorBeneficiarySummary(empty());
    expect(summary.suppressedAll).toBe(false);
    expect(summary.total).toEqual({ key: null, count: 0, suppressed: false });
    expect(summary.byGender).toEqual(['male', 'female', 'other'].map(key => ({ key, count: 0, suppressed: false })));
    expect(summary.byAgeGroup.map(c => c.key)).toEqual(['child_0_5', 'child_6_11', 'adolescent_12_17', 'youth_18_24', 'adult_25_59', 'elderly_60_plus', null]);
    expect(summary.byStatus.map(c => c.key)).toEqual(['active', 'completed', 'dropped_out', 'referred']);
    expect(summary.byGovernorate).toEqual([]);
    expect(summary.byVulnerabilityTag).toEqual([]);
    expect(summary.byServiceType).toEqual([]);
  });

  it('rounds every count and total on its own, orders free-text rows from what is shown, uses the sensitive minimum', () => {
    const summary = toDonorBeneficiarySummary({
      total: 62,
      serviceCount: 4,
      byGender: [{ key: 'female', count: 36 }, { key: 'male', count: 26 }],
      byAgeGroup: [{ key: null, count: 11 }, { key: 'adult_25_59', count: 51 }],
      byGovernorate: [{ key: 'Jenin', count: 11 }, { key: null, count: 10 }, { key: ' Hebron ', count: 9 }, { key: 'Hebron', count: 12 }, { key: 'Bethlehem', count: 20 }],
      byStatus: [{ key: 'active', count: 62 }],
      byVulnerabilityTag: [{ key: 'idp', count: 4 }, { key: 'disabled', count: 14 }, { key: 'chronic', count: 3 }, { key: 'female_headed', count: 55 }],
      byServiceType: [{ key: 'training', count: 41 }, { key: 'cash', count: 39 }],
    });
    expect(summary).toMatchObject({ ...BASE, suppressedAll: false, total: { key: null, count: 60, suppressed: false } });
    expect(summary.byGender).toEqual([
      { key: 'male', count: 25, suppressed: false }, { key: 'female', count: 35, suppressed: false }, { key: 'other', count: 0, suppressed: false },
    ]);
    expect(summary.byAgeGroup.slice(-3)).toEqual([
      { key: 'adult_25_59', count: 50, suppressed: false }, { key: 'elderly_60_plus', count: 0, suppressed: false }, { key: null, count: 10, suppressed: false },
    ]);
    // Trimmed values merged (Hebron 21 → 20), largest shown first, ties by name, null last.
    expect(summary.byGovernorate).toEqual([
      { key: 'Bethlehem', count: 20, suppressed: false }, { key: 'Hebron', count: 20, suppressed: false },
      { key: 'Jenin', count: 10, suppressed: false }, { key: null, count: 10, suppressed: false },
    ]);
    // 4 and 3 are below 10: merged into one row of 7, hidden; 55 of 62 have the tag: 7 without it, hidden.
    expect(summary.byVulnerabilityTag).toEqual([
      { key: 'disabled', count: 15, suppressed: false },
      { key: 'female_headed', count: null, suppressed: true },
      { key: OTHER_KEY, count: null, suppressed: true },
    ]);
    expect(summary.byServiceType).toEqual([{ key: 'cash', count: 40, suppressed: false }, { key: 'training', count: 40, suppressed: false }]);
    expect(summary.serviceCount).toEqual({ key: null, count: null, suppressed: true });
    expect(summary.minCellSensitive).toBe(DISCLOSURE_MIN_CELL_SENSITIVE);
  });

  it('shows listed governorates only: other typed places join "other" whatever their size', () => {
    const summary = toDonorBeneficiarySummary({
      ...empty(), total: 40,
      byGender: [{ key: 'female', count: 40 }],
      byAgeGroup: [{ key: 'adult_25_59', count: 40 }],
      byGovernorate: [{ key: 'Hebron', count: 15 }, { key: 'al-khalil', count: 3 }, { key: 'Beit Ummar', count: 12 }, { key: 'Layla Testname', count: 10 }],
      byStatus: [{ key: 'active', count: 40 }],
    });
    expect(summary.byGovernorate).toEqual([{ key: 'Hebron', count: 20, suppressed: false }, { key: OTHER_KEY, count: 20, suppressed: false }]);
    expect(JSON.stringify(summary)).not.toMatch(/Beit Ummar|Testname/);
  });

  it('checks the tables together: a governorate table that would pin a count shows no rows', () => {
    // 17 people: gender 10 and 7 → 10 and 5; governorate Hebron 8, Jenin 8, one typed village → Hebron 10,
    // Jenin 10, other hidden; the total 15 (13 to 17) would pin "other" at 1.
    const summary = toDonorBeneficiarySummary({
      ...empty(), total: 17,
      byGender: [{ key: 'female', count: 10 }, { key: 'male', count: 7 }],
      byAgeGroup: [{ key: 'adult_25_59', count: 17 }],
      byGovernorate: [{ key: 'Hebron', count: 8 }, { key: 'Jenin', count: 8 }, { key: 'Wadi Testvillage', count: 1 }],
      byStatus: [{ key: 'active', count: 17 }],
    });
    expect(summary.suppressedAll).toBe(false);
    expect(summary.total.count).toBe(15);
    expect(summary.byGovernorate).toEqual([]);
    expect(summary.byGender.map(c => c.count)).toEqual([5, 10, 0]);
    expect(JSON.stringify(summary)).not.toContain('Testvillage');
  });
});
