import fs from 'fs';
import { CollectionMethod, Frequency, IndicatorDirection } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_ANALYSIS_MARKER,
  DEFAULT_TARGET_METHOD,
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
  stripAiAnalysis,
  structureForPrompt,
  withLibrarySexDisaggregation,
} from '../src/services/ai/frameworkNormalize';
import {
  FRAMEWORK_DIRECTIONS,
  FRAMEWORK_FREQUENCIES,
  FRAMEWORK_INDICATORS_SCHEMA,
  FRAMEWORK_INDICATORS_SYSTEM,
  FRAMEWORK_METHODS,
  FRAMEWORK_PROMPT_VERSION,
  FRAMEWORK_STRUCTURE_SYSTEM,
  INDICATOR_UNITS,
  PROJECT_STRUCTURE_SCHEMA,
  STRUCTURE_DOCUMENT_MAX_CHARS,
  extractProjectStructurePrompt,
  generateFrameworkPrompt,
} from '../src/services/ai/prompts/framework';
import { AiInvalidOutputError, AiOutputTruncatedError, AiRefusalError, AiRequestError } from '../src/services/ai/errors';
import type { GenerateStructuredParams, StructuredResult } from '../src/services/ai/client';
import { prisma } from '../src/config/prisma';
import { DEFAULT_LIBRARY_PATH } from '../src/services/library/load';
import { structuredOutputSchemaProblems } from './aiSchemaHelpers';
import { hasTestDatabase, resetDatabase } from './helpers';

// tests/setup.ts mocks the generator for every other test file; this file tests the real one
// with the AI client mocked (generateStructured), so no model is ever called.
vi.unmock('../src/services/ai/frameworkGenerator');

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
  + 'Budget line 1.5 covers 1,200 training kits.',
];

const SOURCES: SourceDocument[] = [{ fileName: 'proposal.pdf', text: DOCS[0] }];

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
    documents: SOURCES,
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
    calculation: { numerator: 'Trainees employed at six months', denominator: 'Trainees reached by the tracer survey', formula: 'numerator ÷ denominator × 100' },
    direction: 'increase',
    disaggregation: ['sex', 'age', 'disability'],
    dataCollectionMethod: 'hh_survey',
    frequency: 'biannual',
    meansOfVerification: 'Phone tracer survey of all graduates six months after completion',
    baselineValue: '',
    baselineBasis: 'none',
    baselineMethod: 'Not applicable for a new cohort; first measured at the six-month tracer survey',
    targetValue: '60%',
    targetBasis: 'document',
    targetJustification: 'Target stated in the proposal.',
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

  it('keeps only document figures whose value appears in the documents', () => {
    const s = normalizeProjectStructure({
      goal: 'Goal',
      documentFigures: [
        { resultCode: 'O1', kind: 'target', value: '60%', quote: '60% of graduates' },
        { resultCode: 'O1', kind: 'baseline', value: '35%', quote: 'invented' },
        { kind: 'estimate', value: '800' },
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

  it('ignores the AI analysis the document parser appends after its marker', () => {
    const parsed = DOCS[0] + AI_ANALYSIS;
    expect(stripAiAnalysis(parsed)).toBe(DOCS[0]);
    expect(stripAiAnalysis(DOCS[0])).toBe(DOCS[0]);
    expect(stripAiAnalysis(`${AI_ANALYSIS_MARKER}\n{"summary":"only the analysis"}`)).toBe('');
    // Text after a second marker is cut as well: everything from the first marker onward is model output.
    expect(stripAiAnalysis(`A 10%${AI_ANALYSIS}${AI_ANALYSIS}`)).toBe('A 10%');
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
  const base = { baselineValue: '', baselineBasis: 'none', targetValue: '', targetBasis: 'none', targetJustification: '', standardReferenceCode: null };

  it('keeps document values that appear in a document and cites the document', () => {
    const r = resolveBaselineAndTarget({ ...base, baselineValue: '22%', baselineBasis: 'document', targetValue: '60%', targetBasis: 'document' }, SOURCES);
    expect(r.baselineValue).toBe('22%');
    expect(r.baselineMethod).toBe('Baseline taken from the project documents (source: proposal.pdf)');
    expect(r.targetValue).toBe('60%');
    expect(r.targetJustification).toBe('Target taken from the project documents (source: proposal.pdf)');

    const own = resolveBaselineAndTarget({
      ...base, baselineValue: '41%', baselineBasis: 'document', baselineMethod: 'Baseline survey, March 2026.',
      targetValue: '800', targetBasis: 'document', targetJustification: 'Output target in the proposal budget.',
    }, [...SOURCES, { fileName: 'baseline-report.docx', text: 'The baseline survey found 41% food insecure households.' }]);
    expect(own.baselineMethod).toBe('Baseline survey, March 2026 (source: baseline-report.docx)');
    expect(own.targetJustification).toBe('Output target in the proposal budget (source: proposal.pdf)');
  });

  it('never accepts a value found only in the AI analysis appended to a document', () => {
    const r = resolveBaselineAndTarget({
      ...base, baselineValue: '41%', baselineBasis: 'document', targetValue: '95%', targetBasis: 'document',
    }, [{ fileName: 'proposal.pdf', text: DOCS[0] + AI_ANALYSIS }]);
    expect(r.baselineValue).toBeNull();
    expect(r.baselineMethod).toBe(TO_BE_CONFIRMED);
    expect(r.targetValue).toBeNull();
    expect(r.targetJustification).toMatch(/target proposed by the AI was not found/);
  });

  it('clears document values not found in any document and notes it in the justification', () => {
    const r = resolveBaselineAndTarget({
      ...base, baselineValue: '30%', baselineBasis: 'document', targetValue: '75%', targetBasis: 'document',
      targetJustification: 'baseline + 15 percentage points',
    }, SOURCES);
    expect(r.baselineValue).toBeNull();
    expect(r.baselineMethod).toBe(TO_BE_CONFIRMED);
    expect(r.targetValue).toBeNull();
    expect(r.targetJustification).toMatch(/^Proposed method: baseline \+ 15 percentage points — confirm after baseline\./);
    expect(r.targetJustification).toMatch(/target proposed by the AI was not found/);
    expect(r.targetJustification).toMatch(/baseline proposed by the AI was not found.*pending baseline/);
    expect(r.targetJustification).not.toContain('75');
  });

  it('clears target values with basis none or method_only and keeps the method', () => {
    const none = resolveBaselineAndTarget({ ...base, targetValue: '500', targetBasis: 'none' }, SOURCES);
    expect(none.targetValue).toBeNull();
    expect(none.targetJustification).toBe(`Proposed method: ${DEFAULT_TARGET_METHOD} — confirm after baseline.`);
    expect(none.targetJustification).toBe('Proposed method: set after the baseline survey, using comparable programmes — confirm after baseline.');

    const method = resolveBaselineAndTarget({ ...base, targetValue: 'baseline + 10 percentage points', targetBasis: 'method_only' }, SOURCES);
    expect(method.targetValue).toBeNull();
    expect(method.targetJustification).toBe('Proposed method: baseline + 10 percentage points — confirm after baseline.');

    const prefixed = resolveBaselineAndTarget({
      ...base, targetValue: '80%', targetBasis: 'METHOD_ONLY',
      targetJustification: 'Proposed method: baseline + 5 percentage points — confirm after baseline.',
    }, SOURCES);
    expect(prefixed.targetValue).toBeNull();
    expect(prefixed.targetJustification).toBe('Proposed method: baseline + 5 percentage points — confirm after baseline.');
  });

  it('does not carry an invented number in the justification of a removed target', () => {
    for (const targetBasis of ['none', 'document', 'standard_threshold']) {
      const r = resolveBaselineAndTarget({
        ...base, targetValue: '85%', targetBasis, targetJustification: 'Reach 85% of households by year two',
      }, SOURCES);
      expect(r.targetValue).toBeNull();
      expect(r.targetJustification).toMatch(new RegExp(`^Proposed method: ${DEFAULT_TARGET_METHOD} — confirm after baseline\\.`));
      expect(r.targetJustification).not.toContain('85');
    }
  });

  it('keeps the model\'s method_only text only when it sets the target from the baseline', () => {
    const resolve = (targetJustification: string, targetValue = '') =>
      resolveBaselineAndTarget({ ...base, targetBasis: 'method_only', targetValue, targetJustification }, SOURCES);
    const DEFAULT = 'Proposed method: set after the baseline survey, using comparable programmes — confirm after baseline.';

    expect(resolve('Set after the baseline survey using the national average').targetJustification)
      .toBe('Proposed method: Set after the baseline survey using the national average — confirm after baseline.');
    expect(resolve('خط الأساس + 10 نقاط مئوية').targetJustification).toBe('Proposed method: خط الأساس + 10 نقاط مئوية — confirm after baseline.');
    expect(resolve('يحدد بعد خط الاساس').targetJustification).toBe('Proposed method: يحدد بعد خط الاساس — confirm after baseline.');

    // Not a method: a justification, an activity plan, a target in disguise, or our own boilerplate only.
    for (const text of ['Target stated in the proposal.', 'two sessions per week', '75% of participants', 'match the national rate',
      'Proposed method: match the national rate — confirm after baseline.', '']) {
      const r = resolve(text, '75%');
      expect(r.targetValue, text).toBeNull();
      expect(r.targetJustification, text).toBe(DEFAULT);
    }

    // A method written in the target field is used when the justification is not one.
    expect(resolve('Consistent with similar programmes', 'baseline + 10 percentage points').targetJustification)
      .toBe('Proposed method: baseline + 10 percentage points — confirm after baseline.');
  });

  it('never keeps a baseline without a document basis, even when the value appears in a document', () => {
    expect(resolveBaselineAndTarget({ ...base, baselineValue: '22%', baselineBasis: 'none' }, SOURCES).baselineValue).toBeNull();
    expect(resolveBaselineAndTarget({ ...base, baselineValue: '22%', baselineBasis: 'estimate' }, SOURCES).baselineValue).toBeNull();
  });

  it('keeps a standard threshold only when the linked library entry\'s own text contains it', () => {
    const wa01 = seedEntry('WA-01');
    const sphere = resolveBaselineAndTarget({
      ...base, targetValue: '15', targetBasis: 'standard_threshold', targetJustification: 'Sphere minimum of 15 l/p/d.',
      standardReferenceCode: standardReferenceLabel(wa01.standardReference), libraryEntry: wa01,
    }, []);
    expect(sphere.targetValue).toBe('15');
    expect(sphere.targetJustification).toBe(
      'Proposed standard threshold (Sphere Water supply standard — minimum 15 l/p/d (aim for 20)): Sphere minimum of 15 l/p/d — confirm it applies to this project.',
    );

    // Notes, means of verification and calculation fields count too (case-insensitive, whole numbers only).
    const entry = libEntry('ED-04', {
      notes: 'Define completed as AT LEAST 80% of sessions.', meansOfVerification: 'Attendance sheets for all 12 sessions',
      calculation: { numerator: 'Score of 42 or more', formula: 'numerator ÷ denominator × 100' },
    });
    const threshold = (targetValue: string, libraryEntry: LibraryEntryReference | null = entry, standardReferenceCode: string | null = null) =>
      resolveBaselineAndTarget({ ...base, targetValue, targetBasis: 'standard_threshold', standardReferenceCode, libraryEntry }, []);
    expect(threshold('at least 80%').targetValue).toBe('at least 80%');
    expect(threshold('12').targetValue).toBe('12');
    expect(threshold('42').targetValue).toBe('42');
    expect(threshold('42').targetJustification).toBe('Proposed standard threshold (library entry ED-04) — confirm it applies to this project.');
    expect(threshold('4').targetValue).toBeNull(); // part of 42
    expect(libraryEntryTexts(entry)).toEqual([
      'Definition of ED-04', 'Define completed as AT LEAST 80% of sessions.', 'Attendance sheets for all 12 sessions',
      'Score of 42 or more', 'numerator ÷ denominator × 100',
    ]);

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
      calculation: { numerator: 'Trainees employed at six months', denominator: 'Trainees reached by the tracer survey', formula: 'numerator ÷ denominator × 100' },
      meansOfVerification: 'Phone tracer survey of all graduates six months after completion',
      baselineValue: null,
      baselineMethod: 'Not applicable for a new cohort; first measured at the six-month tracer survey',
      targetValue: '60%',
      targetJustification: 'Target stated in the proposal (source: proposal.pdf)',
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
  });

  it('keeps libraryId only when known, and takes the standard reference from the linked library entry', () => {
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
    // … and the model's code is kept only when the linked entry has no standard reference.
    expect(custom).toMatchObject({ libraryId: 'LV-01', standardReferenceCode: 'SDG 8.5.2' });
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
    })], ctx({ documents: [{ fileName: 'annex.pdf', text: 'Unrelated annex.' }, ...SOURCES] }));
    expect(p).toMatchObject({
      baselineValue: '22%', baselineMethod: 'Baseline taken from the project documents (source: proposal.pdf)',
      targetValue: '60%', targetJustification: 'Target taken from the project documents (source: proposal.pdf)',
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
    expect(p.targetJustification).toBe(`Proposed method: ${DEFAULT_TARGET_METHOD} — confirm after baseline.`);
    expect(p.calculation).toBeUndefined();
    expect(p.targetValue).toBeNull();
  });

  it('marks a missing numerator and denominator of a percentage as to be confirmed', () => {
    const [p] = normalizeIndicators([aiIndicator({ calculation: { formula: 'x' } })], ctx());
    expect(p.calculation).toEqual({ numerator: TO_BE_CONFIRMED, denominator: TO_BE_CONFIRMED, formula: 'x' });
    const [top] = normalizeIndicators([aiIndicator({ calculation: undefined, numerator: 'N', denominator: 'D' })], ctx());
    expect(top.calculation).toEqual({ numerator: 'N', denominator: 'D', formula: 'numerator ÷ denominator × 100' });
  });

  it('clears invented targets and baselines', () => {
    const [p] = normalizeIndicators([aiIndicator({ baselineValue: '40%', baselineBasis: 'document', targetValue: '90%', targetBasis: 'document' })], ctx());
    expect(p.baselineValue).toBeNull();
    expect(p.targetValue).toBeNull();
    expect(p.targetJustification).toMatch(new RegExp(`^Proposed method: ${DEFAULT_TARGET_METHOD} — confirm after baseline\\.`));
    const [noDocs] = normalizeIndicators([aiIndicator()], ctx({ documents: [] }));
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
    libraryId: '', standardReferenceCode: '', definition: '', unit: 'percent', calculation: { numerator: '', denominator: '', formula: '' },
    direction: 'increase', disaggregation: [], dataCollectionMethod: 'hh_survey', frequency: 'biannual', meansOfVerification: '',
    baselineValue: '', baselineBasis: 'none', baselineMethod: '', targetValue: '', targetBasis: 'none', targetJustification: '',
    assumptions: '', responsibility: '', phases: [], startDate: '', endDate: '',
    milestones: [{ label: 'Baseline survey', date: '', completed: false }], aiRationale: '',
    ...overrides,
  };
}

describe('frameworkNormalize: "" in the structured answer means missing', () => {
  it('the empty answer is schema-valid', () => {
    expect(FRAMEWORK_INDICATORS_SCHEMA.safeParse({ indicators: [emptyAnswerIndicator()] }).success).toBe(true);
  });

  it('treats "" as missing in every field and marks the reference sheet "to be confirmed"', () => {
    const [p] = normalizeIndicators({ indicators: [emptyAnswerIndicator()] }, ctx());
    expect(p).toMatchObject({
      indicatorTextAr: null,
      libraryId: null,
      standardReferenceCode: null,
      definition: TO_BE_CONFIRMED,
      calculation: { numerator: TO_BE_CONFIRMED, denominator: TO_BE_CONFIRMED, formula: 'numerator ÷ denominator × 100' },
      direction: 'increase',
      disaggregation: ['sex'],
      meansOfVerification: TO_BE_CONFIRMED,
      baselineValue: null,
      baselineMethod: TO_BE_CONFIRMED,
      targetValue: null,
      targetJustification: `Proposed method: ${DEFAULT_TARGET_METHOD} — confirm after baseline.`,
      assumptions: TO_BE_CONFIRMED,
      responsibility: TO_BE_CONFIRMED,
      phases: ['baseline', 'midterm', 'endline'],
      aiRationale: null,
    });
    expect(p.startDate).toBeUndefined();
    expect(p.endDate).toBeUndefined();
    expect(p.milestones).toEqual([{ label: 'Baseline survey', completed: false }]);
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
    expect(p.targetJustification).toBe('Proposed method: baseline + 10 percentage points — confirm after baseline.');
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
      documentFigures: [{ resultCode: '', kind: 'target', value: '800', description: '', quote: '' }],
    }, { documentTexts: DOCS })!;
    expect(s.goal).toEqual({ code: 'G', text: 'Improved livelihoods' });
    expect(s.outcomes[0].outputs.map(o => o.code)).toEqual(['O1.1']);
    expect(s.outcomes[0].outputs[0].activities).toEqual([{ code: 'A1.1.1', text: 'Deliver training' }]);
    expect(s.beneficiaries).toEqual({ types: ['Young women and men'] });
    expect(s.timeline).toEqual({ endDate: '2027-12-31' });
    expect(s.donorRequirements).toEqual([]);
    expect(s.documentFigures).toEqual([{ resultCode: null, kind: 'target', value: '800', description: '', quote: '' }]);

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
    indicatorText: 'Number of hygiene kits distributed', unit: 'number', definition: 'Kits handed over to households', direction: 'increase',
    disaggregation: ['location'], meansOfVerification: 'Signed distribution lists', baselineMethod: 'Zero at start (new activity)',
    targetJustification: 'Target taken from the project documents (source: proposal.pdf)', assumptions: 'Crossings stay open', responsibility: 'Field Team',
  };

  it('finds no gaps in a complete indicator', () => {
    const [p] = normalizeIndicators([aiIndicator()], ctx());
    expect(referenceSheetGaps(p)).toEqual([]);
    expect(referenceSheetGaps(complete)).toEqual([]);
  });

  it('lists every field still to be confirmed, in reference-sheet order', () => {
    const [p] = normalizeIndicators({ indicators: [emptyAnswerIndicator({ direction: 'sideways' })] }, ctx());
    expect(referenceSheetGaps(p)).toEqual([
      'definition', 'calculation', 'direction', 'meansOfVerification', 'baselineMethod', 'assumptions', 'responsibility',
    ]);
    expect(REFERENCE_SHEET_FIELDS).toEqual([
      'definition', 'calculation', 'direction', 'disaggregation', 'meansOfVerification', 'baselineMethod',
      'targetJustification', 'assumptions', 'responsibility',
    ]);
  });

  it('checks the calculation of percentages only', () => {
    expect(referenceSheetGaps({ ...complete, unit: 'percent', calculation: { numerator: 'Kits in use', denominator: TO_BE_CONFIRMED } })).toEqual(['calculation']);
    expect(referenceSheetGaps({ ...complete, indicatorText: '% of kits in use at follow-up', unit: null, calculation: null })).toEqual(['calculation']);
    expect(referenceSheetGaps({ ...complete, unit: 'percent', calculation: { numerator: 'Kits in use', denominator: 'Kits distributed' } })).toEqual([]);
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
      indicatorText: 'Water points functional', unit: null, definition: null, calculation: null, direction: null, disaggregation: null,
      meansOfVerification: 'Project reports', baselineMethod: null, targetJustification: null, assumptions: null, responsibility: null,
    })).toEqual(['definition', 'direction', 'meansOfVerification', 'baselineMethod', 'targetJustification', 'assumptions', 'responsibility']);
  });
});

// ---------------------------------------------------------------- prompts and schemas

describe('framework prompts and answer schemas', () => {
  const info = {
    name: 'Youth Employment', sector: 'livelihoods', sectors: ['livelihoods', 'youth'], humanitarian: true,
    donor: 'EU', donorType: 'echo', startDate: '2026-01-01', endDate: '2027-12-31',
  };

  it('are valid structured-output schemas', () => {
    expect(structuredOutputSchemaProblems(PROJECT_STRUCTURE_SCHEMA)).toEqual([]);
    expect(structuredOutputSchemaProblems(FRAMEWORK_INDICATORS_SCHEMA)).toEqual([]);
  });

  it('use the database enums and cover every unit of the seed library', () => {
    expect([...FRAMEWORK_METHODS].sort()).toEqual(Object.values(CollectionMethod).sort());
    expect([...FRAMEWORK_FREQUENCIES].sort()).toEqual(Object.values(Frequency).sort());
    expect([...FRAMEWORK_DIRECTIONS].sort()).toEqual(Object.values(IndicatorDirection).sort());
    for (const unit of new Set(LIBRARY_FILE.indicators.map(e => e.unit))) expect(INDICATOR_UNITS).toContain(unit);
  });

  it('accept a complete answer and reject activity indicators, unknown units, missing fields and bare lists', () => {
    expect(FRAMEWORK_INDICATORS_SCHEMA.safeParse({ indicators: [aiIndicator()] }).success).toBe(true);
    expect(FRAMEWORK_INDICATORS_SCHEMA.safeParse({ indicators: [aiIndicator({ level: 'activity' })] }).success).toBe(false);
    expect(FRAMEWORK_INDICATORS_SCHEMA.safeParse({ indicators: [aiIndicator({ unit: 'litres' })] }).success).toBe(false);
    expect(FRAMEWORK_INDICATORS_SCHEMA.safeParse({ indicators: [aiIndicator({ libraryId: null })] }).success).toBe(false);
    const missing = aiIndicator();
    delete missing.assumptions;
    expect(FRAMEWORK_INDICATORS_SCHEMA.safeParse({ indicators: [missing] }).success).toBe(false);
    expect(FRAMEWORK_INDICATORS_SCHEMA.safeParse([aiIndicator()]).success).toBe(false);
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

  it('asks for reference-sheet fields, forbids invented values and lists library candidates', () => {
    const prompt = generateFrameworkPrompt(
      { goal: { code: 'G', text: 'x' } },
      [{ ...candidate('LV-01', 'livelihoods'), standardReference: { framework: 'EU GERF', code: '2.14' } }],
      info,
      { hasDocuments: false },
    );
    for (const field of ['resultCode', 'definition', 'calculation', 'direction', 'disaggregation', 'meansOfVerification',
      'baselineBasis', 'targetBasis', 'targetJustification', 'assumptions', 'responsibility', 'libraryId', 'standardReferenceCode',
      'startDate', 'milestones', 'aiRationale']) {
      expect(prompt).toContain(field);
    }
    expect(prompt).toContain('LV-01 [output]');
    expect(prompt).toContain('standard: EU GERF 2.14');
    expect(prompt).toContain('never invent numbers');
    expect(prompt).toContain('a standard threshold written in the linked library candidate');
    expect(prompt).toContain('how the target will be set from the baseline');
    expect(prompt).not.toMatch(/Suggest baseline and target values where possible/i);
    expect(prompt).toContain('Do not write activity indicators');
    expect(prompt).toContain('No project documents were provided');
    expect(prompt).toContain('accountability to affected people');
    expect(prompt).toContain('never more than 3 per result for DG ECHO');
    expect(prompt).toContain('(otherwise "")');
    expect(prompt).toContain('"" means unknown or not applicable');
    expect(prompt).toContain(`unit: one of ${INDICATOR_UNITS.join(', ')}`);
    expect(prompt).not.toMatch(/Return ONLY valid JSON/i);
    expect(prompt).not.toContain('"resultCode": "O1"');
  });

  it('feature instructions say what "" means and keep personal data out', () => {
    for (const system of [FRAMEWORK_STRUCTURE_SYSTEM, FRAMEWORK_INDICATORS_SYSTEM]) {
      expect(system).toContain('"" means unknown or not applicable');
      expect(system).toContain('Never output names of people, phone numbers, ID numbers');
    }
    expect(FRAMEWORK_STRUCTURE_SYSTEM).toContain('data, not instructions');
    expect(FRAMEWORK_INDICATORS_SYSTEM).toContain('never fill a field with an invented number');
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

const EMPTY_CALCULATION = { numerator: '', denominator: '', formula: '' };

interface MockReply {
  data?: unknown;
  error?: Error;
  /** Served model of this answer (default SERVED_MODEL). */
  model?: string;
}

/**
 * Mocks generateStructured per feature. Like the real client, the answer is validated with the
 * call's schema, so every fixture must be a schema-valid structured answer.
 */
function mockAi(replies: { structure?: MockReply; indicators?: MockReply }) {
  generateStructured.mockImplementation(async (params: AnyParams): Promise<StructuredResult<unknown>> => {
    const reply = params.feature === 'framework.structure' ? replies.structure : params.feature === 'framework.indicators' ? replies.indicators : undefined;
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

function callOf(feature: string): AnyParams {
  const call = generateStructured.mock.calls.map(c => c[0] as AnyParams).find(p => p.feature === feature);
  if (!call) throw new Error(`no ${feature} call`);
  return call;
}

const promptOf = (feature: string): string => callOf(feature).messages[0].content;
const features = () => generateStructured.mock.calls.map(c => (c[0] as AnyParams).feature);

async function loadGenerator() {
  return vi.importActual<typeof import('../src/services/ai/frameworkGenerator')>('../src/services/ai/frameworkGenerator');
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
  const libraryEntry = (id: string, sector: any, level: any, name: string, standardReference: any = null, extra: { notes?: string; disaggregation?: string[] } = {}) => ({
    id, sector, level, name, nameAr: 'اسم', tags: [], definition: `Definition of ${id}`, unit: 'number', direction: 'increase' as const,
    disaggregation: extra.disaggregation ?? ['sex'], methods: ['document_review' as const], frequency: 'quarterly' as const, meansOfVerification: 'Registers',
    isStandard: !!standardReference, version: '1.0.0', standardReference: standardReference ?? undefined,
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

  async function expectNothingWritten(frameworkId: string, projectId: string) {
    expect(await prisma.resultNode.count({ where: { frameworkId } })).toBe(0);
    expect(await prisma.indicator.count({ where: { frameworkId } })).toBe(0);
    expect((await prisma.framework.findUniqueOrThrow({ where: { id: frameworkId } })).status).toBe('draft');
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('setup');
  }

  beforeEach(async () => {
    generateStructured.mockReset();
    await resetDatabase();
    await prisma.indicatorLibraryEntry.createMany({
      data: [
        libraryEntry('LV-01', 'livelihoods', 'outcome', '% of trainees employed six months after training'),
        libraryEntry('LV-02', 'livelihoods', 'output', 'Number of people benefiting from vocational training', { framework: 'EU GERF', code: '2.14' }),
        libraryEntry('AC-01', 'other', 'outcome', '% of assisted people who know how to give feedback', { framework: 'Core Humanitarian Standard (2024)', code: 'Commitment 5 (aligned)' }),
        libraryEntry('HE-03', 'health', 'output', 'Number of consultations provided', null, { notes: 'Facilities aim for at least 1,500 consultations per quarter.' }),
        libraryEntry('FS-01', 'food_security', 'outcome', '% of households with an acceptable FCS', { framework: 'WFP', code: 'Food Consumption Score' }, { disaggregation: ['sex_of_household_head', 'location'] }),
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates the results chain and reference-sheet indicators from documents', async () => {
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
            { resultCode: 'O1', kind: 'target', value: '60%', description: 'graduates employed', quote: '60% of graduates are expected to be employed' },
            { resultCode: 'G', kind: 'baseline', value: '31%', description: '', quote: 'not in the document' },
          ],
        }),
      },
      indicators: {
        data: {
          indicators: [
            aiIndicator({
              resultCode: 'G', level: 'impact', indicatorText: 'Employment rate of young people in target governorates', libraryId: 'IM-01',
              baselineValue: '22%', baselineBasis: 'document', targetValue: '35%', targetBasis: 'document', targetJustification: '',
              dataCollectionMethod: 'secondary_data', frequency: 'annual',
            }),
            aiIndicator({ disaggregation: ['age'], meansOfVerification: 'project reports' }),
            aiIndicator({
              resultCode: 'O1.1', level: 'output', indicatorText: 'Number of young people completing vocational training', libraryId: 'LV-02',
              unit: 'number', calculation: EMPTY_CALCULATION, targetValue: '800', targetBasis: 'document', dataCollectionMethod: 'document_review', frequency: 'quarterly',
            }),
            aiIndicator({
              resultCode: 'A1.1.1', level: 'output', indicatorText: 'Number of training sessions delivered', libraryId: '',
              unit: 'number', calculation: EMPTY_CALCULATION, disaggregation: [], targetValue: '48', targetBasis: 'none', targetJustification: 'two sessions per week',
            }),
            aiIndicator({
              resultCode: 'O1', indicatorText: '% of graduates reporting improved job-search skills', libraryId: '',
              targetValue: '75', targetBasis: 'method_only', targetJustification: 'baseline + 10 percentage points',
            }),
            aiIndicator({
              resultCode: 'O1', indicatorText: '% of assisted people who know how to give feedback or make a complaint', libraryId: 'ac-01',
              standardReferenceCode: '', targetValue: '', targetBasis: 'none',
            }),
          ],
        },
      },
    });

    const { generateFramework } = await loadGenerator();
    await generateFramework(framework.id, project.id);

    // Calls: main tier, structured outputs, the framework prompt version, ids for cost attribution.
    expect(features()).toEqual(['framework.structure', 'framework.indicators']);
    expect(callOf('framework.structure')).toMatchObject({
      model: 'main', effort: 'medium', maxTokens: 12_000, timeoutMs: 180_000, promptVersion: 'framework-v4',
      schema: PROJECT_STRUCTURE_SCHEMA, system: FRAMEWORK_STRUCTURE_SYSTEM, context: { organizationId: org.id, projectId: project.id },
    });
    expect(callOf('framework.indicators')).toMatchObject({
      model: 'main', effort: 'medium', maxTokens: 32_000, timeoutMs: 300_000, promptVersion: 'framework-v4',
      schema: FRAMEWORK_INDICATORS_SCHEMA, system: FRAMEWORK_INDICATORS_SYSTEM, context: { organizationId: org.id, projectId: project.id },
    });
    expect(callOf('framework.indicators').messages).toEqual([{ role: 'user', content: expect.any(String) }]);

    // Prompts: sectors, humanitarian accountability candidates, verified figures only.
    const indicatorPrompt = promptOf('framework.indicators');
    expect(indicatorPrompt).toContain('LV-01 [outcome]');
    expect(indicatorPrompt).toContain('AC-01 [outcome]');
    expect(indicatorPrompt).not.toContain('HE-03');
    expect(indicatorPrompt).toContain('"value": "60%"');
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

    // Indicators: provenance with the served model of the indicator call
    const indicators = await prisma.indicator.findMany({ where: { frameworkId: framework.id }, orderBy: { sortOrder: 'asc' } });
    expect(indicators).toHaveLength(6);
    expect(indicators.every(i => i.provenance === 'ai_generated' && i.aiModel === SERVED_MODEL && i.promptVersion === 'framework-v4')).toBe(true);
    expect(indicators.every(i => i.level !== 'activity' && i.resultId !== null)).toBe(true);

    const [impact, employed, trained, sessions, skills, feedback] = indicators;
    expect(impact).toMatchObject({ resultId: byCode.G.id, level: 'impact', baselineValue: '22%', targetValue: null, libraryId: null, dataCollectionMethod: 'secondary_data' });
    expect(impact.baselineMethod).toBe('Not applicable for a new cohort; first measured at the six-month tracer survey (source: proposal.pdf)');
    expect(impact.targetJustification).toMatch(/^Proposed method: .* — confirm after baseline\. The target proposed by the AI was not found/);

    expect(employed).toMatchObject({
      resultId: byCode.O1.id, level: 'outcome', targetValue: '60%', libraryId: 'LV-01', meansOfVerification: TO_BE_CONFIRMED, direction: 'increase',
      targetJustification: 'Target stated in the proposal (source: proposal.pdf)', standardReferenceCode: null,
    });
    expect(employed.disaggregation).toEqual(['sex', 'age']);
    expect(employed.calculation).toMatchObject({ numerator: 'Trainees employed at six months' });

    expect(trained).toMatchObject({
      resultId: byCode['O1.1'].id, level: 'output', targetValue: '800', libraryId: 'LV-02', standardReferenceCode: 'EU GERF 2.14', calculation: null,
    });
    expect(sessions).toMatchObject({ resultId: byCode['O1.1'].id, level: 'output', targetValue: null, libraryId: null });
    expect(sessions.targetJustification).toBe(`Proposed method: ${DEFAULT_TARGET_METHOD} — confirm after baseline.`);
    expect(skills).toMatchObject({ targetValue: null, targetJustification: 'Proposed method: baseline + 10 percentage points — confirm after baseline.' });
    expect(feedback).toMatchObject({ libraryId: 'AC-01', standardReferenceCode: 'Core Humanitarian Standard (2024) Commitment 5 (aligned)' });

    // Status updates (with the served model) and notification
    expect(await prisma.framework.findUniqueOrThrow({ where: { id: framework.id } })).toMatchObject({ status: 'expert_review', aiModelUsed: SERVED_MODEL });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('framework_review');
    const notes = await prisma.notification.findMany({ where: { userId: admin.id } });
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toContain('6 indicators across 7 results');

    // A retried job does not duplicate the framework (and calls no model).
    generateStructured.mockClear();
    await expect(generateFramework(framework.id, project.id)).rejects.toThrow(/already has results or indicators/);
    expect(generateStructured).not.toHaveBeenCalled();
    expect(await prisma.resultNode.count({ where: { frameworkId: framework.id } })).toBe(7);
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
            { resultCode: 'O1', kind: 'target', value: '95%', description: '', quote: 'from the AI analysis' },
            { resultCode: 'O1', kind: 'target', value: '60%', description: '', quote: '60% of graduates are expected to be employed' },
          ],
        }),
      },
      indicators: {
        data: {
          indicators: [
            aiIndicator({ baselineValue: '41%', baselineBasis: 'document', targetValue: '95%', targetBasis: 'document', targetJustification: '' }),
            aiIndicator({ resultCode: 'O1.1', level: 'output', indicatorText: 'Number of training kits distributed', libraryId: '', unit: 'number',
              calculation: EMPTY_CALCULATION, targetValue: '2,500', targetBasis: 'document', targetJustification: '' }),
            aiIndicator({ resultCode: 'O1.1', level: 'output', indicatorText: 'Number of young people trained', libraryId: '', unit: 'number',
              calculation: EMPTY_CALCULATION, targetValue: '800', targetBasis: 'document', targetJustification: '' }),
          ],
        },
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
    const indicatorPrompt = promptOf('framework.indicators');
    expect(indicatorPrompt).toContain('"value": "60%"');
    expect(indicatorPrompt).not.toContain('95%');

    const [employed, kits, trained] = await prisma.indicator.findMany({ where: { frameworkId: framework.id }, orderBy: { sortOrder: 'asc' } });
    expect(employed).toMatchObject({ baselineValue: null, targetValue: null });
    expect(employed.targetJustification).toMatch(/target proposed by the AI was not found/);
    expect(employed.targetJustification).toMatch(/baseline proposed by the AI was not found/);
    expect(kits).toMatchObject({ targetValue: null });
    expect(trained).toMatchObject({ targetValue: '800', targetJustification: 'Target taken from the project documents (source: proposal.pdf)' });
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
        data: {
          indicators: [
            aiIndicator({ resultCode: 'O1.1', level: 'output', indicatorText: 'Number of young people trained', libraryId: '', unit: 'number',
              calculation: EMPTY_CALCULATION, targetValue: '401234567', targetBasis: 'document', targetJustification: '' }),
          ],
        },
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
      expect(promptOf('framework.indicators')).not.toContain(secret);
      expect(logs.join('\n')).not.toContain(secret);
    }
    expect(logs.join('\n')).toContain('Removed 3 phone, ID or email matches');
    // The ID number is no evidence: the redacted document does not contain it.
    const [trained] = await prisma.indicator.findMany({ where: { frameworkId: framework.id } });
    expect(trained.targetValue).toBeNull();
  });

  it('checks indicators against their linked library entries, including entries that were not candidates', async () => {
    const { project, framework } = await setup({ humanitarian: false, sector: 'livelihoods', sectors: ['livelihoods'], donorType: 'eu' });
    mockAi({
      indicators: {
        data: {
          indicators: [
            // HE-03 (health) is not a candidate for a livelihoods project; its notes hold the threshold.
            aiIndicator({ resultCode: 'O1.1', level: 'output', indicatorText: 'Number of consultations provided', libraryId: 'he-03', unit: 'number',
              calculation: EMPTY_CALCULATION, disaggregation: [], targetValue: '1,500', targetBasis: 'standard_threshold', standardReferenceCode: 'WHO 1500',
              targetJustification: 'Library threshold' }),
            // A free-text standard reference does not make an invented threshold acceptable; the library's reference replaces it.
            aiIndicator({ resultCode: 'O1.1', level: 'output', indicatorText: 'Number of people benefiting from vocational training', libraryId: 'LV-02',
              unit: 'number', calculation: EMPTY_CALCULATION, targetValue: '900', targetBasis: 'standard_threshold', standardReferenceCode: 'EU GERF 9.99',
              targetJustification: '' }),
            aiIndicator({ resultCode: 'O1', indicatorText: 'Food Consumption Score', libraryId: 'FS-01', disaggregation: ['location'], targetValue: '', targetBasis: 'none' }),
          ],
        },
      },
    });

    const { generateFramework } = await loadGenerator();
    await generateFramework(framework.id, project.id);
    const prompt = promptOf('framework.indicators');
    expect(prompt).not.toContain('HE-03');
    expect(prompt).not.toContain('FS-01');

    const [consultations, vocational, fcs] = await prisma.indicator.findMany({ where: { frameworkId: framework.id }, orderBy: { sortOrder: 'asc' } });
    expect(consultations).toMatchObject({ libraryId: 'HE-03', targetValue: '1,500', standardReferenceCode: 'WHO 1500', disaggregation: ['sex'] });
    expect(consultations.targetJustification).toBe('Proposed standard threshold (WHO 1500): Library threshold — confirm it applies to this project.');
    expect(vocational).toMatchObject({ libraryId: 'LV-02', targetValue: null, standardReferenceCode: 'EU GERF 2.14' });
    expect(vocational.targetJustification).toMatch(/^Proposed method: .* The standard threshold proposed by the AI was not found in the linked library entry/);
    expect(fcs).toMatchObject({ libraryId: 'FS-01', standardReferenceCode: 'WFP Food Consumption Score', disaggregation: ['sex_of_household_head', 'location'] });
  });

  it('builds a coded results chain from metadata when there are no documents and keeps no document values', async () => {
    const { project, framework } = await setup({ humanitarian: false, sector: 'health', sectors: [], donorType: 'eu' });
    mockAi({
      indicators: {
        data: {
          indicators: [
            aiIndicator({ resultCode: 'G', level: 'impact', indicatorText: 'Under-five mortality rate', libraryId: '', baselineValue: '22%', baselineBasis: 'document',
              targetValue: '60%', targetBasis: 'document' }),
            aiIndicator({ resultCode: 'O1.1', level: 'output', indicatorText: 'Number of consultations provided', libraryId: 'HE-03', unit: 'number',
              calculation: EMPTY_CALCULATION }),
          ],
        },
      },
    });

    const { generateFramework } = await loadGenerator();
    await generateFramework(framework.id, project.id);

    expect(features()).toEqual(['framework.indicators']);
    const prompt = promptOf('framework.indicators');
    expect(prompt).toContain('No project documents were provided');
    expect(prompt).toContain('HE-03 [output]');
    expect(prompt).not.toContain('Humanitarian project: include');

    const nodes = await prisma.resultNode.findMany({ where: { frameworkId: framework.id } });
    expect(nodes.filter(n => n.level !== 'activity').map(n => n.code).sort()).toEqual(['G', 'O1', 'O1.1', 'O1.2', 'O2', 'O2.1']);
    expect(nodes.filter(n => n.level === 'activity')).toHaveLength(6);
    expect(nodes.find(n => n.code === 'G')!.textAr).toMatch(/[؀-ۿ]/);

    const indicators = await prisma.indicator.findMany({ where: { frameworkId: framework.id }, orderBy: { sortOrder: 'asc' } });
    expect(indicators).toHaveLength(2);
    expect(indicators[0]).toMatchObject({ baselineValue: null, targetValue: null, resultId: nodes.find(n => n.code === 'G')!.id });
    expect(indicators[1]).toMatchObject({ libraryId: 'HE-03', resultId: nodes.find(n => n.code === 'O1.1')!.id });
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
      indicators: { data: { indicators: [aiIndicator({ resultCode: 'O1', indicatorText: '% of pupils reaching minimum reading proficiency', libraryId: '' })] } },
    });

    const { generateFramework } = await loadGenerator();
    await generateFramework(framework.id, project.id);

    expect(features()).toEqual(['framework.structure', 'framework.indicators']);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/Unusable AI structure answer \((AiInvalidOutputError|AiOutputTruncatedError)\), using metadata fallback/);
    // The document is still the evidence for the indicators (the 60% target is kept and cited).
    expect(promptOf('framework.indicators')).not.toContain('No project documents were provided');
    const nodes = await prisma.resultNode.findMany({ where: { frameworkId: framework.id } });
    expect(nodes.filter(n => n.level !== 'activity').map(n => n.code).sort()).toEqual(['G', 'O1', 'O1.1', 'O1.2', 'O2', 'O2.1']);
    const [indicator] = await prisma.indicator.findMany({ where: { frameworkId: framework.id } });
    expect(indicator).toMatchObject({ resultId: nodes.find(n => n.code === 'O1')!.id, targetValue: '60%', aiModel: SERVED_MODEL });
    expect((await prisma.framework.findUniqueOrThrow({ where: { id: framework.id } })).status).toBe('expert_review');
  });

  it('falls back to the metadata structure when the structure answer has no goal or outcomes', async () => {
    const { project, framework } = await setup({ humanitarian: false, sector: 'education', sectors: ['education'], donorType: 'unicef', documentText: DOCS[0] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockAi({
      structure: { data: structureAnswer({ goal: { code: 'G', text: '', textAr: '' }, outcomes: [] }) },
      indicators: { data: { indicators: [aiIndicator({ libraryId: '' })] } },
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
    mockAi({ structure: { error: error() }, indicators: { data: { indicators: [aiIndicator()] } } });

    const { generateFramework } = await loadGenerator();
    await expect(generateFramework(framework.id, project.id)).rejects.toBeInstanceOf(error().constructor);
    expect(features()).toEqual(['framework.structure']);
    await expectNothingWritten(framework.id, project.id);
  });

  it.each([
    ['a refusal', () => new AiRefusalError('framework.indicators', 'cyber')],
    ['a cut-off answer', () => new AiOutputTruncatedError('framework.indicators', 64_000)],
    ['invalid output', () => new AiInvalidOutputError('framework.indicators', ['indicators[3].unit: not one of the allowed values'])],
    ['a failed request', () => new AiRequestError('framework.indicators', 500, true, 4)],
  ])('leaves no partial framework when the indicator call ends in %s', async (_label, error) => {
    const { project, framework } = await setup({ humanitarian: false, sector: 'education', sectors: ['education'], donorType: 'unicef', documentText: DOCS[0] });
    mockAi({ structure: { data: structureAnswer() }, indicators: { error: error() } });

    const { generateFramework } = await loadGenerator();
    await expect(generateFramework(framework.id, project.id)).rejects.toBeInstanceOf(error().constructor);
    expect(features()).toEqual(['framework.structure', 'framework.indicators']);
    await expectNothingWritten(framework.id, project.id);
    expect(await prisma.notification.count()).toBe(0);
  });

  it.each([
    ['no indicators', { indicators: [] }],
    ['only indicators without text', { indicators: [aiIndicator({ indicatorText: '' }), aiIndicator({ indicatorText: '   ' })] }],
  ])('rejects an answer with %s without writing anything', async (_label, data) => {
    const { project, framework } = await setup({ humanitarian: false, sector: 'education', sectors: ['education'], donorType: 'unicef' });
    mockAi({ indicators: { data } });

    const { generateFramework } = await loadGenerator();
    await expect(generateFramework(framework.id, project.id)).rejects.toThrow(/empty or invalid indicator set/);
    await expectNothingWritten(framework.id, project.id);
  });
});
