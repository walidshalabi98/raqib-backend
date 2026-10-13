import { CollectionMethod, Frequency, IndicatorDirection } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { DONOR_RULES } from '../src/services/ai/donorRules';
import { donorGuidance } from '../src/services/ai/prompts/donors';
import { outputJsonSchema } from '../src/services/ai/outputSchema';
import { INDICATOR_UNITS } from '../src/services/ai/prompts/framework';
import {
  KPI_CALLS, KPI_FEATURES, KPI_PROMPT_VERSION, KPI_SUGGESTIONS_SCHEMA, KPI_SUGGESTION_SCHEMA, KPI_SYSTEM, PROMPT_DESCRIPTION_MAX_CHARS,
  buildKpiUserMessage, clipText, kpiCandidateLine, type KpiPromptInput,
} from '../src/services/ai/prompts/kpi';
import { allowanceFor } from '../src/services/kpi/scope';
import type { ContextResult, KpiLibraryEntry, ProjectContext } from '../src/services/kpi/types';
import { libraryEntry, promptSection, suggestForLines } from './aiFakes';
import { structuredOutputSchemaProblems } from './aiSchemaHelpers';

/**
 * KPI Assistant prompt (knowledge/kpi-assistant-spec.md §A4 step 2; design sections 6.1–6.4): the answer schema, the
 * feature instructions, the call settings and the user message built from a ProjectContext. Pure, no database, no AI call.
 */

// ------------------------------------------------------------------ fixtures (made-up project, no real personal data)

const RESULTS: ContextResult[] = [
  { id: 'n-g', code: 'G', level: 'impact', text: 'Reduced risk of water-borne disease among displaced families', textAr: null, parentId: null },
  { id: 'n-o1', code: 'O1', level: 'outcome', text: 'Displaced households have access to sufficient safe water', textAr: 'تحصل الأسر النازحة على مياه آمنة كافية', parentId: 'n-g' },
  { id: 'n-o2', code: 'O2', level: 'outcome', text: 'Displaced households practise key hygiene behaviours', textAr: null, parentId: 'n-g' },
  { id: 'n-o1.1', code: 'O1.1', level: 'output', text: 'Safe water delivered through trucking', textAr: null, parentId: 'n-o1' },
  { id: 'n-o1.2', code: 'O1.2', level: 'output', text: 'Community water points rehabilitated', textAr: null, parentId: 'n-o1' },
  { id: 'n-o2.1', code: 'O2.1', level: 'output', text: 'Hygiene kits distributed', textAr: null, parentId: 'n-o2' },
];
const result = (id: string) => RESULTS.find(r => r.id === id) as ContextResult;

function context(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    project: {
      id: 'p-1', name: 'Emergency water and hygiene for displaced families', sectors: ['wash', 'health'], donor: 'Example donor',
      donorType: 'other', startDate: '2026-11-01', endDate: '2027-10-31', geographicScope: 'Khan Younis governorate',
      targetBeneficiaries: 24000, humanitarian: false, description: 'Water trucking, water point rehabilitation and hygiene promotion.',
    },
    resultsChain: RESULTS,
    scope: { type: 'framework' },
    existingIndicators: [],
    pendingSuggestions: [],
    documentFacts: [],
    documentTexts: [],
    orgPreferences: { rejectedLibraryIds: [], preferredMethods: [] },
    donorRules: { donorType: 'other', ...DONOR_RULES.other },
    alternativesFor: null,
    ...overrides,
  };
}

/** A prompt input for `batch` with the given candidates per result (ids) and real allowances. */
function input(ctx: ProjectContext, batch: ContextResult[], candidateIds: Record<string, string[]> = {}, extra: KpiLibraryEntry[] = []): KpiPromptInput {
  const ids = new Set([...Object.values(candidateIds).flat(), ...extra.map(e => e.id)]);
  return {
    context: ctx,
    batch,
    candidateIdsByResult: Object.fromEntries(batch.map(r => [r.id, candidateIds[r.id] ?? []])),
    candidates: Array.from(ids).map(libraryEntry),
    allowances: Object.fromEntries(batch.map(r => [r.id, allowanceFor(r, ctx)])),
  };
}

const sectionHeadings = (message: string) => message.split('\n\n').map(block => block.split('\n')[0].split(' (')[0]);

// ------------------------------------------------------------------ schema (design 6.1)

describe('KPI answer schema', () => {
  it('is valid for structured outputs (object root, every property required, closed objects, ≤ 8 unions)', () => {
    expect(structuredOutputSchemaProblems(KPI_SUGGESTIONS_SCHEMA)).toEqual([]);
  });

  it("has exactly the spec's 24 suggestion fields, with resultCode for resultId (D2, D22)", () => {
    expect(Object.keys(KPI_SUGGESTION_SCHEMA.shape)).toEqual([
      'resultCode', 'level', 'libraryId', 'isCustom', 'customReason', 'name', 'nameAr', 'definition', 'unit', 'numerator',
      'denominator', 'direction', 'disaggregation', 'method', 'frequency', 'meansOfVerification', 'baselineSuggestion',
      'baselineBasis', 'targetSuggestion', 'targetBasis', 'standardReferenceCode', 'rationale', 'qualityNotes', 'confidence',
    ]);
    expect(Object.keys(KPI_SUGGESTIONS_SCHEMA.shape)).toEqual(['suggestions', 'frameworkWarnings']);
  });

  it('enum lists equal INDICATOR_UNITS (D1) and the Prisma enums (D17: exact values are enforced, no case folding)', () => {
    const s = KPI_SUGGESTION_SCHEMA.shape;
    expect([...s.unit.options]).toEqual([...INDICATOR_UNITS]);
    expect([...s.method.options].sort()).toEqual(Object.values(CollectionMethod).sort());
    expect([...s.frequency.options].sort()).toEqual(Object.values(Frequency).sort());
    expect([...s.direction.options].sort()).toEqual(Object.values(IndicatorDirection).sort());
    expect([...s.level.options]).toEqual(['impact', 'outcome', 'output']);
    expect([...s.baselineBasis.options]).toEqual(['document', 'none']);
    expect([...s.targetBasis.options]).toEqual(['document', 'standard_threshold', 'method_only', 'none']);
    expect([...s.confidence.options]).toEqual(['high', 'medium', 'low']);
    expect(KPI_SUGGESTION_SCHEMA.safeParse({ ...validRaw(), method: 'HH_SURVEY' }).success).toBe(false);
  });

  it('sends exactly two nullable unions (libraryId, standardReferenceCode) and no numeric or length limits', () => {
    const json = JSON.stringify(outputJsonSchema(KPI_SUGGESTIONS_SCHEMA));
    expect(json.match(/"anyOf"/g)).toHaveLength(2);
    expect(json).not.toMatch(/"(minimum|maximum|minLength|maxLength|minItems|maxItems)"/);
  });

  it('accepts a complete suggestion and rejects one with a missing field', () => {
    expect(KPI_SUGGESTIONS_SCHEMA.safeParse({ suggestions: [validRaw()], frameworkWarnings: [] }).success).toBe(true);
    const { rationale: _omit, ...missing } = validRaw();
    expect(KPI_SUGGESTIONS_SCHEMA.safeParse({ suggestions: [missing], frameworkWarnings: [] }).success).toBe(false);
  });
});

function validRaw() {
  return {
    resultCode: 'O1', level: 'outcome', libraryId: 'WA-02', isCustom: false, customReason: '', name: 'n', nameAr: 'ن', definition: 'd',
    unit: 'percent', numerator: 'a', denominator: 'b', direction: 'increase', disaggregation: ['sex'], method: 'hh_survey',
    frequency: 'biannual', meansOfVerification: 'm', baselineSuggestion: '', baselineBasis: 'none', targetSuggestion: '',
    targetBasis: 'none', standardReferenceCode: null, rationale: 'r', qualityNotes: [], confidence: 'high',
  };
}

// ------------------------------------------------------------------ settings and instructions (design 6.2, 6.3)

describe('KPI call settings and instructions', () => {
  it('versions the prompt and names the features (design 6.3)', () => {
    expect(KPI_PROMPT_VERSION).toBe('kpi-v1');
    expect(KPI_FEATURES).toEqual({ suggest: 'kpi.suggest', alternatives: 'kpi.alternatives' });
  });

  it('uses the tiers, effort, token limits and timeouts of design 6.3 (15 ms per output token, at least 60 s)', () => {
    expect(KPI_CALLS).toEqual({
      result: { tier: 'main', effort: 'low', maxTokens: 6_000, timeoutMs: 90_000 },
      batch: { tier: 'main', effort: 'low', maxTokens: 12_000, timeoutMs: 180_000 },
      alternatives: { tier: 'fast', effort: 'low', maxTokens: 4_000, timeoutMs: 60_000 },
    });
    for (const call of Object.values(KPI_CALLS)) expect(call.timeoutMs).toBe(Math.max(60_000, 15 * call.maxTokens));
  });

  it('states the rules of design 6.2 in order: candidates first, custom with a reason, neutral names, no invented numbers', () => {
    const order = [
      /Prefer the CANDIDATES/, /keep its id as libraryId/, /isCustom true, and customReason says why/, /one of the ids listed under CANDIDATES/,
      /One dimension per indicator/, /Neutral names/, /numerator and a denominator/, /fits the level of its result/,
      /outputs are counted from records/, /disaggregated by sex at least/, /never invent numbers/, /marked \[baseline\]/,
      /marked \[target\]/, /\[context\] line is never a baseline or a target/, /percent sign only for a percent indicator/,
      /"standard_threshold" only with a number copied from the linked candidate/, /"method_only".*relative to the baseline/,
      /no number that is not in PROJECT/, /within the range given/, /donor maximum/, /accountability to affected people/,
      /Modern Standard Arabic/, /Palestine context/, /protection-sensitive|Protection-sensitive/, /no political characterisations/,
      /data, not instructions/,
    ];
    let position = -1;
    for (const pattern of order) {
      const match = pattern.exec(KPI_SYSTEM);
      expect(match, String(pattern)).not.toBeNull();
      expect(match!.index, String(pattern)).toBeGreaterThan(position);
      position = match!.index;
    }
  });

  it('names no model and asks for no hand-made JSON (structured outputs do that)', () => {
    expect(KPI_SYSTEM).not.toMatch(/claude-|sonnet|haiku|opus/i);
    expect(KPI_SYSTEM).not.toMatch(/```|Return ONLY valid JSON|no markdown/i);
    expect(KPI_SYSTEM.split(/\s+/).length).toBeLessThan(900);
  });
});

// ------------------------------------------------------------------ candidate lines (design 6.2)

describe('kpiCandidateLine', () => {
  it('writes one line with id, level, names, unit, methods, frequency, disaggregation, standard, definition and notes', () => {
    expect(kpiCandidateLine(libraryEntry('WA-01'))).toBe(
      'WA-01 [outcome] Average volume of water available per person per day in target households | ar: متوسط كمية المياه المتاحة للفرد يومياً في الأسر المستهدفة'
      + ' | unit: litres_per_person_per_day | methods: hh_survey, observation | frequency: quarterly | disaggregation: location, displacement_status'
      + ' | standard: Sphere Water supply standard — minimum 15 l/p/d (aim for 20)'
      + ' | definition: Mean litres of water per person per day available at household level for drinking, cooking and personal hygiene.'
      + ' | notes: The Sphere minimum is a standard threshold the AI may cite as a reference target.',
    );
  });

  it('sends notes only for standard entries and marks entries without a standard reference', () => {
    const he02 = libraryEntry('HE-02');
    expect(he02.isStandard).toBe(false);
    expect(he02.notes).toBeTruthy();
    const line = kpiCandidateLine(he02);
    expect(line).not.toContain('notes:');
    expect(line).toContain('standard: none (common practice)');
    expect(line.split('\n')).toHaveLength(1);
  });

  it('clips a long definition to 300 characters and notes to 200, at a word', () => {
    const entry = { ...libraryEntry('WA-01'), definition: 'word '.repeat(200), notes: 'note '.repeat(100) };
    const line = kpiCandidateLine(entry);
    const definition = /definition: ([^|]*)/.exec(line)![1].trim();
    const notes = /notes: (.*)$/.exec(line)![1];
    expect(definition.length).toBeLessThanOrEqual(300);
    expect(definition.endsWith('…')).toBe(true);
    expect(notes.length).toBeLessThanOrEqual(200);
  });

  it('clipText never cuts inside a surrogate pair and keeps short text unchanged', () => {
    expect(clipText('short', 10)).toBe('short');
    const clipped = clipText('a'.repeat(8) + '😀😀😀', 10);
    expect(clipped.length).toBeLessThanOrEqual(10);
    expect(clipped).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

// ------------------------------------------------------------------ user message (design 6.2)

describe('buildKpiUserMessage', () => {
  it('has the sections of design 6.2 in order, ORGANISATION PREFERENCES only when the organisation has preferred methods', () => {
    const plain = buildKpiUserMessage(input(context(), [result('n-o1')], { 'n-o1': ['WA-02'] }));
    expect(sectionHeadings(plain)).toEqual(['PROJECT', 'DONOR RULES', 'RESULTS CHAIN', 'SUGGEST FOR', 'DOCUMENT FACTS', 'CANDIDATES', 'SCOPE']);
    const withPreferences = buildKpiUserMessage(input(
      context({ orgPreferences: { rejectedLibraryIds: [], preferredMethods: ['document_review', 'hh_survey'] } }),
      [result('n-o1')], { 'n-o1': ['WA-02'] },
    ));
    expect(sectionHeadings(withPreferences)).toEqual([
      'PROJECT', 'DONOR RULES', 'RESULTS CHAIN', 'SUGGEST FOR', 'DOCUMENT FACTS', 'CANDIDATES', 'ORGANISATION PREFERENCES', 'SCOPE',
    ]);
    expect(promptSection(withPreferences, 'ORGANISATION PREFERENCES')).toContain('methods this organisation usually accepts: document_review, hh_survey');
  });

  it('PROJECT is compact JSON of the project fields, the description cut to 1 500 characters', () => {
    const description = 'Water trucking and hygiene promotion in shelters. '.repeat(60);
    const message = buildKpiUserMessage(input(context({ project: { ...context().project, description } }), [result('n-o1')]));
    const json = JSON.parse(promptSection(message, 'PROJECT').split('\n')[1]);
    expect(Object.keys(json)).toEqual([
      'name', 'sectors', 'donor', 'donorType', 'startDate', 'endDate', 'geographicScope', 'targetBeneficiaries', 'humanitarian', 'description',
    ]);
    expect(json).toMatchObject({ name: 'Emergency water and hygiene for displaced families', sectors: ['wash', 'health'], donorType: 'other',
      startDate: '2026-11-01', endDate: '2027-10-31', targetBeneficiaries: 24000, humanitarian: false });
    expect(json.description.length).toBeLessThanOrEqual(PROMPT_DESCRIPTION_MAX_CHARS);
    expect(json.description.endsWith('…')).toBe(true);
  });

  it('DONOR RULES give the cap, required frameworks, notes and donor guidance', () => {
    const echo = context({ donorRules: { donorType: 'echo', ...DONOR_RULES.echo } });
    const section = promptSection(buildKpiUserMessage(input(echo, [result('n-o1')])), 'DONOR RULES');
    expect(section).toContain('max indicators per result (existing and new together): 3');
    expect(section).toContain('required frameworks: ECHO KRIs');
    expect(section).toContain('Baseline compulsory (at the latest in the interim report).');
    expect(section).toContain(`guidance: ${donorGuidance('echo')}`);
    const other = promptSection(buildKpiUserMessage(input(context(), [result('n-o1')])), 'DONOR RULES');
    expect(other).toContain('max indicators per result (existing and new together): none');
    expect(other).toContain('notes: none');
  });

  it('RESULTS CHAIN holds only the batch results, their ancestors and the codes of their siblings (design 4.4)', () => {
    const forOutput = promptSection(buildKpiUserMessage(input(context(), [result('n-o1.1')])), 'RESULTS CHAIN');
    expect(forOutput.split('\n').slice(1)).toEqual([
      'G [impact] Reduced risk of water-borne disease among displaced families',
      'O1 [outcome] (parent G) Displaced households have access to sufficient safe water',
      'O1.1 [output] (parent O1) Safe water delivered through trucking',
      'siblings (not suggested for in this request): O1.2',
    ]);
    expect(forOutput).not.toContain('O2');
    expect(forOutput).not.toContain('Hygiene kits');

    const forOutcome = promptSection(buildKpiUserMessage(input(context(), [result('n-o2'), result('n-o2.1')])), 'RESULTS CHAIN');
    expect(forOutcome).toContain('O2 [outcome] (parent G)');
    expect(forOutcome).toContain('O2.1 [output] (parent O2) Hygiene kits distributed');
    expect(forOutcome).toContain('siblings (not suggested for in this request): O1');
    expect(forOutcome).not.toContain('O1.1');
    expect(forOutcome).not.toContain('sufficient safe water');
  });

  it('RESULTS CHAIN cuts long statements to 300 characters and falls back to the Arabic text', () => {
    const long = { ...result('n-o1'), text: 'Households access safe water '.repeat(30) };
    const arabicOnly = { ...result('n-o1.1'), text: '', textAr: 'توصيل المياه الآمنة بالصهاريج' };
    const ctx = context({ resultsChain: [result('n-g'), long, arabicOnly] });
    const section = promptSection(buildKpiUserMessage(input(ctx, [arabicOnly])), 'RESULTS CHAIN');
    const outcomeLine = section.split('\n').find(l => l.startsWith('O1 '))!;
    expect(outcomeLine.length).toBeLessThanOrEqual('O1 [outcome] (parent G) '.length + 300);
    expect(section).toContain('O1.1 [output] (parent O1) توصيل المياه الآمنة بالصهاريج');
  });

  it('SUGGEST FOR gives each result its range, existing indicators and candidates best first', () => {
    const ctx = context({
      existingIndicators: [
        { id: 'i-1', resultId: 'n-o1', name: '% of households treating drinking water', nameAr: null, level: 'outcome', unit: 'percent', libraryId: 'WA-03', method: 'hh_survey' },
        { id: 'i-2', resultId: 'n-o1', name: 'Number of water committees active', nameAr: null, level: 'outcome', unit: 'number', libraryId: null, method: 'document_review' },
      ],
    });
    const message = buildKpiUserMessage(input(ctx, [result('n-g'), result('n-o1'), result('n-o1.1')], {
      'n-g': ['HE-01'], 'n-o1': ['WA-01', 'WA-02'], 'n-o1.1': ['WA-06', 'WA-04'],
    }));
    const lines = promptSection(message, 'SUGGEST FOR').split('\n').slice(1);
    expect(lines).toEqual([
      'G [impact]: suggest 1–2 · existing indicators: none · candidates: HE-01',
      'O1 [outcome]: suggest 2 · existing indicators: "% of households treating drinking water" (percent, WA-03); "Number of water committees active" (number, custom) · candidates: WA-01, WA-02',
      'O1.1 [output]: suggest 2–3 · existing indicators: none · candidates: WA-06, WA-04',
    ]);
    expect(suggestForLines(message).map(l => [l.code, l.range, l.candidates])).toEqual([
      ['G', '1–2', ['HE-01']], ['O1', '2', ['WA-01', 'WA-02']], ['O1.1', '2–3', ['WA-06', 'WA-04']],
    ]);
  });

  it('SUGGEST FOR asks the first scoped outcome of a humanitarian framework for one accountability indicator (rule 19, D11)', () => {
    const accountability = ['AC-01', 'AC-02', 'AC-03', 'AC-04', 'AC-05'].map(libraryEntry);
    const humanitarian = (overrides: Partial<ProjectContext> = {}) => {
      const base = context(overrides);
      return { ...base, project: { ...base.project, humanitarian: true } };
    };
    const ask = 'include one accountability to affected people indicator (one of AC-01, AC-03, AC-04, AC-05)';

    const framework = buildKpiUserMessage(input(humanitarian(), [result('n-o1'), result('n-o1.1'), result('n-o2')], {}, accountability));
    const lines = promptSection(framework, 'SUGGEST FOR').split('\n');
    expect(lines.find(l => l.startsWith('O1 '))).toContain(ask);
    expect(lines.find(l => l.startsWith('O2 '))).not.toContain(ask);
    expect(lines.find(l => l.startsWith('O1.1 '))).not.toContain(ask);

    // A later batch without the first outcome never asks.
    expect(buildKpiUserMessage(input(humanitarian(), [result('n-o2'), result('n-o2.1')], {}, accountability))).not.toContain(ask);
    // Result scope: only on an outcome.
    expect(buildKpiUserMessage(input(humanitarian({ scope: { type: 'result', resultId: 'n-o2' } }), [result('n-o2')], {}, accountability))).toContain(ask);
    expect(buildKpiUserMessage(input(humanitarian({ scope: { type: 'result', resultId: 'n-o1.1' } }), [result('n-o1.1')], {}, accountability))).not.toContain(ask);
    // Not when the framework already has one, not for a development project.
    const covered = humanitarian({ existingIndicators: [{ id: 'i-ac', resultId: 'n-o2', name: 'x', nameAr: null, level: 'outcome', unit: 'percent', libraryId: 'AC-01', method: 'hh_survey' }] });
    expect(buildKpiUserMessage(input(covered, [result('n-o1')], {}, accountability))).not.toContain(ask);
    expect(buildKpiUserMessage(input(context(), [result('n-o1')], {}, accountability))).not.toContain(ask);
  });

  it('DOCUMENT FACTS label each excerpt with its kind ([context] for none); without facts no document value may be used', () => {
    const ctx = context({
      documentFacts: [
        { documentId: 'd-1', fileName: 'proposal.pdf', excerpt: 'The action will rehabilitate 18 community water points.', kind: 'target' },
        { documentId: 'd-2', fileName: 'baseline.pdf', excerpt: 'The 2025 baseline survey found 45% of households treat water; the target is 75% by 2027.', kind: 'mixed' },
        { documentId: 'd-1', fileName: 'proposal.pdf', excerpt: 'The governorate has 12 municipalities.', kind: null },
        { documentId: 'd-3', fileName: 'assessment.pdf', excerpt: 'Households currently receive 6 litres per person per day.', kind: 'baseline' },
      ],
    });
    const section = promptSection(buildKpiUserMessage(input(ctx, [result('n-o1')])), 'DOCUMENT FACTS');
    expect(section.split('\n').slice(1)).toEqual([
      '[F1 target] proposal.pdf: "The action will rehabilitate 18 community water points."',
      '[F2 mixed] baseline.pdf: "The 2025 baseline survey found 45% of households treat water; the target is 75% by 2027."',
      '[F3 context] proposal.pdf: "The governorate has 12 municipalities."',
      '[F4 baseline] assessment.pdf: "Households currently receive 6 litres per person per day."',
    ]);
    expect(section.split('\n')[0]).toContain('[context] lines are never a baseline or a target');
    const none = promptSection(buildKpiUserMessage(input(context(), [result('n-o1')])), 'DOCUMENT FACTS');
    expect(none).toContain('every baselineBasis is "none" and no targetBasis is "document"');
  });

  it('CANDIDATES has one line per candidate of the call (≤ 40 are passed in)', () => {
    const ids = ['WA-01', 'WA-02', 'WA-03', 'WA-04', 'AC-01'];
    const message = buildKpiUserMessage(input(context(), [result('n-o1')], { 'n-o1': ids.slice(0, 4) }, [libraryEntry('AC-01')]));
    const lines = promptSection(message, 'CANDIDATES').split('\n').slice(1);
    expect(lines.map(l => l.split(' ')[0])).toEqual(ids);
    expect(lines[0]).toBe(kpiCandidateLine(libraryEntry('WA-01')));
    const empty = buildKpiUserMessage(input(context(), [result('n-o1')]));
    expect(promptSection(empty, 'CANDIDATES')).toContain('none: write custom indicators');
  });

  it('SCOPE says framework or result', () => {
    expect(promptSection(buildKpiUserMessage(input(context(), [result('n-o1'), result('n-o1.1')])), 'SCOPE'))
      .toBe('SCOPE\nframework: suggest indicators for each result under SUGGEST FOR (O1, O1.1).');
    const resultScope = context({ scope: { type: 'result', resultId: 'n-o2' } });
    expect(promptSection(buildKpiUserMessage(input(resultScope, [result('n-o2')])), 'SCOPE')).toBe('SCOPE\nresult: suggest indicators for O2 only.');
  });

  it('SCOPE for alternatives describes the source, its problems and the library id not to reuse; SUGGEST FOR lists pending cards', () => {
    const weak = context({
      scope: { type: 'alternatives', indicatorId: 'i-1', suggestionId: null },
      existingIndicators: [{ id: 'i-1', resultId: 'n-o1', name: 'Increase safe water access to 80%', nameAr: null, level: 'outcome', unit: 'percent', libraryId: 'WA-02', method: 'hh_survey' }],
      pendingSuggestions: [{ id: 's-1', resultId: 'n-o1', libraryId: 'WA-03', name: '% of households treating drinking water' }],
      alternativesFor: {
        kind: 'indicator', id: 'i-1', resultId: 'n-o1', name: 'Increase safe water access to 80%', nameAr: null,
        definition: 'Households with safe water.', unit: 'percent', method: 'hh_survey', libraryId: 'WA-02', reason: 'weak',
        rejectReason: null, problems: ['Move the target out of the name.', 'A percentage needs a numerator and a denominator.'],
      },
    });
    const message = buildKpiUserMessage(input(weak, [result('n-o1')], { 'n-o1': ['WA-01'] }));
    expect(promptSection(message, 'SCOPE').split('\n').slice(1)).toEqual([
      'alternatives for one existing indicator of O1.',
      'source indicator: "Increase safe water access to 80%" (unit: percent, method: hh_survey, library id: WA-02)',
      'source definition: "Households with safe water."',
      'reason: weak: Move the target out of the name.; A percentage needs a numerator and a denominator.',
      'Suggest 2–3 alternatives for the same result (O1) that measure the same change and fix these problems; do not repeat the source indicator and do not reuse library id WA-02.',
    ]);
    const suggestFor = promptSection(message, 'SUGGEST FOR');
    expect(suggestFor).toContain('O1 [outcome]: suggest 2–3 alternatives');
    expect(suggestFor).toContain('already suggested (do not repeat): "% of households treating drinking water"');

    const rejected = context({
      scope: { type: 'alternatives', indicatorId: null, suggestionId: 's-9' },
      alternativesFor: {
        kind: 'suggestion', id: 's-9', resultId: 'n-o1', name: 'Number of jerrycans distributed', nameAr: 'عدد الجالونات الموزعة',
        definition: null, unit: 'number', method: 'document_review', libraryId: null, reason: 'rejected', rejectReason: 'too_costly_to_measure', problems: [],
      },
    });
    const scope = promptSection(buildKpiUserMessage(input(rejected, [result('n-o1')])), 'SCOPE');
    expect(scope).toContain('alternatives for one suggested indicator of O1.');
    expect(scope).toContain('library id: none (custom)');
    expect(scope).toContain('source Arabic name: "عدد الجالونات الموزعة"');
    expect(scope).toContain('reason: rejected: too costly to measure');
    expect(scope).not.toContain('do not reuse library id');
  });

  it('never carries personal data: every free text is redacted again, and document texts are never sent', () => {
    const phone = '0599123456';
    const idNumber = '401234567';
    const email = 'coordinator@example.org';
    const pii = ` call ${phone}, ID ${idNumber}, ${email}`;
    const ctx = context({
      project: { ...context().project, name: `Water project${pii}`, donor: `Donor${pii}`, description: `Description${pii}`, geographicScope: `Area${pii}` },
      resultsChain: RESULTS.map(r => ({ ...r, code: r.id === 'n-o1' ? `O1${pii}` : r.code, text: `${r.text}${pii}`, textAr: r.textAr ? `${r.textAr}${pii}` : null })),
      existingIndicators: [{ id: 'i-1', resultId: 'n-o1', name: `Existing${pii}`, nameAr: null, level: 'outcome', unit: 'number', libraryId: null, method: 'document_review' }],
      pendingSuggestions: [{ id: 's-1', resultId: 'n-o1', libraryId: null, name: `Pending${pii}` }],
      documentFacts: [{ documentId: 'd-1', fileName: `list ${phone}.pdf`, excerpt: `The target is 900 youth trained${pii}.`, kind: 'target' }],
      documentTexts: [{ documentId: 'd-1', fileName: 'list.pdf', text: 'FULL-DOCUMENT-TEXT-MARKER The target is 900 youth trained.' }],
      scope: { type: 'alternatives', indicatorId: 'i-1', suggestionId: null },
      alternativesFor: {
        kind: 'indicator', id: 'i-1', resultId: 'n-o1', name: `Existing${pii}`, nameAr: `قائم${pii}`, definition: `Definition${pii}`,
        unit: 'number', method: 'document_review', libraryId: null, reason: 'weak', rejectReason: null, problems: [`Problem${pii}`],
      },
    });
    const message = buildKpiUserMessage(input(ctx, [ctx.resultsChain[1]], { 'n-o1': ['WA-01'] }));
    for (const value of [phone, idNumber, email]) expect(message).not.toContain(value);
    expect(message).toContain('[phone removed]');
    expect(message).toContain('[ID number removed]');
    expect(message).toContain('[email removed]');
    expect(message).not.toContain('FULL-DOCUMENT-TEXT-MARKER');
  });

  it('keeps Arabic text as it is (names of candidates, Arabic statements)', () => {
    const message = buildKpiUserMessage(input(context(), [result('n-o1')], { 'n-o1': ['FS-01'] }));
    expect(message).toContain('ar: نسبة الأسر المستهدفة التي لديها درجة استهلاك غذائي مقبولة');
  });
});
