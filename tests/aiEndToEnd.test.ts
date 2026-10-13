import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Feature services run through the REAL AI client (src/services/ai/client.ts), with only the
 * Anthropic SDK replaced by a fake (configureAiClientForTests). Nothing here mocks client.ts, so the
 * request each service builds, the parsing and validation of the raw Messages API JSON, the cost and
 * served-model bookkeeping and the AiCall rows are all the production code (review finding R6).
 * Covered: generateFramework (main tier, server-side fallback; its indicator step runs the KPI pipeline, design
 * section 4.6), parseDocument on a stored .xlsx (fast tier) and risk analysis (fast tier). No network: tests/setup.ts points the real SDK at a
 * closed port, and the fake replaces it.
 */

// tests/setup.ts replaces these services with mocks for the route tests; this file runs the real ones.
vi.unmock('../src/services/ai/frameworkGenerator');
vi.unmock('../src/services/ai/documentParser');
vi.unmock('../src/services/ai/riskAnalyzer');
vi.unmock('../src/services/kpi/pipeline');

import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { configureAiClientForTests, REFUSAL_FALLBACK_BETA, resetAiClientForTests, type AiSdkClient } from '../src/services/ai/client';
import { parseDocument } from '../src/services/ai/documentParser';
import { AiRefusalError } from '../src/services/ai/errors';
import { generateFramework } from '../src/services/ai/frameworkGenerator';
import { DOCUMENT_ANALYSIS_SYSTEM, DOCUMENT_TYPES } from '../src/services/ai/prompts/documentAnalysis';
import {
  FRAMEWORK_INDICATOR_LEVELS,
  FRAMEWORK_PROMPT_VERSION,
  FRAMEWORK_STRUCTURE_SYSTEM,
  INDICATOR_UNITS,
} from '../src/services/ai/prompts/framework';
import { KPI_CALLS, KPI_PROMPT_VERSION, KPI_SYSTEM, type KpiRawSuggestion } from '../src/services/ai/prompts/kpi';
import { RISK_LEVELS, RISK_SYSTEM } from '../src/services/ai/prompts/risk';
import { loadSharedSystemPrompt } from '../src/services/ai/prompts/system';
import { analyzeProjectRisks } from '../src/services/ai/riskAnalyzer';
import { seedLibrary } from '../src/services/library/seed';
import { buildDocumentKey, getStorage } from '../src/services/storage';
import { createOrgFixture, hasTestDatabase, OrgFixture, resetDatabase } from './helpers';

// ------------------------------------------------------------------ fake SDK

interface SentRequest {
  endpoint: 'messages' | 'beta.messages';
  body: Record<string, any>;
  options: { timeout?: number; maxRetries?: number } | undefined;
}

/** A fake Anthropic client that records every request and returns the queued raw responses in order. */
function fakeSdk(responses: unknown[]): { client: AiSdkClient; sent: SentRequest[] } {
  const sent: SentRequest[] = [];
  const queue = [...responses];
  const create = (endpoint: SentRequest['endpoint']) => async (body: Record<string, any>, options?: SentRequest['options']) => {
    sent.push({ endpoint, body: structuredClone(body), options });
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected request #${sent.length}`);
    return structuredClone(next);
  };
  return { client: { messages: { create: create('messages') }, beta: { messages: { create: create('beta.messages') } } }, sent };
}

interface Tokens { input: number; output: number; cacheWrite: number; cacheRead: number }

/** usage as the Messages API returns it (counts plus the cache breakdown and service fields). */
function usageJson(t: Tokens, iterations: unknown[] | null = null) {
  return {
    input_tokens: t.input,
    output_tokens: t.output,
    cache_creation_input_tokens: t.cacheWrite,
    cache_read_input_tokens: t.cacheRead,
    cache_creation: { ephemeral_5m_input_tokens: t.cacheWrite, ephemeral_1h_input_tokens: 0 },
    server_tool_use: null,
    service_tier: 'standard',
    inference_geo: 'global',
    speed: 'standard',
    output_tokens_details: null,
    fallback_credit: null,
    iterations,
  };
}

/** One usage.iterations entry. */
function iteration(type: 'message' | 'fallback_message', model: string, t: Tokens) {
  return {
    type,
    model,
    input_tokens: t.input,
    output_tokens: t.output,
    cache_creation_input_tokens: t.cacheWrite,
    cache_read_input_tokens: t.cacheRead,
    cache_creation: { ephemeral_5m_input_tokens: t.cacheWrite, ephemeral_1h_input_tokens: 0 },
  };
}

/** Thinking is on by default on Sonnet 5.5 and Haiku 5.5; its text is omitted unless display is set. */
const THINKING_BLOCK = { type: 'thinking', thinking: '', signature: 'EuYBCkQIBhgCIkBe2Jp0c2lnbmF0dXJlLWZvci10ZXN0cy1vbmx5' };

/** A raw Messages API response holding a structured-output answer. */
function rawMessage(model: string, answer: unknown, tokens: Tokens, extra: { before?: unknown[]; iterations?: unknown[] } = {}) {
  return {
    id: `msg_01${Math.random().toString(36).slice(2, 12)}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [...(extra.before ?? []), THINKING_BLOCK, { type: 'text', text: JSON.stringify(answer) }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    usage: usageJson(tokens, extra.iterations ?? null),
  };
}

const SHARED = loadSharedSystemPrompt();
const MAIN = 'claude-sonnet-5-5';
const MAIN_FALLBACK = 'claude-sonnet-5';
const FAST = 'claude-haiku-5-5';

/** The body keys the client sends: never thinking, temperature, tools or a `betas` key on the plain endpoint. */
const PLAIN_KEYS = ['max_tokens', 'messages', 'model', 'output_config', 'system'];
const FALLBACK_KEYS = [...PLAIN_KEYS, 'betas', 'fallbacks'].sort();

function expectSystemBlocks(body: Record<string, any>, featureSystem: string): void {
  expect(body.system).toEqual([
    { type: 'text', text: SHARED.text, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: featureSystem },
  ]);
}

/** Every object of a JSON schema closes its properties and requires all of them (structured outputs). */
function expectStrictObjects(schema: any, path = 'root'): void {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'object') {
    expect(schema.additionalProperties, `${path}.additionalProperties`).toBe(false);
    expect([...(schema.required ?? [])].sort(), `${path}.required`).toEqual(Object.keys(schema.properties ?? {}).sort());
    for (const [key, value] of Object.entries(schema.properties ?? {})) expectStrictObjects(value, `${path}.${key}`);
  }
  if (schema.items) expectStrictObjects(schema.items, `${path}[]`);
}

const PERSONAL_DATA = ['0599123456', '0599 123 456', '401234567', 'coordinator@example.org', 'p1@example.org', 'Umm Ahmad'];

function expectNoPersonalData(text: string): void {
  for (const value of PERSONAL_DATA) expect(text).not.toContain(value);
}

async function aiCalls(projectId: string) {
  const rows = await prisma.aiCall.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } });
  return rows.map(r => ({ ...r, estimatedCostUsd: r.estimatedCostUsd === null ? null : Number(r.estimatedCostUsd) }));
}

// ------------------------------------------------------------------ framework fixtures

const PROPOSAL = [
  'Gaza Emergency WASH Response: proposal to DG ECHO (2026).',
  'The rapid needs assessment carried out in December 2025 found that displaced households had access to an average of 6 litres of water per person per day.',
  'Result 1.1: 12,000 people receive trucked drinking water for nine months (6,000 by the end of March 2026).',
  'Result 1.2: 2,400 hygiene kits are distributed to displaced households.',
  'Budget. Post-distribution monitoring survey: 400 households, 80 ILS per interview.',
  // A legacy row stored before redaction existed: the generator redacts it again before any prompt.
  'Field coordinator: 0599 123 456, coordinator@example.org (staff ID 401234567).',
].join('\n\n');

const STRUCTURE_ANSWER = {
  goal: { code: 'G', text: 'Displaced households in the southern Gaza Strip meet their basic needs', textAr: 'تلبية الأسر النازحة في جنوب قطاع غزة احتياجاتها الأساسية' },
  outcomes: [{
    code: 'O1',
    text: 'Displaced households have sufficient safe water and practise safe hygiene',
    textAr: 'حصول الأسر النازحة على كميات كافية من المياه الآمنة وممارستها النظافة الآمنة',
    outputs: [
      { code: 'O1.1', text: 'People receive trucked drinking water', textAr: 'حصول السكان على مياه الشرب المنقولة بالصهاريج', activities: ['Contract water trucking'] },
      { code: 'O1.2', text: 'Displaced households receive hygiene kits', textAr: 'حصول الأسر النازحة على حقائب النظافة', activities: ['Distribute hygiene kits'] },
    ],
  }],
  beneficiaries: { total: 12000, types: ['Displaced households'], disaggregation: ['sex', 'age', 'disability'] },
  timeline: { startDate: '2026-01-01', endDate: '2026-12-31', phases: [] },
  donorRequirements: ['Key Result Indicators where available'],
  crossCuttingThemes: ['gender'],
  documentFigures: [
    { resultCode: 'O1', kind: 'baseline', value: '6', description: 'litres per person per day', quote: 'access to an average of 6 litres of water per person per day' },
    { resultCode: 'O1.1', kind: 'target', value: '12,000', description: 'people receiving trucked water', quote: 'Result 1.1: 12,000 people receive trucked drinking water for nine months' },
    { resultCode: 'O1.1', kind: 'target', value: '6,000', description: 'by March 2026', quote: '(6,000 by the end of March 2026)' },
    { resultCode: 'O1.2', kind: 'target', value: '2,400', description: 'hygiene kits', quote: 'Result 1.2: 2,400 hygiene kits are distributed to displaced households.' },
  ],
};

/** One suggestion of the KPI answer (KPI_SUGGESTION_SCHEMA): the indicator step runs the KPI pipeline (design 4.6, D19). */
function suggestion(overrides: Partial<KpiRawSuggestion>): KpiRawSuggestion {
  return {
    resultCode: 'O1', level: 'outcome', libraryId: null, isCustom: true, customReason: 'No library candidate fits this result.', name: '', nameAr: '',
    definition: '', unit: 'number', numerator: '', denominator: '', direction: 'increase', disaggregation: [], method: 'document_review',
    frequency: 'quarterly', meansOfVerification: '', baselineSuggestion: '', baselineBasis: 'none', targetSuggestion: '', targetBasis: 'method_only',
    standardReferenceCode: null, rationale: 'Measures the result with a verifiable source.', qualityNotes: [], confidence: 'medium',
    ...overrides,
  };
}

/** The answer to the one KPI batch of the four results (G, O1, O1.1, O1.2). */
const INDICATORS_ANSWER = {
  suggestions: [
    suggestion({
      resultCode: 'O1', name: 'Average volume of water available per person per day in target households', libraryId: 'WA-01', isCustom: false, customReason: '',
      nameAr: 'متوسط كمية المياه المتاحة للفرد يوميًا في الأسر المستهدفة', standardReferenceCode: 'Sphere',
      definition: 'Litres of water available for drinking, cooking and hygiene per person per day, from all sources.', unit: 'litres_per_person_per_day',
      disaggregation: ['location', 'displacement_status'], method: 'hh_survey', meansOfVerification: 'Household survey water module',
      baselineSuggestion: '6', baselineBasis: 'document', targetSuggestion: '15', targetBasis: 'standard_threshold', confidence: 'high',
    }),
    suggestion({
      resultCode: 'O1.1', level: 'output', name: 'Number of people receiving trucked drinking water', libraryId: 'WA-04', isCustom: false, customReason: '',
      nameAr: 'عدد الأشخاص الذين يحصلون على مياه الشرب المنقولة بالصهاريج',
      definition: 'People in households registered at a served delivery point who received water at least once in the month.',
      disaggregation: ['age'], frequency: 'monthly', meansOfVerification: 'Water-trucking delivery logs', targetSuggestion: '12,000', targetBasis: 'document',
    }),
    // An invented target that only matches a budget cell ("80 ILS per interview"): removed in code.
    suggestion({
      resultCode: 'O1.2', level: 'output', name: '% of target households with a handwashing facility with soap and water', unit: 'percent',
      nameAr: 'نسبة الأسر المستهدفة التي لديها مرفق لغسل اليدين بالماء والصابون',
      numerator: 'Households with a handwashing facility with soap and water', denominator: 'Households observed',
      method: 'observation', frequency: 'biannual', meansOfVerification: 'Household observation checklist', targetSuggestion: '80', targetBasis: 'document',
    }),
  ],
  frameworkWarnings: [],
};

/** Tokens of each framework attempt. The indicator (KPI batch) request is declined by Sonnet 5.5 before any output and served by Sonnet 5. */
const STRUCTURE_TOKENS: Tokens = { input: 2210, output: 3180, cacheWrite: 9814, cacheRead: 0 };
const DECLINED_TOKENS: Tokens = { input: 4020, output: 0, cacheWrite: 0, cacheRead: 9814 };
const SERVED_TOKENS: Tokens = { input: 4020, output: 7410, cacheWrite: 9814, cacheRead: 0 };

// Prices per million tokens (models.ts): Sonnet 5.5 and Sonnet 5 both $2 in, $10 out, $2.50 cache write, $0.20 cache read.
// structure: 2210×2 + 3180×10 + 9814×2.5 = 60 755 → $0.060755
// declined:  4020×2 + 9814×0.2 = 10 002.8 → $0.010003; served: 4020×2 + 7410×10 + 9814×2.5 = 106 675 → $0.106675
const STRUCTURE_COST = 0.060755;
const INDICATORS_COST = 0.116678;

const FALLBACK_BLOCK = { type: 'fallback', from: { model: MAIN }, to: { model: MAIN_FALLBACK }, trigger: { type: 'refusal', category: 'frontier_llm' } };

describe.skipIf(!hasTestDatabase)('AI services through the real client (fake SDK only)', () => {
  let fx: OrgFixture;

  beforeEach(async () => {
    await resetDatabase();
    fx = await createOrgFixture('e2e');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetAiClientForTests();
    vi.restoreAllMocks();
  });

  async function frameworkProject() {
    await seedLibrary(prisma);
    const project = await prisma.project.create({
      data: {
        organizationId: fx.org.id, name: 'Gaza Emergency WASH Response', sector: 'wash', sectors: ['wash'], humanitarian: true,
        donor: 'DG ECHO', donorType: 'echo', startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'), targetBeneficiaries: 12000,
        description: 'Water trucking and hygiene kits. Contact 0599123456.', geographicScope: 'Khan Younis',
      },
    });
    await prisma.document.create({
      data: { projectId: project.id, uploadedBy: fx.officer.id, fileName: 'proposal.pdf', fileUrl: `projects/${project.id}/proposal.pdf`, fileType: 'proposal', parsedText: PROPOSAL, parsingStatus: 'completed' },
    });
    // An FGD transcript: framework generation never sends it.
    await prisma.document.create({
      data: {
        projectId: project.id, uploadedBy: fx.officer.id, fileName: 'fgd.docx', fileUrl: `projects/${project.id}/fgd.docx`, fileType: 'other',
        parsedText: 'FGD transcript: Umm Ahmad said the water ran out.', parsingStatus: 'completed', qualitativeSource: true,
      },
    });
    const framework = await prisma.framework.create({ data: { projectId: project.id, version: 1, status: 'draft', aiModelUsed: MAIN } });
    return { project, framework };
  }

  it('generateFramework: structure + one KPI batch with a server-side fallback, stored rows, request shape and AiCall rows', async () => {
    const { project, framework } = await frameworkProject();
    const sdk = fakeSdk([
      rawMessage(MAIN, STRUCTURE_ANSWER, STRUCTURE_TOKENS),
      rawMessage(MAIN_FALLBACK, INDICATORS_ANSWER, SERVED_TOKENS, {
        before: [FALLBACK_BLOCK],
        iterations: [iteration('message', MAIN, DECLINED_TOKENS), iteration('fallback_message', MAIN_FALLBACK, SERVED_TOKENS)],
      }),
    ]);
    configureAiClientForTests({ anthropic: sdk.client });

    await generateFramework(framework.id, project.id);

    // --- request shape (main tier: Sonnet 5.5 has the server-side fallback, so the beta endpoint)
    expect(sdk.sent).toHaveLength(2);
    const [structureReq, indicatorsReq] = sdk.sent;
    for (const req of sdk.sent) {
      expect(req.endpoint).toBe('beta.messages');
      expect(Object.keys(req.body).sort()).toEqual(FALLBACK_KEYS);
      expect(req.body.model).toBe(MAIN);
      expect(req.body.betas).toEqual([REFUSAL_FALLBACK_BETA]);
      expect(req.body.betas).toEqual(['server-side-fallback-2026-07-01']);
      expect(req.body.fallbacks).toBe('default');
      expect(req.body.output_config.format.type).toBe('json_schema');
      expectStrictObjects(req.body.output_config.format.schema);
      expect(req.body.messages).toHaveLength(1);
      expect(req.body.messages[0].role).toBe('user');
      expectNoPersonalData(JSON.stringify(req.body.messages));
      expect(req.body.messages[0].content).not.toContain('FGD transcript');
    }
    expectSystemBlocks(structureReq.body, FRAMEWORK_STRUCTURE_SYSTEM);
    expectSystemBlocks(indicatorsReq.body, KPI_SYSTEM);
    expect(structureReq.body.output_config.effort).toBe('medium');
    expect(indicatorsReq.body.output_config.effort).toBe('low');
    expect(structureReq.body.max_tokens).toBe(12_000);
    expect(indicatorsReq.body.max_tokens).toBe(KPI_CALLS.batch.maxTokens);
    expect(structureReq.options).toEqual({ timeout: 180_000, maxRetries: 0 });
    expect(indicatorsReq.options).toEqual({ timeout: KPI_CALLS.batch.timeoutMs, maxRetries: 0 });
    // Enums survive the zod → JSON schema conversion.
    const structureSchema = structureReq.body.output_config.format.schema;
    expect(structureSchema.properties.documentFigures.items.properties.kind.enum).toEqual(['baseline', 'target']);
    const suggestionItem = indicatorsReq.body.output_config.format.schema.properties.suggestions.items.properties;
    expect(suggestionItem.unit.enum).toEqual([...INDICATOR_UNITS]);
    expect(suggestionItem.level.enum).toEqual([...FRAMEWORK_INDICATOR_LEVELS]);
    // The project description was redacted; only checked document figures reach the indicator step, as DOCUMENT FACTS.
    expect(structureReq.body.messages[0].content).toContain('[phone removed]');
    const indicatorPrompt: string = indicatorsReq.body.messages[0].content;
    expect(indicatorPrompt).toContain('SUGGEST FOR\nG [impact]');
    expect(indicatorPrompt).toMatch(/\[F\d+ target\] proposal\.pdf: "Result 1\.1: 12,000 people receive trucked drinking water for nine months"/);
    expect(indicatorPrompt).not.toContain('80 ILS');

    // --- stored rows
    const stored = await prisma.framework.findUniqueOrThrow({
      where: { id: framework.id },
      include: { resultNodes: true, indicators: { orderBy: { sortOrder: 'asc' } } },
    });
    expect(stored).toMatchObject({ status: 'expert_review', aiModelUsed: MAIN_FALLBACK, generationError: null });
    // Goal, outcome, outputs and their activities.
    expect(stored.resultNodes.map(n => n.code).sort()).toEqual(['A1.1.1', 'A1.2.1', 'G', 'O1', 'O1.1', 'O1.2']);
    // The three answered indicators plus AC-01, appended for this humanitarian project (rule 19).
    expect(stored.indicators).toHaveLength(4);
    expect(stored.indicators.every(i => i.provenance === 'ai_generated' && i.aiModel === MAIN_FALLBACK && i.promptVersion === KPI_PROMPT_VERSION)).toBe(true);
    const byText = (text: string) => stored.indicators.find(i => i.indicatorText.startsWith(text))!;
    expect(byText('Average volume')).toMatchObject({ baselineValue: '6', baselineDate: null, targetValue: '15', unit: 'litres_per_person_per_day', libraryId: 'WA-01' });
    expect(byText('Average volume').baselineMethod).toContain('(source: proposal.pdf)');
    expect(byText('Number of people')).toMatchObject({ targetValue: '12,000', libraryId: 'WA-04', intermediateTargets: [] });
    // The invented 80 (a budget cell) is not kept.
    expect(byText('% of target households').targetValue).toBeNull();
    expect(byText('% of target households').targetJustification).toContain('was not found as a target in the project documents and was removed');
    expect(stored.indicators.map(i => i.libraryId)).toContain('AC-01');
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('framework_review');

    // --- AiCall rows: one per call, every attempt counted and priced at its own model
    const rows = await aiCalls(project.id);
    expect(rows).toHaveLength(2);
    const common = {
      model: MAIN, systemPromptVersion: SHARED.version, status: 'success', stopReason: 'end_turn',
      errorType: null, attempts: 1, organizationId: fx.org.id, projectId: project.id,
    };
    expect(rows[0]).toMatchObject({
      ...common, feature: 'framework.structure', promptVersion: FRAMEWORK_PROMPT_VERSION, servedModel: MAIN,
      inputTokens: 2210, outputTokens: 3180, cacheReadTokens: 0, cacheWriteTokens: 9814, estimatedCostUsd: STRUCTURE_COST,
    });
    expect(rows[1]).toMatchObject({
      ...common, feature: 'framework.indicators', promptVersion: KPI_PROMPT_VERSION, servedModel: MAIN_FALLBACK,
      inputTokens: 8040, outputTokens: 7410, cacheReadTokens: 9814, cacheWriteTokens: 9814, estimatedCostUsd: INDICATORS_COST,
    });
  });

  it('generateFramework: a refusal the fallback does not retry is recorded on the version and reported as failed', async () => {
    const { project, framework } = await frameworkProject();
    const refusal = {
      ...rawMessage(MAIN, {}, { input: 4020, output: 0, cacheWrite: 0, cacheRead: 9814 }),
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'general_harms', explanation: null },
    };
    // The refused batch of four results is retried result by result (design 4.4); every retry is refused too.
    const sdk = fakeSdk([rawMessage(MAIN, STRUCTURE_ANSWER, STRUCTURE_TOKENS), refusal, refusal, refusal, refusal, refusal]);
    configureAiClientForTests({ anthropic: sdk.client });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(generateFramework(framework.id, project.id)).rejects.toBeInstanceOf(AiRefusalError);
    expect(sdk.sent).toHaveLength(6);
    expect(sdk.sent.slice(2).every(req => req.body.max_tokens === KPI_CALLS.result.maxTokens)).toBe(true);

    const stored = await prisma.framework.findUniqueOrThrow({ where: { id: framework.id }, include: { indicators: true, resultNodes: true } });
    expect(stored.indicators).toEqual([]);
    expect(stored.resultNodes).toEqual([]);
    expect(stored.generationError).toBe('The AI model declined the request (framework.indicators, category general_harms).');

    const status = await request(app).get(`/api/frameworks/${framework.id}/status`).set('Authorization', fx.adminAuth);
    expect(status.body).toEqual({ frameworkId: framework.id, status: 'failed', message: stored.generationError });
    // The failed version never becomes the project's framework.
    const current = await request(app).get(`/api/projects/${project.id}/framework`).set('Authorization', fx.adminAuth);
    expect(current.body).toBeNull();

    const rows = await aiCalls(project.id);
    expect(rows.map(r => [r.feature, r.status, r.stopReason, r.servedModel])).toEqual([
      ['framework.structure', 'success', 'end_turn', MAIN],
      ...Array.from({ length: 5 }, () => ['framework.indicators', 'refusal', 'refusal', MAIN]),
    ]);
    // A declined request is still counted: 4020×2 + 9814×0.2 → $0.010003.
    expect(rows[1]).toMatchObject({ errorType: 'AiRefusalError', inputTokens: 4020, outputTokens: 0, cacheReadTokens: 9814, estimatedCostUsd: 0.010003 });
  });

  it('parseDocument: a stored .xlsx is parsed, redacted and analysed on the fast tier; figures are checked against the text', async () => {
    const workbook = new ExcelJS.Workbook();
    const targets = workbook.addWorksheet('Targets');
    targets.addRow(['Indicator', 'Baseline', 'Target', 'Timeline']);
    targets.addRow(['Households with a stable income', '14%', '22%', 'December 2027']);
    targets.addRow(['Households reached', '0', '1,200', '2027']);
    const contacts = workbook.addWorksheet('Contacts');
    contacts.addRow(['Name', 'ID number', 'Phone', 'Email']);
    contacts.addRow(['Participant 1', 401234567, '0599123456', 'p1@example.org']);
    const body = Buffer.from(await workbook.xlsx.writeBuffer());
    const key = buildDocumentKey(fx.project.id, 'targets.xlsx');
    await getStorage().put(key, body, 'application/octet-stream');
    const doc = await prisma.document.create({
      data: { projectId: fx.project.id, uploadedBy: fx.officer.id, fileName: 'targets.xlsx', fileUrl: key, fileType: 'logframe', fileSizeBytes: body.length },
    });

    const answer = {
      documentType: 'logframe',
      summary: 'Targets for household income and reach for 2027.',
      keyFindings: ['The stable income target is 22% by December 2027.', '45% of households lack savings.'],
      indicatorsMentioned: ['Households with a stable income', 'Households reached'],
      targetsMentioned: [
        { indicator: 'Households with a stable income', target: '22%', timeline: 'December 2027' },
        { indicator: '% of households with soap', target: '80%', timeline: '2027' },
      ],
      recommendations: ['Add a baseline date to each target.'],
    };
    // Haiku 5.5 base tier: $0.10 in, $0.50 out, $0.125 cache write → 3900×0.1 + 410×0.5 + 9814×0.125 = 1 821.75 → $0.001822
    const sdk = fakeSdk([rawMessage(FAST, answer, { input: 3900, output: 410, cacheWrite: 9814, cacheRead: 0 })]);
    configureAiClientForTests({ anthropic: sdk.client });

    await parseDocument(doc.id);

    // --- request shape (fast tier: Haiku 5.5 has no server-side fallback, so the plain endpoint)
    expect(sdk.sent).toHaveLength(1);
    const [req] = sdk.sent;
    expect(req.endpoint).toBe('messages');
    expect(Object.keys(req.body).sort()).toEqual(PLAIN_KEYS);
    expect(req.body).toMatchObject({ model: FAST, max_tokens: 4000 });
    expect(req.body.output_config.effort).toBe('low');
    expect(req.body.output_config.format.schema.properties.documentType.enum).toEqual([...DOCUMENT_TYPES]);
    expectStrictObjects(req.body.output_config.format.schema);
    expectSystemBlocks(req.body, DOCUMENT_ANALYSIS_SYSTEM);
    expect(req.options).toEqual({ timeout: 60_000, maxRetries: 0 });
    expectNoPersonalData(JSON.stringify(req.body.messages));
    expect(req.body.messages[0].content).toContain('Households with a stable income');

    // --- stored rows
    const stored = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(stored.parsingStatus).toBe('completed');
    expectNoPersonalData(stored.parsedText!);
    expect(stored.parsedText).toContain('[phone removed]');
    expect(stored.aiAnalysis).toMatchObject({
      documentType: 'logframe',
      model: FAST,
      promptVersion: 'document-analysis-v2',
      targetsMentioned: [
        { indicator: 'Households with a stable income', target: '22%', timeline: 'December 2027', verified: true },
        { indicator: '% of households with soap', target: '80%', timeline: '2027', verified: false },
      ],
      unverifiedFigures: ['45%'],
    });

    const rows = await aiCalls(fx.project.id);
    expect(rows).toEqual([expect.objectContaining({
      feature: 'document.analysis', model: FAST, servedModel: FAST, promptVersion: 'document-analysis-v2', systemPromptVersion: SHARED.version,
      status: 'success', stopReason: 'end_turn', attempts: 1, inputTokens: 3900, outputTokens: 410, cacheReadTokens: 0, cacheWriteTokens: 9814,
      estimatedCostUsd: 0.001822, organizationId: fx.org.id, projectId: fx.project.id,
    })]);
  });

  it('risk analysis (fast tier): the computed trend wins and an invented figure is replaced; AiCall row written', async () => {
    const framework = await prisma.framework.create({ data: { projectId: fx.project.id, version: 2, status: 'approved' } });
    const result = await prisma.resultNode.create({ data: { frameworkId: framework.id, level: 'outcome', code: 'O1', text: 'Hygiene' } });
    const base = { frameworkId: framework.id, resultId: result.id, level: 'outcome' as const, dataCollectionMethod: 'hh_survey' as const, frequency: 'quarterly' as const, phases: ['baseline', 'endline'] };
    const soap = await prisma.indicator.create({
      data: { ...base, indicatorText: '% of households without soap', unit: 'percent', direction: 'decrease', baselineValue: '38%', targetValue: '15%', currentValue: '30%', status: 'off_track', sortOrder: 0 },
    });
    const water = await prisma.indicator.create({
      data: { ...base, indicatorText: 'Litres of water per person per day', unit: 'litres_per_person_per_day', direction: 'increase', baselineValue: '6', targetValue: '15', currentValue: '9', status: 'at_risk', sortOrder: 1 },
    });
    const point = (indicatorId: string, value: string, date: string) => prisma.dataPoint.create({
      data: { indicatorId, projectId: fx.project.id, value, collectionDate: new Date(date), collectionMethod: 'hh_survey', geographicArea: 'Gaza', createdBy: fx.officer.id },
    });
    await point(soap.id, '22%', '2026-02-01');
    await point(soap.id, '30%', '2026-05-01');
    await point(water.id, '9', '2026-05-01');

    const answer = {
      risks: [
        { indicatorId: soap.id, riskLevel: 'high', trend: 'improving', analysis: 'Rose from 22% to 30%, showing strong improvement of 36%.', suggestedActions: ['Distribute soap with the next hygiene kit round.'], estimatedImpact: 'Hygiene outcomes may not be reached.' },
        { indicatorId: water.id, riskLevel: 'medium', trend: 'stagnant', analysis: 'At 9 litres the value is below the target of 15.', suggestedActions: ['Add a second water truck in Gaza.'], estimatedImpact: 'Households may rely on unsafe sources.' },
      ],
    };
    const sdk = fakeSdk([rawMessage(FAST, answer, { input: 1800, output: 520, cacheWrite: 0, cacheRead: 9814 })]);
    configureAiClientForTests({ anthropic: sdk.client });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const alerts = await analyzeProjectRisks(fx.project.id);

    expect(sdk.sent).toHaveLength(1);
    const [req] = sdk.sent;
    expect(req.endpoint).toBe('messages');
    expect(Object.keys(req.body).sort()).toEqual(PLAIN_KEYS);
    expect(req.body).toMatchObject({ model: FAST, max_tokens: 4000, output_config: { effort: 'low' } });
    expect(req.body.output_config.format.schema.properties.risks.items.properties.riskLevel.enum).toEqual([...RISK_LEVELS]);
    expectSystemBlocks(req.body, RISK_SYSTEM);

    const bySoap = alerts.find(a => a.indicatorId === soap.id)!;
    expect(bySoap).toMatchObject({ riskLevel: 'high', trend: 'declining', aiAnalysis: 'This outcome indicator is off track and requires attention.' });
    expect(alerts.find(a => a.indicatorId === water.id)).toMatchObject({ riskLevel: 'medium', aiAnalysis: 'At 9 litres the value is below the target of 15.' });

    // Haiku 5.5: 1800×0.1 + 520×0.5 + 9814×0.01 = 538.14 → $0.000538
    const rows = await aiCalls(fx.project.id);
    expect(rows).toEqual([expect.objectContaining({
      feature: 'risk.analysis', model: FAST, servedModel: FAST, promptVersion: 'risk-analysis-v2', status: 'success', attempts: 1,
      inputTokens: 1800, outputTokens: 520, cacheReadTokens: 9814, cacheWriteTokens: 0, estimatedCostUsd: 0.000538, organizationId: fx.org.id,
    })]);
  });
});
