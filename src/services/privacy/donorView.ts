import {
  Assessment, AssessmentStatus, AssessmentType, CollectionMethod, DataPoint, DocumentType, DonorType, Prisma,
  QualitativeEntry, QualitativeType, Report, ReportStatus, ReportType,
} from '@prisma/client';
import { hasStaffRole } from '../../middleware/roles';
import { isCountUnit, isPercentUnit, parseNumeric } from '../dataPoints/breakdown';
import { DisclosedCell, discloseCount, DISCLOSURE_MIN_CELL } from './disclosure';
import { donorPlace, donorPlaceName } from './places';

/**
 * Donor projections (docs/SECURITY_SETUP.md §8). Pure functions that build donor responses from explicit
 * field lists, so a column added later never reaches donor viewers by accident. Routes apply them when
 * `hasStaffRole(req.user)` is false (deny by default: a missing or unknown role gets this view too).
 */

/** Document types that normally pass between an organisation and its donor. Never `other`, never transcripts. */
export const DONOR_DOCUMENT_TYPES = [
  'proposal', 'logframe', 'theory_of_change', 'baseline_report', 'donor_guidelines', 'budget',
] as const satisfies readonly DocumentType[];

const DONOR_TYPES: ReadonlySet<string> = new Set(DONOR_DOCUMENT_TYPES);

/** A donor-facing type, and not an FGD/KII transcript uploaded through the qualitative upload. */
export function donorCanSeeDocument(doc: { fileType: DocumentType | string; qualitativeSource: boolean }): boolean {
  return DONOR_TYPES.has(doc.fileType) && doc.qualitativeSource === false;
}

/** Prisma filter for document lists: nothing extra for staff, donor-visible documents only for everyone else. */
export function donorDocumentWhere(user: { role?: unknown } | null | undefined): Prisma.DocumentWhereInput {
  if (hasStaffRole(user)) return {};
  return { fileType: { in: [...DONOR_DOCUMENT_TYPES] }, qualitativeSource: false };
}

/**
 * An area as donors see it: a listed region or governorate (src/services/privacy/places.ts), otherwise null.
 * Deny by default: villages, camps, streets, coordinates in any format, plus codes and anything typed by
 * mistake (a name) never reach donor viewers; a household location is personal data and finer than a
 * governorate.
 */
export function donorArea(area: string | null | undefined): string | null {
  return donorPlaceName(area);
}

export interface AreaCount { area: string | null; dataPointCount: number }

/** A dashboard area group as donors see it: the listed place (English name, plus the Arabic one) or null. */
export interface DonorAreaCount { area: string | null; areaAr: string | null; dataPointCount: number }

/**
 * The dashboard's per-area counts for donors, grouped by listed place whatever the spelling or script it was
 * typed in (so "Hebron" and "الخليل" are one group), under the English listed name with the Arabic one beside
 * it; areas not on the list fold into one `area: null` group. First-seen order.
 */
export function mergeDonorAreas(groups: readonly AreaCount[]): DonorAreaCount[] {
  const merged = new Map<string | null, DonorAreaCount>();
  for (const group of groups) {
    const place = donorPlace(group.area);
    const key = place?.en ?? null;
    const entry = merged.get(key) ?? { area: key, areaAr: place?.ar ?? null, dataPointCount: 0 };
    entry.dataPointCount += group.dataPointCount;
    merged.set(key, entry);
  }
  return Array.from(merged.values());
}

export type DataPointLike = Pick<DataPoint,
  'id' | 'indicatorId' | 'assessmentId' | 'value' | 'collectionDate' | 'collectionMethod' | 'dataSource' | 'geographicArea' | 'breakdown' | 'createdAt'
> & { indicator?: { indicatorText: string } | null };

export interface DonorDataPoint {
  id: string;
  indicatorId: string;
  assessmentId: string | null;
  value: string;
  collectionDate: Date;
  collectionMethod: CollectionMethod;
  dataSource: string | null;
  geographicArea: string | null;
  breakdown: Prisma.JsonValue | null;
  createdAt: Date;
  indicator?: { indicatorText: string };
}

/** No notes (free text, may name respondents), attachments, createdBy or creator; listed areas only. */
export function toDonorDataPoint(dp: DataPointLike): DonorDataPoint {
  const out: DonorDataPoint = {
    id: dp.id,
    indicatorId: dp.indicatorId,
    assessmentId: dp.assessmentId,
    value: dp.value,
    collectionDate: dp.collectionDate,
    collectionMethod: dp.collectionMethod,
    dataSource: dp.dataSource,
    geographicArea: donorArea(dp.geographicArea),
    breakdown: dp.breakdown ?? null,
    createdAt: dp.createdAt,
  };
  if (dp.indicator) out.indicator = { indicatorText: dp.indicator.indicatorText };
  return out;
}

/** The data source the KoboToolbox webhook writes on every data point it creates (src/routes/webhooks.ts). */
export const KOBO_DATA_SOURCE = 'KoboToolbox';

/**
 * Rows that hold one respondent's answer: KoboToolbox submissions. The webhook writes one row per submission
 * and mapped field, with `dataSource: 'KoboToolbox'` and the household's GPS; a row typed by staff with that
 * source counts too (compared without regard to case, exactly as RESPONDENT_LEVEL_WHERE). Donors never get
 * these rows one by one, only monthly aggregates (toDonorSurveyAggregates), and the record counts donors see
 * leave them out (donorDataPointWhere). Results staff enter, whatever the collection method (household survey
 * included), are indicator values: one survey round's result, as donors' reports need it.
 */
export function isRespondentLevel(dp: { dataSource: string | null }): boolean {
  return (dp.dataSource ?? '').toLowerCase() === KOBO_DATA_SOURCE.toLowerCase();
}

/** Prisma filter for the same rows as isRespondentLevel. */
export const RESPONDENT_LEVEL_WHERE: Prisma.DataPointWhereInput = {
  dataSource: { equals: KOBO_DATA_SOURCE, mode: 'insensitive' },
};

/** Prisma filter for every other row (written out: NOT over a nullable column would also drop rows without a source). */
export const NOT_RESPONDENT_LEVEL_WHERE: Prisma.DataPointWhereInput = {
  OR: [{ dataSource: null }, { NOT: { dataSource: { equals: KOBO_DATA_SOURCE, mode: 'insensitive' } } }],
};

/**
 * Prisma filter for the data points a user may count (`_count`, dashboard counts): every row for staff; for
 * everyone else only the rows donors are shown one by one. An exact count of KoboToolbox rows is the exact
 * number of submissions, which would undo the hiding and rounding of `submissions` (§8.4) and, with a mean,
 * give away one household's answer as it arrives.
 */
export function donorDataPointWhere(user: { role?: unknown } | null | undefined): Prisma.DataPointWhereInput {
  return hasStaffRole(user) ? {} : NOT_RESPONDENT_LEVEL_WHERE;
}

/** Days after the end of a month before its survey aggregates reach donors. */
export const SURVEY_RELEASE_DELAY_DAYS = 14;

/**
 * When the survey aggregates of a month ('YYYY-MM', UTC) reach donors: 00:00 UTC, 14 days after the month
 * ends. Each aggregate is built from the submissions received before then, so once published it never
 * changes: a figure that moved with every new submission would give away each household's answer by
 * differencing (the mean before and after one submission).
 */
export function surveyReleaseAt(period: string): Date {
  const [year, month] = period.split('-').map(Number);
  // Date.UTC months count from 0, so `month` is the month after the period.
  return new Date(Date.UTC(year, month, 1 + SURVEY_RELEASE_DELAY_DAYS));
}

/**
 * The respondent-level rows that may go into a donor aggregate at `now`: rows of months already released
 * (surveyReleaseAt), received (createdAt) before their month's release. Later submissions stay with staff.
 */
export function releasedSurveyRows<T extends { collectionDate: Date; createdAt: Date }>(rows: readonly T[], now: Date): T[] {
  return rows.filter(row => {
    const release = surveyReleaseAt(row.collectionDate.toISOString().slice(0, 7));
    return now.getTime() >= release.getTime() && row.createdAt.getTime() < release.getTime();
  });
}

export interface DonorSurveyAggregate {
  indicatorId: string;
  /** Calendar month of collection, 'YYYY-MM' (UTC). */
  period: string;
  /**
   * Submissions in the period (one respondent or household each), as a count shown to donors: 1 to 4
   * hidden, otherwise rounded to the nearest 5.
   */
  submissions: DisclosedCell;
  /**
   * 'yes_count' when every answer is yes/no (1/0, or 100/0 for a percent unit): the number of yes answers;
   * 'sum' for indicators that count something (unit number, people…); otherwise 'mean'.
   */
  aggregation: 'yes_count' | 'sum' | 'mean';
  /**
   * Null when the submissions are hidden, when no answer is a number, when a count (yes_count, sum) is 1 to
   * 4, or when a mean would be of 7 answers or fewer (HESA's rule for averages). Counts are rounded to the
   * nearest 5; a mean to one decimal place. Never a single answer.
   */
  value: number | null;
  /** Answers that are numbers (yes/no count as 1/0), shown like `submissions`. */
  numericAnswers: DisclosedCell;
}

/** HESA suppresses averages of 7 or fewer people. */
const MIN_ANSWERS_FOR_MEAN = 8;
const YES = /^(yes|true|نعم)$/i;
const NO = /^(no|false|لا)$/i;

/** One answer as a number: a numeric string, or yes/no as 1/0; otherwise null. */
function answerValue(value: string): number | null {
  const text = value.trim();
  if (YES.test(text)) return 1;
  if (NO.test(text)) return 0;
  return parseNumeric(text);
}

/**
 * Pure: respondent-level rows → one aggregate per indicator and calendar month, with the disclosure rules
 * for counts (docs/SECURITY_SETUP.md §8.4). Only released months, from the rows received before their
 * release (releasedSurveyRows), so a published aggregate never changes. `unitOf` gives the indicator's unit
 * (sum for count units). Ordered by indicator (first seen), then period.
 */
export function toDonorSurveyAggregates(
  allRows: readonly { indicatorId: string; value: string; collectionDate: Date; createdAt: Date }[],
  unitOf: (indicatorId: string) => string | null | undefined,
  now: Date = new Date(),
): DonorSurveyAggregate[] {
  const rows = releasedSurveyRows(allRows, now);
  const groups = new Map<string, { indicatorId: string; period: string; count: number; values: number[] }>();
  for (const row of rows) {
    const period = row.collectionDate.toISOString().slice(0, 7);
    const key = `${row.indicatorId} ${period}`;
    const group = groups.get(key) ?? { indicatorId: row.indicatorId, period, count: 0, values: [] };
    group.count++;
    const value = answerValue(row.value);
    if (value !== null) group.values.push(value);
    groups.set(key, group);
  }
  const order = new Map<string, number>();
  for (const row of rows) if (!order.has(row.indicatorId)) order.set(row.indicatorId, order.size);
  return Array.from(groups.values())
    .sort((a, b) => (order.get(a.indicatorId)! - order.get(b.indicatorId)!) || (a.period < b.period ? -1 : a.period > b.period ? 1 : 0))
    .map(group => {
      const submissions = discloseCount(group.count, DISCLOSURE_MIN_CELL);
      const numericAnswers = discloseCount(group.values.length, DISCLOSURE_MIN_CELL);
      const unit = unitOf(group.indicatorId);
      // A share of yes answers is a count in disguise (0.2 of 5 households is one household): shown as a count.
      const yes = isPercentUnit(unit) && group.values.every(v => v === 0 || v === 100) ? 100 : 1;
      const binary = group.values.length > 0 && group.values.every(v => v === 0 || v === yes);
      const aggregation = binary ? 'yes_count' : isCountUnit(unit) ? 'sum' : 'mean';
      let value: number | null = null;
      if (!submissions.suppressed && !numericAnswers.suppressed && group.values.length > 0) {
        const total = group.values.reduce((a, b) => a + b, 0);
        if (aggregation === 'mean') {
          value = group.values.length >= MIN_ANSWERS_FOR_MEAN ? Math.round((total / group.values.length) * 10) / 10 : null;
        } else {
          const count = Math.round(binary ? total / yes : total);
          value = count < 0 ? null : discloseCount(count, DISCLOSURE_MIN_CELL).count;
        }
      }
      return { indicatorId: group.indicatorId, period: group.period, submissions, aggregation, value, numericAnswers };
    });
}

/** Donor view of an indicator's data points: respondent-level rows become released monthly aggregates. */
export function toDonorIndicatorData(
  rows: readonly DataPointLike[],
  unitOf: (indicatorId: string) => string | null | undefined,
  now: Date = new Date(),
): { dataPoints: DonorDataPoint[]; surveyAggregates: DonorSurveyAggregate[] } {
  return {
    dataPoints: rows.filter(row => !isRespondentLevel(row)).map(toDonorDataPoint),
    surveyAggregates: toDonorSurveyAggregates(rows.filter(isRespondentLevel), unitOf, now),
  };
}

export type QualitativeEntryLike = Pick<QualitativeEntry,
  'id' | 'projectId' | 'assessmentId' | 'entryType' | 'dateConducted' | 'participants'
>;

/**
 * What donors get for a qualitative entry: that it took place, its type, its month and the number of
 * participants. Never the title, content, facilitator, location, attachments, exact date or time, and no
 * AI output (themes, sentiment, linked indicators): AI coding is not reviewed before donors would see it.
 */
export interface DonorQualitativeEntry {
  id: string;
  projectId: string;
  assessmentId: string | null;
  entryType: QualitativeType;
  /** 'YYYY-MM' (UTC), or null. Never the exact date. */
  monthConducted: string | null;
  participants: number | null;
}

export function toDonorQualitativeEntry(entry: QualitativeEntryLike): DonorQualitativeEntry {
  return {
    id: entry.id,
    projectId: entry.projectId,
    assessmentId: entry.assessmentId,
    entryType: entry.entryType,
    monthConducted: entry.dateConducted ? entry.dateConducted.toISOString().slice(0, 7) : null,
    participants: entry.participants,
  };
}

export type AssessmentLike = Pick<Assessment,
  'id' | 'projectId' | 'type' | 'status' | 'requestedAt' | 'deliveredAt' | 'sampleSize' | 'methodsIncluded'
>;

export interface DonorAssessment {
  id: string;
  projectId: string;
  type: AssessmentType;
  status: AssessmentStatus;
  requestedAt: Date;
  deliveredAt: Date | null;
  sampleSize: number | null;
  /** Collection methods only (CollectionMethod values). */
  methodsIncluded: CollectionMethod[];
}

const METHODS: ReadonlySet<string> = new Set(Object.values(CollectionMethod));

/**
 * Never scopeDescription (it holds the AI assessment, written from transcript excerpts), the price or the
 * report location.
 */
export function toDonorAssessment(a: AssessmentLike): DonorAssessment {
  const methods = Array.isArray(a.methodsIncluded) ? a.methodsIncluded : [];
  return {
    id: a.id,
    projectId: a.projectId,
    type: a.type,
    status: a.status,
    requestedAt: a.requestedAt,
    deliveredAt: a.deliveredAt,
    sampleSize: a.sampleSize,
    methodsIncluded: methods.filter((m): m is CollectionMethod => typeof m === 'string' && METHODS.has(m)),
  };
}

export type ReportLike = Pick<Report,
  'id' | 'projectId' | 'type' | 'title' | 'donorFormat' | 'generatedAt' | 'periodStart' | 'periodEnd' | 'status' | 'aiNarrative'
>;

/** Donors see published reports only: a draft holds an unreviewed AI narrative (from transcripts, for assessments). */
export function donorCanSeeReport(report: { status: ReportStatus | string }): boolean {
  return report.status === 'published';
}

/** Prisma filter for report lists: nothing extra for staff, published reports only for everyone else. */
export function donorReportWhere(user: { role?: unknown } | null | undefined): Prisma.ReportWhereInput {
  return hasStaffRole(user) ? {} : { status: 'published' };
}

export interface DonorReport {
  id: string;
  projectId: string;
  type: ReportType;
  title: string;
  donorFormat: DonorType | null;
  generatedAt: Date;
  periodStart: Date | null;
  periodEnd: Date | null;
  status: ReportStatus;
  /** The narrative of a published report (staff published it after review). */
  aiNarrative: string | null;
}

/** A published report from an explicit field list (never fileUrl). */
export function toDonorReport(r: ReportLike): DonorReport {
  return {
    id: r.id,
    projectId: r.projectId,
    type: r.type,
    title: r.title,
    donorFormat: r.donorFormat,
    generatedAt: r.generatedAt,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    status: r.status,
    aiNarrative: r.aiNarrative,
  };
}

/**
 * Donor view of a document row selected with DOCUMENT_FIELDS: no AI analysis (not reviewed) and no
 * uploader name (field staff are not named to donors).
 */
export function toDonorDocument<T extends { aiAnalysis?: unknown; uploader?: unknown }>(doc: T): T {
  return { ...doc, aiAnalysis: null, uploader: null };
}
