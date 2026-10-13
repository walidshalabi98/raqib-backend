/**
 * KPI Assistant prompt and answer schema (features "kpi.suggest", "kpi.alternatives" and, through the
 * KPI pipeline, "framework.indicators"; knowledge/kpi-assistant-spec.md §A4, design sections 6.1–6.3).
 *
 * Step 0 (Phase 4 contracts): the version, the answer schema, its types, KPI_FEATURES and KPI_CALLS are
 * final; KPI_SYSTEM and the message builders are completed by E4. Answers are structured outputs (zod/v4
 * schema → JSON schema via outputSchema.ts) and are validated again by generateStructured.
 */
import * as z from 'zod/v4';
import { BASELINE_BASES, FRAMEWORK_DIRECTIONS, FRAMEWORK_FREQUENCIES, FRAMEWORK_INDICATOR_LEVELS, FRAMEWORK_METHODS,
  INDICATOR_UNITS, TARGET_BASES } from './framework';
import type { AiEffort, ModelTier } from '../client';
import type { ContextResult, KpiLibraryEntry, ProjectContext } from '../../kpi/types';

/** Bump on any change to the text or the schema; listed in docs/AI.md §6. */
export const KPI_PROMPT_VERSION = 'kpi-v1';

export const KPI_SUGGESTION_SCHEMA = z.object({
  resultCode: z.string().describe('Code of the result this indicator measures, exactly as listed under SUGGEST FOR (e.g. "O1.2").'),
  level: z.enum(FRAMEWORK_INDICATOR_LEVELS),
  libraryId: z.string().nullable().describe('Id of the candidate used (e.g. "WA-01"), or null for a custom indicator.'),
  isCustom: z.boolean(),
  customReason: z.string().describe('Why no candidate fits; "" when isCustom is false.'),
  name: z.string().describe('Neutral wording: what is measured. No target, number or direction.'),
  nameAr: z.string().describe('The name in Modern Standard Arabic.'),
  definition: z.string().describe('One or two sentences, at most 50 words.'),
  unit: z.enum(INDICATOR_UNITS),
  numerator: z.string().describe('"" unless unit is percent.'),
  denominator: z.string().describe('"" unless unit is percent.'),
  direction: z.enum(FRAMEWORK_DIRECTIONS),
  disaggregation: z.array(z.string()).describe('snake_case keys, e.g. sex, age, disability, location, displacement_status, sex_of_household_head.'),
  method: z.enum(FRAMEWORK_METHODS),
  frequency: z.enum(FRAMEWORK_FREQUENCIES),
  meansOfVerification: z.string().describe('The specific source and tool, in a few words. Never a generic answer such as "project reports".'),
  baselineSuggestion: z.string().describe('Only a value copied exactly from a DOCUMENT FACTS excerpt marked baseline or mixed; otherwise "".'),
  baselineBasis: z.enum(BASELINE_BASES),
  targetSuggestion: z.string().describe('A value copied exactly from a DOCUMENT FACTS excerpt marked target or mixed, a threshold number copied from the linked candidate (e.g. "15"), or a target-setting method relative to the baseline (e.g. "baseline + 10 percentage points"); "" if none.'),
  targetBasis: z.enum(TARGET_BASES),
  standardReferenceCode: z.string().nullable().describe('e.g. "EU GERF 2.38", or null.'),
  rationale: z.string().describe('2 short sentences (at most 45 words): why this indicator fits this result and this donor.'),
  qualityNotes: z.array(z.string()).describe('At most 2 short notes; [] if none.'),
  confidence: z.enum(['high', 'medium', 'low']),
});

export const KPI_SUGGESTIONS_SCHEMA = z.object({
  suggestions: z.array(KPI_SUGGESTION_SCHEMA),
  frameworkWarnings: z.array(z.string()).describe('Gaps you notice, e.g. an outcome with no measurable change. [] if none.'),
});

export type KpiModelAnswer = z.infer<typeof KPI_SUGGESTIONS_SCHEMA>;
export type KpiRawSuggestion = z.infer<typeof KPI_SUGGESTION_SCHEMA>;

// ------------------------------------------------------------------ E4: prompt text and builders (design 6.2, 6.3)

/**
 * Feature instructions sent after the shared cached system prompt (design 6.2, ≈ 600 words).
 * TODO(E4): the real text; bump KPI_PROMPT_VERSION only when the released text changes.
 */
export const KPI_SYSTEM: string = 'TODO(E4): KPI Assistant instructions (design section 6.2).';

/** AiCall feature ids of the KPI Assistant (framework generation passes 'framework.indicators' itself). */
export const KPI_FEATURES = { suggest: 'kpi.suggest', alternatives: 'kpi.alternatives' } as const;

/**
 * Call settings per scope (design 6.3): result = one result, batch = framework scope and framework
 * generation (≤ 4 results per call), alternatives = fast tier. Timeouts are 15 ms per output token (≥ 60 s).
 */
export const KPI_CALLS: Readonly<Record<'result' | 'batch' | 'alternatives',
  { tier: ModelTier; effort: AiEffort; maxTokens: number; timeoutMs: number }>> = {
  result: { tier: 'main', effort: 'low', maxTokens: 6_000, timeoutMs: 90_000 },
  batch: { tier: 'main', effort: 'low', maxTokens: 12_000, timeoutMs: 180_000 },
  alternatives: { tier: 'fast', effort: 'low', maxTokens: 4_000, timeoutMs: 60_000 },
};

/** What one model call's user message is built from (all free text already redacted by the context builder). */
export interface KpiPromptInput {
  context: ProjectContext;
  /** The results of this call (SUGGEST FOR). */
  batch: ContextResult[];
  /** Key ContextResult.id, best first. */
  candidateIdsByResult: Record<string, string[]>;
  /** ≤ 40: union for the batch + accountability entries. */
  candidates: KpiLibraryEntry[];
  /** Key ContextResult.id. */
  allowances: Record<string, { min: number; max: number }>;
}

/** One CANDIDATES line of the user message (design 6.2). */
export function kpiCandidateLine(_entry: KpiLibraryEntry): string {
  throw new Error('Phase 4: not implemented (E4)');
}

/** The plain-text user message: PROJECT, DONOR RULES, RESULTS CHAIN, SUGGEST FOR, DOCUMENT FACTS, CANDIDATES, … (design 6.2). */
export function buildKpiUserMessage(_input: KpiPromptInput): string {
  throw new Error('Phase 4: not implemented (E4)');
}
