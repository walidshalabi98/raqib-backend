/**
 * Disclosure control for counts shown to donor viewers (docs/SECURITY_SETUP.md §8.4). Pure and deterministic,
 * unit tested (tests/disclosure.test.ts). One-way tables only. Every count is computed exactly first, then:
 *
 * 1. Free-text tables (governorate, tags, service types): rows of 1 to minCell − 1 merge into one OTHER_KEY row,
 *    so a small row never shows its label (a village or a name typed into the field); zero rows are dropped.
 * 2. A count of 1 to minCell − 1 is hidden (minCell is 5, or 10 for sensitive tables). 0 is shown as 0.
 * 3. Every other count, and every total, is rounded to the nearest 5 (HESA's rounding: computed exactly, then
 *    rounded, each figure on its own), so the parts of a table may not add up to its total.
 * 4. Sensitive tables (one person may count in several rows): a count is also hidden when
 *    0 < total − count < minCell, because then almost everyone shares the attribute and the few who do not
 *    would stand out.
 * 5. Check: a reader can bound every published figure (a rounded 10 is 8 to 12, a hidden count 1 to 4) and
 *    combine the tables whose cells add up to the total. When those bounds leave a single possible value for a
 *    hidden count (every figure at the edge of its range), that table is hidden whole (zeros included; a
 *    free-text table shows no rows). When the table had nothing left to hide, nothing is shown at all, as for
 *    a total of 1 to 4. Sensitive tables are checked the same way against the bounds on the total.
 *
 * The method is public (docs/SECURITY_SETUP.md §8.4); tests/disclosure.test.ts checks by exhaustive search
 * that a reader who knows it cannot work out any hidden count exactly.
 */

/** Counts of people by sex, age group, governorate and status; the total and the service-record count. */
export const DISCLOSURE_MIN_CELL = 5;
/** Counts by vulnerability tag and people reached per service type (special-category data). */
export const DISCLOSURE_MIN_CELL_SENSITIVE = 10;
/** Every count shown to donors is rounded to a multiple of this. */
export const DISCLOSURE_ROUNDING_BASE = 5;
/** Key of the merged "Other (combined)" row in free-text tables. */
export const OTHER_KEY = '__other__';

export interface CountInput { key: string | null; count: number }
/** `count` is null exactly when `suppressed` is true; otherwise it is 0 or a rounded count of at least minCell. */
export interface DisclosedCell { key: string | null; count: number | null; suppressed: boolean }
export interface DisclosureOptions {
  /** Smallest count shown (never below DISCLOSURE_MIN_CELL). */
  minCell: number;
  /**
   * Every person is in exactly one cell and the total is shown, so the cells must add up to `total`; the
   * table is checked against the total (step 5). Otherwise (one person may count in several rows) step 4 applies.
   */
  exclusive: boolean;
  /** Keys were typed by people (governorate, tag, service type): small rows are merged so their label is never shown. */
  freeTextKeys: boolean;
}

/** [lowest, highest] possible true count. */
export type CountRange = readonly [number, number];

const HALF_BASE = Math.floor(DISCLOSURE_ROUNDING_BASE / 2);

function assertMinCell(minCell: number): void {
  if (!Number.isInteger(minCell) || minCell < DISCLOSURE_MIN_CELL) {
    throw new RangeError(`minCell must be an integer of at least ${DISCLOSURE_MIN_CELL} (got ${minCell})`);
  }
}

function assertCount(count: number, what: string): void {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError(`${what} must be a non-negative integer (got ${count})`);
}

const shown = (key: string | null, count: number): DisclosedCell => ({ key, count, suppressed: false });
const hidden = (key: string | null): DisclosedCell => ({ key, count: null, suppressed: true });

/** The nearest multiple of 5 (0 stays 0). A whole number is never exactly halfway between two multiples of 5. */
export function roundToBase(count: number): number {
  assertCount(count, 'count');
  return Math.round(count / DISCLOSURE_ROUNDING_BASE) * DISCLOSURE_ROUNDING_BASE;
}

/** A single figure (a total, the number of service records): 0 shown, 1 to minCell − 1 hidden, otherwise rounded. */
export function discloseCount(count: number, minCell: number): DisclosedCell {
  assertMinCell(minCell);
  assertCount(count, 'count');
  if (count === 0) return shown(null, 0);
  return count < minCell ? hidden(null) : shown(null, roundToBase(count));
}

/**
 * Free-text tables: every row with 0 < count < minCell, and any row whose key is already OTHER_KEY,
 * becomes one OTHER_KEY row appended last; rows with count 0 are dropped. The null ("not recorded")
 * row is kept as it is: its label reveals nothing.
 */
function mergeSmallFreeTextCells(cells: readonly CountInput[], minCell: number): CountInput[] {
  const kept: CountInput[] = [];
  let other = 0;
  for (const cell of cells) {
    if (cell.key === null) kept.push(cell);
    else if (cell.key === OTHER_KEY || (cell.count > 0 && cell.count < minCell)) other += cell.count;
    else if (cell.count > 0) kept.push(cell);
  }
  if (other > 0) kept.push({ key: OTHER_KEY, count: other });
  return kept;
}

/**
 * Steps 1 to 4 for one table. `total` is the exact number of people the table describes; it is used only
 * for step 4 (non-exclusive tables). Does not check exclusive tables against the total: see
 * protectLinkedTables and applyDisclosureControl.
 */
export function discloseTable(cells: readonly CountInput[], total: number, options: DisclosureOptions): DisclosedCell[] {
  const { minCell, exclusive, freeTextKeys } = options;
  assertMinCell(minCell);
  assertCount(total, 'total');
  for (const cell of cells) assertCount(cell.count, 'count');
  if (exclusive) {
    const sum = cells.reduce((acc, cell) => acc + cell.count, 0);
    if (sum !== total) throw new RangeError(`the cells of an exclusive table must add up to the total (${sum} ≠ ${total})`);
  }
  const table = freeTextKeys ? mergeSmallFreeTextCells(cells, minCell) : [...cells];
  return table.map(({ key, count }) => {
    if (count === 0) return shown(key, 0);
    if (count < minCell) return hidden(key);
    if (!exclusive && total - count > 0 && total - count < minCell) return hidden(key);
    return shown(key, roundToBase(count));
  });
}

/**
 * What a reader can work out about one published count of an exclusive table on its own: 0 is exactly 0, a
 * hidden count is 1 to minCell − 1, and a rounded count r is r − 2 to r + 2 but at least minCell.
 */
export function possibleCounts(cell: DisclosedCell, minCell: number): CountRange {
  if (cell.suppressed || cell.count === null) return [1, minCell - 1];
  if (cell.count === 0) return [0, 0];
  return [Math.max(minCell, cell.count - HALF_BASE), cell.count + HALF_BASE];
}

const sumOf = (ranges: readonly CountRange[]): CountRange =>
  ranges.reduce<CountRange>((acc, r) => [acc[0] + r[0], acc[1] + r[1]], [0, 0]);

/**
 * The total as a reader can bound it from the published total (always published with DISCLOSURE_MIN_CELL)
 * and the open exclusive tables (all but `skip`).
 */
function totalBounds(total: DisclosedCell, ranges: readonly CountRange[][], open: readonly boolean[], skip = -1): CountRange {
  let [low, high] = possibleCounts(total, DISCLOSURE_MIN_CELL);
  ranges.forEach((table, j) => {
    if (j === skip || !open[j]) return;
    const [a, b] = sumOf(table);
    low = Math.max(low, a);
    high = Math.min(high, b);
  });
  return [low, high];
}

export interface LinkedTablesResult {
  /** True when a hidden count could still be pinned with every table hidden whole: then nothing is shown. */
  suppressAll: boolean;
  tables: DisclosedCell[][];
  /** Per table: hidden whole by the check. */
  hiddenWhole: boolean[];
  /** The total as a reader can bound it from everything published (used for the sensitive tables). */
  totalRange: CountRange;
}

/**
 * Step 5 for exclusive tables of the same people (each adds up to the total, which is published through
 * discloseCount with DISCLOSURE_MIN_CELL). A reader combines the bounds of every figure (possibleCounts). A
 * table where some hidden count would have a single possible value is hidden whole, zeros included, and
 * then no longer constrains the others; this repeats until no hidden count can be pinned. When such a
 * table has no visible cell left to hide (every count in it is 1 to minCell − 1), the pin comes from the
 * total itself, and `suppressAll` is set: the caller then shows nothing, as for a total of 1 to 4.
 */
export function protectLinkedTables(tables: readonly DisclosedCell[][], total: DisclosedCell, minCell: number): LinkedTablesResult {
  assertMinCell(minCell);
  const ranges = tables.map(table => table.map(cell => possibleCounts(cell, minCell)));
  const open = tables.map(() => true);
  for (;;) {
    const pinned = new Set<number>();
    tables.forEach((table, i) => {
      if (!open[i]) return;
      const [low, high] = totalBounds(total, ranges, open, i);
      const [tableLow, tableHigh] = sumOf(ranges[i]);
      table.forEach((cell, k) => {
        if (!cell.suppressed) return;
        const [cellLow, cellHigh] = ranges[i][k];
        const least = Math.max(cellLow, low - (tableHigh - cellHigh));
        const most = Math.min(cellHigh, high - (tableLow - cellLow));
        if (least >= most) pinned.add(i);
      });
    });
    if (pinned.size === 0) break;
    for (const i of pinned) {
      if (tables[i].every(cell => cell.suppressed)) {
        return {
          suppressAll: true,
          tables: tables.map(table => table.map(cell => hidden(cell.key))),
          hiddenWhole: tables.map(() => true),
          totalRange: [0, Number.MAX_SAFE_INTEGER],
        };
      }
      open[i] = false;
    }
  }
  return {
    suppressAll: false,
    tables: tables.map((table, i) => (open[i] ? table.map(cell => ({ ...cell })) : table.map(cell => hidden(cell.key)))),
    hiddenWhole: open.map(isOpen => !isOpen),
    totalRange: totalBounds(total, ranges, open),
  };
}

/**
 * Sensitive (non-exclusive) free-text tables after step 4: a hidden named row holds at least minCell people
 * (smaller rows were merged), so it was hidden because almost everyone is in it. When the reader's bounds on
 * the total leave it a single possible value, the table is hidden whole: no rows at all, because in a
 * free-text table each label shown is itself a lower bound (a named row holds at least minCell people).
 */
export function protectNearTotalRows(table: readonly DisclosedCell[], totalRange: CountRange, minCell: number): DisclosedCell[] {
  assertMinCell(minCell);
  const least = Math.max(minCell, totalRange[0] - (minCell - 1));
  const most = totalRange[1] - 1;
  const pinned = least >= most && table.some(cell => cell.suppressed && cell.key !== null && cell.key !== OTHER_KEY);
  return pinned ? [] : table.map(cell => ({ ...cell }));
}

export interface LinkedTableInput { cells: readonly CountInput[]; freeTextKeys: boolean }

export interface LinkedTablesOutput {
  /** The total is 1 to minCell − 1, or a hidden count could not be protected otherwise: nothing is shown. */
  suppressedAll: boolean;
  total: DisclosedCell;
  /**
   * In input order; empty when `suppressedAll`. A table hidden whole has every key hidden, zeros included;
   * a free-text table hidden whole has no rows, because each label shown would be a lower bound (a named
   * row holds at least minCell people, "not recorded" and OTHER_KEY at least one).
   */
  tables: DisclosedCell[][];
  /** The total as a reader can bound it from everything published. */
  totalRange: CountRange;
}

/**
 * Steps 1 to 3 and 5 for exclusive tables of the same people and their total (sex, age group, governorate
 * and status in the donor summary). Throws like discloseTable.
 */
export function discloseLinkedTables(inputs: readonly LinkedTableInput[], total: number, minCell = DISCLOSURE_MIN_CELL): LinkedTablesOutput {
  assertMinCell(minCell);
  assertCount(total, 'total');
  const tables = inputs.map(input => discloseTable(input.cells, total, { minCell, exclusive: true, freeTextKeys: input.freeTextKeys }));
  const nothing: LinkedTablesOutput = {
    suppressedAll: true, total: hidden(null), tables: inputs.map(() => []), totalRange: [0, Number.MAX_SAFE_INTEGER],
  };
  // A whole population of 1 to minCell − 1: zeros would reveal "all of them are …".
  if (total > 0 && total < minCell) return nothing;
  const publishedTotal = discloseCount(total, DISCLOSURE_MIN_CELL);
  const protectedTables = protectLinkedTables(tables, publishedTotal, minCell);
  if (protectedTables.suppressAll) return nothing;
  return {
    suppressedAll: false,
    total: publishedTotal,
    tables: protectedTables.tables.map((table, i) => (protectedTables.hiddenWhole[i] && inputs[i].freeTextKeys ? [] : table)),
    totalRange: protectedTables.totalRange,
  };
}

/**
 * One table with its total, steps 1 to 5. Exclusive tables are checked against the rounded total on their
 * own (when nothing can be shown, every cell is hidden); the donor summary checks its exclusive tables
 * together (src/services/beneficiaries/donorSummary.ts). Throws when minCell is below the platform floor, a
 * count is not a non-negative integer, or the cells of an exclusive table do not add up to `total`.
 */
export function applyDisclosureControl(cells: readonly CountInput[], total: number, options: DisclosureOptions): DisclosedCell[] {
  if (options.exclusive) {
    const linked = discloseLinkedTables([{ cells, freeTextKeys: options.freeTextKeys }], total, options.minCell);
    if (!linked.suppressedAll) return linked.tables[0];
    return options.freeTextKeys ? [] : discloseTable(cells, total, options).map(cell => hidden(cell.key));
  }
  const table = discloseTable(cells, total, options);
  const totalRange = possibleCounts(discloseCount(total, DISCLOSURE_MIN_CELL), DISCLOSURE_MIN_CELL);
  return options.freeTextKeys ? protectNearTotalRows(table, totalRange, options.minCell) : table;
}
