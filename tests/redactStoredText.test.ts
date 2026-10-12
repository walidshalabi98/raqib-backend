import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { redactPersonalData, REDACTION_PLACEHOLDERS, type RedactionCounts } from '../src/services/ai/redact';
import {
  missingColumns,
  missingPhase3Columns,
  PHASE3_SQL_FILE,
  planDocumentRedaction,
  RedactBackfillRefused,
  redactJsonText,
  redactStoredText,
  runRedactStoredTextCli,
} from '../src/services/maintenance/redactStoredText';
import { createOrgFixture, hasTestDatabase, resetDatabase } from './helpers';
import { NEGATIVES, POSITIVES } from './redactExamples';

const P = REDACTION_PLACEHOLDERS.phone;
const I = REDACTION_PLACEHOLDERS.idNumber;
const E = REDACTION_PLACEHOLDERS.email;
const NONE: RedactionCounts = { phone: 0, idNumber: 0, email: 0 };
const counts = (phone: number, idNumber: number, email: number): RedactionCounts => ({ phone, idNumber, email });

/** The example strings that tests/redact.test.ts checks (the POSITIVES inputs and the NEGATIVES), from tests/redactExamples.ts. */
function redactTestExamples(): string[] {
  expect(POSITIVES.length).toBeGreaterThan(50);
  expect(NEGATIVES.length).toBeGreaterThan(20);
  return [...POSITIVES.map(([input]) => input), ...NEGATIVES];
}

/** A small seeded generator, so the generated cases are the same on every run. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] };
}

const SEPARATORS = ['', '', ' ', '/', '-', '.', '_', ',', '\n', '\t', '(', ')', '+', '@', ':', '،', 'و', 'ID', 'x', '%'];
const WORDS = ['0599123456', '401234567', 'someone@example.org', '٠٥٦٩٨٧٦٥٤٣', '٤٠١٢٣٤٥٦٧', '+970 2 298 1234', 'هوية', 'Tel', 'ENI/2026', '2026', '05', '9', P, I, E];

/** Strings made of pieces of the examples, words and separators, joined in random order. */
function generatedMixes(examples: string[], count: number): string[] {
  const r = random(20261012);
  const piece = () => {
    const example = r.pick(examples);
    const start = Math.floor(r.next() * example.length);
    return r.next() < 0.5 ? example : example.slice(start, start + 1 + Math.floor(r.next() * 20));
  };
  return Array.from({ length: count }, () => {
    let text = '';
    const parts = 2 + Math.floor(r.next() * 6);
    for (let i = 0; i < parts; i++) text += (r.next() < 0.6 ? piece() : r.pick(WORDS)) + r.pick(SEPARATORS);
    return text;
  });
}

describe('redactPersonalData is idempotent (the backfill relies on it)', () => {
  const examples = redactTestExamples();

  it.each([
    ['the examples of tests/redactExamples.ts', examples],
    ['generated mixes of them', generatedMixes(examples, 3000)],
  ])('redacting the redacted text again changes nothing: %s', (_name, inputs) => {
    const failures = inputs.filter(input => {
      const once = redactPersonalData(input);
      const twice = redactPersonalData(once.text);
      return twice.text !== once.text || twice.counts.phone + twice.counts.idNumber + twice.counts.email > 0;
    });
    expect(failures).toEqual([]);
  });
});

/** Reference for redactJsonText: walks a parsed value, redacting every string that is not a key. */
function walk(value: unknown, total: RedactionCounts): unknown {
  if (typeof value === 'string') {
    const r = redactPersonalData(value);
    total.phone += r.counts.phone;
    total.idNumber += r.counts.idNumber;
    total.email += r.counts.email;
    return r.text;
  }
  if (Array.isArray(value)) return value.map(v => walk(v, total));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, total)]));
  return value;
}

describe('redactJsonText', () => {
  it('redacts string values only: keys, numbers (digit for digit), booleans and null stay as stored', () => {
    const json =
      '{"ar": "هاتف ٠٥٩٩١٢٣٤٥٦", "ok": true, "big": 12345678901234567890, "dec": 1.50, "id": 401234567, "list": ["ID 401234567", ' +
      '["write to someone@example.org"], {"q": "\\"quoted\\" 0599123456\\n"}], "none": null, "someone@example.org": "key kept", "summary": "Plain"}';
    const result = redactJsonText(json);
    expect(result.text).toBe(
      `{"ar": "هاتف ${P}", "ok": true, "big": 12345678901234567890, "dec": 1.50, "id": 401234567, "list": ["ID ${I}", ` +
      `["write to ${E}"], {"q": "\\"quoted\\" ${P}\\n"}], "none": null, "someone@example.org": "key kept", "summary": "Plain"}`,
    );
    expect(result.counts).toEqual(counts(2, 1, 1));
  });

  it('returns the text unchanged when no string holds personal data', () => {
    for (const json of ['{}', '[]', 'null', '"text"', '401234567', '{"a": [1, 2, {"b": "ENI/2026/412345678"}]}', '{"0599123456": 1}']) {
      expect(redactJsonText(json)).toEqual({ text: json, counts: NONE });
    }
  });

  it('gives the same result as walking the parsed value, for generated JSON in any layout', () => {
    const r = random(7);
    const strings = [...WORDS, 'Budget 1,200,000 EUR', 'Target 45%', 'He said "call 0599123456"', 'line\nbreak 401234567', 'tab\there', '\\ back', '📄 0599123456', ''];
    const value = (depth: number): unknown => {
      const kind = depth > 3 ? r.next() * 4 : r.next() * 6;
      if (kind < 2) return r.pick(strings) + r.pick(SEPARATORS) + r.pick(strings);
      if (kind < 3) return r.pick([0, 401234567, -1.5, 1e21, 599123456]);
      if (kind < 4) return r.pick([true, false, null]);
      if (kind < 5) return Array.from({ length: Math.floor(r.next() * 4) }, () => value(depth + 1));
      return Object.fromEntries(Array.from({ length: Math.floor(r.next() * 4) }, () => [r.pick(strings), value(depth + 1)]));
    };
    for (let n = 0; n < 500; n++) {
      const original = value(0);
      for (const json of [JSON.stringify(original), JSON.stringify(original, null, 2), JSON.stringify(original, null, '\t')]) {
        const expected = counts(0, 0, 0);
        const result = redactJsonText(json);
        expect(JSON.parse(result.text)).toEqual(walk(JSON.parse(json), expected));
        expect(result.counts).toEqual(expected);
        expect(redactJsonText(result.text)).toEqual({ text: result.text, counts: NONE });
      }
    }
  });
});

describe('planDocumentRedaction', () => {
  it('changes nothing in empty columns', () => {
    expect(planDocumentRedaction({ parsedText: null, aiAnalysis: null })).toEqual({
      next: { parsedText: null, aiAnalysis: null }, parsedText: NONE, aiAnalysis: NONE, legacyMarker: false, legacyAnalysisNoLongerJson: false,
    });
  });

  it('redacts a legacy parsedText that still holds "---AI_ANALYSIS---" as plain text, and reports a legacy analysis that stops being JSON', () => {
    const parsedText = 'Text 0599123456\n\n---AI_ANALYSIS---\n{"summary": "Call 0599123456", "beneficiaryId": 401234567}';
    expect(planDocumentRedaction({ parsedText, aiAnalysis: null })).toEqual({
      next: { parsedText: `Text ${P}\n\n---AI_ANALYSIS---\n{"summary": "Call ${P}", "beneficiaryId": ${I}}`, aiAnalysis: null },
      parsedText: counts(2, 1, 0),
      aiAnalysis: NONE,
      legacyMarker: true,
      legacyAnalysisNoLongerJson: true,
    });
    // A number inside a string keeps the JSON valid.
    const quoted = planDocumentRedaction({ parsedText: 'Text\n---AI_ANALYSIS---\n{"summary": "ID 401234567"}', aiAnalysis: null });
    expect(quoted).toMatchObject({ legacyMarker: true, legacyAnalysisNoLongerJson: false, parsedText: counts(0, 1, 0) });
    // A legacy analysis that was not JSON (cut off) is reported only as legacy.
    expect(planDocumentRedaction({ parsedText: 'T\n---AI_ANALYSIS---\n{"summary": 401234567', aiAnalysis: null }))
      .toMatchObject({ legacyMarker: true, legacyAnalysisNoLongerJson: false });
  });
});

// ---------------------------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------------------------

/** A pre-Phase 3 proposal: unredacted text, and an analysis with personal data in its strings. */
const LEGACY_TEXT = 'Proposal for Beit Ummar schools. Coordinator Amal: 0599123456, ID 401234567, someone@example.org. Target: 1,200 households by 31/12/2027.';
const LEGACY_ANALYSIS =
  '{"summary": "Contact someone@example.org", "key_findings": ["Call ٠٥٦٩٨٧٦٥٤٣", "Budget 1,200,000 EUR"], ' +
  '"targets_mentioned": [{"text": "ID 401234567", "value": 123456789}], "total": 12345678901234567890, "verified": true, "note": null}';
const ARABIC_TEXT = 'رقم الهوية: ٤٠١٢٣٤٥٦٧ للمستفيدة، هاتف ٠٥٩٩١٢٣٤٥٦، والتوزيع في بيت أمر.';
const MARKER_TEXT = 'Report on Dura 0599123456\n\n---AI_ANALYSIS---\n{"summary": "Call 0599123456", "beneficiaryId": 401234567}';
const ENTRY = {
  title: 'KII with Amal 0599123456',
  content: 'She gave her ID 401234567 and someone@example.org. وقالت إن هاتفها ٠٥٦٩٨٧٦٥٤٣',
  location: 'Beit Ummar',
  facilitator: 'facilitator@example.org',
};
const FILE_NAME = 'Proposal Amal 0599654321.pdf';
/** Everything that must never reach the output: personal data, words of the texts, file names. */
const NEVER_PRINTED = [
  '0599123456', '401234567', 'someone@example.org', '٠٥٦٩٨٧٦٥٤٣', '٤٠١٢٣٤٥٦٧', '٠٥٩٩١٢٣٤٥٦', 'facilitator@example.org', '0599654321',
  'Beit Ummar', 'بيت أمر', 'Amal', 'Dura', 'Proposal', 'proposal.pdf', 'Budget', 'households', P, I, E,
];

interface Seeded {
  legacy: string;
  clean: string;
  arabic: string;
  marker: string;
  analysisOnly: string;
  entry: string;
}

async function seed(): Promise<Seeded> {
  await resetDatabase();
  const a = await createOrgFixture('backfill'); // one clean document (no text) and one clean entry
  const doc = async (fileName: string, parsedText: string | null, aiAnalysis: string | null) => {
    const d = await prisma.document.create({
      data: { projectId: a.project.id, uploadedBy: a.officer.id, fileName, fileUrl: `${a.project.id}/${fileName}`, fileType: 'proposal', parsedText },
    });
    // Raw, so the stored jsonb keeps numbers that a JavaScript number cannot hold.
    if (aiAnalysis !== null) await prisma.$executeRaw`UPDATE "Document" SET "aiAnalysis" = ${aiAnalysis}::jsonb WHERE "id" = ${d.id}`;
    return d.id;
  };
  const seeded = {
    legacy: await doc(FILE_NAME, LEGACY_TEXT, LEGACY_ANALYSIS),
    // Stored since Phase 3: already redacted; a number value is kept.
    clean: await doc('report.pdf', `Clean text, call ${P}.`, '{"summary": "No personal data", "beneficiaries": 401234567}'),
    arabic: await doc('تقرير.pdf', ARABIC_TEXT, null),
    marker: await doc('report-dura.pdf', MARKER_TEXT, null),
    analysisOnly: await doc('scan.pdf', null, '{"legacyText": "Phone 0599123456"}'),
    entry: '',
  };
  seeded.entry = (await prisma.qualitativeEntry.create({ data: { projectId: a.project.id, entryType: 'kii_notes', ...ENTRY } })).id;
  return seeded;
}

const documentsNow = () => prisma.$queryRaw<{ id: string; fileName: string; parsedText: string | null; aiAnalysis: string | null }[]>`
  SELECT "id", "fileName", "parsedText", "aiAnalysis"::text AS "aiAnalysis" FROM "Document" ORDER BY "id"`;
const entriesNow = () => prisma.qualitativeEntry.findMany({
  orderBy: { id: 'asc' }, select: { id: true, title: true, content: true, location: true, facilitator: true },
});
const documentNow = async (id: string) => (await documentsNow()).find(d => d.id === id)!;

function captured() {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line), out: { log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) } };
}

/** Totals of the seeded rows (see seed()). */
const DOCUMENT_TOTALS = {
  scanned: 6, parsedText: 3, aiAnalysis: 2, legacyMarker: 1, legacyAnalysisNoLongerJson: 1,
  // legacy: text 1/1/1, analysis 1/1/1; arabic 1/1/0; marker 2/1/0; analysisOnly 1/0/0
  counts: counts(6, 4, 2),
};
const ENTRY_TOTALS = { scanned: 2, fields: { title: 1, content: 1, location: 0, facilitator: 1 }, counts: counts(2, 1, 2) };

/** A client that throws if the backfill touches the database at all. */
const untouchable = new Proxy({}, {
  get(_target, prop) {
    throw new Error(`the database was used (${String(prop)})`);
  },
}) as PrismaClient;

/**
 * The shared test client, except that `meanwhile` runs once, right after the backfill has read row `id`
 * of `table`: as if a user or the parser wrote the row between the backfill's read and its write.
 */
function writesAfterRowRead(table: 'Document' | 'QualitativeEntry', id: string, meanwhile: () => Promise<unknown>): PrismaClient {
  let done = false;
  const once = async <T>(rows: T): Promise<T> => {
    if (!done) {
      done = true;
      await meanwhile();
    }
    return rows;
  };
  const bound = <T extends object>(target: T, prop: PropertyKey) => {
    const value = Reflect.get(target, prop);
    return typeof value === 'function' ? value.bind(target) : value;
  };
  return new Proxy(prisma, {
    get(target, prop) {
      if (table === 'Document' && prop === '$queryRaw') {
        return (query: TemplateStringsArray, ...values: unknown[]) => {
          const result = target.$queryRaw(query, ...values);
          return query.join('').includes('"parsedText"') && values.includes(id) ? result.then(once) : result;
        };
      }
      if (table === 'QualitativeEntry' && prop === 'qualitativeEntry') {
        return new Proxy(target.qualitativeEntry, {
          get(delegate, method) {
            if (method === 'findUnique') {
              return (args: Parameters<typeof delegate.findUnique>[0]) =>
                args.where.id === id ? delegate.findUnique(args).then(once) : delegate.findUnique(args);
            }
            return bound(delegate, method);
          },
        });
      }
      return bound(target, prop);
    },
  }) as PrismaClient;
}

describe.skipIf(!hasTestDatabase)('redaction backfill (database)', () => {
  let s: Seeded;

  beforeEach(async () => {
    s = await seed();
  });

  it('dry run: reports what would change and changes nothing', async () => {
    const documentsBefore = await documentsNow();
    const entriesBefore = await entriesNow();
    const { lines, log } = captured();

    const report = await redactStoredText({ prisma, batchSize: 2, log });

    expect(report).toEqual({
      apply: false,
      documents: { ...DOCUMENT_TOTALS, found: 4, changed: 0, skipped: 0 },
      qualitative: null,
    });
    expect(lines).toEqual([]);
    expect(await documentsNow()).toEqual(documentsBefore);
    expect(await entriesNow()).toEqual(entriesBefore);

    const withEntries = await redactStoredText({ prisma, includeQualitative: true, log });
    expect(withEntries.qualitative).toEqual({ ...ENTRY_TOTALS, found: 1, changed: 0, skipped: 0 });
    expect(await entriesNow()).toEqual(entriesBefore);
  });

  it('apply: redacts parsedText and the strings of aiAnalysis, keeps everything else, and a second run changes nothing', async () => {
    const before = await documentsNow();
    const report = await redactStoredText({ prisma, apply: true, batchSize: 2, log: () => undefined });
    expect(report.documents).toEqual({ ...DOCUMENT_TOTALS, found: 4, changed: 4, skipped: 0 });

    const legacy = await documentNow(s.legacy);
    expect(legacy.parsedText).toBe(`Proposal for Beit Ummar schools. Coordinator Amal: ${P}, ID ${I}, ${E}. Target: 1,200 households by 31/12/2027.`);
    expect(legacy.aiAnalysis).toBe(
      `{"note": null, "total": 12345678901234567890, "summary": "Contact ${E}", "verified": true, "key_findings": ["Call ${P}", "Budget 1,200,000 EUR"], ` +
      `"targets_mentioned": [{"text": "ID ${I}", "value": 123456789}]}`,
    );
    expect(legacy.fileName).toBe(FILE_NAME);
    expect((await documentNow(s.arabic)).parsedText).toBe(`رقم الهوية: ${I} للمستفيدة، هاتف ${P}، والتوزيع في بيت أمر.`);
    expect((await documentNow(s.marker)).parsedText).toBe(`Report on Dura ${P}\n\n---AI_ANALYSIS---\n{"summary": "Call ${P}", "beneficiaryId": ${I}}`);
    expect(await documentNow(s.analysisOnly)).toMatchObject({ parsedText: null, aiAnalysis: `{"legacyText": "Phone ${P}"}` });
    // Rows without personal data are not written at all.
    expect(await documentNow(s.clean)).toEqual(before.find(d => d.id === s.clean));
    // Qualitative entries are left alone without --include-qualitative.
    expect((await entriesNow()).find(e => e.id === s.entry)).toMatchObject(ENTRY);

    const after = await documentsNow();
    const again = await redactStoredText({ prisma, apply: true, includeQualitative: false, log: () => undefined });
    expect(again.documents).toEqual({
      scanned: 6, found: 0, changed: 0, skipped: 0, parsedText: 0, aiAnalysis: 0, legacyMarker: 1, legacyAnalysisNoLongerJson: 0, counts: NONE,
    });
    expect(await documentsNow()).toEqual(after);
  });

  it('--include-qualitative: redacts existing entries too, and a second run changes nothing', async () => {
    const report = await redactStoredText({ prisma, apply: true, includeQualitative: true, log: () => undefined });
    expect(report.qualitative).toEqual({ ...ENTRY_TOTALS, found: 1, changed: 1, skipped: 0 });
    expect((await entriesNow()).find(e => e.id === s.entry)).toEqual({
      id: s.entry,
      title: `KII with Amal ${P}`,
      content: `She gave her ID ${I} and ${E}. وقالت إن هاتفها ${P}`,
      location: 'Beit Ummar',
      facilitator: E,
    });

    const entries = await entriesNow();
    const again = await redactStoredText({ prisma, apply: true, includeQualitative: true, log: () => undefined });
    expect(again.qualitative).toEqual({ scanned: 2, found: 0, changed: 0, skipped: 0, fields: { title: 0, content: 0, location: 0, facilitator: 0 }, counts: NONE });
    expect(await entriesNow()).toEqual(entries);
  });

  /** The legacy row's analysis as seeded, as Postgres prints the jsonb (keys sorted by length, then bytes). */
  async function seededLegacyAnalysis(): Promise<string> {
    const [row] = await prisma.$queryRaw<{ value: string }[]>`SELECT ${LEGACY_ANALYSIS}::jsonb::text AS value`;
    return row.value;
  }

  it('skips a document written between read and write, says to run again, and the next run redacts it', async () => {
    const reparsed = 'Parsed again by an old API: call 0569876543.';
    const client = writesAfterRowRead('Document', s.legacy, () =>
      prisma.document.update({ where: { id: s.legacy }, data: { parsedText: reparsed } }));
    const { lines, out } = captured();

    expect(await runRedactStoredTextCli(client, ['--apply'], { DATABASE_URL: 'postgresql://unused' }, out)).toBe(0);

    // Not overwritten: the newer text stays, with the analysis as it was.
    expect(await documentNow(s.legacy)).toMatchObject({ parsedText: reparsed, aiAnalysis: await seededLegacyAnalysis() });
    // Written: the Arabic document (1 phone, 1 ID), the marker document (2 phone, 1 ID) and the analysis-only one (1 phone).
    expect(lines).toContain('Documents: 6 scanned, 3 changed (parsedText 2, aiAnalysis 1), 1 skipped; removed: 4 phone numbers, 2 ID numbers, 0 email addresses.');
    expect(lines).toContain('1 row(s) changed while the script ran and were not written: run the script again.');

    const next = await redactStoredText({ prisma, apply: true, log: () => undefined });
    expect(next.documents).toMatchObject({ found: 1, changed: 1, skipped: 0, counts: counts(2, 1, 1) });
    expect((await documentNow(s.legacy)).parsedText).toBe(`Parsed again by an old API: call ${P}.`);
  });

  it('skips a qualitative entry edited between read and write', async () => {
    const edited = 'Edited meanwhile: ID 402345678';
    const client = writesAfterRowRead('QualitativeEntry', s.entry, () =>
      prisma.qualitativeEntry.update({ where: { id: s.entry }, data: { content: edited } }));
    const report = await redactStoredText({ prisma: client, apply: true, includeQualitative: true, log: () => undefined });
    expect(report.qualitative).toMatchObject({ found: 1, changed: 0, skipped: 1, counts: NONE });
    expect((await entriesNow()).find(e => e.id === s.entry)).toMatchObject({ ...ENTRY, content: edited });

    const next = await redactStoredText({ prisma, apply: true, includeQualitative: true, log: () => undefined });
    expect(next.qualitative).toMatchObject({ changed: 1, skipped: 0, counts: counts(1, 1, 1) });
  });

  it('refuses to start without the Phase 3 columns, naming the SQL file, before touching any row', async () => {
    const checkSchema = async () => ['Document.aiAnalysis'];
    await expect(redactStoredText({ prisma: untouchable, apply: true, checkSchema })).rejects.toThrow(RedactBackfillRefused);
    await expect(redactStoredText({ prisma: untouchable, checkSchema })).rejects.toThrow(
      `Document.aiAnalysis is missing: this database does not have the Phase 3 schema. Apply ${PHASE3_SQL_FILE} first (docs/DATA_MODEL.md §9), then run this again. Nothing was changed.`,
    );

    const before = await documentsNow();
    const { lines, out } = captured();
    expect(await runRedactStoredTextCli(prisma, ['--apply'], { DATABASE_URL: 'postgresql://unused' }, out, { checkSchema })).toBe(1);
    expect(lines.at(-1)).toContain(PHASE3_SQL_FILE);
    expect(await documentsNow()).toEqual(before);
  });

  it('finds missing columns in the database schema', async () => {
    expect(await missingPhase3Columns(prisma)).toEqual([]);
    expect(await missingColumns(prisma, ['Document.aiAnalysis', 'Document.noSuchColumn', 'NoSuchTable.id', 'QualitativeEntry.facilitator']))
      .toEqual(['Document.noSuchColumn', 'NoSuchTable.id']);
  });

  it('prints totals and, with --verbose, ids only: never text, model output, notes or file names', async () => {
    const { lines, out } = captured();
    const env = { DATABASE_URL: 'postgresql://unused' };
    expect(await runRedactStoredTextCli(prisma, ['--include-qualitative', '--verbose'], env, out)).toBe(0);
    expect(await runRedactStoredTextCli(prisma, ['--apply', '--include-qualitative', '--verbose'], env, out)).toBe(0);
    expect(await runRedactStoredTextCli(prisma, ['--apply', '--include-qualitative'], env, out)).toBe(0);

    expect(lines.length).toBeGreaterThan(10);
    const printed = lines.join('\n');
    for (const value of NEVER_PRINTED) expect(printed).not.toContain(value);
    // Every row line names a row by id, then field names and numbers.
    const rowLines = lines.filter(line => line.startsWith('  ') && !line.includes('legacy'));
    expect(rowLines).toHaveLength(10); // 5 rows (4 documents, 1 entry) in the dry run and in the first apply
    for (const line of rowLines) {
      expect(line).toMatch(/^ {2}(document|qualitative entry) [0-9a-f-]{36}: [a-zA-Z, ]+ \(\d+ phone, \d+ ID, \d+ email\)$/);
    }
  });

  it('CLI: dry run by default, with a backup reminder and the totals', async () => {
    const { lines, out } = captured();
    expect(await runRedactStoredTextCli(prisma, [], { DATABASE_URL: 'postgresql://unused' }, out)).toBe(0);
    expect(lines).toEqual([
      'Redact stored text: dry run, nothing is written. Take a backup of the database before running with --apply.',
      'Documents: 6 scanned, 4 would change (parsedText 3, aiAnalysis 2); to remove: 6 phone numbers, 4 ID numbers, 2 email addresses.',
      "  1 document(s) still hold a legacy '---AI_ANALYSIS---' analysis in parsedText; it is redacted as plain text. In 1 of them that analysis no longer parses as JSON afterwards (a bare 9-digit number became a placeholder), so readers use the document text instead.",
      'Qualitative entries: not included (add --include-qualitative to redact existing entries too).',
      'Dry run: nothing was changed. Take a backup, then run again with --apply to write these changes.',
    ]);

    const applied = captured();
    expect(await runRedactStoredTextCli(prisma, ['--apply', '--include-qualitative'], { DATABASE_URL: 'postgresql://unused' }, applied.out)).toBe(0);
    expect(applied.lines).toEqual([
      'Redact stored text: --apply writes the changes. Make sure a backup of this database was taken first (on Supabase: a recent backup or a pg_dump).',
      'Documents: 6 scanned, 4 changed (parsedText 3, aiAnalysis 2), 0 skipped; removed: 6 phone numbers, 4 ID numbers, 2 email addresses.',
      "  1 document(s) still hold a legacy '---AI_ANALYSIS---' analysis in parsedText; it is redacted as plain text. In 1 of them that analysis no longer parses as JSON afterwards (a bare 9-digit number became a placeholder), so readers use the document text instead.",
      'Qualitative entries: 2 scanned, 1 changed (title 1, content 1, location 0, facilitator 1), 0 skipped; removed: 2 phone numbers, 1 ID numbers, 2 email addresses.',
    ]);

    const second = captured();
    expect(await runRedactStoredTextCli(prisma, ['--include-qualitative'], { DATABASE_URL: 'postgresql://unused' }, second.out)).toBe(0);
    expect(second.lines.at(-1)).toBe('Dry run: nothing was changed, and there is nothing to change.');
  });

  it('CLI: refuses unknown arguments and a missing DATABASE_URL before using the database', async () => {
    const unknown = captured();
    expect(await runRedactStoredTextCli(untouchable, ['--apply', '--force'], { DATABASE_URL: 'postgresql://unused' }, unknown.out)).toBe(1);
    expect(unknown.lines).toEqual(['Redact stored text: unknown argument --force (options: --apply, --include-qualitative, --verbose)']);

    for (const DATABASE_URL of [undefined, '', '   ']) {
      const missing = captured();
      expect(await runRedactStoredTextCli(untouchable, ['--apply'], { DATABASE_URL }, missing.out)).toBe(1);
      expect(missing.lines).toEqual(['Redact stored text: DATABASE_URL is required (set it in .env or the environment). Nothing was changed.']);
    }
  });

  it('CLI: reports a database error by class name only, with exit code 1', async () => {
    const failing = new Proxy(prisma, {
      get(target, prop) {
        if (prop === '$queryRaw') return () => Promise.reject(Object.assign(new Error('value "0599123456" violates something'), { name: 'PrismaClientKnownRequestError', code: 'P2010' }));
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as PrismaClient;
    const { lines, out } = captured();
    expect(await runRedactStoredTextCli(failing, [], { DATABASE_URL: 'postgresql://unused' }, out)).toBe(1);
    expect(lines.at(-1)).toBe('Redact stored text failed: PrismaClientKnownRequestError (P2010). Rows written before the error stay redacted; run the script again.');
    expect(lines.join('\n')).not.toContain('0599123456');
  });

  it('runs as a script with DATABASE_URL alone (exit code 0), and exits with 1 without it', async () => {
    // A fresh directory, so no .env file can fill in settings.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'raqib-redact-backfill-'));
    const run = (env: Record<string, string | undefined>) => promisify(execFile)(
      path.resolve(__dirname, '../node_modules/.bin/tsx'),
      [path.resolve(__dirname, '../scripts/redact-stored-text.ts'), '--include-qualitative'],
      { cwd, env: { PATH: process.env.PATH, NODE_ENV: 'production', ...env }, timeout: 60_000 },
    );
    try {
      const { stdout } = await run({ DATABASE_URL: process.env.TEST_DATABASE_URL });
      expect(stdout).toContain('Documents: 6 scanned, 4 would change (parsedText 3, aiAnalysis 2)');
      expect(stdout).toContain('Qualitative entries: 2 scanned, 1 would change');
      for (const value of NEVER_PRINTED) expect(stdout).not.toContain(value);

      await expect(run({})).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('DATABASE_URL is required'),
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 120_000);
});
