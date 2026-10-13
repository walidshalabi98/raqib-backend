import { IndicatorLevel, KpiSuggestionRun, Prisma, SuggestionRejectReason, SuggestionStatus, UserRole } from '@prisma/client';
import { prisma } from '../src/config/prisma';
import { KPI_PROMPT_VERSION } from '../src/services/ai/prompts/kpi';
import type { IndicatorDraft, SuggestableLevel, ValidatedSuggestion } from '../src/services/kpi/types';
import { generateAccessToken } from '../src/utils/tokens';
import { buildDocumentKey, getStorage } from '../src/services/storage';

export const hasTestDatabase = !!process.env.TEST_DATABASE_URL;

if (hasTestDatabase) {
  const dbName = new URL(process.env.TEST_DATABASE_URL!).pathname;
  if (!/test/i.test(dbName)) {
    throw new Error(`TEST_DATABASE_URL must point at a disposable database whose name contains "test" (got ${dbName}). Tests delete all data.`);
  }
} else {
  console.warn('[tests] TEST_DATABASE_URL is not set; integration tests are skipped.');
}

/**
 * Deletes every row in the test database: one TRUNCATE of every public table with CASCADE, so foreign keys never
 * decide the order (KpiSuggestion → KpiSuggestionRun is NO ACTION; both are truncated in the same statement).
 */
export async function resetDatabase(): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'`;
  if (tables.length === 0) return;
  const list = tables.map(t => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE`);
}

export function bearer(user: { id: string; email: string; organizationId: string; role: UserRole; fullName: string }) {
  return `Bearer ${generateAccessToken({
    id: user.id,
    email: user.email,
    organizationId: user.organizationId,
    role: user.role,
    fullName: user.fullName,
  })}`;
}

export const PDF_BYTES = Buffer.from('%PDF-1.4\n% test document\n%%EOF\n');

/**
 * Creates an organisation with one of every project-owned resource (the indicator measures the outcome result `O1`),
 * a donor_viewer user and, for the KPI Assistant (Phase 4), a completed result-scope run on `O1` with one pending
 * suggestion whose payload is kpiSuggestionPayloadFixture(result).
 */
export async function createOrgFixture(label: string) {
  const org = await prisma.organization.create({
    data: { name: `Org ${label}`, type: 'local_ngo', country: 'Palestine', city: 'Ramallah', contactEmail: `${label}@example.org` },
  });
  const admin = await prisma.user.create({
    data: { organizationId: org.id, email: `admin-${label}@example.org`, passwordHash: 'x', fullName: `Admin ${label}`, role: 'org_admin' },
  });
  const officer = await prisma.user.create({
    data: { organizationId: org.id, email: `me-${label}@example.org`, passwordHash: 'x', fullName: `Officer ${label}`, role: 'me_officer' },
  });
  const donor = await prisma.user.create({
    data: { organizationId: org.id, email: `donor-${label}@example.org`, passwordHash: 'x', fullName: `Donor ${label}`, role: 'donor_viewer' },
  });
  const project = await prisma.project.create({
    data: {
      organizationId: org.id, name: `Project ${label}`, sector: 'education', donor: 'EU', donorType: 'eu',
      startDate: new Date('2026-01-01'), endDate: new Date('2027-12-31'),
    },
  });
  const framework = await prisma.framework.create({ data: { projectId: project.id, version: 1 } });
  const result = await prisma.resultNode.create({
    data: { frameworkId: framework.id, level: 'outcome', code: 'O1', text: `Outcome ${label}` },
  });
  const indicator = await prisma.indicator.create({
    data: {
      frameworkId: framework.id, resultId: result.id, indicatorText: `Indicator ${label}`, level: 'outcome',
      dataCollectionMethod: 'hh_survey', frequency: 'quarterly', phases: ['baseline', 'endline'],
    },
  });
  const assessment = await prisma.assessment.create({ data: { projectId: project.id, type: 'baseline', methodsIncluded: ['hh_survey'] } });
  const dataPoint = await prisma.dataPoint.create({
    data: {
      indicatorId: indicator.id, projectId: project.id, value: '10', collectionDate: new Date('2026-03-01'),
      collectionMethod: 'hh_survey', createdBy: officer.id,
    },
  });
  const qualitative = await prisma.qualitativeEntry.create({
    data: { projectId: project.id, entryType: 'field_notes', title: `Notes ${label}`, content: 'Field notes' },
  });
  const report = await prisma.report.create({ data: { projectId: project.id, type: 'quarterly_summary', title: `Report ${label}` } });
  const beneficiary = await prisma.beneficiary.create({ data: { projectId: project.id, fullName: `Person ${label}`, gender: 'female' } });

  const documentKey = buildDocumentKey(project.id, 'proposal.pdf');
  await getStorage().put(documentKey, PDF_BYTES, 'application/pdf');
  const document = await prisma.document.create({
    data: {
      projectId: project.id, uploadedBy: officer.id, fileName: 'proposal.pdf', fileUrl: documentKey,
      fileType: 'proposal', fileSizeBytes: PDF_BYTES.length,
    },
  });

  const kpiRun = await createKpiRunRow({ projectId: project.id, frameworkId: framework.id, resultId: result.id, requestedBy: officer.id });
  const kpiSuggestion = await createKpiSuggestionRow({
    run: kpiRun, suggestion: kpiValidatedSuggestionFixture(result, { startDate: project.startDate, endDate: project.endDate }),
  });

  return {
    org, admin, officer, donor, project, framework, result, indicator, assessment, dataPoint, qualitative, report, beneficiary, document,
    kpiRun, kpiSuggestion,
    adminAuth: bearer(admin),
    officerAuth: bearer(officer),
    donorAuth: bearer(donor),
  };
}

export type OrgFixture = Awaited<ReturnType<typeof createOrgFixture>>;

// ------------------------------------------------------------------ KPI Assistant fixtures (Phase 4, design section 7.5)

/** Model id stored on fixture runs and suggestions (CLAUDE.md: AI_MODEL_MAIN default). */
export const KPI_FIXTURE_MODEL = 'claude-sonnet-5-5';

const TO_BE_CONFIRMED = 'To be confirmed by the M&E officer';
const FIXTURE_BASELINE_METHOD = `${TO_BE_CONFIRMED}. Baseline date: to be confirmed.`;
const FIXTURE_TARGET_METHOD = 'Proposed method: baseline + 10 percentage points — confirm after baseline.';

const ymd = (date: Date) => date.toISOString().slice(0, 10);

/**
 * A well-formed ValidatedSuggestion for `result` (src/services/kpi/types.ts), built directly as an object (no
 * validation code runs): a custom percent indicator with a target-setting method, no document values, an info
 * warning and a draft that passes parseIndicatorCreate. Made-up text, no personal data. `dates` are the project
 * dates (YYYY-MM-DD strings or Dates; default the createOrgFixture project dates); `overrides` replace fields.
 */
export function kpiValidatedSuggestionFixture(
  result: { id: string; code: string; level: IndicatorLevel },
  dates: { startDate: Date | string | null; endDate: Date | string | null } = { startDate: '2026-01-01', endDate: '2027-12-31' },
  overrides: Partial<ValidatedSuggestion> = {},
): ValidatedSuggestion {
  const level = (result.level === 'activity' ? 'output' : result.level) as SuggestableLevel;
  const asYmd = (d: Date | string | null) => (d instanceof Date ? ymd(d) : d);
  const name = 'Percentage of trained teachers applying learner-centred methods in observed lessons';
  const nameAr = 'نسبة المعلمين المدرَّبين الذين يطبقون أساليب التعلم المتمحور حول المتعلم في الحصص الصفية التي تمت ملاحظتها';
  const definition = 'Share of trained teachers who apply the learner-centred practices of the observation checklist during an observed lesson.';
  const numerator = 'Number of observed trained teachers applying learner-centred methods';
  const denominator = 'Number of trained teachers observed';
  const meansOfVerification = 'Classroom observation checklist completed by the project education officers';
  const rationale = 'Measures whether the training changes teaching practice, which this outcome is about. Observation suits a school setting with limited access.';
  const targetJustification = `${FIXTURE_TARGET_METHOD} Intermediate targets: to be confirmed after the baseline.`;
  const draft: IndicatorDraft = {
    indicatorText: name,
    indicatorTextAr: nameAr,
    level,
    resultId: result.id,
    libraryId: null,
    standardReferenceCode: null,
    definition,
    unit: 'percent',
    calculation: { numerator, denominator, formula: 'numerator ÷ denominator × 100', rounding: TO_BE_CONFIRMED },
    direction: 'increase',
    disaggregation: ['sex', 'location'],
    dataCollectionMethod: 'observation',
    frequency: 'biannual',
    meansOfVerification,
    baselineValue: null,
    baselineDate: null,
    baselineMethod: FIXTURE_BASELINE_METHOD,
    targetValue: null,
    targetJustification,
    intermediateTargets: [],
    assumptions: TO_BE_CONFIRMED,
    responsibility: TO_BE_CONFIRMED,
    startDate: asYmd(dates.startDate),
    endDate: asYmd(dates.endDate),
    aiRationale: rationale,
  };
  return {
    resultId: result.id,
    resultCode: result.code,
    level,
    libraryId: null,
    isCustom: true,
    customReason: 'No library indicator measures classroom teaching practice.',
    name,
    nameAr,
    definition,
    unit: 'percent',
    numerator,
    denominator,
    direction: 'increase',
    disaggregation: ['sex', 'location'],
    method: 'observation',
    frequency: 'biannual',
    meansOfVerification,
    baselineSuggestion: '',
    baselineBasis: 'none',
    baselineMethod: FIXTURE_BASELINE_METHOD,
    targetSuggestion: FIXTURE_TARGET_METHOD,
    targetBasis: 'method_only',
    targetJustification,
    standardReferenceCode: null,
    rationale,
    qualityNotes: [],
    confidence: 'medium',
    sources: { baseline: null, target: null },
    origin: 'model',
    rank: 1,
    qualityScore: 100,
    qualityBand: 'strong',
    warnings: [{
      code: 'sex_added', severity: 'info', message: 'Sex disaggregation added because the indicator counts people.', params: {}, penalty: 0,
    }],
    draft,
    ...overrides,
  };
}

/** What KpiSuggestion.payload stores: the ValidatedSuggestion without warnings, qualityScore and qualityBand (columns). */
export type KpiSuggestionPayloadFixture = Omit<ValidatedSuggestion, 'warnings' | 'qualityScore' | 'qualityBand'>;

/** The stored payload of kpiValidatedSuggestionFixture(result, dates, overrides) (design section 4.5, persistence). */
export function kpiSuggestionPayloadFixture(
  result: { id: string; code: string; level: IndicatorLevel },
  dates?: { startDate: Date | string | null; endDate: Date | string | null },
  overrides: Partial<ValidatedSuggestion> = {},
): KpiSuggestionPayloadFixture {
  const { warnings: _w, qualityScore: _s, qualityBand: _b, ...payload } = kpiValidatedSuggestionFixture(result, dates, overrides);
  return payload;
}

/** A KpiSuggestionRun row (default: a completed result-scope run with one suggestion, keyword retrieval, kpi-v1). */
export async function createKpiRunRow(input: {
  projectId: string; frameworkId: string; resultId?: string | null; requestedBy?: string | null;
  data?: Partial<Prisma.KpiSuggestionRunUncheckedCreateInput>;
}): Promise<KpiSuggestionRun> {
  const finishedAt = new Date();
  return prisma.kpiSuggestionRun.create({
    data: {
      projectId: input.projectId,
      frameworkId: input.frameworkId,
      scope: input.resultId ? 'result' : 'framework',
      resultId: input.resultId ?? null,
      status: 'completed',
      step: 'done',
      suggestionCount: 1,
      retrieval: 'keyword',
      model: KPI_FIXTURE_MODEL,
      promptVersion: KPI_PROMPT_VERSION,
      modelCalls: 1,
      requestedBy: input.requestedBy ?? null,
      finishedAt,
      ...input.data,
    },
  });
}

/**
 * A KpiSuggestion row whose columns match `suggestion` (payload without warnings/qualityScore/qualityBand,
 * sortOrder = rank). Pending by default; pass `decision` for decided rows (feedback history, e.g. preferences tests).
 */
export async function createKpiSuggestionRow(input: {
  run: Pick<KpiSuggestionRun, 'id' | 'projectId' | 'frameworkId'>;
  suggestion: ValidatedSuggestion;
  status?: SuggestionStatus;
  decision?: { decidedAt?: Date; decidedBy?: string | null; rejectReason?: SuggestionRejectReason | null; rejectNote?: string | null; indicatorId?: string | null };
  data?: Partial<Prisma.KpiSuggestionUncheckedCreateInput>;
}) {
  const { warnings, qualityScore, qualityBand: _band, ...payload } = input.suggestion;
  const status = input.status ?? 'pending';
  return prisma.kpiSuggestion.create({
    data: {
      projectId: input.run.projectId,
      frameworkId: input.run.frameworkId,
      runId: input.run.id,
      resultId: input.suggestion.resultId,
      level: input.suggestion.level,
      sortOrder: input.suggestion.rank,
      payload: payload as unknown as Prisma.InputJsonValue,
      qualityScore,
      warnings: warnings as unknown as Prisma.InputJsonValue,
      libraryId: input.suggestion.libraryId,
      isCustom: input.suggestion.isCustom,
      method: input.suggestion.method,
      status,
      model: KPI_FIXTURE_MODEL,
      promptVersion: KPI_PROMPT_VERSION,
      ...(status === 'pending' ? {} : {
        decidedAt: input.decision?.decidedAt ?? new Date(),
        decidedBy: input.decision?.decidedBy ?? null,
        rejectReason: input.decision?.rejectReason ?? null,
        rejectNote: input.decision?.rejectNote ?? null,
        indicatorId: input.decision?.indicatorId ?? null,
      }),
      ...input.data,
    },
  });
}

async function createKpiProject(fx: OrgFixture, label: string) {
  return prisma.project.create({
    data: {
      organizationId: fx.org.id, name: `Project ${label}`, sector: 'education', donor: 'EU', donorType: 'eu',
      startDate: new Date('2026-01-01'), endDate: new Date('2027-12-31'),
    },
  });
}

/** A framework version of `project` with an outcome result O1. */
async function createKpiFramework(projectId: string, version: number, label: string) {
  const framework = await prisma.framework.create({ data: { projectId, version } });
  const result = await prisma.resultNode.create({
    data: { frameworkId: framework.id, level: 'outcome', code: 'O1', text: `Outcome ${label}` },
  });
  return { framework, result };
}

/** A framework version with O1, an indicator on it and a completed result-scope run with one pending suggestion. */
async function createKpiFrameworkWithSuggestion(fx: OrgFixture, project: { id: string; startDate: Date; endDate: Date }, version: number, label: string) {
  const { framework, result } = await createKpiFramework(project.id, version, label);
  const indicator = await prisma.indicator.create({
    data: {
      frameworkId: framework.id, resultId: result.id, indicatorText: `Indicator ${label}`, level: 'outcome',
      dataCollectionMethod: 'hh_survey', frequency: 'quarterly', phases: ['baseline', 'endline'],
    },
  });
  const kpiRun = await createKpiRunRow({ projectId: project.id, frameworkId: framework.id, resultId: result.id, requestedBy: fx.officer.id });
  const kpiSuggestion = await createKpiSuggestionRow({
    run: kpiRun, suggestion: kpiValidatedSuggestionFixture(result, { startDate: project.startDate, endDate: project.endDate }),
  });
  return { framework, result, indicator, kpiRun, kpiSuggestion };
}

/**
 * Extra KPI fixtures for one organisation (KPI, isolation and visibility tests only, so tests that count projects or
 * frameworks are unaffected): project A2 with its own framework, result O1, indicator and pending suggestion; project
 * A3 whose framework v1 (result O1, indicator, pending suggestion) is followed by a current v2 (result O1); and, in
 * the main fixture framework, an indicator that is not linked to a result (422 not_suggestable).
 */
export async function createKpiFixtures(fx: OrgFixture) {
  const a2Project = await createKpiProject(fx, `${fx.org.name} A2`);
  const a2 = await createKpiFrameworkWithSuggestion(fx, a2Project, 1, 'A2');

  const a3Project = await createKpiProject(fx, `${fx.org.name} A3`);
  const v1 = await createKpiFrameworkWithSuggestion(fx, a3Project, 1, 'A3 v1');
  const v2 = await createKpiFramework(a3Project.id, 2, 'A3 v2');

  const unlinkedIndicator = await prisma.indicator.create({
    data: {
      frameworkId: fx.framework.id, resultId: null, indicatorText: 'Indicator without a result', level: 'output',
      dataCollectionMethod: 'document_review', frequency: 'quarterly', phases: ['baseline', 'endline'],
    },
  });

  return {
    a2: { project: a2Project, ...a2 },
    a3: { project: a3Project, v1, v2 },
    unlinkedIndicator,
  };
}

export type KpiFixtures = Awaited<ReturnType<typeof createKpiFixtures>>;
