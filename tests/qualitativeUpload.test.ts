import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrgFixture, hasTestDatabase, OrgFixture, PDF_BYTES, resetDatabase } from './helpers';
import { tablePdf } from './pdfFixture';

// The real parser runs; the AI client is mocked (never the SDK, never the network). Qualitative
// coding stays mocked by tests/setup.ts.
vi.unmock('../src/services/ai/documentParser');
const mocks = vi.hoisted(() => ({ generateStructured: vi.fn() }));
vi.mock('../src/services/ai/client', () => ({
  generateStructured: mocks.generateStructured,
  resolveModel: (tier: string) => (tier === 'fast' ? 'claude-haiku-5-5' : 'claude-sonnet-5-5'),
}));

import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { codeQualitativeEntry } from '../src/services/ai/qualitativeCoder';
import { REDACTION_PLACEHOLDERS } from '../src/services/ai/redact';

const P = REDACTION_PLACEHOLDERS.phone;
const I = REDACTION_PLACEHOLDERS.idNumber;

/** An FGD transcript: personal data in the text, and the old analysis marker quoted in it. */
const TRANSCRIPT = tablePdf({
  lines: [
    'Focus group discussion, Hebron, women-headed households, 12 participants.',
    'Facilitator: participants were reminded they can call the hotline 0599123456 at any time.',
    'P3: My ID is 401234567 and I registered in March but did not receive the cash transfer.',
    'P5: The notice said ---AI_ANALYSIS--- in the subject line, then: the distribution moved to Sunday.',
    'P7: Water trucking comes twice a week; we buy the rest.',
  ],
  rows: [],
  columns: [],
});

/** The qualitative entry created from an uploaded document (its attachments name the document). */
async function entryFor(documentId: string) {
  const entries = await prisma.qualitativeEntry.findMany();
  return entries.find(e => JSON.stringify(e.attachments ?? null).includes(documentId)) ?? null;
}

async function waitFor<T>(find: () => Promise<T | null>): Promise<T> {
  const until = Date.now() + 10_000;
  for (;;) {
    const found = await find();
    if (found) return found;
    if (Date.now() > until) throw new Error('timed out waiting for the upload to be processed');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe.skipIf(!hasTestDatabase)('qualitative transcript upload', () => {
  let a: OrgFixture;

  beforeAll(async () => {
    await resetDatabase();
    a = await createOrgFixture('qual');
  });

  beforeEach(() => {
    mocks.generateStructured.mockReset();
    vi.mocked(codeQualitativeEntry).mockClear();
  });

  it('stores the transcript as a qualitative source: redacted, coded with its entry, never analysed as a document', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const res = await request(app)
      .post(`/api/projects/${a.project.id}/qualitative/upload`)
      .set('Authorization', a.officerAuth)
      .field('entryType', 'fgd_transcript')
      .field('participants', '12')
      .attach('file', TRANSCRIPT, { filename: 'FGD Hebron 0599654321.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ documentId: expect.any(String), status: 'processing' });

    const entry = await waitFor(() => entryFor(res.body.documentId));
    const document = await prisma.document.findUniqueOrThrow({ where: { id: res.body.documentId } });

    expect(document.qualitativeSource).toBe(true);
    expect(document.parsingStatus).toBe('completed');
    expect(document.aiAnalysis).toBeNull();
    expect(mocks.generateStructured).not.toHaveBeenCalled();

    // The entry holds the redacted transcript, whole: the quoted marker does not cut it.
    expect(entry.content).toBe(document.parsedText);
    expect(entry.content).toContain(`call the hotline ${P} at any time`);
    expect(entry.content).toContain(`My ID is ${I} and`);
    expect(entry.content).toContain('---AI_ANALYSIS--- in the subject line, then: the distribution moved to Sunday.');
    expect(entry.content).toContain('Water trucking comes twice a week');
    expect(entry.content).not.toMatch(/0599|401234567/);
    expect(entry.title).toBe(`Transcript: FGD Hebron ${P}.pdf`);
    expect(entry.participants).toBe(12);
    expect(entry.attachments).toEqual([{ documentId: document.id, fileName: 'FGD Hebron 0599654321.pdf' }]);

    await waitFor(async () => vi.mocked(codeQualitativeEntry).mock.calls.length > 0 || null);
    expect(codeQualitativeEntry).toHaveBeenCalledWith(entry.id, a.project.id);

    // Listed with the project's documents, marked as a qualitative source, without its text.
    const list = await request(app).get(`/api/projects/${a.project.id}/documents`).set('Authorization', a.officerAuth);
    const listed = list.body.find((d: { id: string }) => d.id === document.id);
    expect(listed).toMatchObject({ qualitativeSource: true, aiAnalysis: null, textLength: document.parsedText!.length });
    expect(listed).not.toHaveProperty('parsedText');
  });

  it('creates no entry when the file cannot be parsed', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const before = await prisma.qualitativeEntry.count({ where: { projectId: a.project.id } });

    const res = await request(app)
      .post(`/api/projects/${a.project.id}/qualitative/upload`)
      .set('Authorization', a.officerAuth)
      .attach('file', PDF_BYTES, { filename: 'broken.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(202);

    const document = await waitFor(async () => {
      const doc = await prisma.document.findUnique({ where: { id: res.body.documentId } });
      return doc?.parsingStatus === 'failed' ? doc : null;
    });
    expect(document.qualitativeSource).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(await prisma.qualitativeEntry.count({ where: { projectId: a.project.id } })).toBe(before);
    expect(await entryFor(document.id)).toBeNull();
    expect(mocks.generateStructured).not.toHaveBeenCalled();
  });

  it('refuses Word 97–2003 (.doc) transcripts with advice', async () => {
    const res = await request(app)
      .post(`/api/projects/${a.project.id}/qualitative/upload`)
      .set('Authorization', a.officerAuth)
      .attach('file', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), { filename: 'fgd.doc', contentType: 'application/msword' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Save it as \.docx or a text-based PDF/);
  });
});
