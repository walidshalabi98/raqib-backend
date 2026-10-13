import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The real pipeline: context, retrieval on the seeded library, the real client.ts with a fake SDK, validation and
// persistence (BUILD_GUIDE §7.1 "KPI suggestion runs end to end with the AI mocked"; design 7.5).
vi.unmock('../src/services/kpi/pipeline');
vi.mock('../src/services/kpi/availability', async importOriginal => {
  const original = await importOriginal<typeof import('../src/services/kpi/availability')>();
  return { ...original, kpiAssistantStatus: vi.fn(() => ({ ...original.kpiAssistantStatus(), aiConfigured: true })) };
});

import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { configureAiClientForTests, resetAiClientForTests, resolveModel } from '../src/services/ai/client';
import { outputJsonSchema } from '../src/services/ai/outputSchema';
import { KPI_SUGGESTIONS_SCHEMA } from '../src/services/ai/prompts/kpi';
import { seedLibrary } from '../src/services/library/seed';
import type { KpiModelAnswer, KpiRawSuggestion } from '../src/services/kpi/types';
import { fakeSdk, libraryEntry, promptSection, rawFromEntry, rawMessage, refusalMessage, suggestForLines } from './aiFakes';
import { bearer, hasTestDatabase, resetDatabase } from './helpers';

const PHONE = '0599 123 456';
const PROJECT_DATES = { startDate: '2026-02-01', endDate: '2027-07-31' };

/** The candidate ids of each SUGGEST FOR line, standard entries first (so rank 1 is a library indicator with a standard). */
function standardFirst(ids: string[]): string[] {
  return [...ids].sort((a, b) => Number(!libraryEntry(a).standardReference) - Number(!libraryEntry(b).standardReference));
}

/** Answers from the prompt: two candidates per result (copied from the library), optionally changed by `tweak`. */
function answerFromPrompt(body: Record<string, any>, tweak?: (s: KpiRawSuggestion, index: number) => KpiRawSuggestion): KpiModelAnswer {
  const lines = suggestForLines(body.messages[0].content as string);
  const suggestions = lines.flatMap(line => standardFirst(line.candidates).slice(0, 2)
    .map(id => rawFromEntry(libraryEntry(id), line.code, { level: line.level as KpiRawSuggestion['level'] })));
  return { suggestions: tweak ? suggestions.map(tweak) : suggestions, frameworkWarnings: [] };
}

describe.skipIf(!hasTestDatabase)('KPI suggestion runs end to end with the AI mocked (design 7.5)', () => {
  let auth: string;
  let organizationId: string;
  let projectId: string;
  let frameworkId: string;
  let o1: { id: string };
  let o2: { id: string };
  const post = (path: string, body: object) => request(app).post(path).set('Authorization', auth).send(body);
  const get = (path: string) => request(app).get(path).set('Authorization', auth);
  const suggestPath = () => `/api/projects/${projectId}/kpi-suggestions`;

  async function pollUntilDone(runId: string) {
    let body: any;
    await vi.waitFor(async () => {
      body = (await get(`/api/kpi-suggestion-runs/${runId}`)).body;
      expect(body.run.status).not.toBe('running');
    }, { timeout: 15_000, interval: 50 });
    return body;
  }

  beforeAll(async () => {
    await resetDatabase();
    await seedLibrary(prisma, { logger: { warn: () => undefined } });
    configureAiClientForTests({ sleep: async () => undefined });
    const org = await prisma.organization.create({
      data: { name: 'Org job', type: 'local_ngo', country: 'Palestine', city: 'Gaza', contactEmail: 'job@example.org' },
    });
    organizationId = org.id;
    const officer = await prisma.user.create({
      data: { organizationId: org.id, email: 'me-job@example.org', passwordHash: 'x', fullName: 'Officer job', role: 'me_officer' },
    });
    auth = bearer(officer);
    const project = await prisma.project.create({
      data: {
        organizationId: org.id, name: 'Water and hygiene for displaced households', sector: 'wash', sectors: ['wash'], donor: 'EU',
        donorType: 'eu', startDate: new Date(PROJECT_DATES.startDate), endDate: new Date(PROJECT_DATES.endDate),
        description: `Water trucking and water point repairs. Field contact ${PHONE}.`,
      },
    });
    projectId = project.id;
    const framework = await prisma.framework.create({ data: { projectId, version: 1 } });
    frameworkId = framework.id;
    o1 = await prisma.resultNode.create({
      data: { frameworkId, level: 'outcome', code: 'O1', text: 'Displaced households have reliable access to safe drinking water', sortOrder: 1 },
    });
    o2 = await prisma.resultNode.create({
      data: { frameworkId, level: 'outcome', code: 'O2', text: 'Target households practise safe hygiene, including handwashing with soap', sortOrder: 2 },
    });
    await prisma.document.create({
      data: {
        projectId, uploadedBy: officer.id, fileName: 'baseline-assessment.pdf', fileUrl: `projects/${projectId}/baseline.pdf`, fileType: 'proposal',
        parsingStatus: 'completed',
        parsedText: [
          'Baseline assessment of water access, March 2026.',
          'The household survey found that 22.5% of households had access to safe water within 30 minutes.',
          `Contact the field coordinator on ${PHONE} for the raw data.`,
          'The action will rehabilitate 18 community water points.',
        ].join('\n'),
      },
    });
  });

  afterAll(() => {
    resetAiClientForTests();
  });

  it('result scope on an outcome → 200 with ranked pending suggestions; accept → an ai_suggested indicator visible in the framework (under 2 s)', async () => {
    const sdk = fakeSdk(body => rawMessage(body.model, answerFromPrompt(body)));
    configureAiClientForTests({ anthropic: sdk.client });
    const started = Date.now();

    const res = await post(suggestPath(), { scope: 'result', resultId: o1.id });
    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({ status: 'completed', step: 'done', scope: 'result', retrieval: 'keyword', model: resolveModel('main'), promptVersion: 'kpi-v1' });
    expect(res.body.suggestions.length).toBeGreaterThanOrEqual(2);
    expect(res.body.suggestions.map((s: any) => s.sortOrder)).toEqual(res.body.suggestions.map((_: unknown, i: number) => i + 1));
    expect(res.body.suggestions.every((s: any) => s.resultId === o1.id && s.status === 'pending' && Array.isArray(s.warnings) && s.draft.resultId === o1.id)).toBe(true);

    // One main-tier kpi.suggest request with the structured-output schema; nothing personal in it or in storage.
    expect(sdk.sent).toHaveLength(1);
    expect(sdk.sent[0].body.model).toBe(resolveModel('main'));
    expect(sdk.sent[0].body.output_config.format).toEqual({ type: 'json_schema', schema: outputJsonSchema(KPI_SUGGESTIONS_SCHEMA) });
    const sentText = JSON.stringify(sdk.sent);
    expect(sentText).not.toContain(PHONE);
    expect(sentText).not.toContain('0599123456');
    expect(sentText).toContain('22.5%');
    const stored = await prisma.kpiSuggestion.findMany({ where: { projectId } });
    expect(JSON.stringify(stored)).not.toContain(PHONE);
    const calls = await prisma.aiCall.findMany({ where: { projectId } });
    expect(calls.map(c => [c.feature, c.status, c.organizationId, c.promptVersion])).toEqual([['kpi.suggest', 'success', organizationId, 'kpi-v1']]);

    const first = res.body.suggestions[0];
    const accepted = await post(`/api/kpi-suggestions/${first.id}/accept`, {});
    expect(accepted.status).toBe(201);
    const framework = await get(`/api/projects/${projectId}/framework`);
    expect(Date.now() - started).toBeLessThan(2000);

    const indicator = await prisma.indicator.findUniqueOrThrow({ where: { id: accepted.body.indicator.id } });
    expect(indicator).toMatchObject({
      provenance: 'ai_suggested', libraryId: first.libraryId, standardReferenceCode: first.draft.standardReferenceCode, aiModel: resolveModel('main'),
      promptVersion: 'kpi-v1', resultId: o1.id, level: 'outcome', isApproved: false,
    });
    expect(first.libraryId).toMatch(/^[A-Z]{2}-\d{2}$/);
    expect(indicator.standardReferenceCode).toEqual(expect.stringMatching(/\S/));
    expect(indicator.startDate?.toISOString().slice(0, 10)).toBe(PROJECT_DATES.startDate);
    expect(indicator.endDate?.toISOString().slice(0, 10)).toBe(PROJECT_DATES.endDate);
    for (const field of ['indicatorTextAr', 'definition', 'unit', 'direction', 'meansOfVerification', 'baselineMethod', 'targetJustification', 'assumptions', 'responsibility'] as const) {
      expect(indicator[field], field).toEqual(expect.stringMatching(/\S/));
    }
    expect(indicator.baselineMethod).toContain('Baseline date: to be confirmed.');
    expect(indicator.targetJustification).toContain('Intermediate targets: to be confirmed after the baseline.');
    expect(framework.body.indicators.map((i: any) => i.id)).toContain(indicator.id);
  });

  it('framework scope → 202; polling the run reaches completed with suggestions for every outcome', async () => {
    const sdk = fakeSdk(body => rawMessage(body.model, answerFromPrompt(body)));
    configureAiClientForTests({ anthropic: sdk.client });
    const res = await post(suggestPath(), { scope: 'framework' });
    expect(res.status).toBe(202);
    const done = await pollUntilDone(res.body.run.id);
    expect(done.run).toMatchObject({ status: 'completed', scope: 'framework' });
    expect(new Set(done.suggestions.map((s: any) => s.resultCode))).toEqual(new Set(['O1', 'O2']));
    const run = await prisma.kpiSuggestionRun.findUniqueOrThrow({ where: { id: res.body.run.id } });
    expect(run.modelCalls).toBe(sdk.sent.length);
    expect(run.inputTokens).toBeGreaterThan(0);
  });

  it('after a not_relevant rejection the next run\'s candidates and answers exclude that library id; only that result\'s older cards expire', async () => {
    const pendingO1 = await prisma.kpiSuggestion.findMany({ where: { projectId, resultId: o1.id, status: 'pending', libraryId: { not: null } }, orderBy: { createdAt: 'asc' } });
    const pendingO2Before = await prisma.kpiSuggestion.findMany({ where: { projectId, resultId: o2.id, status: 'pending' } });
    expect(pendingO1.length).toBeGreaterThan(0);
    expect(pendingO2Before.length).toBeGreaterThan(0);
    const rejected = pendingO1[0];
    expect((await post(`/api/kpi-suggestions/${rejected.id}/reject`, { reason: 'not_relevant', note: 'Not for this context' })).status).toBe(200);

    // A model that tries to use the rejected id anyway.
    const sdk = fakeSdk(body => {
      const answer = answerFromPrompt(body);
      answer.suggestions.push(rawFromEntry(libraryEntry(rejected.libraryId!), 'O1', { name: 'Rejected entry, suggested again' }));
      return rawMessage(body.model, answer);
    });
    configureAiClientForTests({ anthropic: sdk.client });
    const res = await post(suggestPath(), { scope: 'result', resultId: o1.id });
    expect(res.status).toBe(200);
    const candidates = promptSection(sdk.sent[0].body.messages[0].content, 'CANDIDATES');
    expect(candidates).not.toMatch(new RegExp(`^${rejected.libraryId} `, 'm'));
    expect(suggestForLines(sdk.sent[0].body.messages[0].content)[0].candidates).not.toContain(rejected.libraryId);
    expect(res.body.suggestions.map((s: any) => s.libraryId)).not.toContain(rejected.libraryId);
    expect(res.body.run.frameworkWarnings.map((w: any) => w.code)).toContain('rejected_library_dropped');

    const statuses = await prisma.kpiSuggestion.findMany({ where: { id: { in: [...pendingO1.slice(1), ...pendingO2Before].map(s => s.id) } }, select: { id: true, resultId: true, status: true } });
    for (const row of statuses) expect(row.status, row.resultId === o1.id ? 'O1 card' : 'O2 card').toBe(row.resultId === o1.id ? 'expired' : 'pending');
    expect((await prisma.kpiSuggestion.findUniqueOrThrow({ where: { id: rejected.id } })).status).toBe('rejected');
  });

  it('alternatives use the fast tier and never offer the source library id', async () => {
    const source = await prisma.kpiSuggestion.findFirstOrThrow({ where: { projectId, resultId: o2.id, status: 'pending', libraryId: { not: null } } });
    const sdk = fakeSdk(body => rawMessage(body.model, answerFromPrompt(body)));
    configureAiClientForTests({ anthropic: sdk.client });
    const res = await post(suggestPath(), { scope: 'alternatives', suggestionId: source.id });
    expect(res.status).toBe(200);
    expect(sdk.sent).toHaveLength(1);
    expect(sdk.sent[0].body.model).toBe(resolveModel('fast'));
    expect(suggestForLines(sdk.sent[0].body.messages[0].content)[0].candidates).not.toContain(source.libraryId);
    expect(res.body.suggestions.length).toBeGreaterThan(0);
    expect(res.body.suggestions.every((s: any) => s.alternativeOfSuggestionId === source.id && s.libraryId !== source.libraryId)).toBe(true);
    expect((await prisma.aiCall.findFirstOrThrow({ where: { projectId }, orderBy: { createdAt: 'desc' } })).feature).toBe('kpi.alternatives');
  });

  it('a document baseline "22" taken from the "22.5%" sentence is stored as baselineBasis none with a baseline_not_found warning', async () => {
    // Every suggestion claims the cut number (one of them may be dropped as a repeat of the indicator accepted above).
    const sdk = fakeSdk(body => rawMessage(body.model, answerFromPrompt(body, s => ({ ...s, baselineSuggestion: '22', baselineBasis: 'document' }))));
    configureAiClientForTests({ anthropic: sdk.client });
    const res = await post(suggestPath(), { scope: 'result', resultId: o2.id });
    expect(res.status).toBe(200);
    expect(res.body.suggestions.length).toBeGreaterThan(0);
    for (const s of res.body.suggestions) expect(s.warnings.map((w: any) => w.code)).toContain('baseline_not_found');
    const flagged = res.body.suggestions[0];
    expect(flagged.suggestion).toMatchObject({ baselineBasis: 'none', baselineSuggestion: '' });
    expect(flagged.draft.baselineValue).toBeNull();
    const row = await prisma.kpiSuggestion.findUniqueOrThrow({ where: { id: flagged.id } });
    expect(row.payload).toMatchObject({ baselineBasis: 'none' });
  });

  it('the fake SDK refuses → the run fails with errorCode ai_refused and no suggestion is saved', async () => {
    const sdk = fakeSdk(body => refusalMessage(body.model, null));
    configureAiClientForTests({ anthropic: sdk.client });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await post(suggestPath(), { scope: 'result', resultId: o2.id });
    errors.mockRestore();
    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({ status: 'failed', errorCode: 'ai_refused', message: 'The AI model declined the request (kpi.suggest).' });
    expect(res.body.suggestions).toEqual([]);
    expect(await prisma.kpiSuggestion.count({ where: { runId: res.body.run.id } })).toBe(0);
  });
});
