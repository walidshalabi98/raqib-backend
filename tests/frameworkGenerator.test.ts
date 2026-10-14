import fs from 'fs';
import { CollectionMethod, Frequency, IndicatorDirection } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_ANALYSIS_MARKER,
  BASELINE_DATE_TO_BE_CONFIRMED,
  DEFAULT_TARGET_METHOD,
  DocumentFigure,
  INTERMEDIATE_TARGETS_TO_BE_CONFIRMED,
  LibraryCandidate,
  LibraryEntryReference,
  NormalizeIndicatorsContext,
  REFERENCE_SHEET_FIELDS,
  SourceDocument,
  TO_BE_CONFIRMED,
  appearsInDocuments,
  buildStructureFromMetadata,
  documentTextForAi,
  ensureSexDisaggregation,
  extractIndicatorList,
  findSourceDocument,
  isGenericMeansOfVerification,
  isPeopleLevelIndicator,
  libraryEntryTexts,
  librarySectorsFor,
  linkedLibraryIds,
  normalizeDirection,
  normalizeDisaggregation,
  normalizeFrequency,
  normalizeIndicatorLevel,
  normalizeIndicators,
  normalizeMethod,
  normalizeProjectStructure,
  planResultNodes,
  projectSectors,
  referenceSheetGaps,
  resolveBaselineAndTarget,
  resolveResult,
  selectLibraryCandidates,
  standardReferenceLabel,
  strictIsoDate,
  stripAiAnalysis,
  structureForPrompt,
  matchingFigure,
  verifyDocumentFigures,
  VerifiedFigure,
  withLibrarySexDisaggregation,
} from '../src/services/ai/frameworkNormalize';
import { ECHO_INDICATOR_CAP, donorGuidance } from '../src/services/ai/prompts/donors';
import {
  FRAMEWORK_DIRECTIONS,
  FRAMEWORK_FREQUENCIES,
  FRAMEWORK_METHODS,
  FRAMEWORK_PROMPT_VERSION,
  FRAMEWORK_STRUCTURE_SYSTEM,
  INDICATOR_UNITS,
  PROJECT_STRUCTURE_SCHEMA,
  STRUCTURE_DOCUMENT_MAX_CHARS,
  extractProjectStructurePrompt,
} from '../src/services/ai/prompts/framework';
import * as frameworkPrompts from '../src/services/ai/prompts/framework';
import { KPI_CALLS, KPI_PROMPT_VERSION, KPI_SUGGESTIONS_SCHEMA, KPI_SYSTEM, type KpiRawSuggestion } from '../src/services/ai/prompts/kpi';
import { AiInvalidOutputError, AiOutputTruncatedError, AiRefusalError, AiRequestError } from '../src/services/ai/errors';
import { FrameworkGenerationError, generationFailureMessage } from '../src/services/ai/frameworkGenerator';
import type { GenerateStructuredParams, StructuredResult } from '../src/services/ai/client';
import { prisma } from '../src/config/prisma';
import { parseIndicatorCreate } from '../src/services/indicators/validation';
import { DRAFT_EDITABLE_KEYS } from '../src/services/kpi/draft';
import { DEFAULT_LIBRARY_PATH } from '../src/services/library/load';
import { structuredOutputSchemaProblems } from './aiSchemaHelpers';
import { createKpiRunRow, createKpiSuggestionRow, hasTestDatabase, kpiValidatedSuggestionFixture, resetDatabase } from './helpers';

// tests/setup.ts mocks the generator for every other test file; this file tests the real one
// with the AI client mocked (generateStructured), so no model is ever called.
vi.unmock('../src/services/ai/frameworkGenerator');
// tests/setup.ts answers runKpiPipeline with an empty result for route tests; the generator runs the real pipeline here.
vi.unmock('../src/services/kpi/pipeline');

const { generateStructured } = vi.hoisted(() => ({ generateStructured: vi.fn() }));
vi.mock('../src/services/ai/client', () => ({
  generateStructured,
  resolveModel: (tier: 'main' | 'fast') => (tier === 'main' ? 'configured-main-model' : 'configured-fast-model'),
}));

/** The model that "served" the mocked answers (generateStructured returns the served model, not the configured one). */
const SERVED_MODEL = 'claude-sonnet-5-5-20261001';
const MODEL = SERVED_MODEL;

// ---------------------------------------------------------------- fixtures

const NODES: NormalizeIndicatorsContext['resultNodes'] = [
  { id: 'n-g', code: 'G', level: 'impact', parentId: null },
  { id: 'n-o1', code: 'O1', level: 'outcome', parentId: 'n-g' },
  { id: 'n-o2', code: 'O2', level: 'outcome', parentId: 'n-g' },
  { id: 'n-o11', code: 'O1.1', level: 'output', parentId: 'n-o1' },
  { id: 'n-o21', code: 'O2.1', level: 'output', parentId: 'n-o2' },
  { id: 'n-a111', code: 'A1.1.1', level: 'activity', parentId: 'n-o11' },
];

const DOCS = [
  'The baseline survey (January 2026) found a youth employment rate of 22% in the three governorates. '
  + 'The project will train 800 young women and men; 60% of graduates are expected to be employed within six months. '
  + 'By the end of 2026, 400 of them will have completed the course. '
  + 'Budget line 1.5 covers 1,200 training kits.',
];

const SOURCES: SourceDocument[] = [{ fileName: 'proposal.pdf', text: DOCS[0] }];

/** What the structure step extracts from DOCS (PROJECT_STRUCTURE_SCHEMA documentFigures). */
const DOC_FIGURES: DocumentFigure[] = [
  { resultCode: 'G', kind: 'baseline', value: '22%', description: 'youth employment rate', quote: 'found a youth employment rate of 22% in the three governorates' },
  { resultCode: 'O1', kind: 'target', value: '60%', description: 'graduates employed', quote: '60% of graduates are expected to be employed within six months' },
  { resultCode: 'O1.1', kind: 'target', value: '800', description: 'young people trained', quote: 'The project will train 800 young women and men' },
  { resultCode: 'O1.1', kind: 'target', value: '400', description: 'trained by the end of 2026', quote: 'By the end of 2026, 400 of them will have completed the course.' },
];

/** DOC_FIGURES as verifyDocumentFigures returns them for SOURCES: the only evidence for document values. */
const FIGURES: VerifiedFigure[] = verifyDocumentFigures(DOC_FIGURES, SOURCES);

/** The end of a target justification without intermediate targets. */
const NO_INTERMEDIATE = ` ${INTERMEDIATE_TARGETS_TO_BE_CONFIRMED}`;

/** What documentParser.ts appends to Document.parsedText: model output, never evidence. */
const AI_ANALYSIS = `\n\n${AI_ANALYSIS_MARKER}\n{"targets_mentioned":[{"indicator":"employment","target":"95%"}],"baseline":"41%","summary":"Kits: 2,500"}`;

/** The seed library (knowledge/indicator-library.json). */
const LIBRARY_FILE = JSON.parse(fs.readFileSync(DEFAULT_LIBRARY_PATH, 'utf8')) as {
  indicators: Array<LibraryEntryReference & { name: string; nameAr: string; unit: string }>;
};
const seedEntry = (id: string) => {
  const entry = LIBRARY_FILE.indicators.find(e => e.id === id);
  if (!entry) throw new Error(`${id} is not in the seed library`);
  return entry;
};

function libEntry(id: string, overrides: Partial<LibraryEntryReference> = {}): LibraryEntryReference {
  return {
    id, definition: `Definition of ${id}`, notes: null, meansOfVerification: 'Registers', calculation: null,
    disaggregation: [], standardReference: null, ...overrides,
  };
}

const LIBRARY = new Map<string, LibraryEntryReference>([
  ['LV-01', libEntry('LV-01', { disaggregation: ['sex', 'age'] })],
  ['LV-02', libEntry('LV-02', { standardReference: { framework: 'EU GERF', code: '2.14' }, disaggregation: ['sex'] })],
  ['AC-01', libEntry('AC-01', { standardReference: { framework: 'Core Humanitarian Standard (2024)', code: 'Commitment 5 (aligned)' } })],
  ['FS-01', seedEntry('FS-01')],
  ['WA-01', seedEntry('WA-01')],
]);

function ctx(overrides: Partial<NormalizeIndicatorsContext> = {}): NormalizeIndicatorsContext {
  return {
    frameworkId: 'fw-1',
    resultNodes: NODES,
    knownLibraryIds: new Set(['LV-01', 'LV-02', 'AC-01', 'FS-01', 'WA-01', 'ED-04', 'ED-05', 'GV-03']),
    libraryEntries: LIBRARY,
    verifiedFigures: FIGURES,
    aiModel: MODEL,
    promptVersion: FRAMEWORK_PROMPT_VERSION,
    ...overrides,
  };
}

function aiIndicator(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resultCode: 'O1',
    level: 'outcome',
    indicatorText: '% of trainees employed or self-employed six months after completing training',
    indicatorTextAr: 'نسبة المتدربين العاملين أو العاملين لحسابهم الخاص بعد ستة أشهر من إتمام التدريب',
    libraryId: 'LV-01',
    standardReferenceCode: '',
    definition: 'Trainees who report paid work or self-employment at the six-month tracer survey.',
    unit: 'percent',
    calculation: {
      numerator: 'Trainees employed at six months', denominator: 'Trainees reached by the tracer survey', formula: 'numerator ÷ denominator × 100',
      rounding: '1 decimal place',
    },
    direction: 'increase',
    disaggregation: ['sex', 'age', 'disability'],
    dataCollectionMethod: 'hh_survey',
    frequency: 'biannual',
    meansOfVerification: 'Phone tracer survey of all graduates six months after completion',
    baselineValue: '',
    baselineBasis: 'none',
    baselineDate: '2026-12-15',
    baselineMethod: 'Not applicable for a new cohort; first measured at the six-month tracer survey',
    targetValue: '60%',
    targetBasis: 'document',
    targetJustification: 'Target stated in the proposal.',
    intermediateTargets: [],
    assumptions: 'Labour market conditions do not deteriorate sharply.',
    responsibility: 'M&E Officer',
    phases: ['midterm', 'endline'],
    startDate: '2026-07-01',
    endDate: '2027-12-31',
    milestones: [{ label: 'First tracer survey', date: '2026-12-15', completed: true }],
    aiRationale: 'Measures the employment outcome of the training.',
    ...overrides,
  };
}

// ---------------------------------------------------------------- enums

describe('frameworkNormalize: enum fallbacks', () => {
  it('maps indicator levels; activity and unknown values become output', () => {
    expect(normalizeIndicatorLevel('Outcome')).toBe('outcome');
    expect(normalizeIndicatorLevel(' IMPACT ')).toBe('impact');
    expect(normalizeIndicatorLevel('goal')).toBe('impact');
    expect(normalizeIndicatorLevel('activity')).toBe('output');
    expect(normalizeIndicatorLevel('process')).toBe('output');
    expect(normalizeIndicatorLevel(undefined)).toBe('output');
  });

  it('matches methods and frequencies case-insensitively with synonyms, else the level default', () => {
    expect(normalizeMethod('FGD', 'outcome')).toBe('fgd');
    expect(normalizeMethod('Household survey', 'outcome')).toBe('hh_survey');
    expect(normalizeMethod('records review', 'output')).toBe('document_review');
    expect(normalizeMethod('telepathy', 'output')).toBe('document_review');
    expect(normalizeMethod(undefined, 'outcome')).toBe('hh_survey');
    expect(normalizeMethod('', 'impact')).toBe('secondary_data');

    expect(normalizeFrequency('Quarterly', 'output')).toBe('quarterly');
    expect(normalizeFrequency('semi-annual', 'output')).toBe('biannual');
    expect(normalizeFrequency('yearly', 'output')).toBe('annual');
    expect(normalizeFrequency('sometimes', 'output')).toBe('quarterly');
    expect(normalizeFrequency(null, 'outcome')).toBe('biannual');
    expect(normalizeFrequency(null, 'impact')).toBe('annual');
  });

  it('matches directions, else null', () => {
    expect(normalizeDirection('Increase')).toBe('increase');
    expect(normalizeDirection('reduction')).toBe('decrease');
    expect(normalizeDirection('maintain')).toBe('maintain');
    expect(normalizeDirection('sideways')).toBeNull();
    expect(normalizeDirection(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------- structure

describe('frameworkNormalize: project structure', () => {
  it('keeps the coded results chain and Arabic text', () => {
    const s = normalizeProjectStructure({
      goal: { code: 'G', text: 'Improved food security', textAr: 'تحسين الأمن الغذائي' },
      outcomes: [{
        code: 'O1', text: 'Households consume adequate diets', textAr: 'استهلاك الأسر نظامًا غذائيًا كافيًا',
        outputs: [{ code: 'O1.1', text: 'Cash transfers delivered', activities: ['Register households', 'Distribute cash'] }],
      }],
      beneficiaries: { total: 2000 },
      donorRequirements: ['KRIs'],
      crossCuttingThemes: ['gender'],
    });
    expect(s).not.toBeNull();
    expect(s!.goal).toEqual({ code: 'G', text: 'Improved food security', textAr: 'تحسين الأمن الغذائي' });
    expect(s!.outcomes[0].code).toBe('O1');
    expect(s!.outcomes[0].textAr).toBe('استهلاك الأسر نظامًا غذائيًا كافيًا');
    expect(s!.outcomes[0].outputs[0].activities.map(a => a.code)).toEqual(['A1.1.1', 'A1.1.2']);
    expect(s!.beneficiaries).toEqual({ total: 2000 });
    expect(s!.donorRequirements).toEqual(['KRIs']);
  });

  it('assigns codes to the older uncoded format and resolves duplicate codes', () => {
    const s = normalizeProjectStructure({
      goal: 'Improved livelihoods',
      outcomes: [
        { text: 'Outcome A', outputs: [{ text: 'Output A1', activities: ['x'] }, 'Output A2'] },
        { code: 'o1', text: 'Outcome B (duplicate code)', outputs: [] },
        { text: '   ' },
      ],
    });
    expect(s!.goal).toEqual({ code: 'G', text: 'Improved livelihoods' });
    expect(s!.outcomes.map(o => o.code)).toEqual(['O1', 'O2']);
    expect(s!.outcomes[0].outputs.map(o => o.code)).toEqual(['O1.1', 'O1.2']);
    expect(s!.outcomes[0].outputs[0].activities).toEqual([{ code: 'A1.1.1', text: 'x' }]);
  });

  it('returns null without a goal or outcomes, and uses a placeholder goal when only outcomes exist', () => {
    expect(normalizeProjectStructure(null)).toBeNull();
    expect(normalizeProjectStructure([])).toBeNull();
    expect(normalizeProjectStructure({ outcomes: [] })).toBeNull();
    const s = normalizeProjectStructure({ outcomes: ['Only an outcome'] });
    expect(s!.goal.code).toBe('G');
    expect(s!.goal.text).toMatch(/to be confirmed/i);
  });

  it('keeps only document figures whose quote is found in the documents and contains the value', () => {
    const s = normalizeProjectStructure({
      goal: 'Goal',
      documentFigures: [
        { resultCode: 'O1', kind: 'target', value: '60%', quote: '60% of graduates' },
        { resultCode: 'O1', kind: 'baseline', value: '35%', quote: 'invented' },
        { kind: 'estimate', value: '800' },
        // The value is in the document, but the quote is not.
        { resultCode: 'O1.1', kind: 'target', value: '800', quote: 'We will train 800 youth' },
        // The quote is in the document, but it does not contain the value.
        { resultCode: 'O1.1', kind: 'target', value: '900', quote: 'The project will train 800 young women and men' },
        // No quote, or a bare number as the quote.
        { resultCode: 'O1.1', kind: 'target', value: '800', quote: '' },
        { resultCode: 'O1.1', kind: 'target', value: '800', quote: '800' },
      ],
    }, { documentTexts: DOCS });
    expect(s!.documentFigures).toEqual([{ resultCode: 'O1', kind: 'target', value: '60%', description: '', quote: '60% of graduates' }]);
  });

  it('plans result nodes parents first, with levels, parents and sibling sort order', () => {
    const s = normalizeProjectStructure({
      goal: 'G text',
      outcomes: [
        { text: 'O1 text', outputs: [{ text: 'O1.1 text', activities: ['a', 'b'] }] },
        { text: 'O2 text', outputs: [{ text: 'O2.1 text' }] },
      ],
    })!;
    expect(planResultNodes(s)).toEqual([
      { code: 'G', level: 'impact', text: 'G text', textAr: null, parentCode: null, sortOrder: 0 },
      { code: 'O1', level: 'outcome', text: 'O1 text', textAr: null, parentCode: 'G', sortOrder: 0 },
      { code: 'O1.1', level: 'output', text: 'O1.1 text', textAr: null, parentCode: 'O1', sortOrder: 0 },
      { code: 'A1.1.1', level: 'activity', text: 'a', textAr: null, parentCode: 'O1.1', sortOrder: 0 },
      { code: 'A1.1.2', level: 'activity', text: 'b', textAr: null, parentCode: 'O1.1', sortOrder: 1 },
      { code: 'O2', level: 'outcome', text: 'O2 text', textAr: null, parentCode: 'G', sortOrder: 1 },
      { code: 'O2.1', level: 'output', text: 'O2.1 text', textAr: null, parentCode: 'O2', sortOrder: 0 },
    ]);
    // The indicator prompt sees activities as text only.
    const forPrompt = structureForPrompt(s) as any;
    expect(forPrompt.outcomes[0].outputs[0].activities).toEqual(['a', 'b']);
  });

  it('builds a coded bilingual structure from project metadata', () => {
    const s = buildStructureFromMetadata({
      sector: 'mhpss', sectors: ['mhpss'], humanitarian: true, donorType: 'echo',
      description: null, geographicScope: 'Gaza', targetBeneficiaries: 900,
      startDate: new Date('2026-01-01'), endDate: '2026-12-31',
    });
    const plan = planResultNodes(s);
    expect(plan.filter(p => p.level !== 'activity').map(p => p.code)).toEqual(['G', 'O1', 'O1.1', 'O1.2', 'O2', 'O2.1']);
    expect(plan.filter(p => p.level === 'activity')).toHaveLength(6);
    expect(s.goal.textAr).toMatch(/[؀-ۿ]/);
    expect(s.outcomes[0].text).toContain('Gaza');
    expect(s.timeline).toMatchObject({ startDate: '2026-01-01', endDate: '2026-12-31' });
    expect(s.crossCuttingThemes).toContain('accountability_to_affected_people');
    expect(s.donorRequirements.join(' ')).toMatch(/Key Result Indicators/);
  });
});

// ---------------------------------------------------------------- library

function candidate(id: string, sector: LibraryCandidate['sector'], isStandard = false): LibraryCandidate {
  return {
    id, sector, isStandard, name: id, definition: 'd', unit: 'number', level: 'output', methods: ['document_review'],
    frequency: 'quarterly', disaggregation: ['sex'], standardReference: null,
  };
}

describe('frameworkNormalize: library candidates', () => {
  it('lists project sectors (primary first), related sectors and other', () => {
    expect(projectSectors({ sector: 'health', sectors: ['protection', 'health'] })).toEqual(['health', 'protection']);
    expect(projectSectors({ sector: 'health', sectors: [] })).toEqual(['health']);
    expect(librarySectorsFor(['mhpss', 'cash'])).toEqual(['mhpss', 'cash', 'protection', 'food_security', 'other']);
  });

  it('puts accountability entries first for humanitarian projects, then primary, secondary, related and other', () => {
    const entries = [
      candidate('EN-01', 'other', true), candidate('AC-02', 'other'), candidate('AC-01', 'other', true),
      candidate('HE-03', 'health'), candidate('PR-02', 'protection', true), candidate('PR-01', 'protection'),
      candidate('ED-01', 'education', true), candidate('FS-01', 'food_security'),
    ];
    const ids = selectLibraryCandidates(entries, { sectors: ['health', 'mhpss'], humanitarian: true }).map(e => e.id);
    expect(ids).toEqual(['AC-01', 'AC-02', 'HE-03', 'PR-02', 'PR-01', 'EN-01']);

    const notHumanitarian = selectLibraryCandidates(entries, { sectors: ['education'], humanitarian: false }).map(e => e.id);
    expect(notHumanitarian).toEqual(['ED-01', 'AC-01', 'EN-01', 'AC-02']);
  });

  it('caps the number of candidates', () => {
    const many = Array.from({ length: 60 }, (_, i) => candidate(`LV-${String(i + 1).padStart(2, '0')}`, 'livelihoods'));
    expect(selectLibraryCandidates(many, { sectors: ['livelihoods'], humanitarian: false })).toHaveLength(40);
    expect(selectLibraryCandidates(many, { sectors: ['livelihoods'], humanitarian: false, limit: 5 }).map(e => e.id))
      .toEqual(['LV-01', 'LV-02', 'LV-03', 'LV-04', 'LV-05']);
  });

  it('labels standard references', () => {
    expect(standardReferenceLabel({ framework: 'EU GERF', code: '2.38', url: 'https://x' })).toBe('EU GERF 2.38');
    expect(standardReferenceLabel(null)).toBeNull();
    expect(standardReferenceLabel({})).toBeNull();
  });
});

// ---------------------------------------------------------------- deterministic checks

describe('frameworkNormalize: document matching', () => {
  it('finds exact values and ignores parts of larger numbers', () => {
    expect(appearsInDocuments('22%', DOCS)).toBe(true);
    expect(appearsInDocuments('22', DOCS)).toBe(true);
    expect(appearsInDocuments('800', DOCS)).toBe(true);
    expect(appearsInDocuments('1,200', DOCS)).toBe(true);
    expect(appearsInDocuments('80', DOCS)).toBe(false); // part of 800
    expect(appearsInDocuments('200', DOCS)).toBe(false); // part of 1,200
    expect(appearsInDocuments('5', DOCS)).toBe(false); // part of 1.5
    expect(appearsInDocuments('35%', DOCS)).toBe(false);
  });

  it('normalises spacing and Arabic-Indic digits, and never matches values without digits', () => {
    expect(appearsInDocuments('60 %', DOCS)).toBe(true);
    expect(appearsInDocuments('٨٠٠', DOCS)).toBe(true);
    expect(appearsInDocuments('45', ['نسبة التشغيل ٤٥٪ في خط الأساس'])).toBe(true);
    expect(appearsInDocuments('yes', ['yes, the baseline exists'])).toBe(false);
    expect(appearsInDocuments('', DOCS)).toBe(false);
    expect(appearsInDocuments('22%', [])).toBe(false);
  });

  it('reads the Arabic thousands separator and percent sign: fragments are not found, whole values are', () => {
    const arabic = ['يستفيد من المشروع ١٢٬٠٠٠ شخص … ٣٨٪ من الأسر لا تملك الصابون'];
    expect(appearsInDocuments('12', arabic)).toBe(false); // part of ١٢٬٠٠٠
    expect(appearsInDocuments('000', arabic)).toBe(false);
    expect(appearsInDocuments('12,000', arabic)).toBe(true);
    expect(appearsInDocuments('١٢٬٠٠٠', arabic)).toBe(true);
    expect(appearsInDocuments('38%', arabic)).toBe(true);
    expect(appearsInDocuments('38 %', arabic)).toBe(true);
    expect(appearsInDocuments('٣٨٪', arabic)).toBe(true);
    expect(appearsInDocuments('38', arabic)).toBe(true);
    // And the other way round: Arabic values in an English document.
    expect(appearsInDocuments('١٬٢٠٠', DOCS)).toBe(true);
    expect(appearsInDocuments('٢٢٪', DOCS)).toBe(true);
    expect(appearsInDocuments('١٬٢', DOCS)).toBe(false);
    // The Arabic decimal separator joins digits too.
    expect(appearsInDocuments('5', ['المعدل ٢٫٥ لتر'])).toBe(false);
    expect(appearsInDocuments('2.5', ['المعدل ٢٫٥ لتر'])).toBe(true);
  });

  it('ignores the AI analysis the document parser appended after its marker, cutting at the last marker', () => {
    const parsed = DOCS[0] + AI_ANALYSIS;
    expect(stripAiAnalysis(parsed)).toBe(DOCS[0]);
    expect(stripAiAnalysis(DOCS[0])).toBe(DOCS[0]);
    expect(stripAiAnalysis(`${AI_ANALYSIS_MARKER}\n{"summary":"only the analysis"}`)).toBe('');
    // The parser appended one marker at the end: a marker quoted earlier is part of the document's own text.
    const quoting = `Guidelines quoting ${AI_ANALYSIS_MARKER} in the text, with 41% of households.`;
    expect(stripAiAnalysis(`${quoting}${AI_ANALYSIS}`)).toBe(quoting);
    expect(appearsInDocuments('41%', [`${quoting}${AI_ANALYSIS}`])).toBe(true);
    expect(appearsInDocuments('95%', [parsed])).toBe(false);
    expect(appearsInDocuments('2,500', [parsed])).toBe(false);
    expect(appearsInDocuments('22%', [parsed])).toBe(true);
  });

  it('finds the first document containing a value, for the citation', () => {
    const docs: SourceDocument[] = [
      { fileName: 'proposal.pdf', text: DOCS[0] },
      { fileName: 'baseline-report.docx', text: 'The baseline survey found 41% of households food insecure; 800 households were sampled.' },
    ];
    expect(findSourceDocument('41%', docs)?.fileName).toBe('baseline-report.docx');
    expect(findSourceDocument('800', docs)?.fileName).toBe('proposal.pdf');
    expect(findSourceDocument('80', docs)).toBeNull();
    expect(findSourceDocument('95%', [{ fileName: 'proposal.pdf', text: DOCS[0] + AI_ANALYSIS }])).toBeNull();
  });
});

describe('frameworkNormalize: verified document figures', () => {
  const figure = (value: string, quote: string, kind: DocumentFigure['kind'] = 'target'): DocumentFigure => ({ resultCode: 'O1', kind, value, description: '', quote });
  const verified = (figures: DocumentFigure[], documents: SourceDocument[] = SOURCES) => verifyDocumentFigures(figures, documents).map(f => f.value);

  it('keeps the figures whose quote is in a document, with that document as the source', () => {
    expect(FIGURES.map(f => [f.value, f.kind, f.source])).toEqual([
      ['22%', 'baseline', 'proposal.pdf'], ['60%', 'target', 'proposal.pdf'], ['800', 'target', 'proposal.pdf'], ['400', 'target', 'proposal.pdf'],
    ]);
    const docs: SourceDocument[] = [{ fileName: 'annex.pdf', text: 'Unrelated annex.' }, ...SOURCES, { fileName: 'baseline.docx', text: 'The survey found 41% of households food insecure.' }];
    expect(verifyDocumentFigures([figure('41%', 'The survey found 41% of households food insecure', 'baseline')], docs)[0].source).toBe('baseline.docx');
  });

  it('tolerates case, spacing, quote marks, final punctuation and an ellipsis, but not changed wording', () => {
    expect(verified([
      figure('60%', '“60 %  of GRADUATES are expected to be employed”'),
      figure('800', 'The project will train 800 … within six months.'),
      figure('400', 'the end of 2026, 400 of them'),
    ])).toEqual(['60%', '800', '400']);
    expect(verified([
      figure('60%', '60% of graduates are expected to find work'),
      figure('800', 'The project will train 800 … within nine months'),
    ])).toEqual([]);
  });

  it('rejects a value that is part of a larger number, a date or a range in the document', () => {
    const docs: SourceDocument[] = [{
      fileName: 'plan.pdf',
      text: 'Distributions start on 15 March 2026 and end on March 30, 2026. Reports are due on 15/06/2026. '
        + 'Between 10-20 sessions per site. In total 12,000 people and 2.5 litres; a target of 15 schools.',
    }];
    expect(verified([
      figure('15', 'Distributions start on 15 March 2026'),
      figure('30', 'and end on March 30, 2026'),
      figure('15', 'Reports are due on 15/06/2026'),
      figure('20', 'Between 10-20 sessions per site'),
      figure('12', 'In total 12,000 people'),
      figure('5', 'and 2.5 litres'),
    ], docs)).toEqual([]);
    expect(verified([figure('15', 'a target of 15 schools'), figure('12,000', 'In total 12,000 people')], docs)).toEqual(['15', '12,000']);
  });

  it('verifies Arabic quotes and figures written with Arabic digits and separators', () => {
    const docs: SourceDocument[] = [{ fileName: 'مقترح.pdf', text: 'يستفيد من المشروع ١٢٬٠٠٠ شخص. وأظهر التقييم أن ٣٨٪ من الأسر لا تملك الصابون في ١٥ آذار ٢٠٢٦.' }];
    expect(verified([
      figure('12,000', 'يستفيد من المشروع ١٢٬٠٠٠ شخص'),
      figure('٣٨٪', 'أن ٣٨٪ من الأسر لا تملك الصابون', 'baseline'),
      figure('15', 'لا تملك الصابون في ١٥ آذار ٢٠٢٦'),
      figure('12', 'يستفيد من المشروع ١٢٬٠٠٠ شخص'),
    ], docs)).toEqual(['12,000', '٣٨٪']);
  });

  it('never verifies a quote from the AI analysis appended to a document', () => {
    const parsed: SourceDocument[] = [{ fileName: 'proposal.pdf', text: DOCS[0] + AI_ANALYSIS }];
    expect(verified([
      figure('95%', '{"indicator":"employment","target":"95%"}'),
      figure('41%', '"baseline":"41%","summary":"Kits: 2,500"', 'baseline'),
    ], parsed)).toEqual([]);
    expect(verified([figure('60%', '60% of graduates are expected')], parsed)).toEqual(['60%']);
  });

  it('matches a value to a verified figure of the same kind only', () => {
    expect(matchingFigure('60 %', 'target', FIGURES)?.value).toBe('60%');
    expect(matchingFigure('٨٠٠', 'target', FIGURES)?.value).toBe('800');
    expect(matchingFigure('60%', 'baseline', FIGURES)).toBeNull();
    expect(matchingFigure('22%', 'target', FIGURES)).toBeNull();
    expect(matchingFigure('22', 'baseline', FIGURES)).toBeNull();
    expect(matchingFigure('', 'target', FIGURES)).toBeNull();
  });
});

describe('frameworkNormalize: people-level disaggregation', () => {
  it('recognises people-level indicators in English and Arabic', () => {
    expect(isPeopleLevelIndicator('Number of households receiving cash')).toBe(true);
    expect(isPeopleLevelIndicator('% of Students achieving minimum proficiency')).toBe(true);
    expect(isPeopleLevelIndicator('Number of water points rehabilitated')).toBe(false);
    expect(isPeopleLevelIndicator('Number of water points', 'عدد المستفيدين من نقاط المياه')).toBe(true);
    expect(isPeopleLevelIndicator('Volume', 'نسبة الأسر التي لديها مياه')).toBe(true);
    expect(isPeopleLevelIndicator('Volume', 'نسبة النساء المشاركات')).toBe(true);
    expect(isPeopleLevelIndicator('Volume', 'للأطفال')).toBe(true);
    expect(isPeopleLevelIndicator('Megawatts installed', 'قدرة الطاقة المتجددة المركبة')).toBe(false);
  });

  it('decides by the counted noun, not by a people word used as a modifier (AI-5 side effect)', () => {
    for (const name of ['Number of water points serving displaced communities', 'Number of family tents distributed',
      'Number of IDP sites with functioning latrines', 'Number of mother-and-baby spaces established', 'Number of youth-led initiatives funded',
      "Number of teachers' guides distributed"]) {
      expect(isPeopleLevelIndicator(name), name).toBe(false);
    }
    expect(isPeopleLevelIndicator('Number of family tents distributed', 'عدد الخيام العائلية الموزعة')).toBe(false);
    expect(isPeopleLevelIndicator('Number of IDP sites with functioning latrines', 'عدد مواقع النازحين المزودة بمراحيض')).toBe(false);
    for (const name of ['Number of displaced families receiving hygiene kits', 'Number of newly enrolled children', 'Number of children fully immunised',
      'Number of heads of household trained', 'Number of boys and girls enrolled', 'Number of trained teachers',
      'Average number of meals per day among children under five', 'Number of persons with disabilities accessing services',
      'Number of young people trained']) {
      expect(isPeopleLevelIndicator(name), name).toBe(true);
    }
  });

  it('recognises the wider list of people nouns in English and Arabic', () => {
    for (const name of [
      'Number of teachers trained', 'Number of health staff trained', 'Number of committee members trained', '% of residents satisfied',
      '% of citizens who trust the council', 'Number of patients treated', 'Number of caregivers reached', '% of parents engaged',
      'Number of entrepreneurs supported', 'Number of business owners supported', '% of learners passing', 'Number of pupils enrolled',
      'Number of local officials trained', 'Number of survivors assisted', 'Number of workers employed', 'Number of employees retained',
      'Number of trainees certified', '% of graduates employed', 'Number of refugees assisted', 'Number of people reached',
    ]) expect(isPeopleLevelIndicator(name), name).toBe(true);
    expect(isPeopleLevelIndicator('Number of official documents issued')).toBe(false);
    expect(isPeopleLevelIndicator('Membership fee collected')).toBe(false);

    for (const nameAr of [
      'عدد المعلمين المدربين', 'عدد المعلمات', 'عدد الموظفين', 'عدد أعضاء اللجان', 'نسبة السكان الراضين', 'نسبة المواطنين',
      'نسبة المرضى الراضين', 'عدد مقدمي الرعاية', 'نسبة الأهالي المشاركين في المجالس', 'عدد رواد الأعمال', 'عدد مالكي المنشآت',
      'نسبة المتعلمين', 'عدد التلاميذ', 'عدد المسؤولين المدربين', 'عدد الناجين', 'عدد العمال', 'عدد المتدربين', 'عدد الخريجين',
      'عدد اللاجئين', 'عدد الأشخاص',
    ]) expect(isPeopleLevelIndicator('Volume', nameAr), nameAr).toBe(true);
  });

  it('gives the library entries ED-04, ED-05 and GV-03 sex disaggregation', () => {
    for (const id of ['ED-04', 'ED-05', 'GV-03']) {
      const entry = seedEntry(id);
      expect(entry.disaggregation).toContain('sex');
      expect(isPeopleLevelIndicator(entry.name), entry.name).toBe(true);
      expect(isPeopleLevelIndicator('Volume', entry.nameAr), entry.nameAr).toBe(true);

      // By the people noun alone (no library link) …
      const [unlinked] = normalizeIndicators([aiIndicator({ indicatorText: entry.name, indicatorTextAr: '', libraryId: null, disaggregation: ['location'] })], ctx());
      expect(unlinked.disaggregation, entry.name).toEqual(['sex', 'location']);

      // … and by the linked library entry, whatever the wording.
      const [linked] = normalizeIndicators([aiIndicator({ indicatorText: 'Coverage rate', indicatorTextAr: '', libraryId: id, disaggregation: [] })],
        ctx({ libraryEntries: new Map([[id, entry]]) }));
      expect(linked.disaggregation, id).toEqual(['sex']);
    }
  });

  it('keeps the sex keys of the linked library entry', () => {
    expect(withLibrarySexDisaggregation(['location'], ['sex_of_household_head', 'location'])).toEqual(['sex_of_household_head', 'location']);
    expect(withLibrarySexDisaggregation(['age'], ['sex', 'age'])).toEqual(['sex', 'age']);
    expect(withLibrarySexDisaggregation(['sex'], ['sex'])).toEqual(['sex']);
    expect(withLibrarySexDisaggregation(['location'], ['location'])).toEqual(['location']);
    expect(withLibrarySexDisaggregation(['location'], undefined)).toEqual(['location']);

    // A household indicator linked to FS-01 gets sex_of_household_head, not sex.
    const [fcs] = normalizeIndicators([aiIndicator({
      indicatorText: '% of households with an acceptable Food Consumption Score', indicatorTextAr: '', libraryId: 'FS-01', disaggregation: ['location'],
    })], ctx());
    expect(fcs.disaggregation).toEqual(['sex_of_household_head', 'location']);
  });

  it('normalises keys and synonyms, dropping invalid and duplicate keys', () => {
    expect(normalizeDisaggregation(['Gender', 'Age group', 'PwD', 'displacement status', 'sex', '123', ''])).toEqual(
      ['sex', 'age', 'disability', 'displacement_status'],
    );
    expect(normalizeDisaggregation('location; Sex')).toEqual(['location', 'sex']);
    expect(normalizeDisaggregation(undefined)).toEqual([]);
  });

  it('adds sex to people-level indicators lacking sex or sex_of_household_head', () => {
    expect(ensureSexDisaggregation(['age'], true)).toEqual(['sex', 'age']);
    expect(ensureSexDisaggregation([], true)).toEqual(['sex']);
    expect(ensureSexDisaggregation(['sex_of_household_head'], true)).toEqual(['sex_of_household_head']);
    expect(ensureSexDisaggregation(['location', 'sex'], true)).toEqual(['location', 'sex']);
    expect(ensureSexDisaggregation(['location'], false)).toEqual(['location']);
  });

  it('rejects generic means of verification', () => {
    expect(isGenericMeansOfVerification('Project reports')).toBe(true);
    expect(isGenericMeansOfVerification('progress reports.')).toBe(true);
    expect(isGenericMeansOfVerification('Training attendance sheets and certificates register')).toBe(false);
  });
});

describe('frameworkNormalize: baselines and targets (never invented)', () => {
  const base = {
    baselineValue: '', baselineBasis: 'none', baselineDate: '2026-01-15', targetValue: '', targetBasis: 'none', targetJustification: '',
    standardReferenceCode: null,
  };
  const PENDING = `${TO_BE_CONFIRMED}. ${BASELINE_DATE_TO_BE_CONFIRMED}`;

  it('keeps document values that equal a verified figure of the same kind and cites its document', () => {
    const r = resolveBaselineAndTarget({ ...base, baselineValue: '22%', baselineBasis: 'document', targetValue: '60%', targetBasis: 'document' }, FIGURES);
    expect(r.baselineValue).toBe('22%');
    expect(r.baselineDate).toEqual(new Date('2026-01-15T00:00:00.000Z'));
    expect(r.baselineMethod).toBe('Baseline taken from the project documents (source: proposal.pdf)');
    expect(r.targetValue).toBe('60%');
    expect(r.targetJustification).toBe(`Target taken from the project documents (source: proposal.pdf).${NO_INTERMEDIATE}`);
    expect(r.intermediateTargets).toEqual([]);

    const report: SourceDocument = { fileName: 'baseline-report.docx', text: 'The baseline survey found 41% food insecure households.' };
    const own = resolveBaselineAndTarget({
      ...base, baselineValue: '41%', baselineBasis: 'document', baselineMethod: 'Baseline survey, March 2026.',
      targetValue: '800', targetBasis: 'document', targetJustification: 'Output target in the proposal budget.',
    }, [...FIGURES, ...verifyDocumentFigures([{ resultCode: 'O1', kind: 'baseline', value: '41%', description: '', quote: report.text }], [report])]);
    expect(own.baselineMethod).toBe('Baseline survey, March 2026 (source: baseline-report.docx)');
    expect(own.targetJustification).toBe(`Output target in the proposal budget (source: proposal.pdf).${NO_INTERMEDIATE}`);
  });

  it('never accepts a value found only in the AI analysis appended to a document', () => {
    const fromAnalysis = verifyDocumentFigures([
      { resultCode: 'O1', kind: 'baseline', value: '41%', description: '', quote: '"baseline":"41%","summary":"Kits: 2,500"' },
      { resultCode: 'O1', kind: 'target', value: '95%', description: '', quote: '{"indicator":"employment","target":"95%"}' },
    ], [{ fileName: 'proposal.pdf', text: DOCS[0] + AI_ANALYSIS }]);
    const r = resolveBaselineAndTarget({ ...base, baselineValue: '41%', baselineBasis: 'document', targetValue: '95%', targetBasis: 'document' }, fromAnalysis);
    expect(r.baselineValue).toBeNull();
    expect(r.baselineMethod).toBe(PENDING);
    expect(r.targetValue).toBeNull();
    expect(r.targetJustification).toMatch(/target proposed by the AI was not found/);
  });

  it('clears document values that are not verified figures and notes it in the justification', () => {
    const r = resolveBaselineAndTarget({
      ...base, baselineValue: '30%', baselineBasis: 'document', targetValue: '75%', targetBasis: 'document',
      targetJustification: 'baseline + 15 percentage points',
    }, FIGURES);
    expect(r.baselineValue).toBeNull();
    // The date the model gave belongs to the removed baseline.
    expect(r.baselineDate).toBeNull();
    expect(r.baselineMethod).toBe(PENDING);
    expect(r.targetValue).toBeNull();
    expect(r.targetJustification).toMatch(/^Proposed method: baseline \+ 15 percentage points — confirm after baseline\./);
    expect(r.targetJustification).toMatch(/target proposed by the AI was not found/);
    expect(r.targetJustification).toMatch(/baseline proposed by the AI was not found.*pending baseline/);
    expect(r.targetJustification.endsWith(NO_INTERMEDIATE)).toBe(true);
    expect(r.targetJustification).not.toContain('75');
  });

  it('rejects a document figure of the other kind: a target is no baseline and a baseline no target', () => {
    const r = resolveBaselineAndTarget({ ...base, baselineValue: '60%', baselineBasis: 'document', targetValue: '22%', targetBasis: 'document' }, FIGURES);
    expect(r).toMatchObject({ baselineValue: null, baselineDate: null, targetValue: null });
    expect(r.targetJustification).toMatch(/not found as a baseline.*not found as a target/);
  });

  it('rejects numbers that appear in a document but are not figures: a date and a budget cell', () => {
    const plan: SourceDocument = {
      fileName: 'plan.pdf',
      text: 'Distributions start on 15 March 2026. Budget: FCS survey household 400 80 32000. Result 1: 2,400 hygiene kits distributed.',
    };
    const figures = verifyDocumentFigures([
      { resultCode: 'O1', kind: 'target', value: '2,400', description: 'kits', quote: 'Result 1: 2,400 hygiene kits distributed.' },
    ], [plan]);
    expect(figures.map(f => f.value)).toEqual(['2,400']);
    // The old substring check would have accepted both: they stand alone in the document.
    expect(appearsInDocuments('15', [plan.text])).toBe(true);
    expect(appearsInDocuments('80', [plan.text])).toBe(true);
    for (const targetValue of ['15', '80']) {
      const r = resolveBaselineAndTarget({ ...base, targetValue, targetBasis: 'document', targetJustification: 'Agreed with the donor.' }, figures);
      expect(r.targetValue, targetValue).toBeNull();
      expect(r.targetJustification, targetValue).not.toContain('plan.pdf');
      expect(r.targetJustification, targetValue).toMatch(/target proposed by the AI was not found/);
    }
    expect(resolveBaselineAndTarget({ ...base, targetValue: '2,400', targetBasis: 'document' }, figures).targetValue).toBe('2,400');
  });

  it('keeps the baseline date (measured or planned) and marks an unknown one "to be confirmed"', () => {
    const measured = resolveBaselineAndTarget({ ...base, baselineValue: '22%', baselineBasis: 'document', baselineDate: '2026-01-31' }, FIGURES);
    expect(measured.baselineDate).toEqual(new Date('2026-01-31T00:00:00.000Z'));
    const planned = resolveBaselineAndTarget({ ...base, baselineMethod: 'Baseline survey planned for March 2026', baselineDate: '2026-03-01' }, FIGURES);
    expect(planned).toMatchObject({ baselineDate: new Date('2026-03-01T00:00:00.000Z'), baselineMethod: 'Baseline survey planned for March 2026' });

    for (const baselineDate of ['', '2026-02-30', '15/03/2026', 'March 2026', '2026-3-1', undefined]) {
      const r = resolveBaselineAndTarget({ ...base, baselineMethod: 'Baseline survey planned for March 2026', baselineDate }, FIGURES);
      expect(r.baselineDate, String(baselineDate)).toBeNull();
      expect(r.baselineMethod, String(baselineDate)).toBe(`Baseline survey planned for March 2026. ${BASELINE_DATE_TO_BE_CONFIRMED}`);
    }
    // The marker is added once, and the method is shortened to keep it within the field limit.
    expect(resolveBaselineAndTarget({ ...base, baselineMethod: `Pending. ${BASELINE_DATE_TO_BE_CONFIRMED}`, baselineDate: '' }, FIGURES).baselineMethod)
      .toBe(`Pending. ${BASELINE_DATE_TO_BE_CONFIRMED}`);
    const long = resolveBaselineAndTarget({ ...base, baselineMethod: 'x'.repeat(3000), baselineDate: '' }, FIGURES).baselineMethod;
    expect(long).toHaveLength(2000);
    expect(long.endsWith(` ${BASELINE_DATE_TO_BE_CONFIRMED}`)).toBe(true);
    expect(strictIsoDate('2026-02-28')).toEqual(new Date('2026-02-28T00:00:00.000Z'));
    expect(strictIsoDate('2026-02-29')).toBeNull();
  });

  it('keeps intermediate targets only for verified target figures with a real date, sorted, one per date', () => {
    const r = resolveBaselineAndTarget({
      ...base, targetValue: '800', targetBasis: 'document', targetJustification: 'Output target of the proposal.',
      intermediateTargets: [
        { date: '2026-12-31', value: '400' },
        { date: '2026-06-30', value: '250' }, // invented
        { date: '2026-12-31', value: '400' }, // repeated date
        { date: 'end of 2026', value: '400' }, // no valid date
        { date: '2026-09-30', value: '22%' }, // a baseline figure
        { date: '', value: '' }, // empty row
      ],
    }, FIGURES);
    expect(r.intermediateTargets).toEqual([{ date: '2026-12-31', value: '400' }]);
    expect(r.targetJustification).toBe('Output target of the proposal (source: proposal.pdf). '
      + 'Intermediate targets proposed by the AI without a target value of the project documents or a valid date were removed. '
      + 'Intermediate targets taken from the project documents (source: proposal.pdf).');

    const none = resolveBaselineAndTarget({ ...base, targetBasis: 'method_only', targetJustification: 'baseline + 5 points', intermediateTargets: [{ date: '2026-06-30', value: '30%' }] }, FIGURES);
    expect(none.intermediateTargets).toEqual([]);
    expect(none.targetJustification).toMatch(/were removed\. Intermediate targets: to be confirmed after the baseline\.$/);
    expect(none.targetJustification).not.toContain('30%');
    expect(resolveBaselineAndTarget({ ...base, intermediateTargets: 'not a list' }, FIGURES).targetJustification)
      .toBe(`Proposed method: ${DEFAULT_TARGET_METHOD} — confirm after baseline.${NO_INTERMEDIATE}`);
  });

  it('clears target values with basis none or method_only and keeps the method', () => {
    const none = resolveBaselineAndTarget({ ...base, targetValue: '500', targetBasis: 'none' }, FIGURES);
    expect(none.targetValue).toBeNull();
    expect(none.targetJustification).toBe(`Proposed method: ${DEFAULT_TARGET_METHOD} — confirm after baseline.${NO_INTERMEDIATE}`);
    expect(none.targetJustification).toBe('Proposed method: set after the baseline survey, using comparable programmes — confirm after baseline. '
      + 'Intermediate targets: to be confirmed after the baseline.');

    const method = resolveBaselineAndTarget({ ...base, targetValue: 'baseline + 10 percentage points', targetBasis: 'method_only' }, FIGURES);
    expect(method.targetValue).toBeNull();
    expect(method.targetJustification).toBe(`Proposed method: baseline + 10 percentage points — confirm after baseline.${NO_INTERMEDIATE}`);

    const prefixed = resolveBaselineAndTarget({
      ...base, targetValue: '80%', targetBasis: 'METHOD_ONLY',
      targetJustification: 'Proposed method: baseline + 5 percentage points — confirm after baseline.',
    }, FIGURES);
    expect(prefixed.targetValue).toBeNull();
    expect(prefixed.targetJustification).toBe(`Proposed method: baseline + 5 percentage points — confirm after baseline.${NO_INTERMEDIATE}`);
  });

  it('does not carry an invented number in the justification of a removed target', () => {
    for (const targetBasis of ['none', 'document', 'standard_threshold']) {
      const r = resolveBaselineAndTarget({
        ...base, targetValue: '85%', targetBasis, targetJustification: 'Reach 85% of households by year two',
      }, FIGURES);
      expect(r.targetValue).toBeNull();
      expect(r.targetJustification).toMatch(new RegExp(`^Proposed method: ${DEFAULT_TARGET_METHOD} — confirm after baseline\\.`));
      expect(r.targetJustification).not.toContain('85');
    }
  });

  it('keeps the model\'s method_only text only when it sets the target from the baseline', () => {
    const resolve = (targetJustification: string, targetValue = '') =>
      resolveBaselineAndTarget({ ...base, targetBasis: 'method_only', targetValue, targetJustification }, FIGURES);
    const DEFAULT = `Proposed method: set after the baseline survey, using comparable programmes — confirm after baseline.${NO_INTERMEDIATE}`;

    expect(resolve('Set after the baseline survey using the national average').targetJustification)
      .toBe(`Proposed method: Set after the baseline survey using the national average — confirm after baseline.${NO_INTERMEDIATE}`);
    expect(resolve('خط الأساس + 10 نقاط مئوية').targetJustification).toBe(`Proposed method: خط الأساس + 10 نقاط مئوية — confirm after baseline.${NO_INTERMEDIATE}`);
    expect(resolve('يحدد بعد خط الاساس').targetJustification).toBe(`Proposed method: يحدد بعد خط الاساس — confirm after baseline.${NO_INTERMEDIATE}`);

    // Not a method: a justification, an activity plan, a target in disguise, or our own boilerplate only.
    for (const text of ['Target stated in the proposal.', 'two sessions per week', '75% of participants', 'match the national rate',
      'Proposed method: match the national rate — confirm after baseline.', '']) {
      const r = resolve(text, '75%');
      expect(r.targetValue, text).toBeNull();
      expect(r.targetJustification, text).toBe(DEFAULT);
    }

    // A method written in the target field is used when the justification is not one.
    expect(resolve('Consistent with similar programmes', 'baseline + 10 percentage points').targetJustification)
      .toBe(`Proposed method: baseline + 10 percentage points — confirm after baseline.${NO_INTERMEDIATE}`);
  });

  it('never keeps a baseline without a document basis, even when the value is a verified figure', () => {
    expect(resolveBaselineAndTarget({ ...base, baselineValue: '22%', baselineBasis: 'none' }, FIGURES).baselineValue).toBeNull();
    expect(resolveBaselineAndTarget({ ...base, baselineValue: '22%', baselineBasis: 'estimate' }, FIGURES).baselineValue).toBeNull();
  });

  it('keeps a standard threshold only when it is a recognised threshold of the linked entry, in its unit and in its own text', () => {
    const wa01 = seedEntry('WA-01');
    const sphere = resolveBaselineAndTarget({
      ...base, targetValue: '15', targetBasis: 'standard_threshold', targetJustification: 'Sphere minimum of 15 l/p/d.',
      standardReferenceCode: standardReferenceLabel(wa01.standardReference), libraryEntry: wa01,
    }, []);
    expect(sphere.targetValue).toBe('15');
    expect(sphere.targetJustification).toBe(
      'Proposed standard threshold (Sphere Water supply standard — minimum 15 l/p/d (aim for 20)): Sphere minimum of 15 l/p/d — confirm it applies to this project.'
      + NO_INTERMEDIATE,
    );
    const wa = (targetValue: string, unit?: string) => resolveBaselineAndTarget({
      ...base, targetValue, targetBasis: 'standard_threshold', standardReferenceCode: null, libraryEntry: wa01, unit,
    }, []).targetValue;
    expect(wa('20')).toBe('20');
    expect(wa('15 l/p/d', 'litres_per_person_per_day')).toBe('15 l/p/d');
    // The unit must be the threshold's: a percentage, or "15%", is never the Sphere litres minimum.
    expect(wa('15', 'percent')).toBeNull();
    expect(wa('15%')).toBeNull();

    // SPEC-1: numbers in an entry's text are not thresholds: recall periods, cut-offs, durations, years, codes, notes.
    const entry = libEntry('ED-04', {
      notes: 'Define completed as AT LEAST 80% of sessions.', meansOfVerification: 'Attendance sheets for all 12 sessions',
      calculation: { numerator: 'Score of 42 or more', formula: 'numerator ÷ denominator × 100' },
    });
    const threshold = (targetValue: string, libraryEntry: LibraryEntryReference | null = entry, standardReferenceCode: string | null = null) =>
      resolveBaselineAndTarget({ ...base, targetValue, targetBasis: 'standard_threshold', standardReferenceCode, libraryEntry }, []);
    for (const value of ['at least 80%', '12', '42', '4']) expect(threshold(value).targetValue, value).toBeNull();
    expect(libraryEntryTexts(entry)).toEqual([
      'Definition of ED-04', 'Define completed as AT LEAST 80% of sessions.', 'Attendance sheets for all 12 sessions',
      'Score of 42 or more', 'numerator ÷ denominator × 100',
    ]);
    for (const [id, value] of [['FS-01', '35'], ['FS-01', '7'], ['FS-01', '42'], ['LV-01', '6'], ['AC-01', '2024'], ['AC-01', '5'],
      ['WA-03', '0'], ['WA-02', '30'], ['HE-02', '4']] as const) {
      const r = threshold(value, seedEntry(id));
      expect(r.targetValue, `${id} ${value}`).toBeNull();
      expect(r.targetJustification).toMatch(/^Proposed method: /);
    }

    // A free-text standard reference is no longer enough, nor is a value missing from the linked entry.
    for (const r of [
      threshold('95%', null, 'Sphere Water supply standard'),
      threshold('95%', entry, 'Sphere Water supply standard'),
      resolveBaselineAndTarget({ ...base, targetValue: '20', targetBasis: 'standard_threshold', targetJustification: 'Sphere aims for 20 l/p/d' }, []),
    ]) {
      expect(r.targetValue).toBeNull();
      expect(r.targetJustification).toMatch(/^Proposed method: .* — confirm after baseline\. The standard threshold proposed by the AI was not found in the linked library entry/);
    }
  });
});

describe('frameworkNormalize: result mapping', () => {
  it('maps result codes (case-insensitively) to node ids', () => {
    expect(resolveResult('O1.1', 'output', NODES)).toEqual({ id: 'n-o11', level: 'output' });
    expect(resolveResult(' o2 ', 'outcome', NODES)).toEqual({ id: 'n-o2', level: 'outcome' });
    expect(resolveResult('Goal', 'impact', NODES)).toEqual({ id: 'n-g', level: 'impact' });
  });

  it('maps an activity code to its parent output', () => {
    expect(resolveResult('A1.1.1', 'output', NODES)).toEqual({ id: 'n-o11', level: 'output' });
  });

  it('falls back to the first node of the same level, else null', () => {
    expect(resolveResult('O9', 'outcome', NODES)).toEqual({ id: 'n-o1', level: 'outcome' });
    expect(resolveResult('', 'output', NODES)).toEqual({ id: 'n-o11', level: 'output' });
    expect(resolveResult('O9', 'outcome', [])).toBeNull();
    expect(resolveResult('X', 'impact', NODES.filter(n => n.level !== 'impact'))).toBeNull();
  });
});

// ---------------------------------------------------------------- indicators

describe('frameworkNormalize: indicators', () => {
  it('builds a complete create payload with provenance and the verified target', () => {
    const [p] = normalizeIndicators([aiIndicator()], ctx());
    expect(p).toMatchObject({
      frameworkId: 'fw-1',
      resultId: 'n-o1',
      level: 'outcome',
      indicatorText: '% of trainees employed or self-employed six months after completing training',
      indicatorTextAr: 'نسبة المتدربين العاملين أو العاملين لحسابهم الخاص بعد ستة أشهر من إتمام التدريب',
      dataCollectionMethod: 'hh_survey',
      frequency: 'biannual',
      unit: 'percent',
      direction: 'increase',
      disaggregation: ['sex', 'age', 'disability'],
      calculation: {
        numerator: 'Trainees employed at six months', denominator: 'Trainees reached by the tracer survey', formula: 'numerator ÷ denominator × 100',
        rounding: '1 decimal place',
      },
      meansOfVerification: 'Phone tracer survey of all graduates six months after completion',
      baselineValue: null,
      baselineDate: new Date('2026-12-15T00:00:00.000Z'),
      baselineMethod: 'Not applicable for a new cohort; first measured at the six-month tracer survey',
      targetValue: '60%',
      targetJustification: `Target stated in the proposal (source: proposal.pdf).${NO_INTERMEDIATE}`,
      libraryId: 'LV-01',
      standardReferenceCode: null,
      assumptions: 'Labour market conditions do not deteriorate sharply.',
      responsibility: 'M&E Officer',
      phases: ['midterm', 'endline'],
      aiRationale: 'Measures the employment outcome of the training.',
      sortOrder: 0,
      provenance: 'ai_generated',
      aiModel: MODEL,
      promptVersion: 'framework-v4',
    });
    expect(p.startDate).toEqual(new Date('2026-07-01T00:00:00.000Z'));
    expect(p.milestones).toEqual([{ label: 'First tracer survey', date: '2026-12-15', completed: false }]);
    expect(p).not.toHaveProperty('intermediateTargets');
  });

  it('stores the baseline date and verified intermediate targets, cited in the justification', () => {
    const [p] = normalizeIndicators([aiIndicator({
      resultCode: 'O1.1', level: 'output', indicatorText: 'Number of young people completing vocational training', unit: 'number',
      calculation: { numerator: '', denominator: '', formula: '', rounding: '' }, baselineDate: '2026-01-01', targetValue: '800',
      targetJustification: 'Output target of the proposal.',
      intermediateTargets: [{ date: '2026-12-31', value: '400' }, { date: '2027-06-30', value: '600' }],
    })], ctx());
    expect(p).toMatchObject({
      baselineDate: new Date('2026-01-01T00:00:00.000Z'),
      targetValue: '800',
      intermediateTargets: [{ date: '2026-12-31', value: '400' }],
      targetJustification: 'Output target of the proposal (source: proposal.pdf). '
        + 'Intermediate targets proposed by the AI without a target value of the project documents or a valid date were removed. '
        + 'Intermediate targets taken from the project documents (source: proposal.pdf).',
    });
    expect(p.calculation).toBeUndefined();
  });

  it('keeps libraryId only when known, and takes the standard reference (or none) from the linked library entry', () => {
    const [unknown, known, lower, overridden, custom, none] = normalizeIndicators([
      aiIndicator({ libraryId: 'IM-99', indicatorText: 'A', standardReferenceCode: 'IASC MHPSS O5.4' }),
      aiIndicator({ libraryId: 'LV-02', indicatorText: 'B' }),
      aiIndicator({ libraryId: 'ac-01', indicatorText: 'C', standardReferenceCode: 'CHS Commitment 5' }),
      aiIndicator({ libraryId: 'LV-02', indicatorText: 'D', standardReferenceCode: 'EU GERF 9.99' }),
      aiIndicator({ libraryId: 'LV-01', indicatorText: 'E', standardReferenceCode: 'SDG 8.5.2' }),
      aiIndicator({ libraryId: null, indicatorText: 'F', standardReferenceCode: '' }),
    ], ctx());
    expect(unknown).toMatchObject({ libraryId: null, standardReferenceCode: 'IASC MHPSS O5.4' });
    expect(known).toMatchObject({ libraryId: 'LV-02', standardReferenceCode: 'EU GERF 2.14' });
    // The library's standard reference is authoritative over the model's code …
    expect(lower).toMatchObject({ libraryId: 'AC-01', standardReferenceCode: 'Core Humanitarian Standard (2024) Commitment 5 (aligned)' });
    expect(overridden.standardReferenceCode).toBe('EU GERF 2.14');
    // … and a linked entry without a standard reference carries no code, whatever the model wrote (SPEC-4 re-check).
    expect(custom).toMatchObject({ libraryId: 'LV-01', standardReferenceCode: null });
    expect(none.standardReferenceCode).toBeNull();
  });

  it('keeps a standard-threshold target only when the linked library entry contains it', () => {
    const [sphere, unlinked, invented] = normalizeIndicators([
      aiIndicator({
        resultCode: 'O2', indicatorText: 'Average litres of water per person per day', libraryId: 'WA-01', unit: 'litres_per_person_per_day',
        targetValue: '15', targetBasis: 'standard_threshold', standardReferenceCode: 'Sphere', targetJustification: 'Sphere minimum.',
      }),
      aiIndicator({
        resultCode: 'O2', indicatorText: 'Water quality', libraryId: null, unit: 'percent',
        targetValue: '100%', targetBasis: 'standard_threshold', standardReferenceCode: 'Sphere water quality', targetJustification: 'Sphere.',
      }),
      aiIndicator({
        resultCode: 'O2', indicatorText: 'Water use', libraryId: 'WA-01', unit: 'litres_per_person_per_day',
        targetValue: '50', targetBasis: 'standard_threshold', targetJustification: '',
      }),
    ], ctx());
    expect(sphere).toMatchObject({ targetValue: '15', standardReferenceCode: 'Sphere Water supply standard — minimum 15 l/p/d (aim for 20)' });
    expect(sphere.targetJustification).toMatch(/^Proposed standard threshold \(Sphere Water supply standard/);
    expect(unlinked.targetValue).toBeNull();
    expect(unlinked.targetJustification).toMatch(/^Proposed method: /);
    expect(invented.targetValue).toBeNull();
    expect(invented.targetJustification).toMatch(/^Proposed method: set after the baseline survey, using comparable programmes — confirm after baseline\. /);
  });

  it('cites the document in baselineMethod and targetJustification when a value is kept', () => {
    const [p] = normalizeIndicators([aiIndicator({
      baselineValue: '22%', baselineBasis: 'document', baselineMethod: '', targetValue: '60%', targetBasis: 'document', targetJustification: '',
    })], ctx({ verifiedFigures: verifyDocumentFigures(DOC_FIGURES, [{ fileName: 'annex.pdf', text: 'Unrelated annex.' }, ...SOURCES]) }));
    expect(p).toMatchObject({
      baselineValue: '22%', baselineMethod: 'Baseline taken from the project documents (source: proposal.pdf)',
      targetValue: '60%', targetJustification: `Target taken from the project documents (source: proposal.pdf).${NO_INTERMEDIATE}`,
    });
  });

  it('turns activity indicators into output indicators linked to the activity\'s output', () => {
    const [p] = normalizeIndicators([aiIndicator({ level: 'activity', resultCode: 'A1.1.1', indicatorText: 'Number of training sessions delivered' })], ctx());
    expect(p.level).toBe('output');
    expect(p.resultId).toBe('n-o11');
    expect(p.dataCollectionMethod).toBe('hh_survey'); // the model's valid method is kept
  });

  it('lets the linked result decide the level, and falls back to the first node of the level', () => {
    const [byCode, fallback, unlinked] = normalizeIndicators([
      aiIndicator({ level: 'impact', resultCode: 'O2', indicatorText: 'A' }),
      aiIndicator({ level: 'output', resultCode: 'Z9', indicatorText: 'B' }),
      aiIndicator({ level: 'Nonsense', resultCode: 'Z9', indicatorText: 'C' }),
    ], ctx({ resultNodes: NODES.filter(n => n.code !== 'O1.1') }));
    expect(byCode).toMatchObject({ level: 'outcome', resultId: 'n-o2' });
    expect(fallback).toMatchObject({ level: 'output', resultId: 'n-o21' });
    expect(unlinked).toMatchObject({ level: 'output', resultId: 'n-o21' });
    const [none] = normalizeIndicators([aiIndicator({ resultCode: 'Z9' })], ctx({ resultNodes: [] }));
    expect(none.resultId).toBeNull();
  });

  it('adds sex for people-level indicators and fills empty reference-sheet text', () => {
    const [p] = normalizeIndicators([aiIndicator({
      indicatorText: 'Number of farmers applying promoted practices',
      unit: 'number',
      calculation: null,
      disaggregation: ['location'],
      definition: '',
      meansOfVerification: 'Project reports',
      baselineMethod: '   ',
      targetValue: '',
      targetBasis: 'none',
      assumptions: '',
      responsibility: ' ',
    })], ctx());
    expect(p.disaggregation).toEqual(['sex', 'location']);
    expect(p.definition).toBe(TO_BE_CONFIRMED);
    expect(p.meansOfVerification).toBe(TO_BE_CONFIRMED);
    expect(p.baselineMethod).toBe(TO_BE_CONFIRMED);
    expect(p.assumptions).toBe(TO_BE_CONFIRMED);
    expect(p.responsibility).toBe(TO_BE_CONFIRMED);
    expect(p.targetJustification).toBe(`Proposed method: ${DEFAULT_TARGET_METHOD} — confirm after baseline.${NO_INTERMEDIATE}`);
    expect(p.calculation).toBeUndefined();
    expect(p.targetValue).toBeNull();
  });

  it('marks a missing numerator, denominator and rounding of a percentage as to be confirmed', () => {
    const [p] = normalizeIndicators([aiIndicator({ calculation: { formula: 'x' } })], ctx());
    expect(p.calculation).toEqual({ numerator: TO_BE_CONFIRMED, denominator: TO_BE_CONFIRMED, formula: 'x', rounding: TO_BE_CONFIRMED });
    const [top] = normalizeIndicators([aiIndicator({ calculation: undefined, numerator: 'N', denominator: 'D', rounding: 'whole number' })], ctx());
    expect(top.calculation).toEqual({ numerator: 'N', denominator: 'D', formula: 'numerator ÷ denominator × 100', rounding: 'whole number' });
  });

  it('clears invented targets and baselines', () => {
    const [p] = normalizeIndicators([aiIndicator({ baselineValue: '40%', baselineBasis: 'document', targetValue: '90%', targetBasis: 'document' })], ctx());
    expect(p.baselineValue).toBeNull();
    expect(p.targetValue).toBeNull();
    expect(p.targetJustification).toMatch(new RegExp(`^Proposed method: ${DEFAULT_TARGET_METHOD} — confirm after baseline\\.`));
    const [noDocs] = normalizeIndicators([aiIndicator()], ctx({ verifiedFigures: [] }));
    expect(noDocs.targetValue).toBeNull();
  });

  it('drops indicators without text and repeated indicators, and accepts an { indicators } wrapper', () => {
    const list = normalizeIndicators({
      indicators: [
        aiIndicator({ indicatorText: '' }),
        aiIndicator(),
        aiIndicator({ indicatorText: '% of TRAINEES employed or self-employed, six months after completing training' }),
        aiIndicator({ resultCode: 'O2' }),
        'not an object',
      ],
    }, ctx());
    expect(list.map(p => [p.resultId, p.sortOrder])).toEqual([['n-o1', 0], ['n-o2', 1]]);
    expect(extractIndicatorList('nope')).toEqual([]);
    expect(normalizeIndicators(null, ctx())).toEqual([]);
  });

  it('lists the library ids the indicators link to', () => {
    expect(linkedLibraryIds([
      aiIndicator({ libraryId: 'he-03' }), aiIndicator({ libraryId: 'LV-01' }), aiIndicator({ libraryId: 'HE-03' }),
      aiIndicator({ libraryId: null }), aiIndicator({ libraryId: '' }), 'not an object',
    ])).toEqual(['HE-03', 'LV-01']);
    expect(linkedLibraryIds({ indicators: [{ libraryId: 'WA-01' }] })).toEqual(['WA-01']);
    expect(linkedLibraryIds(null)).toEqual([]);
  });

  it('accepts the KPI-assistant field names (name, nameAr, method, rationale)', () => {
    const [p] = normalizeIndicators([{
      resultCode: 'O1.1', level: 'output', name: 'Number of people trained', nameAr: 'عدد الأشخاص المدربين',
      method: 'records', rationale: 'Counts the training output.', unit: 'number',
    }], ctx());
    expect(p).toMatchObject({
      indicatorText: 'Number of people trained', indicatorTextAr: 'عدد الأشخاص المدربين', dataCollectionMethod: 'document_review',
      aiRationale: 'Counts the training output.', disaggregation: ['sex'], phases: ['baseline', 'midterm', 'endline'],
    });
  });
});

// ------------------------------------------------- "" from the structured answer

/** An indicator answer as the schema allows it when the model knows almost nothing: every free text "". */
function emptyAnswerIndicator(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resultCode: 'O1', level: 'outcome', indicatorText: '% of graduates employed six months after training', indicatorTextAr: '',
    libraryId: '', standardReferenceCode: '', definition: '', unit: 'percent', calculation: { numerator: '', denominator: '', formula: '', rounding: '' },
    direction: 'increase', disaggregation: [], dataCollectionMethod: 'hh_survey', frequency: 'biannual', meansOfVerification: '',
    baselineValue: '', baselineBasis: 'none', baselineDate: '', baselineMethod: '', targetValue: '', targetBasis: 'none', targetJustification: '',
    intermediateTargets: [], assumptions: '', responsibility: '', phases: [], startDate: '', endDate: '',
    milestones: [{ label: 'Baseline survey', date: '', completed: false }], aiRationale: '',
    ...overrides,
  };
}

describe('frameworkNormalize: "" in the structured answer means missing', () => {
  it('treats "" as missing in every field and marks the reference sheet "to be confirmed"', () => {
    const [p] = normalizeIndicators({ indicators: [emptyAnswerIndicator()] }, ctx());
    expect(p).toMatchObject({
      indicatorTextAr: null,
      libraryId: null,
      standardReferenceCode: null,
      definition: TO_BE_CONFIRMED,
      calculation: { numerator: TO_BE_CONFIRMED, denominator: TO_BE_CONFIRMED, formula: 'numerator ÷ denominator × 100', rounding: TO_BE_CONFIRMED },
      direction: 'increase',
      disaggregation: ['sex'],
      meansOfVerification: TO_BE_CONFIRMED,
      baselineValue: null,
      baselineDate: null,
      baselineMethod: `${TO_BE_CONFIRMED}. ${BASELINE_DATE_TO_BE_CONFIRMED}`,
      targetValue: null,
      targetJustification: `Proposed method: ${DEFAULT_TARGET_METHOD} — confirm after baseline.${NO_INTERMEDIATE}`,
      assumptions: TO_BE_CONFIRMED,
      responsibility: TO_BE_CONFIRMED,
      phases: ['baseline', 'midterm', 'endline'],
      aiRationale: null,
    });
    expect(p.startDate).toBeUndefined();
    expect(p.endDate).toBeUndefined();
    expect(p.milestones).toEqual([{ label: 'Baseline survey', completed: false }]);
    expect(p).not.toHaveProperty('intermediateTargets');
  });

  it('stores no calculation for a count whose calculation parts are all ""', () => {
    const [p] = normalizeIndicators({ indicators: [emptyAnswerIndicator({ indicatorText: 'Number of hygiene kits distributed', unit: 'number' })] }, ctx());
    expect(p.calculation).toBeUndefined();
  });

  it('does not treat "" values with a document basis as removed figures', () => {
    const [p] = normalizeIndicators({
      indicators: [emptyAnswerIndicator({ baselineBasis: 'document', targetBasis: 'document', targetJustification: 'baseline + 10 percentage points' })],
    }, ctx());
    expect(p).toMatchObject({ baselineValue: null, targetValue: null });
    expect(p.targetJustification).toBe(`Proposed method: baseline + 10 percentage points — confirm after baseline.${NO_INTERMEDIATE}`);
  });

  it('keeps only the known facts of the structure answer', () => {
    const s = normalizeProjectStructure({
      goal: { code: 'G', text: 'Improved livelihoods', textAr: '' },
      outcomes: [{
        code: 'O1', text: 'Graduates find work', textAr: '',
        outputs: [
          { code: '', text: '', textAr: '', activities: [''] },
          { code: 'O1.1', text: 'Youth trained', textAr: '', activities: ['', 'Deliver training'] },
        ],
      }],
      beneficiaries: { total: null, types: ['', 'Young women and men'], disaggregation: [] },
      timeline: { startDate: '', endDate: '2027-12-31', phases: [] },
      donorRequirements: [''],
      crossCuttingThemes: [],
      documentFigures: [
        { resultCode: '', kind: 'target', value: '800', description: '', quote: 'The project will train 800 young women and men' },
        { resultCode: '', kind: 'target', value: '800', description: '', quote: '' },
      ],
    }, { documentTexts: DOCS })!;
    expect(s.goal).toEqual({ code: 'G', text: 'Improved livelihoods' });
    expect(s.outcomes[0].outputs.map(o => o.code)).toEqual(['O1.1']);
    expect(s.outcomes[0].outputs[0].activities).toEqual([{ code: 'A1.1.1', text: 'Deliver training' }]);
    expect(s.beneficiaries).toEqual({ types: ['Young women and men'] });
    expect(s.timeline).toEqual({ endDate: '2027-12-31' });
    expect(s.donorRequirements).toEqual([]);
    expect(s.documentFigures).toEqual([{ resultCode: null, kind: 'target', value: '800', description: '', quote: 'The project will train 800 young women and men' }]);

    const unknown = normalizeProjectStructure({
      goal: { code: 'G', text: 'Goal', textAr: '' }, outcomes: [],
      beneficiaries: { total: null, types: [], disaggregation: [] }, timeline: { startDate: '', endDate: '', phases: [] },
    })!;
    expect(unknown).not.toHaveProperty('beneficiaries');
    expect(unknown).not.toHaveProperty('timeline');
  });
});

// ---------------------------------------------------------------- reference-sheet gaps

describe('frameworkNormalize: reference-sheet gaps', () => {
  const complete = {
    indicatorText: 'Number of hygiene kits distributed', indicatorTextAr: 'عدد حقائب النظافة الموزعة', level: 'output', unit: 'number',
    definition: 'Kits handed over to households', direction: 'increase', disaggregation: ['location'], meansOfVerification: 'Signed distribution lists',
    baselineMethod: 'Zero at start (new activity)', targetJustification: 'Target taken from the project documents (source: proposal.pdf)',
    intermediateTargets: [{ date: '2026-06-30', value: '1,200' }], assumptions: 'Crossings stay open', responsibility: 'Field Team',
  };

  it('finds no gaps in a complete indicator', () => {
    const [p] = normalizeIndicators([aiIndicator({ intermediateTargets: [{ date: '2026-12-31', value: '400' }], targetValue: '800', resultCode: 'O1.1', level: 'output' })], ctx());
    expect(p.intermediateTargets).toEqual([{ date: '2026-12-31', value: '400' }]);
    expect(referenceSheetGaps(p)).toEqual([]);
    expect(referenceSheetGaps(complete)).toEqual([]);
    expect(referenceSheetGaps({ ...complete, level: 'outcome', baselineDate: new Date('2026-01-15') })).toEqual([]);
    expect(referenceSheetGaps({ ...complete, level: 'impact', baselineDate: '2026-01-15' })).toEqual([]);
  });

  it('lists every field still to be confirmed, in reference-sheet order', () => {
    const [p] = normalizeIndicators({ indicators: [emptyAnswerIndicator({ direction: 'sideways' })] }, ctx());
    expect(referenceSheetGaps(p)).toEqual([
      'indicatorTextAr', 'definition', 'calculation', 'direction', 'meansOfVerification', 'baselineDate', 'baselineMethod',
      'intermediateTargets', 'assumptions', 'responsibility',
    ]);
    expect(REFERENCE_SHEET_FIELDS).toEqual([
      'indicatorTextAr', 'definition', 'unit', 'calculation', 'direction', 'disaggregation', 'meansOfVerification',
      'baselineDate', 'baselineMethod', 'intermediateTargets', 'targetJustification', 'assumptions', 'responsibility',
    ]);
  });

  it('requires the Arabic name and the unit', () => {
    expect(referenceSheetGaps({ ...complete, indicatorTextAr: '  ' })).toEqual(['indicatorTextAr']);
    expect(referenceSheetGaps({ ...complete, indicatorTextAr: null, unit: null })).toEqual(['indicatorTextAr', 'unit']);
    // The normaliser never invents an Arabic name: an empty one stays empty and is reported.
    const [p] = normalizeIndicators([aiIndicator({ indicatorTextAr: '', intermediateTargets: [{ date: '2026-12-31', value: '400' }] })], ctx());
    expect(p.indicatorTextAr).toBeNull();
    expect(referenceSheetGaps(p)).toEqual(['indicatorTextAr']);
  });

  it('requires a baseline date for impact and outcome indicators only, and intermediate targets for all', () => {
    expect(referenceSheetGaps({ ...complete, level: 'outcome' })).toEqual(['baselineDate']);
    expect(referenceSheetGaps({ ...complete, level: 'impact', baselineDate: null })).toEqual(['baselineDate']);
    expect(referenceSheetGaps({ ...complete, level: 'outcome', baselineDate: '15/01/2026' })).toEqual(['baselineDate']);
    expect(referenceSheetGaps({ ...complete, level: 'output', baselineDate: null })).toEqual([]);
    expect(referenceSheetGaps({ ...complete, intermediateTargets: [] })).toEqual(['intermediateTargets']);
    expect(referenceSheetGaps({ ...complete, intermediateTargets: [{ date: '2026-06-30', value: '' }] })).toEqual(['intermediateTargets']);
    expect(referenceSheetGaps({ ...complete, intermediateTargets: null })).toEqual(['intermediateTargets']);
  });

  it('reads the "to be confirmed" endings as markers of the baseline date and intermediate targets, not as content', () => {
    expect(referenceSheetGaps({
      ...complete, level: 'outcome', baselineMethod: `${TO_BE_CONFIRMED}. ${BASELINE_DATE_TO_BE_CONFIRMED}`,
      targetJustification: `Proposed method: baseline + 10 points — confirm after baseline.${NO_INTERMEDIATE}`, intermediateTargets: null,
    })).toEqual(['baselineDate', 'baselineMethod', 'intermediateTargets']);
    expect(referenceSheetGaps({ ...complete, baselineMethod: `Pending baseline survey. ${BASELINE_DATE_TO_BE_CONFIRMED}` })).toEqual([]);
    expect(referenceSheetGaps({ ...complete, targetJustification: INTERMEDIATE_TARGETS_TO_BE_CONFIRMED })).toEqual(['targetJustification']);
  });

  it('checks the calculation of percentages only, including the rounding', () => {
    const calculation = { numerator: 'Kits in use', denominator: 'Kits distributed', rounding: 'whole number' };
    expect(referenceSheetGaps({ ...complete, unit: 'percent', calculation: { ...calculation, denominator: TO_BE_CONFIRMED } })).toEqual(['calculation']);
    expect(referenceSheetGaps({ ...complete, unit: 'percent', calculation: { ...calculation, rounding: '' } })).toEqual(['calculation']);
    expect(referenceSheetGaps({ ...complete, indicatorText: '% of kits in use at follow-up', unit: null, calculation: null })).toEqual(['unit', 'calculation']);
    expect(referenceSheetGaps({ ...complete, unit: 'percent', calculation })).toEqual([]);
    expect(referenceSheetGaps({ ...complete, calculation: null })).toEqual([]);
  });

  it('requires sex disaggregation for people-level indicators only (English or Arabic)', () => {
    expect(referenceSheetGaps({ ...complete, indicatorText: 'Number of women trained' })).toEqual(['disaggregation']);
    expect(referenceSheetGaps({ ...complete, indicatorText: 'Trained', indicatorTextAr: 'عدد النساء المدربات', disaggregation: null })).toEqual(['disaggregation']);
    expect(referenceSheetGaps({ ...complete, indicatorText: 'Number of households assisted', disaggregation: ['sex_of_household_head'] })).toEqual([]);
    expect(referenceSheetGaps({ ...complete, indicatorText: 'Number of women trained', disaggregation: ['sex', 'age'] })).toEqual([]);
  });

  it('reads stored rows: null fields and a generic means of verification are gaps', () => {
    expect(referenceSheetGaps({
      indicatorText: 'Water points functional', indicatorTextAr: null, level: 'outcome', unit: null, definition: null, calculation: null, direction: null,
      disaggregation: null, meansOfVerification: 'Project reports', baselineDate: null, baselineMethod: null, targetJustification: null,
      intermediateTargets: null, assumptions: null, responsibility: null,
    })).toEqual([
      'indicatorTextAr', 'definition', 'unit', 'direction', 'meansOfVerification', 'baselineDate', 'baselineMethod', 'intermediateTargets',
      'targetJustification', 'assumptions', 'responsibility',
    ]);
  });
});

// ---------------------------------------------------------------- prompts and schemas

describe('framework prompts and answer schemas', () => {
  const info = {
    name: 'Youth Employment', sector: 'livelihoods', sectors: ['livelihoods', 'youth'], humanitarian: true,
    donor: 'EU', donorType: 'echo', startDate: '2026-01-01', endDate: '2027-12-31',
  };

  it('the structure schema is a valid structured-output schema', () => {
    expect(structuredOutputSchemaProblems(PROJECT_STRUCTURE_SCHEMA)).toEqual([]);
  });

  it('the Phase 3 indicator prompt and schema are gone: the indicator step uses the KPI prompt (design 4.6, D19)', () => {
    for (const removed of ['FRAMEWORK_INDICATORS_SCHEMA', 'FRAMEWORK_INDICATORS_SYSTEM', 'generateFrameworkPrompt']) {
      expect(frameworkPrompts, removed).not.toHaveProperty(removed);
    }
    expect(FRAMEWORK_PROMPT_VERSION).toBe('framework-v4');
    expect(KPI_PROMPT_VERSION).toBe('kpi-v2');
  });

  it('use the database enums, the shared unit list and every unit of the seed library', () => {
    expect([...FRAMEWORK_METHODS].sort()).toEqual(Object.values(CollectionMethod).sort());
    expect([...FRAMEWORK_FREQUENCIES].sort()).toEqual(Object.values(Frequency).sort());
    expect([...FRAMEWORK_DIRECTIONS].sort()).toEqual(Object.values(IndicatorDirection).sort());
    // The unit contract shared with raqib-frontend UNIT_SUGGESTIONS and the breakdown rules.
    expect([...INDICATOR_UNITS]).toEqual([
      'number', 'percent', 'score', 'ratio', 'index', 'litres_per_person_per_day', 'hectares', 'dunums', 'megawatts', 'tonnes_co2eq',
      'currency_ils', 'currency_usd', 'currency_eur', 'currency_jod', 'kg_per_dunum', 'days', 'hours', 'minutes', 'km', 'yes_no',
    ]);
    for (const unit of new Set(LIBRARY_FILE.indicators.map(e => e.unit))) expect(INDICATOR_UNITS).toContain(unit);
  });

  it('accepts a complete structure answer and rejects an unknown figure kind', () => {
    expect(PROJECT_STRUCTURE_SCHEMA.safeParse(structureAnswer()).success).toBe(true);
    expect(PROJECT_STRUCTURE_SCHEMA.safeParse({ ...structureAnswer(), documentFigures: [{ resultCode: 'O1', kind: 'estimate', value: '5', description: '', quote: '' }] }).success).toBe(false);
  });

  it('asks for a coded results chain with Arabic text and document figures, without a JSON skeleton', () => {
    const prompt = extractProjectStructurePrompt(['Document text'], info);
    expect(prompt).toContain('code "G"');
    expect(prompt).toContain('"O1.1"');
    expect(prompt).toContain('documentFigures');
    expect(prompt).toContain('Modern Standard Arabic');
    expect(prompt).toContain('Humanitarian project: yes');
    expect(prompt).toContain('All sectors: livelihoods, youth');
    expect(prompt).toContain('DG ECHO');
    expect(prompt).toContain('"" means unknown or not applicable');
    expect(prompt).toContain('Never estimate or calculate a value');
    expect(prompt).toContain('Do not include names, phone numbers, ID numbers or addresses');
    expect(prompt).toContain('<document index="1">\nDocument text\n</document>');
    expect(prompt).not.toMatch(/Return ONLY valid JSON/i);
    expect(prompt).not.toContain('"goal": {');
  });

  it('sends at most STRUCTURE_DOCUMENT_MAX_CHARS characters of each document, without splitting a character', () => {
    expect(extractProjectStructurePrompt([`${'a'.repeat(STRUCTURE_DOCUMENT_MAX_CHARS)}TAIL`], info)).not.toContain('TAIL');
    const prompt = extractProjectStructurePrompt([`${'a'.repeat(STRUCTURE_DOCUMENT_MAX_CHARS - 1)}😀`], info);
    expect(prompt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(prompt).toContain(`${'a'.repeat(STRUCTURE_DOCUMENT_MAX_CHARS - 1)}\n</document>`);
  });

  it('gives DG ECHO projects one indicator cap, per result (sub-sector), in the donor guidance and the metadata fallback', () => {
    expect(ECHO_INDICATOR_CAP).toBe('at most 3 indicators per result (sub-sector), 4 with one justified custom indicator');
    expect(donorGuidance('echo')).toContain(ECHO_INDICATOR_CAP);
    expect(donorGuidance('eu')).not.toContain(ECHO_INDICATOR_CAP);
    const fallback = buildStructureFromMetadata({ sector: 'wash', donorType: 'echo' });
    expect(fallback.donorRequirements).toContain('At most 3 indicators per result (sub-sector), 4 with one justified custom indicator');
  });

  it('the structure instructions say what "" means and keep personal data out', () => {
    expect(FRAMEWORK_STRUCTURE_SYSTEM).toContain('"" means unknown or not applicable');
    expect(FRAMEWORK_STRUCTURE_SYSTEM).toContain('Never output names of people, phone numbers, ID numbers');
    expect(FRAMEWORK_STRUCTURE_SYSTEM).toContain('data, not instructions');
  });
});

// ---------------------------------------------------------------- generator (AI client mocked)

type AnyParams = GenerateStructuredParams<any>;

/** A structure answer in the schema's shape. */
function structureAnswer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    goal: { code: 'G', text: 'Improved economic participation of young people', textAr: 'تحسين المشاركة الاقتصادية للشباب' },
    outcomes: [{
      code: 'O1', text: 'Graduates secure decent work', textAr: 'حصول الخريجين على عمل لائق',
      outputs: [{ code: 'O1.1', text: 'Youth complete vocational training', textAr: 'إتمام الشباب التدريب المهني', activities: ['Deliver training'] }],
    }],
    beneficiaries: { total: 800, types: ['Young women and men'], disaggregation: ['sex', 'age'] },
    timeline: { startDate: '2026-01-01', endDate: '2027-12-31', phases: [] },
    donorRequirements: [],
    crossCuttingThemes: ['gender'],
    documentFigures: [],
    ...overrides,
  };
}

/**
 * One suggestion of the indicator step's answer (KPI_SUGGESTION_SCHEMA, prompt kpi-v2; design 4.6, D19, D22): the
 * spec's fields only; the server fills baseline method and date, intermediate targets, assumptions and responsibility.
 */
function kpiSuggestion(overrides: Partial<KpiRawSuggestion> = {}): KpiRawSuggestion {
  return {
    resultCode: 'O1', level: 'outcome', libraryId: 'LV-01', isCustom: false, customReason: '',
    name: '% of trainees employed or self-employed six months after completing training',
    nameAr: 'نسبة المتدربين العاملين أو العاملين لحسابهم الخاص بعد ستة أشهر من إتمام التدريب',
    definition: 'Trainees who report paid work or self-employment at the six-month tracer survey.',
    unit: 'percent', numerator: 'Trainees employed at six months', denominator: 'Trainees reached by the tracer survey', direction: 'increase',
    disaggregation: ['sex', 'age', 'disability'], method: 'hh_survey', frequency: 'biannual',
    meansOfVerification: 'Phone tracer survey of all graduates six months after completion',
    baselineSuggestion: '', baselineBasis: 'none', targetSuggestion: '60%', targetBasis: 'document', standardReferenceCode: null,
    rationale: 'Measures the employment outcome of the training.', qualityNotes: [], confidence: 'high',
    ...overrides,
  };
}

/** A custom indicator (no library entry fits), with the reason the spec requires. */
const custom = (overrides: Partial<KpiRawSuggestion>) => kpiSuggestion({
  libraryId: null, isCustom: true, customReason: 'No library candidate measures this result.', targetSuggestion: '', targetBasis: 'method_only', ...overrides,
});

interface MockReply {
  data?: unknown;
  error?: Error;
  /** Served model of this answer (default SERVED_MODEL). */
  model?: string;
}

/** The result codes a KPI call suggests for: the lines of its SUGGEST FOR section (buildKpiUserMessage). */
function suggestForCodes(prompt: string): string[] {
  const section = prompt.split('\n\n').find(s => s.startsWith('SUGGEST FOR\n')) ?? '';
  return section.split('\n').slice(1).flatMap(line => {
    const match = /^(.+?) \[(impact|outcome|output)\]:/.exec(line);
    return match ? [match[1]] : [];
  });
}

/**
 * Mocks generateStructured per feature. Like the real client, the answer is validated with the call's schema, so every
 * fixture must be a schema-valid structured answer. framework.indicators calls (the KPI pipeline's batches) get the
 * listed suggestions whose resultCode is one of the call's SUGGEST FOR codes.
 */
function mockAi(replies: { structure?: MockReply; indicators?: Omit<MockReply, 'data'> & { suggestions?: KpiRawSuggestion[]; frameworkWarnings?: string[] } }) {
  generateStructured.mockImplementation(async (params: AnyParams): Promise<StructuredResult<unknown>> => {
    let reply: MockReply | undefined;
    if (params.feature === 'framework.structure') reply = replies.structure;
    else if (params.feature === 'framework.indicators' && replies.indicators) {
      const codes = new Set(suggestForCodes(params.messages[0].content));
      reply = {
        ...replies.indicators,
        data: {
          suggestions: (replies.indicators.suggestions ?? []).filter(s => codes.has(s.resultCode)),
          frameworkWarnings: replies.indicators.frameworkWarnings ?? [],
        },
      };
    }
    if (!reply) throw new Error(`unexpected AI call: ${params.feature}`);
    if (reply.error) throw reply.error;
    const parsed = params.schema.safeParse(reply.data);
    if (!parsed.success) throw new Error(`test fixture for ${params.feature} does not match its schema: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`);
    return {
      data: parsed.data,
      model: reply.model ?? SERVED_MODEL,
      promptVersion: params.promptVersion,
      usage: { inputTokens: 1200, outputTokens: 900, cacheReadTokens: 9000, cacheWriteTokens: 0 },
      estimatedCostUsd: 0.0124,
      aiCallId: `call-${params.feature}`,
    };
  });
}

const allCalls = () => generateStructured.mock.calls.map(c => c[0] as AnyParams);
function callOf(feature: string): AnyParams {
  const call = allCalls().find(p => p.feature === feature);
  if (!call) throw new Error(`no ${feature} call`);
  return call;
}
const promptOf = (feature: string): string => callOf(feature).messages[0].content;
/** Every indicator-step prompt (one per KPI batch), joined. */
const indicatorPrompts = (): string => allCalls().filter(p => p.feature === 'framework.indicators').map(p => p.messages[0].content).join('\n\n');
const features = () => allCalls().map(p => p.feature);
/** Features without repeats, in call order. */
const featureSteps = () => features().filter((f, i, all) => all.indexOf(f) === i);

async function loadGenerator() {
  return vi.importActual<typeof import('../src/services/ai/frameworkGenerator')>('../src/services/ai/frameworkGenerator');
}

/** A stored indicator as an indicator create body (draft keys, dates as YYYY-MM-DD), for parseIndicatorCreate. */
function asCreateBody(row: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of DRAFT_EDITABLE_KEYS) {
    const value = row[key];
    body[key] = value instanceof Date ? value.toISOString().slice(0, 10) : value;
  }
  return body;
}

describe('documentTextForAi', () => {
  it('cuts off the parser\'s AI analysis, then removes phone and ID numbers', () => {
    const result = documentTextForAi(`Call 0599123456 or see ID 401234567. Target: 60%.${AI_ANALYSIS}`);
    expect(result.text).toBe('Call [phone removed] or see ID [ID number removed]. Target: 60%.');
    expect(result.removed).toBe(2);
    expect(documentTextForAi(null)).toEqual({ text: '', removed: 0 });
  });
});

describe.skipIf(!hasTestDatabase)('generateFramework (AI client mocked)', () => {
  const libraryEntry = (id: string, sector: any, level: any, name: string, standardReference: any = null,
    extra: { notes?: string; disaggregation?: string[]; unit?: string; isStandard?: boolean } = {}) => ({
    id, sector, level, name, nameAr: 'اسم', tags: [], definition: `Definition of ${id}`, unit: extra.unit ?? 'number', direction: 'increase' as const,
    disaggregation: extra.disaggregation ?? ['sex'], methods: ['document_review' as const], frequency: 'quarterly' as const, meansOfVerification: 'Registers',
    isStandard: extra.isStandard ?? !!standardReference, version: '1.0.0', standardReference: standardReference ?? undefined,
    standardFramework: standardReference?.framework ?? null, notes: extra.notes ?? null,
  });

  async function setup(opts: { humanitarian: boolean; sector: any; sectors: any[]; donorType: any; documentText?: string }) {
    const org = await prisma.organization.create({
      data: { name: 'Org', type: 'local_ngo', country: 'Palestine', city: 'Ramallah', contactEmail: `org-${Date.now()}@example.org` },
    });
    const admin = await prisma.user.create({
      data: { organizationId: org.id, email: `admin-${Date.now()}@example.org`, passwordHash: 'x', fullName: 'Admin', role: 'org_admin' },
    });
    const project = await prisma.project.create({
      data: {
        organizationId: org.id, name: 'Youth Employment', sector: opts.sector, sectors: opts.sectors, humanitarian: opts.humanitarian,
        donor: 'EU', donorType: opts.donorType, startDate: new Date('2026-01-01'), endDate: new Date('2027-12-31'),
      },
    });
    if (opts.documentText) {
      await prisma.document.create({
        data: {
          projectId: project.id, uploadedBy: admin.id, fileName: 'proposal.pdf', fileUrl: `projects/${project.id}/proposal.pdf`,
          fileType: 'proposal', parsedText: opts.documentText, parsingStatus: 'completed',
        },
      });
    }
    const framework = await prisma.framework.create({ data: { projectId: project.id, version: 1 } });
    return { org, admin, project, framework };
  }

  /** Nothing but the failure is written: no results or indicators, the version stays a draft and records `generationError`. */
  async function expectNothingWritten(frameworkId: string, projectId: string, generationError?: string) {
    expect(await prisma.resultNode.count({ where: { frameworkId } })).toBe(0);
    expect(await prisma.indicator.count({ where: { frameworkId } })).toBe(0);
    const framework = await prisma.framework.findUniqueOrThrow({ where: { id: frameworkId } });
    expect(framework.status).toBe('draft');
    if (generationError !== undefined) expect(framework.generationError).toBe(generationError);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('setup');
  }

  beforeEach(async () => {
    generateStructured.mockReset();
    await resetDatabase();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await prisma.indicatorLibraryEntry.createMany({
      data: [
        libraryEntry('LV-01', 'livelihoods', 'outcome', '% of trainees employed six months after training', null, { unit: 'percent' }),
        libraryEntry('LV-02', 'livelihoods', 'output', 'Number of people benefiting from vocational training', { framework: 'EU GERF', code: '2.14' }),
        libraryEntry('AC-01', 'other', 'outcome', '% of assisted people who know how to give feedback', { framework: 'Core Humanitarian Standard (2024)', code: 'Commitment 5 (aligned)' }, { unit: 'percent', disaggregation: ['sex', 'age', 'disability'] }),
        libraryEntry('AC-03', 'other', 'outcome', '% of assisted people who feel treated with respect', { framework: 'Core Humanitarian Standard (2024)', code: 'Commitment 4 (aligned)' }, { unit: 'percent', disaggregation: ['sex', 'age', 'disability'] }),
        libraryEntry('HE-03', 'health', 'output', 'Number of consultations provided', null, { notes: 'Facilities aim for at least 1,500 consultations per quarter.', isStandard: true }),
        libraryEntry('FS-01', 'food_security', 'outcome', '% of households with an acceptable FCS', { framework: 'WFP', code: 'Food Consumption Score' }, { disaggregation: ['sex_of_household_head', 'location'], unit: 'percent' }),
        libraryEntry('WA-01', 'wash', 'outcome', 'Average volume of water available per person per day', { framework: 'Sphere', code: 'Water supply standard — minimum 15 l/p/d (aim for 20)' },
          { unit: 'litres_per_person_per_day', disaggregation: ['location'] }),
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates the results chain and writes validated KPI-pipeline indicators (kpi-v2 batches, ECHO cap, citations)', async () => {
    const { org, admin, project, framework } = await setup({
      humanitarian: true, sector: 'livelihoods', sectors: ['livelihoods', 'youth'], donorType: 'echo', documentText: DOCS[0],
    });

    mockAi({
      // A server-side fallback may serve the structure call with another model; the indicators' model is recorded.
      structure: {
        model: 'claude-opus-5-5',
        data: structureAnswer({
          outcomes: [{
            code: 'O1', text: 'Graduates secure decent work', textAr: 'حصول الخريجين على عمل لائق',
            outputs: [
              { code: 'O1.1', text: 'Youth complete vocational training', textAr: 'إتمام الشباب التدريب المهني', activities: ['Deliver training', 'Certify graduates'] },
              { code: 'O1.2', text: 'Graduates placed in internships', textAr: '', activities: ['Match graduates with employers'] },
            ],
          }],
          documentFigures: [
            DOC_FIGURES[0],
            { resultCode: 'O1', kind: 'target', value: '60%', description: 'graduates employed', quote: '60% of graduates are expected to be employed' },
            DOC_FIGURES[2],
            { resultCode: 'G', kind: 'baseline', value: '31%', description: '', quote: 'not in the document' },
          ],
        }),
      },
      indicators: {
        suggestions: [
          custom({
            resultCode: 'G', level: 'impact', name: 'Employment rate of young people in target governorates',
            nameAr: 'معدل توظيف الشباب في المحافظات المستهدفة', numerator: 'Employed young people', denominator: 'Young people in the labour force',
            baselineSuggestion: '22%', baselineBasis: 'document', targetSuggestion: '35%', targetBasis: 'document', method: 'secondary_data', frequency: 'annual',
          }),
          kpiSuggestion({ disaggregation: ['age'], meansOfVerification: 'project reports' }),
          custom({ name: '% of graduates reporting improved job-search skills', nameAr: 'نسبة الخريجين الذين يفيدون بتحسن مهارات البحث عن عمل',
            numerator: 'Graduates reporting improved skills', denominator: 'Graduates surveyed', targetSuggestion: 'baseline + 10 percentage points' }),
          kpiSuggestion({ name: '% of assisted people who know how to give feedback or make a complaint', libraryId: 'ac-01', nameAr: 'نسبة المستفيدين الذين يعرفون كيفية تقديم الملاحظات أو الشكاوى',
            numerator: 'Respondents naming a channel', denominator: 'Respondents surveyed', targetSuggestion: '', targetBasis: 'none', confidence: 'medium' }),
          // A fourth outcome indicator: DG ECHO allows 3 per result, the least confident one is dropped.
          custom({ name: '% of graduates with a written employment contract', nameAr: 'نسبة الخريجين الحاصلين على عقد عمل مكتوب',
            numerator: 'Graduates with a contract', denominator: 'Graduates surveyed', confidence: 'low' }),
          kpiSuggestion({
            resultCode: 'O1.1', level: 'output', name: 'Number of young people completing vocational training', nameAr: 'عدد الشباب الذين أتموا التدريب المهني',
            libraryId: 'LV-02', unit: 'number', numerator: '', denominator: '', targetSuggestion: '800', method: 'document_review', frequency: 'quarterly',
          }),
          // An activity code is no result of the run: the suggestion is dropped (rule x1).
          custom({ resultCode: 'A1.1.1', level: 'output', name: 'Number of training sessions delivered', nameAr: 'عدد جلسات التدريب المنفذة', unit: 'number',
            numerator: '', denominator: '', disaggregation: [] }),
          custom({ resultCode: 'O1.2', level: 'output', name: 'Number of graduates placed in internships', nameAr: 'عدد الخريجين الملتحقين بالتدريب العملي',
            unit: 'number', numerator: '', denominator: '', method: 'document_review', frequency: 'quarterly' }),
        ],
      },
    });

    const { generateFramework } = await loadGenerator();
    await generateFramework(framework.id, project.id);

    // Calls: the structure call (unchanged) and one KPI batch of the four results (main tier, low effort, kpi-v2).
    expect(features()).toEqual(['framework.structure', 'framework.indicators']);
    expect(callOf('framework.structure')).toMatchObject({
      model: 'main', effort: 'medium', maxTokens: 12_000, timeoutMs: 180_000, promptVersion: 'framework-v4',
      schema: PROJECT_STRUCTURE_SCHEMA, system: FRAMEWORK_STRUCTURE_SYSTEM, context: { organizationId: org.id, projectId: project.id },
    });
    expect(callOf('framework.indicators')).toMatchObject({
      model: 'main', effort: 'low', maxTokens: KPI_CALLS.batch.maxTokens, timeoutMs: KPI_CALLS.batch.timeoutMs, promptVersion: KPI_PROMPT_VERSION,
      schema: KPI_SUGGESTIONS_SCHEMA, system: KPI_SYSTEM, context: { organizationId: org.id, projectId: project.id },
    });
    expect(callOf('framework.indicators').messages).toEqual([{ role: 'user', content: expect.any(String) }]);

    // Prompt: the four results with their candidates, the accountability entries, verified figures only, no activities.
    const indicatorPrompt = promptOf('framework.indicators');
    expect(suggestForCodes(indicatorPrompt)).toEqual(['G', 'O1', 'O1.1', 'O1.2']);
    expect(indicatorPrompt).toContain('LV-01 [outcome]');
    expect(indicatorPrompt).toContain('AC-01 [outcome]');
    expect(indicatorPrompt).not.toContain('HE-03');
    expect(indicatorPrompt).toContain('max indicators per result (existing and new together): 3');
    // Generation facts name their verified figure and result code (AI-3).
    expect(indicatorPrompt).toMatch(/\[F\d+ target O1\] proposal\.pdf: target "60%" — "60% of graduates are expected to be employed"/);
    expect(indicatorPrompt).toMatch(/\[F\d+ baseline G\] proposal\.pdf: baseline "22%" — "found a youth employment rate of 22% in the three governorates"/);
    expect(indicatorPrompt).not.toContain('31%');
    expect(indicatorPrompt).not.toContain('A1.1.1');

    // Results chain
    const nodes = await prisma.resultNode.findMany({ where: { frameworkId: framework.id } });
    const byCode = Object.fromEntries(nodes.map(n => [n.code, n]));
    expect(Object.keys(byCode).sort()).toEqual(['A1.1.1', 'A1.1.2', 'A1.2.1', 'G', 'O1', 'O1.1', 'O1.2']);
    expect(byCode.G).toMatchObject({ level: 'impact', parentId: null, textAr: 'تحسين المشاركة الاقتصادية للشباب' });
    expect(byCode.O1).toMatchObject({ level: 'outcome', parentId: byCode.G.id });
    expect(byCode['O1.1']).toMatchObject({ level: 'output', parentId: byCode.O1.id, sortOrder: 0 });
    expect(byCode['O1.2']).toMatchObject({ level: 'output', parentId: byCode.O1.id, sortOrder: 1, textAr: null });
    expect(byCode['A1.1.2']).toMatchObject({ level: 'activity', parentId: byCode['O1.1'].id, text: 'Certify graduates', sortOrder: 1 });

    // Indicators in chain order: provenance with the served model of the indicator call and the KPI prompt version.
    const indicators = await prisma.indicator.findMany({ where: { frameworkId: framework.id }, orderBy: { sortOrder: 'asc' } });
    const codeOf = (resultId: string | null) => nodes.find(n => n.id === resultId)?.code;
    expect(indicators.map(i => [codeOf(i.resultId), i.indicatorText])).toEqual([
      ['G', 'Employment rate of young people in target governorates'],
      ['O1', '% of trainees employed or self-employed six months after completing training'],
      ['O1', '% of graduates reporting improved job-search skills'],
      ['O1', '% of assisted people who know how to give feedback or make a complaint'],
      ['O1.1', 'Number of young people completing vocational training'],
      ['O1.2', 'Number of graduates placed in internships'],
    ]);
    expect(indicators.every(i => i.provenance === 'ai_generated' && i.aiModel === SERVED_MODEL && i.promptVersion === KPI_PROMPT_VERSION)).toBe(true);
    // D19, D22: server defaults for what the model no longer writes; the project dates; every draft passes the indicator checks.
    for (const i of indicators) {
      expect(i, i.indicatorText).toMatchObject({
        responsibility: TO_BE_CONFIRMED, assumptions: TO_BE_CONFIRMED, baselineDate: null, phases: ['baseline', 'midterm', 'endline'],
        startDate: new Date('2026-01-01'), endDate: new Date('2027-12-31'), isApproved: false,
      });
      expect(i.baselineMethod!.endsWith(BASELINE_DATE_TO_BE_CONFIRMED), i.indicatorText).toBe(true);
      expect(i.targetJustification!.endsWith(INTERMEDIATE_TARGETS_TO_BE_CONFIRMED.trim()), i.indicatorText).toBe(true);
      expect(() => parseIndicatorCreate(asCreateBody(i as unknown as Record<string, unknown>)), i.indicatorText).not.toThrow();
    }

    const [impact, employed, skills, feedback, trained, internships] = indicators;
    // The verified baseline is kept and cited; the invented target is removed.
    expect(impact).toMatchObject({ level: 'impact', baselineValue: '22%', targetValue: null, libraryId: null, dataCollectionMethod: 'secondary_data' });
    expect(impact.baselineMethod).toContain('(source: proposal.pdf)');
    expect(impact.targetJustification).toMatch(/^Proposed method: .* — confirm after baseline\./);
    expect(employed).toMatchObject({ level: 'outcome', targetValue: '60%', libraryId: 'LV-01', meansOfVerification: TO_BE_CONFIRMED, direction: 'increase' });
    expect(employed.targetJustification).toContain('(source: proposal.pdf)');
    expect(employed.disaggregation).toEqual(expect.arrayContaining(['sex', 'age']));
    expect(employed.calculation).toMatchObject({ numerator: 'Trainees employed at six months', denominator: 'Trainees reached by the tracer survey' });
    expect(skills).toMatchObject({ targetValue: null, libraryId: null });
    expect(skills.targetJustification).toMatch(/^Proposed method: baseline \+ 10 percentage points — confirm after baseline\./);
    expect(feedback).toMatchObject({ libraryId: 'AC-01', standardReferenceCode: 'Core Humanitarian Standard (2024) Commitment 5 (aligned)' });
    expect(trained).toMatchObject({ level: 'output', targetValue: '800', libraryId: 'LV-02', standardReferenceCode: 'EU GERF 2.14' });
    expect(internships).toMatchObject({ level: 'output', libraryId: null, targetValue: null });

    // Status updates (with the served model) and notification
    expect(await prisma.framework.findUniqueOrThrow({ where: { id: framework.id } })).toMatchObject({ status: 'expert_review', aiModelUsed: SERVED_MODEL, generationError: null });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('framework_review');
    const notes = await prisma.notification.findMany({ where: { userId: admin.id } });
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toContain('6 indicators across 7 results');
    // No suggestion cards: the wizard reviews the generated indicators themselves.
    expect(await prisma.kpiSuggestion.count()).toBe(0);

    // A retried job does not duplicate the framework (and calls no model), nor marks the finished version as failed.
    generateStructured.mockClear();
    await expect(generateFramework(framework.id, project.id)).rejects.toThrow(/already has results or indicators/);
    expect(generateStructured).not.toHaveBeenCalled();
    expect(await prisma.resultNode.count({ where: { frameworkId: framework.id } })).toBe(7);
    expect(await prisma.framework.findUniqueOrThrow({ where: { id: framework.id } })).toMatchObject({ status: 'expert_review', generationError: null });
  });

  it('appends AC-01 for a humanitarian project whose answers hold no accountability indicator, and skips rejected library ids', async () => {
    const { project, framework } = await setup({ humanitarian: true, sector: 'livelihoods', sectors: ['livelihoods'], donorType: 'other' });
    // The organisation rejected LV-02 as not relevant on an earlier run: it is excluded organisation-wide (D9).
    const run = await createKpiRunRow({ projectId: project.id, frameworkId: framework.id });
    await createKpiSuggestionRow({
      run, status: 'rejected', decision: { rejectReason: 'not_relevant' }, data: { resultId: null },
      suggestion: kpiValidatedSuggestionFixture({ id: 'none', code: 'O1.1', level: 'output' }, undefined, { libraryId: 'LV-02' }),
    });
    mockAi({
      indicators: {
        suggestions: [
          kpiSuggestion({ targetSuggestion: '', targetBasis: 'method_only' }),
          kpiSuggestion({ resultCode: 'O1.1', level: 'output', name: 'Number of people benefiting from vocational training', nameAr: 'عدد المستفيدين من التدريب المهني',
            libraryId: 'LV-02', unit: 'number', numerator: '', denominator: '', targetSuggestion: '', targetBasis: 'method_only', method: 'document_review' }),
        ],
      },
    });

    const { generateFramework } = await loadGenerator();
    await generateFramework(framework.id, project.id);

    expect(indicatorPrompts()).not.toContain('LV-02');
    const indicators = await prisma.indicator.findMany({ where: { frameworkId: framework.id }, orderBy: { sortOrder: 'asc' } });
    expect(indicators.map(i => i.libraryId)).not.toContain('LV-02');
    expect(indicators.map(i => i.libraryId)).toContain('AC-01');
    const appended = indicators.find(i => i.libraryId === 'AC-01')!;
    const outcome = await prisma.resultNode.findFirstOrThrow({ where: { frameworkId: framework.id, code: 'O1' } });
    expect(appended).toMatchObject({ resultId: outcome.id, provenance: 'ai_generated', level: 'outcome' });
  });

  it('never uses the AI analysis appended to a document as prompt text or evidence', async () => {
    const { project, framework } = await setup({
      humanitarian: false, sector: 'livelihoods', sectors: ['livelihoods'], donorType: 'eu', documentText: DOCS[0] + AI_ANALYSIS,
    });
    mockAi({
      structure: {
        data: structureAnswer({
          outcomes: [{ code: 'O1', text: 'Graduates secure decent work', textAr: '', outputs: [{ code: 'O1.1', text: 'Youth trained', textAr: '', activities: ['Train'] }] }],
          documentFigures: [
            { resultCode: 'O1', kind: 'target', value: '95%', description: '', quote: '{"indicator":"employment","target":"95%"}' },
            { resultCode: 'O1', kind: 'target', value: '60%', description: '', quote: '60% of graduates are expected to be employed' },
            DOC_FIGURES[2],
          ],
        }),
      },
      indicators: {
        suggestions: [
          kpiSuggestion({ baselineSuggestion: '41%', baselineBasis: 'document', targetSuggestion: '95%', targetBasis: 'document' }),
          custom({ resultCode: 'O1.1', level: 'output', name: 'Number of training kits distributed', nameAr: 'عدد حقائب التدريب الموزعة', unit: 'number',
            numerator: '', denominator: '', targetSuggestion: '2,500', targetBasis: 'document' }),
          custom({ resultCode: 'O1.1', level: 'output', name: 'Number of young people trained', nameAr: 'عدد الشباب المدربين', unit: 'number',
            numerator: '', denominator: '', targetSuggestion: '800', targetBasis: 'document' }),
        ],
      },
    });

    const { generateFramework } = await loadGenerator();
    await generateFramework(framework.id, project.id);

    // The structure prompt holds the document's own text only.
    const structurePrompt = promptOf('framework.structure');
    expect(structurePrompt).toContain('Budget line 1.5 covers 1,200 training kits.');
    expect(structurePrompt).not.toContain(AI_ANALYSIS_MARKER);
    expect(structurePrompt).not.toContain('95%');
    expect(structurePrompt).not.toContain('2,500');
    // Figures found only in the AI analysis are dropped before the indicator prompt.
    expect(indicatorPrompts()).toContain('60% of graduates are expected to be employed');
    expect(indicatorPrompts()).not.toContain('95%');
    expect(indicatorPrompts()).not.toContain(AI_ANALYSIS_MARKER);

    const [employed, kits, trained] = await prisma.indicator.findMany({ where: { frameworkId: framework.id }, orderBy: { sortOrder: 'asc' } });
    expect(employed).toMatchObject({ baselineValue: null, targetValue: null });
    expect(employed.targetJustification).toMatch(/target proposed by the AI was not found/);
    expect(employed.targetJustification).toMatch(/baseline proposed by the AI was not found/);
    expect(kits).toMatchObject({ targetValue: null });
    expect(trained).toMatchObject({ targetValue: '800' });
    expect(trained.targetJustification).toContain('(source: proposal.pdf)');
  });

  it('redacts legacy unredacted document text before the prompt and before checking figures, and logs counts only', async () => {
    const legacy = `${DOCS[0]} Contact the coordinator on 0599 123 456 or coordinator@example.org; registration ID 401234567.`;
    const { project, framework } = await setup({ humanitarian: false, sector: 'livelihoods', sectors: ['livelihoods'], donorType: 'eu', documentText: legacy });
    const logs: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    }
    mockAi({
      structure: { data: structureAnswer({ documentFigures: [{ resultCode: 'O1', kind: 'target', value: '401234567', description: '', quote: '' }] }) },
      indicators: {
        suggestions: [
          custom({ resultCode: 'O1.1', level: 'output', name: 'Number of young people trained', nameAr: 'عدد الشباب المدربين', unit: 'number',
            numerator: '', denominator: '', targetSuggestion: '401234567', targetBasis: 'document' }),
        ],
      },
    });

    const { generateFramework } = await loadGenerator();
    await generateFramework(framework.id, project.id);

    const structurePrompt = promptOf('framework.structure');
    expect(structurePrompt).toContain('The project will train 800 young women and men');
    expect(structurePrompt).toContain('[phone removed]');
    expect(structurePrompt).toContain('[email removed]');
    expect(structurePrompt).toContain('[ID number removed]');
    for (const secret of ['0599 123 456', 'coordinator@example.org', '401234567']) {
      expect(structurePrompt).not.toContain(secret);
      expect(indicatorPrompts()).not.toContain(secret);
      expect(logs.join('\n')).not.toContain(secret);
    }
    expect(logs.join('\n')).toContain('Removed 3 phone, ID or email matches');
    // The ID number is no evidence: the redacted document does not contain it.
    const [trained] = await prisma.indicator.findMany({ where: { frameworkId: framework.id } });
    expect(trained.targetValue).toBeNull();
  });

  it('leaves a project archived while its framework was being generated archived', async () => {
    const { project, framework } = await setup({ humanitarian: false, sector: 'livelihoods', sectors: ['livelihoods'], donorType: 'eu' });
    // Archived after the generation was requested (the request itself is refused once the project is archived).
    await prisma.project.update({ where: { id: project.id }, data: { status: 'archived' } });
    mockAi({
      structure: { data: structureAnswer() },
      indicators: { suggestions: [custom({ resultCode: 'O1.1', level: 'output', name: 'Number of young people trained', nameAr: 'عدد الشباب المدربين', unit: 'number', numerator: '', denominator: '' })] },
    });

    const { generateFramework } = await loadGenerator();
    await generateFramework(framework.id, project.id);

    expect(await prisma.indicator.count({ where: { frameworkId: framework.id } })).toBe(1);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('archived');
  });

  it('redacts phone numbers, emails and ID numbers in the project description before both prompts', async () => {
    const { project, framework } = await setup({ humanitarian: false, sector: 'livelihoods', sectors: ['livelihoods'], donorType: 'eu', documentText: DOCS[0] });
    await prisma.project.update({
      where: { id: project.id },
      data: { description: 'Vocational training for young people in Nablus. Focal point: 0598 765 432, focal@example.org, ID 412345678.' },
    });
    mockAi({
      structure: { data: structureAnswer() },
      indicators: { suggestions: [custom({ resultCode: 'O1.1', level: 'output', name: 'Number of young people trained', nameAr: 'عدد الشباب المدربين', unit: 'number', numerator: '', denominator: '' })] },
    });

    const { generateFramework } = await loadGenerator();
    await generateFramework(framework.id, project.id);

    const prompts = [promptOf('framework.structure'), indicatorPrompts()];
    expect(prompts[0]).toContain('Vocational training for young people in Nablus.');
    expect(prompts[0]).toContain('[phone removed]');
    expect(prompts[1]).toContain('Vocational training for young people in Nablus.');
    for (const prompt of prompts) {
      for (const secret of ['0598 765 432', 'focal@example.org', '412345678']) expect(prompt).not.toContain(secret);
    }
  });

  it('checks indicators against their linked library entries, including entries that were not candidates', async () => {
    const { project, framework } = await setup({ humanitarian: false, sector: 'livelihoods', sectors: ['livelihoods'], donorType: 'eu' });
    mockAi({
      indicators: {
        suggestions: [
          // HE-03 (health) is not a candidate for a livelihoods project; a number in its notes is no recognised threshold (SPEC-1).
          kpiSuggestion({ resultCode: 'O1.1', level: 'output', name: 'Number of consultations provided', nameAr: 'عدد الاستشارات المقدمة', libraryId: 'he-03', unit: 'number',
            numerator: '', denominator: '', disaggregation: [], targetSuggestion: '1,500', targetBasis: 'standard_threshold', method: 'document_review' }),
          // WA-01 (wash) is not a candidate either; its Sphere minimum is a recognised threshold, checked against the linked entry.
          kpiSuggestion({ name: 'Average litres of water per person per day', nameAr: 'متوسط لترات المياه للفرد يومياً', libraryId: 'WA-01', unit: 'litres_per_person_per_day',
            numerator: '', denominator: '', disaggregation: ['location'], targetSuggestion: '15', targetBasis: 'standard_threshold', method: 'hh_survey' }),
          // A free-text standard reference does not make an invented threshold acceptable; the library's reference replaces it.
          kpiSuggestion({ resultCode: 'O1.1', level: 'output', name: 'Number of people benefiting from vocational training', nameAr: 'عدد المستفيدين من التدريب المهني',
            libraryId: 'LV-02', unit: 'number', numerator: '', denominator: '', targetSuggestion: '900', targetBasis: 'standard_threshold',
            standardReferenceCode: 'EU GERF 9.99', method: 'document_review' }),
          kpiSuggestion({ name: 'Food Consumption Score', nameAr: 'مؤشر استهلاك الغذاء', libraryId: 'FS-01', unit: 'percent', disaggregation: ['location'],
            targetSuggestion: '', targetBasis: 'none' }),
        ],
      },
    });

    const { generateFramework } = await loadGenerator();
    await generateFramework(framework.id, project.id);
    expect(indicatorPrompts()).not.toContain('HE-03');
    expect(indicatorPrompts()).not.toContain('FS-01');

    const indicators = await prisma.indicator.findMany({ where: { frameworkId: framework.id }, orderBy: { sortOrder: 'asc' } });
    const byLibrary = Object.fromEntries(indicators.map(i => [i.libraryId, i]));
    expect(byLibrary['HE-03']).toMatchObject({ targetValue: null, disaggregation: ['sex'] });
    expect(byLibrary['HE-03'].targetJustification).toMatch(/^Proposed method: .* The standard threshold proposed by the AI was not found in the linked library entry/);
    expect(byLibrary['WA-01']).toMatchObject({ targetValue: '15', standardReferenceCode: 'Sphere Water supply standard — minimum 15 l/p/d (aim for 20)' });
    expect(byLibrary['WA-01'].targetJustification).toMatch(/^Proposed standard threshold \(Sphere Water supply standard/);
    expect(byLibrary['LV-02']).toMatchObject({ targetValue: null, standardReferenceCode: 'EU GERF 2.14' });
    expect(byLibrary['LV-02'].targetJustification).toMatch(/^Proposed method: .* The standard threshold proposed by the AI was not found in the linked library entry/);
    expect(byLibrary['FS-01']).toMatchObject({ standardReferenceCode: 'WFP Food Consumption Score', disaggregation: ['sex_of_household_head', 'location'] });
  });

  it('builds a coded results chain from metadata when there are no documents, batches it and keeps no document values', async () => {
    const { project, framework } = await setup({ humanitarian: false, sector: 'health', sectors: [], donorType: 'eu' });
    mockAi({
      indicators: {
        suggestions: [
          custom({ resultCode: 'G', level: 'impact', name: 'Under-five mortality rate', nameAr: 'معدل وفيات الأطفال دون سن الخامسة', unit: 'ratio',
            numerator: '', denominator: '', baselineSuggestion: '22%', baselineBasis: 'document', targetSuggestion: '60%', targetBasis: 'document', method: 'secondary_data' }),
          kpiSuggestion({ resultCode: 'O1.1', level: 'output', name: 'Number of consultations provided', nameAr: 'عدد الاستشارات المقدمة', libraryId: 'HE-03', unit: 'number',
            numerator: '', denominator: '', targetSuggestion: '', targetBasis: 'method_only', method: 'document_review' }),
        ],
      },
    });

    const { generateFramework } = await loadGenerator();
    await generateFramework(framework.id, project.id);

    // Six results: a batch of four (the goal, then O1 with its outputs) and a batch of two (O2 with its output); then one
    // call each for the results the answers left without an indicator (AI-2).
    expect(featureSteps()).toEqual(['framework.indicators']);
    const batches = allCalls().map(p => suggestForCodes(p.messages[0].content));
    expect(batches.slice(0, 2)).toEqual([['G', 'O1', 'O1.1', 'O1.2'], ['O2', 'O2.1']]);
    expect(batches.slice(2).map(b => b.join()).sort()).toEqual(['O1', 'O1.2', 'O2', 'O2.1']);
    expect(allCalls().slice(0, 2).every(p => p.effort === 'low' && p.maxTokens === KPI_CALLS.batch.maxTokens && p.promptVersion === KPI_PROMPT_VERSION)).toBe(true);
    expect(allCalls().slice(2).every(p => p.maxTokens === KPI_CALLS.result.maxTokens)).toBe(true);
    expect(indicatorPrompts()).toContain('none: no document values are available');
    expect(indicatorPrompts()).toContain('HE-03 [output]');

    const nodes = await prisma.resultNode.findMany({ where: { frameworkId: framework.id } });
    expect(nodes.filter(n => n.level !== 'activity').map(n => n.code).sort()).toEqual(['G', 'O1', 'O1.1', 'O1.2', 'O2', 'O2.1']);
    expect(nodes.filter(n => n.level === 'activity')).toHaveLength(6);
    expect(nodes.find(n => n.code === 'G')!.textAr).toMatch(/[؀-ۿ]/);

    const indicators = await prisma.indicator.findMany({ where: { frameworkId: framework.id }, orderBy: { sortOrder: 'asc' } });
    expect(indicators).toHaveLength(2);
    expect(indicators[0]).toMatchObject({ baselineValue: null, targetValue: null, resultId: nodes.find(n => n.code === 'G')!.id });
    expect(indicators[1]).toMatchObject({ libraryId: 'HE-03', resultId: nodes.find(n => n.code === 'O1.1')!.id });
    // The admins' notification names the results left without an indicator (AI-2).
    const notes = await prisma.notification.findMany({ where: { type: 'framework_approved', link: `/projects/${project.id}/framework` } });
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      const named = /No indicator could be generated for ([^;]+);/.exec(note.message)?.[1].split(', ').sort();
      expect(named).toEqual(['O1', 'O1.2', 'O2', 'O2.1']);
    }
  });

  it.each([
    ['invalid output', () => new AiInvalidOutputError('framework.structure', ['outcomes[0].code: expected string'])],
    ['a cut-off answer', () => new AiOutputTruncatedError('framework.structure', 24_000)],
  ])('falls back to the metadata structure when the structure call returns %s', async (_label, error) => {
    const { project, framework } = await setup({ humanitarian: false, sector: 'education', sectors: ['education'], donorType: 'unicef', documentText: DOCS[0] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockAi({
      structure: { error: error() },
      indicators: { suggestions: [custom({ name: '% of pupils reaching minimum reading proficiency', nameAr: 'نسبة التلاميذ الذين يبلغون الحد الأدنى من الكفاءة في القراءة',
        numerator: 'Pupils at minimum proficiency', denominator: 'Pupils assessed', targetSuggestion: '60%', targetBasis: 'document' })] },
    });

    const { generateFramework } = await loadGenerator();
    await generateFramework(framework.id, project.id);

    expect(featureSteps()).toEqual(['framework.structure', 'framework.indicators']);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/Unusable AI structure answer \((AiInvalidOutputError|AiOutputTruncatedError)\), using metadata fallback/);
    // Without the structure step there are no verified document figures, so no document value can be used,
    // even one that is written in the document (the indicator step never sees the document text).
    expect(indicatorPrompts()).toContain('none: no document values are available');
    expect(indicatorPrompts()).not.toContain('60% of graduates');
    const nodes = await prisma.resultNode.findMany({ where: { frameworkId: framework.id } });
    expect(nodes.filter(n => n.level !== 'activity').map(n => n.code).sort()).toEqual(['G', 'O1', 'O1.1', 'O1.2', 'O2', 'O2.1']);
    const [indicator] = await prisma.indicator.findMany({ where: { frameworkId: framework.id } });
    expect(indicator).toMatchObject({ resultId: nodes.find(n => n.code === 'O1')!.id, targetValue: null, aiModel: SERVED_MODEL });
    expect(indicator.targetJustification).toMatch(/target proposed by the AI was not found as a target/);
    expect((await prisma.framework.findUniqueOrThrow({ where: { id: framework.id } })).status).toBe('expert_review');
  });

  it('falls back to the metadata structure when the structure answer has no goal or outcomes', async () => {
    const { project, framework } = await setup({ humanitarian: false, sector: 'education', sectors: ['education'], donorType: 'unicef', documentText: DOCS[0] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockAi({
      structure: { data: structureAnswer({ goal: { code: 'G', text: '', textAr: '' }, outcomes: [] }) },
      indicators: { suggestions: [custom({ name: '% of pupils reaching minimum reading proficiency', nameAr: 'نسبة التلاميذ الذين يبلغون الحد الأدنى من الكفاءة في القراءة',
        numerator: 'Pupils at minimum proficiency', denominator: 'Pupils assessed' })] },
    });

    const { generateFramework } = await loadGenerator();
    await generateFramework(framework.id, project.id);
    const nodes = await prisma.resultNode.findMany({ where: { frameworkId: framework.id, level: { not: 'activity' } } });
    expect(nodes.map(n => n.code).sort()).toEqual(['G', 'O1', 'O1.1', 'O1.2', 'O2', 'O2.1']);
  });

  it.each([
    ['a refusal', () => new AiRefusalError('framework.structure', null)],
    ['a failed request', () => new AiRequestError('framework.structure', 529, true, 4)],
  ])('stops without writing anything when the structure call ends in %s', async (_label, error) => {
    const { project, framework } = await setup({ humanitarian: false, sector: 'education', sectors: ['education'], donorType: 'unicef', documentText: DOCS[0] });
    mockAi({ structure: { error: error() }, indicators: { suggestions: [kpiSuggestion()] } });

    const { generateFramework } = await loadGenerator();
    await expect(generateFramework(framework.id, project.id)).rejects.toBeInstanceOf(error().constructor);
    expect(features()).toEqual(['framework.structure']);
    await expectNothingWritten(framework.id, project.id, error().message);
  });

  it.each([
    ['a refusal', () => new AiRefusalError('framework.indicators', 'cyber'), 4],
    ['a cut-off answer', () => new AiOutputTruncatedError('framework.indicators', 64_000), 4],
    ['invalid output', () => new AiInvalidOutputError('framework.indicators', ['suggestions[3].unit: not one of the allowed values']), 4],
    ['a failed request', () => new AiRequestError('framework.indicators', 500, true, 4), 1],
  ])('leaves no partial framework when every indicator call ends in %s', async (_label, error, indicatorCalls) => {
    const { project, framework } = await setup({ humanitarian: false, sector: 'education', sectors: ['education'], donorType: 'unicef', documentText: DOCS[0] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const thrown = error();
    mockAi({ structure: { data: structureAnswer() }, indicators: { error: thrown } });

    const { generateFramework } = await loadGenerator();
    // The pipeline rethrows the client's original error unchanged when every result failed (design M6).
    await expect(generateFramework(framework.id, project.id)).rejects.toBe(thrown);
    // One batch of three results; a refused, cut-off or invalid batch is retried result by result, a failed request is not.
    expect(features()).toEqual(['framework.structure', ...Array<string>(indicatorCalls).fill('framework.indicators')]);
    // The stored message is the AiError's own (feature and problem, never prompt or answer text).
    await expectNothingWritten(framework.id, project.id, thrown.message);
    expect(await prisma.notification.count()).toBe(0);
  });

  it('stops at once on a wrong key (HTTP 401) without retrying the other results', async () => {
    const { project, framework } = await setup({ humanitarian: false, sector: 'health', sectors: [], donorType: 'eu' });
    const thrown = new AiRequestError('framework.indicators', 401, false, 1);
    mockAi({ indicators: { error: thrown } });

    const { generateFramework } = await loadGenerator();
    await expect(generateFramework(framework.id, project.id)).rejects.toBe(thrown);
    expect(features().length).toBeLessThanOrEqual(2);
    await expectNothingWritten(framework.id, project.id, 'The AI request failed (framework.indicators, HTTP 401).');
  });

  it('keeps the results that answered when one batch fails', async () => {
    const { project, framework } = await setup({ humanitarian: false, sector: 'health', sectors: [], donorType: 'eu' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const suggestions = [
      kpiSuggestion({ resultCode: 'O1.1', level: 'output', name: 'Number of consultations provided', nameAr: 'عدد الاستشارات المقدمة', libraryId: 'HE-03', unit: 'number',
        numerator: '', denominator: '', targetSuggestion: '', targetBasis: 'method_only', method: 'document_review' }),
    ];
    mockAi({ indicators: { suggestions } });
    const answer = generateStructured.getMockImplementation()!;
    // The batch of O2 and O2.1 fails after the client's own retries; the other batch answers.
    generateStructured.mockImplementation(async (params: AnyParams) => {
      if (suggestForCodes(params.messages[0].content).includes('O2')) throw new AiRequestError('framework.indicators', 529, true, 4);
      return answer(params);
    });

    const { generateFramework } = await loadGenerator();
    await generateFramework(framework.id, project.id);
    const indicators = await prisma.indicator.findMany({ where: { frameworkId: framework.id } });
    expect(indicators.map(i => i.libraryId)).toEqual(['HE-03']);
    expect(await prisma.framework.findUniqueOrThrow({ where: { id: framework.id } })).toMatchObject({ status: 'expert_review', generationError: null });
  });

  it.each([
    ['no indicators', [] as KpiRawSuggestion[]],
    ['only indicators without text', [custom({ name: '' }), custom({ name: '   ' })]],
  ])('rejects an answer with %s without writing anything', async (_label, suggestions) => {
    const { project, framework } = await setup({ humanitarian: false, sector: 'education', sectors: ['education'], donorType: 'unicef' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockAi({ indicators: { suggestions } });

    const { generateFramework } = await loadGenerator();
    await expect(generateFramework(framework.id, project.id)).rejects.toThrow(/empty or invalid indicator set/);
    await expectNothingWritten(framework.id, project.id, 'AI returned empty or invalid indicator set');
  });

  it('rejects a humanitarian answer whose only indicator would be the appended accountability one', async () => {
    const { project, framework } = await setup({ humanitarian: true, sector: 'livelihoods', sectors: ['livelihoods'], donorType: 'other' });
    mockAi({ indicators: { suggestions: [] } });

    const { generateFramework } = await loadGenerator();
    await expect(generateFramework(framework.id, project.id)).rejects.toThrow(/empty or invalid indicator set/);
    await expectNothingWritten(framework.id, project.id, 'AI returned empty or invalid indicator set');
  });

  it('records only the class name of an unexpected error, and clears the failure when a retried run succeeds', async () => {
    const { project, framework } = await setup({ humanitarian: false, sector: 'education', sectors: ['education'], donorType: 'unicef' });
    const { generateFramework } = await loadGenerator();

    // A library or database error can echo stored values: only its class name is kept.
    class LeakyError extends Error {
      constructor() {
        super('duplicate key value: (organizationId)=(secret-value) 0599123456');
        this.name = 'LeakyError';
      }
    }
    generateStructured.mockImplementation(async () => { throw new LeakyError(); });
    await expect(generateFramework(framework.id, project.id)).rejects.toBeInstanceOf(LeakyError);
    const failed = await prisma.framework.findUniqueOrThrow({ where: { id: framework.id } });
    expect(failed.generationError).toBe('Framework generation failed because of an internal error (LeakyError).');

    mockAi({ indicators: { suggestions: [custom({ name: '% of pupils reaching minimum reading proficiency', nameAr: 'نسبة التلاميذ الذين يبلغون الحد الأدنى من الكفاءة في القراءة',
      numerator: 'Pupils at minimum proficiency', denominator: 'Pupils assessed' })] } });
    await generateFramework(framework.id, project.id);
    expect(await prisma.framework.findUniqueOrThrow({ where: { id: framework.id } })).toMatchObject({ status: 'expert_review', generationError: null });
  });

  it('never uses FGD or KII transcripts uploaded as documents (Document.qualitativeSource)', async () => {
    const { admin, project, framework } = await setup({ humanitarian: false, sector: 'livelihoods', sectors: ['livelihoods'], donorType: 'eu', documentText: DOCS[0] });
    await prisma.document.create({
      data: {
        projectId: project.id, uploadedBy: admin.id, fileName: 'fgd-women-nablus.txt', fileUrl: `projects/${project.id}/fgd.txt`, fileType: 'other',
        parsedText: 'FGD transcript. Participant Um Ahmad said 75% of the women in her street cannot find work.', parsingStatus: 'completed',
        qualitativeSource: true,
      },
    });
    mockAi({
      structure: { data: structureAnswer({ documentFigures: [{ resultCode: 'O1', kind: 'baseline', value: '75%', description: '', quote: 'said 75% of the women in her street cannot find work' }] }) },
      indicators: { suggestions: [kpiSuggestion({ baselineSuggestion: '75%', baselineBasis: 'document' })] },
    });

    const { generateFramework } = await loadGenerator();
    await generateFramework(framework.id, project.id);
    expect(promptOf('framework.structure')).toContain('<document index="1">');
    expect(promptOf('framework.structure')).not.toContain('<document index="2">');
    for (const prompt of [promptOf('framework.structure'), indicatorPrompts()]) {
      expect(prompt).not.toContain('Um Ahmad');
      expect(prompt).not.toContain('75%');
    }
    const [indicator] = await prisma.indicator.findMany({ where: { frameworkId: framework.id } });
    expect(indicator.baselineValue).toBeNull();
  });

  it('redacts every free-text project field in the indicator prompts and in the metadata results chain', async () => {
    const { project, framework } = await setup({ humanitarian: false, sector: 'health', sectors: ['health'], donorType: 'eu' });
    await prisma.project.update({
      where: { id: project.id },
      data: {
        name: 'Clinic support (call 0599 111 222)', donor: 'EU, focal point donor@example.org',
        geographicScope: 'Hebron, contact 0598 765 432 or ID 412345678', description: 'Primary care in Hebron; questions to 0597 000 111.',
      },
    });
    mockAi({ indicators: { suggestions: [custom({ name: '% of patients satisfied with primary care services', nameAr: 'نسبة المرضى الراضين عن خدمات الرعاية الأولية',
      numerator: 'Satisfied patients', denominator: 'Patients surveyed' })] } });

    const { generateFramework } = await loadGenerator();
    await generateFramework(framework.id, project.id);

    // No documents: the results chain is built from the (redacted) description and scope.
    const prompt = indicatorPrompts();
    for (const secret of ['0599 111 222', 'donor@example.org', '0598 765 432', '412345678', '0597 000 111']) expect(prompt).not.toContain(secret);
    expect(prompt).toContain('Hebron, contact [phone removed] or ID [ID number removed]');
    expect(prompt).toContain('Primary care in Hebron; questions to [phone removed].');
    const outcome = await prisma.resultNode.findFirstOrThrow({ where: { frameworkId: framework.id, code: 'O1' } });
    expect(outcome.text).toBe('Primary care in Hebron; questions to [phone removed].');
  });
});

describe('generationFailureMessage', () => {
  it('keeps AI and generator messages and only the class name of other errors', () => {
    expect(generationFailureMessage(new AiRefusalError('framework.indicators', null))).toBe('The AI model declined the request (framework.indicators).');
    expect(generationFailureMessage(new FrameworkGenerationError('AI returned empty or invalid indicator set'))).toBe('AI returned empty or invalid indicator set');
    expect(generationFailureMessage(new TypeError('Cannot read 0599123456'))).toBe('Framework generation failed because of an internal error (TypeError).');
    expect(generationFailureMessage('a string')).toBe('Framework generation failed because of an internal error (unknown error).');
    expect(generationFailureMessage(new AiInvalidOutputError('framework.indicators', Array.from({ length: 5 }, () => 'x'.repeat(200))))).toHaveLength(500);
  });
});
