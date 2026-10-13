import { describe, expect, it } from 'vitest';
import { DocumentType } from '@prisma/client';
import { hasStaffRole } from '../src/middleware/roles';
import {
  DONOR_DOCUMENT_TYPES, donorArea, donorCanSeeDocument, donorCanSeeReport, donorDataPointWhere, donorDocumentWhere, donorReportWhere,
  isRespondentLevel, mergeDonorAreas, NOT_RESPONDENT_LEVEL_WHERE, releasedSurveyRows, surveyReleaseAt, toDonorAssessment,
  toDonorDataPoint, toDonorDocument, toDonorIndicatorData, toDonorQualitativeEntry, toDonorReport, toDonorSurveyAggregates,
} from '../src/services/privacy/donorView';
import { DONOR_PLACES, donorPlaceName } from '../src/services/privacy/places';

const DATA_POINT_KEYS = ['id', 'indicatorId', 'assessmentId', 'value', 'collectionDate', 'collectionMethod', 'dataSource', 'geographicArea', 'breakdown', 'createdAt'];
const QUALITATIVE_KEYS = ['id', 'projectId', 'assessmentId', 'entryType', 'monthConducted', 'participants'];
const ASSESSMENT_KEYS = ['id', 'projectId', 'type', 'status', 'requestedAt', 'deliveredAt', 'sampleSize', 'methodsIncluded'];
const REPORT_KEYS = ['id', 'projectId', 'type', 'title', 'donorFormat', 'generatedAt', 'periodStart', 'periodEnd', 'status', 'aiNarrative'];

const dataPointRow = {
  id: 'dp-1', indicatorId: 'ind-1', assessmentId: null, projectId: 'p-1', value: '10',
  collectionDate: new Date('2026-03-01'), collectionMethod: 'secondary_data' as const, dataSource: 'Ministry of Health records',
  geographicArea: '31.531234, 35.095678', notes: 'Respondent Layla Testname', attachments: [{ fileName: 'photo_layla.jpg' }],
  breakdown: { sex: { female: 6, male: 4 } }, createdAt: new Date('2026-03-02T10:00:00Z'), createdBy: 'user-1',
  creator: { fullName: 'Officer a' },
};

const qualitativeRow = {
  id: 'q-1', projectId: 'p-1', assessmentId: null, entryType: 'kii_notes' as const,
  title: 'KII with Layla Testname', content: 'Participant Layla Testname said…', participants: 1,
  location: '31.531234, 35.095678', dateConducted: new Date('2026-03-14'), facilitator: 'Facilitator Testname',
  themes: ['access to services', 7, null, 'water'], sentiment: 'negative' as const, linkedIndicators: ['ind-1', { id: 'x' }],
  attachments: [{ fileName: 'KII_Layla_Testname.docx' }], createdAt: new Date('2026-03-15T08:00:00Z'),
};

describe('donorArea: listed places only', () => {
  it.each([
    // Listed regions and governorates, in English or Arabic, any common spelling → the listed name.
    [' Hebron ', 'Hebron'],
    ['hebron governorate', 'Hebron'],
    ['Al-Khalil', 'Hebron'],
    ['الخليل', 'الخليل'],
    ['محافظة الخليل', 'الخليل'],
    ['Ramallah', 'Ramallah and Al-Bireh'],
    ['رام الله و البيرة', 'رام الله والبيرة'],
    ['اريحا', 'أريحا والأغوار'],
    ['Khan Yunis', 'Khan Younis'],
    ['Gaza Strip', 'Gaza Strip'],
    // Anything else → null: villages, camps, streets, typed names, coordinates in every format, plus codes.
    ['Beit Ummar', null],
    ['Jenin camp', null],
    ['Wadi Testvillage house 12', null],
    ['Area C, zone 3', null],
    ['Layla Testname', null],
    ['Hebron (31.53, 35.09)', null],
    ['31.531234, 35.095678', null],
    ['31.53 35.09 0 0', null],
    ['31.531234;35.095678', null],
    ['٣١٫٥٣١٢، ٣٥٫٠٩٥٦', null],
    ['31°31\'52"N 35°05\'44"E', null],
    ['31.531234°N, 35.095678°E', null],
    ['31.531234° N 35.095678° E', null],
    ['31.53123° N, 35.09568° E', null],
    ['N31.531234 E35.095678', null],
    ['31.531234N 35.095678E', null],
    ['lat 31.531234 lon 35.095678', null],
    ['lat=31.531234&lon=35.095678', null],
    ['8G3QG3J9+F7', null],
    ['', null],
    ['   ', null],
    [null, null],
    [undefined, null],
  ])('%j → %j', (area, expected) => {
    expect(donorArea(area)).toBe(expected);
  });

  it('knows the two regions and the 16 governorates, each name once', () => {
    expect(DONOR_PLACES).toHaveLength(18);
    for (const place of DONOR_PLACES) {
      expect(donorPlaceName(place.en)).toBe(place.en);
      expect(donorPlaceName(place.ar)).toBe(place.ar);
      for (const alias of place.aliases) expect(donorPlaceName(alias)).toBe(/[\u0600-\u06FF]/.test(alias) ? place.ar : place.en);
    }
  });
});

describe('mergeDonorAreas', () => {
  it('folds unlisted areas into one null group and adds equal places together, whatever the spelling or script', () => {
    expect(mergeDonorAreas([
      { area: 'Hebron', dataPointCount: 3 },
      { area: '31.531234, 35.095678', dataPointCount: 1 },
      { area: 'الخليل', dataPointCount: 1 },
      { area: 'Beit Ummar', dataPointCount: 1 },
      { area: ' hebron', dataPointCount: 2 },
      { area: 'محافظة الخليل', dataPointCount: 1 },
      { area: null, dataPointCount: 4 },
      { area: 'رام الله', dataPointCount: 2 },
    ])).toEqual([
      { area: 'Hebron', areaAr: 'الخليل', dataPointCount: 7 },
      { area: null, areaAr: null, dataPointCount: 6 },
      { area: 'Ramallah and Al-Bireh', areaAr: 'رام الله والبيرة', dataPointCount: 2 },
    ]);
  });
});

describe('toDonorDataPoint', () => {
  it('keeps exactly the donor fields and removes coordinates', () => {
    const out = toDonorDataPoint(dataPointRow);
    expect(Object.keys(out).sort()).toEqual([...DATA_POINT_KEYS].sort());
    expect(out.geographicArea).toBeNull();
    expect(out.breakdown).toEqual({ sex: { female: 6, male: 4 } });
    expect(JSON.stringify(out)).not.toMatch(/Testname|photo_layla|Officer a|user-1/);
  });

  it('keeps the indicator text when the row has it', () => {
    const out = toDonorDataPoint({ ...dataPointRow, geographicArea: 'Hebron', indicator: { indicatorText: 'Households reached' } });
    expect(Object.keys(out).sort()).toEqual([...DATA_POINT_KEYS, 'indicator'].sort());
    expect(out.indicator).toEqual({ indicatorText: 'Households reached' });
    expect(out.geographicArea).toBe('Hebron');
  });
});

describe('toDonorQualitativeEntry', () => {
  it('keeps the type, month and participants only: no exact time and no AI output', () => {
    const out = toDonorQualitativeEntry(qualitativeRow);
    expect(Object.keys(out).sort()).toEqual([...QUALITATIVE_KEYS].sort());
    expect(out).toEqual({ id: 'q-1', projectId: 'p-1', assessmentId: null, entryType: 'kii_notes', monthConducted: '2026-03', participants: 1 });
    expect(JSON.stringify(out)).not.toMatch(/Testname|31\.53|2026-03-14|2026-03-15|access to services|negative|ind-1/);
  });

  it('handles a missing date', () => {
    expect(toDonorQualitativeEntry({ ...qualitativeRow, dateConducted: null }).monthConducted).toBeNull();
  });
});

describe('survey rows (one respondent each)', () => {
  /** A KoboToolbox row received the day after it was collected. Every month here was released long before NOW. */
  const row = (value: string, day: string, extra: Partial<typeof dataPointRow> = {}) => ({
    ...dataPointRow, id: `dp-${day}-${value}`, value, collectionDate: new Date(day), collectionMethod: 'hh_survey' as const, dataSource: 'KoboToolbox',
    createdAt: new Date(new Date(day).getTime() + 86_400_000), ...extra,
  });
  const NOW = new Date('2026-10-13T09:00:00Z');

  it('are the KoboToolbox rows; results staff enter are not, whatever the method', () => {
    expect(isRespondentLevel({ dataSource: 'KoboToolbox' })).toBe(true);
    expect(isRespondentLevel({ dataSource: 'kobotoolbox' })).toBe(true);
    // A household-survey result staff entered (one survey round) is an indicator value.
    expect(isRespondentLevel({ dataSource: null })).toBe(false);
    expect(isRespondentLevel({ dataSource: 'Endline household survey (n=420)' })).toBe(false);
    expect(isRespondentLevel({ dataSource: 'Manasati' })).toBe(false);
    // The same rule as the Prisma filters (case-insensitive equality, no trimming).
    expect(isRespondentLevel({ dataSource: ' KoboToolbox ' })).toBe(false);
    expect(NOT_RESPONDENT_LEVEL_WHERE).toEqual({ OR: [{ dataSource: null }, { NOT: { dataSource: { equals: 'KoboToolbox', mode: 'insensitive' } } }] });
  });

  it('are left out of the counts everyone but staff sees', () => {
    for (const role of ['org_admin', 'platform_admin', 'me_officer']) expect(donorDataPointWhere({ role })).toEqual({});
    for (const user of [{ role: 'donor_viewer' }, { role: undefined }, { role: 'admin' }, undefined]) {
      expect(donorDataPointWhere(user)).toEqual(NOT_RESPONDENT_LEVEL_WHERE);
    }
  });

  it('reach donors once their month is released, 14 days after it ends, and only if received by then', () => {
    expect(surveyReleaseAt('2026-08').toISOString()).toBe('2026-09-15T00:00:00.000Z');
    expect(surveyReleaseAt('2026-12').toISOString()).toBe('2027-01-15T00:00:00.000Z');
    const august = row('5', '2026-08-20');
    const late = row('9', '2026-08-21', { createdAt: new Date('2026-09-15T00:00:00Z') });
    const september = row('7', '2026-09-30', { createdAt: new Date('2026-10-01T08:00:00Z') });
    const ids = (now: string) => releasedSurveyRows([august, late, september], new Date(now)).map(r => r.id);
    expect(ids('2026-09-14T23:59:59Z')).toEqual([]);
    expect(ids('2026-09-15T00:00:00Z')).toEqual([august.id]);
    expect(ids('2026-10-15T00:00:00Z')).toEqual([august.id, september.id]);
  });

  it('give an aggregate that a later submission does not change (no differencing)', () => {
    const incomes = [1200, 1500, 900, 2000, 1100, 1300, 1700, 1000].map((v, i) => row(String(v), `2026-08-0${i + 1}`));
    const before = toDonorSurveyAggregates(incomes, () => 'ILS', NOW);
    expect(before).toEqual([{
      indicatorId: 'ind-1', period: '2026-08', aggregation: 'mean', value: 1337.5,
      submissions: { key: null, count: 10, suppressed: false }, numericAnswers: { key: null, count: 10, suppressed: false },
    }]);
    // A ninth household's answer for August, received after the release: the published figure stays as it was.
    const ninth = row('2450', '2026-08-20', { createdAt: new Date('2026-10-13T08:00:00Z') });
    expect(toDonorSurveyAggregates([...incomes, ninth], () => 'ILS', NOW)).toEqual(before);
    // The current month is not published at all while submissions arrive.
    const october = ['3000', '2800', '2600', '2400', '2200', '2000', '1800', '1600'].map((v, i) => row(v, `2026-10-0${i + 1}`));
    expect(toDonorSurveyAggregates([...incomes, ...october], () => 'ILS', NOW)).toEqual(before);
  });

  it('become one aggregate per indicator and month, with the rules for counts', () => {
    const rows = [
      ...['3', '4', '5', '2', '6', '1'].map((v, i) => row(v, `2026-03-0${i + 1}`)), // 6 answers, sum 21
      ...['7', '8'].map((v, i) => row(v, `2026-04-0${i + 1}`)), // 2 answers: hidden
      ...['1', '1', '0', '0', '0', '0', '0'].map((v, i) => row(v, `2026-05-0${i + 1}`, { indicatorId: 'ind-2' })), // 2 yes of 7
    ];
    const units: Record<string, string> = { 'ind-1': 'number', 'ind-2': 'percent' };
    expect(toDonorSurveyAggregates(rows, id => units[id], NOW)).toEqual([
      {
        indicatorId: 'ind-1', period: '2026-03', aggregation: 'sum', value: 20,
        submissions: { key: null, count: 5, suppressed: false }, numericAnswers: { key: null, count: 5, suppressed: false },
      },
      {
        indicatorId: 'ind-1', period: '2026-04', aggregation: 'sum', value: null,
        submissions: { key: null, count: null, suppressed: true }, numericAnswers: { key: null, count: null, suppressed: true },
      },
      // Yes/no answers are counted, never shown as a share: 2 yes answers is a small count, hidden.
      {
        indicatorId: 'ind-2', period: '2026-05', aggregation: 'yes_count', value: null,
        submissions: { key: null, count: 5, suppressed: false }, numericAnswers: { key: null, count: 5, suppressed: false },
      },
    ]);
  });

  it('give a mean, to one decimal place, of 8 answers or more for other units, and nothing when no answer is a number', () => {
    const scores = ['2', '3', '3', '4', '5', '4', '2', '3'].map((v, i) => row(v, `2026-06-0${i + 1}`));
    expect(toDonorSurveyAggregates(scores, () => 'score', NOW)[0]).toMatchObject({ aggregation: 'mean', value: 3.3 });
    // 7 answers or fewer: no mean (HESA's rule for averages).
    expect(toDonorSurveyAggregates(scores.slice(0, 7), () => 'score', NOW)[0]).toMatchObject({ aggregation: 'mean', value: null, submissions: { count: 5 } });
    const words = ['good', 'bad', 'good', 'good', 'bad'].map((v, i) => row(v, `2026-06-0${i + 1}`));
    expect(toDonorSurveyAggregates(words, () => 'score', NOW)[0]).toMatchObject({ value: null, numericAnswers: { count: 0, suppressed: false } });
    const yes = ['yes', 'Yes', 'no', 'نعم', 'yes', 'لا', 'yes'].map((v, i) => row(v, `2026-07-0${i + 1}`));
    expect(toDonorSurveyAggregates(yes, () => null, NOW)[0]).toMatchObject({ aggregation: 'yes_count', value: 5 });
  });

  it('never reach donors one by one; results staff enter do, survey results included', () => {
    const staffSurvey = { ...dataPointRow, id: 'staff-2', value: '62', collectionMethod: 'hh_survey' as const, dataSource: 'Endline household survey (n=420)' };
    const rows = [row('12', '2026-03-01'), row('14', '2026-03-02'), { ...dataPointRow, id: 'staff-1', geographicArea: 'Hebron' }, staffSurvey];
    const out = toDonorIndicatorData(rows, () => 'number', NOW);
    expect(out.dataPoints.map(dp => dp.id)).toEqual(['staff-1', 'staff-2']);
    expect(out.surveyAggregates).toHaveLength(1);
    expect(JSON.stringify(out)).not.toMatch(/"12"|"14"|dp-2026/);
  });
});

describe('assessments, reports and documents', () => {
  const assessment = {
    id: 'a-1', projectId: 'p-1', type: 'baseline' as const, status: 'delivered' as const, requestedAt: new Date('2026-02-01'),
    deliveredAt: new Date('2026-02-03'), sampleSize: 300, methodsIncluded: ['hh_survey', 'kii', { note: 'Layla Testname' }, 'Layla'],
    scopeDescription: '{"qualitativeInsights":{"beneficiaryVoices":["Layla Testname said the clinic is far"]}}', priceUsd: 5000, reportUrl: 'reports/a-1.html',
    startedAt: null,
  };

  it('assessments: an explicit field list, never the AI text, price or report location', () => {
    const out = toDonorAssessment(assessment);
    expect(Object.keys(out).sort()).toEqual([...ASSESSMENT_KEYS].sort());
    expect(out.methodsIncluded).toEqual(['hh_survey', 'kii']);
    expect(JSON.stringify(out)).not.toMatch(/Testname|Layla|5000|reports\//);
  });

  it('reports: published only, from an explicit field list', () => {
    const report = {
      id: 'r-1', projectId: 'p-1', type: 'assessment_report' as const, title: 'Baseline', donorFormat: null, fileUrl: 'reports/r-1.pdf',
      generatedAt: new Date('2026-02-03'), periodStart: null, periodEnd: null, status: 'published' as const, aiNarrative: '<p>Reviewed</p>',
    };
    expect(donorCanSeeReport(report)).toBe(true);
    expect(donorCanSeeReport({ status: 'draft' })).toBe(false);
    const out = toDonorReport(report);
    expect(Object.keys(out).sort()).toEqual([...REPORT_KEYS].sort());
    expect(JSON.stringify(out)).not.toContain('reports/r-1.pdf');
    for (const role of ['org_admin', 'platform_admin', 'me_officer']) expect(donorReportWhere({ role })).toEqual({});
    for (const user of [{ role: 'donor_viewer' }, { role: undefined }, undefined]) expect(donorReportWhere(user)).toEqual({ status: 'published' });
  });

  it('documents: no AI analysis and no uploader name', () => {
    const doc = { id: 'd-1', fileName: 'proposal.pdf', aiAnalysis: { summary: 'AI text' }, uploader: { fullName: 'Officer Testname' }, textLength: 10 };
    expect(toDonorDocument(doc)).toEqual({ id: 'd-1', fileName: 'proposal.pdf', aiAnalysis: null, uploader: null, textLength: 10 });
  });
});

describe('documents', () => {
  it('shows donors the donor-facing types only, never transcripts or "other"', () => {
    expect([...DONOR_DOCUMENT_TYPES].sort()).toEqual(['baseline_report', 'budget', 'donor_guidelines', 'logframe', 'proposal', 'theory_of_change']);
    for (const fileType of Object.values(DocumentType)) {
      expect(donorCanSeeDocument({ fileType, qualitativeSource: false })).toBe(fileType !== 'other');
      expect(donorCanSeeDocument({ fileType, qualitativeSource: true })).toBe(false);
    }
  });

  it('filters document queries for everyone but staff', () => {
    for (const role of ['org_admin', 'platform_admin', 'me_officer']) expect(donorDocumentWhere({ role })).toEqual({});
    const donorFilter = { fileType: { in: [...DONOR_DOCUMENT_TYPES] }, qualitativeSource: false };
    for (const user of [{ role: 'donor_viewer' }, { role: undefined }, { role: 'admin' }, undefined]) {
      expect(donorDocumentWhere(user)).toEqual(donorFilter);
    }
  });
});

describe('hasStaffRole', () => {
  it.each([
    ['org_admin', true], ['platform_admin', true], ['me_officer', true], ['donor_viewer', false],
    [undefined, false], ['', false], ['admin', false],
  ])('%j → %j', (role, expected) => {
    expect(hasStaffRole({ role })).toBe(expected);
  });
});
