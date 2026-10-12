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
import { chunkText, normalizeDocumentAnalysis, parseDocument } from '../src/services/ai/documentParser';
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

    // Logs hold ids, counts and token numbers only.
    expect(logs).toContain(doc.id);
    expect(logs).toMatch(/removed \d+ phone numbers, \d+ ID numbers, \d+ email addresses/);
    expect(logs).toContain('4200 input / 350 output tokens');
    expect(personalDataIn(logs)).toEqual([]);
    expect(logs).not.toContain('Participant');
    expect(logs).not.toContain('beneficiaries');
    expect(logs).not.toContain(ANSWER.summary);
  });

  it('returns aiAnalysis and the redacted text in the project document list', async () => {
    mocks.generateStructured.mockResolvedValue(structuredResult(ANSWER));
    const doc = await storeDocument('list.xlsx', workbook);
    await parseDocument(doc.id);

    const res = await request(app).get(`/api/projects/${a.project.id}/documents`).set('Authorization', a.officerAuth);
    expect(res.status).toBe(200);
    const listed = res.body.find((d: { id: string }) => d.id === doc.id);
    expect(listed.parsingStatus).toBe('completed');
    expect(listed.aiAnalysis).toMatchObject({ documentType: 'proposal', summary: ANSWER.summary, model: SERVED_MODEL, promptVersion: 'document-analysis-v2' });
    expect(personalDataIn(listed.parsedText)).toEqual([]);
    const fixture = res.body.find((d: { id: string }) => d.id === a.document.id);
    expect(fixture.aiAnalysis).toBeNull();
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

  it('rejects an unknown document id', async () => {
    await expect(parseDocument('00000000-0000-0000-0000-000000000000')).rejects.toThrow(/not found/);
  });
});
