import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { DEFAULT_LIBRARY_PATH, loadLibraryFile, LibraryValidationError, validateLibraryData } from '../src/services/library/load';
import { libraryContentDiffers, seedLibrary, stableStringify, toLibraryContent } from '../src/services/library/seed';
import { buildLibraryWhere, matchesLibrarySearch, normaliseSearchText, parseLibraryQuery } from '../src/services/library/query';
import { bearer, hasTestDatabase, resetDatabase } from './helpers';

const rawLibrary = () => JSON.parse(fs.readFileSync(DEFAULT_LIBRARY_PATH, 'utf8'));
const silent = { warn: vi.fn() };

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(LibraryValidationError);
    return (err as LibraryValidationError).problems;
  }
  throw new Error('expected a LibraryValidationError');
}

describe('loadLibraryFile', () => {
  it('loads the real library: 63 entries with unique ids', () => {
    const { version, entries } = loadLibraryFile();
    expect(version).toBe('1.0.0');
    expect(entries).toHaveLength(63);
    expect(new Set(entries.map(e => e.id)).size).toBe(63);
    for (const e of entries) {
      expect(e.id).toMatch(/^[A-Z]{2}-\d{2}$/);
      expect(e.nameAr).toMatch(/[\u0600-\u06FF]/);
      expect(e.methods.length).toBeGreaterThan(0);
      if (e.isStandard) expect(e.standardReference).not.toBeNull();
    }
    expect(entries.find(e => e.id === 'FS-01')).toMatchObject({ sector: 'food_security', level: 'outcome', unit: 'percent' });
  });

  it('reads a file from a given path', () => {
    const data = rawLibrary();
    data.meta.version = '9.9.9';
    data.indicators = data.indicators.slice(0, 2);
    const file = path.join(os.tmpdir(), `raqib-library-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify(data));
    try {
      expect(loadLibraryFile(file)).toMatchObject({ version: '9.9.9', entries: [{ id: 'FS-01' }, { id: 'FS-02' }] });
    } finally {
      fs.unlinkSync(file);
    }
  });

  it('reports a missing file and invalid JSON clearly', () => {
    expect(problemsOf(() => loadLibraryFile(path.join(os.tmpdir(), 'no-such-library.json')))).toEqual(['cannot read the file: file not found']);
    const file = path.join(os.tmpdir(), `raqib-library-bad-${process.pid}.json`);
    fs.writeFileSync(file, '{ "meta": ');
    try {
      expect(problemsOf(() => loadLibraryFile(file))[0]).toMatch(/^not valid JSON/);
    } finally {
      fs.unlinkSync(file);
    }
  });

  it('checks the file structure', () => {
    expect(problemsOf(() => validateLibraryData({ meta: { enums: {} }, indicators: [] }))).toEqual([
      'meta.version: is required',
      'meta.enums.unit: is required',
      'indicators: must contain at least one entry',
    ]);
  });

  it('lists every problem in every entry in one error', () => {
    const data = rawLibrary();
    const e = data.indicators;
    e[0].sector = 'space';
    e[1].id = 'FS-01';
    delete e[2].frequency;
    e[3].colour = 'red';
    e[4].nameAr = 'Not Arabic';
    e[5].methods = [];
    e[6].unit = 'parsecs';
    e[7].level = 'activity';
    e[8].standardReference = null; // isStandard is true
    e[9].methods = ['telepathy'];
    e[10].id = 'wa-1';
    e[11].name = '   ';
    e[12].tags = 'water';
    e[13].calculation = { numerater: 'typo' };
    e[14].standardReference = { framework: 'Sphere', url: 'not a url' };
    e[15].isStandard = 'yes';
    e[16].direction = 'up';
    e[17] = 'not an object';

    const problems = problemsOf(() => validateLibraryData(data, 'synthetic'));
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringMatching(/^indicators\[0\] \(FS-01\)\.sector: must be one of: .*food_security.*mhpss/),
      'indicators[1] (FS-01): duplicate id "FS-01" (first used by indicators[0])',
      'indicators[2] (FS-03).frequency: is required',
      'indicators[3] (FS-04): unknown field "colour"',
      'indicators[4] (FS-05).nameAr: must contain Arabic text',
      'indicators[5] (FS-06).methods: must list at least one collection method',
      expect.stringMatching(/^indicators\[6\] \(WA-01\)\.unit: must be one of the units in meta\.enums\.unit: number, percent/),
      'indicators[7] (WA-02).level: must be one of: impact, outcome, output',
      'indicators[8] (WA-03).standardReference: is required when isStandard is true',
      expect.stringMatching(/^indicators\[9\] \(WA-04\)\.methods\[0\]: must be one of: hh_survey/),
      expect.stringMatching(/^indicators\[10\] \(wa-1\)\.id: must look like "FS-01"/),
      'indicators[11] (WA-06).name: must not be empty',
      'indicators[12] (HE-01).tags: must be an array of strings',
      'indicators[13] (HE-02): unknown field "calculation.numerater"',
      'indicators[14] (HE-03).standardReference.code: is required',
      'indicators[14] (HE-03).standardReference.url: must be a valid URL',
      'indicators[15] (HE-04).isStandard: must be true or false',
      expect.stringMatching(/^indicators\[16\] \(HE-05\)\.direction: must be one of: increase, decrease, maintain/),
      'indicators[17]: must be an object',
    ]));
    expect(problems).toHaveLength(19);
    expect(() => validateLibraryData(data, 'synthetic')).toThrow(/Indicator library synthetic is invalid \(19 problems\)/);
  });
});

describe('library seed helpers', () => {
  const entry = () => loadLibraryFile().entries.find(e => e.id === 'FS-01')!;

  it('maps a file entry to stored columns', () => {
    const content = toLibraryContent(entry());
    expect(content.standardFramework).toBe('WFP');
    expect(content.notes).toMatch(/WFP country office/);
    const blankNotes = toLibraryContent({ ...entry(), notes: '', standardReference: null, calculation: null });
    expect(blankNotes).toMatchObject({ notes: null, standardFramework: null, standardReference: Prisma.DbNull, calculation: Prisma.DbNull });
  });

  it('compares JSON regardless of key order but array order matters', () => {
    expect(stableStringify({ b: 1, a: { d: [2, 1], c: null } })).toBe(stableStringify({ a: { c: null, d: [2, 1] }, b: 1 }));
    expect(stableStringify(['a', 'b'])).not.toBe(stableStringify(['b', 'a']));
    expect(stableStringify(Prisma.DbNull)).toBe('null');
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('detects changed content only', () => {
    const content = toLibraryContent(entry());
    const stored: Record<string, unknown> = {
      ...content,
      calculation: { denominator: (content.calculation as any).denominator, numerator: (content.calculation as any).numerator },
      standardReference: JSON.parse(JSON.stringify(content.standardReference)),
    };
    expect(libraryContentDiffers(content, stored)).toBe(false);
    expect(libraryContentDiffers(content, { ...stored, name: 'Changed' })).toBe(true);
    expect(libraryContentDiffers(content, { ...stored, tags: [...(content.tags as string[])].reverse() })).toBe(true);
    expect(libraryContentDiffers(content, { ...stored, calculation: null })).toBe(true);
  });
});

describe('library query helpers', () => {
  it('parses filters and ignores empty values', () => {
    expect(parseLibraryQuery({ sector: '', level: '', framework: '', q: '', isStandard: '' })).toEqual({});
    expect(parseLibraryQuery({ sector: 'wash, health', level: 'outcome', isStandard: 'false', framework: ' gerf ', q: ' water ' })).toEqual({
      sector: ['wash', 'health'], level: 'outcome', isStandard: false, framework: 'gerf', q: 'water',
    });
    expect(parseLibraryQuery({ sector: ['wash', 'mhpss'], isStandard: 'true' })).toEqual({ sector: ['wash', 'mhpss'], isStandard: true });
  });

  it('rejects unknown values with a clear message', () => {
    expect(() => parseLibraryQuery({ sector: 'wash,space' })).toThrow(/sector unknown sector "space"; use one or more of: education/);
    expect(() => parseLibraryQuery({ level: 'goal' })).toThrow(/level must be one of: impact, outcome, output, activity/);
    expect(() => parseLibraryQuery({ isStandard: 'yes' })).toThrow(/isStandard must be true or false/);
    expect(() => parseLibraryQuery({ q: 'x'.repeat(201) })).toThrow(/q must be at most 200 characters/);
  });

  it('builds the database filter', () => {
    expect(buildLibraryWhere({ sector: ['wash'], level: 'output', framework: 'GERF', isStandard: false })).toEqual({
      sector: { in: ['wash'] }, level: 'output', standardFramework: { contains: 'GERF', mode: 'insensitive' }, isStandard: false,
    });
    expect(buildLibraryWhere({})).toEqual({});
  });

  it('normalises English and Arabic search text', () => {
    expect(normaliseSearchText('  Food   CONSUMPTION ')).toBe('food consumption');
    expect(normaliseSearchText('التكيّف')).toBe('التكيف');
    expect(normaliseSearchText('أُسرة')).toBe(normaliseSearchText('اسره'));
    expect(normaliseSearchText('مستشفى')).toBe('مستشفي');
    expect(normaliseSearchText('مـيـاه')).toBe('مياه');
  });

  it('matches name, Arabic name, definition, tags and id', () => {
    const e = { id: 'FS-02', name: 'Mean reduced Coping Strategies Index (rCSI) score', nameAr: 'متوسط درجة مؤشر استراتيجيات التكيّف', definition: 'Average rCSI score of households.', tags: ['rcsi', 'food_consumption'] };
    expect(matchesLibrarySearch(e, undefined)).toBe(true);
    expect(matchesLibrarySearch(e, 'coping strategies')).toBe(true);
    expect(matchesLibrarySearch(e, 'households coping')).toBe(true); // every word, any order
    expect(matchesLibrarySearch(e, 'التكيف')).toBe(true); // without the shadda
    expect(matchesLibrarySearch(e, 'food consumption')).toBe(true); // tag food_consumption
    expect(matchesLibrarySearch(e, 'RCSI')).toBe(true);
    expect(matchesLibrarySearch(e, 'fs-02')).toBe(true);
    expect(matchesLibrarySearch(e, 'water')).toBe(false);
    expect(matchesLibrarySearch(e, 'coping water')).toBe(false);
    expect(matchesLibrarySearch({ ...e, tags: ['cash'] }, 'cas')).toBe(false); // tags match whole words only
  });
});

describe.skipIf(!hasTestDatabase)('seedLibrary (database)', () => {
  const updatedAtById = async () =>
    new Map((await prisma.indicatorLibraryEntry.findMany({ select: { id: true, updatedAt: true } })).map(r => [r.id, r.updatedAt.getTime()]));

  beforeAll(async () => {
    await resetDatabase();
  });

  it('creates every entry, then changes nothing on a second run', async () => {
    const first = await seedLibrary(prisma, { logger: silent });
    expect(first).toEqual({ created: 63, updated: 0, unchanged: 0, total: 63, version: '1.0.0', notInFile: [] });
    expect(await prisma.indicatorLibraryEntry.count()).toBe(63);
    const before = await updatedAtById();

    await new Promise(r => setTimeout(r, 20));
    const second = await seedLibrary(prisma, { logger: silent });
    expect(second).toEqual({ created: 0, updated: 0, unchanged: 63, total: 63, version: '1.0.0', notInFile: [] });
    expect(await updatedAtById()).toEqual(before);
  });

  it('stores the file content', async () => {
    const fs01 = await prisma.indicatorLibraryEntry.findUniqueOrThrow({ where: { id: 'FS-01' } });
    expect(fs01).toMatchObject({
      sector: 'food_security', level: 'outcome', unit: 'percent', direction: 'increase', frequency: 'biannual',
      methods: ['hh_survey'], standardFramework: 'WFP', isStandard: true, version: '1.0.0',
      standardReference: { framework: 'WFP', code: 'Food Consumption Score' },
    });
    expect(fs01.tags).toEqual(['fcs', 'food_consumption', 'humanitarian', 'cash', 'in_kind']);
    const fs02 = await prisma.indicatorLibraryEntry.findUniqueOrThrow({ where: { id: 'FS-02' } });
    expect(fs02.notes).toBeNull(); // "" in the file
    const custom = await prisma.indicatorLibraryEntry.findFirstOrThrow({ where: { isStandard: false } });
    expect(custom.standardReference).toBeNull();
    expect(custom.standardFramework).toBeNull();
  });

  it('updates exactly the changed rows and keeps the embedding', async () => {
    await prisma.indicatorLibraryEntry.update({ where: { id: 'FS-01' }, data: { name: 'Edited by hand' } });
    await prisma.$executeRawUnsafe(
      `UPDATE "IndicatorLibraryEntry" SET embedding = array_fill(0.5, ARRAY[1024])::vector WHERE id = 'FS-01'`,
    );
    const before = await updatedAtById();

    const result = await seedLibrary(prisma, { logger: silent });
    expect(result).toMatchObject({ created: 0, updated: 1, unchanged: 62 });

    const after = await updatedAtById();
    expect(after.get('FS-01')).toBeGreaterThan(before.get('FS-01')!);
    for (const [id, t] of before) if (id !== 'FS-01') expect(after.get(id)).toBe(t);
    expect((await prisma.indicatorLibraryEntry.findUniqueOrThrow({ where: { id: 'FS-01' } })).name).toMatch(/Food Consumption Score/);
    const [{ hasEmbedding }] = await prisma.$queryRaw<{ hasEmbedding: boolean }[]>`
      SELECT embedding IS NOT NULL AS "hasEmbedding" FROM "IndicatorLibraryEntry" WHERE id = 'FS-01'`;
    expect(hasEmbedding).toBe(true);
  });

  it('treats a reordered array or a cleared JSON field as a change', async () => {
    const wa01 = await prisma.indicatorLibraryEntry.findUniqueOrThrow({ where: { id: 'WA-01' } });
    await prisma.indicatorLibraryEntry.update({ where: { id: 'WA-01' }, data: { tags: [...wa01.tags].reverse() } });
    await prisma.indicatorLibraryEntry.update({ where: { id: 'WA-02' }, data: { calculation: Prisma.DbNull } });
    const result = await seedLibrary(prisma, { logger: silent });
    expect(result).toMatchObject({ created: 0, updated: 2, unchanged: 61 });
    expect((await prisma.indicatorLibraryEntry.findUniqueOrThrow({ where: { id: 'WA-01' } })).tags).toEqual(wa01.tags);
    expect((await seedLibrary(prisma, { logger: silent })).unchanged).toBe(63);
  });

  it('re-creates a missing entry and keeps entries that are not in the file', async () => {
    await prisma.indicatorLibraryEntry.delete({ where: { id: 'HE-01' } });
    const extra = await prisma.indicatorLibraryEntry.findUniqueOrThrow({ where: { id: 'HE-02' } });
    const { createdAt: _c, updatedAt: _u, ...rest } = extra;
    await prisma.indicatorLibraryEntry.create({
      data: { ...rest, id: 'ZZ-99', calculation: rest.calculation ?? Prisma.DbNull, standardReference: rest.standardReference ?? Prisma.DbNull },
    });
    const logger = { warn: vi.fn() };

    const result = await seedLibrary(prisma, { logger });
    expect(result).toEqual({ created: 1, updated: 0, unchanged: 62, total: 63, version: '1.0.0', notInFile: ['ZZ-99'] });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ZZ-99'));
    expect(await prisma.indicatorLibraryEntry.findUnique({ where: { id: 'ZZ-99' } })).not.toBeNull();
    expect(await prisma.indicatorLibraryEntry.count()).toBe(64);
    await prisma.indicatorLibraryEntry.delete({ where: { id: 'ZZ-99' } });
  });

  it('writes nothing when the file is invalid', async () => {
    const data = rawLibrary();
    data.indicators[0].name = 'Changed in an invalid file';
    data.indicators[1].sector = 'space';
    const file = path.join(os.tmpdir(), `raqib-library-invalid-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify(data));
    try {
      await expect(seedLibrary(prisma, { path: file, logger: silent })).rejects.toBeInstanceOf(LibraryValidationError);
    } finally {
      fs.unlinkSync(file);
    }
    expect((await prisma.indicatorLibraryEntry.findUniqueOrThrow({ where: { id: 'FS-01' } })).name).not.toMatch(/invalid file/);
  });
});

describe.skipIf(!hasTestDatabase)('indicator library routes', () => {
  let auth: string;
  let viewerAuth: string;

  beforeAll(async () => {
    await resetDatabase();
    await seedLibrary(prisma, { logger: silent });
    await prisma.$executeRawUnsafe(
      `UPDATE "IndicatorLibraryEntry" SET embedding = array_fill(0.1, ARRAY[1024])::vector WHERE id = 'FS-01'`,
    );
    const org = await prisma.organization.create({
      data: { name: 'Org lib', type: 'local_ngo', country: 'Palestine', city: 'Ramallah', contactEmail: 'lib@example.org' },
    });
    const officer = await prisma.user.create({
      data: { organizationId: org.id, email: 'me-lib@example.org', passwordHash: 'x', fullName: 'Officer lib', role: 'me_officer' },
    });
    const viewer = await prisma.user.create({
      data: { organizationId: org.id, email: 'donor-lib@example.org', passwordHash: 'x', fullName: 'Donor lib', role: 'donor_viewer' },
    });
    auth = bearer(officer);
    viewerAuth = bearer(viewer);
  });

  const list = (query = '', token = auth) => request(app).get(`/api/indicator-library${query}`).set('Authorization', token);
  const ids = (res: request.Response) => res.body.map((e: any) => e.id);

  it('requires authentication', async () => {
    expect((await request(app).get('/api/indicator-library')).status).toBe(401);
    expect((await request(app).get('/api/indicator-library/FS-01')).status).toBe(401);
  });

  it('lists every entry ordered by id, without the embedding', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(63);
    expect(ids(res)).toEqual([...ids(res)].sort());
    for (const e of res.body) expect(e).not.toHaveProperty('embedding');
    expect(res.body.find((e: any) => e.id === 'FS-01')).toMatchObject({
      name: expect.stringMatching(/Food Consumption Score/), nameAr: expect.stringMatching(/[\u0600-\u06FF]/),
      calculation: { numerator: expect.any(String), denominator: expect.any(String) }, version: '1.0.0',
    });
  });

  it('is readable by every role', async () => {
    expect((await list('?sector=wash', viewerAuth)).status).toBe(200);
  });

  it('ignores empty parameters', async () => {
    const res = await list('?sector=&level=&framework=&q=&isStandard=');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(63);
  });

  it('filters by one or several sectors', async () => {
    const wash = await list('?sector=wash');
    expect(wash.body).toHaveLength(6);
    expect(wash.body.every((e: any) => e.sector === 'wash')).toBe(true);
    const two = await list('?sector=wash,health');
    expect(two.body).toHaveLength(11);
    expect(new Set(two.body.map((e: any) => e.sector))).toEqual(new Set(['wash', 'health']));
    expect((await list('?sector=mhpss')).body).toEqual([]);
  });

  it('filters by level', async () => {
    const res = await list('?level=impact');
    expect(ids(res)).toEqual(['IM-01', 'IM-02']);
  });

  it('filters by framework, case-insensitively', async () => {
    const gerf = await list('?framework=eu%20gerf');
    expect(gerf.body).toHaveLength(20);
    expect(gerf.body.every((e: any) => e.standardFramework === 'EU GERF')).toBe(true);
    expect((await list('?framework=GERF')).body).toHaveLength(20);
    const wfp = await list('?framework=wfp');
    expect(wfp.body).toHaveLength(4); // "WFP" and "WFP CARI"
  });

  it('filters by isStandard', async () => {
    const custom = await list('?isStandard=false');
    expect(custom.body).toHaveLength(25);
    expect(custom.body.every((e: any) => e.isStandard === false)).toBe(true);
    expect((await list('?isStandard=true')).body).toHaveLength(38);
  });

  it('searches names, Arabic names, definitions and tags', async () => {
    expect(ids(await list('?q=food%20consumption%20score'))).toContain('FS-01');
    expect(ids(await list('?q=rcsi'))).toEqual(['FS-02']);
    // Stored names are written with a shadda (التكيّف) and hamza (الأسر); search works without them.
    expect(ids(await list(`?q=${encodeURIComponent('التكيف')}`))).toEqual(['FS-02']);
    expect(ids(await list(`?q=${encodeURIComponent('تكيف')}`))).toEqual(expect.arrayContaining(['FS-02', 'FS-03']));
    expect(ids(await list(`?q=${encodeURIComponent('الاسر المستهدفه')}`))).toContain('FS-01');
    const tag = await list('?q=humanitarian&sector=food_security');
    expect(tag.body.length).toBeGreaterThan(0);
    expect(tag.body.every((e: any) => e.tags.includes('humanitarian') || /humanitarian/i.test(e.name + e.definition))).toBe(true);
    expect((await list('?q=zzzz-no-match')).body).toEqual([]);
  });

  it('combines filters', async () => {
    const res = await list('?sector=food_security&level=outcome&isStandard=true&framework=cari');
    expect(ids(res)).toEqual(['FS-02', 'FS-03', 'FS-05']);
    expect(ids(await list('?sector=food_security&q=coping'))).toEqual(['FS-02', 'FS-03']);
  });

  it('rejects invalid filters with 400 and a clear message', async () => {
    const sector = await list('?sector=space');
    expect(sector.status).toBe(400);
    expect(sector.body.message).toMatch(/unknown sector "space"; use one or more of: education/);
    const level = await list('?level=goal');
    expect(level.status).toBe(400);
    expect(level.body.message).toMatch(/level must be one of/);
    const isStandard = await list('?isStandard=maybe');
    expect(isStandard.status).toBe(400);
    expect(isStandard.body.message).toMatch(/isStandard must be true or false/);
  });

  it('returns one entry by id, or 404', async () => {
    const res = await request(app).get('/api/indicator-library/WA-01').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'WA-01', sector: 'wash' });
    expect(res.body).not.toHaveProperty('embedding');
    const fs01 = await request(app).get('/api/indicator-library/FS-01').set('Authorization', auth);
    expect(fs01.status).toBe(200);
    expect(fs01.body).not.toHaveProperty('embedding');
    const missing = await request(app).get('/api/indicator-library/XX-99').set('Authorization', auth);
    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe('Library entry not found');
  });
});
