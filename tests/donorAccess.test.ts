import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { loadBeneficiaryAggregates } from '../src/services/beneficiaries/donorSummary';
import { OTHER_KEY } from '../src/services/privacy/disclosure';
import { DONOR_PLACES } from '../src/services/privacy/places';
import { buildDocumentKey, getStorage } from '../src/services/storage';
import { generateResetToken } from '../src/utils/tokens';
import { createOrgFixture, hasTestDatabase, OrgFixture, PDF_BYTES, resetDatabase } from './helpers';
import { ROLE_MATRIX } from './roleMatrix';

/**
 * Donor viewers get results, never identities (docs/SECURITY_SETUP.md §8). The fixture holds made-up
 * personal data; no donor-readable response may contain any of it.
 */

const GPS = '31.531234, 35.095678';
/** Every made-up personal value in the fixture, matched without regard to case (field staff names included). */
const PERSONAL_VALUES = [
  'Person a', 'Testperson', 'رشا اختبار', '0599123456', '401234567', 'Wadi Testvillage house 12', 'Testvillage',
  'Visited at home', 'spouse present', 'testdescription', 'Testname', '31.531234', '35.095678', 'KII_Layla', 'register_testvillage',
  'Officer a', 'Beit Ummar', '31.5401',
];
/** Names donors may see as an area: the listed places. */
const LISTED_PLACES = new Set(DONOR_PLACES.flatMap(p => [p.en, p.ar]));
const FORBIDDEN_KEYS = new Set([
  'fullNameAr', 'phoneNumber', 'nationalId', 'householdSize', 'vulnerabilityTags', 'registrationDate',
  'facilitator', 'content', 'attachments', 'age', 'beneficiaries',
]);
const DATA_POINT_STAFF_KEYS = ['notes', 'attachments', 'createdBy', 'creator'];
const QUALITATIVE_KEYS = ['id', 'projectId', 'assessmentId', 'entryType', 'monthConducted', 'participants'];
const ASSESSMENT_KEYS = ['id', 'projectId', 'type', 'status', 'requestedAt', 'deliveredAt', 'sampleSize', 'methodsIncluded'];
/** The AI assessment as the generator stores it: written from transcript excerpts, here with a name the model let through. */
const AI_ASSESSMENT = JSON.stringify({
  executiveSummary: 'Access to services is limited.',
  qualitativeInsights: { beneficiaryVoices: ['Layla, a widow in Wadi Testvillage, said the clinic is too far (Layla Testname)'] },
  keyFindings: [{ finding: 'Distance', evidence: 'KII with Layla Testname' }],
});

function personalValuesIn(body: unknown): string[] {
  const text = JSON.stringify(body).toLowerCase();
  return PERSONAL_VALUES.filter(value => text.includes(value.toLowerCase()));
}

function keysIn(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach(item => keysIn(item, found));
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      found.add(key);
      keysIn(inner, found);
    }
  }
  return found;
}

const forbiddenKeysIn = (body: unknown) => [...keysIn(body)].filter(key => FORBIDDEN_KEYS.has(key));

async function storeFile(projectId: string, name: string) {
  const key = buildDocumentKey(projectId, name);
  await getStorage().put(key, PDF_BYTES, 'application/octet-stream');
  return key;
}

/** Adds made-up personal data to organisation A: project A then has 12 beneficiaries (9 female, 3 male). */
async function seedPersonalData(fx: OrgFixture) {
  const projectId = fx.project.id;
  const rasha = await prisma.beneficiary.create({
    data: {
      projectId, fullName: 'Rasha Testperson', fullNameAr: 'رشا اختبار', gender: 'female', age: 34, ageGroup: 'adult_25_59',
      location: 'Wadi Testvillage house 12', governorate: 'Testvillage', phoneNumber: '0599123456', nationalId: '401234567',
      householdSize: 6, vulnerabilityTags: ['disabled'],
    },
  });
  const service = await prisma.beneficiaryService.create({
    data: {
      beneficiaryId: rasha.id, projectId, serviceType: 'home_visit', description: 'Home visit testdescription',
      notes: 'Visited at home; spouse present', dateProvided: new Date('2026-03-10'),
    },
  });
  for (let i = 1; i <= 10; i++) {
    await prisma.beneficiary.create({
      data: {
        projectId, fullName: `${i <= 7 ? 'Fatima' : 'Omar'} Testperson ${i}`, gender: i <= 7 ? 'female' : 'male',
        ageGroup: 'adult_25_59', governorate: 'Hebron', phoneNumber: `05991000${String(i).padStart(2, '0')}`,
      },
    });
  }

  const transcript = await prisma.document.create({
    data: {
      projectId, uploadedBy: fx.officer.id, fileName: 'KII_Layla_Testname.docx', fileUrl: await storeFile(projectId, 'KII_Layla_Testname.docx'),
      fileType: 'other', qualitativeSource: true, fileSizeBytes: PDF_BYTES.length,
    },
  });
  const register = await prisma.document.create({
    data: {
      projectId, uploadedBy: fx.officer.id, fileName: 'register_testvillage.xlsx', fileUrl: await storeFile(projectId, 'register_testvillage.xlsx'),
      fileType: 'other', fileSizeBytes: PDF_BYTES.length,
    },
  });

  const interview = await prisma.qualitativeEntry.create({
    data: {
      projectId, entryType: 'kii_notes', title: 'KII with Layla Testname', content: 'Participant Layla Testname said the clinic is far.',
      participants: 1, location: GPS, dateConducted: new Date('2026-03-14'), facilitator: 'Facilitator Testname',
      attachments: [{ documentId: transcript.id, fileName: 'KII_Layla_Testname.docx' }], themes: ['access to services'], sentiment: 'negative',
    },
  });

  // Household-survey results staff entered (one survey round each): indicator values, passed to donors without
  // notes, attachments or unlisted areas.
  const gpsPoint = await prisma.dataPoint.create({
    data: {
      indicatorId: fx.indicator.id, projectId, value: '12', collectionDate: new Date('2026-04-01'), collectionMethod: 'hh_survey',
      geographicArea: GPS, notes: 'Respondent Layla Testname', attachments: [{ fileName: 'photo_Layla_Testname.jpg' }],
      breakdown: { sex: { female: 6, male: 4 } }, createdBy: fx.officer.id,
    },
  });
  const hebronPoint = await prisma.dataPoint.create({
    data: {
      indicatorId: fx.indicator.id, projectId, value: '14', collectionDate: new Date('2026-05-01'), collectionMethod: 'hh_survey',
      geographicArea: 'Hebron', createdBy: fx.officer.id,
    },
  });
  // Results entered by staff from other sources: passed to donors (listed areas only).
  const recordsPoint = await prisma.dataPoint.create({
    data: {
      indicatorId: fx.indicator.id, projectId, value: '20', collectionDate: new Date('2026-06-01'), collectionMethod: 'secondary_data',
      dataSource: 'Ministry records', geographicArea: 'Beit Ummar', createdBy: fx.officer.id,
    },
  });
  const reviewPoint = await prisma.dataPoint.create({
    data: {
      indicatorId: fx.indicator.id, projectId, value: '25', collectionDate: new Date('2026-07-01'), collectionMethod: 'document_review',
      geographicArea: 'Hebron', breakdown: { sex: { female: 13, male: 12 } }, createdBy: fx.officer.id,
    },
  });
  // Eight KoboToolbox submissions in August, received the same day (one household each, exact GPS): donors get
  // one monthly aggregate, published on 15 September.
  for (let i = 1; i <= 8; i++) {
    await prisma.dataPoint.create({
      data: {
        indicatorId: fx.indicator.id, projectId, value: String(i), collectionDate: new Date(`2026-08-0${i}`), collectionMethod: 'hh_survey',
        dataSource: 'KoboToolbox', geographicArea: `31.5401${i}, 35.0956${i}`, createdBy: fx.officer.id, createdAt: new Date(`2026-08-0${i}T15:00:00Z`),
      },
    });
  }
  // Notifications go to the people they are about; this one is the donor's own ('self' route).
  await prisma.notification.create({
    data: { userId: fx.donor.id, type: 'report_generated', title: 'Q1 summary published', message: 'The Q1 summary is ready to read.' },
  });

  // AI output drawn from transcripts: the assessment JSON, its draft report, and the AI analysis of a proposal.
  const aiAssessment = await prisma.assessment.create({
    data: {
      projectId, type: 'baseline', status: 'delivered', methodsIncluded: ['hh_survey', 'kii'], sampleSize: 300,
      scopeDescription: AI_ASSESSMENT, priceUsd: 5000, reportUrl: 'reports/testname.html', deliveredAt: new Date('2026-03-20'),
    },
  });
  const draftReport = await prisma.report.create({
    data: {
      projectId, type: 'assessment_report', title: 'Baseline assessment', status: 'draft',
      aiNarrative: '<h2>Beneficiary Voices</h2><p>Layla Testname said the clinic is too far.</p>',
    },
  });
  const publishedReport = await prisma.report.create({
    data: { projectId, type: 'quarterly_summary', title: 'Q1 summary', status: 'published', aiNarrative: '<p>Reviewed narrative</p>' },
  });
  await prisma.document.update({ where: { id: fx.document.id }, data: { aiAnalysis: { summary: 'Proposal reviewed with Layla Testname' } } });

  return { rasha, service, transcript, register, interview, gpsPoint, hebronPoint, recordsPoint, reviewPoint, aiAssessment, draftReport, publishedReport };
}

type Seeded = OrgFixture & Awaited<ReturnType<typeof seedPersonalData>>;

/** A request path for every GET route a donor viewer can call (ROLE_MATRIX 'all' and 'self'). */
const DONOR_GET_PATHS: Record<string, (f: Seeded) => string> = {
  'get /api/notifications/': () => '/api/notifications',
  'get /api/organizations/:id': f => `/api/organizations/${f.org.id}`,
  'get /api/projects/': () => '/api/projects',
  'get /api/projects/:id': f => `/api/projects/${f.project.id}`,
  'get /api/projects/:id/export': f => `/api/projects/${f.project.id}/export`,
  'get /api/projects/:id/documents': f => `/api/projects/${f.project.id}/documents`,
  'get /api/documents/:id/download': f => `/api/documents/${f.document.id}/download`,
  'get /api/documents/:id/status': f => `/api/documents/${f.document.id}/status`,
  'get /api/projects/:id/framework': f => `/api/projects/${f.project.id}/framework`,
  'get /api/frameworks/:id/status': f => `/api/frameworks/${f.framework.id}/status`,
  'get /api/frameworks/:id/indicators': f => `/api/frameworks/${f.framework.id}/indicators`,
  'get /api/frameworks/:id/results': f => `/api/frameworks/${f.framework.id}/results`,
  'get /api/projects/:id/assessments': f => `/api/projects/${f.project.id}/assessments`,
  'get /api/assessments/:id/report': f => `/api/assessments/${f.aiAssessment.id}/report`,
  'get /api/assessments/:id/estimate': f => `/api/assessments/${f.assessment.id}/estimate`,
  'get /api/indicators/:id/data': f => `/api/indicators/${f.indicator.id}/data`,
  'get /api/projects/:id/qualitative': f => `/api/projects/${f.project.id}/qualitative`,
  'get /api/qualitative/:id': f => `/api/qualitative/${f.interview.id}`,
  'get /api/projects/:id/reports': f => `/api/projects/${f.project.id}/reports`,
  'get /api/reports/:id': f => `/api/reports/${f.draftReport.id}`,
  'get /api/reports/:id/status': f => `/api/reports/${f.draftReport.id}/status`,
  'get /api/dashboard/projects/:id/dashboard': f => `/api/dashboard/projects/${f.project.id}/dashboard`,
  'get /api/dashboard/overview': () => '/api/dashboard/overview',
  'get /api/templates/': () => '/api/templates',
  'get /api/projects/:id/beneficiaries/stats': f => `/api/projects/${f.project.id}/beneficiaries/stats`,
  'get /api/projects/:id/export/indicators': f => `/api/projects/${f.project.id}/export/indicators`,
  'get /api/indicator-library/': () => '/api/indicator-library',
  'get /api/indicator-library/:id': () => '/api/indicator-library/NOT-A-LIBRARY-ID',
};

describe('donor-readable routes', () => {
  it("cover every GET route open to all signed-in roles or to the caller's own records", () => {
    const open = Object.entries(ROLE_MATRIX)
      .filter(([key, access]) => (access === 'all' || access === 'self') && key.startsWith('get '))
      .map(([key]) => key);
    expect(Object.keys(DONOR_GET_PATHS).sort()).toEqual(open.sort());
  });
});

describe.skipIf(!hasTestDatabase)('donor viewers: results without identities', () => {
  let a: Seeded;
  let b: OrgFixture;

  beforeAll(async () => {
    await resetDatabase();
    const fixture = await createOrgFixture('a');
    a = { ...fixture, ...(await seedPersonalData(fixture)) };
    b = await createOrgFixture('b');
  });

  it.each(Object.keys(DONOR_GET_PATHS).map(key => [key]))('%s holds no personal data for a donor viewer', async key => {
    const res = await request(app).get(DONOR_GET_PATHS[key](a)).set('Authorization', a.donorAuth);
    expect([200, 404]).toContain(res.status);
    expect(personalValuesIn(res.body)).toEqual([]);
    expect(forbiddenKeysIn(res.body)).toEqual([]);
  });

  it('the fixture really holds the personal data (the officer sees it)', async () => {
    const res = await request(app).get(`/api/projects/${a.project.id}/export`).set('Authorization', a.officerAuth);
    expect(personalValuesIn(res.body)).toEqual(expect.arrayContaining(['Testperson', '0599123456', '401234567', 'Testname', '31.531234']));
  });

  describe('project export', () => {
    it('gives donors results and a beneficiary summary, never beneficiaries', async () => {
      const res = await request(app).get(`/api/projects/${a.project.id}/export`).set('Authorization', a.donorAuth);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ audience: 'donor', personalData: 'excluded' });
      expect(res.body).not.toHaveProperty('beneficiaries');
      expect(Object.keys(res.body).sort()).toEqual(
        ['assessments', 'audience', 'beneficiarySummary', 'exportedAt', 'frameworks', 'indicators', 'personalData', 'project', 'qualitativeEntries'],
      );
      expect(res.body.beneficiarySummary).toMatchObject({ audience: 'donor', roundingBase: 5, total: { key: null, count: 10, suppressed: false } });

      for (const entry of res.body.qualitativeEntries) expect(Object.keys(entry).sort()).toEqual([...QUALITATIVE_KEYS].sort());
      const interview = res.body.qualitativeEntries.find((e: { id: string }) => e.id === a.interview.id);
      expect(interview).toEqual({ id: a.interview.id, projectId: a.project.id, assessmentId: null, entryType: 'kii_notes', monthConducted: '2026-03', participants: 1 });

      // Assessments from an explicit field list: never the AI text, the price or the report location.
      for (const assessment of res.body.assessments) expect(Object.keys(assessment).sort()).toEqual([...ASSESSMENT_KEYS].sort());
      expect(res.body.assessments.find((x: { id: string }) => x.id === a.aiAssessment.id)).toMatchObject({ status: 'delivered', sampleSize: 300, methodsIncluded: ['hh_survey', 'kii'] });

      // Staff-entered results pass (listed areas only, survey results included); KoboToolbox rows only as monthly aggregates.
      const [indicator] = res.body.indicators;
      expect(indicator.dataPoints.map((p: { id: string }) => p.id)).toEqual([a.reviewPoint.id, a.recordsPoint.id, a.hebronPoint.id, a.gpsPoint.id, a.dataPoint.id]);
      for (const point of indicator.dataPoints) for (const key of DATA_POINT_STAFF_KEYS) expect(point).not.toHaveProperty(key);
      expect(indicator.dataPoints[0]).toMatchObject({ geographicArea: 'Hebron', breakdown: { sex: { female: 13, male: 12 } } });
      expect(indicator.dataPoints[1]).toMatchObject({ geographicArea: null });
      expect(indicator.dataPoints[3]).toMatchObject({ value: '12', geographicArea: null, breakdown: { sex: { female: 6, male: 4 } } });
      expect(indicator.surveyAggregates).toEqual([{
        indicatorId: a.indicator.id, period: '2026-08', aggregation: 'mean', value: 4.5,
        submissions: { key: null, count: 10, suppressed: false }, numericAnswers: { key: null, count: 10, suppressed: false },
      }]);
      // Project, frameworks and indicator reference sheets are the same as staff get.
      const staff = await request(app).get(`/api/projects/${a.project.id}/export`).set('Authorization', a.officerAuth);
      expect(res.body.project).toEqual(staff.body.project);
      expect(res.body.frameworks).toEqual(staff.body.frameworks);
      expect(res.body.indicators.map((i: { indicatorText: string }) => i.indicatorText)).toEqual(staff.body.indicators.map((i: { indicatorText: string }) => i.indicatorText));
    });

    it('still gives staff everything, as before', async () => {
      const res = await request(app).get(`/api/projects/${a.project.id}/export`).set('Authorization', a.officerAuth);
      expect(res.status).toBe(200);
      expect(res.body.audience).toBe('staff');
      expect(res.body).not.toHaveProperty('beneficiarySummary');
      expect(res.body.beneficiaries).toHaveLength(12);
      const rasha = res.body.beneficiaries.find((x: { id: string }) => x.id === a.rasha.id);
      expect(rasha).toMatchObject({ phoneNumber: '0599123456', nationalId: '401234567', fullNameAr: 'رشا اختبار' });
      expect(rasha.services[0]).toMatchObject({ notes: 'Visited at home; spouse present' });
      const interview = res.body.qualitativeEntries.find((e: { id: string }) => e.id === a.interview.id);
      expect(interview.content).toContain('Layla Testname');
      const gps = res.body.indicators.flatMap((i: { dataPoints: { id: string }[] }) => i.dataPoints).find((p: { id: string }) => p.id === a.gpsPoint.id);
      expect(gps).toMatchObject({ geographicArea: GPS, notes: 'Respondent Layla Testname' });
      expect(res.body.indicators[0].dataPoints).toHaveLength(13);
      expect(res.body.indicators[0]).not.toHaveProperty('surveyAggregates');
      expect(res.body.assessments.find((x: { id: string }) => x.id === a.aiAssessment.id).scopeDescription).toBe(AI_ASSESSMENT);
    });

    it('stays organisation-scoped for donor viewers', async () => {
      const res = await request(app).get(`/api/projects/${b.project.id}/export`).set('Authorization', a.donorAuth);
      expect(res.status).toBe(404);
    });
  });

  describe('closed routes', () => {
    it('refuses beneficiary records and the register CSV to donor viewers', async () => {
      for (const path of [
        `/api/projects/${a.project.id}/beneficiaries`,
        `/api/projects/${a.project.id}/beneficiaries?search=401234567`,
        `/api/beneficiaries/${a.rasha.id}`,
        `/api/projects/${a.project.id}/export/beneficiaries`,
      ]) {
        const res = await request(app).get(path).set('Authorization', a.donorAuth);
        expect(res.status, path).toBe(403);
        expect(res.body).toEqual({ message: 'Insufficient permissions' });
      }
    });

    it('leaves the data unchanged when a donor viewer tries to write', async () => {
      const before = {
        beneficiaries: await prisma.beneficiary.count({ where: { projectId: a.project.id } }),
        services: await prisma.beneficiaryService.count({ where: { projectId: a.project.id } }),
        documents: await prisma.document.count({ where: { projectId: a.project.id } }),
        qualitative: await prisma.qualitativeEntry.count({ where: { projectId: a.project.id } }),
      };

      const writes = [
        request(app).post(`/api/projects/${a.project.id}/beneficiaries`).set('Authorization', a.donorAuth).send({ fullName: 'Injected Person', gender: 'male' }),
        request(app).patch(`/api/beneficiaries/${a.rasha.id}`).set('Authorization', a.donorAuth).send({ nationalId: '999999999' }),
        request(app).post(`/api/beneficiaries/${a.rasha.id}/services`).set('Authorization', a.donorAuth).send({ serviceType: 'cash', dateProvided: '2026-04-01' }),
        request(app).delete(`/api/documents/${a.document.id}`).set('Authorization', a.donorAuth),
        request(app).post(`/api/projects/${a.project.id}/qualitative`).set('Authorization', a.donorAuth).send({ entryType: 'field_notes', title: 'x', content: 'y' }),
        request(app).post(`/api/qualitative/${a.interview.id}/code`).set('Authorization', a.donorAuth),
        request(app).post(`/api/projects/${a.project.id}/documents`).set('Authorization', a.donorAuth)
          .attach('file', PDF_BYTES, { filename: 'donor.pdf', contentType: 'application/pdf' }),
      ];
      for (const res of await Promise.all(writes)) {
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ message: 'Insufficient permissions' });
      }

      expect(await prisma.beneficiary.count({ where: { projectId: a.project.id } })).toBe(before.beneficiaries);
      expect(await prisma.beneficiaryService.count({ where: { projectId: a.project.id } })).toBe(before.services);
      expect(await prisma.document.count({ where: { projectId: a.project.id } })).toBe(before.documents);
      expect(await prisma.qualitativeEntry.count({ where: { projectId: a.project.id } })).toBe(before.qualitative);
      expect((await prisma.beneficiary.findUniqueOrThrow({ where: { id: a.rasha.id } })).nationalId).toBe('401234567');
      const proposal = await prisma.document.findUniqueOrThrow({ where: { id: a.document.id } });
      await expect(getStorage().get(proposal.fileUrl)).resolves.toEqual(PDF_BYTES);
    });
  });

  describe('beneficiary stats', () => {
    it('gives donor viewers the summary with small counts hidden and the others rounded', async () => {
      const res = await request(app).get(`/api/projects/${a.project.id}/beneficiaries/stats`).set('Authorization', a.donorAuth);
      expect(res.status).toBe(200);
      const s = res.body;
      expect(s).toMatchObject({ audience: 'donor', minCell: 5, minCellSensitive: 10, roundingBase: 5, otherKey: OTHER_KEY, suppressedAll: false });
      // 12 people: shown as 10.
      expect(s.total).toEqual({ key: null, count: 10, suppressed: false });
      // 3 men hidden, 9 women shown as 10; parts need not add up to the total.
      expect(s.byGender).toEqual([
        { key: 'male', count: null, suppressed: true },
        { key: 'female', count: 10, suppressed: false },
        { key: 'other', count: 0, suppressed: false },
      ]);
      // 11 adults shown as 10, 1 without an age group hidden; every other group 0.
      expect(s.byAgeGroup).toEqual([
        ...['child_0_5', 'child_6_11', 'adolescent_12_17', 'youth_18_24'].map(key => ({ key, count: 0, suppressed: false })),
        { key: 'adult_25_59', count: 10, suppressed: false },
        { key: 'elderly_60_plus', count: 0, suppressed: false },
        { key: null, count: null, suppressed: true },
      ]);
      // Testvillage (1) is merged into __other__ and hidden; "not recorded" (1) hidden; Hebron 10.
      expect(s.byGovernorate).toEqual([
        { key: 'Hebron', count: 10, suppressed: false },
        { key: null, count: null, suppressed: true },
        { key: OTHER_KEY, count: null, suppressed: true },
      ]);
      expect(s.byStatus).toEqual([
        { key: 'active', count: 10, suppressed: false },
        ...['completed', 'dropped_out', 'referred'].map(key => ({ key, count: 0, suppressed: false })),
      ]);
      expect(s.byVulnerabilityTag).toEqual([{ key: OTHER_KEY, count: null, suppressed: true }]);
      expect(s.byServiceType).toEqual([{ key: OTHER_KEY, count: null, suppressed: true }]);
      expect(s.serviceCount).toEqual({ key: null, count: null, suppressed: true });
      expect([...keysIn(s)]).not.toContain('Testvillage');
      expect(JSON.stringify(s)).not.toMatch(/Testvillage|disabled|home_visit/);
    });

    it('gives staff exact counts, as before', async () => {
      const res = await request(app).get(`/api/projects/${a.project.id}/beneficiaries/stats`).set('Authorization', a.officerAuth);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ audience: 'staff', total: 12, serviceCount: 1 });
      const count = (rows: { _count: number }[], field: string, value: unknown) =>
        rows.find(row => (row as unknown as Record<string, unknown>)[field] === value)?._count;
      expect(count(res.body.byGender, 'gender', 'female')).toBe(9);
      expect(count(res.body.byGender, 'gender', 'male')).toBe(3);
      expect(count(res.body.byGovernorate, 'governorate', 'Testvillage')).toBe(1);
      expect(count(res.body.byGovernorate, 'governorate', 'Hebron')).toBe(10);
    });

    it('loads aggregates with counts only: tags once per person, distinct people per service type, trimmed areas', async () => {
      const project = await prisma.project.create({
        data: {
          organizationId: a.org.id, name: 'Aggregates project', sector: 'protection', donor: 'EU', donorType: 'eu',
          startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'),
        },
      });
      const people = [
        { gender: 'female', governorate: ' Hebron', vulnerabilityTags: ['Disabled', ' disabled ', 7, null, ''], ageGroup: 'youth_18_24' },
        { gender: 'female', governorate: 'Hebron', vulnerabilityTags: ['IDP'], ageGroup: null },
        { gender: 'male', governorate: '', vulnerabilityTags: 'disabled', ageGroup: 'youth_18_24' },
        { gender: 'other', governorate: null, vulnerabilityTags: null, ageGroup: 'adult_25_59' },
      ] as const;
      const ids: string[] = [];
      for (const p of people) {
        const row = await prisma.beneficiary.create({
          data: {
            projectId: project.id, fullName: 'Aggregate Testperson', gender: p.gender, governorate: p.governorate,
            ageGroup: p.ageGroup, vulnerabilityTags: p.vulnerabilityTags === null ? undefined : (p.vulnerabilityTags as never),
          },
        });
        ids.push(row.id);
      }
      for (const [beneficiaryId, serviceType] of [[ids[0], 'Cash'], [ids[0], ' cash '], [ids[1], 'cash'], [ids[1], 'PSS']] as const) {
        await prisma.beneficiaryService.create({ data: { beneficiaryId, projectId: project.id, serviceType, dateProvided: new Date('2026-02-01') } });
      }

      const agg = await loadBeneficiaryAggregates(project.id);
      expect(agg.total).toBe(4);
      expect(agg.serviceCount).toBe(4);
      expect(agg.byGender).toEqual([{ key: 'male', count: 1 }, { key: 'female', count: 2 }, { key: 'other', count: 1 }]);
      expect(agg.byAgeGroup).toEqual([
        { key: 'child_0_5', count: 0 }, { key: 'child_6_11', count: 0 }, { key: 'adolescent_12_17', count: 0 },
        { key: 'youth_18_24', count: 2 }, { key: 'adult_25_59', count: 1 }, { key: 'elderly_60_plus', count: 0 }, { key: null, count: 1 },
      ]);
      expect([...agg.byGovernorate].sort((x, y) => String(x.key).localeCompare(String(y.key)))).toEqual([{ key: 'Hebron', count: 2 }, { key: null, count: 2 }]);
      expect(agg.byStatus).toEqual([{ key: 'active', count: 4 }, { key: 'completed', count: 0 }, { key: 'dropped_out', count: 0 }, { key: 'referred', count: 0 }]);
      // Strings in arrays only, trimmed and lower case, once per person; a plain string is not a list of tags.
      expect([...agg.byVulnerabilityTag].sort((x, y) => String(x.key).localeCompare(String(y.key)))).toEqual([{ key: 'disabled', count: 1 }, { key: 'idp', count: 1 }]);
      expect([...agg.byServiceType].sort((x, y) => String(x.key).localeCompare(String(y.key)))).toEqual([{ key: 'cash', count: 2 }, { key: 'pss', count: 1 }]);
      expect(JSON.stringify(agg)).not.toMatch(/Testperson/);
    });

    it('hides every breakdown for a project with fewer than 5 beneficiaries', async () => {
      const small = await prisma.project.create({
        data: {
          organizationId: a.org.id, name: 'Small project', sector: 'health', donor: 'EU', donorType: 'eu',
          startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'),
        },
      });
      for (const gender of ['female', 'female', 'female'] as const) {
        await prisma.beneficiary.create({ data: { projectId: small.id, fullName: 'Small Testperson', gender } });
      }
      const res = await request(app).get(`/api/projects/${small.id}/beneficiaries/stats`).set('Authorization', a.donorAuth);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        suppressedAll: true,
        total: { key: null, count: null, suppressed: true },
        serviceCount: { key: null, count: null, suppressed: true },
        byGender: [], byAgeGroup: [], byGovernorate: [], byStatus: [], byVulnerabilityTag: [], byServiceType: [],
      });
    });
  });

  describe('documents', () => {
    it('lists donor-facing documents only, and hides the others behind 404', async () => {
      const list = await request(app).get(`/api/projects/${a.project.id}/documents`).set('Authorization', a.donorAuth);
      expect(list.status).toBe(200);
      expect(list.body.map((d: { id: string }) => d.id)).toEqual([a.document.id]);
      const project = await request(app).get(`/api/projects/${a.project.id}`).set('Authorization', a.donorAuth);
      expect(project.body.documents.map((d: { id: string }) => d.id)).toEqual([a.document.id]);

      for (const hidden of [a.transcript.id, a.register.id]) {
        for (const path of [`/api/documents/${hidden}/download`, `/api/documents/${hidden}/status`]) {
          const res = await request(app).get(path).set('Authorization', a.donorAuth);
          expect(res.status, path).toBe(404);
          expect(res.body).toEqual({ message: 'Document not found' });
        }
      }

      const proposal = await request(app).get(`/api/documents/${a.document.id}/download`).set('Authorization', a.donorAuth);
      expect(proposal.status).toBe(200);
      expect(proposal.body.url).toEqual(expect.any(String));
      expect(proposal.body.fileName).toBe('proposal.pdf');
    });

    it('still shows staff every document', async () => {
      const list = await request(app).get(`/api/projects/${a.project.id}/documents`).set('Authorization', a.officerAuth);
      expect(list.body.map((d: { id: string }) => d.id).sort()).toEqual([a.document.id, a.transcript.id, a.register.id].sort());
      const transcript = await request(app).get(`/api/documents/${a.transcript.id}/download`).set('Authorization', a.officerAuth);
      expect(transcript.status).toBe(200);
    });
  });

  describe('dashboard, data points and qualitative entries', () => {
    it('shows donor viewers recent activity without KoboToolbox rows, notes, authors or unlisted areas', async () => {
      const res = await request(app).get(`/api/dashboard/projects/${a.project.id}/dashboard`).set('Authorization', a.donorAuth);
      expect(res.status).toBe(200);
      expect(res.body.recentActivity.map((p: { id: string }) => p.id).sort())
        .toEqual([a.dataPoint.id, a.gpsPoint.id, a.hebronPoint.id, a.recordsPoint.id, a.reviewPoint.id].sort());
      for (const point of res.body.recentActivity) {
        for (const key of DATA_POINT_STAFF_KEYS) expect(point).not.toHaveProperty(key);
        expect(point.indicator).toEqual({ indicatorText: 'Indicator a' });
      }
      // Rows donors are shown one by one only: the GPS row and Beit Ummar fold into null, KoboToolbox rows are not counted.
      expect(res.body.geographic).toHaveLength(2);
      expect(res.body.geographic).toEqual(expect.arrayContaining([
        { area: 'Hebron', areaAr: 'الخليل', dataPointCount: 2 }, { area: null, areaAr: null, dataPointCount: 2 },
      ]));
      for (const group of res.body.geographic) if (group.area) expect(LISTED_PLACES.has(group.area)).toBe(true);
      const [trend] = res.body.trends;
      // Level and unit decide how the dashboard shows progress (as indicatorProgress does).
      expect(trend).toMatchObject({ level: 'outcome', unit: null });
      expect(trend.dataPoints.map((p: { value: string }) => p.value)).toEqual(['25', '20', '14', '12', '10']);
      expect(trend.surveyAggregates.map((x: { period: string }) => x.period)).toEqual(['2026-08']);

      const staff = await request(app).get(`/api/dashboard/projects/${a.project.id}/dashboard`).set('Authorization', a.officerAuth);
      expect(staff.body.geographic).toEqual(expect.arrayContaining([{ area: GPS, dataPointCount: 1 }]));
      expect(staff.body.recentActivity).toHaveLength(10);
      expect(staff.body.trends[0]).not.toHaveProperty('surveyAggregates');
    });

    it('shows donor viewers indicator data: staff-entered results, and KoboToolbox rows as monthly aggregates only', async () => {
      const res = await request(app).get(`/api/indicators/${a.indicator.id}/data`).set('Authorization', a.donorAuth);
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(5);
      expect(res.body.dataPoints.map((p: { id: string }) => p.id)).toEqual([a.dataPoint.id, a.gpsPoint.id, a.hebronPoint.id, a.recordsPoint.id, a.reviewPoint.id]);
      for (const point of res.body.dataPoints) for (const key of DATA_POINT_STAFF_KEYS) expect(point).not.toHaveProperty(key);
      expect(res.body.dataPoints[0].geographicArea).toBeNull();
      expect(res.body.surveyAggregates).toHaveLength(1);
      // Never one household's answer: the KoboToolbox values 1 to 8 do not appear one by one.
      expect(JSON.stringify(res.body)).not.toMatch(/"value":"[1-8]"/);
      // The trend from what donors see: 20 (June), 25 (July), mean 4.5 (August).
      expect(res.body.trend).toBe('decreasing');

      const staff = await request(app).get(`/api/indicators/${a.indicator.id}/data`).set('Authorization', a.officerAuth);
      expect(staff.body.count).toBe(13);
      expect(staff.body).not.toHaveProperty('surveyAggregates');
    });

    it('shows donor viewers the household-survey results staff enter, as staff see them (one row per survey round)', async () => {
      const project = await prisma.project.create({
        data: {
          organizationId: a.org.id, name: 'Water survey project', sector: 'wash', donor: 'EU', donorType: 'eu',
          startDate: new Date('2026-01-01'), endDate: new Date('2027-12-31'),
        },
      });
      const framework = await prisma.framework.create({ data: { projectId: project.id, version: 1 } });
      const indicator = await prisma.indicator.create({
        data: {
          frameworkId: framework.id, indicatorText: '% of households with safe water', level: 'outcome', unit: '%',
          dataCollectionMethod: 'hh_survey', frequency: 'quarterly', phases: ['baseline'],
        },
      });
      for (const [collectionDate, value] of [['2026-03-31', '48'], ['2026-06-30', '55'], ['2026-09-30', '62']]) {
        const res = await request(app).post(`/api/indicators/${indicator.id}/data`).set('Authorization', a.officerAuth)
          .send({ value, collectionDate, collectionMethod: 'hh_survey', dataSource: 'Endline household survey (n=420)' });
        expect(res.status).toBe(201);
      }
      const res = await request(app).get(`/api/indicators/${indicator.id}/data`).set('Authorization', a.donorAuth);
      expect(res.body).toMatchObject({ indicator: { currentValue: '62' }, count: 3, trend: 'increasing', surveyAggregates: [] });
      expect(res.body.dataPoints.map((p: { value: string }) => p.value)).toEqual(['48', '55', '62']);
      const exported = await request(app).get(`/api/projects/${project.id}/export/indicators`).set('Authorization', a.donorAuth);
      expect(exported.body.indicators[0]).toMatchObject({ current: '62', surveyAggregates: [] });
      expect(exported.body.indicators[0].dataPoints.map((p: { value: string }) => p.value)).toEqual(['62', '55', '48']);
    });

    it('drops unlisted areas and KoboToolbox rows from the indicator export for donor viewers', async () => {
      const res = await request(app).get(`/api/projects/${a.project.id}/export/indicators`).set('Authorization', a.donorAuth);
      expect(res.status).toBe(200);
      const [indicator] = res.body.indicators;
      expect(indicator.dataPoints.map((p: { area: string | null }) => p.area)).toEqual(['Hebron', null, 'Hebron', null, null]);
      expect(indicator.surveyAggregates).toHaveLength(1);
      const staff = await request(app).get(`/api/projects/${a.project.id}/export/indicators`).set('Authorization', a.officerAuth);
      expect(staff.body.indicators[0].dataPoints.map((p: { area: string | null }) => p.area)).toContain(GPS);
      expect(staff.body.indicators[0].dataPoints).toHaveLength(13);
    });

    it('gives donor viewers the type, month and participants of qualitative entries only (no AI coding)', async () => {
      const list = await request(app).get(`/api/projects/${a.project.id}/qualitative`).set('Authorization', a.donorAuth);
      expect(list.status).toBe(200);
      for (const entry of list.body) expect(Object.keys(entry).sort()).toEqual([...QUALITATIVE_KEYS].sort());
      const one = await request(app).get(`/api/qualitative/${a.interview.id}`).set('Authorization', a.donorAuth);
      expect(Object.keys(one.body).sort()).toEqual([...QUALITATIVE_KEYS].sort());
      expect(one.body).toMatchObject({ entryType: 'kii_notes', monthConducted: '2026-03', participants: 1 });
      expect(JSON.stringify(one.body)).not.toMatch(/access to services|negative|2026-03-14/);

      const staff = await request(app).get(`/api/qualitative/${a.interview.id}`).set('Authorization', a.officerAuth);
      expect(staff.body).toMatchObject({ facilitator: 'Facilitator Testname', location: GPS, themes: ['access to services'], sentiment: 'negative' });
      expect(staff.body.project.id).toBe(a.project.id);
    });

    it('refuses the AI risk analysis to donor viewers', async () => {
      const res = await request(app).get(`/api/dashboard/projects/${a.project.id}/risks`).set('Authorization', a.donorAuth);
      expect(res.status).toBe(403);
      const staff = await request(app).get(`/api/dashboard/projects/${a.project.id}/risks`).set('Authorization', a.officerAuth);
      expect(staff.status).toBe(200);
    });
  });

  describe('AI output drawn from transcripts', () => {
    it('gives donor viewers assessments without the AI text, price or report location', async () => {
      const list = await request(app).get(`/api/projects/${a.project.id}/assessments`).set('Authorization', a.donorAuth);
      expect(list.status).toBe(200);
      for (const assessment of list.body) expect(Object.keys(assessment).sort()).toEqual([...ASSESSMENT_KEYS].sort());
      const report = await request(app).get(`/api/assessments/${a.aiAssessment.id}/report`).set('Authorization', a.donorAuth);
      expect(report.status).toBe(200);
      expect(report.body).toEqual({
        assessmentId: a.aiAssessment.id, status: 'delivered', type: 'baseline', report: null, deliveredAt: '2026-03-20T00:00:00.000Z',
      });

      const staffList = await request(app).get(`/api/projects/${a.project.id}/assessments`).set('Authorization', a.officerAuth);
      expect(staffList.body.find((x: { id: string }) => x.id === a.aiAssessment.id)).toMatchObject({ scopeDescription: AI_ASSESSMENT, _count: { dataPoints: 0 } });
      const staffReport = await request(app).get(`/api/assessments/${a.aiAssessment.id}/report`).set('Authorization', a.officerAuth);
      expect(staffReport.body.report.qualitativeInsights.beneficiaryVoices[0]).toContain('Layla');
    });

    it('shows donor viewers published reports only; drafts answer 404', async () => {
      const list = await request(app).get(`/api/projects/${a.project.id}/reports`).set('Authorization', a.donorAuth);
      expect(list.body.map((r: { id: string }) => r.id)).toEqual([a.publishedReport.id]);
      expect(Object.keys(list.body[0]).sort()).toEqual(
        ['aiNarrative', 'donorFormat', 'generatedAt', 'id', 'periodEnd', 'periodStart', 'projectId', 'status', 'title', 'type'],
      );
      for (const path of [`/api/reports/${a.draftReport.id}`, `/api/reports/${a.draftReport.id}/status`, `/api/reports/${a.report.id}`]) {
        const res = await request(app).get(path).set('Authorization', a.donorAuth);
        expect(res.status, path).toBe(404);
        expect(res.body).toEqual({ message: 'Report not found' });
      }
      const published = await request(app).get(`/api/reports/${a.publishedReport.id}`).set('Authorization', a.donorAuth);
      expect(published.body).toMatchObject({ id: a.publishedReport.id, aiNarrative: '<p>Reviewed narrative</p>' });
      const status = await request(app).get(`/api/reports/${a.publishedReport.id}/status`).set('Authorization', a.donorAuth);
      expect(status.body).toEqual({ reportId: a.publishedReport.id, status: 'processing' });

      const staff = await request(app).get(`/api/projects/${a.project.id}/reports`).set('Authorization', a.officerAuth);
      expect(staff.body.map((r: { id: string }) => r.id).sort()).toEqual([a.report.id, a.draftReport.id, a.publishedReport.id].sort());
      const draft = await request(app).get(`/api/reports/${a.draftReport.id}`).set('Authorization', a.officerAuth);
      expect(draft.body.aiNarrative).toContain('Beneficiary Voices');
    });

    it('gives donor viewers documents without the AI analysis or the uploader name', async () => {
      for (const path of [`/api/projects/${a.project.id}/documents`, `/api/projects/${a.project.id}`]) {
        const res = await request(app).get(path).set('Authorization', a.donorAuth);
        const docs = Array.isArray(res.body) ? res.body : res.body.documents;
        expect(docs).toEqual([expect.objectContaining({ id: a.document.id, aiAnalysis: null, uploader: null })]);
      }
      const staff = await request(app).get(`/api/projects/${a.project.id}/documents`).set('Authorization', a.officerAuth);
      expect(staff.body.find((d: { id: string }) => d.id === a.document.id)).toMatchObject({
        aiAnalysis: { summary: 'Proposal reviewed with Layla Testname' }, uploader: { fullName: 'Officer a' },
      });
    });
  });

  describe('counts', () => {
    const get = (path: string, auth: string) => request(app).get(path).set('Authorization', auth);

    it('count only what donor viewers are shown: no KoboToolbox rows, hidden documents or draft reports', async () => {
      const cases = [
        { auth: a.donorAuth, dataPoints: 5, documents: 1, reports: 1 },
        { auth: a.officerAuth, dataPoints: 13, documents: 3, reports: 3 },
      ];
      for (const { auth, dataPoints, documents, reports } of cases) {
        const list = await get('/api/projects', auth);
        expect(list.body.find((p: { id: string }) => p.id === a.project.id)._count).toMatchObject({ dataPoints, documents });
        const one = await get(`/api/projects/${a.project.id}`, auth);
        expect(one.body._count).toMatchObject({ dataPoints, reports });
        const indicators = await get(`/api/frameworks/${a.framework.id}/indicators`, auth);
        expect(indicators.body.find((i: { id: string }) => i.id === a.indicator.id)._count).toEqual({ dataPoints });
        const framework = await get(`/api/projects/${a.project.id}/framework`, auth);
        expect(framework.body.indicators.find((i: { id: string }) => i.id === a.indicator.id)._count).toEqual({ dataPoints });
        const status = await get(`/api/frameworks/${a.framework.id}/status`, auth);
        expect(status.body.framework.indicators.find((i: { id: string }) => i.id === a.indicator.id)._count).toEqual({ dataPoints });
        const overview = await get('/api/dashboard/overview', auth);
        expect(overview.body.projects.find((p: { id: string }) => p.id === a.project.id)).toMatchObject({ dataPointCount: dataPoints, reportCount: reports });
      }
    });
  });

  describe('survey aggregates over time', () => {
    const get = (path: string, auth: string) => request(app).get(path).set('Authorization', auth);

    it('a new submission changes nothing a donor viewer sees: no exact counts, published months only', async () => {
      const project = await prisma.project.create({
        data: {
          organizationId: a.org.id, name: 'Income survey project', sector: 'livelihoods', donor: 'EU', donorType: 'eu',
          startDate: new Date('2026-01-01'), endDate: new Date('2027-12-31'),
        },
      });
      const framework = await prisma.framework.create({ data: { projectId: project.id, version: 1 } });
      const indicator = await prisma.indicator.create({
        data: {
          frameworkId: framework.id, indicatorText: 'Average monthly household income', level: 'outcome', unit: 'ILS',
          dataCollectionMethod: 'hh_survey', frequency: 'quarterly', phases: ['baseline'],
        },
      });
      /** A KoboToolbox submission as the webhook stores it (createdAt: when it was received). */
      const submit = (value: number, collectionDate: Date, createdAt?: Date) => prisma.dataPoint.create({
        data: {
          indicatorId: indicator.id, projectId: project.id, value: String(value), collectionDate, collectionMethod: 'hh_survey',
          dataSource: 'KoboToolbox', geographicArea: '31.549, 35.099', createdBy: a.officer.id, ...(createdAt && { createdAt }),
        },
      });
      // Eight households in August, received the same day.
      for (const [i, income] of [1200, 1500, 900, 2000, 1100, 1300, 1700, 1000].entries()) {
        await submit(income, new Date(Date.UTC(2026, 7, i + 1)), new Date(Date.UTC(2026, 7, i + 1, 15)));
      }

      const donorView = async () => {
        const as = (path: string) => get(path, a.donorAuth);
        const indicators = await as(`/api/frameworks/${framework.id}/indicators`);
        const projects = await as('/api/projects');
        const one = await as(`/api/projects/${project.id}`);
        const data = await as(`/api/indicators/${indicator.id}/data`);
        const dashboard = await as(`/api/dashboard/projects/${project.id}/dashboard`);
        const overview = await as('/api/dashboard/overview');
        const exported = await as(`/api/projects/${project.id}/export`);
        const indicatorExport = await as(`/api/projects/${project.id}/export/indicators`);
        return {
          counts: [
            indicators.body[0]._count.dataPoints,
            projects.body.find((p: { id: string }) => p.id === project.id)._count.dataPoints,
            one.body._count.dataPoints,
            data.body.count,
            dashboard.body.geographic,
            overview.body.projects.find((p: { id: string }) => p.id === project.id).dataPointCount,
          ],
          aggregates: [
            data.body.surveyAggregates, dashboard.body.trends[0].surveyAggregates,
            exported.body.indicators[0].surveyAggregates, indicatorExport.body.indicators[0].surveyAggregates,
          ],
        };
      };

      const before = await donorView();
      expect(before.counts).toEqual([0, 0, 0, 0, [], 0]);
      const august = [{
        indicatorId: indicator.id, period: '2026-08', aggregation: 'mean', value: 1337.5,
        submissions: { key: null, count: 10, suppressed: false }, numericAnswers: { key: null, count: 10, suppressed: false },
      }];
      for (const aggregates of before.aggregates) expect(aggregates).toEqual(august);

      // A ninth August household arrives after the release (15 September), and this month's submissions start.
      await submit(2450, new Date(Date.UTC(2026, 7, 20)));
      for (const income of [3000, 2800, 2600, 2400, 2200, 2000, 1800, 1600]) await submit(income, new Date());
      expect(await donorView()).toEqual(before);

      // Staff see every row.
      const staff = await get(`/api/frameworks/${framework.id}/indicators`, a.officerAuth);
      expect(staff.body[0]._count.dataPoints).toBe(17);
      const staffData = await get(`/api/indicators/${indicator.id}/data`, a.officerAuth);
      expect(staffData.body.dataPoints.map((p: { value: string }) => p.value)).toContain('2450');
    });
  });

  // Access tokens must carry an organisation and a role; reset tokens are refused (tests/accessToken.test.ts).
  describe('a reset token', () => {
    const resetAuth = () => `Bearer ${generateResetToken(a.donor.id)}`;

    it('is refused on writes and reads', async () => {
      const write = await request(app).post(`/api/projects/${a.project.id}/beneficiaries`).set('Authorization', resetAuth()).send({ fullName: 'Injected', gender: 'male' });
      expect(write.status).toBe(401);
      for (const path of [
        `/api/projects/${a.project.id}/export`, `/api/projects/${b.project.id}/export`, `/api/projects/${a.project.id}/beneficiaries/stats`,
        `/api/projects/${a.project.id}/documents`, `/api/projects/${a.project.id}/beneficiaries`, '/api/projects',
      ]) {
        const res = await request(app).get(path).set('Authorization', resetAuth());
        expect(res.status, path).toBe(401);
      }
    });
  });
});
