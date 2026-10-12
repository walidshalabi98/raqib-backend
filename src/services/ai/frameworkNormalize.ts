import { CollectionMethod, Frequency, IndicatorDirection, IndicatorLevel, Prisma, Sector } from '@prisma/client';
import { ECHO_INDICATOR_CAP } from './prompts/donors';
import { FRAMEWORK_PROMPT_VERSION } from './prompts/framework';
import { redactPersonalData } from './redact';

/**
 * Pure helpers for the AI framework generator (BUILD_GUIDE Phase 2 task 7).
 *
 * They turn the model's parsed JSON into a coded results chain and into
 * indicator create payloads, applying the deterministic rules from
 * knowledge/me-foundations.md (§2 quality checklist, §3 reference sheet,
 * §4 disaggregation, §6 baselines and targets). No database or network access,
 * so every rule is unit-tested (CLAUDE.md rule 7).
 */

export const TO_BE_CONFIRMED = 'To be confirmed by the M&E officer';

/** Used when the model gives no target-setting method. Never a number (me-foundations.md §6). */
export const DEFAULT_TARGET_METHOD = 'set after the baseline survey, using comparable programmes';

/** Appended to baselineMethod when the baseline date is unknown (me-foundations.md §3: baseline value, date and method). */
export const BASELINE_DATE_TO_BE_CONFIRMED = 'Baseline date: to be confirmed.';

/** Appended to targetJustification when no intermediate target is known (me-foundations.md §3: final and intermediate targets). */
export const INTERMEDIATE_TARGETS_TO_BE_CONFIRMED = 'Intermediate targets: to be confirmed after the baseline.';

/**
 * Marker after which the pre-Phase 3 document parser appended the model's own analysis to
 * Document.parsedText. New analyses are stored in Document.aiAnalysis (StoredDocumentAnalysis in
 * prompts/documentAnalysis.ts); the marker now appears only in legacy rows.
 */
export const AI_ANALYSIS_MARKER = '---AI_ANALYSIS---';

// Field limits match the indicator and result validation of the REST API.
const LIMITS = {
  code: 50,
  resultText: 2000,
  indicatorText: 1000,
  unit: 100,
  value: 200,
  definition: 5000,
  meansOfVerification: 2000,
  baselineMethod: 2000,
  targetJustification: 2000,
  assumptions: 5000,
  responsibility: 300,
  aiRationale: 5000,
  libraryId: 50,
  standardReferenceCode: 100,
  calculationPart: 1000,
  formula: 2000,
  disaggregationKey: 50,
  disaggregationKeys: 20,
  phase: 50,
  phases: 20,
  intermediateTargets: 20,
  milestoneLabel: 300,
  milestones: 100,
  structureList: 30,
  documentFigures: 40,
} as const;

// ------------------------------------------------------------------ basics

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Trimmed text for strings and finite numbers; '' for anything else. */
export function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max).trimEnd() : value;
}

/** First non-empty text among the given keys of an object. */
function pick(obj: Json, ...keys: string[]): string {
  for (const key of keys) {
    const value = text(obj[key]);
    if (value) return value;
  }
  return '';
}

function orNull(value: string): string | null {
  return value === '' ? null : value;
}

function textList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(text).filter(Boolean).slice(0, max);
}

/**
 * A shallow copy without unknown values: "" (the structured-output answer's "unknown"), null and
 * blank list items are dropped, and so are lists left empty. The prompt then shows known facts only.
 */
function compactObject(value: Json): Json {
  const out: Json = {};
  for (const [key, v] of Object.entries(value)) {
    if (Array.isArray(v)) {
      const items = v.filter(item => item !== null && item !== undefined && !(typeof item === 'string' && item.trim() === ''));
      if (items.length > 0) out[key] = items;
    } else if (v !== null && v !== undefined && !(typeof v === 'string' && v.trim() === '')) {
      out[key] = v;
    }
  }
  return out;
}

/** The compacted object, or null when nothing known is left. */
function compactOrNull(value: unknown): Json | null {
  if (!isObject(value)) return null;
  const compact = compactObject(value);
  return Object.keys(compact).length > 0 ? compact : null;
}

const enumKey = (value: string) => value.trim().toLowerCase().replace(/[\s\-/]+/g, '_');

/** Case-insensitive enum match with a few common synonyms; null when nothing matches. */
function matchEnum<T extends string>(value: unknown, allowed: readonly T[], synonyms: Record<string, T> = {}): T | null {
  const raw = text(value);
  if (!raw) return null;
  const key = enumKey(raw);
  const direct = allowed.find(a => a === key);
  return direct ?? synonyms[key] ?? null;
}

const LEVELS = Object.values(IndicatorLevel);
const METHODS = Object.values(CollectionMethod);
const FREQUENCIES = Object.values(Frequency);
const DIRECTIONS = Object.values(IndicatorDirection);

const METHOD_SYNONYMS: Record<string, CollectionMethod> = {
  household_survey: 'hh_survey',
  survey: 'hh_survey',
  hh: 'hh_survey',
  focus_group: 'fgd',
  focus_groups: 'fgd',
  focus_group_discussion: 'fgd',
  focus_group_discussions: 'fgd',
  key_informant_interview: 'kii',
  key_informant_interviews: 'kii',
  interviews: 'kii',
  direct_observation: 'observation',
  records: 'document_review',
  record_review: 'document_review',
  records_review: 'document_review',
  desk_review: 'document_review',
  administrative_records: 'document_review',
  registers: 'document_review',
  secondary: 'secondary_data',
  secondary_data_review: 'secondary_data',
  participatory_methods: 'participatory',
  participatory_method: 'participatory',
};

const FREQUENCY_SYNONYMS: Record<string, Frequency> = {
  semi_annual: 'biannual',
  semiannual: 'biannual',
  semi_annually: 'biannual',
  biannually: 'biannual',
  six_monthly: 'biannual',
  every_6_months: 'biannual',
  yearly: 'annual',
  annually: 'annual',
  quarter: 'quarterly',
  month: 'monthly',
  baseline_and_endline: 'baseline_endline',
  baseline_endline_survey: 'baseline_endline',
  per_cycle: 'per_cohort',
  per_round: 'per_cohort',
};

const DIRECTION_SYNONYMS: Record<string, IndicatorDirection> = {
  increasing: 'increase',
  higher: 'increase',
  up: 'increase',
  decreasing: 'decrease',
  reduce: 'decrease',
  reduction: 'decrease',
  lower: 'decrease',
  down: 'decrease',
  stable: 'maintain',
  maintained: 'maintain',
};

/** Rule of thumb from me-foundations.md §5: outputs → records, outcomes → surveys, impact → secondary data. */
const DEFAULT_METHOD: Record<IndicatorLevel, CollectionMethod> = {
  impact: 'secondary_data',
  outcome: 'hh_survey',
  output: 'document_review',
  activity: 'document_review',
};

const DEFAULT_FREQUENCY: Record<IndicatorLevel, Frequency> = {
  impact: 'annual',
  outcome: 'biannual',
  output: 'quarterly',
  activity: 'quarterly',
};

/** Indicator level: 'goal' means impact; activities are tracked as tasks, so 'activity' and unknown values become output. */
export function normalizeIndicatorLevel(value: unknown): Exclude<IndicatorLevel, 'activity'> {
  const level = matchEnum(value, LEVELS, { goal: 'impact' });
  return level && level !== 'activity' ? level : 'output';
}

export function normalizeMethod(value: unknown, level: IndicatorLevel): CollectionMethod {
  return matchEnum(value, METHODS, METHOD_SYNONYMS) ?? DEFAULT_METHOD[level];
}

export function normalizeFrequency(value: unknown, level: IndicatorLevel): Frequency {
  return matchEnum(value, FREQUENCIES, FREQUENCY_SYNONYMS) ?? DEFAULT_FREQUENCY[level];
}

export function normalizeDirection(value: unknown): IndicatorDirection | null {
  return matchEnum(value, DIRECTIONS, DIRECTION_SYNONYMS);
}

// ------------------------------------------------------- results structure

export interface ResultStatement {
  code: string;
  text: string;
  textAr?: string;
}

export interface StructureOutput extends ResultStatement {
  activities: ResultStatement[];
}

export interface StructureOutcome extends ResultStatement {
  outputs: StructureOutput[];
}

/** A baseline or target value quoted in an uploaded document. */
export interface DocumentFigure {
  resultCode: string | null;
  kind: 'baseline' | 'target';
  value: string;
  description: string;
  quote: string;
}

export interface ProjectStructure {
  goal: ResultStatement;
  outcomes: StructureOutcome[];
  beneficiaries?: Json;
  timeline?: Json;
  donorRequirements: string[];
  crossCuttingThemes: string[];
  documentFigures: DocumentFigure[];
}

/** Hands out unique result codes (case-insensitive, like the REST API's check). */
function codeRegistry() {
  const taken = new Set<string>();
  const key = (code: string) => code.toUpperCase();
  return (preferred: string, fallback: string): string => {
    const wanted = clip(preferred.replace(/\s+/g, ' ').trim(), LIMITS.code);
    if (wanted && !taken.has(key(wanted))) {
      taken.add(key(wanted));
      return wanted;
    }
    let candidate = fallback;
    for (let n = 2; taken.has(key(candidate)); n++) candidate = `${fallback}-${n}`;
    taken.add(key(candidate));
    return candidate;
  };
}

function statementParts(value: unknown): { code: string; text: string; textAr: string } {
  if (typeof value === 'string') return { code: '', text: value.trim(), textAr: '' };
  if (!isObject(value)) return { code: '', text: '', textAr: '' };
  return {
    code: text(value.code),
    text: pick(value, 'text', 'statement', 'description', 'title', 'name'),
    textAr: pick(value, 'textAr', 'text_ar', 'arabic'),
  };
}

function statement(parts: { text: string; textAr: string }, code: string): ResultStatement {
  const out: ResultStatement = { code, text: clip(parts.text, LIMITS.resultText) };
  if (parts.textAr) out.textAr = clip(parts.textAr, LIMITS.resultText);
  return out;
}

/**
 * Normalises the model's project structure into a coded results chain.
 * Accepts the structured-output answer (PROJECT_STRUCTURE_SCHEMA in prompts/framework.ts)
 * and the older uncoded format (goal as a string, outcomes/outputs/activities as text).
 * Codes the model gave are kept when unique; otherwise G, O1, O1.1 and A1.1.1
 * (activities) are assigned. "" means unknown: empty statements are dropped, and
 * beneficiaries and timeline keep only known values. Returns null when there is
 * neither a goal nor an outcome.
 *
 * When documentTexts are given, documentFigures that the documents do not support are
 * dropped (see verifyDocumentFigures: the quote must be found and must contain the value).
 */
export function normalizeProjectStructure(raw: unknown, options: { documentTexts?: readonly string[] } = {}): ProjectStructure | null {
  if (!isObject(raw)) return null;
  const claim = codeRegistry();

  const goalParts = statementParts(raw.goal ?? raw.impact);
  const rawOutcomes = (Array.isArray(raw.outcomes) ? raw.outcomes : [])
    .map(o => ({ o, parts: statementParts(o) }))
    .filter(({ parts }) => parts.text !== '')
    .slice(0, LIMITS.structureList);
  if (!goalParts.text && rawOutcomes.length === 0) return null;

  const goal = statement(
    goalParts.text ? goalParts : { text: 'Goal to be confirmed by the M&E officer', textAr: '' },
    claim(goalParts.code, 'G'),
  );

  const outcomes: StructureOutcome[] = rawOutcomes.map(({ o, parts }, i) => {
    const outcomeCode = claim(parts.code, `O${i + 1}`);
    const rawOutputs = (isObject(o) && Array.isArray(o.outputs) ? o.outputs : [])
      .map(out => ({ out, parts: statementParts(out) }))
      .filter(({ parts: p }) => p.text !== '')
      .slice(0, LIMITS.structureList);
    const outputs: StructureOutput[] = rawOutputs.map(({ out, parts: outputParts }, j) => {
      const outputCode = claim(outputParts.code, `O${i + 1}.${j + 1}`);
      const activities = (isObject(out) && Array.isArray(out.activities) ? out.activities : [])
        .map(statementParts)
        .filter(p => p.text !== '')
        .slice(0, LIMITS.structureList)
        .map((p, k) => statement(p, claim(p.code, `A${i + 1}.${j + 1}.${k + 1}`)));
      return { ...statement(outputParts, outputCode), activities };
    });
    return { ...statement(parts, outcomeCode), outputs };
  });

  const figures = (Array.isArray(raw.documentFigures) ? raw.documentFigures : [])
    .filter(isObject)
    .map((f): DocumentFigure | null => {
      const kind = matchEnum(f.kind, ['baseline', 'target'] as const);
      const value = clip(text(f.value), LIMITS.value);
      if (!kind || !value) return null;
      return {
        resultCode: orNull(text(f.resultCode)),
        kind,
        value,
        description: clip(text(f.description), 500),
        quote: clip(text(f.quote), 500),
      };
    })
    .filter((f): f is DocumentFigure => f !== null);
  const evidence = options.documentTexts ? normalisedDocuments(options.documentTexts.map((t, i) => ({ fileName: String(i + 1), text: t }))) : null;
  const documentFigures = figures
    .filter(f => evidence === null || figureSource(f, evidence) !== null)
    .slice(0, LIMITS.documentFigures);

  const beneficiaries = compactOrNull(raw.beneficiaries);
  const timeline = compactOrNull(raw.timeline);
  return {
    goal,
    outcomes,
    ...(beneficiaries && { beneficiaries }),
    ...(timeline && { timeline }),
    donorRequirements: textList(raw.donorRequirements, LIMITS.structureList),
    crossCuttingThemes: textList(raw.crossCuttingThemes, LIMITS.structureList),
    documentFigures,
  };
}

/** The structure as shown to the model in the indicator step: activities as plain text, no codes to attach indicators to. */
export function structureForPrompt(structure: ProjectStructure): Json {
  return {
    ...structure,
    outcomes: structure.outcomes.map(o => ({
      ...o,
      outputs: o.outputs.map(out => ({ ...out, activities: out.activities.map(a => a.text) })),
    })),
  };
}

export interface ResultNodePlan {
  code: string;
  level: IndicatorLevel;
  text: string;
  textAr: string | null;
  parentCode: string | null;
  sortOrder: number;
}

/**
 * The ResultNodes to create, parents before children: the goal (impact), each
 * outcome, its outputs and their activities (level 'activity'). sortOrder is the
 * position among siblings.
 */
export function planResultNodes(structure: ProjectStructure): ResultNodePlan[] {
  const node = (s: ResultStatement, level: IndicatorLevel, parentCode: string | null, sortOrder: number): ResultNodePlan => ({
    code: s.code, level, text: s.text, textAr: s.textAr ?? null, parentCode, sortOrder,
  });
  const plan: ResultNodePlan[] = [node(structure.goal, 'impact', null, 0)];
  structure.outcomes.forEach((outcome, i) => {
    plan.push(node(outcome, 'outcome', structure.goal.code, i));
    outcome.outputs.forEach((output, j) => {
      plan.push(node(output, 'output', outcome.code, j));
      output.activities.forEach((activity, k) => plan.push(node(activity, 'activity', output.code, k)));
    });
  });
  return plan;
}

// ---------------------------------------------------- metadata fallback

const SECTOR_GOALS: Record<Sector, { en: string; ar: string }> = {
  livelihoods: { en: 'Improved livelihood opportunities and economic resilience for vulnerable communities', ar: 'تحسين فرص كسب العيش وتعزيز الصمود الاقتصادي للمجتمعات الهشة' },
  education: { en: 'Enhanced quality of and access to education for marginalised populations', ar: 'تحسين جودة التعليم وإتاحته للفئات المهمشة' },
  health: { en: 'Improved health outcomes and access to healthcare services', ar: 'تحسين النتائج الصحية وإتاحة خدمات الرعاية الصحية' },
  wash: { en: 'Improved access to safe water, sanitation and hygiene practices', ar: 'تحسين الوصول إلى المياه الآمنة وخدمات الصرف الصحي وممارسات النظافة' },
  protection: { en: 'Enhanced protection of vulnerable populations and their rights', ar: 'تعزيز حماية الفئات الأكثر عرضة للخطر وصون حقوقها' },
  food_security: { en: 'Improved food security and nutrition for vulnerable households', ar: 'تحسين الأمن الغذائي والتغذية للأسر الهشة' },
  governance: { en: 'Strengthened governance, transparency and civic participation', ar: 'تعزيز الحوكمة والشفافية والمشاركة المدنية' },
  agriculture: { en: 'Enhanced agricultural productivity and sustainable farming practices', ar: 'تعزيز الإنتاجية الزراعية والممارسات الزراعية المستدامة' },
  gender: { en: 'Advanced gender equality and women\'s empowerment', ar: 'تعزيز المساواة بين الجنسين وتمكين النساء' },
  youth: { en: 'Improved opportunities and engagement for young people', ar: 'تحسين الفرص المتاحة للشباب وتعزيز مشاركتهم' },
  mhpss: { en: 'Improved mental health and psychosocial well-being of affected communities', ar: 'تحسين الصحة النفسية والرفاه النفسي الاجتماعي للمجتمعات المتأثرة' },
  cash: { en: 'Vulnerable households able to meet their basic needs in dignity', ar: 'تمكين الأسر الهشة من تلبية احتياجاتها الأساسية بكرامة' },
  shelter: { en: 'Improved access to safe and adequate shelter for affected households', ar: 'تحسين وصول الأسر المتضررة إلى مأوى آمن وملائم' },
  climate_energy: { en: 'Improved access to clean energy and resilience to climate change', ar: 'تحسين الوصول إلى الطاقة النظيفة وتعزيز القدرة على التكيف مع تغير المناخ' },
  other: { en: 'Improved well-being of target communities', ar: 'تحسين رفاه المجتمعات المستهدفة' },
};

const SECTOR_LABELS: Record<Sector, { en: string; ar: string }> = {
  livelihoods: { en: 'livelihoods', ar: 'سبل العيش' },
  education: { en: 'education', ar: 'التعليم' },
  health: { en: 'health', ar: 'الصحة' },
  wash: { en: 'water, sanitation and hygiene', ar: 'المياه والصرف الصحي والنظافة' },
  protection: { en: 'protection', ar: 'الحماية' },
  food_security: { en: 'food security', ar: 'الأمن الغذائي' },
  governance: { en: 'governance', ar: 'الحوكمة' },
  agriculture: { en: 'agriculture', ar: 'الزراعة' },
  gender: { en: 'gender equality', ar: 'المساواة بين الجنسين' },
  youth: { en: 'youth', ar: 'الشباب' },
  mhpss: { en: 'mental health and psychosocial support', ar: 'الصحة النفسية والدعم النفسي الاجتماعي' },
  cash: { en: 'cash assistance', ar: 'المساعدات النقدية' },
  shelter: { en: 'shelter', ar: 'المأوى' },
  climate_energy: { en: 'climate and energy', ar: 'المناخ والطاقة' },
  other: { en: 'the project sector', ar: 'قطاع المشروع' },
};

const DONOR_REQUIREMENTS: Record<string, string[]> = {
  eu: ['GERF Level 2 indicators first, then other OPSYS indicators', 'Sex disaggregation for people-count indicators', 'Results matrix alignment', 'Gender Action Plan III alignment'],
  echo: ['Compulsory Key Result Indicators per sub-sector', `${ECHO_INDICATOR_CAP.charAt(0).toUpperCase()}${ECHO_INDICATOR_CAP.slice(1)}`, 'Baseline compulsory (at the latest in the interim report)', 'Specific source and method of verification'],
  usaid: ['Legacy award: USAID-era indicator reference sheets may still apply', 'Gender analysis', 'Do No Harm assessment'],
  giz: ['Results-based monitoring', 'Capacity development tracking', 'Sustainability indicators'],
  undp: ['UNDP Strategic Plan and SDG alignment', 'Human development indicators'],
  unicef: ['UNICEF Strategic Plan and SDG alignment', 'Child rights-based, equity-focused indicators', 'HACT compliance'],
  wfp: ['WFP corporate results framework indicators (FCS, rCSI, LCS)', 'Sex and age disaggregation', 'Accountability to affected people'],
  unfpa: ['UNFPA Strategic Plan and SDG alignment', 'Sexual and reproductive health and GBV indicators'],
  fcdo: ['Logframe with milestones', 'Disability and sex disaggregation', 'Value for money'],
  un_women: ['UN Women Strategic Plan and SDG 5 alignment', 'Sex-disaggregated and gender-specific indicators'],
  sida: ['Results framework alignment', 'Human rights-based approach indicators', 'Conflict sensitivity analysis'],
  other: ['Standard logframe indicators', 'Sex-disaggregated data'],
};

export function donorRequirementsFor(donorType: string): string[] {
  return DONOR_REQUIREMENTS[donorType] ?? DONOR_REQUIREMENTS.other;
}

export interface ProjectMetadata {
  sector: Sector;
  sectors?: Sector[] | null;
  humanitarian?: boolean | null;
  donorType: string;
  description?: string | null;
  geographicScope?: string | null;
  targetBeneficiaries?: number | null;
  startDate?: Date | string | null;
  endDate?: Date | string | null;
}

function isoDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/** A coded results chain built from the project's metadata, used when there are no parsed documents. */
export function buildStructureFromMetadata(project: ProjectMetadata): ProjectStructure {
  const goal = SECTOR_GOALS[project.sector] ?? SECTOR_GOALS.other;
  const label = SECTOR_LABELS[project.sector] ?? SECTOR_LABELS.other;
  const area = project.geographicScope || 'Palestine';
  const raw = {
    goal: { code: 'G', text: goal.en, textAr: goal.ar },
    outcomes: [
      {
        code: 'O1',
        text: project.description || `Improved ${label.en} outcomes for target beneficiaries in ${area}`,
        ...(!project.description && { textAr: `تحسين نتائج ${label.ar} للمستفيدين المستهدفين` }),
        outputs: [
          { code: 'O1.1', text: 'Services delivered and capacity built', textAr: 'تقديم الخدمات وبناء القدرات', activities: ['Direct service provision', 'Training and workshops'] },
          { code: 'O1.2', text: 'Community engagement and awareness raised', textAr: 'إشراك المجتمع ورفع الوعي', activities: ['Community mobilisation', 'Awareness campaigns'] },
        ],
      },
      {
        code: 'O2',
        text: `Strengthened institutional and community capacity in ${label.en}`,
        textAr: `تعزيز القدرات المؤسسية والمجتمعية في مجال ${label.ar}`,
        outputs: [
          { code: 'O2.1', text: 'Partner institutions strengthened', textAr: 'تعزيز قدرات المؤسسات الشريكة', activities: ['Policy development support', 'Organisational capacity assessment'] },
        ],
      },
    ],
    beneficiaries: {
      total: project.targetBeneficiaries ?? null,
      types: ['Direct beneficiaries', 'Indirect beneficiaries', 'Community members'],
      disaggregation: ['sex', 'age', 'disability'],
    },
    timeline: {
      startDate: isoDate(project.startDate),
      endDate: isoDate(project.endDate),
      phases: ['Inception', 'Implementation', 'Monitoring', 'Evaluation'],
    },
    donorRequirements: donorRequirementsFor(project.donorType),
    crossCuttingThemes: [
      'gender', 'disability_inclusion', 'conflict_sensitivity', 'do_no_harm',
      ...(project.humanitarian ? ['accountability_to_affected_people'] : []),
    ],
  };
  return normalizeProjectStructure(raw) as ProjectStructure;
}

// --------------------------------------------------- library candidates

/** Library sectors to search for project sectors that have no library entries of their own yet. */
export const RELATED_LIBRARY_SECTORS: Partial<Record<Sector, Sector[]>> = {
  mhpss: ['protection'],
  cash: ['food_security'],
  shelter: ['protection'],
  climate_energy: ['agriculture'],
};

/** All sectors of a project, primary first, without duplicates (sectors may be empty on older rows). */
export function projectSectors(project: { sector: Sector; sectors?: Sector[] | null }): Sector[] {
  return Array.from(new Set([project.sector, ...(project.sectors ?? [])]));
}

/** Library sectors to load candidates from: the project's sectors, related sectors and 'other' (cross-cutting). */
export function librarySectorsFor(sectors: Sector[]): Sector[] {
  return Array.from(new Set<Sector>([...sectors, ...sectors.flatMap(s => RELATED_LIBRARY_SECTORS[s] ?? []), 'other']));
}

export interface LibraryCandidate {
  id: string;
  sector: Sector;
  name: string;
  definition: string;
  unit: string;
  level: IndicatorLevel;
  methods: CollectionMethod[];
  frequency: Frequency;
  disaggregation: string[];
  standardReference: unknown;
  isStandard: boolean;
}

export const MAX_LIBRARY_CANDIDATES = 40;

/**
 * Chooses and orders the library entries offered to the model: accountability
 * entries (AC-*) first for humanitarian projects (kpi-assistant-spec §A4), then
 * the primary sector, the other project sectors, related sectors and 'other';
 * standard entries before custom ones, then by id. At most `limit` entries.
 */
export function selectLibraryCandidates<T extends LibraryCandidate>(
  entries: readonly T[],
  opts: { sectors: Sector[]; humanitarian: boolean; limit?: number },
): T[] {
  const [primary, ...secondary] = opts.sectors;
  const related = new Set(opts.sectors.flatMap(s => RELATED_LIBRARY_SECTORS[s] ?? []));
  const rank = (e: T): number => {
    if (opts.humanitarian && e.id.startsWith('AC-')) return 0;
    if (e.sector === primary) return 1;
    if (secondary.includes(e.sector)) return 2;
    if (related.has(e.sector)) return 3;
    if (e.sector === 'other') return 4;
    return -1;
  };
  return entries
    .map(e => ({ e, r: rank(e) }))
    .filter(({ r }) => r >= 0)
    .sort((a, b) => a.r - b.r
      || Number(b.e.isStandard) - Number(a.e.isStandard)
      || a.e.id.localeCompare(b.e.id, 'en', { numeric: true }))
    .slice(0, opts.limit ?? MAX_LIBRARY_CANDIDATES)
    .map(({ e }) => e);
}

/** "EU GERF 2.38" from a library standardReference { framework, code }, or null. */
export function standardReferenceLabel(reference: unknown): string | null {
  if (!isObject(reference)) return null;
  const label = [text(reference.framework), text(reference.code)].filter(Boolean).join(' ');
  return label ? clip(label, LIMITS.standardReferenceCode) : null;
}

/** The fields of a linked IndicatorLibraryEntry that the normaliser checks indicators against. */
export interface LibraryEntryReference {
  id: string;
  definition: string;
  notes?: string | null;
  meansOfVerification?: string | null;
  calculation?: unknown;
  disaggregation: readonly string[];
  standardReference: unknown;
}

/**
 * The library entry's own text, the only evidence for a standard threshold: definition, notes,
 * means of verification, the calculation fields and the standard reference (framework and code,
 * e.g. "Sphere Water supply standard — minimum 15 l/p/d"). Never text written by the model.
 */
export function libraryEntryTexts(entry: LibraryEntryReference): string[] {
  const calculation = isObject(entry.calculation) ? Object.values(entry.calculation).map(text) : [];
  const reference = isObject(entry.standardReference) ? [text(entry.standardReference.framework), text(entry.standardReference.code)] : [];
  return [text(entry.definition), text(entry.notes), text(entry.meansOfVerification), ...calculation, ...reference].filter(Boolean);
}

// ------------------------------------------------------- deterministic checks

const DIGIT = /\d/;

/**
 * Text as compared by the document checks: NFKC, ASCII digits for Arabic-Indic and Extended
 * Arabic-Indic digits, the Arabic decimal separator (٫) as ".", the Arabic thousands separator (٬)
 * and the Arabic comma (،) as ",", the Arabic percent sign (٪) as "%", typographic quotes and dashes
 * as ASCII, single spaces, no space before "%", lower case. "١٢٬٠٠٠" and "12,000" then compare equal.
 */
function normaliseForMatch(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660)) // Arabic-Indic digits
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0)) // Extended Arabic-Indic digits
    .replace(/٫/g, '.')
    .replace(/[٬،]/g, ',')
    .replace(/٪/g, '%')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/ %/g, '%')
    .toLowerCase();
}

/**
 * The document's own text: everything before the LAST AI analysis marker. The pre-Phase 3 parser
 * appended one marker and its analysis at the end of the text; that analysis is model output and
 * must never "prove" a baseline or target (me-foundations.md §6). A marker quoted earlier in the
 * document belongs to the document's own text and is kept (the legacy migration splits the same way).
 */
export function stripAiAnalysis(parsedText: string): string {
  const at = parsedText.lastIndexOf(AI_ANALYSIS_MARKER);
  return at === -1 ? parsedText : parsedText.slice(0, at).trimEnd();
}

/**
 * A document's own text for prompts and evidence: the parser's AI analysis is cut off (model output
 * must never "prove" a baseline or target), then phone numbers, ID numbers and email addresses are
 * removed (CLAUDE.md rule 5). The parser already redacts what it stores; rows parsed before Phase 3
 * may not be redacted, so this runs again. `removed` counts the matches (safe to log).
 */
export function documentTextForAi(parsedText: string | null | undefined): { text: string; removed: number } {
  const { text: redacted, counts } = redactPersonalData(stripAiAnalysis(parsedText ?? ''));
  return { text: redacted, removed: counts.phone + counts.idNumber + counts.email };
}

/** A project document's file name and its own text (see documentTextForAi). */
export interface SourceDocument {
  fileName: string;
  text: string;
}

/** Characters that join digit groups into one number: decimal and thousands separators (ASCII and Arabic). */
const NUMBER_JOINERS = new Set(['.', ',', '٫', '٬']);

function partOfLargerNumber(haystack: string, start: number, end: number): boolean {
  const before = haystack[start - 1] ?? '';
  const after = haystack[end] ?? '';
  if (DIGIT.test(before) || DIGIT.test(after)) return true;
  if (NUMBER_JOINERS.has(before) && DIGIT.test(haystack[start - 2] ?? '')) return true;
  if (NUMBER_JOINERS.has(after) && DIGIT.test(haystack[end + 1] ?? '')) return true;
  return false;
}

/** The value as searched for; null when it has no digit. */
function matchNeedle(value: string): string | null {
  const needle = normaliseForMatch(value).trim();
  return needle && DIGIT.test(needle) ? needle : null;
}

function containsValue(doc: string, needle: string): boolean {
  const haystack = normaliseForMatch(stripAiAnalysis(doc));
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
    if (!partOfLargerNumber(haystack, i, i + needle.length)) return true;
  }
  return false;
}

/**
 * True when the exact value string (ignoring case, repeated spaces and Arabic-Indic
 * digits) appears in at least one document and is not part of a larger number
 * ("8" is not found in "800"). Values without a digit are never treated as found,
 * since words such as "yes" would match almost any document. Text after the AI
 * analysis marker is ignored.
 */
export function appearsInDocuments(value: string, documentTexts: readonly string[]): boolean {
  const needle = matchNeedle(value);
  return needle !== null && documentTexts.some(doc => containsValue(doc, needle));
}

/** The first document in which the value appears (same matching as appearsInDocuments), or null. */
export function findSourceDocument(value: string, documents: readonly SourceDocument[]): SourceDocument | null {
  const needle = matchNeedle(value);
  return needle === null ? null : documents.find(doc => containsValue(doc.text, needle)) ?? null;
}

// ------------------------------------------------------- verified document figures

/** A documentFigures entry whose quote was found in a document (see verifyDocumentFigures). */
export interface VerifiedFigure extends DocumentFigure {
  /** File name of the document that holds the quote, cited when the value is used. */
  source: string;
}

const MONTH_NAMES = [
  'january', 'jan', 'february', 'feb', 'march', 'mar', 'april', 'apr', 'june', 'jun', 'july', 'jul', 'august', 'aug',
  'september', 'sept', 'sep', 'october', 'oct', 'november', 'nov', 'december', 'dec',
  'يناير', 'فبراير', 'مارس', 'أبريل', 'ابريل', 'إبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'اغسطس', 'سبتمبر', 'أكتوبر', 'اكتوبر',
  'نوفمبر', 'ديسمبر', 'كانون', 'شباط', 'آذار', 'اذار', 'نيسان', 'أيار', 'ايار', 'حزيران', 'تموز', 'آب', 'أيلول', 'ايلول', 'تشرين',
].join('|');
// "may" only before a year ("15 May 2026"), so that "15 may be revised" is not read as a date.
const MONTH_AFTER_VALUE = new RegExp(`^ ?(?:(?:${MONTH_NAMES})(?!\\p{L})|may ?,? ?\\d{4})`, 'u');
const MONTH_BEFORE_VALUE = new RegExp(`(?<!\\p{L})(?:${MONTH_NAMES}|may)\\.? ?$`, 'u');

/**
 * True when the number at [start, end) of normalised text is part of a date or a range rather than a
 * figure: next to a month name ("15 March 2026", "March 15", "١٥ آذار"), or joined to other digits by
 * "/" or "-" ("15/03/2026", "2026-03-15", "10-15").
 */
function isDateOrRangePart(haystack: string, start: number, end: number): boolean {
  if (MONTH_AFTER_VALUE.test(haystack.slice(end, end + 20)) || MONTH_BEFORE_VALUE.test(haystack.slice(Math.max(0, start - 20), start))) return true;
  const before = haystack[start - 1] ?? '';
  const after = haystack[end] ?? '';
  if ((before === '/' || before === '-') && DIGIT.test(haystack[start - 2] ?? '')) return true;
  if ((after === '/' || after === '-') && DIGIT.test(haystack[end + 1] ?? '')) return true;
  return false;
}

/** Quote marks, brackets and final punctuation around a quote, which the model may add or drop. */
const QUOTE_EDGES = /^[\s"'«»()[\]]+|[\s"'«»()[\].,;:!?]+$/g;
/** A quote may skip text with an ellipsis ("…" becomes "..." under NFKC). */
const QUOTE_ELLIPSIS = / ?\.{3,} ?/;
/** Words of at least two letters: a quote needs two besides the value, so a bare number is no quote. */
const QUOTE_WORD = /\p{L}{2,}/gu;

/**
 * True when the quote supports the figure in this (normalised) document text: every part of the
 * quote (parts separated by an ellipsis) appears in the text; the part holding the value has at
 * least two words; and at one place where that part appears, the value stands alone there (not part
 * of a larger number, a date or a range).
 */
function quoteSupportsValue(normalisedDoc: string, quote: string, needle: string): boolean {
  const parts = normaliseForMatch(quote).split(QUOTE_ELLIPSIS).map(p => p.replace(QUOTE_EDGES, '')).filter(Boolean);
  const holder = parts.find(p => p.includes(needle) && (p.match(QUOTE_WORD)?.length ?? 0) >= 2);
  if (!holder || !parts.every(p => normalisedDoc.includes(p))) return false;
  for (let at = normalisedDoc.indexOf(holder); at !== -1; at = normalisedDoc.indexOf(holder, at + 1)) {
    for (let offset = holder.indexOf(needle); offset !== -1; offset = holder.indexOf(needle, offset + 1)) {
      const start = at + offset;
      const end = start + needle.length;
      if (!partOfLargerNumber(normalisedDoc, start, end) && !isDateOrRangePart(normalisedDoc, start, end)) return true;
    }
  }
  return false;
}

/** The documents as compared by quoteSupportsValue: own text only (see stripAiAnalysis), normalised. */
function normalisedDocuments(documents: readonly SourceDocument[]): Array<{ fileName: string; text: string }> {
  return documents.map(d => ({ fileName: d.fileName, text: normaliseForMatch(stripAiAnalysis(d.text)) }));
}

function figureSource(figure: DocumentFigure, documents: ReadonlyArray<{ fileName: string; text: string }>): string | null {
  const needle = matchNeedle(figure.value);
  if (needle === null || !figure.quote) return null;
  return documents.find(doc => quoteSupportsValue(doc.text, figure.quote, needle))?.fileName ?? null;
}

/**
 * The document figures that the documents support, each with the file it was found in: the quote
 * is found in a document (ignoring case, spacing, Arabic-Indic digits and separators, typographic
 * quotes and an ellipsis between parts), it contains the value, and the value stands alone there
 * (not part of a larger number, a date or a range). Only these figures can supply a baseline, a
 * target or an intermediate target (me-foundations.md §6), and only for their own kind.
 */
export function verifyDocumentFigures(figures: readonly DocumentFigure[], documents: readonly SourceDocument[]): VerifiedFigure[] {
  const docs = normalisedDocuments(documents);
  return figures.flatMap(figure => {
    const source = figureSource(figure, docs);
    return source === null ? [] : [{ ...figure, source }];
  });
}

/** The verified figure of this kind whose value equals `value` (after normalisation), or null. */
export function matchingFigure(value: string, kind: DocumentFigure['kind'], figures: readonly VerifiedFigure[]): VerifiedFigure | null {
  const needle = matchNeedle(value);
  if (needle === null) return null;
  return figures.find(f => f.kind === kind && matchNeedle(f.value) === needle) ?? null;
}

// "officials" only in the plural: "official" is usually an adjective ("official records").
const PEOPLE_WORDS_EN = /\b(people|persons?|individuals?|households?|women|woman|men|man|girls?|boys?|children|child|youths?|young people|students?|pupils?|learners?|teachers?|staff|employees?|workers?|officials|members?|residents?|citizens?|parents?|caregivers?|entrepreneurs?|owners?|farmers?|participants?|beneficiar(?:y|ies)|trainees?|graduates?|patients?|refugees?|survivors?)\b/i;

const normaliseArabic = (word: string) => word
  .replace(/[ً-ْـ]/g, '') // diacritics and tatweel
  .replace(/[أإآ]/g, 'ا')
  .replace(/ى/g, 'ي');

/** Arabic word forms (without the article or attached prepositions), normalised like the indicator text (hamza, alif maqsura). */
const PEOPLE_WORDS_AR = new Set([
  'ناس', 'أشخاص', 'شخص', 'أفراد', 'أسر', 'أسرة', 'أسره', 'نساء', 'امرأة', 'رجال', 'أطفال', 'طفل', 'طفلة', 'فتيات', 'فتيان',
  'شباب', 'شابات', 'طلاب', 'طالبات', 'طلبة', 'تلاميذ', 'تلميذ', 'تلميذات', 'متعلمين', 'متعلمون', 'متعلمات',
  'معلم', 'معلمين', 'معلمون', 'معلمات', 'موظف', 'موظفين', 'موظفون', 'موظفات', 'عمال', 'عاملين', 'عاملون', 'عاملات',
  'مسؤولين', 'مسؤولون', 'مسؤولات', 'أعضاء', 'سكان', 'مواطن', 'مواطنين', 'مواطنون', 'مواطنات', 'أهالي',
  'مقدمي', 'مقدمو', 'مقدمات', 'رواد', 'رائدات', 'مالكي', 'مالكو', 'مالكات',
  'مزارعين', 'مزارعون', 'مزارعات', 'مشاركين', 'مشاركون', 'مشاركات',
  'مستفيدين', 'مستفيدون', 'مستفيدات', 'متدربين', 'متدربون', 'متدربات', 'خريجين', 'خريجون', 'خريجات', 'مرضى',
  'لاجئين', 'لاجئون', 'لاجئات', 'ناجين', 'ناجون', 'ناجيات',
].map(normaliseArabic));

function arabicWordCandidates(token: string): string[] {
  const out = new Set<string>([token]);
  const strip = (w: string) => {
    const forms = [w];
    if (/^[وف]/.test(w)) forms.push(w.slice(1));
    for (const f of [...forms]) if (/^[بلك]/.test(f)) forms.push(f.slice(1));
    for (const f of [...forms]) {
      if (f.startsWith('ال')) forms.push(f.slice(2));
      if (f.startsWith('لل')) forms.push(f.slice(2));
    }
    return forms;
  };
  for (const form of strip(token)) out.add(form);
  return Array.from(out);
}

/** True when an indicator counts or measures people (me-foundations.md §2 rule 7), in English or Arabic. */
export function isPeopleLevelIndicator(nameEn: string, nameAr?: string | null): boolean {
  if (PEOPLE_WORDS_EN.test(nameEn)) return true;
  if (!nameAr) return false;
  return normaliseArabic(nameAr)
    .split(/[^ء-ي]+/)
    .filter(Boolean)
    .some(token => arabicWordCandidates(token).some(w => PEOPLE_WORDS_AR.has(w)));
}

const DISAGGREGATION_SYNONYMS: Record<string, string> = {
  gender: 'sex',
  male: 'sex',
  female: 'sex',
  male_female: 'sex',
  sex_disaggregated: 'sex',
  age_group: 'age',
  age_groups: 'age',
  age_band: 'age',
  age_bands: 'age',
  youth: 'age',
  pwd: 'disability',
  disabled: 'disability',
  disability_status: 'disability',
  washington_group: 'disability',
  governorate: 'location',
  geography: 'location',
  geographic_area: 'location',
  displacement: 'displacement_status',
};

const DISAGGREGATION_KEY = /^[a-z][a-z0-9_]*$/;

/** Disaggregation groups as unique snake_case keys ("Gender" → sex, "PwD" → disability); invalid keys are dropped. */
export function normalizeDisaggregation(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;]/) : [];
  const keys: string[] = [];
  for (const item of items) {
    const key = text(item)
      .toLowerCase()
      .replace(/[\s\-/]+/g, '_')
      .replace(/[^a-z0-9_]/g, '')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
    const mapped = DISAGGREGATION_SYNONYMS[key] ?? key;
    if (!DISAGGREGATION_KEY.test(mapped) || mapped.length > LIMITS.disaggregationKey || keys.includes(mapped)) continue;
    keys.push(mapped);
  }
  return keys.slice(0, LIMITS.disaggregationKeys);
}

const SEX_KEYS = ['sex', 'sex_of_household_head'] as const;

/** Adds (first) the sex keys of the linked library entry (sex, sex_of_household_head) that the indicator lacks. */
export function withLibrarySexDisaggregation(keys: string[], libraryDisaggregation: readonly string[] | null | undefined): string[] {
  const missing = SEX_KEYS.filter(key => libraryDisaggregation?.includes(key) && !keys.includes(key));
  return missing.length > 0 ? [...missing, ...keys].slice(0, LIMITS.disaggregationKeys) : keys;
}

/** Adds 'sex' (first) to a people-level indicator that has neither sex nor sex_of_household_head. */
export function ensureSexDisaggregation(keys: string[], peopleLevel: boolean): string[] {
  if (!peopleLevel || keys.includes('sex') || keys.includes('sex_of_household_head')) return keys;
  return ['sex', ...keys].slice(0, LIMITS.disaggregationKeys);
}

const GENERIC_MEANS_OF_VERIFICATION = new Set([
  'project reports', 'project report', 'reports', 'report', 'progress reports', 'monitoring reports', 'project records',
  'records', 'project documents', 'documents', 'n/a', 'na', 'none', 'tbd', 'to be determined', 'm&e reports',
]);

/** "Project reports" and similar are not acceptable means of verification (me-foundations.md §1). */
export function isGenericMeansOfVerification(value: string): boolean {
  const key = value.toLowerCase().replace(/[.\s]+$/g, '').replace(/\s+/g, ' ').trim();
  return GENERIC_MEANS_OF_VERIFICATION.has(key);
}

function isPercentUnit(unit: string, name: string): boolean {
  const u = unit.trim().toLowerCase();
  return u.startsWith('%') || u.startsWith('percent') || /^(%|percentage\b|proportion\b)/i.test(name.trim());
}

/** A bare number such as "35", "35%" or "1,200" (as opposed to a target-setting method). */
const BARE_NUMBER = /^[~≈<>≤≥]?\s*[+-]?[\d٠-٩.,]+\s*%?$/;

type BaselineBasis = 'document' | 'none';
type TargetBasis = 'document' | 'standard_threshold' | 'method_only' | 'none';

/** An intermediate target as stored on Indicator.intermediateTargets (a type, so that it is valid Prisma JSON). */
export type IntermediateTarget = { date: string; value: string };

export interface BaselineTargetInput {
  baselineValue: string;
  baselineBasis: string;
  /** The model's baseline method; the document is cited in it when the baseline is kept. */
  baselineMethod?: string;
  /** The model's baseline date, "YYYY-MM-DD": when a document baseline was measured, otherwise the planned date. */
  baselineDate?: string;
  targetValue: string;
  targetBasis: string;
  targetJustification: string;
  /** The model's intermediate targets [{ date, value }]: kept only for document target values. */
  intermediateTargets?: unknown;
  standardReferenceCode: string | null;
  /** The linked library entry: its own text is the only evidence for a standard threshold. */
  libraryEntry?: LibraryEntryReference | null;
}

export interface BaselineTargetResult {
  baselineValue: string | null;
  /** UTC midnight of the baseline date, or null when unknown (baselineMethod then says "Baseline date: to be confirmed."). */
  baselineDate: Date | null;
  baselineMethod: string;
  targetValue: string | null;
  targetJustification: string;
  /** Verified intermediate targets sorted by date; [] when none (targetJustification then says they are to be confirmed). */
  intermediateTargets: IntermediateTarget[];
}

function methodText(justification: string, fallback: string): string {
  const cleaned = justification
    .replace(/^proposed method:\s*/i, '')
    .replace(/\s*[—–-]+\s*confirm after baseline\.?$/i, '')
    .replace(/[.\s]+$/, '')
    .trim();
  return cleaned || fallback;
}

/** A target-setting method sets the target from the baseline ("baseline + 10 percentage points", "بعد خط الأساس"). */
function describesTargetMethod(method: string): boolean {
  return /\bbaseline/i.test(method) || /خط\s*الاساس/.test(normaliseArabic(method));
}

/** "Target stated in the proposal (source: proposal.pdf)": the text (or the fallback) without its final full stop, then the citation. */
function withSource(value: string, fallback: string, fileName: string, max: number): string {
  const suffix = ` (source: ${fileName})`;
  const base = (value.trim() || fallback).replace(/[.\s]+$/, '');
  return clip(`${clip(base, Math.max(0, max - suffix.length))}${suffix}`, max);
}

const sentence = (value: string) => /[.!?]$/.test(value) ? value : `${value}.`;

/** `body` as a sentence, then `tail`; the body is shortened when needed so that the tail always fits within `max`. */
function withTail(body: string, tail: string, max: number): string {
  const trimmed = body.trim();
  if (!trimmed) return clip(tail, max);
  return `${clip(sentence(trimmed), Math.max(0, max - tail.length - 1))} ${tail}`;
}

/** A real calendar date written exactly as YYYY-MM-DD, at UTC midnight; null for anything else. */
export function strictIsoDate(value: unknown): Date | null {
  const raw = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw ? date : null;
}

/**
 * The model's intermediate targets that the documents support: each value must equal a verified
 * figure of kind 'target' (like a document target) and each date must be a real YYYY-MM-DD date.
 * One target per date (the first), sorted by date, at most 20. `removed` counts the rest.
 */
function resolveIntermediateTargets(raw: unknown, figures: readonly VerifiedFigure[]): { targets: IntermediateTarget[]; sources: string[]; removed: number } {
  const items = Array.isArray(raw) ? raw : [];
  const byDate = new Map<string, IntermediateTarget>();
  const sources = new Set<string>();
  let removed = 0;
  for (const item of items) {
    const date = isObject(item) ? strictIsoDate(item.date) : null;
    const value = isObject(item) ? clip(text(item.value), LIMITS.value) : '';
    if (!value && !date) continue; // an empty row is "nothing", not a removed target
    const figure = value ? matchingFigure(value, 'target', figures) : null;
    if (!date || !figure) {
      removed++;
      continue;
    }
    const key = date.toISOString().slice(0, 10);
    if (byDate.has(key)) continue;
    byDate.set(key, { date: key, value });
    sources.add(figure.source);
  }
  const targets = Array.from(byDate.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, LIMITS.intermediateTargets);
  return { targets, sources: Array.from(sources), removed };
}

/**
 * Applies me-foundations.md §6 (the AI never invents baselines or targets). `figures` are the
 * document figures the documents support (see verifyDocumentFigures); a document value must equal
 * one of them of the right kind, so a target used as a baseline, a date ("15 March"), a budget
 * cell or any number the structure step did not find as a baseline or target is not enough.
 * - a baseline is kept only with basis 'document' and when it equals a verified figure of kind
 *   'baseline'; the figure's document is cited in baselineMethod ("… (source: proposal.pdf)");
 * - baselineDate is a real YYYY-MM-DD date (the measured date of a document baseline, otherwise
 *   the planned date); it is dropped with a rejected document baseline. When it is unknown,
 *   baselineMethod ends with "Baseline date: to be confirmed.";
 * - a target is kept with basis 'document' when it equals a verified figure of kind 'target' (cited
 *   in targetJustification), or with basis 'standard_threshold' when it appears in the linked library
 *   entry's own text (see libraryEntryTexts; a standardReferenceCode written by the model is not
 *   enough); it is cleared for 'method_only', 'none', unknown bases and unverified values;
 * - whenever the target is cleared, targetJustification holds the proposed method: "Proposed
 *   method: … — confirm after baseline." The model's text is used only when it sets the target
 *   from the baseline (so a removed target's justification cannot carry the invented number),
 *   otherwise DEFAULT_TARGET_METHOD;
 * - intermediate targets are kept only when their value equals a verified figure of kind 'target'
 *   (cited in targetJustification); without any, targetJustification ends with "Intermediate
 *   targets: to be confirmed after the baseline."
 */
export function resolveBaselineAndTarget(input: BaselineTargetInput, figures: readonly VerifiedFigure[]): BaselineTargetResult {
  const baselineBasis = matchEnum<BaselineBasis>(input.baselineBasis, ['document', 'none']) ?? 'none';
  const targetBasis = matchEnum<TargetBasis>(input.targetBasis, ['document', 'standard_threshold', 'method_only', 'none'], {
    standard: 'standard_threshold',
    threshold: 'standard_threshold',
    method: 'method_only',
  }) ?? 'none';
  const notes: string[] = [];
  const modelBaselineMethod = input.baselineMethod?.trim() ?? '';

  let baselineValue: string | null = null;
  let baselineMethod = clip(modelBaselineMethod, LIMITS.baselineMethod) || TO_BE_CONFIRMED;
  let baselineRejected = false;
  if (baselineBasis === 'document' && input.baselineValue) {
    const figure = matchingFigure(input.baselineValue, 'baseline', figures);
    if (figure) {
      baselineValue = input.baselineValue;
      baselineMethod = withSource(modelBaselineMethod, 'Baseline taken from the project documents', figure.source, LIMITS.baselineMethod);
    } else {
      baselineRejected = true;
      notes.push('The baseline proposed by the AI was not found as a baseline in the project documents and was removed (pending baseline).');
    }
  }
  // The date of a rejected baseline dates a value that is not in the documents.
  const baselineDate = baselineRejected ? null : strictIsoDate(input.baselineDate);
  if (!baselineDate && !baselineMethod.endsWith(BASELINE_DATE_TO_BE_CONFIRMED)) {
    baselineMethod = withTail(baselineMethod, BASELINE_DATE_TO_BE_CONFIRMED, LIMITS.baselineMethod);
  }

  let targetValue: string | null = null;
  let justification: string;
  const targetFigure = targetBasis === 'document' && input.targetValue !== '' ? matchingFigure(input.targetValue, 'target', figures) : null;
  const standardEntry = targetBasis === 'standard_threshold' && input.targetValue !== '' && input.libraryEntry
    && appearsInDocuments(input.targetValue, libraryEntryTexts(input.libraryEntry))
    ? input.libraryEntry : null;

  if (targetFigure) {
    targetValue = input.targetValue;
    justification = withSource(input.targetJustification, 'Target taken from the project documents', targetFigure.source, LIMITS.targetJustification);
  } else if (standardEntry) {
    targetValue = input.targetValue;
    const why = input.targetJustification.replace(/[.\s]+$/, '');
    const reference = input.standardReferenceCode ?? `library entry ${standardEntry.id}`;
    justification = `Proposed standard threshold (${reference})${why ? `: ${why}` : ''} — confirm it applies to this project.`;
  } else if (targetBasis === 'method_only') {
    // A method the model wrote in the target field (e.g. "baseline + 10 percentage points") counts as the method too.
    const methodInValue = input.targetValue !== '' && !BARE_NUMBER.test(input.targetValue) ? input.targetValue : '';
    const method = [input.targetJustification, methodInValue].map(t => methodText(t, '')).find(describesTargetMethod);
    justification = `Proposed method: ${method ?? DEFAULT_TARGET_METHOD} — confirm after baseline.`;
  } else {
    // The model's justification of a removed target may quote the invented number; keep it only when it is a method.
    const method = methodText(input.targetJustification, '');
    justification = `Proposed method: ${describesTargetMethod(method) ? method : DEFAULT_TARGET_METHOD} — confirm after baseline.`;
    if (targetBasis === 'document' && input.targetValue) {
      notes.push('The target proposed by the AI was not found as a target in the project documents and was removed.');
    }
    if (targetBasis === 'standard_threshold' && input.targetValue) {
      notes.push('The standard threshold proposed by the AI was not found in the linked library entry and was removed.');
    }
  }

  const intermediate = resolveIntermediateTargets(input.intermediateTargets, figures);
  if (intermediate.removed > 0) {
    notes.push('Intermediate targets proposed by the AI without a target value of the project documents or a valid date were removed.');
  }
  const intermediateTail = intermediate.targets.length > 0
    ? `Intermediate targets taken from the project documents (source: ${intermediate.sources.join(', ')}).`
    : INTERMEDIATE_TARGETS_TO_BE_CONFIRMED;

  return {
    baselineValue,
    baselineDate,
    baselineMethod,
    targetValue,
    targetJustification: withTail([sentence(justification), ...notes].join(' '), intermediateTail, LIMITS.targetJustification),
    intermediateTargets: intermediate.targets,
  };
}

// ------------------------------------------------------------ indicators

export interface NormalizeIndicatorsContext {
  frameworkId: string;
  /** Result nodes of the framework, in creation order (ResultNode id, code, level, parent id). */
  resultNodes: ReadonlyArray<{ id: string; code: string; level: IndicatorLevel; parentId?: string | null }>;
  /** Ids of the IndicatorLibraryEntry rows offered to (or known by) the model. */
  knownLibraryIds: ReadonlySet<string>;
  /**
   * Library entries by id, including every entry an indicator links to: their standard reference
   * replaces the model's standardReferenceCode, their sex disaggregation is kept, and their own
   * text is the only evidence for a standard threshold.
   */
  libraryEntries?: ReadonlyMap<string, LibraryEntryReference>;
  /**
   * The structure step's document figures that the documents support (verifyDocumentFigures): the
   * only source of document baselines, targets and intermediate targets, cited by file name.
   */
  verifiedFigures: readonly VerifiedFigure[];
  /** Model id used for the call (stored in Indicator.aiModel). */
  aiModel: string;
  promptVersion?: string;
}

export type IndicatorCreatePayload = Prisma.IndicatorCreateManyInput & {
  frameworkId: string;
  level: IndicatorLevel;
  dataCollectionMethod: CollectionMethod;
  frequency: Frequency;
};

const codeKey = (code: string) => code.trim().toUpperCase().replace(/\s+/g, '');
const GOAL_ALIASES = new Set(['G', 'GOAL', 'IMPACT']);

/**
 * Finds the result an indicator measures: the node whose code matches resultCode
 * (an activity code resolves to its parent output, since activities carry no
 * indicators), else the first node of the indicator's level, else null.
 */
export function resolveResult(
  resultCode: string,
  level: IndicatorLevel,
  nodes: NormalizeIndicatorsContext['resultNodes'],
): { id: string; level: IndicatorLevel } | null {
  const key = codeKey(resultCode);
  let node = key ? nodes.find(n => codeKey(n.code) === key) : undefined;
  if (!node && GOAL_ALIASES.has(key)) node = nodes.find(n => n.level === 'impact');
  if (node && node.level === 'activity') {
    const parent = nodes.find(n => n.id === node!.parentId);
    node = parent && parent.level !== 'activity' ? parent : undefined;
  }
  if (!node) node = nodes.find(n => n.level === level);
  return node ? { id: node.id, level: node.level } : null;
}

function parseDate(value: unknown): Date | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00.000Z`) : new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function normalizeMilestones(value: unknown): Array<{ label: string; date?: string; completed: boolean }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const milestones = value
    .filter(isObject)
    .map(m => {
      const label = clip(text(m.label), LIMITS.milestoneLabel);
      const date = parseDate(m.date);
      return { label, ...(date && { date: date.toISOString().slice(0, 10) }), completed: false };
    })
    .filter(m => m.label !== '')
    .slice(0, LIMITS.milestones);
  return milestones.length > 0 ? milestones : undefined;
}

function normalizeCalculation(raw: Json, percent: boolean): Record<string, string> | undefined {
  const source = isObject(raw.calculation) ? raw.calculation : {};
  const calc: Record<string, string> = {};
  const numerator = clip(pick(source, 'numerator') || pick(raw, 'numerator'), LIMITS.calculationPart);
  const denominator = clip(pick(source, 'denominator') || pick(raw, 'denominator'), LIMITS.calculationPart);
  const formula = clip(pick(source, 'formula') || pick(raw, 'formula'), LIMITS.formula);
  const rounding = clip(pick(source, 'rounding') || pick(raw, 'rounding'), 200);
  if (numerator) calc.numerator = numerator;
  if (denominator) calc.denominator = denominator;
  if (formula) calc.formula = formula;
  if (rounding) calc.rounding = rounding;
  // Percentages need an explicit numerator and denominator (me-foundations.md §2 rule 3) and a rounding rule (§3).
  if (percent) {
    calc.numerator ??= TO_BE_CONFIRMED;
    calc.denominator ??= TO_BE_CONFIRMED;
    calc.formula ??= 'numerator ÷ denominator × 100';
    calc.rounding ??= TO_BE_CONFIRMED;
  }
  return Object.keys(calc).length > 0 ? calc : undefined;
}

const normalisedName = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}%]+/gu, ' ').trim();

const rawLibraryId = (raw: Json) => pick(raw, 'libraryId').toUpperCase();

/** The library ids the model's indicators link to (upper case, unique), so entries that were not candidates can be loaded. */
export function linkedLibraryIds(parsed: unknown): string[] {
  return Array.from(new Set(extractIndicatorList(parsed).filter(isObject).map(rawLibraryId).filter(Boolean)));
}

/**
 * Normalises one indicator from the model into a create payload; null when it
 * has no indicator text. See normalizeIndicators for the rules.
 */
export function normalizeIndicator(raw: unknown, sortOrder: number, ctx: NormalizeIndicatorsContext): IndicatorCreatePayload | null {
  if (!isObject(raw)) return null;
  const indicatorText = clip(pick(raw, 'indicatorText', 'name', 'text'), LIMITS.indicatorText);
  if (!indicatorText) return null;
  const indicatorTextAr = clip(pick(raw, 'indicatorTextAr', 'nameAr'), LIMITS.indicatorText);

  // Level, then the result it measures (the linked result's level wins when the code matches).
  const claimedLevel = normalizeIndicatorLevel(raw.level);
  const result = resolveResult(pick(raw, 'resultCode', 'resultId'), claimedLevel, ctx.resultNodes);
  const level: IndicatorLevel = result && result.level !== 'activity' ? result.level : claimedLevel;

  const libraryIdRaw = rawLibraryId(raw);
  const libraryId = libraryIdRaw && ctx.knownLibraryIds.has(libraryIdRaw) ? clip(libraryIdRaw, LIMITS.libraryId) : null;
  const libraryEntry = libraryId ? ctx.libraryEntries?.get(libraryId) ?? null : null;
  // The linked entry's standard reference is authoritative; the model's code is kept only when there is none.
  const standardReferenceCode = (libraryEntry ? standardReferenceLabel(libraryEntry.standardReference) : null)
    ?? orNull(clip(pick(raw, 'standardReferenceCode'), LIMITS.standardReferenceCode));

  const unit = clip(pick(raw, 'unit'), LIMITS.unit);
  const percent = isPercentUnit(unit, indicatorText);
  const disaggregation = ensureSexDisaggregation(
    withLibrarySexDisaggregation(normalizeDisaggregation(raw.disaggregation), libraryEntry?.disaggregation),
    isPeopleLevelIndicator(indicatorText, indicatorTextAr),
  );

  const meansRaw = clip(pick(raw, 'meansOfVerification'), LIMITS.meansOfVerification);
  const values = resolveBaselineAndTarget({
    baselineValue: clip(text(raw.baselineValue), LIMITS.value),
    baselineBasis: text(raw.baselineBasis),
    baselineMethod: pick(raw, 'baselineMethod'),
    baselineDate: text(raw.baselineDate),
    targetValue: clip(text(raw.targetValue), LIMITS.value),
    targetBasis: text(raw.targetBasis),
    targetJustification: pick(raw, 'targetJustification'),
    intermediateTargets: raw.intermediateTargets,
    standardReferenceCode,
    libraryEntry,
  }, ctx.verifiedFigures);

  const phases = textList(raw.phases, LIMITS.phases).map(p => clip(p, LIMITS.phase));
  const startDate = parseDate(raw.startDate);
  const endDate = parseDate(raw.endDate);
  const milestones = normalizeMilestones(raw.milestones);
  const calculation = normalizeCalculation(raw, percent);

  return {
    frameworkId: ctx.frameworkId,
    resultId: result?.id ?? null,
    indicatorText,
    indicatorTextAr: orNull(indicatorTextAr),
    level,
    dataCollectionMethod: normalizeMethod(raw.dataCollectionMethod ?? raw.method, level),
    frequency: normalizeFrequency(raw.frequency, level),
    unit: orNull(unit),
    definition: clip(pick(raw, 'definition'), LIMITS.definition) || TO_BE_CONFIRMED,
    ...(calculation && { calculation }),
    direction: normalizeDirection(raw.direction),
    disaggregation,
    meansOfVerification: meansRaw && !isGenericMeansOfVerification(meansRaw) ? meansRaw : TO_BE_CONFIRMED,
    baselineValue: values.baselineValue,
    baselineDate: values.baselineDate,
    baselineMethod: values.baselineMethod,
    targetValue: values.targetValue,
    targetJustification: values.targetJustification,
    ...(values.intermediateTargets.length > 0 && { intermediateTargets: values.intermediateTargets }),
    assumptions: clip(pick(raw, 'assumptions'), LIMITS.assumptions) || TO_BE_CONFIRMED,
    libraryId,
    standardReferenceCode,
    responsibility: clip(pick(raw, 'responsibility'), LIMITS.responsibility) || TO_BE_CONFIRMED,
    phases: phases.length > 0 ? phases : ['baseline', 'midterm', 'endline'],
    ...(startDate && { startDate }),
    ...(endDate && { endDate }),
    ...(milestones && { milestones }),
    aiRationale: orNull(clip(pick(raw, 'aiRationale', 'rationale'), LIMITS.aiRationale)),
    sortOrder,
    provenance: 'ai_generated',
    aiModel: ctx.aiModel,
    promptVersion: ctx.promptVersion ?? FRAMEWORK_PROMPT_VERSION,
  };
}

/** The indicator list from the model's reply: a JSON array, or an object with an `indicators` array. */
export function extractIndicatorList(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (isObject(parsed)) {
    if (Array.isArray(parsed.indicators)) return parsed.indicators;
    if (Array.isArray(parsed.suggestions)) return parsed.suggestions;
  }
  return [];
}

/**
 * Normalises the model's indicators into create payloads:
 * - enums matched case-insensitively with synonyms; unknown method/frequency fall
 *   back to the level's usual choice; level 'activity' or unknown → output;
 * - resultCode → ResultNode id (else the first node of the same level, else null);
 * - libraryId kept only when it is a known library id; the linked entry's standard
 *   reference replaces the model's standardReferenceCode;
 * - the linked entry's sex keys (sex, sex_of_household_head) are kept, and 'sex' is
 *   added to people-level indicators that lack sex / sex_of_household_head;
 * - baselines, baseline dates, targets and intermediate targets per resolveBaselineAndTarget
 *   (never invented: document values must be verified document figures of the same kind and
 *   cite the document; an unknown baseline date or no intermediate target is marked "to be
 *   confirmed" in baselineMethod or targetJustification);
 * - "" (the structured-output answer's "unknown") counts as missing everywhere:
 *   indicatorTextAr, libraryId, standardReferenceCode, calculation parts, dates, baseline and target values;
 * - empty definition, means of verification (or a generic one such as "project
 *   reports"), baseline method, assumptions and responsibility → "To be confirmed by
 *   the M&E officer" (me-foundations.md §3), and so are the numerator, denominator and rounding
 *   of a percentage; targetJustification is always filled (see resolveBaselineAndTarget);
 *   referenceSheetGaps lists what is still open (including a missing Arabic name or unit);
 * - provenance ai_generated with the model and prompt version;
 * - indicators without text and repeats (same result, same wording) are dropped.
 */
export function normalizeIndicators(parsed: unknown, ctx: NormalizeIndicatorsContext): IndicatorCreatePayload[] {
  const seen = new Set<string>();
  const out: IndicatorCreatePayload[] = [];
  for (const raw of extractIndicatorList(parsed)) {
    const payload = normalizeIndicator(raw, out.length, ctx);
    if (!payload) continue;
    const key = `${payload.resultId ?? ''}|${normalisedName(payload.indicatorText)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(payload);
  }
  return out;
}

// ------------------------------------------------------- reference-sheet gaps

/** Reference-sheet fields checked by referenceSheetGaps, in reference-sheet order (me-foundations.md §3). */
export const REFERENCE_SHEET_FIELDS = [
  'indicatorTextAr', 'definition', 'unit', 'calculation', 'direction', 'disaggregation', 'meansOfVerification',
  'baselineDate', 'baselineMethod', 'intermediateTargets', 'targetJustification', 'assumptions', 'responsibility',
] as const;

export type ReferenceSheetField = typeof REFERENCE_SHEET_FIELDS[number];

/** The indicator fields referenceSheetGaps reads: a create payload or a stored Indicator row. */
export interface ReferenceSheetFields {
  indicatorText: string;
  indicatorTextAr?: string | null;
  /** The baseline date is required for impact and outcome indicators (me-foundations.md §6). */
  level?: string | null;
  unit?: string | null;
  definition?: string | null;
  calculation?: unknown;
  direction?: string | null;
  disaggregation?: unknown;
  meansOfVerification?: string | null;
  baselineDate?: Date | string | null;
  baselineMethod?: string | null;
  targetJustification?: string | null;
  intermediateTargets?: unknown;
  assumptions?: string | null;
  responsibility?: string | null;
}

/**
 * Empty, or still the "to be confirmed" marker. `marker` ("Baseline date: to be confirmed.", or the
 * intermediate targets one) is ignored at the end: it marks another field.
 */
function unconfirmed(value: unknown, marker?: string): boolean {
  let t = text(value);
  if (marker && t.endsWith(marker)) t = t.slice(0, -marker.length).trim();
  t = t.replace(/\.$/, '');
  return t === '' || t === TO_BE_CONFIRMED;
}

function hasDate(value: unknown): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  return strictIsoDate(value) !== null;
}

function hasIntermediateTargets(value: unknown): boolean {
  return Array.isArray(value) && value.some(t => isObject(t) && text(t.value) !== '' && text(t.date) !== '');
}

/**
 * The reference-sheet fields an M&E officer still has to fill or confirm: an empty Arabic name or
 * unit; empty or "To be confirmed by the M&E officer" text (a generic means of verification counts
 * as missing); the numerator, denominator or rounding of a percentage; a missing or unknown
 * direction; a people-level indicator without sex disaggregation (sex or sex_of_household_head);
 * the baseline date of an impact or outcome indicator; and intermediate targets.
 * Pure; used by tests and scripts/ai-smoke.ts to check generated frameworks.
 */
export function referenceSheetGaps(indicator: ReferenceSheetFields): ReferenceSheetField[] {
  const gaps = new Set<ReferenceSheetField>();
  if (text(indicator.indicatorTextAr) === '') gaps.add('indicatorTextAr');
  if (unconfirmed(indicator.definition)) gaps.add('definition');
  if (text(indicator.unit) === '') gaps.add('unit');
  if (isPercentUnit(indicator.unit ?? '', indicator.indicatorText)) {
    const calc = isObject(indicator.calculation) ? indicator.calculation : {};
    if (unconfirmed(calc.numerator) || unconfirmed(calc.denominator) || unconfirmed(calc.rounding)) gaps.add('calculation');
  }
  if (normalizeDirection(indicator.direction) === null) gaps.add('direction');
  if (isPeopleLevelIndicator(indicator.indicatorText, indicator.indicatorTextAr)) {
    const keys = Array.isArray(indicator.disaggregation) ? indicator.disaggregation.map(text) : [];
    if (!SEX_KEYS.some(key => keys.includes(key))) gaps.add('disaggregation');
  }
  const means = text(indicator.meansOfVerification);
  if (unconfirmed(means) || isGenericMeansOfVerification(means)) gaps.add('meansOfVerification');
  if ((indicator.level === 'impact' || indicator.level === 'outcome') && !hasDate(indicator.baselineDate)) gaps.add('baselineDate');
  if (unconfirmed(indicator.baselineMethod, BASELINE_DATE_TO_BE_CONFIRMED)) gaps.add('baselineMethod');
  if (!hasIntermediateTargets(indicator.intermediateTargets)) gaps.add('intermediateTargets');
  if (unconfirmed(indicator.targetJustification, INTERMEDIATE_TARGETS_TO_BE_CONFIRMED)) gaps.add('targetJustification');
  if (unconfirmed(indicator.assumptions)) gaps.add('assumptions');
  if (unconfirmed(indicator.responsibility)) gaps.add('responsibility');
  return REFERENCE_SHEET_FIELDS.filter(field => gaps.has(field));
}
