/**
 * validateAndScore: the deterministic checks around the model's suggestions (knowledge/kpi-assistant-spec.md §A4
 * step 3, rules 1–19; me-foundations §6: the AI never invents numbers; CLAUDE.md rule 7; design sections 1.5 and
 * 4.2). Pure: no prisma, no env, no AI client (tests/kpiPurity.test.ts).
 *
 * Step 0 stub (Phase 4 contracts): constants, types and signatures are final; E2 implements the bodies.
 */
import type { VerifiedFigure } from '../ai/frameworkNormalize';
import type {
  ContextResult, DocumentFact, DocumentText, KpiLibraryEntry, KpiModelAnswer, KpiRawSuggestion, KpiWarning,
  KpiWarningCode, ProjectContext, QualityBand, SuggestionOrigin, ValidatedSuggestion,
} from './types';

/** Quality bands (spec §A4 step 3): ≥ 85 strong, 65–84 review, < 65 weak. */
export const QUALITY_THRESHOLDS = { strong: 85, review: 65 } as const;

export function qualityBand(_score: number): QualityBand {
  throw new Error('Phase 4: not implemented (E2)');
}

/** max(0, 100 − Σ penalty). */
export function qualityScore(_warnings: readonly KpiWarning[]): number {
  throw new Error('Phase 4: not implemented (E2)');
}

/** Builds a warning: fills message (English text of design 9.6), severity and penalty (KPI_PENALTIES). */
export function warning(_code: KpiWarningCode, _params?: Record<string, string | number>): KpiWarning {
  throw new Error('Phase 4: not implemented (E2)');
}

/** Cosine of two English names, null when unknown (rule 18 near-duplicates). */
export type SimilarityFn = (a: string, b: string) => number | null;

export interface ValidateDeps {
  /** Whole library by id. */
  library: ReadonlyMap<string, KpiLibraryEntry>;
  /** Ids offered to the model (for x5 allowed numbers). */
  candidateIds: ReadonlySet<string>;
  /** Cosine of two EN names, null when unknown. */
  similarity?: SimilarityFn;
}

/**
 * Cue positions in a normalised excerpt and the kind of the value at `start`: fact.kind 'baseline'/'target' → that
 * kind; 'mixed' → the kind of the nearest cue that ends before `start` (none → null); null → null. Cue lists are
 * FACT_CUES (exported by documentFacts.ts, E3; pure).
 */
export function valueKindInFact(_fact: DocumentFact, _start: number): 'baseline' | 'target' | null {
  throw new Error('Phase 4: not implemented (E2)');
}

/**
 * The fact that supports `value` as `kind` (rules 8–9, D14): standalone + unit-consistent (excerptSupportsValue with
 * unitIsPercent), valueKindInFact === kind at that occurrence, and verifyDocumentFigures([{ value, quote: excerpt, kind }],
 * documentTexts) non-empty (the excerpt sits in the full text and the value stands alone there). Null otherwise.
 */
export function documentValueSupported(_value: string, _kind: 'baseline' | 'target', _unitIsPercent: boolean,
  _facts: readonly DocumentFact[], _documentTexts: readonly DocumentText[]): { fact: DocumentFact; source: string } | null {
  throw new Error('Phase 4: not implemented (E2)');
}

/**
 * VerifiedFigures for normalizeIndicator: one per document value (baseline, target) that documentValueSupported
 * accepts, with the kind of the field and source = the redacted file name.
 */
export function factsFiguresFor(_raw: KpiRawSuggestion, _ctx: Pick<ProjectContext, 'documentFacts' | 'documentTexts'>): VerifiedFigure[] {
  throw new Error('Phase 4: not implemented (E2)');
}

/** A "baseline"-based method that also holds a number outside a relative pattern (rule 12, SDA-02). */
export function methodHasAbsoluteFigure(_method: string): boolean {
  throw new Error('Phase 4: not implemented (E2)');
}

/** x5/x6: removes sentences holding a figure unverifiedFigures finds; returns the kept text and the removed figures. */
export function withoutUnverifiedSentences(_text: string, _allowed: readonly string[]): { text: string; removed: string[] } {
  throw new Error('Phase 4: not implemented (E2)');
}

/** Rules x1, 1–16, x2–x5 for one suggestion. */
export function validateSuggestion(_raw: KpiRawSuggestion, _ctx: ProjectContext, _deps: ValidateDeps,
  _meta: { rank: number; origin?: SuggestionOrigin }): { suggestion: ValidatedSuggestion } | { dropped: KpiWarning } {
  throw new Error('Phase 4: not implemented (E2)');
}

/** Rule 18 and D12: near-duplicates of existing indicators and pending suggestions, repeats within the run. */
export function dropDuplicates(_s: ValidatedSuggestion[], _ctx: ProjectContext, _similarity?: SimilarityFn): { kept: ValidatedSuggestion[]; warnings: KpiWarning[] } {
  throw new Error('Phase 4: not implemented (E2)');
}

/** Rule 17 (D5, D10): per result keep allowanceFor(result, ctx).max suggestions, best first. */
export function applyResultCaps(_s: ValidatedSuggestion[], _ctx: ProjectContext): { kept: ValidatedSuggestion[]; warnings: KpiWarning[] } {
  throw new Error('Phase 4: not implemented (E2)');
}

/** Rule 19 (D11): appends an accountability indicator for humanitarian projects when none exists or is kept. */
export function ensureAccountability(_s: ValidatedSuggestion[], _ctx: ProjectContext, _deps: ValidateDeps): { suggestions: ValidatedSuggestion[]; warnings: KpiWarning[] } {
  throw new Error('Phase 4: not implemented (E2)');
}

/** Composes everything; re-ranks per result (rank 1..n) at the end. */
export function validateAndScore(_input: { context: ProjectContext; answer: KpiModelAnswer; deps: ValidateDeps }):
  { suggestions: ValidatedSuggestion[]; frameworkWarnings: KpiWarning[] } {
  throw new Error('Phase 4: not implemented (E2)');
}

/**
 * A raw suggestion copied from a library entry (rule 19 and the eval's fake model): name/nameAr/definition/unit/
 * calculation/direction/disaggregation/methods[0]/frequency/MoV of the entry, baselineBasis none, targetBasis
 * method_only, targetSuggestion '', confidence 'medium', isCustom false, the given rationale.
 */
export function rawSuggestionFromLibrary(_entry: KpiLibraryEntry, _result: ContextResult, _rationale: string): KpiRawSuggestion {
  throw new Error('Phase 4: not implemented (E2)');
}

/**
 * Quality check of an existing indicator (trigger 3): rules 3, 4, 5 (on its calculation), x3, x4.
 * needsAlternatives = some warning has penalty > 0 (the band alone cannot drop below 60, so it is not the trigger).
 */
export function scoreExistingIndicator(_ind: { indicatorText: string; indicatorTextAr: string | null; unit: string | null;
  calculation: unknown; meansOfVerification: string | null }): { qualityScore: number; qualityBand: QualityBand; warnings: KpiWarning[]; needsAlternatives: boolean } {
  throw new Error('Phase 4: not implemented (E2)');
}
