/**
 * Phase 4 KPI Assistant contracts (knowledge/kpi-assistant-spec.md §A3–A5). Types and constants only:
 * no runtime imports with side effects, so the eval, scripts and the frontend mirror can rely on it.
 */
import type {
  CollectionMethod, DonorType, Frequency, IndicatorDirection, IndicatorLevel, Sector,
  SuggestionRejectReason, SuggestionStatus,
} from '@prisma/client';
import type { AiCallContext, AiEffort, AiUsage, ModelTier } from '../ai/client';
import type { EmbeddingProvider } from '../ai/embeddingProviders';
import type { INDICATOR_UNITS } from '../ai/prompts/framework';
import type { KpiModelAnswer, KpiRawSuggestion } from '../ai/prompts/kpi';

export type { KpiModelAnswer, KpiRawSuggestion };

export type SuggestableLevel = 'impact' | 'outcome' | 'output';
export type IndicatorUnit = (typeof INDICATOR_UNITS)[number];
export type KpiScopeType = 'framework' | 'result' | 'alternatives';

/** Suggestion count per result by level (spec §A4 step 2): [minimum, maximum]. */
export const LEVEL_SUGGESTION_RANGE: Readonly<Record<SuggestableLevel, readonly [number, number]>> = {
  impact: [1, 2], outcome: [2, 4], output: [2, 3],
};
/** Alternatives runs suggest 2–3 replacements for one indicator. */
export const ALTERNATIVES_RANGE = [2, 3] as const;

export type KpiScope =
  | { type: 'framework' }
  | { type: 'result'; resultId: string }
  | { type: 'alternatives'; indicatorId: string; suggestionId: null }
  | { type: 'alternatives'; indicatorId: null; suggestionId: string };

export interface ContextResult {
  /** ResultNode id (eval and framework generation: the code). */
  id: string;
  /** Redacted; unique by codeKey within the context (collisions get a " (2)" suffix; prompt only, ids map back). */
  code: string;
  level: SuggestableLevel;
  text: string;
  textAr: string | null;
  parentId: string | null;
}

export interface ContextIndicator {
  id: string;
  resultId: string | null;
  name: string;
  nameAr: string | null;
  level: IndicatorLevel;
  unit: string | null;
  libraryId: string | null;
  method: CollectionMethod;
}

export interface ContextPendingSuggestion { id: string; resultId: string | null; libraryId: string | null; name: string }

/**
 * A sentence of an uploaded document (redacted, own text only; fileName redacted). kind from cue words and explicit
 * patterns (factKind): 'baseline' or 'target' = only that kind; 'mixed' = both; each number then takes its own kind
 * (valueKindAt: "from X to Y", "up from X", the nearest cue in its clause); null = no cue: context for the model, never
 * evidence for a baseline or a target. `figures` (framework generation only): the structure step's verified figures in
 * this quote, the only values the fact can supply (design 1.3, 6.4).
 */
export interface DocumentFact {
  documentId: string; fileName: string; excerpt: string; kind: 'baseline' | 'target' | 'mixed' | null;
  figures?: Array<{ value: string; kind: 'baseline' | 'target'; resultCode: string | null }>;
}

/** A document's full own text (documentTextForAi: AI analysis cut, redacted) for rules 8–9. Never sent to the model. */
export interface DocumentText { documentId: string; fileName: string; text: string }

export interface OrgPreferences { rejectedLibraryIds: string[]; preferredMethods: CollectionMethod[] }

export interface DonorRules {
  donorType: DonorType;
  /** Indicators per result the donor allows (existing + suggested); null = no donor cap. */
  maxIndicatorsPerResult: number | null;
  /** Labels shown to the model, as in spec §A3. */
  requiredFrameworks: string[];
  /** Exact IndicatorLibraryEntry.standardFramework values added by the hard filter. */
  libraryFrameworks: string[];
  notes: string[];
}

export interface AlternativesSource {
  kind: 'indicator' | 'suggestion';
  id: string;
  resultId: string;
  name: string;
  nameAr: string | null;
  definition: string | null;
  unit: string | null;
  method: CollectionMethod | null;
  libraryId: string | null;
  reason: 'requested' | 'weak' | 'rejected';
  rejectReason: SuggestionRejectReason | null;
  /** English warning messages of the source (its quality problems). */
  problems: string[];
}

export interface ProjectContext {
  project: {
    id: string; name: string; sectors: Sector[]; donor: string; donorType: DonorType;
    startDate: string; endDate: string; geographicScope: string | null; targetBeneficiaries: number | null;
    humanitarian: boolean; description: string | null;
  };
  resultsChain: ContextResult[];
  scope: KpiScope;
  existingIndicators: ContextIndicator[];
  pendingSuggestions: ContextPendingSuggestion[];
  documentFacts: DocumentFact[];
  /** Full redacted texts of the documents the facts come from (validation only; see DocumentText). */
  documentTexts: DocumentText[];
  orgPreferences: OrgPreferences;
  donorRules: DonorRules;
  alternativesFor: AlternativesSource | null;
}

/** IndicatorLibraryEntry fields the KPI Assistant reads (compatible with LibraryCandidate and LibraryEntryReference). */
export interface KpiLibraryEntry {
  id: string; sector: Sector; tags: string[]; level: IndicatorLevel; name: string; nameAr: string; definition: string;
  unit: string; calculation: unknown; direction: IndicatorDirection; disaggregation: string[]; methods: CollectionMethod[];
  frequency: Frequency; meansOfVerification: string; standardReference: unknown; standardFramework: string | null;
  isStandard: boolean; notes: string | null;
}

export const KPI_WARNING_CODES = [
  // per suggestion
  'library_id_unknown', 'custom_reason_missing', 'target_in_name', 'double_barrelled', 'percent_without_calculation',
  'sex_keys_from_library', 'sex_added', 'baseline_not_found', 'target_not_found', 'standard_threshold_not_found',
  'target_method_default', 'output_survey_method', 'impact_not_secondary', 'arabic_name_missing',
  'generic_means_of_verification', 'figures_unverified', 'level_adjusted', 'arabic_name_from_library', 'level_mismatch_library',
  // framework (run) level
  'model_note', 'unknown_result', 'rejected_library_dropped', 'duplicate_in_run', 'near_duplicate', 'result_cap',
  'accountability_added', 'accountability_missing', 'result_failed', 'result_empty', 'keyword_fallback',
  // accept response (not stored on a suggestion)
  'donor_cap_exceeded',
] as const;
export type KpiWarningCode = (typeof KPI_WARNING_CODES)[number];

/** Penalties of spec §A4 step 3; every other code costs 0. */
export const KPI_PENALTIES: Readonly<Partial<Record<KpiWarningCode, number>>> = {
  custom_reason_missing: 10, target_in_name: 15, double_barrelled: 10, percent_without_calculation: 15,
};

export interface KpiWarning {
  code: KpiWarningCode;
  severity: 'warning' | 'info';
  /** English text (fallback; the frontend translates by code with params). model_note holds model text. */
  message: string;
  params: Record<string, string | number>;
  penalty: number;
}

export type QualityBand = 'strong' | 'review' | 'weak';
export type SuggestionOrigin = 'model' | 'appended_accountability';

/** What accept creates, before edits: IndicatorCreateInput-shaped JSON (dates as YYYY-MM-DD). Always passes parseIndicatorCreate. */
export interface IndicatorDraft {
  indicatorText: string;
  indicatorTextAr: string | null;
  level: SuggestableLevel;
  resultId: string;
  libraryId: string | null;
  standardReferenceCode: string | null;
  definition: string;
  unit: IndicatorUnit;
  calculation: { numerator?: string; denominator?: string; formula?: string; rounding?: string } | null;
  direction: IndicatorDirection;
  disaggregation: string[];
  dataCollectionMethod: CollectionMethod;
  frequency: Frequency;
  meansOfVerification: string;
  baselineValue: string | null;
  /** Always null from the server (the model no longer proposes dates; D22); the officer sets it. */
  baselineDate: string | null;
  baselineMethod: string;
  targetValue: string | null;
  targetJustification: string;
  /** Always [] from the server (D22). */
  intermediateTargets: Array<{ date: string; value: string }>;
  /** TO_BE_CONFIRMED from the server (D22). */
  assumptions: string;
  responsibility: string;
  /** Project start date (YYYY-MM-DD); editable on accept (me-foundations §2.6: the target date is recorded). */
  startDate: string | null;
  /** Project end date (YYYY-MM-DD) = the date the target refers to; editable on accept. */
  endDate: string | null;
  aiRationale: string | null;
}

/** A suggestion after validateAndScore (stored in KpiSuggestion.payload without warnings/qualityScore, which are columns). */
export interface ValidatedSuggestion {
  resultId: string;
  resultCode: string;
  level: SuggestableLevel;
  libraryId: string | null;
  isCustom: boolean;
  customReason: string;
  name: string;
  nameAr: string;
  definition: string;
  unit: IndicatorUnit;
  numerator: string;
  denominator: string;
  direction: IndicatorDirection;
  disaggregation: string[];
  method: CollectionMethod;
  frequency: Frequency;
  meansOfVerification: string;
  baselineSuggestion: string;
  baselineBasis: 'document' | 'none';
  /** Server text: the document citation or TO_BE_CONFIRMED, then "Baseline date: to be confirmed." */
  baselineMethod: string;
  targetSuggestion: string;
  targetBasis: 'document' | 'standard_threshold' | 'method_only' | 'none';
  targetJustification: string;
  standardReferenceCode: string | null;
  rationale: string;
  qualityNotes: string[];
  confidence: 'high' | 'medium' | 'low';
  sources: { baseline: string | null; target: string | null };
  origin: SuggestionOrigin;
  /** 1-based rank within its result after validation. */
  rank: number;
  qualityScore: number;
  qualityBand: QualityBand;
  warnings: KpiWarning[];
  draft: IndicatorDraft;
}

export type KpiRunStep = 'context' | 'retrieval' | 'model' | 'validation' | 'saving' | 'done';
export type KpiErrorCode = 'ai_not_configured' | 'ai_refused' | 'ai_unavailable' | 'ai_invalid_output' | 'interrupted' | 'stale' | 'internal';
/** Request-level error codes (AppError.code) of the KPI routes. */
export type KpiRequestErrorCode = 'ai_not_configured' | 'run_in_progress' | 'no_framework' | 'not_suggestable' | 'already_decided' | 'stale'
  | 'nothing_to_suggest' | 'too_many_results' | 'budget_reached' | 'project_archived' | 'duplicate' | 'source_has_data' | 'not_editable';

export interface KpiCallInfo {
  feature: string; tier: ModelTier; model: string | null; promptVersion: string; resultCodes: string[];
  outcome: 'success' | 'truncated' | 'invalid' | 'refused' | 'error';
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  estimatedCostUsd: number | null; latencyMs: number; aiCallId: string | null;
}

export interface KpiPipelineResult {
  suggestions: ValidatedSuggestion[];
  frameworkWarnings: KpiWarning[];
  retrieval: 'vector' | 'keyword';
  candidateIdsByResult: Record<string, string[]>;
  /** The model's suggestions before validation (eval only; never stored). */
  raw: KpiRawSuggestion[];
  calls: KpiCallInfo[];
  /** Served model of the first successful call; null when no call succeeded. */
  model: string | null;
  promptVersion: string;
  /** Embedding requests made (query texts + near-duplicate names); stored on the run. */
  embeddingCalls: number;
}

export interface LibrarySource {
  /** Every library entry (the library is small). */
  allEntries(): Promise<KpiLibraryEntry[]>;
  /** Stored vectors made by `model`, by entry id (entries without one are absent). */
  vectors(model: string, ids: readonly string[]): Promise<Map<string, number[]>>;
}

export interface KpiModelRequest {
  feature: string;
  tier: ModelTier;
  effort: AiEffort;
  maxTokens: number;
  timeoutMs: number;
  promptVersion: string;
  system: string;
  user: string;
  context: AiCallContext;
  /** Structured copy of what the prompt contains, for fakes and logs (never sent). */
  meta: {
    scopeType: KpiScopeType;
    batch: ContextResult[];
    candidateIdsByResult: Record<string, string[]>;
    candidates: KpiLibraryEntry[];
    allowances: Record<string, { min: number; max: number }>;
  };
}

export interface KpiModelResponse {
  data: KpiModelAnswer;
  model: string;
  usage: AiUsage;
  estimatedCostUsd: number | null;
  aiCallId: string | null;
  latencyMs: number;
}

/** Throws AiRefusalError, AiOutputTruncatedError, AiInvalidOutputError or AiRequestError like generateStructured. */
export type ModelCaller = (request: KpiModelRequest) => Promise<KpiModelResponse>;

export interface KpiPipelineDeps {
  library: LibrarySource;
  embeddings: EmbeddingProvider;
  callModel: ModelCaller;
  now: () => Date;
}

export interface KpiPipelineOptions {
  /** Called when a step starts (the run executor stores it and refreshes updatedAt). */
  onStep?: (step: KpiRunStep) => void | Promise<void>;
  /** Called after each model batch (heartbeat). */
  onProgress?: (info: { batchesDone: number; batchesTotal: number }) => void | Promise<void>;
  /** Feature id for the model calls; default kpi.suggest / kpi.alternatives. Framework generation passes 'framework.indicators'. */
  feature?: string;
  /** AiCall attribution. */
  callContext?: AiCallContext;
  /** No model call starts after this many ms from the pipeline start (default KPI_RUN_DEADLINE_MS); skipped results get result_failed. */
  deadlineMs?: number;
  /** At most this many model calls per run, split retries included (default KPI_MAX_CALLS_PER_RUN). */
  maxCalls?: number;
}

// ---- API DTOs (mirrored in raqib-frontend src/types/api.ts) ----

export interface KpiRunDto {
  id: string; projectId: string; frameworkId: string; scope: KpiScopeType;
  resultId: string | null; sourceIndicatorId: string | null; sourceSuggestionId: string | null;
  /** 'failed' is also reported for a run that stopped sending heartbeats (errorCode 'interrupted'). */
  status: 'running' | 'completed' | 'failed';
  step: KpiRunStep;
  errorCode: KpiErrorCode | null;
  message: string | null;
  frameworkWarnings: KpiWarning[];
  suggestionCount: number;
  retrieval: 'vector' | 'keyword' | null;
  model: string | null;
  promptVersion: string | null;
  createdAt: string; updatedAt: string; finishedAt: string | null;
  /** The server's clock when this DTO was built (ISO): the run's age is serverNow − createdAt (TQ-07). */
  serverNow: string;
}

export interface KpiSuggestionDto {
  id: string; runId: string; projectId: string; frameworkId: string;
  resultId: string | null; resultCode: string; level: SuggestableLevel; sortOrder: number;
  status: SuggestionStatus; qualityScore: number; qualityBand: QualityBand; warnings: KpiWarning[];
  libraryId: string | null; isCustom: boolean; origin: SuggestionOrigin;
  model: string; promptVersion: string;
  alternativeOfIndicatorId: string | null; alternativeOfSuggestionId: string | null;
  indicatorId: string | null;
  createdAt: string; decidedAt: string | null; decidedBy: string | null;
  rejectReason: SuggestionRejectReason | null; rejectNote: string | null;
  suggestion: Omit<ValidatedSuggestion, 'warnings' | 'qualityScore' | 'qualityBand' | 'draft' | 'resultId' | 'resultCode' | 'level' | 'libraryId' | 'isCustom' | 'origin'>;
  draft: IndicatorDraft;
}

/**
 * POST /api/kpi-suggestions/:id/accept response body (warnings: donor_cap_exceeded only, today). replacedIndicatorId:
 * the indicator removed by `replaceSource: true` (SPEC-8), else null.
 */
export interface AcceptKpiSuggestionDto { indicator: unknown; suggestion: KpiSuggestionDto; warnings: KpiWarning[]; replacedIndicatorId: string | null }
