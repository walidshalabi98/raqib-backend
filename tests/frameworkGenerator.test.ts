import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TARGET_METHOD,
  LibraryCandidate,
  NormalizeIndicatorsContext,
  TO_BE_CONFIRMED,
  appearsInDocuments,
  buildStructureFromMetadata,
  ensureSexDisaggregation,
  extractIndicatorList,
  isGenericMeansOfVerification,
  isPeopleLevelIndicator,
  librarySectorsFor,
  normalizeDirection,
  normalizeDisaggregation,
  normalizeFrequency,
  normalizeIndicatorLevel,
  normalizeIndicators,
  normalizeMethod,
  normalizeProjectStructure,
  planResultNodes,
  projectSectors,
  resolveBaselineAndTarget,
  resolveResult,
  selectLibraryCandidates,
  standardReferenceLabel,
  structureForPrompt,
} from '../src/services/ai/frameworkNormalize';
import { FRAMEWORK_PROMPT_VERSION, extractProjectStructurePrompt, generateFrameworkPrompt } from '../src/services/ai/prompts';
import { prisma } from '../src/config/prisma';
import { hasTestDatabase, resetDatabase } from './helpers';

// tests/setup.ts mocks the generator for every other test file; this file tests the real one
// with the Anthropic SDK mocked, so no model is ever called.
vi.unmock('../src/services/ai/frameworkGenerator');

const { createMessage } = vi.hoisted(() => ({ createMessage: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = { create: createMessage };
  },
}));

const MODEL = 'claude-sonnet-4-20250514';

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

function ctx(overrides: Partial<NormalizeIndicatorsContext> = {}): NormalizeIndicatorsContext {
  return {
    frameworkId: 'fw-1',
    resultNodes: NODES,
    knownLibraryIds: new Set(['LV-01', 'LV-02', 'AC-01']),
    libraryStandardCodes: new Map([['LV-02', 'EU GERF 2.14']]),
    documentTexts: DOCS,
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
    standardReferenceCode: null,
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

  it('keeps document values that appear in a document', () => {
    const r = resolveBaselineAndTarget({ ...base, baselineValue: '22%', baselineBasis: 'document', targetValue: '60%', targetBasis: 'document' }, DOCS);
    expect(r.baselineValue).toBe('22%');
    expect(r.targetValue).toBe('60%');
    expect(r.targetJustification).toBe('Target taken from the project documents.');
  });

  it('clears document values not found in any document and notes it in the justification', () => {
    const r = resolveBaselineAndTarget({
      ...base, baselineValue: '30%', baselineBasis: 'document', targetValue: '75%', targetBasis: 'document',
      targetJustification: 'baseline + 15 percentage points',
    }, DOCS);
    expect(r.baselineValue).toBeNull();
    expect(r.targetValue).toBeNull();
    expect(r.targetJustification).toMatch(/^Proposed method: baseline \+ 15 percentage points — confirm after baseline\./);
    expect(r.targetJustification).toMatch(/target proposed by the AI was not found/);
    expect(r.targetJustification).toMatch(/baseline proposed by the AI was not found.*pending baseline/);
    expect(r.targetJustification).not.toContain('75');
  });

  it('clears target values with basis none or method_only and keeps the method', () => {
    const none = resolveBaselineAndTarget({ ...base, targetValue: '500', targetBasis: 'none' }, DOCS);
    expect(none.targetValue).toBeNull();
    expect(none.targetJustification).toBe(`Proposed method: ${DEFAULT_TARGET_METHOD} — confirm after baseline.`);

    const method = resolveBaselineAndTarget({ ...base, targetValue: 'baseline + 10 percentage points', targetBasis: 'method_only' }, DOCS);
    expect(method.targetValue).toBeNull();
    expect(method.targetJustification).toBe('Proposed method: baseline + 10 percentage points — confirm after baseline.');

    const prefixed = resolveBaselineAndTarget({
      ...base, targetValue: '80%', targetBasis: 'METHOD_ONLY', targetJustification: 'Proposed method: match the national rate — confirm after baseline.',
    }, DOCS);
    expect(prefixed.targetValue).toBeNull();
    expect(prefixed.targetJustification).toBe('Proposed method: match the national rate — confirm after baseline.');
  });

  it('never keeps a baseline without a document basis, even when the value appears in a document', () => {
    expect(resolveBaselineAndTarget({ ...base, baselineValue: '22%', baselineBasis: 'none' }, DOCS).baselineValue).toBeNull();
    expect(resolveBaselineAndTarget({ ...base, baselineValue: '22%', baselineBasis: 'estimate' }, DOCS).baselineValue).toBeNull();
  });

  it('keeps a standard threshold only with a standard reference', () => {
    const sphere = resolveBaselineAndTarget({
      ...base, targetValue: '15', targetBasis: 'standard_threshold', targetJustification: 'Sphere minimum of 15 l/p/d.',
      standardReferenceCode: 'Sphere Water supply standard',
    }, []);
    expect(sphere.targetValue).toBe('15');
    expect(sphere.targetJustification).toBe('Proposed standard threshold (Sphere Water supply standard): Sphere minimum of 15 l/p/d — confirm it applies to this project.');

    const unreferenced = resolveBaselineAndTarget({ ...base, targetValue: '95%', targetBasis: 'standard_threshold' }, []);
    expect(unreferenced.targetValue).toBeNull();
    expect(unreferenced.targetJustification).toMatch(/^Proposed method:/);
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
      targetValue: '60%',
      targetJustification: 'Target stated in the proposal.',
      libraryId: 'LV-01',
      standardReferenceCode: null,
      assumptions: 'Labour market conditions do not deteriorate sharply.',
      responsibility: 'M&E Officer',
      phases: ['midterm', 'endline'],
      aiRationale: 'Measures the employment outcome of the training.',
      sortOrder: 0,
      provenance: 'ai_generated',
      aiModel: MODEL,
      promptVersion: 'framework-v2',
    });
    expect(p.startDate).toEqual(new Date('2026-07-01T00:00:00.000Z'));
    expect(p.milestones).toEqual([{ label: 'First tracer survey', date: '2026-12-15', completed: false }]);
  });

  it('keeps libraryId only when known, and fills the standard reference from the library', () => {
    const [unknown, known, lower] = normalizeIndicators([
      aiIndicator({ libraryId: 'IM-99', indicatorText: 'A' }),
      aiIndicator({ libraryId: 'LV-02', indicatorText: 'B' }),
      aiIndicator({ libraryId: 'ac-01', indicatorText: 'C', standardReferenceCode: 'CHS Commitment 5' }),
    ], ctx());
    expect(unknown.libraryId).toBeNull();
    expect(known.libraryId).toBe('LV-02');
    expect(known.standardReferenceCode).toBe('EU GERF 2.14');
    expect(lower.libraryId).toBe('AC-01');
    expect(lower.standardReferenceCode).toBe('CHS Commitment 5');
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
    })], ctx());
    expect(p.disaggregation).toEqual(['sex', 'location']);
    expect(p.definition).toBe(TO_BE_CONFIRMED);
    expect(p.meansOfVerification).toBe(TO_BE_CONFIRMED);
    expect(p.baselineMethod).toBe(TO_BE_CONFIRMED);
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
    expect(p.targetJustification).toMatch(/^Proposed method: Target stated in the proposal — confirm after baseline\./);
    const [noDocs] = normalizeIndicators([aiIndicator()], ctx({ documentTexts: [] }));
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

// ---------------------------------------------------------------- prompts

describe('framework prompts', () => {
  const info = {
    name: 'Youth Employment', sector: 'livelihoods', sectors: ['livelihoods', 'youth'], humanitarian: true,
    donor: 'EU', donorType: 'echo', startDate: '2026-01-01', endDate: '2027-12-31',
  };

  it('asks for a coded results chain with Arabic text and document figures', () => {
    const prompt = extractProjectStructurePrompt(['Document text'], info);
    expect(prompt).toContain('"code": "G"');
    expect(prompt).toContain('"O1.1"');
    expect(prompt).toContain('documentFigures');
    expect(prompt).toContain('Humanitarian project: yes');
    expect(prompt).toContain('All sectors: livelihoods, youth');
    expect(prompt).toContain('DG ECHO');
  });

  it('asks for reference-sheet fields, forbids invented values and lists library candidates', () => {
    const prompt = generateFrameworkPrompt(
      { goal: { code: 'G', text: 'x' } },
      [{ ...candidate('LV-01', 'livelihoods'), standardReference: { framework: 'EU GERF', code: '2.14' } }],
      info,
      { hasDocuments: false },
    );
    for (const field of ['resultCode', 'definition', 'calculation', 'direction', 'disaggregation', 'meansOfVerification',
      'baselineBasis', 'targetBasis', 'targetJustification', 'assumptions', 'libraryId', 'standardReferenceCode']) {
      expect(prompt).toContain(`"${field}"`);
    }
    expect(prompt).toContain('LV-01 [output]');
    expect(prompt).toContain('standard: EU GERF 2.14');
    expect(prompt).toContain('never invent numbers');
    expect(prompt).not.toMatch(/Suggest baseline and target values where possible/i);
    expect(prompt).toContain('Do not write activity indicators');
    expect(prompt).toContain('No project documents were provided');
    expect(prompt).toContain('accountability to affected people');
    expect(prompt).toContain('never more than 3 per result for DG ECHO');
  });
});

// ---------------------------------------------------------------- integration

function reply(json: unknown, stopReason = 'end_turn') {
  return { content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(json)}\n\`\`\`` }], stop_reason: stopReason };
}

async function loadGenerator() {
  return vi.importActual<typeof import('../src/services/ai/frameworkGenerator')>('../src/services/ai/frameworkGenerator');
}

describe.skipIf(!hasTestDatabase)('generateFramework (Anthropic SDK mocked)', () => {
  const libraryEntry = (id: string, sector: any, level: any, name: string, standardReference: any = null) => ({
    id, sector, level, name, nameAr: 'اسم', tags: [], definition: `Definition of ${id}`, unit: 'number', direction: 'increase' as const,
    disaggregation: ['sex'], methods: ['document_review' as const], frequency: 'quarterly' as const, meansOfVerification: 'Registers',
    isStandard: !!standardReference, version: '1.0.0', standardReference: standardReference ?? undefined,
    standardFramework: standardReference?.framework ?? null,
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

  beforeEach(async () => {
    createMessage.mockReset();
    await resetDatabase();
    await prisma.indicatorLibraryEntry.createMany({
      data: [
        libraryEntry('LV-01', 'livelihoods', 'outcome', '% of trainees employed six months after training'),
        libraryEntry('LV-02', 'livelihoods', 'output', 'Number of people benefiting from vocational training', { framework: 'EU GERF', code: '2.14' }),
        libraryEntry('AC-01', 'other', 'outcome', '% of assisted people who know how to give feedback', { framework: 'Core Humanitarian Standard (2024)', code: 'Commitment 5 (aligned)' }),
        libraryEntry('HE-03', 'health', 'output', 'Number of consultations provided'),
      ],
    });
  });

  it('creates the results chain and reference-sheet indicators from documents', async () => {
    const { admin, project, framework } = await setup({
      humanitarian: true, sector: 'livelihoods', sectors: ['livelihoods', 'youth'], donorType: 'echo', documentText: DOCS[0],
    });

    createMessage
      .mockResolvedValueOnce(reply({
        goal: { code: 'G', text: 'Improved economic participation of young people', textAr: 'تحسين المشاركة الاقتصادية للشباب' },
        outcomes: [{
          code: 'O1', text: 'Graduates secure decent work', textAr: 'حصول الخريجين على عمل لائق',
          outputs: [
            { code: 'O1.1', text: 'Youth complete vocational training', textAr: 'إتمام الشباب التدريب المهني', activities: ['Deliver training', 'Certify graduates'] },
            { code: 'O1.2', text: 'Graduates placed in internships', activities: ['Match graduates with employers'] },
          ],
        }],
        documentFigures: [
          { resultCode: 'O1', kind: 'target', value: '60%', quote: '60% of graduates are expected to be employed' },
          { resultCode: 'G', kind: 'baseline', value: '31%', quote: 'not in the document' },
        ],
      }))
      .mockResolvedValueOnce(reply([
        aiIndicator({
          resultCode: 'G', level: 'impact', indicatorText: 'Employment rate of young people in target governorates', libraryId: 'IM-01',
          baselineValue: '22%', baselineBasis: 'document', targetValue: '35%', targetBasis: 'document', targetJustification: '',
          dataCollectionMethod: 'secondary_data', frequency: 'annual',
        }),
        aiIndicator({ disaggregation: ['age'], meansOfVerification: 'project reports' }),
        aiIndicator({
          resultCode: 'O1.1', level: 'activity', indicatorText: 'Number of young people completing vocational training', libraryId: 'LV-02',
          unit: 'number', calculation: null, targetValue: '800', targetBasis: 'document', dataCollectionMethod: 'document_review', frequency: 'quarterly',
        }),
        aiIndicator({
          resultCode: 'A1.1.1', level: 'activity', indicatorText: 'Number of training sessions delivered', libraryId: null,
          unit: 'number', calculation: null, disaggregation: [], targetValue: '48', targetBasis: 'none', targetJustification: 'two sessions per week',
        }),
        aiIndicator({
          resultCode: 'O1', indicatorText: '% of graduates reporting improved job-search skills', libraryId: null,
          targetValue: '75', targetBasis: 'method_only', targetJustification: 'baseline + 10 percentage points',
        }),
        aiIndicator({
          resultCode: 'O1', indicatorText: '% of assisted people who know how to give feedback or make a complaint', libraryId: 'ac-01',
          standardReferenceCode: null, targetValue: '', targetBasis: 'none',
        }),
      ]));

    const { generateFramework, FRAMEWORK_MODEL } = await loadGenerator();
    await generateFramework(framework.id, project.id);

    // Prompts: model id, sectors, humanitarian accountability candidates, verified figures only.
    expect(createMessage).toHaveBeenCalledTimes(2);
    expect(createMessage.mock.calls[0][0].model).toBe(MODEL);
    expect(FRAMEWORK_MODEL).toBe(MODEL);
    const indicatorPrompt: string = createMessage.mock.calls[1][0].messages[0].content;
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

    // Indicators
    const indicators = await prisma.indicator.findMany({ where: { frameworkId: framework.id }, orderBy: { sortOrder: 'asc' } });
    expect(indicators).toHaveLength(6);
    expect(indicators.every(i => i.provenance === 'ai_generated' && i.aiModel === MODEL && i.promptVersion === 'framework-v2')).toBe(true);
    expect(indicators.every(i => i.level !== 'activity' && i.resultId !== null)).toBe(true);

    const [impact, employed, trained, sessions, skills, feedback] = indicators;
    expect(impact).toMatchObject({ resultId: byCode.G.id, level: 'impact', baselineValue: '22%', targetValue: null, libraryId: null, dataCollectionMethod: 'secondary_data' });
    expect(impact.targetJustification).toMatch(/^Proposed method: .* — confirm after baseline\. The target proposed by the AI was not found/);

    expect(employed).toMatchObject({
      resultId: byCode.O1.id, level: 'outcome', targetValue: '60%', libraryId: 'LV-01', meansOfVerification: TO_BE_CONFIRMED, direction: 'increase',
    });
    expect(employed.disaggregation).toEqual(['sex', 'age']);
    expect(employed.calculation).toMatchObject({ numerator: 'Trainees employed at six months' });

    expect(trained).toMatchObject({
      resultId: byCode['O1.1'].id, level: 'output', targetValue: '800', libraryId: 'LV-02', standardReferenceCode: 'EU GERF 2.14',
    });
    expect(sessions).toMatchObject({ resultId: byCode['O1.1'].id, level: 'output', targetValue: null });
    expect(sessions.targetJustification).toBe('Proposed method: two sessions per week — confirm after baseline.');
    expect(skills).toMatchObject({ targetValue: null, targetJustification: 'Proposed method: baseline + 10 percentage points — confirm after baseline.' });
    expect(feedback).toMatchObject({ libraryId: 'AC-01', standardReferenceCode: 'Core Humanitarian Standard (2024) Commitment 5 (aligned)' });

    // Status updates and notification
    expect((await prisma.framework.findUniqueOrThrow({ where: { id: framework.id } })).status).toBe('expert_review');
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('framework_review');
    const notes = await prisma.notification.findMany({ where: { userId: admin.id } });
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toContain('6 indicators across 7 results');

    // A retried job does not duplicate the framework.
    await expect(generateFramework(framework.id, project.id)).rejects.toThrow(/already has results or indicators/);
    expect(await prisma.resultNode.count({ where: { frameworkId: framework.id } })).toBe(7);
  });

  it('builds a coded results chain from metadata when there are no documents and keeps no document values', async () => {
    const { project, framework } = await setup({ humanitarian: false, sector: 'health', sectors: [], donorType: 'eu' });
    createMessage.mockResolvedValueOnce(reply([
      aiIndicator({ resultCode: 'G', level: 'impact', indicatorText: 'Under-five mortality rate', libraryId: null, baselineValue: '22%', baselineBasis: 'document', targetValue: '60%', targetBasis: 'document' }),
      aiIndicator({ resultCode: 'O1.1', level: 'output', indicatorText: 'Number of consultations provided', libraryId: 'HE-03', unit: 'number', calculation: null }),
    ]));

    const { generateFramework } = await loadGenerator();
    await generateFramework(framework.id, project.id);

    expect(createMessage).toHaveBeenCalledTimes(1);
    const prompt: string = createMessage.mock.calls[0][0].messages[0].content;
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

  it('leaves no partial framework when the indicator reply cannot be parsed', async () => {
    const { project, framework } = await setup({ humanitarian: false, sector: 'education', sectors: ['education'], donorType: 'unicef' });
    createMessage.mockResolvedValueOnce({ content: [{ type: 'text', text: '[{"indicatorText": "cut off' }], stop_reason: 'max_tokens' });

    const { generateFramework } = await loadGenerator();
    await expect(generateFramework(framework.id, project.id)).rejects.toThrow(/cut off at max_tokens/);
    expect(await prisma.resultNode.count({ where: { frameworkId: framework.id } })).toBe(0);
    expect(await prisma.indicator.count({ where: { frameworkId: framework.id } })).toBe(0);
    expect((await prisma.framework.findUniqueOrThrow({ where: { id: framework.id } })).status).toBe('draft');
  });

  it('rejects an empty indicator set without writing anything', async () => {
    const { project, framework } = await setup({ humanitarian: false, sector: 'education', sectors: ['education'], donorType: 'unicef' });
    createMessage.mockResolvedValueOnce(reply([{ indicatorText: '' }]));

    const { generateFramework } = await loadGenerator();
    await expect(generateFramework(framework.id, project.id)).rejects.toThrow(/empty or invalid indicator set/);
    expect(await prisma.resultNode.count({ where: { frameworkId: framework.id } })).toBe(0);
  });
});
