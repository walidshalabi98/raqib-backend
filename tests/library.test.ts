import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import {
  EMBEDDING_DIMENSIONS, EmbeddingError, NoopEmbeddingProvider, type EmbeddingInputType, type EmbeddingProvider,
} from '../src/services/ai/embeddings';
import { redactPersonalData } from '../src/services/ai/redact';
import { embedLibraryEntries, libraryEmbeddingText } from '../src/services/library/embed';
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

/** seedLibrary's embedding fields when no provider is passed (prisma/seed.ts, most tests). */
const NO_PROVIDER = { embedded: 0, embeddingsSkipped: 'no embedding provider was given (keyword search is used)', embeddingError: null };

/** Deterministic stand-in for a Voyage vector: length and checksum of the text (integers, exact in pgvector's float4). */
function fakeVector(text: string, dimensions = EMBEDDING_DIMENSIONS): number[] {
  let checksum = 0;
  for (const ch of text) checksum = (checksum * 31 + ch.codePointAt(0)!) % 10007;
  return Array.from({ length: dimensions }, (_, i) => (i === 0 ? text.length : i === 1 ? checksum : 0));
}

/** An enabled provider that records what it is asked to embed. `failOnCall` makes that call (1-based) throw. */
class FakeEmbeddings implements EmbeddingProvider {
  readonly name = 'fake';
  readonly model = 'fake-embed-1';
  readonly enabled = true;
  readonly calls: { texts: string[]; inputType: EmbeddingInputType }[] = [];

  constructor(readonly dimensions = EMBEDDING_DIMENSIONS, private readonly failOnCall?: number) {}

  async embed(texts: string[], inputType: EmbeddingInputType): Promise<number[][]> {
    this.calls.push({ texts, inputType });
    if (this.calls.length === this.failOnCall) {
      throw new EmbeddingError('Voyage embeddings request failed (HTTP 503) (gave up after 4 attempts)', 503, true, 4);
    }
    return texts.map(text => fakeVector(text, this.dimensions));
  }

  get texts(): string[] {
    return this.calls.flatMap(c => c.texts);
  }
}

/** An enabled provider whose embed() is the given function. */
const providerWith = (embed: EmbeddingProvider['embed']): EmbeddingProvider =>
  ({ name: 'broken', model: 'broken-1', dimensions: EMBEDDING_DIMENSIONS, enabled: true, embed });

const fileEntry = (id: string) => loadLibraryFile().entries.find(e => e.id === id)!;

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

  it('builds the embedded text from the names, definition and tags', () => {
    const e = entry();
    expect(libraryEmbeddingText(e)).toBe(
      [e.name, e.nameAr, e.definition, 'Tags: fcs, food consumption, humanitarian, cash, in kind'].join('\n'),
    );
    expect(libraryEmbeddingText({ name: ' Only a name ', nameAr: '', definition: null, tags: [] })).toBe('Only a name');
    expect(libraryEmbeddingText({ name: 'N', tags: ['', ' a_b '] })).toBe('N\nTags: a b');
    // Other fields (unit, methods, notes…) are not embedded: changing them keeps the vector.
    expect(libraryEmbeddingText({ ...e, unit: 'count', notes: 'Changed' } as typeof e)).toBe(libraryEmbeddingText(e));
  });

  it('embeds reference text only: no phone numbers, ID numbers or email addresses', () => {
    for (const e of loadLibraryFile().entries) {
      expect(redactPersonalData(libraryEmbeddingText(e)).counts, e.id).toEqual({ phone: 0, idNumber: 0, email: 0 });
    }
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
    expect(first).toEqual({ created: 63, updated: 0, unchanged: 0, total: 63, version: '1.0.0', notInFile: [], ...NO_PROVIDER });
    expect(await prisma.indicatorLibraryEntry.count()).toBe(63);
    const before = await updatedAtById();

    await new Promise(r => setTimeout(r, 20));
    const second = await seedLibrary(prisma, { logger: silent });
    expect(second).toEqual({ created: 0, updated: 0, unchanged: 63, total: 63, version: '1.0.0', notInFile: [], ...NO_PROVIDER });
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

  const hasEmbedding = async (id: string) => {
    const [row] = await prisma.$queryRaw<{ hasEmbedding: boolean }[]>`
      SELECT embedding IS NOT NULL AS "hasEmbedding" FROM "IndicatorLibraryEntry" WHERE id = ${id}`;
    return row.hasEmbedding;
  };

  it('updates exactly the changed rows and keeps the embedding when the embedded text is unchanged', async () => {
    await prisma.indicatorLibraryEntry.update({ where: { id: 'FS-01' }, data: { unit: 'Edited by hand' } });
    await prisma.$executeRawUnsafe(
      `UPDATE "IndicatorLibraryEntry" SET embedding = array_fill(0.5, ARRAY[1024])::vector WHERE id = 'FS-01'`,
    );
    const before = await updatedAtById();

    const result = await seedLibrary(prisma, { logger: silent });
    expect(result).toMatchObject({ created: 0, updated: 1, unchanged: 62, ...NO_PROVIDER });

    const after = await updatedAtById();
    expect(after.get('FS-01')).toBeGreaterThan(before.get('FS-01')!);
    for (const [id, t] of before) if (id !== 'FS-01') expect(after.get(id)).toBe(t);
    expect((await prisma.indicatorLibraryEntry.findUniqueOrThrow({ where: { id: 'FS-01' } })).unit).toBe('percent');
    expect(await hasEmbedding('FS-01')).toBe(true);
  });

  it('clears a stale embedding when the embedded text changed, even without a provider', async () => {
    await prisma.indicatorLibraryEntry.update({ where: { id: 'FS-01' }, data: { name: 'Edited by hand' } });

    const result = await seedLibrary(prisma, { logger: silent });
    expect(result).toMatchObject({ created: 0, updated: 1, unchanged: 62, ...NO_PROVIDER });
    expect((await prisma.indicatorLibraryEntry.findUniqueOrThrow({ where: { id: 'FS-01' } })).name).toMatch(/Food Consumption Score/);
    // The vector was made for other text; it is cleared so it is never searched (the next seed with a key re-embeds it).
    expect(await hasEmbedding('FS-01')).toBe(false);
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
    expect(result).toEqual({ created: 1, updated: 0, unchanged: 62, total: 63, version: '1.0.0', notInFile: ['ZZ-99'], ...NO_PROVIDER });
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

describe.skipIf(!hasTestDatabase)('seedLibrary embeddings (database)', () => {
  const ALL_IDS = loadLibraryFile().entries.map(e => e.id);

  /** Stored vectors by id (entries without one are left out). */
  const storedVectors = async () => {
    const rows = await prisma.$queryRaw<{ id: string; vector: string }[]>`
      SELECT id, embedding::text AS vector FROM "IndicatorLibraryEntry" WHERE embedding IS NOT NULL ORDER BY id`;
    return new Map(rows.map(r => [r.id, JSON.parse(r.vector) as number[]]));
  };
  const embeddedCount = async () => (await storedVectors()).size;
  const updatedAtById = async () =>
    new Map((await prisma.indicatorLibraryEntry.findMany({ select: { id: true, updatedAt: true } })).map(r => [r.id, r.updatedAt.getTime()]));
  const textOf = (id: string) => libraryEmbeddingText(fileEntry(id));
  const clearAllEmbeddings = () => prisma.$executeRaw`UPDATE "IndicatorLibraryEntry" SET embedding = NULL`;

  beforeAll(async () => {
    await resetDatabase();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('embeds every entry with input type "document" and stores 1024-dimension vectors', async () => {
    const embeddings = new FakeEmbeddings();
    const result = await seedLibrary(prisma, { logger: silent, embeddings });

    expect(result).toEqual({
      created: 63, updated: 0, unchanged: 0, total: 63, version: '1.0.0', notInFile: [],
      embedded: 63, embeddingsSkipped: null, embeddingError: null,
    });
    expect(embeddings.calls).toHaveLength(1);
    expect(embeddings.calls[0].inputType).toBe('document');
    expect(embeddings.texts).toEqual([...ALL_IDS].sort().map(textOf));

    const stored = await storedVectors();
    expect([...stored.keys()].sort()).toEqual([...ALL_IDS].sort());
    for (const id of ALL_IDS) expect(stored.get(id), id).toEqual(fakeVector(textOf(id)));
    const dims = await prisma.$queryRaw<{ dims: number }[]>`
      SELECT DISTINCT vector_dims(embedding) AS dims FROM "IndicatorLibraryEntry"`;
    expect(dims).toEqual([{ dims: 1024 }]);
  });

  it('embeds nothing on a second run and leaves the rows alone', async () => {
    const before = await updatedAtById();
    const vectorsBefore = await storedVectors();
    const embeddings = new FakeEmbeddings();

    const result = await seedLibrary(prisma, { logger: silent, embeddings });

    expect(result).toMatchObject({ created: 0, updated: 0, unchanged: 63, embedded: 0, embeddingsSkipped: null, embeddingError: null });
    expect(embeddings.calls).toHaveLength(0);
    expect(await updatedAtById()).toEqual(before);
    expect(await storedVectors()).toEqual(vectorsBefore);
  });

  it('re-embeds an entry whose embedded text was updated, and only that entry', async () => {
    await prisma.indicatorLibraryEntry.update({ where: { id: 'FS-01' }, data: { name: 'Edited by hand' } });
    // Stands for the vector made from the hand-edited text.
    await prisma.$executeRawUnsafe(`UPDATE "IndicatorLibraryEntry" SET embedding = array_fill(0.5, ARRAY[1024])::vector WHERE id = 'FS-01'`);
    const vectorsBefore = await storedVectors();
    const embeddings = new FakeEmbeddings();

    const result = await seedLibrary(prisma, { logger: silent, embeddings });

    expect(result).toMatchObject({ created: 0, updated: 1, unchanged: 62, embedded: 1, embeddingError: null });
    expect(embeddings.texts).toEqual([textOf('FS-01')]);
    const after = await storedVectors();
    expect(after.get('FS-01')).toEqual(fakeVector(textOf('FS-01')));
    for (const id of ALL_IDS) if (id !== 'FS-01') expect(after.get(id), id).toEqual(vectorsBefore.get(id));
  });

  it('keeps the vector when only fields outside the embedded text change', async () => {
    await prisma.indicatorLibraryEntry.update({ where: { id: 'HE-01' }, data: { unit: 'Edited by hand', methods: ['kii'] } });
    const vectorBefore = (await storedVectors()).get('HE-01');
    const embeddings = new FakeEmbeddings();

    const result = await seedLibrary(prisma, { logger: silent, embeddings });

    expect(result).toMatchObject({ updated: 1, embedded: 0 });
    expect(embeddings.calls).toHaveLength(0);
    expect((await storedVectors()).get('HE-01')).toEqual(vectorBefore);
  });

  it('embeds entries whose vector is missing', async () => {
    await prisma.$executeRaw`UPDATE "IndicatorLibraryEntry" SET embedding = NULL WHERE id IN ('WA-02', 'WA-01')`;
    const embeddings = new FakeEmbeddings();

    const result = await seedLibrary(prisma, { logger: silent, embeddings });

    expect(result).toMatchObject({ updated: 0, unchanged: 63, embedded: 2 });
    expect(embeddings.texts).toEqual([textOf('WA-01'), textOf('WA-02')]);
    expect(await embeddedCount()).toBe(63);
  });

  it('re-embeds an entry edited while embeddings were off once a key is available', async () => {
    await prisma.indicatorLibraryEntry.update({ where: { id: 'FS-02' }, data: { definition: 'Edited by hand' } });

    const withoutKey = await seedLibrary(prisma, { logger: silent, embeddings: new NoopEmbeddingProvider() });
    expect(withoutKey).toMatchObject({ updated: 1, embedded: 0, embeddingsSkipped: 'VOYAGE_API_KEY is not set (keyword search is used)' });
    expect((await storedVectors()).has('FS-02')).toBe(false);

    const embeddings = new FakeEmbeddings();
    const withKey = await seedLibrary(prisma, { logger: silent, embeddings });
    expect(withKey).toMatchObject({ updated: 0, embedded: 1, embeddingsSkipped: null });
    expect(embeddings.texts).toEqual([textOf('FS-02')]);
    expect((await storedVectors()).get('FS-02')).toEqual(fakeVector(textOf('FS-02')));
  });

  it('re-embeds every entry with reembedAll', async () => {
    const embeddings = new FakeEmbeddings();
    const result = await seedLibrary(prisma, { logger: silent, embeddings, reembedAll: true });
    expect(result).toMatchObject({ unchanged: 63, embedded: 63 });
    expect(embeddings.texts).toHaveLength(63);
  });

  it('reports a provider failure without losing the content; the next run embeds what is missing', async () => {
    await clearAllEmbeddings();
    await prisma.indicatorLibraryEntry.update({ where: { id: 'FS-01' }, data: { name: 'Edited by hand' } });

    const failed = await seedLibrary(prisma, { logger: silent, embeddings: new FakeEmbeddings(EMBEDDING_DIMENSIONS, 1) });
    expect(failed).toMatchObject({
      updated: 1, embedded: 0, embeddingsSkipped: null,
      embeddingError: 'Voyage embeddings request failed (HTTP 503) (gave up after 4 attempts)',
    });
    expect((await prisma.indicatorLibraryEntry.findUniqueOrThrow({ where: { id: 'FS-01' } })).name).toMatch(/Food Consumption Score/);
    expect(await embeddedCount()).toBe(0);

    // Batches before a failure are kept.
    const partial = await embedLibraryEntries(prisma, new FakeEmbeddings(EMBEDDING_DIMENSIONS, 2), ALL_IDS, { batchSize: 20 });
    expect(partial).toEqual({ embedded: 20, error: 'Voyage embeddings request failed (HTTP 503) (gave up after 4 attempts)' });
    expect(await embeddedCount()).toBe(20);

    const embeddings = new FakeEmbeddings();
    const retried = await seedLibrary(prisma, { logger: silent, embeddings });
    expect(retried).toMatchObject({ updated: 0, embedded: 43, embeddingError: null });
    expect(await embeddedCount()).toBe(63);
  });

  it('stores nothing from a provider that returns unusable vectors', async () => {
    await clearAllEmbeddings();
    const cases: [EmbeddingProvider, RegExp][] = [
      [new FakeEmbeddings(512), /512-dimension vectors; the library column holds 1024/],
      [providerWith(async () => null), /returned no vectors/],
      [providerWith(async texts => texts.slice(1).map(t => fakeVector(t))), /returned 62 vectors for 63 entries/],
      [providerWith(async texts => texts.map(t => fakeVector(t, 3))), /has 3 dimensions \(expected 1024\)/],
      [providerWith(async texts => texts.map((t, i) => (i === 5 ? fakeVector(t).fill(Number.NaN, 2, 3) : fakeVector(t)))), /Vector value \[2\] is not a finite number/],
    ];
    for (const [embeddings, message] of cases) {
      const result = await seedLibrary(prisma, { logger: silent, embeddings });
      expect(result.embedded).toBe(0);
      expect(result.embeddingError).toMatch(message);
    }
    expect(await embeddedCount()).toBe(0);
  });

  it('embeds nothing and keeps embeddings NULL with the no-op provider (no network)', async () => {
    await resetDatabase();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const first = await seedLibrary(prisma, { logger: silent, embeddings: new NoopEmbeddingProvider() });
    expect(first).toEqual({
      created: 63, updated: 0, unchanged: 0, total: 63, version: '1.0.0', notInFile: [],
      embedded: 0, embeddingsSkipped: 'VOYAGE_API_KEY is not set (keyword search is used)', embeddingError: null,
    });
    expect(await embeddedCount()).toBe(0);
    expect((await seedLibrary(prisma, { logger: silent, embeddings: new NoopEmbeddingProvider(), reembedAll: true })).embedded).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('npm run seed:library', () => {
    const run = (args: string[]) => promisify(execFile)(
      path.resolve(__dirname, '../node_modules/.bin/tsx'),
      [path.resolve(__dirname, '../scripts/seed-library.ts'), ...args],
      // The test database and test settings from tests/setup.ts; no Voyage key, so nothing leaves the machine.
      { cwd: path.resolve(__dirname, '..'), env: { ...process.env, VOYAGE_API_KEY: '' }, timeout: 60_000 },
    );

    it('prints the counts and says why embeddings were skipped', async () => {
      const { stdout } = await run([]);
      expect(stdout).toContain('Indicator library 1.0.0: 63 entries (0 created, 0 updated, 63 unchanged)');
      expect(stdout).toContain('Embeddings skipped: VOYAGE_API_KEY is not set (keyword search is used)');
      expect(await embeddedCount()).toBe(0);
    }, 60_000);

    it('rejects unknown options', async () => {
      const failure = await run(['--everything']).then(() => null, (err: { code: number; stderr: string }) => err);
      expect(failure?.code).toBe(1);
      expect(failure?.stderr).toContain('unknown option --everything (the only option is --reembed)');
    }, 60_000);
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

  it('finds an entry whatever the case of the id, like libraryId on indicators', async () => {
    const lower = await request(app).get('/api/indicator-library/fs-01').set('Authorization', auth);
    expect(lower.status).toBe(200);
    expect(lower.body.id).toBe('FS-01');
    const padded = await request(app).get(`/api/indicator-library/${encodeURIComponent(' wa-01 ')}`).set('Authorization', auth);
    expect(padded.status).toBe(200);
    expect(padded.body.id).toBe('WA-01');
  });
});
