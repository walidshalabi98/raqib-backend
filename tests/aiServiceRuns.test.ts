import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasTestDatabase, resetDatabase } from './helpers';

// The five AI services end to end against the test database; only generateStructured is
// mocked (never the SDK, never the network).
vi.unmock('../src/services/ai/qualitativeCoder');
vi.unmock('../src/services/ai/reportNarrative');
vi.unmock('../src/services/ai/riskAnalyzer');
vi.unmock('../src/services/ai/assessmentGenerator');
const mocks = vi.hoisted(() => ({ generateStructured: vi.fn() }));
vi.mock('../src/services/ai/client', () => ({
  generateStructured: mocks.generateStructured,
  resolveModel: (tier: string) => (tier === 'fast' ? 'claude-haiku-5-5' : 'claude-sonnet-5-5'),
}));

import { prisma } from '../src/config/prisma';
import { generateIndicatorAlternatives } from '../src/services/ai/indicatorAlternative';
import { codeQualitativeEntry } from '../src/services/ai/qualitativeCoder';
import { generateReportNarrative } from '../src/services/ai/reportNarrative';
import { analyzeProjectRisks } from '../src/services/ai/riskAnalyzer';
import { generateAutoAssessment } from '../src/services/ai/assessmentGenerator';
import { AiInvalidOutputError, AiRefusalError, AiRequestError } from '../src/services/ai/errors';
import { ALTERNATIVES_PROMPT_VERSION, ALTERNATIVES_SCHEMA, ALTERNATIVES_SYSTEM } from '../src/services/ai/prompts/alternatives';
import { QUALITATIVE_PROMPT_VERSION, QUALITATIVE_SCHEMA, QUALITATIVE_SYSTEM } from '../src/services/ai/prompts/qualitative';
import { NARRATIVE_PROMPT_VERSION, NARRATIVE_SCHEMA, NARRATIVE_SYSTEM } from '../src/services/ai/prompts/narrative';
import { RISK_PROMPT_VERSION, RISK_SCHEMA, RISK_SYSTEM } from '../src/services/ai/prompts/risk';
import { ASSESSMENT_PROMPT_VERSION, ASSESSMENT_SCHEMA, ASSESSMENT_SYSTEM, AssessmentAnswer } from '../src/services/ai/prompts/assessment';

const FAST_MODEL = 'claude-haiku-5-5-20261001';
const MAIN_MODEL = 'claude-sonnet-5-5-20261001';
const SCRIPT = '<script>alert("x")</script>';
const ESCAPED_SCRIPT = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;';

/** Personal data that must never reach a prompt. */
const PHONE = '0599123456';
const ID_NUMBER = '401234567';
const EMAIL = 'sara.h@example.ps';
const PERSONAL_DATA = [PHONE, '059-912-3456', ID_NUMBER, EMAIL, '+970 2 298 1234'];

function structuredResult<T>(data: T, promptVersion: string, model = FAST_MODEL) {
  return {
    data,
    model,
    promptVersion,
    usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 9000, cacheWriteTokens: 0 },
    estimatedCostUsd: 0.004,
    aiCallId: 'ai-call-1',
  };
}

/** The params of the only generateStructured call. */
function callParams(): any {
  expect(mocks.generateStructured).toHaveBeenCalledTimes(1);
  return mocks.generateStructured.mock.calls[0][0];
}

/** Everything the model would receive besides the shared system prompt. */
function sentText(params: any): string {
  return [params.system ?? '', ...params.messages.map((m: { content: string }) => m.content)].join('\n');
}

let sequence = 0;

/** An organisation with an admin, an officer and a project with an approved framework and one outcome result. */
async function seedProject(options: { frameworkStatus?: 'draft' | 'approved' } = {}) {
  sequence += 1;
  const org = await prisma.organization.create({
    data: { name: `Org ${sequence}`, type: 'local_ngo', country: 'Palestine', city: 'Hebron', contactEmail: `org${sequence}@example.org` },
  });
  const admin = await prisma.user.create({
    data: { organizationId: org.id, email: `admin${sequence}@example.org`, passwordHash: 'x', fullName: 'Admin', role: 'org_admin' },
  });
  const officer = await prisma.user.create({
    data: { organizationId: org.id, email: `me${sequence}@example.org`, passwordHash: 'x', fullName: 'Officer', role: 'me_officer' },
  });
  const project = await prisma.project.create({
    data: {
      organizationId: org.id, name: `Livelihoods ${sequence}`, sector: 'livelihoods', donor: 'EU Delegation', donorType: 'eu',
      description: `Women-headed households in Hebron. Focal point ${PHONE}.`,
      startDate: new Date('2026-01-01'), endDate: new Date('2027-12-31'), targetBeneficiaries: 1200, geographicScope: 'Hebron governorate',
    },
  });
  const framework = await prisma.framework.create({ data: { projectId: project.id, version: 1, status: options.frameworkStatus ?? 'approved' } });
  const result = await prisma.resultNode.create({
    data: { frameworkId: framework.id, level: 'outcome', code: 'O1', text: 'Household income is more stable' },
  });
  return { org, admin, officer, project, framework, result };
}

type Seed = Awaited<ReturnType<typeof seedProject>>;

async function addIndicator(seed: Seed, data: {
  indicatorText: string;
  status?: 'on_track' | 'at_risk' | 'off_track' | 'not_started' | 'completed';
  baselineValue?: string;
  targetValue?: string;
  currentValue?: string;
  values?: string[];
  sortOrder?: number;
}) {
  const indicator = await prisma.indicator.create({
    data: {
      frameworkId: seed.framework.id, resultId: seed.result.id, indicatorText: data.indicatorText, level: 'outcome',
      dataCollectionMethod: 'hh_survey', frequency: 'quarterly', phases: ['baseline', 'endline'], status: data.status ?? 'not_started',
      baselineValue: data.baselineValue, targetValue: data.targetValue, currentValue: data.currentValue, unit: 'percentage',
      definition: 'Households reporting income in each of the last three months', sortOrder: data.sortOrder ?? 0,
    },
  });
  // values: newest first.
  for (const [i, value] of (data.values ?? []).entries()) {
    await prisma.dataPoint.create({
      data: {
        indicatorId: indicator.id, projectId: seed.project.id, value, collectionDate: new Date(Date.UTC(2026, 8 - i * 3, 1)),
        collectionMethod: 'hh_survey', geographicArea: 'Hebron', createdBy: seed.officer.id,
        notes: `Enumerator called ${PHONE}`, breakdown: { sex: { female: 60, male: 40 } },
      },
    });
  }
  return indicator;
}

describe.skipIf(!hasTestDatabase)('AI services with the AI client mocked', () => {
  beforeEach(async () => {
    await resetDatabase();
    mocks.generateStructured.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('generateIndicatorAlternatives', () => {
    it('calls the fast tier with the indicator details and returns normalised alternatives', async () => {
      const seed = await seedProject();
      const indicator = await addIndicator(seed, { indicatorText: '% of households with a stable income' });
      mocks.generateStructured.mockResolvedValue(structuredResult({
        alternatives: [
          {
            indicatorText: ' % of households with income from two or more sources ', indicatorTextAr: 'نسبة الأسر التي لديها مصدران للدخل أو أكثر', level: 'impact',
            dataCollectionMethod: 'hh_survey', frequency: 'biannual', rationale: 'EU GERF-aligned.', pros: ['Standard'], cons: ['Survey cost'],
          },
          {
            indicatorText: 'Increase household income to 80%', indicatorTextAr: '', level: 'outcome',
            dataCollectionMethod: 'kii', frequency: 'annual', rationale: '', pros: [], cons: [],
          },
          {
            indicatorText: 'Average monthly household income (ILS), by sex of household head', indicatorTextAr: '', level: 'outcome',
            dataCollectionMethod: 'secondary_data', frequency: 'quarterly', rationale: 'PCBS comparable.', pros: [], cons: ['Self-reported'],
          },
        ],
      }, ALTERNATIVES_PROMPT_VERSION));

      const alternatives = await generateIndicatorAlternatives(indicator.id, seed.project.id);

      expect(alternatives).toEqual([
        {
          indicatorText: '% of households with income from two or more sources', indicatorTextAr: 'نسبة الأسر التي لديها مصدران للدخل أو أكثر', level: 'outcome',
          dataCollectionMethod: 'hh_survey', frequency: 'biannual', rationale: 'EU GERF-aligned.', pros: ['Standard'], cons: ['Survey cost'],
        },
        {
          indicatorText: 'Average monthly household income (ILS), by sex of household head', level: 'outcome',
          dataCollectionMethod: 'secondary_data', frequency: 'quarterly', rationale: 'PCBS comparable.', pros: [], cons: ['Self-reported'],
        },
      ]);

      const params = callParams();
      expect(params).toMatchObject({
        feature: 'indicator.alternatives', model: 'fast', effort: 'low', maxTokens: 4000,
        promptVersion: ALTERNATIVES_PROMPT_VERSION, system: ALTERNATIVES_SYSTEM,
        context: { organizationId: seed.org.id, projectId: seed.project.id },
      });
      expect(params.schema).toBe(ALTERNATIVES_SCHEMA);
      const prompt = params.messages[0].content;
      expect(prompt).toContain('% of households with a stable income');
      expect(prompt).toContain('Households reporting income in each of the last three months');
      expect(prompt).toContain('- Unit: percentage');
      expect(prompt).toContain('O1 Household income is more stable');
      expect(prompt).toContain('Women-headed households in Hebron. Focal point [phone removed].');
      expect(prompt).not.toContain(PHONE);
    });

    it('propagates AI errors', async () => {
      const seed = await seedProject();
      const indicator = await addIndicator(seed, { indicatorText: '% of households with a stable income' });
      mocks.generateStructured.mockRejectedValue(new AiRequestError('indicator.alternatives', 529, true, 4));
      await expect(generateIndicatorAlternatives(indicator.id, seed.project.id)).rejects.toBeInstanceOf(AiRequestError);
    });

    it("refuses an indicator of another organisation's project without calling the model", async () => {
      const mine = await seedProject();
      const other = await seedProject();
      const foreign = await addIndicator(other, { indicatorText: 'Foreign indicator' });
      await expect(generateIndicatorAlternatives(foreign.id, mine.project.id)).rejects.toThrow(/not found/);
      await expect(generateIndicatorAlternatives(foreign.id, '00000000-0000-0000-0000-000000000000')).rejects.toThrow(/not found/);
      expect(mocks.generateStructured).not.toHaveBeenCalled();
    });
  });

  describe('codeQualitativeEntry', () => {
    const CONTENT = `Participants said the cash grants helped. Umm Ahmad (ID ${ID_NUMBER}) asked to be called on ${PHONE} or 059-912-3456, `
      + `or by email ${EMAIL}. The cooperative office number is +970 2 298 1234. Income is still irregular in winter.`;

    it('redacts the entry, codes it with the fast tier and stores themes, sentiment and links', async () => {
      const seed = await seedProject();
      const income = await addIndicator(seed, { indicatorText: '% of households with a stable monthly income' });
      await addIndicator(seed, { indicatorText: 'Average litres of water per person per day', sortOrder: 1 });
      const entry = await prisma.qualitativeEntry.create({
        data: { projectId: seed.project.id, entryType: 'fgd_transcript', title: `FGD Hebron, contact ${PHONE}`, content: CONTENT },
      });
      mocks.generateStructured.mockResolvedValue(structuredResult({
        themes: ['Cash grants', ' cash grants ', 'Seasonal income'],
        sentiment: 'mixed',
        keyQuotes: [{ quote: 'The grant helped us through the summer.', theme: 'Cash grants' }],
        summary: 'Grants help; income stays irregular.',
        suggestedIndicatorLinks: [
          { indicatorKeywords: 'household monthly income stable', relevance: 'Income stability.' },
          { indicatorKeywords: 'number of people', relevance: 'Too generic to link.' },
        ],
      }, QUALITATIVE_PROMPT_VERSION));

      await codeQualitativeEntry(entry.id, seed.project.id);

      const params = callParams();
      expect(params).toMatchObject({
        feature: 'qualitative.coding', model: 'fast', effort: 'low', maxTokens: 4000,
        promptVersion: QUALITATIVE_PROMPT_VERSION, system: QUALITATIVE_SYSTEM,
        context: { organizationId: seed.org.id, projectId: seed.project.id },
      });
      expect(params.schema).toBe(QUALITATIVE_SCHEMA);
      const text = sentText(params);
      for (const value of PERSONAL_DATA) expect(text).not.toContain(value);
      expect(text).toContain('[phone removed]');
      expect(text).toContain('[ID number removed]');
      expect(text).toContain('[email removed]');
      expect(text).toContain('Income is still irregular in winter.');
      expect(params.system).toMatch(/Never output names of people, phone numbers, ID numbers, email addresses or addresses/);

      const stored = await prisma.qualitativeEntry.findUniqueOrThrow({ where: { id: entry.id } });
      expect(stored.themes).toEqual(['Cash grants', 'Seasonal income']);
      expect(stored.sentiment).toBe('mixed');
      expect(stored.linkedIndicators).toEqual([income.id]);
      // The stored entry itself is unchanged.
      expect(stored.content).toBe(CONTENT);
    });

    it('logs ids and counts only', async () => {
      const seed = await seedProject();
      const entry = await prisma.qualitativeEntry.create({
        data: { projectId: seed.project.id, entryType: 'field_notes', title: `Visit to Umm Ahmad ${PHONE}`, content: CONTENT },
      });
      mocks.generateStructured.mockResolvedValue(structuredResult({
        themes: ['Access'], sentiment: 'neutral', keyQuotes: [], summary: 'S', suggestedIndicatorLinks: [],
      }, QUALITATIVE_PROMPT_VERSION));
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      await codeQualitativeEntry(entry.id, seed.project.id);

      const lines = log.mock.calls.map(args => args.join(' ')).join('\n');
      expect(lines).toContain(entry.id);
      // One phone number in the title; an ID number, two phone numbers, an email address and a landline in the content.
      expect(lines).toContain('6 personal data items redacted');
      expect(lines).not.toContain('Umm Ahmad');
      expect(lines).not.toContain(PHONE);
      const stored = await prisma.qualitativeEntry.findUniqueOrThrow({ where: { id: entry.id } });
      expect(stored.linkedIndicators).toBeNull();
    });

    it('leaves the entry unchanged when the AI call fails, and refuses entries of other projects', async () => {
      const seed = await seedProject();
      const other = await seedProject();
      const entry = await prisma.qualitativeEntry.create({
        data: { projectId: seed.project.id, entryType: 'field_notes', title: 'Notes', content: 'Field notes' },
      });
      mocks.generateStructured.mockRejectedValue(new AiInvalidOutputError('qualitative.coding', ['root.sentiment: invalid option']));
      await expect(codeQualitativeEntry(entry.id, seed.project.id)).rejects.toBeInstanceOf(AiInvalidOutputError);
      const stored = await prisma.qualitativeEntry.findUniqueOrThrow({ where: { id: entry.id } });
      expect(stored.themes).toBeNull();
      expect(stored.sentiment).toBeNull();

      mocks.generateStructured.mockReset();
      await expect(codeQualitativeEntry(entry.id, other.project.id)).rejects.toThrow(/not found/);
      expect(mocks.generateStructured).not.toHaveBeenCalled();
    });
  });

  describe('generateReportNarrative', () => {
    it('writes the narrative with the main tier from the figures only and stores escaped HTML', async () => {
      const seed = await seedProject();
      await addIndicator(seed, { indicatorText: `% of households with a stable income ${SCRIPT}`, status: 'on_track', baselineValue: '20%', targetValue: '60%', currentValue: '40%', values: ['40', '30'] });
      await addIndicator(seed, { indicatorText: 'Number of cooperatives registered', status: 'not_started', sortOrder: 1 });
      const report = await prisma.report.create({
        data: { projectId: seed.project.id, type: 'quarterly_summary', title: 'Q3 report', donorFormat: 'echo', periodStart: new Date('2026-07-01'), periodEnd: new Date('2026-09-30') },
      });
      mocks.generateStructured.mockResolvedValue(structuredResult({
        executiveSummary: `Progress is on track. ${SCRIPT}`,
        progress: 'Income stability reached 40% against a 60% target (50% of the way).\nCooperatives: data not available.',
        challenges: 'None reported.',
        patterns: 'data not available',
        recommendations: ['Start cooperative registration.', `Call ${PHONE} for details`],
      }, NARRATIVE_PROMPT_VERSION, MAIN_MODEL));

      await generateReportNarrative(report.id, seed.project.id);

      const params = callParams();
      expect(params).toMatchObject({
        feature: 'report.narrative', model: 'main', effort: 'medium', maxTokens: 8000, timeoutMs: 180000,
        promptVersion: NARRATIVE_PROMPT_VERSION, system: NARRATIVE_SYSTEM,
        context: { organizationId: seed.org.id, projectId: seed.project.id },
      });
      expect(params.schema).toBe(NARRATIVE_SCHEMA);
      const prompt = params.messages[0].content;
      expect(prompt).toContain('Baseline: 20% | Target: 60% | Current: 40% | Progress toward target: 50%');
      expect(prompt).toContain('Baseline: data not available | Target: data not available | Current: data not available | Progress toward target: data not available');
      expect(prompt).toContain('REPORTING PERIOD: 2026-07-01 to 2026-09-30');
      expect(prompt).toContain('DG ECHO');
      // Aggregated breakdowns are sent (jsonb may reorder the keys).
      expect(prompt).toMatch(/40 \(2026-09-01; area Hebron; breakdown \{"sex":\{("male":40,"female":60|"female":60,"male":40)\}\}\)/);
      // Data point notes are free text and never sent.
      expect(prompt).not.toContain(PHONE);

      const stored = await prisma.report.findUniqueOrThrow({ where: { id: report.id } });
      expect(stored.status).toBe('draft');
      expect(stored.fileUrl).toBeNull();
      const html = stored.aiNarrative!;
      expect(html.match(/<script/g)).toBeNull();
      expect(html).toContain(`Progress is on track. ${ESCAPED_SCRIPT}`);
      expect(html).toContain(`<td>% of households with a stable income ${ESCAPED_SCRIPT}</td>`);
      expect(html).toContain('<h2>Progress Against Targets</h2>');
      expect(html).toContain('<p>Cooperatives: data not available.</p>');
      expect(html).toContain('<li>Call [phone removed] for details</li>');
      expect(html).toContain(`report-narrative-v2; ${MAIN_MODEL}`);
    });

    it('propagates AI errors and leaves the report untouched', async () => {
      const seed = await seedProject();
      await addIndicator(seed, { indicatorText: 'Indicator' });
      const report = await prisma.report.create({ data: { projectId: seed.project.id, type: 'monthly_progress', title: 'R' } });
      mocks.generateStructured.mockRejectedValue(new AiRefusalError('report.narrative', null));
      await expect(generateReportNarrative(report.id, seed.project.id)).rejects.toBeInstanceOf(AiRefusalError);
      const stored = await prisma.report.findUniqueOrThrow({ where: { id: report.id } });
      expect(stored.aiNarrative).toBeNull();
    });

    it("refuses a report of another project and a project without a framework", async () => {
      const seed = await seedProject();
      const other = await seedProject();
      const report = await prisma.report.create({ data: { projectId: other.project.id, type: 'monthly_progress', title: 'R' } });
      await expect(generateReportNarrative(report.id, seed.project.id)).rejects.toThrow(/not found/);

      const bare = await prisma.project.create({
        data: { organizationId: seed.org.id, name: 'Bare', sector: 'health', donor: 'X', donorType: 'other', startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31') },
      });
      const bareReport = await prisma.report.create({ data: { projectId: bare.id, type: 'monthly_progress', title: 'R' } });
      await expect(generateReportNarrative(bareReport.id, bare.id)).rejects.toThrow(/No framework/);
      expect(mocks.generateStructured).not.toHaveBeenCalled();
    });
  });

  describe('analyzeProjectRisks', () => {
    it('merges the fast-tier answer with the at-risk indicators and ignores unknown ids', async () => {
      const seed = await seedProject();
      const offTrack = await addIndicator(seed, { indicatorText: 'Households reached', status: 'off_track', targetValue: '1,200', currentValue: '400', values: ['400', '450'] });
      const atRisk = await addIndicator(seed, { indicatorText: 'Women in cooperatives', status: 'at_risk', currentValue: '35%', sortOrder: 1 });
      await addIndicator(seed, { indicatorText: 'On track indicator', status: 'on_track', sortOrder: 2 });
      mocks.generateStructured.mockResolvedValue(structuredResult({
        risks: [
          { indicatorId: offTrack.id, riskLevel: 'critical', trend: 'declining', analysis: 'Reach fell from 450 to 400.', suggestedActions: ['Phone outreach'], estimatedImpact: 'Outcome 1 delayed.' },
          { indicatorId: 'not-an-input-id', riskLevel: 'low', trend: 'improving', analysis: 'x', suggestedActions: [], estimatedImpact: 'x' },
        ],
      }, RISK_PROMPT_VERSION));

      const risks = await analyzeProjectRisks(seed.project.id);

      const params = callParams();
      expect(params).toMatchObject({
        feature: 'risk.analysis', model: 'fast', effort: 'low', maxTokens: 4000,
        promptVersion: RISK_PROMPT_VERSION, system: RISK_SYSTEM,
        context: { organizationId: seed.org.id, projectId: seed.project.id },
      });
      expect(params.schema).toBe(RISK_SCHEMA);
      const prompt = params.messages[0].content;
      expect(prompt).toContain(offTrack.id);
      expect(prompt).toContain('"computedTrend": "declining"');
      expect(prompt).not.toContain('On track indicator');
      expect(prompt).not.toContain(PHONE);

      expect(risks).toHaveLength(2);
      expect(risks[0]).toEqual({
        indicatorId: offTrack.id, indicatorText: 'Households reached', level: 'outcome', currentValue: 400, targetValue: 1200, status: 'off_track',
        riskLevel: 'critical', trend: 'declining', aiAnalysis: 'Reach fell from 450 to 400.', suggestedActions: ['Phone outreach'], estimatedImpact: 'Outcome 1 delayed.',
      });
      expect(risks[1]).toMatchObject({ indicatorId: atRisk.id, riskLevel: 'medium', trend: 'stagnant', currentValue: 35, targetValue: null });
      expect(risks.map(r => r.indicatorId)).not.toContain('not-an-input-id');
    });

    it('falls back to the deterministic assessment on any AI error and logs the error class only', async () => {
      const seed = await seedProject();
      await addIndicator(seed, { indicatorText: 'Households reached', status: 'off_track', values: ['400', '450'] });
      mocks.generateStructured.mockRejectedValue(new AiInvalidOutputError('risk.analysis', ['root.risks[0].riskLevel: invalid option']));
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const risks = await analyzeProjectRisks(seed.project.id);

      expect(risks).toEqual([expect.objectContaining({
        riskLevel: 'high', trend: 'declining', aiAnalysis: 'This outcome indicator is off track and requires attention.',
        suggestedActions: ['Review data collection methods', 'Consult with field team', 'Consider timeline adjustments'],
      })]);
      const logged = error.mock.calls.map(args => args.join(' ')).join('\n');
      expect(logged).toContain('AiInvalidOutputError');
      expect(logged).not.toContain('invalid option');
    });

    it('returns [] without calling the model when nothing is at risk, there is no reviewed framework or no project', async () => {
      const seed = await seedProject();
      await addIndicator(seed, { indicatorText: 'Fine', status: 'on_track' });
      expect(await analyzeProjectRisks(seed.project.id)).toEqual([]);

      const draft = await seedProject({ frameworkStatus: 'draft' });
      await addIndicator(draft, { indicatorText: 'Off', status: 'off_track' });
      expect(await analyzeProjectRisks(draft.project.id)).toEqual([]);

      expect(await analyzeProjectRisks('00000000-0000-0000-0000-000000000000')).toEqual([]);
      expect(mocks.generateStructured).not.toHaveBeenCalled();
    });
  });

  describe('generateAutoAssessment', () => {
    const ANSWER: AssessmentAnswer = {
      executiveSummary: `The project is partly on track. ${SCRIPT}`,
      methodology: 'Monitoring data for 2 indicators, 1 focus group transcript and 3 documents.',
      keyFindings: [{ area: 'Income', finding: 'Income stability is improving.', evidence: 'Current 40% against target 60%.', rating: 'moderate' }],
      indicatorAnalysis: { overallAchievement: '50% achievement rate.', strongPerformers: ['Income stability'], challengeAreas: ['Cooperatives'], dataGaps: ['Disability breakdown'] },
      qualitativeInsights: { mainThemes: ['Cash grants'], beneficiaryVoices: `Participants value grants. Contact ${PHONE}.`, contextualFactors: 'Closures.' },
      recommendations: [{ priority: 'high', recommendation: 'Register cooperatives.', timeline: 'short_term', responsible: 'Project manager' }],
      lessonsLearned: ['Plan remote monitoring.'],
      riskAssessment: { currentRisks: ['Access restrictions (likely, high impact)'], mitigationStrategies: ['Phone surveys'] },
      nextSteps: ['Collect Q4 data'],
    };

    async function seedAssessment() {
      const seed = await seedProject();
      await addIndicator(seed, { indicatorText: '% of households with a stable income', status: 'on_track', baselineValue: '20%', targetValue: '60%', currentValue: '40%', values: ['40', '30'] });
      await addIndicator(seed, { indicatorText: 'Cooperatives registered', status: 'off_track', sortOrder: 1 });
      await prisma.qualitativeEntry.create({
        data: {
          projectId: seed.project.id, entryType: 'fgd_transcript', title: `FGD with ${PHONE}`, participants: 12, location: 'Hebron',
          content: `Participant (ID ${ID_NUMBER}, ${EMAIL}, +970 2 298 1234) said grants helped. ${'More notes. '.repeat(60)}`,
          themes: ['Cash grants', `Contact ${PHONE}`], sentiment: 'positive',
        },
      });
      const doc = (fileName: string, parsedText: string, aiAnalysis?: object) => prisma.document.create({
        data: {
          projectId: seed.project.id, uploadedBy: seed.officer.id, fileName, fileUrl: `projects/${seed.project.id}/${fileName}`, fileType: 'proposal',
          parsedText, parsingStatus: 'completed', ...(aiAnalysis ? { aiAnalysis } : {}),
        },
      });
      await doc('proposal.pdf', 'Proposal text', {
        documentType: 'proposal', summary: 'New-style summary of the proposal.', keyFindings: ['Targets 1,200 households'],
        indicatorsMentioned: [], targetsMentioned: [], recommendations: [], model: FAST_MODEL, promptVersion: 'document-analysis-v2', analysedAt: '2026-10-01T00:00:00.000Z',
      });
      await doc('legacy.pdf', `Old text ${PHONE}\n\n---AI_ANALYSIS---\n{"summary":"Legacy summary.","keyFindings":["Legacy finding"],"indicators_mentioned":[]}`);
      await doc('plain.docx', `Plain document text. Call ${PHONE}. ${'Filler. '.repeat(80)}`);
      await prisma.document.create({
        data: { projectId: seed.project.id, uploadedBy: seed.officer.id, fileName: 'pending.pdf', fileUrl: 'x', fileType: 'other', parsedText: 'Not parsed yet', parsingStatus: 'processing' },
      });
      const assessment = await prisma.assessment.create({ data: { projectId: seed.project.id, type: 'midterm', methodsIncluded: ['fgd'] } });
      return { ...seed, assessment };
    }

    it('generates the assessment with the main tier from redacted aggregates and stores JSON, HTML report and notifications', async () => {
      const seed = await seedAssessment();
      mocks.generateStructured.mockResolvedValue(structuredResult(ANSWER, ASSESSMENT_PROMPT_VERSION, MAIN_MODEL));

      await generateAutoAssessment(seed.assessment.id, seed.project.id, 'midterm');

      const params = callParams();
      expect(params).toMatchObject({
        feature: 'assessment.report', model: 'main', effort: 'medium', maxTokens: 16000, timeoutMs: 300000,
        promptVersion: ASSESSMENT_PROMPT_VERSION, system: ASSESSMENT_SYSTEM,
        context: { organizationId: seed.org.id, projectId: seed.project.id },
      });
      expect(params.schema).toBe(ASSESSMENT_SCHEMA);
      const text = sentText(params);
      for (const value of PERSONAL_DATA) expect(text).not.toContain(value);
      expect(text).toContain('[ID number removed]');
      expect(text).toContain('New-style summary of the proposal.');
      expect(text).toContain('Targets 1,200 households');
      expect(text).toContain('Legacy summary.');
      expect(text).toContain('Legacy finding');
      expect(text).not.toContain('Old text');
      expect(text).toContain('Plain document text. Call [phone removed].');
      expect(text).not.toContain('Not parsed yet');
      expect(text).toContain('"progressPercent": 50');
      expect(text).toContain('"trend": "improving"');
      expect(text).toContain('achievement rate 50%');
      expect(text).toContain('- Budget (USD): data not available');

      const assessment = await prisma.assessment.findUniqueOrThrow({ where: { id: seed.assessment.id } });
      expect(assessment.status).toBe('delivered');
      expect(assessment.deliveredAt).not.toBeNull();
      const stored = JSON.parse(assessment.scopeDescription!);
      expect(stored).toMatchObject({ model: MAIN_MODEL, promptVersion: ASSESSMENT_PROMPT_VERSION, keyFindings: ANSWER.keyFindings, nextSteps: ['Collect Q4 data'] });
      expect(stored.qualitativeInsights.beneficiaryVoices).toBe('Participants value grants. Contact [phone removed].');

      const reports = await prisma.report.findMany({ where: { projectId: seed.project.id } });
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ type: 'quarterly_summary', status: 'draft', title: `AI Midterm Assessment — ${seed.project.name}` });
      expect(reports[0].aiNarrative!.match(/<script/g)).toBeNull();
      expect(reports[0].aiNarrative).toContain(`The project is partly on track. ${ESCAPED_SCRIPT}`);

      const notifications = await prisma.notification.findMany({ where: { userId: { in: [seed.admin.id, seed.officer.id] } } });
      expect(notifications).toEqual([expect.objectContaining({ userId: seed.admin.id, type: 'assessment_ready', link: `/projects/${seed.project.id}/assessments` })]);
    });

    it('keeps the assessment in analysis with a safe message when the AI call fails', async () => {
      const seed = await seedAssessment();
      mocks.generateStructured.mockRejectedValue(new Error(`model output leaked: ${PHONE} beneficiary list`));
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await generateAutoAssessment(seed.assessment.id, seed.project.id, 'midterm');

      const assessment = await prisma.assessment.findUniqueOrThrow({ where: { id: seed.assessment.id } });
      expect(assessment.status).toBe('analysis');
      expect(assessment.scopeDescription).toBe('AI generation failed: an unexpected error occurred. Try again.');
      expect(assessment.deliveredAt).toBeNull();
      expect(await prisma.report.count({ where: { projectId: seed.project.id } })).toBe(0);
      expect(await prisma.notification.count()).toBe(0);
      const logged = error.mock.calls.map(args => args.join(' ')).join('\n');
      expect(logged).not.toContain('leaked');
      expect(logged).not.toContain(PHONE);
    });

    it('stores the refusal message for a refused request', async () => {
      const seed = await seedAssessment();
      mocks.generateStructured.mockRejectedValue(new AiRefusalError('assessment.report', null));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await generateAutoAssessment(seed.assessment.id, seed.project.id, 'midterm');
      const assessment = await prisma.assessment.findUniqueOrThrow({ where: { id: seed.assessment.id } });
      expect(assessment).toMatchObject({ status: 'analysis', scopeDescription: expect.stringMatching(/^AI generation failed: the AI model declined/) });
    });

    it('refuses an assessment of another project without touching it', async () => {
      const seed = await seedAssessment();
      const other = await seedProject();
      await expect(generateAutoAssessment(seed.assessment.id, other.project.id, 'midterm')).rejects.toThrow(/not found/);
      const assessment = await prisma.assessment.findUniqueOrThrow({ where: { id: seed.assessment.id } });
      expect(assessment.status).toBe('requested');
      expect(mocks.generateStructured).not.toHaveBeenCalled();
    });
  });
});
