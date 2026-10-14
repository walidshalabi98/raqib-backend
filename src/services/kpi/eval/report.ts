/**
 * The evaluation report: eval-results/<timestamp>.json and the summary table on stdout (knowledge/kpi-assistant-spec.md
 * §A8 "store each eval run as JSON in eval-results/ and print a summary table"; design section 10.3). Cases are
 * fictional; no personal data; no prompt text. Env-free.
 */
import fs from 'fs';
import nodePath from 'path';
import type { ValidatedSuggestion } from '../types';
import { summarise, type EvalCaseRun, type EvalSummary, type EvalTargets } from './metrics';

/**
 * The stored report of one evaluation run (spec §A8 "store each eval run as JSON in eval-results/"; design 10.3): ids,
 * numbers and validated suggestions without drafts; never prompt text.
 */
export interface EvalReport {
  startedAt: string;
  finishedAt: string;
  mode: 'real' | 'fake';
  status: 'complete' | 'incomplete';
  promptVersion: string;
  /** Shared system prompt version the real calls used (from the AiCall records); null in fake mode (no system prompt sent). */
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

/** `${now.toISOString().replace(/[:.]/g, '-')}.json` (design 10.3), e.g. 2026-10-13T08-00-00-000Z.json. */
export function reportFileName(now: Date): string {
  return `${now.toISOString().replace(/[:.]/g, '-')}.json`;
}

/** Writes the report into `dir` (created when missing) as <startedAt>.json and returns the file path. */
export function writeReport(dir: string, report: EvalReport): string {
  fs.mkdirSync(dir, { recursive: true });
  const started = new Date(report.startedAt);
  const file = nodePath.join(dir, reportFileName(Number.isNaN(started.getTime()) ? new Date() : started));
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return file;
}

/** A plain-text table with padded columns (formatTable of scripts/ai-smoke.ts, copied: design 10.2). */
export function formatTable(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ').trimEnd();
  return [line(header), line(widths.map(w => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

const percent = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)}%`);
const whole = (n: number | null) => (n === null ? '—' : String(Math.round(n)));
const seconds = (ms: number | null) => (ms === null ? '—' : (ms / 1000).toFixed(1));
const usd = (n: number) => n.toFixed(2);
const flag = (passed: boolean) => (passed ? 'PASS' : 'FAIL');

const HEADER = ['case', 'suggestions', 'assertions', 'library use', 'avg quality', 'hallucinated (raw→final)', 'base←target', 'cost USD',
  'result s', 'batch s', 'out tok/sugg'];

/** The cells of one case (its own summary, so the numbers follow the same rules as the total). */
function caseRow(c: EvalReport['cases'][number], resultCheck: boolean): string[] {
  const s = summarise([{ ...c, suggestions: c.suggestions as ValidatedSuggestion[] }], undefined, { resultCheck });
  const resultMax = c.resultCalls.length > 0 ? Math.max(...c.resultCalls.map(call => call.latencyMs)) : null;
  const batchMax = c.calls.length > 0 ? Math.max(...c.calls.map(call => call.latencyMs)) : null;
  return [
    c.error ? `${c.id} (failed)` : c.id,
    `${s.modelSuggestions} (+${s.appendedAccountability} AC)`,
    `${s.assertions.passed}/${s.assertions.total}`,
    percent(s.libraryUsage),
    whole(s.avgQuality),
    `${c.hallucinatedBefore}→${c.hallucinatedAfter}`,
    String(c.baselinesFromTargetSentences),
    usd(s.costUsd),
    seconds(resultMax),
    seconds(batchMax),
    whole(s.outputTokensPerSuggestion),
  ];
}

/**
 * The summary table of design 10.3: a header line (prompt, system prompt, models, retrieval, library, mode), one row per
 * case, the total and target rows and the result line (status and each target flag). Ids and numbers only.
 */
export function formatSummaryTable(report: EvalReport): string {
  const s = report.summary;
  const t = report.targets;
  const resultCheck = s.latencyMeasured;
  const heading = [
    'KPI Assistant evaluation',
    `prompt ${report.promptVersion}`,
    `system ${report.systemPromptVersion ?? '—'}`,
    `main ${report.models.main}`,
    `fast ${report.models.fast}`,
    `retrieval ${report.retrieval}`,
    `library ${report.libraryVersion}`,
    `mode ${report.mode}`,
  ].join(' · ');
  const total = [
    'total',
    `${s.modelSuggestions} (+${s.appendedAccountability} AC)`,
    `${s.assertions.passed}/${s.assertions.total} ${percent(s.assertions.rate)}`,
    percent(s.libraryUsage),
    whole(s.avgQuality),
    `${s.hallucinatedBefore}→${s.hallucinatedAfter}`,
    String(s.baselinesFromTargetSentences),
    usd(s.costUsd),
    resultCheck ? `p50 ${seconds(s.resultLatency.p50Ms)} / max ${seconds(s.resultLatency.maxMs)}` : 'not measured',
    s.batchLatency.maxMs === null ? '—' : `p50 ${seconds(s.batchLatency.p50Ms)} / max ${seconds(s.batchLatency.maxMs)}`,
    whole(s.outputTokensPerSuggestion),
  ];
  const target = [
    'target',
    '',
    `≥ ${Math.round(t.assertionPassRate * 100)}%`,
    `≥ ${Math.round(t.libraryUsage * 100)}%`,
    `≥ ${t.avgQuality}`,
    `final ${t.hallucinatedAfter}`,
    String(t.baselinesFromTargetSentences),
    '—',
    `p50 < ${t.resultLatencyP50Ms / 1000}, max < ${t.resultLatencyMaxMs / 1000}`,
    '',
    '',
  ];
  const result = [
    `result ${s.status}${s.incompleteReasons.length > 0 ? ` (${s.incompleteReasons.join('; ')})` : ''}`,
    `schema validity ${percent(s.schemaValidity)} ${flag(s.passed.schemaValidity)}`,
    `assertions ${flag(s.passed.assertions)}`,
    `library ${flag(s.passed.library)}`,
    `hallucinated ${flag(s.passed.hallucinated)}`,
    `baselines ${flag(s.passed.baselines)}`,
    `thresholds ${s.thresholdsOutsideList} ${flag(s.passed.thresholds)}`,
    `quality ${flag(s.passed.quality)}`,
    `latency ${resultCheck ? flag(s.passed.latency) : 'not measured'}`,
  ].join(' · ');
  const calls = `calls ${Object.entries(s.calls).map(([outcome, n]) => `${outcome} ${n}`).join(', ')}`;
  return [heading, formatTable(HEADER, [...report.cases.map(c => caseRow(c, resultCheck)), total, target]), calls, result].join('\n');
}
