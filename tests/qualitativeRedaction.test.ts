import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { codeQualitativeEntry } from '../src/services/ai/qualitativeCoder';
import { REDACTION_PLACEHOLDERS } from '../src/services/ai/redact';
import { describeRedactions, redactQualitativeFields } from '../src/services/qualitative/redactEntry';
import { createOrgFixture, hasTestDatabase, OrgFixture, resetDatabase } from './helpers';

const P = REDACTION_PLACEHOLDERS.phone;
const I = REDACTION_PLACEHOLDERS.idNumber;
const E = REDACTION_PLACEHOLDERS.email;

// Made-up numbers and addresses only.
const NOTE = {
  entryType: 'kii_notes',
  title: 'KII Beit Ummar, call back on 0599123456',
  content: [
    'The respondent gave her ID 401234567 and asked for a reply to someone@example.org.',
    'قالت المستفيدة إن رقم هاتفها ٠٥٦٩٨٧٦٥٤٣ ورقم هويتها ٤٠١٢٣٤٥٦٧، وإن التوزيع تأخر أسبوعين.',
    'Target: 1,200 households by 31/12/2027 (EU GERF 2.14).',
  ].join('\n'),
  location: 'Beit Ummar, office 02-298-1234',
  facilitator: 'Sara (sara.k@example.org)',
};
/** Every piece of personal data in NOTE, as typed. */
const PERSONAL = ['0599123456', '401234567', 'someone@example.org', '٠٥٦٩٨٧٦٥٤٣', '٤٠١٢٣٤٥٦٧', '02-298-1234', 'sara.k@example.org'];
/** Words of the note that must never reach a log line. */
const NOTE_WORDS = ['Beit Ummar', 'respondent', 'المستفيدة', 'Sara', 'households'];

describe('redactQualitativeFields', () => {
  it('redacts the four text fields, sums the counts and leaves other values as they are', () => {
    const { values, counts } = redactQualitativeFields({ ...NOTE, participants: 12, assessmentId: undefined });
    expect(values).toEqual({
      entryType: 'kii_notes',
      participants: 12,
      assessmentId: undefined,
      title: `KII Beit Ummar, call back on ${P}`,
      content: [
        `The respondent gave her ID ${I} and asked for a reply to ${E}.`,
        `قالت المستفيدة إن رقم هاتفها ${P} ورقم هويتها ${I}، وإن التوزيع تأخر أسبوعين.`,
        'Target: 1,200 households by 31/12/2027 (EU GERF 2.14).',
      ].join('\n'),
      location: `Beit Ummar, office ${P}`,
      facilitator: `Sara (${E})`,
    });
    expect(counts).toEqual({ phone: 3, idNumber: 2, email: 2 });
    expect(describeRedactions(counts)).toBe('removed 3 phone numbers, 2 ID numbers, 2 email addresses');
  });

  it('keeps null and missing fields', () => {
    expect(redactQualitativeFields({ title: 'Plain', content: 'Text', location: null })).toEqual({
      values: { title: 'Plain', content: 'Text', location: null },
      counts: { phone: 0, idNumber: 0, email: 0 },
    });
  });
});

describe.skipIf(!hasTestDatabase)('POST /api/projects/:id/qualitative: notes are redacted when saved', () => {
  let a: OrgFixture;
  const post = (body: Record<string, unknown>) =>
    request(app).post(`/api/projects/${a.project.id}/qualitative`).set('Authorization', a.officerAuth).send(body);

  beforeAll(async () => {
    await resetDatabase();
    a = await createOrgFixture('notes');
  });

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(codeQualitativeEntry).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Every console line written during the test, joined. */
  const consoleText = () =>
    [console.log, console.warn, console.error].flatMap(fn => vi.mocked(fn).mock.calls.map(args => args.map(String).join(' '))).join('\n');

  it('stores and returns the redacted entry with the counts, and logs ids and counts only', async () => {
    const res = await post(NOTE);
    expect(res.status).toBe(201);

    const stored = await prisma.qualitativeEntry.findUniqueOrThrow({ where: { id: res.body.id } });
    const expected = redactQualitativeFields(NOTE).values;
    expect(stored).toMatchObject({
      title: expected.title, content: expected.content, location: expected.location, facilitator: expected.facilitator,
    });
    expect(stored.content).toContain('Target: 1,200 households by 31/12/2027 (EU GERF 2.14).');

    // The response is the stored row plus the counts (numbers only).
    expect(res.body).toMatchObject({
      id: stored.id, title: stored.title, content: stored.content, location: stored.location, facilitator: stored.facilitator,
    });
    expect(res.body.redactions).toEqual({ phone: 3, idNumber: 2, email: 2 });

    for (const value of PERSONAL) {
      expect(JSON.stringify(stored)).not.toContain(value);
      expect(JSON.stringify(res.body)).not.toContain(value);
    }

    // Coded from the stored (redacted) entry.
    expect(codeQualitativeEntry).toHaveBeenCalledWith(stored.id, a.project.id);

    // One line, with the entry id and the counts; never the text.
    expect(vi.mocked(console.log).mock.calls).toEqual([
      [`[Qualitative] Entry ${stored.id}: removed 3 phone numbers, 2 ID numbers, 2 email addresses`],
    ]);
    const logged = consoleText();
    for (const value of [...PERSONAL, ...NOTE_WORDS, P, I, E]) expect(logged).not.toContain(value);
  });

  it('logs nothing and returns zero counts when there is nothing to remove', async () => {
    const res = await post({ entryType: 'field_notes', title: 'Distribution day', content: 'ملاحظات ميدانية: 120 أسرة استلمت المساعدات في 2026.' });
    expect(res.status).toBe(201);
    expect(res.body.redactions).toEqual({ phone: 0, idNumber: 0, email: 0 });
    expect(res.body.content).toBe('ملاحظات ميدانية: 120 أسرة استلمت المساعدات في 2026.');
    expect(console.log).not.toHaveBeenCalled();
  });

  it('accepts null or missing location and facilitator', async () => {
    const res = await post({ entryType: 'field_notes', title: 'Visit', content: 'Notes', location: null });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ location: null, facilitator: null });
  });

  it.each([
    [{ title: 42 }, 'title and content must be text'],
    [{ title: ['KII', '0599123456'] }, 'title and content must be text'],
    [{ content: { text: 'ID 401234567' } }, 'title and content must be text'],
    [{ content: 401234567 }, 'title and content must be text'],
    [{ location: 401234567 }, 'location must be text'],
    [{ location: ['Hebron'] }, 'location must be text'],
    [{ facilitator: { email: 'someone@example.org' } }, 'facilitator must be text'],
    [{ facilitator: true }, 'facilitator must be text'],
  ])('refuses %j with 400 and stores nothing', async (override, message) => {
    const before = await prisma.qualitativeEntry.count();
    const res = await post({ ...NOTE, ...override });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(message);
    expect(await prisma.qualitativeEntry.count()).toBe(before);
    expect(codeQualitativeEntry).not.toHaveBeenCalled();
  });

  it('still requires entryType, title and content', async () => {
    const res = await post({ entryType: 'field_notes', title: '', content: 'Notes' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('entryType, title, and content are required');
  });

  it('leaves entries saved earlier unchanged', async () => {
    const earlier = await prisma.qualitativeEntry.create({
      data: { projectId: a.project.id, entryType: 'field_notes', title: 'Earlier 0599123456', content: 'ID 401234567' },
    });
    expect((await post(NOTE)).status).toBe(201);
    expect(await prisma.qualitativeEntry.findUniqueOrThrow({ where: { id: earlier.id } })).toMatchObject({
      title: 'Earlier 0599123456', content: 'ID 401234567',
    });
  });

  it("cannot save into another organisation's project", async () => {
    const b = await createOrgFixture('notes-b');
    const res = await request(app).post(`/api/projects/${b.project.id}/qualitative`).set('Authorization', a.officerAuth).send(NOTE);
    expect(res.status).toBe(404);
    expect(await prisma.qualitativeEntry.count({ where: { projectId: b.project.id, entryType: 'kii_notes' } })).toBe(0);
  });
});
