import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { mergeSectors, parseProjectCreate, parseProjectUpdate, StoredProject } from '../src/services/projects/validation';
import { createOrgFixture, hasTestDatabase, OrgFixture, resetDatabase } from './helpers';

const DONOR_TYPES = 'usaid, eu, giz, undp, unicef, sida, other, echo, wfp, unfpa, fcdo, un_women';
const SECTORS = 'education, livelihoods, health, wash, protection, food_security, governance, agriculture, gender, youth, other, mhpss, cash, shelter, climate_energy';

const BASE = {
  name: 'Psychosocial support for children in Gaza',
  sector: 'mhpss',
  donor: 'ECHO',
  donorType: 'echo',
  startDate: '2026-01-01',
  endDate: '2026-12-31',
};

const STORED: StoredProject = {
  sector: 'education',
  sectors: ['education', 'youth'],
  startDate: new Date('2026-01-01'),
  endDate: new Date('2027-12-31'),
};

function errorsOf<T>(result: { ok: true; data: T } | { ok: false; errors: string[] }): string[] {
  if (result.ok === true) throw new Error('expected validation errors');
  return result.errors;
}

function dataOf<T>(result: { ok: true; data: T } | { ok: false; errors: string[] }): T {
  if (result.ok === false) throw new Error(result.errors.join('; '));
  return result.data;
}

describe('mergeSectors', () => {
  it('puts the primary sector first and removes repeats', () => {
    expect(mergeSectors('health')).toEqual(['health']);
    expect(mergeSectors('health', [])).toEqual(['health']);
    expect(mergeSectors('health', ['wash', 'health', 'protection'])).toEqual(['health', 'wash', 'protection']);
    expect(mergeSectors('cash', ['food_security'])).toEqual(['cash', 'food_security']);
  });
});

describe('parseProjectCreate', () => {
  it('defaults sectors to the primary sector', () => {
    const data = dataOf(parseProjectCreate(BASE));
    expect(data.sectors).toEqual(['mhpss']);
    expect(data.humanitarian).toBeUndefined();
    expect(data.startDate).toEqual(new Date('2026-01-01'));
  });

  it('always includes the primary sector in sectors', () => {
    expect(dataOf(parseProjectCreate({ ...BASE, sectors: ['protection', 'education'] })).sectors).toEqual(['mhpss', 'protection', 'education']);
    expect(dataOf(parseProjectCreate({ ...BASE, sectors: ['protection', 'mhpss'] })).sectors).toEqual(['mhpss', 'protection']);
  });

  it('parses budget and beneficiaries from numbers or numeric strings, and empty text as missing', () => {
    const data = dataOf(parseProjectCreate({ ...BASE, budgetUsd: '500,000', targetBeneficiaries: '1200', description: '', geographicScope: ' Gaza ' }));
    expect(data.budgetUsd).toBe(500000);
    expect(data.targetBeneficiaries).toBe(1200);
    expect(data.description).toBeUndefined();
    expect(data.geographicScope).toBe('Gaza');
    expect(dataOf(parseProjectCreate({ ...BASE, budgetUsd: 750000.5, targetBeneficiaries: 300 }))).toMatchObject({ budgetUsd: 750000.5, targetBeneficiaries: 300 });
  });

  it('lists every missing required field', () => {
    expect(errorsOf(parseProjectCreate({}))).toEqual([
      'name is required',
      'sector is required',
      'donor is required',
      'donorType is required',
      'startDate is required',
      'endDate is required',
    ]);
  });

  it('lists the allowed values of each enum', () => {
    expect(errorsOf(parseProjectCreate({ ...BASE, donorType: 'usaid_new' }))).toEqual([`donorType must be one of: ${DONOR_TYPES}`]);
    expect(errorsOf(parseProjectCreate({ ...BASE, sector: 'MHPSS' }))).toEqual([`sector must be one of: ${SECTORS}`]);
    expect(errorsOf(parseProjectCreate({ ...BASE, sectors: ['cash', 'nutrition'] }))).toEqual([`sectors[1] must be one of: ${SECTORS}`]);
  });

  it('rejects sectors that are not a unique list', () => {
    expect(errorsOf(parseProjectCreate({ ...BASE, sectors: 'cash' }))).toEqual(['sectors must be a list of sectors']);
    expect(errorsOf(parseProjectCreate({ ...BASE, sectors: ['cash', 'cash'] }))).toEqual(['sectors must not list a sector twice (cash)']);
  });

  it('requires humanitarian to be a boolean', () => {
    expect(errorsOf(parseProjectCreate({ ...BASE, humanitarian: 'yes' }))).toEqual(['humanitarian must be true or false']);
    expect(dataOf(parseProjectCreate({ ...BASE, humanitarian: false })).humanitarian).toBe(false);
  });

  it('checks numbers and dates', () => {
    expect(errorsOf(parseProjectCreate({ ...BASE, budgetUsd: 'a lot' }))).toEqual(['budgetUsd must be a number']);
    expect(errorsOf(parseProjectCreate({ ...BASE, budgetUsd: -5 }))).toEqual(['budgetUsd must not be negative']);
    expect(errorsOf(parseProjectCreate({ ...BASE, budgetUsd: 1e11 }))).toEqual(['budgetUsd must not be more than 9,999,999,999.99']);
    expect(errorsOf(parseProjectCreate({ ...BASE, targetBeneficiaries: 12.5 }))).toEqual(['targetBeneficiaries must be a whole number']);
    expect(errorsOf(parseProjectCreate({ ...BASE, startDate: '2026-02-30' }))).toEqual(['startDate must be a valid date (YYYY-MM-DD)']);
    expect(errorsOf(parseProjectCreate({ ...BASE, endDate: '2025-12-31' }))).toEqual(['endDate must be on or after startDate']);
  });

  it('ignores fields a client may not set', () => {
    const data = dataOf(parseProjectCreate({ ...BASE, organizationId: 'someone-else', status: 'active', id: 'x' })) as Record<string, unknown>;
    expect(data.organizationId).toBeUndefined();
    expect(data.status).toBeUndefined();
    expect(data.id).toBeUndefined();
  });
});

describe('parseProjectUpdate', () => {
  it('changes only the fields sent', () => {
    expect(dataOf(parseProjectUpdate({}, STORED))).toEqual({});
    expect(dataOf(parseProjectUpdate({ name: ' New name ', humanitarian: true }, STORED))).toEqual({ name: 'New name', humanitarian: true });
  });

  it('keeps the new primary sector first when the sector changes, without dropping others', () => {
    expect(dataOf(parseProjectUpdate({ sector: 'mhpss' }, STORED))).toEqual({ sector: 'mhpss', sectors: ['mhpss', 'education', 'youth'] });
    expect(dataOf(parseProjectUpdate({ sector: 'youth' }, STORED))).toEqual({ sector: 'youth', sectors: ['youth', 'education'] });
  });

  it('adds the primary sector when sectors change', () => {
    expect(dataOf(parseProjectUpdate({ sectors: ['wash'] }, STORED))).toEqual({ sectors: ['education', 'wash'] });
    expect(dataOf(parseProjectUpdate({ sectors: [] }, STORED))).toEqual({ sectors: ['education'] });
    expect(dataOf(parseProjectUpdate({ sector: 'cash', sectors: ['food_security'] }, STORED))).toEqual({
      sector: 'cash', sectors: ['cash', 'food_security'],
    });
  });

  it('repairs a project whose sectors miss the primary sector', () => {
    const legacy: StoredProject = { ...STORED, sectors: [] };
    expect(dataOf(parseProjectUpdate({ name: 'x' }, legacy))).toEqual({ name: 'x', sectors: ['education'] });
    expect(dataOf(parseProjectUpdate({ sector: 'health' }, legacy))).toEqual({ sector: 'health', sectors: ['health', 'education'] });
  });

  it('clears optional fields with null but not required ones', () => {
    expect(dataOf(parseProjectUpdate({ description: null, budgetUsd: null, targetBeneficiaries: '' }, STORED))).toEqual({
      description: null, budgetUsd: null, targetBeneficiaries: null,
    });
    expect(errorsOf(parseProjectUpdate({ name: null, donor: '  ' }, STORED))).toEqual(['name is required', 'donor is required']);
  });

  it('validates enums, including status', () => {
    expect(errorsOf(parseProjectUpdate({ donorType: 'gates' }, STORED))).toEqual([`donorType must be one of: ${DONOR_TYPES}`]);
    expect(errorsOf(parseProjectUpdate({ status: 'paused' }, STORED))).toEqual([
      'status must be one of: setup, framework_review, active, completed, archived',
    ]);
    expect(dataOf(parseProjectUpdate({ donorType: 'un_women', status: 'active' }, STORED))).toEqual({ donorType: 'un_women', status: 'active' });
  });

  it('checks the date order against the stored dates', () => {
    expect(errorsOf(parseProjectUpdate({ endDate: '2025-06-30' }, STORED))).toEqual(['endDate must be on or after startDate']);
    expect(errorsOf(parseProjectUpdate({ startDate: '2028-01-01' }, STORED))).toEqual(['endDate must be on or after startDate']);
    expect(dataOf(parseProjectUpdate({ startDate: '2026-03-01', endDate: '2026-09-30' }, STORED))).toEqual({
      startDate: new Date('2026-03-01'), endDate: new Date('2026-09-30'),
    });
  });
});

describe.skipIf(!hasTestDatabase)('projects API: sectors, humanitarian and donor types', () => {
  let a: OrgFixture;
  let b: OrgFixture;

  beforeAll(async () => {
    await resetDatabase();
    a = await createOrgFixture('a');
    b = await createOrgFixture('b');
  });

  it('creates a humanitarian ECHO project with several sectors', async () => {
    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', a.adminAuth)
      .send({ ...BASE, sectors: ['protection', 'education'], humanitarian: true, budgetUsd: '850000', targetBeneficiaries: 2400 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      organizationId: a.org.id,
      sector: 'mhpss',
      sectors: ['mhpss', 'protection', 'education'],
      humanitarian: true,
      donorType: 'echo',
      budgetUsd: '850000',
      targetBeneficiaries: 2400,
    });

    const detail = await request(app).get(`/api/projects/${res.body.id}`).set('Authorization', a.adminAuth);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ sectors: ['mhpss', 'protection', 'education'], humanitarian: true });

    const exported = await request(app).get(`/api/projects/${res.body.id}/export`).set('Authorization', a.adminAuth);
    expect(exported.body.project).toMatchObject({ sectors: ['mhpss', 'protection', 'education'], humanitarian: true });
  });

  it('exports the results chain of each framework and every reference-sheet field of each indicator', async () => {
    await prisma.indicatorLibraryEntry.create({
      data: {
        id: 'TS-02', sector: 'education', tags: [], level: 'outcome', name: 'Test indicator', nameAr: 'مؤشر اختبار', definition: 'Test',
        unit: 'percent', direction: 'increase', disaggregation: ['sex'], methods: ['hh_survey'], frequency: 'annual',
        meansOfVerification: 'Survey', isStandard: true, version: 'test',
      },
    });
    const goal = await prisma.resultNode.create({
      data: { frameworkId: a.framework.id, level: 'impact', code: 'Goal', text: 'Improved learning', textAr: 'تحسين التعلم' },
    });
    await prisma.resultNode.update({ where: { id: a.result.id }, data: { parentId: goal.id } });
    const sheet = {
      definition: 'Learners scoring at least 50% on the standard test',
      calculation: { numerator: 'Learners >= 50%', denominator: 'Learners tested' },
      direction: 'increase' as const,
      disaggregation: ['sex', 'disability'],
      meansOfVerification: 'Learning assessment, EGRA module',
      baselineDate: new Date('2026-01-15'),
      baselineMethod: 'Baseline learning assessment',
      targetJustification: 'Baseline + 15 points, as in similar programmes',
      intermediateTargets: [{ date: '2026-12-31', value: '45' }],
      assumptions: 'Schools stay open',
      libraryId: 'TS-02',
      standardReferenceCode: 'GERF 2.1',
      provenance: 'library' as const,
    };
    await prisma.indicator.update({ where: { id: a.indicator.id }, data: sheet });

    const res = await request(app).get(`/api/projects/${a.project.id}/export`).set('Authorization', a.adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.frameworks).toEqual([{
      id: a.framework.id,
      version: 1,
      status: 'draft',
      resultNodes: [
        { id: goal.id, code: 'Goal', level: 'impact', text: 'Improved learning', textAr: 'تحسين التعلم', parentId: null },
        { id: a.result.id, code: 'O1', level: 'outcome', text: 'Outcome a', textAr: null, parentId: goal.id },
      ],
    }]);
    const exported = res.body.indicators.find((i: any) => i.indicatorId === a.indicator.id);
    expect(exported).toEqual({
      frameworkVersion: 1,
      frameworkStatus: 'draft',
      indicatorId: a.indicator.id,
      indicatorText: 'Indicator a',
      indicatorTextAr: null,
      level: 'outcome',
      collectionMethod: 'hh_survey',
      frequency: 'quarterly',
      baselineValue: null,
      targetValue: null,
      currentValue: null,
      unit: null,
      status: 'not_started',
      frameworkId: a.framework.id,
      resultId: a.result.id,
      resultCode: 'O1',
      ...sheet,
      baselineDate: '2026-01-15T00:00:00.000Z',
      dataPoints: [expect.objectContaining({ id: a.dataPoint.id, value: '10' })],
    });
    // Everything exported before is still there.
    expect(Object.keys(res.body)).toEqual(
      expect.arrayContaining(['project', 'frameworks', 'indicators', 'beneficiaries', 'assessments', 'qualitativeEntries', 'exportedAt']),
    );
  });

  it('defaults sectors to the primary sector and humanitarian to false', async () => {
    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', a.adminAuth)
      .send({ ...BASE, name: 'Women economic empowerment', sector: 'livelihoods', donor: 'UN Women', donorType: 'un_women' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ sector: 'livelihoods', sectors: ['livelihoods'], humanitarian: false, donorType: 'un_women' });
  });

  it.each(['echo', 'wfp', 'unfpa', 'fcdo', 'un_women', 'usaid'])('accepts the donor type %s', async donorType => {
    const res = await request(app).post('/api/projects').set('Authorization', a.adminAuth).send({ ...BASE, donorType });
    expect(res.status).toBe(201);
    expect(res.body.donorType).toBe(donorType);
  });

  it.each(['mhpss', 'cash', 'shelter', 'climate_energy'])('accepts the new sector %s', async sector => {
    const res = await request(app).post('/api/projects').set('Authorization', a.adminAuth).send({ ...BASE, sector });
    expect(res.status).toBe(201);
    expect(res.body.sectors).toEqual([sector]);
  });

  it('rejects an unknown donor type with the allowed values', async () => {
    const before = await prisma.project.count();
    const res = await request(app).post('/api/projects').set('Authorization', a.adminAuth).send({ ...BASE, donorType: 'gates' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(`donorType must be one of: ${DONOR_TYPES}`);
    expect(res.body.errors).toEqual([`donorType must be one of: ${DONOR_TYPES}`]);
    expect(await prisma.project.count()).toBe(before);
  });

  it('rejects unknown sectors and non-boolean humanitarian values together', async () => {
    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', a.adminAuth)
      .send({ ...BASE, sectors: ['nutrition'], humanitarian: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual([`sectors[0] must be one of: ${SECTORS}`, 'humanitarian must be true or false']);
  });

  it('still requires the Phase 0 fields', async () => {
    const res = await request(app).post('/api/projects').set('Authorization', a.adminAuth).send({ name: 'Incomplete' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('sector is required; donor is required; donorType is required; startDate is required; endDate is required');
  });

  it('still lets only admins create projects', async () => {
    const res = await request(app).post('/api/projects').set('Authorization', a.officerAuth).send(BASE);
    expect(res.status).toBe(403);
  });

  describe('PATCH', () => {
    let projectId: string;

    beforeAll(async () => {
      const res = await request(app)
        .post('/api/projects')
        .set('Authorization', a.adminAuth)
        .send({ ...BASE, name: 'Youth employment in Hebron', sector: 'livelihoods', sectors: ['youth'], donor: 'GIZ', donorType: 'giz' });
      projectId = res.body.id;
    });

    it('keeps the new primary sector in sectors when the sector changes', async () => {
      const res = await request(app).patch(`/api/projects/${projectId}`).set('Authorization', a.officerAuth).send({ sector: 'education' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ sector: 'education', sectors: ['education', 'livelihoods', 'youth'] });
    });

    it('adds the primary sector when sectors are replaced', async () => {
      const res = await request(app)
        .patch(`/api/projects/${projectId}`)
        .set('Authorization', a.officerAuth)
        .send({ sectors: ['youth', 'gender'] });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ sector: 'education', sectors: ['education', 'youth', 'gender'] });
    });

    it('updates humanitarian, donor type and status', async () => {
      const res = await request(app)
        .patch(`/api/projects/${projectId}`)
        .set('Authorization', a.officerAuth)
        .send({ humanitarian: true, donorType: 'fcdo', status: 'active', description: null });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ humanitarian: true, donorType: 'fcdo', status: 'active', description: null });
    });

    it('rejects invalid values with clear messages and changes nothing', async () => {
      const res = await request(app)
        .patch(`/api/projects/${projectId}`)
        .set('Authorization', a.officerAuth)
        .send({ sector: 'nutrition', humanitarian: 1, name: 'Changed' });
      expect(res.status).toBe(400);
      expect(res.body.errors).toEqual([`sector must be one of: ${SECTORS}`, 'humanitarian must be true or false']);
      const stored = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
      expect(stored.name).toBe('Youth employment in Hebron');
    });

    it('repairs a project created before Phase 2 (empty sectors) on its next update', async () => {
      expect((await prisma.project.findUniqueOrThrow({ where: { id: a.project.id } })).sectors).toEqual([]);
      const res = await request(app).patch(`/api/projects/${a.project.id}`).set('Authorization', a.officerAuth).send({ name: 'Renamed' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: 'Renamed', sector: 'education', sectors: ['education'] });
    });

    it('returns 404 for a project of another organisation before validating the body', async () => {
      const res = await request(app).patch(`/api/projects/${b.project.id}`).set('Authorization', a.adminAuth).send({ sector: 'nonsense' });
      expect(res.status).toBe(404);
      expect((await prisma.project.findUniqueOrThrow({ where: { id: b.project.id } })).sector).toBe('education');
    });
  });
});
