/**
 * Metrics and targets of the KPI evaluation (knowledge/kpi-assistant-spec.md §A8; design section 10.2). The value
 * matching here is written independently of frameworkNormalize/validate (m1), so a validator bug shows up.
 *
 * Step 0 stub (Phase 4 contracts): types, targets and signatures are final; E6 implements the bodies. EvalCaseRun and
 * EvalSummary are not spelled out in the design; E6 may extend them.
 */
import type { KpiCallInfo, KpiWarning, ValidatedSuggestion } from '../types';
import type { AssertionResult } from './assertions';

/** §A8 targets (design 10.2). */
export interface EvalTargets {
  schemaValidity: number;
  assertionPassRate: number;
  libraryUsage: number;
  hallucinatedAfter: number;
  baselinesFromTargetSentences: number;
  avgQuality: number;
  resultLatencyP50Ms: number;
  resultLatencyMaxMs: number;
}

export const DEFAULT_EVAL_TARGETS: Readonly<EvalTargets> = {
  schemaValidity: 1, assertionPassRate: 0.9, libraryUsage: 0.7, hallucinatedAfter: 0,
  baselinesFromTargetSentences: 0, avgQuality: 80, resultLatencyP50Ms: 15_000, resultLatencyMaxMs: 30_000,
};

/** One case of an evaluation run (design 10.3 "cases[]"). */
export interface EvalCaseRun {
  id: string;
  /** Class name and AiError message only; null when the case ran. */
  error: string | null;
  /** Validated suggestions of the framework-scope run (the report drops their drafts). */
  suggestions: ValidatedSuggestion[];
  frameworkWarnings: KpiWarning[];
  assertions: AssertionResult[];
  /** Raw model suggestions before validation. */
  rawCount: number;
  hallucinatedBefore: number;
  hallucinatedAfter: number;
  baselinesFromTargetSentences: number;
  /** Candidate ids per result id of the framework-scope run (library usage counts results with ≥ 1 candidate). */
  candidateIdsByResult: Record<string, string[]>;
  /** Calls of the framework-scope run. */
  calls: KpiCallInfo[];
  /** Calls of the result-scope latency check ([] with --no-result-check). */
  resultCalls: KpiCallInfo[];
}

type Latency = { p50Ms: number | null; maxMs: number | null };

/** Summary of a run (design 10.2 summarise; printed by formatSummaryTable). */
export interface EvalSummary {
  status: 'complete' | 'incomplete';
  /** Why the run is incomplete (thrown case, budget stop, result_failed, refused or errored call). */
  incompleteReasons: string[];
  calls: Record<KpiCallInfo['outcome'], number>;
  /** success / (success + invalid + truncated); null without calls. */
  schemaValidity: number | null;
  assertions: { passed: number; total: number; rate: number | null };
  /** origin 'model' suggestions with a libraryId / origin 'model' suggestions of results with ≥ 1 candidate. */
  libraryUsage: number | null;
  appendedAccountability: number;
  /** Mean qualityScore over origin 'model' suggestions. */
  avgQuality: number | null;
  hallucinatedBefore: number;
  hallucinatedAfter: number;
  baselinesFromTargetSentences: number;
  costUsd: number;
  outputTokensPerSuggestion: number | null;
  resultLatency: Latency;
  batchLatency: Latency;
  passed: Record<'schemaValidity' | 'assertions' | 'library' | 'hallucinated' | 'baselines' | 'quality' | 'latency', boolean>;
}

/**
 * Independent of the validator (m1): the normalised value (Arabic-Indic digits, separators, case) occurs in a fact
 * excerpt with a non-digit, non-separator character (or the text edge) on both sides. Written separately in
 * metrics.ts; shares no code with frameworkNormalize/validate.
 */
export function valueInFactsIndependent(_value: string, _facts: readonly { excerpt: string }[]): boolean {
  throw new Error('Phase 4: not implemented (E6)');
}

/** basis document and !valueInFactsIndependent (baselines and targets). */
export function hallucinatedTargets(_suggestions: readonly { baselineBasis: string; baselineSuggestion: string; targetBasis: string; targetSuggestion: string }[],
  _facts: readonly { excerpt: string }[]): number {
  throw new Error('Phase 4: not implemented (E6)');
}

/**
 * Document baselines whose value occurs (independent match) only in excerpts that contain a target word (target, will,
 * aim, by the end, المستهدف, سيتم) and no baseline word (baseline, currently, survey found, خط الأساس) — its own small lists.
 */
export function baselinesFromTargetSentences(_suggestions: readonly ValidatedSuggestion[], _facts: readonly { excerpt: string }[]): number {
  throw new Error('Phase 4: not implemented (E6)');
}

export function summarise(_cases: readonly EvalCaseRun[], _targets?: EvalTargets): EvalSummary {
  throw new Error('Phase 4: not implemented (E6)');
}
