/**
 * The evaluation report: eval-results/<timestamp>.json and the summary table on stdout (design section 10.3). Cases
 * are fictional; no personal data; no prompt text.
 *
 * Step 0 stub (Phase 4 contracts): EvalReport and the signatures are final; E6 implements the bodies.
 */
import type { ValidatedSuggestion } from '../types';
import type { EvalCaseRun, EvalSummary, EvalTargets } from './metrics';

export interface EvalReport {
  startedAt: string;
  finishedAt: string;
  mode: 'real' | 'fake';
  status: 'complete' | 'incomplete';
  promptVersion: string;
  systemPromptVersion: string | null;
  models: { main: string; fast: string };
  retrieval: 'vector' | 'keyword';
  libraryVersion: string;
  casesFile: { path: string; version: string };
  /** Number of cases run before the budget stopped the run, else null. */
  budgetReachedAfter: number | null;
  /** Suggestions without drafts. */
  cases: Array<Omit<EvalCaseRun, 'suggestions'> & { suggestions: Array<Omit<ValidatedSuggestion, 'draft'>> }>;
  summary: EvalSummary;
  targets: EvalTargets;
}

/** `${now.toISOString().replace(/[:.]/g, '-')}.json`. */
export function reportFileName(_now: Date): string {
  throw new Error('Phase 4: not implemented (E6)');
}

/** Writes the report into `dir` and returns the file path. */
export function writeReport(_dir: string, _report: EvalReport): string {
  throw new Error('Phase 4: not implemented (E6)');
}

/** The summary table of design 10.3 (formatTable logic copied from scripts/ai-smoke.ts). */
export function formatSummaryTable(_report: EvalReport): string {
  throw new Error('Phase 4: not implemented (E6)');
}
