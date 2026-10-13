import { Sentiment } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { structuredOutputSchemaProblems } from './aiSchemaHelpers';

// Pure parts of the AI services: schemas, prompts, normalisers and HTML builders. (The Phase 3 indicator alternatives
// generator was removed in Phase 4; its name-rule cases live in tests/kpiNameRules.test.ts.)
// The real modules are tested; the AI client is mocked so nothing can reach a model.
vi.unmock('../src/services/ai/qualitativeCoder');
vi.unmock('../src/services/ai/reportNarrative');
vi.unmock('../src/services/ai/riskAnalyzer');
vi.unmock('../src/services/ai/assessmentGenerator');
vi.mock('../src/services/ai/client', () => ({
  generateStructured: vi.fn().mockRejectedValue(new Error('not used in pure tests')),
  resolveModel: (tier: string) => (tier === 'fast' ? 'claude-haiku-5-5' : 'claude-sonnet-5-5'),
}));

import { AiError, AiInvalidOutputError, AiOutputTruncatedError, AiRefusalError, AiRequestError } from '../src/services/ai/errors';
import { linkIndicators, linkKeywords, normalizeThemes } from '../src/services/ai/qualitativeCoder';
import { checkNarrativeFigures, generateReportHtml, narrativeAllowedFigures } from '../src/services/ai/reportNarrative';
import { AtRiskIndicator, fallbackRiskAlert, mergeRiskAnswer, riskAllowedFigures } from '../src/services/ai/riskAnalyzer';
import {
  assessmentFailureMessage,
  assessmentTypeLabel,
  checkAssessmentFigures,
  cutAtWord,
  documentSummaryFor,
  generateAssessmentHtml,
  normalizeAssessment,
} from '../src/services/ai/assessmentGenerator';
import {
  codeQualitativePrompt,
  QUALITATIVE_MAX_CHARS,
  QUALITATIVE_PROMPT_VERSION,
  QUALITATIVE_SCHEMA,
  QUALITATIVE_SYSTEM,
  truncateEntry,
} from '../src/services/ai/prompts/qualitative';
import {
  BREAKDOWN_OMITTED,
  DATA_NOT_AVAILABLE,
  formatBreakdown,
  MAX_BREAKDOWN_CHARS,
  NARRATIVE_PROMPT_VERSION,
  NARRATIVE_SCHEMA,
  NARRATIVE_SYSTEM,
  NarrativeAnswer,
  writeNarrativePrompt,
} from '../src/services/ai/prompts/narrative';
import { RISK_PROMPT_VERSION, RISK_SCHEMA, RISK_SYSTEM, riskAnalysisPrompt } from '../src/services/ai/prompts/risk';
import {
  ASSESSMENT_PROMPT_VERSION,
  ASSESSMENT_SCHEMA,
  ASSESSMENT_SYSTEM,
  AssessmentAnswer,
  assessmentPrompt,
} from '../src/services/ai/prompts/assessment';

const SCRIPT = '<script>alert("x")</script>';
const ESCAPED_SCRIPT = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;';

describe('AI answer schemas', () => {
  it.each([
    ['qualitative coding', QUALITATIVE_SCHEMA],
    ['report narrative', NARRATIVE_SCHEMA],
    ['risk analysis', RISK_SCHEMA],
    ['assessment report', ASSESSMENT_SCHEMA],
  ])('the %s schema is valid for structured outputs', (_name, schema) => {
    expect(structuredOutputSchemaProblems(schema)).toEqual([]);
  });

  it('uses the Prisma enum values for sentiment', () => {
    expect([...QUALITATIVE_SCHEMA.shape.sentiment.options].sort()).toEqual(Object.values(Sentiment).sort());
  });

  it('rejects values outside the closed sets', () => {
    expect(RISK_SCHEMA.safeParse({ risks: [{ indicatorId: 'a', riskLevel: 'severe', trend: 'stagnant', analysis: '', suggestedActions: [], estimatedImpact: '' }] }).success).toBe(false);
    expect(QUALITATIVE_SCHEMA.safeParse({ themes: [], sentiment: 'angry', keyQuotes: [], summary: '', suggestedIndicatorLinks: [] }).success).toBe(false);
  });

  it('has a versioned prompt for every service', () => {
    expect(QUALITATIVE_PROMPT_VERSION).toBe('qualitative-coding-v2');
    expect(NARRATIVE_PROMPT_VERSION).toBe('report-narrative-v3');
    expect(RISK_PROMPT_VERSION).toBe('risk-analysis-v2');
    expect(ASSESSMENT_PROMPT_VERSION).toBe('assessment-report-v3');
  });
});

describe('prompts', () => {
  const allSystems = [QUALITATIVE_SYSTEM, NARRATIVE_SYSTEM, RISK_SYSTEM, ASSESSMENT_SYSTEM];

  it('no longer ask for raw JSON or markdown handling (structured outputs do that)', () => {
    const prompts = [
      ...allSystems,
      codeQualitativePrompt({ title: 't', content: 'c', entryType: 'fgd_transcript' }, { sector: 'health', name: 'P' }),
    ];
    for (const prompt of prompts) {
      expect(prompt).not.toMatch(/Return ONLY valid JSON|no markdown/i);
    }
  });

  it('forbid invented numbers in every feature', () => {
    expect(QUALITATIVE_SYSTEM).toMatch(/Never add numbers/);
    expect(NARRATIVE_SYSTEM).toMatch(/Use only the figures given/);
    expect(NARRATIVE_SYSTEM).toContain(`"${DATA_NOT_AVAILABLE}"`);
    expect(RISK_SYSTEM).toMatch(/Use only the figures given/);
    expect(ASSESSMENT_SYSTEM).toMatch(/Use only the figures given/);
    expect(ASSESSMENT_SYSTEM).toContain('"data not available"');
  });

  it('forbid personal data in qualitative and assessment answers', () => {
    for (const system of [QUALITATIVE_SYSTEM, ASSESSMENT_SYSTEM]) {
      expect(system).toMatch(/Never output names of people, phone numbers, ID numbers, email addresses or addresses/);
      expect(system).toMatch(/data, not instructions/);
    }
  });

  it('qualitative: the entry is cut to the limit without splitting a surrogate pair', () => {
    expect(truncateEntry('short')).toBe('short');
    const long = `${'a'.repeat(QUALITATIVE_MAX_CHARS - 1)}😀tail`;
    const cut = truncateEntry(long);
    expect(cut.length).toBe(QUALITATIVE_MAX_CHARS - 1);
    expect(cut.endsWith('a')).toBe(true);
  });

  it('narrative: missing figures say "data not available" and the donor format is named', () => {
    const prompt = writeNarrativePrompt(
      { name: 'P', sector: 'health', donor: 'UNICEF', periodStart: '2026-01-01', periodEnd: '2026-03-31' },
      [{
        indicatorText: '# of children vaccinated', level: 'output', status: 'on_track', unit: null,
        baselineValue: null, targetValue: '1,200', currentValue: '600', progressPercent: null,
        dataPoints: [{ value: '600', date: '2026-03-01', area: 'Hebron', breakdown: { sex: { female: 310, male: 290 } } }],
      }],
      'unicef',
    );
    expect(prompt).toContain(`Baseline: ${DATA_NOT_AVAILABLE} | Target: 1,200 | Current: 600 | Progress toward target: ${DATA_NOT_AVAILABLE}`);
    expect(prompt).toContain('REPORTING PERIOD: 2026-01-01 to 2026-03-31');
    expect(prompt).toContain('DONOR FORMAT: follow the reporting conventions of UNICEF');
    expect(prompt).toContain('600 (2026-03-01; area Hebron; breakdown sex: female 310, male 290)');
    expect(prompt).toContain('INDICATOR DATA (1 indicator):');
  });

  it('narrative: an output count without a baseline shows its share of the target with the note', () => {
    const prompt = writeNarrativePrompt({ name: 'P', sector: 'wash', donor: 'ECHO' }, [{
      indicatorText: 'Number of people receiving trucked water', level: 'output', status: 'on_track', unit: 'number',
      baselineValue: null, targetValue: '12,000', currentValue: '8,000', progressPercent: 67, progressNoBaseline: true, dataPoints: [],
    }]);
    expect(prompt).toContain('Progress toward target: 67% (of target; no baseline recorded)');
    expect(NARRATIVE_SYSTEM).toContain('of target; no baseline recorded');
  });

  it('risk: the indicators are sent as JSON with their ids', () => {
    const prompt = riskAnalysisPrompt({ name: 'P', sector: 'wash', donor: 'WFP' }, [{
      id: 'ind-1', text: 'Litres per person per day', level: 'outcome', status: 'off_track', unit: 'litres', direction: 'increase',
      baseline: '9', target: '15', current: '8', computedTrend: 'declining', dataPoints: [{ value: '8', date: '2026-05-01' }],
    }]);
    expect(prompt).toContain('"id": "ind-1"');
    expect(prompt).toContain('"computedTrend": "declining"');
  });

  it('assessment: the no-baseline note travels with the progress figure', () => {
    const prompt = assessmentPrompt({
      assessmentType: 'midterm',
      project: { name: 'P', sector: 'wash', donor: 'ECHO', donorType: 'echo', startDate: '2026-01-01', endDate: '2027-12-31', targetBeneficiaries: 12000, geographicScope: 'Gaza', budgetUsd: null },
      indicators: [{
        text: 'People receiving trucked water', level: 'output', status: 'on_track', unit: 'number', baseline: null, target: '12,000', current: '8,000',
        progressPercent: 67, progressNote: 'of target; no baseline recorded', trend: 'insufficient_data', recentDataPoints: [],
      }],
      statusCounts: { on_track: 1 }, achievementRate: 100, qualitative: [], documents: [],
    });
    expect(prompt).toContain('"progressPercent": 67,\n    "progressNote": "of target; no baseline recorded"');
    expect(ASSESSMENT_SYSTEM).toContain('"progressNote": "of target; no baseline recorded"');
  });

  it('assessment: unknown project facts say "data not available", not zero', () => {
    const prompt = assessmentPrompt({
      assessmentType: 'midterm',
      project: { name: 'P', sector: 'health', donor: 'EU', donorType: 'eu', startDate: '2026-01-01', endDate: '2027-12-31', targetBeneficiaries: null, geographicScope: null, budgetUsd: null },
      indicators: [], statusCounts: {}, achievementRate: null, qualitative: [], documents: [],
    });
    expect(prompt).toContain('- Budget (USD): data not available');
    expect(prompt).toContain('- Target beneficiaries: data not available');
    expect(prompt).toContain('achievement rate data not available');
    expect(prompt).not.toContain('$0');
  });
});

describe('narrative: breakdown formatting', () => {
  const GAZA_LOCALITIES = [
    'Gaza City', 'Jabalia', 'Beit Lahia', 'Beit Hanoun', 'Deir al-Balah', 'Nuseirat', 'Bureij', 'Maghazi', 'Khan Younis', 'Rafah',
  ];
  const location = Object.fromEntries(GAZA_LOCALITIES.map((name, i) => [`${name} collective shelter, displacement site ${i + 1}`, 1500 + i * 111]));

  it('formats each dimension as "name: category count, …"', () => {
    expect(formatBreakdown({ sex: { female: 9120, male: 8790 } })).toBe('sex: female 9120, male 8790');
    expect(formatBreakdown({ disability: { yes: 12, no: 206 }, sex: { female: 120, male: 98 } })).toBe('sex: female 120, male 98; disability: yes 12, no 206');
  });

  it('never cuts a number: a long location dimension is left out whole and the omission is said', () => {
    // The review case: 10 localities and the sex dimension, stored in this order.
    const breakdown = { location, sex: { female: 9120, male: 8790 } };
    expect(JSON.stringify(breakdown).length).toBeGreaterThan(MAX_BREAKDOWN_CHARS);
    const text = formatBreakdown(breakdown, 200);
    expect(text).toBe(`sex: female 9120, male 8790 ${BREAKDOWN_OMITTED}`);

    // With room for it, the location dimension is sent whole, after sex.
    const all = formatBreakdown(breakdown, 1000);
    expect(all.startsWith('sex: female 9120, male 8790; location: Gaza City collective shelter, displacement site 1 1500, ')).toBe(true);
    expect(all.endsWith('Rafah collective shelter, displacement site 10 2499')).toBe(true);
    expect(all).not.toContain(BREAKDOWN_OMITTED);
  });

  it('keeps every dimension that fits, in priority order, and every number whole at the default budget', () => {
    const breakdown = { location, age: { '0-17': 9000, '18-59': 8000, '60+': 910 }, sex: { female: 9120, male: 8790 } };
    const text = formatBreakdown(breakdown);
    expect(text.length).toBeLessThanOrEqual(MAX_BREAKDOWN_CHARS + BREAKDOWN_OMITTED.length + 1);
    expect(text).toBe(`sex: female 9120, male 8790; age: 0-17 9000, 18-59 8000, 60+ 910 ${BREAKDOWN_OMITTED}`);
    // Every number in the text is one of the stored counts or part of a label.
    const counts = new Set(['9120', '8790', '9000', '8000', '910', '0', '17', '18', '59', '60']);
    for (const n of text.match(/\d+/g) ?? []) expect(counts.has(n)).toBe(true);
  });

  it('redacts category labels and skips categories that are not numbers', () => {
    expect(formatBreakdown({ location: { 'Camp office 0599123456': 40, Hebron: '1,200', Unknown: 'n/a' } }))
      .toBe('location: Camp office [phone removed] 40, Hebron 1200');
  });

  it('returns "" for no breakdown or a malformed one', () => {
    for (const value of [null, undefined, {}, [], 'x', 5, { sex: 'female' }, { sex: { female: 'many' } }]) {
      expect(formatBreakdown(value)).toBe('');
    }
  });
});

describe('narrative: figure check', () => {
  const project = { name: 'P', sector: 'wash', donor: 'ECHO', periodStart: '2026-07-01', periodEnd: '2026-09-30' };
  const indicators = [{
    indicatorText: 'People receiving at least 15 litres per day', level: 'output', status: 'at_risk', unit: 'number',
    baselineValue: null, targetValue: '12,000', currentValue: '8,000', progressPercent: 67, progressNoBaseline: true,
    dataPoints: [{ value: '8000', date: '2026-09-15', area: 'Rafah', breakdown: { sex: { female: 4100, male: 3900 } } }],
  }];
  const allowed = narrativeAllowedFigures(project, indicators, 'echo');

  it('accepts figures that were sent and lists the others per section', () => {
    const narrative: NarrativeAnswer = {
      executiveSummary: '8,000 of 12,000 people (67% of target; no baseline recorded) received 15 litres in Q3 2026.',
      progress: 'Women 4,100 and men 3,900 by 15 September; 2 indicators reviewed.',
      challenges: 'Coverage fell by 33%.',
      patterns: DATA_NOT_AVAILABLE,
      recommendations: ['Reach 4,000 more people', 'Repair the network'],
    };
    expect(checkNarrativeFigures(narrative, allowed)).toEqual({ challenges: ['33%'], recommendations: ['4,000'] });
  });

  it('report HTML: a visible, escaped warning in each section with unverified figures', () => {
    const html = generateReportHtml({
      projectName: 'P', reportTitle: 'T', model: 'm', promptVersion: 'v', indicators: [],
      narrative: { executiveSummary: 'Fine.', progress: 'Coverage fell by 33%.', challenges: '', patterns: '', recommendations: ['Reach 4,000 more'] },
      unverifiedFigures: { progress: ['33%'], recommendations: ['4,000<script>'] },
    });
    expect(html).toContain('<p>Coverage fell by 33%.</p><p class="figure-check">Check these figures: 33% — not found in the data provided</p></div>');
    expect(html).toContain('Check these figures: 4,000&lt;script&gt; — not found in the data provided');
    expect(html.match(/<script/g)).toBeNull();
    expect(html.split('class="figure-check"').length - 1).toBe(2);
  });
});

describe('qualitative coding: themes and indicator links', () => {
  const indicators = [
    { id: 'ind-water', indicatorText: 'Average litres of water per person per day' },
    { id: 'ind-income', indicatorText: '% of households with a stable monthly income', indicatorTextAr: 'نسبة الأسر ذات دخل شهري مستقر' },
    { id: 'ind-employ', indicatorText: 'Number of youth in employment six months after training' },
  ];

  it('keeps topic keywords and drops stop words and short words', () => {
    expect(linkKeywords('Number of people with income, employment & %')).toEqual(['income', 'employment']);
    expect(linkKeywords('of the % to')).toEqual([]);
    expect(linkKeywords('دخل الأسر في')).toEqual(['دخل', 'الأسر']);
  });

  it('links each suggestion to the indicator matching the most keywords', () => {
    const links = [
      { indicatorKeywords: 'households monthly income', relevance: '' },
      { indicatorKeywords: 'youth employment training', relevance: '' },
    ];
    expect(linkIndicators(links, indicators)).toEqual(['ind-income', 'ind-employ']);
  });

  it('does not link on stop words alone and returns unique ids', () => {
    const links = [
      { indicatorKeywords: 'number of people', relevance: '' },
      { indicatorKeywords: 'water litres', relevance: '' },
      { indicatorKeywords: 'water', relevance: '' },
      { indicatorKeywords: 'unrelated topic', relevance: '' },
    ];
    expect(linkIndicators(links, indicators)).toEqual(['ind-water']);
  });

  it('matches Arabic indicator texts', () => {
    expect(linkIndicators([{ indicatorKeywords: 'دخل شهري', relevance: '' }], indicators)).toEqual(['ind-income']);
  });

  it('returns no links when there are no indicators or suggestions', () => {
    expect(linkIndicators([], indicators)).toEqual([]);
    expect(linkIndicators([{ indicatorKeywords: 'water', relevance: '' }], [])).toEqual([]);
  });

  it('trims, de-duplicates, redacts and caps themes', () => {
    expect(normalizeThemes([' Water access ', 'water access', '', 'Call 0599123456'])).toEqual(['Water access', 'Call [phone removed]']);
    expect(normalizeThemes(Array.from({ length: 15 }, (_, i) => `Theme ${i}`))).toHaveLength(10);
  });
});

describe('risk analysis: merging the answer', () => {
  const indicator = (id: string, status: string, overrides: Partial<AtRiskIndicator> = {}): AtRiskIndicator => ({
    id,
    indicatorText: `Indicator ${id}`,
    level: 'outcome',
    status,
    unit: null,
    direction: null,
    baselineValue: '10',
    targetValue: '1,200',
    currentValue: '45%',
    dataPoints: [{ value: '40', collectionDate: new Date('2026-05-01') }, { value: '50', collectionDate: new Date('2026-02-01') }],
    ...overrides,
  });

  it('uses the answer for known ids, ignores unknown and repeated ids, and falls back for missing ones', () => {
    const a = indicator('a', 'off_track');
    const b = indicator('b', 'at_risk');
    const merged = mergeRiskAnswer([a, b], {
      risks: [
        { indicatorId: 'zzz', riskLevel: 'low', trend: 'improving', analysis: 'Not an input indicator.', suggestedActions: ['x'], estimatedImpact: 'x' },
        { indicatorId: 'a', riskLevel: 'critical', trend: 'declining', analysis: ' Off track since Q1. ', suggestedActions: [' Phone survey ', ''], estimatedImpact: 'Outcome 1 at risk.' },
        { indicatorId: 'a', riskLevel: 'low', trend: 'improving', analysis: 'Second answer.', suggestedActions: [], estimatedImpact: '' },
      ],
    });
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual({
      indicatorId: 'a', indicatorText: 'Indicator a', level: 'outcome', currentValue: 45, targetValue: 1200, status: 'off_track',
      riskLevel: 'critical', trend: 'declining', aiAnalysis: 'Off track since Q1.', suggestedActions: ['Phone survey'], estimatedImpact: 'Outcome 1 at risk.',
    });
    expect(merged[1]).toEqual(fallbackRiskAlert(b));
    expect(merged.map(r => r.indicatorId)).not.toContain('zzz');
  });

  it('fills empty answer fields from the deterministic assessment', () => {
    const a = indicator('a', 'at_risk');
    const [merged] = mergeRiskAnswer([a], { risks: [{ indicatorId: 'a', riskLevel: 'high', trend: 'stagnant', analysis: ' ', suggestedActions: [' '], estimatedImpact: '' }] });
    const fallback = fallbackRiskAlert(a);
    expect(merged.aiAnalysis).toBe(fallback.aiAnalysis);
    expect(merged.suggestedActions).toEqual(fallback.suggestedActions);
    expect(merged.estimatedImpact).toBe(fallback.estimatedImpact);
    expect(merged.riskLevel).toBe('high');
  });

  it('takes the trend from the data whenever there are two comparable points, the model\'s only otherwise', () => {
    // A "decrease" indicator rising from 22% to 30% is getting worse, whatever the model says.
    const worse = indicator('a', 'off_track', {
      direction: 'decrease', baselineValue: '22%', targetValue: '10%', currentValue: '30%',
      dataPoints: [{ value: '30%', collectionDate: new Date('2026-09-01') }, { value: '22%', collectionDate: new Date('2026-06-01') }],
    });
    const noData = indicator('b', 'at_risk', { dataPoints: [] });
    const otherAreas = indicator('c', 'at_risk', {
      dataPoints: [
        { value: '30', collectionDate: new Date('2026-09-01'), geographicArea: 'Gaza' },
        { value: '40', collectionDate: new Date('2026-06-01'), geographicArea: 'Hebron' },
      ],
    });
    const answer = (id: string) => ({ indicatorId: id, riskLevel: 'low' as const, trend: 'improving' as const, analysis: 'Analysis.', suggestedActions: ['Act'], estimatedImpact: 'Impact.' });
    const merged = mergeRiskAnswer([worse, noData, otherAreas], { risks: [answer('a'), answer('b'), answer('c')] });
    expect(merged.map(r => r.trend)).toEqual(['declining', 'improving', 'improving']);
    expect(merged[0].riskLevel).toBe('low');
  });

  it('replaces texts with numbers that were not sent, drops such actions and redacts the rest', () => {
    const a = indicator('a', 'off_track', {
      direction: 'decrease', baselineValue: '22%', targetValue: '10%', currentValue: '30%',
      dataPoints: [{ value: '30%', collectionDate: new Date('2026-09-01') }, { value: '22%', collectionDate: new Date('2026-06-01') }],
    });
    const fallback = fallbackRiskAlert(a);
    const [merged] = mergeRiskAnswer([a], {
      risks: [{
        indicatorId: 'a', riskLevel: 'high', trend: 'improving',
        analysis: 'Rose from 22% to 30%, showing strong improvement of 36%.',
        suggestedActions: ['Reach 500 more households', 'Call the focal point on 0599123456', 'Check the 30% figure'],
        estimatedImpact: 'Up to 1,200 households affected.',
      }],
    });
    expect(merged.aiAnalysis).toBe(fallback.aiAnalysis);
    expect(merged.estimatedImpact).toBe(fallback.estimatedImpact);
    expect(merged.suggestedActions).toEqual(['Call the focal point on [phone removed]', 'Check the 30% figure']);

    const [kept] = mergeRiskAnswer([a], {
      risks: [{ indicatorId: 'a', riskLevel: 'high', trend: 'improving', analysis: 'Rose from 22% to 30% by 1 September 2026.', suggestedActions: ['Reach 500 more households'], estimatedImpact: 'Outcome 1 at risk.' }],
    });
    expect(kept.aiAnalysis).toBe('Rose from 22% to 30% by 1 September 2026.');
    expect(kept.suggestedActions).toEqual(fallback.suggestedActions);
    expect(kept.estimatedImpact).toBe('Outcome 1 at risk.');
  });

  it('allows the figures of every indicator sent, never their ids', () => {
    const a = indicator('3f2a9c41-0000-4000-8000-000000000123', 'off_track', { indicatorText: 'Households reached' });
    const figures = riskAllowedFigures([a]);
    expect(figures).toEqual(expect.arrayContaining(['10', '1,200', '45%', '40', '50', '2026-05-01']));
    expect(figures.join(' ')).not.toContain('3f2a9c41');
  });

  it('deterministic assessment: high when off track, medium when at risk, trend from the data', () => {
    expect(fallbackRiskAlert(indicator('a', 'off_track'))).toMatchObject({ riskLevel: 'high', trend: 'declining' });
    expect(fallbackRiskAlert(indicator('b', 'at_risk', { direction: 'decrease' }))).toMatchObject({ riskLevel: 'medium', trend: 'improving' });
    expect(fallbackRiskAlert(indicator('c', 'at_risk', { dataPoints: [] }))).toMatchObject({ trend: 'stagnant', aiAnalysis: 'This outcome indicator is at risk and requires attention.' });
    expect(fallbackRiskAlert(indicator('d', 'off_track', { currentValue: null, targetValue: 'about 50' }))).toMatchObject({ currentValue: null, targetValue: null });
  });
});

describe('assessment: document summaries', () => {
  const base = { fileName: 'proposal.pdf', fileType: 'proposal' };

  it('reads Document.aiAnalysis (the contract shape)', () => {
    const summary = documentSummaryFor({
      ...base,
      parsedText: 'Full text',
      aiAnalysis: { documentType: 'proposal', summary: 'Livelihoods project.', keyFindings: ['1,200 households', ' '], indicatorsMentioned: [], targetsMentioned: [], recommendations: [], model: 'm', promptVersion: 'v', analysedAt: '2026-10-01T00:00:00Z' },
    });
    expect(summary).toEqual({ name: 'proposal.pdf', type: 'proposal', summary: 'Livelihoods project.', keyFindings: ['1,200 households'] });
  });

  it('falls back to the legacy analysis appended to parsedText', () => {
    const summary = documentSummaryFor({
      ...base,
      parsedText: 'Old text\n\n---AI_ANALYSIS---\n{"summary":"Legacy summary, call 0599123456","keyFindings":["A"],"indicators_mentioned":["x"]}',
      aiAnalysis: null,
    });
    expect(summary.summary).toBe('Legacy summary, call [phone removed]');
    expect(summary.keyFindings).toEqual(['A']);
  });

  it('uses the first 300 characters of the redacted text before the marker when the legacy JSON is malformed', () => {
    const text = `Contact 0599123456 or ID 401234567. ${'word '.repeat(100)}`;
    const summary = documentSummaryFor({ ...base, parsedText: `${text}\n---AI_ANALYSIS---\n{not json`, aiAnalysis: null });
    expect(summary.summary.startsWith('Contact [phone removed] or ID [ID number removed].')).toBe(true);
    expect(summary.summary.length).toBeLessThanOrEqual(300);
    expect(summary.summary).not.toContain('AI_ANALYSIS');
    expect(summary.keyFindings).toEqual([]);
  });

  it('splits a legacy row at the LAST marker, so a marker quoted in the document text stays text', () => {
    const parsedText = 'Guidelines quoting ---AI_ANALYSIS--- in the text.\n\n---AI_ANALYSIS---\n{"summary":"Legacy summary","keyFindings":[]}';
    expect(documentSummaryFor({ ...base, parsedText, aiAnalysis: null }).summary).toBe('Legacy summary');
    const broken = 'Guidelines quoting ---AI_ANALYSIS--- in the text.\n---AI_ANALYSIS---\n{not json';
    expect(documentSummaryFor({ ...base, parsedText: broken, aiAnalysis: null }).summary).toBe('Guidelines quoting ---AI_ANALYSIS--- in the text.');
  });

  it('uses the redacted text when there is no analysis at all, and redacts the file name', () => {
    const summary = documentSummaryFor({ fileName: 'list 0599123456.pdf', fileType: 'other', parsedText: 'Mail sara@example.ps', aiAnalysis: { summary: '', keyFindings: [] } });
    expect(summary).toEqual({ name: 'list [phone removed].pdf', type: 'other', summary: 'Mail [email removed]', keyFindings: [] });
  });

  it('never cuts a number of the fallback text in half', () => {
    const text = `${'word '.repeat(58)}reached 1,250 households.`;
    expect(text.indexOf('1,250')).toBeLessThan(300);
    expect(text.indexOf('1,250') + 5).toBeGreaterThan(300);
    const summary = documentSummaryFor({ ...base, parsedText: text, aiAnalysis: null });
    expect(summary.summary.endsWith('reached')).toBe(true);
    expect(summary.summary).not.toContain('1,2');
  });

  it('handles a document without text', () => {
    expect(documentSummaryFor({ ...base, parsedText: null, aiAnalysis: null })).toEqual({ name: 'proposal.pdf', type: 'proposal', summary: '', keyFindings: [] });
  });
});

const ASSESSMENT: AssessmentAnswer = {
  executiveSummary: 'Overall progress is moderate.\n\nTwo indicators are off track.',
  methodology: 'Indicator monitoring data and 3 focus group transcripts.',
  keyFindings: [{ area: 'Livelihoods', finding: 'Income indicator on track.', evidence: 'Current 22% against target 22%.', rating: 'strong' }],
  indicatorAnalysis: { overallAchievement: '50% achievement rate.', strongPerformers: ['Income'], challengeAreas: ['Water'], dataGaps: ['Disability data'] },
  qualitativeInsights: { mainThemes: ['Access'], beneficiaryVoices: 'Participants value the training.', contextualFactors: 'Closures delayed visits.' },
  recommendations: [{ priority: 'high', recommendation: 'Add a phone survey.', timeline: 'immediate', responsible: 'M&E officer' }],
  lessonsLearned: ['Plan for access constraints.'],
  riskAssessment: { currentRisks: ['Access (likely, high impact)'], mitigationStrategies: ['Remote monitoring'] },
  nextSteps: ['Collect endline data'],
};

describe('assessment: normalisation and failure message', () => {
  it('trims, redacts personal data the model wrote, and drops empty entries', () => {
    const out = normalizeAssessment({
      ...ASSESSMENT,
      executiveSummary: '  Summary. Contact 0599123456.  ',
      keyFindings: [...ASSESSMENT.keyFindings, { area: 'x', finding: ' ', evidence: '', rating: 'weak' }],
      recommendations: [...ASSESSMENT.recommendations, { priority: 'low', recommendation: '', timeline: 'medium_term', responsible: '' }],
      lessonsLearned: ['', ' Lesson '],
      qualitativeInsights: { ...ASSESSMENT.qualitativeInsights, beneficiaryVoices: 'Email sara@example.ps' },
    });
    expect(out.executiveSummary).toBe('Summary. Contact [phone removed].');
    expect(out.keyFindings).toHaveLength(1);
    expect(out.recommendations).toHaveLength(1);
    expect(out.lessonsLearned).toEqual(['Lesson']);
    expect(out.qualitativeInsights.beneficiaryVoices).toBe('Email [email removed]');
  });

  it('keeps a valid answer as it is', () => {
    expect(normalizeAssessment(ASSESSMENT)).toEqual(ASSESSMENT);
  });

  it('stores the kind of failure only, never the error text', () => {
    const cases: [unknown, RegExp][] = [
      [new AiRefusalError('assessment.report', 'cyber'), /declined/],
      [new AiOutputTruncatedError('assessment.report', 16000), /too long/],
      [new AiInvalidOutputError('assessment.report', ['root.keyFindings: expected array']), /expected format/],
      [new AiRequestError('assessment.report', 529, true, 4), /could not be reached/],
      [new AiError('model said: secret beneficiary text', 'assessment.report'), /unexpected error/],
      [new Error('model said: secret beneficiary text'), /unexpected error/],
      ['a string', /unexpected error/],
    ];
    for (const [err, pattern] of cases) {
      const message = assessmentFailureMessage(err);
      expect(message).toMatch(/^AI generation failed: /);
      expect(message).toMatch(pattern);
      expect(message).not.toContain('secret');
      expect(message).not.toContain('keyFindings');
    }
  });
});

describe('assessment: cutAtWord', () => {
  it('ends at a word boundary and never splits a number', () => {
    expect(cutAtWord('short text', 50)).toBe('short text');
    expect(cutAtWord('reached 1,250 households', 12)).toBe('reached');
    expect(cutAtWord('reached 1,250 households', 13)).toBe('reached 1,250');
    expect(cutAtWord('reached 1,250 households', 14)).toBe('reached 1,250');
    expect(cutAtWord('ابلغ ١٬٢٥٠ أسرة', 8)).toBe('ابلغ');
    expect(cutAtWord('x'.repeat(20), 10)).toBe('x'.repeat(10));
  });
});

describe('assessment: figure check', () => {
  const allowed = [JSON.stringify({ indicators: [{ current: '40%', target: '60%', progressPercent: 50 }], statusCounts: { on_track: 1 }, achievementRate: 50, qualitative: [{ participants: 12 }] })];

  it('lists the numbers of each section that were not sent', () => {
    const report: AssessmentAnswer = {
      ...ASSESSMENT,
      executiveSummary: 'Achievement is 50%; income reached 40% of households against 60%.',
      keyFindings: [{ area: 'Income', finding: 'Income rose by 15 points.', evidence: 'Current 40%.', rating: 'moderate' }],
      qualitativeInsights: { ...ASSESSMENT.qualitativeInsights, beneficiaryVoices: '12 participants; 75% were satisfied.' },
      nextSteps: ['Survey 400 households'],
    };
    expect(checkAssessmentFigures(report, allowed)).toEqual({
      keyFindings: ['15'],
      qualitativeInsights: ['75%'],
      nextSteps: ['400'],
    });
  });

  it('assessment HTML: a visible, escaped warning in each section with unverified figures', () => {
    const html = generateAssessmentHtml({
      project: { name: 'P', sector: 'livelihoods', donor: 'EU' },
      assessmentType: 'midterm',
      report: ASSESSMENT,
      unverifiedFigures: { executiveSummary: ['36%'], keyFindings: ['1,500'], nextSteps: ['<b>9</b>'] },
      statusCounts: { on_track: 1, at_risk: 0, off_track: 1, not_started: 0, completed: 0 },
      totalIndicators: 2,
      model: 'm',
      promptVersion: 'v',
    });
    expect(html).toContain('<p>Two indicators are off track.</p>\n<p class="figure-check">Check these figures: 36% — not found in the data provided</p>');
    expect(html).toContain('Check these figures: 1,500 — not found in the data provided');
    expect(html).toContain('<h2>Next Steps</h2><ol><li>Collect endline data</li></ol><p class="figure-check">Check these figures: &lt;b&gt;9&lt;/b&gt;');
    expect(html.split('class="figure-check"').length - 1).toBe(3);
  });
});

describe('HTML builders escape every interpolated value', () => {
  it('report HTML: model output, indicator text and titles', () => {
    const narrative: NarrativeAnswer = {
      executiveSummary: `Summary ${SCRIPT}`,
      progress: `Progress ${SCRIPT}\nSecond paragraph`,
      challenges: SCRIPT,
      patterns: SCRIPT,
      recommendations: [SCRIPT, 'Collect disability data'],
    };
    const html = generateReportHtml({
      projectName: `Project ${SCRIPT}`,
      reportTitle: `Title ${SCRIPT}`,
      narrative,
      indicators: [{ indicatorText: `<img src=x onerror=alert(1)> ${SCRIPT}`, level: 'outcome', status: 'off_track', baselineValue: '"10"', targetValue: null, currentValue: '<b>5</b>' }],
      model: 'claude-sonnet-5-5"><script>',
      promptVersion: 'report-narrative-v2',
      generatedAt: new Date('2026-10-12T00:00:00Z'),
    });
    expect(html).not.toContain(SCRIPT);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>5</b>');
    expect(html.match(/<script/g)).toBeNull();
    expect(html).toContain(`<h1>Title ${ESCAPED_SCRIPT}</h1>`);
    expect(html).toContain(`<p>Progress ${ESCAPED_SCRIPT}</p>\n<p>Second paragraph</p>`);
    expect(html).toContain(`<ol><li>${ESCAPED_SCRIPT}</li><li>Collect disability data</li></ol>`);
    expect(html).toContain('<td>&lt;img src=x onerror=alert(1)&gt; ');
    expect(html).toContain('<td>&quot;10&quot;</td>');
    expect(html).toContain('<td>N/A</td>');
    expect(html).toContain('off track</span>');
    expect(html).toContain('AI suggested — review before approval');
    for (const heading of ['Executive Summary', 'Progress Against Targets', 'Challenges', 'Patterns', 'Recommendations', 'Indicator Summary']) {
      expect(html).toContain(`<h2>${heading}</h2>`);
    }
  });

  it('report HTML: empty sections are left out', () => {
    const html = generateReportHtml({
      projectName: 'P', reportTitle: 'T',
      narrative: { executiveSummary: 'Only this.', progress: '', challenges: ' ', patterns: '', recommendations: [] },
      indicators: [], model: 'm', promptVersion: 'v',
    });
    expect(html).toContain('<h2>Executive Summary</h2>');
    expect(html).not.toContain('<h2>Challenges</h2>');
    expect(html).not.toContain('<h2>Recommendations</h2>');
  });

  it('assessment HTML: every field of the answer and the project facts', () => {
    const evil: AssessmentAnswer = {
      executiveSummary: SCRIPT,
      methodology: SCRIPT,
      keyFindings: [{ area: SCRIPT, finding: SCRIPT, evidence: SCRIPT, rating: 'weak' }],
      indicatorAnalysis: { overallAchievement: SCRIPT, strongPerformers: [SCRIPT], challengeAreas: [SCRIPT], dataGaps: [SCRIPT] },
      qualitativeInsights: { mainThemes: [SCRIPT], beneficiaryVoices: SCRIPT, contextualFactors: SCRIPT },
      recommendations: [{ priority: 'high', recommendation: SCRIPT, timeline: 'short_term', responsible: SCRIPT }],
      lessonsLearned: [SCRIPT],
      riskAssessment: { currentRisks: [SCRIPT], mitigationStrategies: [SCRIPT] },
      nextSteps: [SCRIPT],
    };
    const html = generateAssessmentHtml({
      project: { name: SCRIPT, sector: SCRIPT, donor: SCRIPT },
      assessmentType: `midterm${SCRIPT}`,
      report: evil,
      statusCounts: { on_track: 1, at_risk: 1, off_track: 1, not_started: 0, completed: 1 },
      totalIndicators: 4,
      model: SCRIPT,
      promptVersion: SCRIPT,
    });
    expect(html.match(/<script/g)).toBeNull();
    // 24 interpolated values (18 from the answer, 3 project facts, the type, the model and the prompt version), each escaped.
    expect(html.split(ESCAPED_SCRIPT).length - 1).toBe(24);
    expect(html).toContain('<div class="value">50%</div>');
    expect(html).toContain('<div class="rec high">');
    expect(html).toContain('Short term');
  });

  it('assessment HTML: sections and metrics of a normal answer', () => {
    const html = generateAssessmentHtml({
      project: { name: 'P', sector: 'livelihoods', donor: 'EU' },
      assessmentType: 'baseline',
      report: ASSESSMENT,
      statusCounts: { on_track: 0, at_risk: 0, off_track: 0, not_started: 0, completed: 0 },
      totalIndicators: 0,
      model: 'claude-sonnet-5-5',
      promptVersion: 'assessment-report-v2',
    });
    expect(html).toContain('<h1>AI Baseline Assessment</h1>');
    expect(html).toContain('<div class="value">N/A</div>');
    expect(html).toContain('<p>Overall progress is moderate.</p>\n<p>Two indicators are off track.</p>');
    expect(html).toContain('<h3>Data Gaps</h3><ul><li>Disability data</li></ul>');
    expect(html).toContain('<h2>Next Steps</h2><ol><li>Collect endline data</li></ol>');
    expect(html).toContain('AI suggested — review before approval');
    expect(html).toContain('content="Raqib AI assessment (assessment-report-v2; claude-sonnet-5-5)"');
  });
});

describe('assessmentTypeLabel', () => {
  it.each([
    ['baseline', 'Baseline'],
    ['midterm', 'Midterm'],
    ['endline', 'Endline'],
    ['fgd_round', 'FGD round'],
    ['kii_round', 'KII round'],
    ['observation_round', 'Observation round'],
    ['survey_round', 'Survey round'],
    ['post_distribution_monitoring', 'Post distribution monitoring'],
  ])('%s reads as "%s"', (type, label) => {
    expect(assessmentTypeLabel(type)).toBe(label);
  });
});
