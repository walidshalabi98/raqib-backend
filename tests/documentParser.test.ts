import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { structuredOutputSchemaProblems } from './aiSchemaHelpers';
import { createOrgFixture, hasTestDatabase, OrgFixture, resetDatabase } from './helpers';

// Test the real parser; the AI client is mocked (never the SDK, never the network).
vi.unmock('../src/services/ai/documentParser');
const mocks = vi.hoisted(() => ({ generateStructured: vi.fn() }));
vi.mock('../src/services/ai/client', () => ({
  generateStructured: mocks.generateStructured,
  resolveModel: (tier: string) => (tier === 'fast' ? 'claude-haiku-5-5' : 'claude-sonnet-5-5'),
}));

import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { buildDocumentKey, getStorage } from '../src/services/storage';
import {
  chunkText,
  joinPdfTextItems,
  normalizeDocumentAnalysis,
  parseDocument,
  parsePdf,
  PdfTextItem,
  verifyDocumentAnalysis,
} from '../src/services/ai/documentParser';
import { AiRefusalError, AiRequestError } from '../src/services/ai/errors';
import { redactPersonalData, REDACTION_PLACEHOLDERS } from '../src/services/ai/redact';
import {
  DOCUMENT_ANALYSIS_MAX_CHARS,
  DOCUMENT_ANALYSIS_PROMPT_VERSION,
  DOCUMENT_ANALYSIS_SCHEMA,
  DOCUMENT_ANALYSIS_SYSTEM,
  DocumentAnalysisAnswer,
  documentAnalysisPrompt,
  truncateForPrompt,
} from '../src/services/ai/prompts/documentAnalysis';
import { BENEFICIARY_TABLE, tablePdf } from './pdfFixture';

const SERVED_MODEL = 'claude-haiku-5-5-20261001';

const ANSWER: DocumentAnalysisAnswer = {
  documentType: 'proposal',
  summary: 'A livelihoods project for women-headed households in Hebron.',
  keyFindings: ['Targets 1,200 households', '45% of participants are women'],
  indicatorsMentioned: ['% of households with a stable income'],
  targetsMentioned: [{ indicator: 'Households with a stable income', target: '22%', timeline: 'by December 2027' }],
  recommendations: ['Add sex disaggregation to the income indicator'],
};

function structuredResult(data: DocumentAnalysisAnswer) {
  return {
    data,
    model: SERVED_MODEL,
    promptVersion: DOCUMENT_ANALYSIS_PROMPT_VERSION,
    usage: { inputTokens: 4200, outputTokens: 350, cacheReadTokens: 9000, cacheWriteTokens: 0 },
    estimatedCostUsd: 0.006,
    aiCallId: 'ai-call-1',
  };
}

/** The document text between the <document> tags of a prompt. */
function documentPart(prompt: string): string {
  const match = /<document>\n([\s\S]*)\n<\/document>/.exec(prompt);
  if (!match) throw new Error('prompt has no <document> block');
  return match[1];
}

const ROWS = 400;
const idOf = (i: number) => String(400000000 + i);
const phoneOf = (i: number) => `059-${String(1000000 + i).slice(0, 3)}-${String(1000000 + i).slice(3)}`;
const emailOf = (i: number) => `person${i}@example.org`;

/** A beneficiary list (personal data in every row) and a targets sheet; well over 12 000 characters of text. */
async function buildWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const targets = workbook.addWorksheet('Targets');
  targets.addRow(['Indicator', 'Baseline', 'Target', 'Timeline']);
  targets.addRow(['Households with a stable income', '14%', '22%', 'December 2027']);
  targets.addRow(['Households reached', '0', '1,200', '2027']);
  targets.addRow(['Code', 'EU GERF 2.14', 'Grant ENI/2026/412345678', '2026-10-12']);
  const list = workbook.addWorksheet('Beneficiaries');
  list.addRow(['#', 'Full name', 'ID number', 'Phone', 'Email', 'Governorate', 'Phone 2']);
  for (let i = 0; i < ROWS; i++) {
    list.addRow([i + 1, `Participant ${i}`, Number(idOf(i)), phoneOf(i), emailOf(i), 'Hebron', `+970 2 298 ${String(1000 + i).slice(-4)}`]);
  }
  list.addRow(['', 'رقم الهوية', '٤٠١٢٣٤٥٦٧', '٠٥٦٩٨٧٦٥٤٣', 'sara@example.ps', 'الخليل', '']);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Captures everything written to the console while `fn` runs. */
async function captureConsole(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const record = (...args: unknown[]) => { lines.push(args.map(a => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' ')); };
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(record),
    vi.spyOn(console, 'warn').mockImplementation(record),
    vi.spyOn(console, 'error').mockImplementation(record),
  ];
  try {
    await fn().catch(() => undefined);
  } finally {
    spies.forEach(s => s.mockRestore());
  }
  return lines.join('\n');
}

/** Whether a text still holds anything from the fixture's personal data. */
function personalDataIn(text: string): string[] {
  const found: string[] = [];
  if (/@/.test(text)) found.push('email');
  if (/(?<!\d)40\d{7}(?!\d)/.test(text) || text.includes('٤٠١٢٣٤٥٦٧')) found.push('ID number');
  if (/059-\d{3}-\d{4}/.test(text) || /\+970 2 298/.test(text) || text.includes('٠٥٦٩٨٧٦٥٤٣')) found.push('phone');
  const leftover = redactPersonalData(text).counts;
  if (leftover.phone || leftover.idNumber || leftover.email) found.push(`redactable ${JSON.stringify(leftover)}`);
  return found;
}

// ---------------------------------------------------------------------------

describe('document analysis prompt and schema', () => {
  it('is a valid structured-output schema', () => {
    expect(structuredOutputSchemaProblems(DOCUMENT_ANALYSIS_SCHEMA)).toEqual([]);
  });

  it('accepts a complete answer and rejects a partial one', () => {
    expect(DOCUMENT_ANALYSIS_SCHEMA.safeParse(ANSWER).success).toBe(true);
    expect(DOCUMENT_ANALYSIS_SCHEMA.safeParse({ ...ANSWER, documentType: 'invoice' }).success).toBe(false);
    const { recommendations: _omitted, ...partial } = ANSWER;
    expect(DOCUMENT_ANALYSIS_SCHEMA.safeParse(partial).success).toBe(false);
  });

  it('has a versioned prompt that forbids invented figures and personal data', () => {
    expect(DOCUMENT_ANALYSIS_PROMPT_VERSION).toBe('document-analysis-v2');
    expect(DOCUMENT_ANALYSIS_SYSTEM).toMatch(/exactly as it is written/);
    expect(DOCUMENT_ANALYSIS_SYSTEM).toMatch(/Never estimate, calculate/);
    expect(DOCUMENT_ANALYSIS_SYSTEM).toMatch(/Never output names of people, phone numbers, ID numbers, email addresses or street addresses/);
    expect(DOCUMENT_ANALYSIS_SYSTEM).toMatch(/language of the document/);
    expect(DOCUMENT_ANALYSIS_SYSTEM).toMatch(/Modern Standard Arabic/);
    const prompt = documentAnalysisPrompt('Proposal text with a 22% target.', 'proposal.pdf');
    expect(prompt).toContain('FILE NAME: proposal.pdf');
    expect(prompt).toMatch(/Do not suggest target values/);
    expect(documentPart(prompt)).toBe('Proposal text with a 22% target.');
  });

  it('redacts the file name and sends at most 12 000 characters of text', () => {
    const prompt = documentAnalysisPrompt('x'.repeat(30_000), 'list 0599123456 ahmad@example.org 401234567.xlsx');
    expect(prompt).toContain(`FILE NAME: list ${REDACTION_PLACEHOLDERS.phone} ${REDACTION_PLACEHOLDERS.email} ${REDACTION_PLACEHOLDERS.idNumber}.xlsx`);
    expect(documentPart(prompt)).toHaveLength(DOCUMENT_ANALYSIS_MAX_CHARS);
    expect(DOCUMENT_ANALYSIS_MAX_CHARS).toBe(12_000);
  });

  it('does not split a surrogate pair when truncating', () => {
    const text = 'a'.repeat(DOCUMENT_ANALYSIS_MAX_CHARS - 1) + '📄' + 'tail';
    const cut = truncateForPrompt(text);
    expect(cut).toBe('a'.repeat(DOCUMENT_ANALYSIS_MAX_CHARS - 1));
    expect(truncateForPrompt('short')).toBe('short');
  });
});

describe('normalizeDocumentAnalysis', () => {
  it('trims, drops empty entries and removes personal data the model wrote anyway', () => {
    const result = normalizeDocumentAnalysis({
      documentType: 'report',
      summary: '  Coordinator reachable on 0599123456.  ',
      keyFindings: [' 1,200 households ', '', '   ', 'ID 401234567 was mentioned'],
      indicatorsMentioned: ['% of women in decision-making'],
      targetsMentioned: [
        { indicator: ' Income ', target: ' 22% ', timeline: '' },
        { indicator: '', target: '', timeline: '2027' },
      ],
      recommendations: ['Write to m.e@example.org'],
    });
    expect(result).toEqual({
      documentType: 'report',
      summary: `Coordinator reachable on ${REDACTION_PLACEHOLDERS.phone}.`,
      keyFindings: ['1,200 households', `ID ${REDACTION_PLACEHOLDERS.idNumber} was mentioned`],
      indicatorsMentioned: ['% of women in decision-making'],
      targetsMentioned: [{ indicator: 'Income', target: '22%', timeline: '' }],
      recommendations: [`Write to ${REDACTION_PLACEHOLDERS.email}`],
    });
  });

  it('caps list sizes and text lengths', () => {
    const result = normalizeDocumentAnalysis({
      ...ANSWER,
      summary: 'y'.repeat(5000),
      keyFindings: Array.from({ length: 50 }, (_, i) => `finding ${i}`),
      targetsMentioned: Array.from({ length: 50 }, (_, i) => ({ indicator: `ind ${i}`, target: `${i}%`, timeline: '' })),
    });
    expect(result.summary).toHaveLength(2000);
    expect(result.keyFindings).toHaveLength(20);
    expect(result.targetsMentioned).toHaveLength(20);
  });
});

describe('verifyDocumentAnalysis: figures checked against the document text', () => {
  const TEXT = [
    'Outcome 1: 22% of households have a stable income by December 2027 (baseline 14%, 2025).',
    'The project reaches 1,200 households in 3 governorates; 12.5 km of pipes. Grant ENI/2026/412345678.',
    'الهدف: ٤٥٪ من النساء، ١٬٥٠٠ أسرة',
    'Target\tHouseholds reached\t2500',
    '[phone removed]',
  ].join('\n');
  const answer = (over: Partial<DocumentAnalysisAnswer>): DocumentAnalysisAnswer => ({ ...ANSWER, summary: '', keyFindings: [], targetsMentioned: [], ...over });
  const target = (value: string) => ({ indicator: 'x', target: value, timeline: '' });
  const verified = (value: string) => verifyDocumentAnalysis(answer({ targetsMentioned: [target(value)] }), TEXT).targetsMentioned[0].verified;

  it('marks a target verified only when the document contains it', () => {
    expect(verified('22%')).toBe(true);
    expect(verified('22 %')).toBe(true);
    expect(verified('1,200')).toBe(true);
    expect(verified('1200')).toBe(true); // written with a thousands separator in the document
    expect(verified('1,200 households')).toBe(true);
    expect(verified('2,500 households')).toBe(true); // the figure is in a table cell; the unit is in its header
    expect(verified('22% by December 2027')).toBe(true);
    expect(verified('٢٢٪')).toBe(true);
    expect(verified('45%')).toBe(true); // written ٤٥٪ in the document
    expect(verified('1500')).toBe(true); // written ١٬٥٠٠
    expect(verified('80%')).toBe(false); // invented
    expect(verified('2%')).toBe(false); // "22%" holds "2%" but not as a whole number
    expect(verified('22% by 2030')).toBe(false); // every figure must be in the text
    expect(verified('1,2')).toBe(false); // a decimal comma: not the 1,200 of the document
    expect(verified('12,5 km')).toBe(true); // a decimal comma for the document's 12.5
    expect(verified('All governorates')).toBe(false);
    expect(verified('stable income')).toBe(true); // a target without figures must be written as given
    expect(verified('')).toBe(false);
  });

  it('lists numbers in the summary and key findings that the document does not contain', () => {
    const result = verifyDocumentAnalysis(answer({
      summary: 'Reaches 1,200 households (22%) and 950 youth; ٤٥٪ of women; 12.5 km; 80 % coverage.',
      keyFindings: ['Baseline 14% in 2025', 'Budget of 3,400,000 EUR', 'Covers 3 governorates and 7 schools', 'Reaches 950 youth'],
    }), TEXT);
    // Years (2025) and single-digit counts (3, 7) are not checked; each figure is listed once.
    expect(result.unverifiedFigures).toEqual(['950', '80 %', '3,400,000']);
    expect(result.summary).toBe('Reaches 1,200 households (22%) and 950 youth; ٤٥٪ of women; 12.5 km; 80 % coverage.');
  });

  it('keeps every entry (nothing is dropped) and lists at most 20 figures', () => {
    const many = Array.from({ length: 30 }, (_, i) => `${100 + i} items`);
    const result = verifyDocumentAnalysis(answer({ keyFindings: many, targetsMentioned: [target('80%'), target('22%')] }), TEXT);
    expect(result.keyFindings).toHaveLength(30);
    expect(result.targetsMentioned.map(t => t.verified)).toEqual([false, true]);
    expect(result.unverifiedFigures).toHaveLength(20);
  });

  it('is fast on a long document', () => {
    const long = `${TEXT}\n${'The project reached 1,250 households in 2026 with 45 schools. '.repeat(16_000)}`; // about 1 MB
    const started = Date.now();
    const result = verifyDocumentAnalysis(answer({
      summary: Array.from({ length: 20 }, (_, i) => `${1000 + i} people`).join(', '),
      targetsMentioned: Array.from({ length: 20 }, (_, i) => target(`${45 + i} schools`)),
    }), long);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.targetsMentioned[0].verified).toBe(true);
    expect(result.targetsMentioned[1].verified).toBe(false);
  });
});

describe('PDF text extraction', () => {
  /** A text item at (x, y) with the given width and a 10-point font. */
  const item = (str: string, x: number, y: number, width: number): PdfTextItem => ({ str, transform: [10, 0, 0, 10, x, y], width, height: 10 });

  it('separates items on the same line by a space or a tab, and lines by a line break', () => {
    expect(joinPdfTextItems([
      item('Ahmad Ali', 50, 700, 45),
      item('401234567', 160, 700, 45), // a table cell: wide gap
      item('0599123456', 260, 700, 50),
      item('Gaza', 380, 700, 20),
      item('Next', 50, 680, 20), // a new line
      item('word', 72.8, 680, 20), // a word gap (2.8 points)
      item('ing', 92.5, 680, 15), // touching: same word in another font
      item(' spaced', 108, 680, 30), // the space is already there
    ])).toBe('Ahmad Ali\t401234567\t0599123456\tGaza\nNext wording spaced');
  });

  it('separates right-to-left items and keeps a raised footnote mark on its line', () => {
    expect(joinPdfTextItems([
      item('أحمد علي', 500, 700, 40),
      item('٤٠١٢٣٤٥٦٨', 400, 700, 45),
      item('٠٥٩٩١٢٣٤٥٨', 300, 700, 50),
      item('1', 353, 703, 4),
    ])).toBe('أحمد علي\t٤٠١٢٣٤٥٦٨\t٠٥٩٩١٢٣٤٥٨ 1');
  });

  it('ignores empty and malformed items', () => {
    expect(joinPdfTextItems([item('', 50, 700, 0), { str: 'a' } as PdfTextItem, item('b', 80, 0, 5)])).toBe('a\tb');
  });

  it('keeps table cells apart in a real PDF, so every phone and ID number in the table is redacted (regression)', async () => {
    const pdf = tablePdf(BENEFICIARY_TABLE);
    // pdf-parse's own renderer runs the cells together, and nothing can be recognised.
    const pdfParse = (await import('pdf-parse')).default;
    const joined = (await pdfParse(new Uint8Array(pdf) as unknown as Buffer)).text;
    expect(joined).toContain('Ahmad Ali4012345670599123456Gaza');
    // Only the +970 number, alone in its cell's run, was found; the ID numbers and local mobiles were not.
    expect(redactPersonalData(joined).counts).toEqual({ phone: 1, idNumber: 0, email: 0 });

    const text = await parsePdf(pdf);
    expect(text).toContain('Ahmad Ali\t401234567\t0599123456\tGaza');
    const redacted = redactPersonalData(text);
    expect(redacted.counts).toEqual({ phone: 3, idNumber: 3, email: 0 });
    expect(redacted.text).toContain(`Sara Omar\t${REDACTION_PLACEHOLDERS.idNumber}\t${REDACTION_PLACEHOLDERS.phone}\tKhan Younis`);
    expect(redacted.text).toContain('target: 1,200 households by 2027');
    expect(personalDataIn(redacted.text)).toEqual([]);
  });

  it('parses each small PDF on its own (pdf.js must not read Node\'s shared buffer pool)', async () => {
    const first = tablePdf({ rows: [['first', 'file']], columns: [50, 120] });
    const second = tablePdf({ rows: [['second', 'file']], columns: [50, 120] });
    expect(second.byteOffset).toBeGreaterThan(0); // both share Node's buffer pool
    expect((await parsePdf(first)).trim()).toBe('first\tfile');
    expect((await parsePdf(second)).trim()).toBe('second\tfile');
  });
});

describe('chunkText', () => {
  it('splits text into overlapping chunks and always ends', () => {
    const text = 'abcdefghij'.repeat(300); // 3 000 characters
    const chunks = chunkText(text, 2000, 200);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(text.slice(0, 2000));
    expect(chunks[1]).toBe(text.slice(1800));
    expect(chunkText('short text')).toEqual(['short text']);
    expect(chunkText('')).toEqual([]);
    expect(chunkText('abcdef', 2, 5)).toEqual(['ab', 'bc', 'cd', 'de', 'ef']);
  });
});

// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDatabase)('parseDocument (stored file, mocked AI client)', () => {
  let a: OrgFixture;
  let workbook: Buffer;

  async function storeDocument(fileName: string, body: Buffer, extra: { parsedText?: string; aiAnalysis?: object } = {}) {
    const key = buildDocumentKey(a.project.id, fileName);
    await getStorage().put(key, body, 'application/octet-stream');
    return prisma.document.create({
      data: {
        projectId: a.project.id, uploadedBy: a.officer.id, fileName, fileUrl: key, fileType: 'other',
        fileSizeBytes: body.length, ...extra,
      },
    });
  }

  beforeAll(async () => {
    await resetDatabase();
    a = await createOrgFixture('docs');
    workbook = await buildWorkbook();
  });

  beforeEach(() => {
    mocks.generateStructured.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores redacted text, sends only redacted text to the model and stores the analysis', async () => {
    mocks.generateStructured.mockResolvedValue(structuredResult(ANSWER));
    const doc = await storeDocument('beneficiaries 0599123456.xlsx', workbook);

    const logs = await captureConsole(() => parseDocument(doc.id));

    const stored = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(stored.parsingStatus).toBe('completed');
    const text = stored.parsedText!;
    expect(personalDataIn(text)).toEqual([]);
    expect(text).toContain(REDACTION_PLACEHOLDERS.phone);
    expect(text).toContain(REDACTION_PLACEHOLDERS.idNumber);
    expect(text).toContain(REDACTION_PLACEHOLDERS.email);
    expect(text).not.toContain('---AI_ANALYSIS---');
    // Figures, dates and codes survive redaction.
    expect(text).toContain('Households with a stable income,14%,22%,December 2027');
    expect(text).toContain('"1,200"');
    expect(text).toContain('EU GERF 2.14');
    expect(text).toContain('Grant ENI/2026/412345678');
    expect(text).toContain('2026-10-12');
    expect(text.length).toBeGreaterThan(DOCUMENT_ANALYSIS_MAX_CHARS);

    expect(mocks.generateStructured).toHaveBeenCalledTimes(1);
    const params = mocks.generateStructured.mock.calls[0][0];
    expect(params).toMatchObject({
      feature: 'document.analysis',
      model: 'fast',
      effort: 'low',
      maxTokens: 4000,
      promptVersion: 'document-analysis-v2',
      system: DOCUMENT_ANALYSIS_SYSTEM,
      context: { organizationId: a.org.id, projectId: a.project.id },
    });
    expect(params.schema).toBe(DOCUMENT_ANALYSIS_SCHEMA);
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0].role).toBe('user');
    const prompt: string = params.messages[0].content;
    expect(personalDataIn(prompt)).toEqual([]);
    expect(prompt).not.toContain('0599123456');
    const sent = documentPart(prompt);
    expect(sent.length).toBeLessThanOrEqual(DOCUMENT_ANALYSIS_MAX_CHARS);
    expect(sent).toBe(text.slice(0, DOCUMENT_ANALYSIS_MAX_CHARS));

    const analysis = stored.aiAnalysis as Record<string, unknown>;
    expect(analysis).toMatchObject({ ...ANSWER, model: SERVED_MODEL, promptVersion: 'document-analysis-v2' });
    expect(new Date(analysis.analysedAt as string).toISOString()).toBe(analysis.analysedAt);
    // Checked against the redacted text: the 22% target is in the workbook; "45%" (a key finding) is not.
    expect(analysis.targetsMentioned).toEqual([{ ...ANSWER.targetsMentioned[0], verified: true }]);
    expect(analysis.unverifiedFigures).toEqual(['45%']);

    // Logs hold ids, counts and token numbers only.
    expect(logs).toContain(doc.id);
    expect(logs).toMatch(/removed \d+ phone numbers, \d+ ID numbers, \d+ email addresses/);
    expect(logs).toContain('4200 input / 350 output tokens');
    expect(personalDataIn(logs)).toEqual([]);
    expect(logs).not.toContain('Participant');
    expect(logs).not.toContain('beneficiaries');
    expect(logs).not.toContain(ANSWER.summary);
  });

  it('lists display fields, textLength and the checked aiAnalysis, never parsedText or the storage key', async () => {
    mocks.generateStructured.mockResolvedValue(structuredResult(ANSWER));
    const doc = await storeDocument('list.xlsx', workbook);
    await parseDocument(doc.id);
    const stored = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });

    const res = await request(app).get(`/api/projects/${a.project.id}/documents`).set('Authorization', a.officerAuth);
    expect(res.status).toBe(200);
    const listed = res.body.find((d: { id: string }) => d.id === doc.id);
    expect(Object.keys(listed).sort()).toEqual([
      'aiAnalysis', 'fileName', 'fileSizeBytes', 'fileType', 'id', 'parsingStatus', 'projectId', 'qualitativeSource',
      'textLength', 'uploadedAt', 'uploader',
    ]);
    expect(listed.parsingStatus).toBe('completed');
    expect(listed.textLength).toBe(stored.parsedText!.length);
    expect(listed.uploader).toEqual({ fullName: a.officer.fullName });
    expect(listed.aiAnalysis).toMatchObject({ documentType: 'proposal', summary: ANSWER.summary, model: SERVED_MODEL, promptVersion: 'document-analysis-v2' });
    expect(listed.aiAnalysis.targetsMentioned[0]).toEqual({ ...ANSWER.targetsMentioned[0], verified: true });
    expect(JSON.stringify(res.body)).not.toContain(stored.fileUrl);
    expect(JSON.stringify(res.body)).not.toContain('Participant');
    const fixture = res.body.find((d: { id: string }) => d.id === a.document.id);
    expect(fixture.aiAnalysis).toBeNull();
    expect(fixture.textLength).toBe(0);
  });

  it.each([
    ['a refusal', new AiRefusalError('document.analysis', null)],
    ['a failed request', new AiRequestError('document.analysis', 529, true, 4)],
    ['any other error', new Error('model said: call 0599123456 or ahmad@example.org')],
  ])('keeps the parsed text and status completed after %s, with aiAnalysis null', async (_label, error) => {
    mocks.generateStructured.mockRejectedValue(error);
    const doc = await storeDocument('failing.xlsx', workbook);

    const logs = await captureConsole(() => parseDocument(doc.id));

    const stored = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(stored.parsingStatus).toBe('completed');
    expect(stored.aiAnalysis).toBeNull();
    expect(personalDataIn(stored.parsedText!)).toEqual([]);
    expect(logs).toContain(`AI analysis failed for document ${doc.id}: ${error.name}`);
    expect(personalDataIn(logs)).toEqual([]);
  });

  it('resolves (does not throw) when the AI analysis fails', async () => {
    mocks.generateStructured.mockRejectedValue(new AiRefusalError('document.analysis', 'cyber'));
    const doc = await storeDocument('resolves.xlsx', workbook);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(parseDocument(doc.id)).resolves.toBeUndefined();
  });

  it('replaces a legacy row: no AI_ANALYSIS marker in parsedText and the old analysis cleared', async () => {
    mocks.generateStructured.mockRejectedValue(new AiRequestError('document.analysis', null, true, 4));
    const doc = await storeDocument('legacy.xlsx', workbook, {
      parsedText: 'old text 0599123456\n\n---AI_ANALYSIS---\n{"summary":"old","indicators_mentioned":[]}',
      aiAnalysis: { summary: 'stale analysis' },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await parseDocument(doc.id);

    const stored = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(stored.parsedText).not.toContain('---AI_ANALYSIS---');
    expect(stored.parsedText).not.toContain('old text');
    expect(stored.aiAnalysis).toBeNull();
  });

  it('does not call the model for a document with almost no text', async () => {
    const tiny = new ExcelJS.Workbook();
    tiny.addWorksheet('S').addRow(['ok']);
    const doc = await storeDocument('tiny.xlsx', Buffer.from(await tiny.xlsx.writeBuffer()));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await parseDocument(doc.id);

    const stored = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(stored.parsingStatus).toBe('completed');
    expect(stored.parsedText).toBe('--- Sheet: S ---\nok');
    expect(stored.aiAnalysis).toBeNull();
    expect(mocks.generateStructured).not.toHaveBeenCalled();
  });

  it('sets status failed and rethrows when the file cannot be parsed', async () => {
    const doc = await storeDocument('broken.xlsx', Buffer.from('this is not a zip file 0599123456'));

    let thrown: unknown;
    const logs = await captureConsole(() => parseDocument(doc.id).catch(err => { thrown = err; }));

    expect(thrown).toBeInstanceOf(Error);
    const stored = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(stored.parsingStatus).toBe('failed');
    expect(stored.parsedText).toBeNull();
    expect(stored.aiAnalysis).toBeNull();
    expect(mocks.generateStructured).not.toHaveBeenCalled();
    expect(logs).toContain(`Failed to parse document ${doc.id}`);
    expect(logs).not.toContain('0599123456');
  });

  it('sets status failed for an unsupported file type', async () => {
    const doc = await storeDocument('notes.txt', Buffer.from('plain text notes that are long enough to analyse, in theory'));

    let thrown: unknown;
    const logs = await captureConsole(() => parseDocument(doc.id).catch(err => { thrown = err; }));

    expect((thrown as Error).message).toBe('Unsupported file type: .txt');
    expect(logs).toContain('UnsupportedFileTypeError: Unsupported file type: .txt');
    const stored = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(stored.parsingStatus).toBe('failed');
    expect(mocks.generateStructured).not.toHaveBeenCalled();
  });

  it('stores a PDF table with its phone and ID numbers removed', async () => {
    mocks.generateStructured.mockResolvedValue(structuredResult(ANSWER));
    const doc = await storeDocument('annex 2.pdf', tablePdf(BENEFICIARY_TABLE));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await parseDocument(doc.id);

    const stored = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(stored.parsingStatus).toBe('completed');
    expect(personalDataIn(stored.parsedText!)).toEqual([]);
    expect(stored.parsedText).toContain(`Ahmad Ali\t${REDACTION_PLACEHOLDERS.idNumber}\t${REDACTION_PLACEHOLDERS.phone}\tGaza`);
    expect(stored.parsedText).not.toMatch(/0599|40[1-3]\d{6}|912 345/);
    const prompt: string = mocks.generateStructured.mock.calls[0][0].messages[0].content;
    expect(personalDataIn(prompt)).toEqual([]);
  });

  it('stores a qualitative transcript redacted but never sends it for document analysis', async () => {
    const doc = await storeDocument('fgd.xlsx', workbook);
    await prisma.document.update({ where: { id: doc.id }, data: { qualitativeSource: true } });

    const logs = await captureConsole(() => parseDocument(doc.id));

    const stored = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(stored.parsingStatus).toBe('completed');
    expect(stored.parsedText!.length).toBeGreaterThan(DOCUMENT_ANALYSIS_MAX_CHARS);
    expect(personalDataIn(stored.parsedText!)).toEqual([]);
    expect(stored.aiAnalysis).toBeNull();
    expect(mocks.generateStructured).not.toHaveBeenCalled();
    expect(logs).toContain(`Document ${doc.id} is a qualitative transcript`);
  });

  it('refuses a Word 97–2003 (.doc) file: only .docx can be read', async () => {
    const doc = await storeDocument('old.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));

    let thrown: unknown;
    await captureConsole(() => parseDocument(doc.id).catch(err => { thrown = err; }));

    expect((thrown as Error).message).toBe('Unsupported file type: .doc');
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).parsingStatus).toBe('failed');
    expect(mocks.generateStructured).not.toHaveBeenCalled();
  });

  it('rejects an unknown document id', async () => {
    await expect(parseDocument('00000000-0000-0000-0000-000000000000')).rejects.toThrow(/not found/);
  });
});
