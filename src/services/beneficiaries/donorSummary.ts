import { AgeGroup, BeneficiaryStatus, Gender, Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import {
  CountInput, DisclosedCell, discloseCount, discloseLinkedTables, discloseTable, protectNearTotalRows,
  DISCLOSURE_MIN_CELL, DISCLOSURE_MIN_CELL_SENSITIVE, DISCLOSURE_ROUNDING_BASE, OTHER_KEY,
} from '../privacy/disclosure';
import { donorPlaceName } from '../privacy/places';

/**
 * The beneficiary figures donor viewers get instead of records (GET /projects/:id/beneficiaries/stats and
 * `beneficiarySummary` in the project export): one-way tables only, small counts hidden and every other
 * count rounded to the nearest 5 (docs/SECURITY_SETUP.md §8.4). There are no cross-tabulations: a sex × age
 * table would need its own protection, otherwise a hidden marginal can be recovered from its inner cells.
 */

export const GENDERS = Object.values(Gender);
export const AGE_GROUPS = Object.values(AgeGroup);
export const BENEFICIARY_STATUSES = Object.values(BeneficiaryStatus);

/** Longest free-text tag or service type kept (longer ones are cut). */
const MAX_FREE_TEXT_KEY = 40;

export interface BeneficiaryAggregates {
  total: number;
  serviceCount: number;
  /** Every Gender value, zeros included. */
  byGender: CountInput[];
  /** Every AgeGroup value, then null when above 0. */
  byAgeGroup: CountInput[];
  /** Trimmed values (null for empty), any order. */
  byGovernorate: CountInput[];
  /** Every BeneficiaryStatus value. */
  byStatus: CountInput[];
  /** People per normalised tag (strings only, trimmed, lower case, at most 40 characters, once per person). */
  byVulnerabilityTag: CountInput[];
  /** Distinct people per normalised service type. */
  byServiceType: CountInput[];
}

export interface DonorBeneficiarySummary {
  audience: 'donor';
  minCell: number;
  minCellSensitive: number;
  /** Every count shown is rounded to a multiple of this (totals on their own, so parts may not add up). */
  roundingBase: number;
  otherKey: typeof OTHER_KEY;
  /**
   * Nothing is shown: total and serviceCount hidden, every table empty. For a total of 1 to minCell − 1, and in
   * the rare case where a small count could otherwise be worked out from the rounded figures.
   */
  suppressedAll: boolean;
  total: DisclosedCell;
  serviceCount: DisclosedCell;
  byGender: DisclosedCell[];
  byAgeGroup: DisclosedCell[];
  byGovernorate: DisclosedCell[];
  byStatus: DisclosedCell[];
  byVulnerabilityTag: DisclosedCell[];
  byServiceType: DisclosedCell[];
}

type Grouped<K extends string> = Record<K, unknown> & { _count: { _all: number } };

/** Counts per enum value in enum order, zeros included; `withNull` adds a trailing null row when above 0. */
function enumCounts<K extends string>(values: readonly string[], groups: readonly Grouped<K>[], field: K, withNull = false): CountInput[] {
  const counts = new Map<string | null, number>();
  for (const group of groups) {
    const key = (group[field] ?? null) as string | null;
    counts.set(key, (counts.get(key) ?? 0) + group._count._all);
  }
  const rows: CountInput[] = values.map(value => ({ key: value, count: counts.get(value) ?? 0 }));
  const missing = counts.get(null) ?? 0;
  if (withNull && missing > 0) rows.push({ key: null, count: missing });
  return rows;
}

/** Trimmed free-text values; empty or missing → null; equal values after trimming are added together. */
function freeTextCounts(groups: readonly { key: string | null; count: number }[]): CountInput[] {
  const counts = new Map<string | null, number>();
  for (const group of groups) {
    const key = typeof group.key === 'string' && group.key.trim() ? group.key.trim() : null;
    counts.set(key, (counts.get(key) ?? 0) + group.count);
  }
  return Array.from(counts, ([key, count]) => ({ key, count }));
}

/**
 * Database reads for one project, all in one snapshot (repeatable read) so the tables add up to the
 * total: counts and GROUP BY only. Never returns beneficiary rows, names, ids or contact details.
 */
export async function loadBeneficiaryAggregates(projectId: string): Promise<BeneficiaryAggregates> {
  const where = { projectId };
  const read = await prisma.$transaction(async tx => ({
    total: await tx.beneficiary.count({ where }),
    serviceCount: await tx.beneficiaryService.count({ where }),
    gender: await tx.beneficiary.groupBy({ by: ['gender'], where, _count: { _all: true } }),
    ageGroup: await tx.beneficiary.groupBy({ by: ['ageGroup'], where, _count: { _all: true } }),
    governorate: await tx.beneficiary.groupBy({ by: ['governorate'], where, _count: { _all: true } }),
    status: await tx.beneficiary.groupBy({ by: ['status'], where, _count: { _all: true } }),
    // People per tag: string elements only, trimmed, lower case, cut to 40 characters, counted once per person.
    tags: await tx.$queryRaw<{ key: string; count: number }[]>(Prisma.sql`
      SELECT t.key, COUNT(DISTINCT t.id)::int AS count
      FROM (
        SELECT b."id" AS id, left(lower(btrim(e.value #>> '{}')), ${MAX_FREE_TEXT_KEY}::int) AS key
        FROM "Beneficiary" b
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(b."vulnerabilityTags") = 'array' THEN b."vulnerabilityTags" ELSE '[]'::jsonb END
        ) AS e(value)
        WHERE b."projectId" = ${projectId} AND jsonb_typeof(e.value) = 'string'
      ) t
      WHERE t.key <> ''
      GROUP BY t.key`),
    // Distinct people per service type, normalised the same way.
    services: await tx.$queryRaw<{ key: string; count: number }[]>(Prisma.sql`
      SELECT t.key, COUNT(DISTINCT t.beneficiary)::int AS count
      FROM (
        SELECT s."beneficiaryId" AS beneficiary, left(lower(btrim(s."serviceType")), ${MAX_FREE_TEXT_KEY}::int) AS key
        FROM "BeneficiaryService" s
        WHERE s."projectId" = ${projectId}
      ) t
      WHERE t.key <> ''
      GROUP BY t.key`),
  }), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  const { total, serviceCount, gender, ageGroup, governorate, status, tags, services } = read;

  return {
    total,
    serviceCount,
    byGender: enumCounts(GENDERS, gender as Grouped<'gender'>[], 'gender'),
    byAgeGroup: enumCounts(AGE_GROUPS, ageGroup as Grouped<'ageGroup'>[], 'ageGroup', true),
    byGovernorate: freeTextCounts((governorate as Grouped<'governorate'>[]).map(g => ({ key: g.governorate as string | null, count: g._count._all }))),
    byStatus: enumCounts(BENEFICIARY_STATUSES, status as Grouped<'status'>[], 'status'),
    byVulnerabilityTag: tags.map(t => ({ key: t.key, count: Number(t.count) })),
    byServiceType: services.map(s => ({ key: s.key, count: Number(s.count) })),
  };
}

/**
 * Display order of a free-text table, from what is shown only (never from exact or hidden counts): visible
 * named rows largest first, ties by key (code-point order); then hidden named rows by key; then "not
 * recorded" (null); then OTHER_KEY.
 */
function displayOrder(cells: readonly DisclosedCell[]): DisclosedCell[] {
  const rank = (cell: DisclosedCell) => (cell.key === OTHER_KEY ? 3 : cell.key === null ? 2 : cell.suppressed ? 1 : 0);
  return [...cells].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (rank(a) === 0 && a.count !== b.count) return (b.count ?? 0) - (a.count ?? 0);
    const ka = a.key ?? '';
    const kb = b.key ?? '';
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * Governorates as donors may see them: a listed governorate or region under its listed name (spellings
 * merged); anything else typed (a village, a camp, a name) joins OTHER_KEY whatever its size, so its label is
 * never shown; "not recorded" stays null.
 */
function listedPlaces(rows: readonly CountInput[]): CountInput[] {
  const counts = new Map<string | null, number>();
  for (const row of rows) {
    const key = row.key === null ? null : donorPlaceName(row.key) ?? OTHER_KEY;
    counts.set(key, (counts.get(key) ?? 0) + row.count);
  }
  return Array.from(counts, ([key, count]) => ({ key, count }));
}

/**
 * Puts rows in the given key order, adding zeros for missing keys; other keys follow, then null when above 0,
 * or always with `withNull` (a fixed set of keys, so the shape of the table never tells anything).
 */
function inOrder(rows: readonly CountInput[], keys: readonly string[], withNull = false): CountInput[] {
  const counts = new Map<string | null, number>();
  for (const row of rows) counts.set(row.key, (counts.get(row.key) ?? 0) + row.count);
  const ordered: CountInput[] = keys.map(key => ({ key, count: counts.get(key) ?? 0 }));
  for (const [key, count] of counts) {
    if (key !== null && !keys.includes(key)) ordered.push({ key, count });
  }
  const missing = counts.get(null) ?? 0;
  if (missing > 0 || withNull) ordered.push({ key: null, count: missing });
  return ordered;
}

/** Pure: aggregates → the donor summary (docs/SECURITY_SETUP.md §8.4). */
export function toDonorBeneficiarySummary(agg: BeneficiaryAggregates): DonorBeneficiarySummary {
  const base: Pick<DonorBeneficiarySummary, 'audience' | 'minCell' | 'minCellSensitive' | 'roundingBase' | 'otherKey'> = {
    audience: 'donor',
    minCell: DISCLOSURE_MIN_CELL,
    minCellSensitive: DISCLOSURE_MIN_CELL_SENSITIVE,
    roundingBase: DISCLOSURE_ROUNDING_BASE,
    otherKey: OTHER_KEY,
  };

  // Sex, age group, governorate and status each add up to the total: disclosed and checked together.
  const linked = discloseLinkedTables([
    { cells: inOrder(agg.byGender, GENDERS), freeTextKeys: false },
    { cells: inOrder(agg.byAgeGroup, AGE_GROUPS, true), freeTextKeys: false },
    { cells: listedPlaces(freeTextCounts(agg.byGovernorate)), freeTextKeys: true },
    { cells: inOrder(agg.byStatus, BENEFICIARY_STATUSES), freeTextKeys: false },
  ], agg.total);

  if (linked.suppressedAll) {
    return {
      ...base,
      suppressedAll: true,
      total: linked.total,
      serviceCount: { key: null, count: null, suppressed: true },
      byGender: [], byAgeGroup: [], byGovernorate: [], byStatus: [], byVulnerabilityTag: [], byServiceType: [],
    };
  }

  // People per tag and per service type (one person may be in several rows): sensitive minimum, and a row
  // is hidden too when almost everyone is in it.
  const sensitive = (cells: CountInput[]) => displayOrder(protectNearTotalRows(
    discloseTable(cells, agg.total, { minCell: DISCLOSURE_MIN_CELL_SENSITIVE, exclusive: false, freeTextKeys: true }),
    linked.totalRange,
    DISCLOSURE_MIN_CELL_SENSITIVE,
  ));
  const [byGender, byAgeGroup, byGovernorate, byStatus] = linked.tables;

  return {
    ...base,
    suppressedAll: false,
    total: linked.total,
    serviceCount: discloseCount(agg.serviceCount, DISCLOSURE_MIN_CELL),
    byGender,
    byAgeGroup,
    byGovernorate: displayOrder(byGovernorate),
    byStatus,
    byVulnerabilityTag: sensitive(agg.byVulnerabilityTag),
    byServiceType: sensitive(agg.byServiceType),
  };
}
