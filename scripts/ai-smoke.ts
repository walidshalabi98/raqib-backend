/**
 * Manual end-to-end check of framework generation with the REAL Anthropic API (BUILD_GUIDE Phase 3
 * acceptance: "A framework generation on the seed project completes and stores indicators with all
 * new fields filled or explicitly marked 'to be confirmed'"). It costs a little money.
 *
 *   npm run ai:smoke -- --yes                      # the dev seed's "Gaza Emergency WASH and Cash Response" project
 *   npm run ai:smoke -- --yes --project <projectId>
 *
 * It creates a new framework version (like POST /api/projects/:id/framework/generate), runs the
 * generator inline, then prints the indicators per level, the reference-sheet status of every indicator
 * (fields still "to be confirmed" and missing fields, reported separately; neither counts as filled)
 * and the AiCall rows of the run. AI calls (main tier): one "framework.structure" call when the project
 * has parsed documents, then the indicator calls of the KPI pipeline (one per batch of results; see
 * AI_CALLS_TEXT). Nothing is deleted: a failed run leaves an empty version marked
 * with its generationError, which is never the project's current framework.
 * Refuses in production, with a placeholder ANTHROPIC_API_KEY, and unless DATABASE_URL points at a
 * development database (localhost, or a database name containing "dev" or "test"; for any other
 * database pass --i-know-this-is-not-shared). Prints ids, counts, indicator wording and gap names
 * only; never prompts, document text, raw model output or error text that could echo stored values.
 */
import { parseArgs } from 'util';
import type { AiCall, IndicatorLevel } from '@prisma/client';
import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { resolveModel } from '../src/services/ai/client';
import { safeErrorSummary } from '../src/services/ai/errors';
import { generateFramework } from '../src/services/ai/frameworkGenerator';
import {
  BASELINE_DATE_TO_BE_CONFIRMED, INTERMEDIATE_TARGETS_TO_BE_CONFIRMED, REFERENCE_SHEET_FIELDS, ReferenceSheetField, ReferenceSheetFields,
  referenceSheetGaps,
} from '../src/services/ai/frameworkNormalize';
import { apiKeyProblem } from '../src/services/ai/keyCheck';
import { KPI_BATCH_MAX_RESULTS, KPI_MAX_CALLS_PER_RUN } from '../src/services/kpi/callModel';

export { apiKeyProblem };

/**
 * The AI calls one run makes, for the help text and the --yes prompt (design D19: framework generation's indicator step
 * runs the KPI pipeline in batches; the client may retry a call, which the AiCall table shows as attempts).
 */
export const AI_CALLS_TEXT = `main-tier calls: one for the results chain when the project has parsed documents, then one per batch of up to ${KPI_BATCH_MAX_RESULTS} results for the indicators (at most ${KPI_MAX_CALLS_PER_RUN})`;

/** The dev seed's project without a framework (prisma/seed.ts: "try framework generation here"). */
export const SEED_PROJECT_NAME = 'Gaza Emergency WASH and Cash Response';

const LEVELS: IndicatorLevel[] = ['impact', 'outcome', 'output', 'activity'];

/** AiCall rows created up to this long before the run started still count as the run's (database clock). */
const CLOCK_MARGIN_MS = 5_000;

export interface SmokeArgs {
  yes: boolean;
  projectId: string | null;
  help: boolean;
  /** --i-know-this-is-not-shared: run against a database that does not look like a development one. */
  notShared: boolean;
}

/** The flag that allows a run against a database whose URL does not look like a development database. */
export const NOT_SHARED_FLAG = '--i-know-this-is-not-shared';

/** Parses --yes, --project <id>, --i-know-this-is-not-shared and --help; throws on unknown options. */
export function parseSmokeArgs(argv: string[]): SmokeArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      yes: { type: 'boolean', default: false },
      project: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      'i-know-this-is-not-shared': { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const projectId = values.project?.trim() || null;
  return { yes: values.yes === true, projectId, help: values.help === true, notShared: values['i-know-this-is-not-shared'] === true };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Why DATABASE_URL may be a shared database, or null when it looks like a development one: the
 * host is localhost / 127.0.0.1 / ::1, or the database name contains "dev" or "test". The URL itself
 * (it holds a password) is never part of the message.
 */
export function databaseProblem(databaseUrl: string | undefined): string | null {
  let url: URL;
  try {
    url = new URL((databaseUrl ?? '').trim());
  } catch {
    return 'DATABASE_URL is not a valid database URL.';
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, '')).toLowerCase();
  if (LOCAL_HOSTS.has(url.hostname.toLowerCase()) || /dev|test/.test(database)) return null;
  return `DATABASE_URL points at database "${database || '(none)'}" on ${url.hostname}, which does not look like a development database (localhost, or a name containing "dev" or "test"). The run adds a framework version to a real project. If this database is not shared, re-run with ${NOT_SHARED_FLAG}.`;
}

/** Why the smoke test must not run, or null. */
export function smokeRefusal(opts: {
  nodeEnv: string;
  apiKey: string | undefined;
  yes: boolean;
  databaseUrl: string | undefined;
  notShared?: boolean;
}): string | null {
  if (opts.nodeEnv === 'production') return 'Refusing to run: NODE_ENV is "production". Run the smoke test against a development database.';
  const keyProblem = apiKeyProblem(opts.apiKey);
  if (keyProblem) return `Refusing to run: ${keyProblem}`;
  const dbProblem = opts.notShared ? null : databaseProblem(opts.databaseUrl);
  if (dbProblem) return `Refusing to run: ${dbProblem}`;
  if (!opts.yes) return `This calls the real Anthropic API (${AI_CALLS_TEXT}; it costs a little money) and adds a framework version. Re-run with --yes to continue.`;
  return null;
}

/** A plain-text table with padded columns. */
export function formatTable(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ').trimEnd();
  return [line(header), line(widths.map(w => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

function shorten(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export type SmokeIndicator = ReferenceSheetFields & { level: IndicatorLevel; resultCode: string | null };

/** Rows "level, count" for every level that has indicators, plus the total. */
export function levelRows(indicators: readonly SmokeIndicator[]): string[][] {
  const rows = LEVELS
    .map(level => [level, String(indicators.filter(i => i.level === level).length)])
    .filter(([, count]) => count !== '0');
  return [...rows, ['total', String(indicators.length)]];
}

/** Text that marks a reference-sheet field as still to be confirmed by the M&E officer (me-foundations §3). */
const TO_BE_CONFIRMED_MARK = /to be confirmed|confirm after baseline/i;

const fieldText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const withoutTail = (value: string, tail: string): string => (value.endsWith(tail) ? value.slice(0, -tail.length).trim() : value);
const marked = (value: unknown): boolean => TO_BE_CONFIRMED_MARK.test(fieldText(value));

/** Reference-sheet fields of one indicator that are not filled: still "to be confirmed", or missing. */
export interface ReferenceSheetStatus {
  toBeConfirmed: ReferenceSheetField[];
  missing: ReferenceSheetField[];
}

/**
 * Which reference-sheet fields are still "to be confirmed" and which are missing (BUILD_GUIDE Phase 3 acceptance: every
 * field filled or explicitly marked "to be confirmed"; me-foundations §3). A field counts as filled only when it holds
 * a value without a "to be confirmed" marker: a field whose text says "To be confirmed by the M&E officer" or "— confirm
 * after baseline" is to be confirmed even when referenceSheetGaps accepts it (e.g. a proposed target-setting method).
 * The baseline date and the intermediate targets have no text of their own: an open one is to be confirmed when the
 * baseline method or the target justification carries its marker ("Baseline date: to be confirmed.", "Intermediate
 * targets: to be confirmed after the baseline."), else missing. Every other open field (empty, a generic means of
 * verification, no sex disaggregation) is missing. Pure.
 */
export function referenceSheetStatus(indicator: ReferenceSheetFields): ReferenceSheetStatus {
  const gaps = new Set(referenceSheetGaps(indicator));
  const baselineMethod = fieldText(indicator.baselineMethod);
  const justification = fieldText(indicator.targetJustification);
  const calculation = indicator.calculation && typeof indicator.calculation === 'object' ? indicator.calculation as Record<string, unknown> : {};
  const markers: Record<ReferenceSheetField, boolean> = {
    indicatorTextAr: marked(indicator.indicatorTextAr),
    definition: marked(indicator.definition),
    unit: false,
    calculation: ['numerator', 'denominator', 'formula', 'rounding'].some(key => marked(calculation[key])),
    direction: false,
    disaggregation: false,
    meansOfVerification: marked(indicator.meansOfVerification),
    baselineDate: gaps.has('baselineDate') && baselineMethod.includes(BASELINE_DATE_TO_BE_CONFIRMED),
    baselineMethod: marked(withoutTail(baselineMethod, BASELINE_DATE_TO_BE_CONFIRMED)),
    intermediateTargets: gaps.has('intermediateTargets') && justification.includes(INTERMEDIATE_TARGETS_TO_BE_CONFIRMED),
    targetJustification: marked(withoutTail(justification, INTERMEDIATE_TARGETS_TO_BE_CONFIRMED)),
    assumptions: marked(indicator.assumptions),
    responsibility: marked(indicator.responsibility),
  };
  const toBeConfirmed = REFERENCE_SHEET_FIELDS.filter(field => markers[field]);
  const missing = REFERENCE_SHEET_FIELDS.filter(field => gaps.has(field) && !markers[field]);
  return { toBeConfirmed, missing };
}

/** Header of the reference-sheet table. */
export const SHEET_HEADER = ['result', 'level', 'indicator', 'to be confirmed', 'missing'];

/** Rows "result, level, indicator, to be confirmed, missing" (referenceSheetStatus; "none" when a list is empty). */
export function gapRows(indicators: readonly SmokeIndicator[]): string[][] {
  return indicators.map(i => {
    const status = referenceSheetStatus(i);
    const list = (fields: ReferenceSheetField[]) => (fields.length > 0 ? fields.join(', ') : 'none');
    return [i.resultCode ?? '—', i.level, shorten(i.indicatorText, 70), list(status.toBeConfirmed), list(status.missing)];
  });
}

/** Counts for the report line: complete (every field filled), with fields to be confirmed, with missing fields. */
export function sheetSummary(indicators: readonly ReferenceSheetFields[]): { total: number; complete: number; withToBeConfirmed: number; withMissing: number } {
  const statuses = indicators.map(referenceSheetStatus);
  return {
    total: indicators.length,
    complete: statuses.filter(s => s.toBeConfirmed.length === 0 && s.missing.length === 0).length,
    withToBeConfirmed: statuses.filter(s => s.toBeConfirmed.length > 0).length,
    withMissing: statuses.filter(s => s.missing.length > 0).length,
  };
}

/** The report line above the reference-sheet table. */
export function sheetSummaryLine(summary: ReturnType<typeof sheetSummary>): string {
  return `Reference sheets: ${summary.complete} of ${summary.total} indicators complete (every field filled); `
    + `${summary.withToBeConfirmed} with fields still "to be confirmed"; ${summary.withMissing} with missing fields`;
}

export const AI_CALL_HEADER = ['feature', 'status', 'model', 'served model', 'attempts', 'input', 'output', 'cache read', 'cache write', 'latency ms', 'cost USD'];

type AiCallRow = Pick<AiCall, 'feature' | 'status' | 'model' | 'servedModel' | 'attempts' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'latencyMs'> & {
  estimatedCostUsd: { toString(): string } | number | null;
};

/** Rows for the AiCall table, then a total row (the cost total is "unknown" when any cost is unknown). */
export function aiCallRows(calls: readonly AiCallRow[]): string[][] {
  const rows = calls.map(c => [
    c.feature, c.status, c.model, c.servedModel ?? '—', String(c.attempts), String(c.inputTokens), String(c.outputTokens),
    String(c.cacheReadTokens), String(c.cacheWriteTokens), String(c.latencyMs), c.estimatedCostUsd === null ? 'unknown' : Number(c.estimatedCostUsd.toString()).toFixed(4),
  ]);
  const sum = (pick: (c: AiCallRow) => number) => String(calls.reduce((total, c) => total + pick(c), 0));
  const unknownCost = calls.some(c => c.estimatedCostUsd === null);
  const cost = calls.reduce((total, c) => total + (c.estimatedCostUsd === null ? 0 : Number(c.estimatedCostUsd.toString())), 0);
  return [...rows, [
    'total', '', '', '', sum(c => c.attempts), sum(c => c.inputTokens), sum(c => c.outputTokens), sum(c => c.cacheReadTokens),
    sum(c => c.cacheWriteTokens), sum(c => c.latencyMs), unknownCost ? 'unknown' : cost.toFixed(4),
  ]];
}

const USAGE = `Usage: npm run ai:smoke -- --yes [--project <projectId>] [${NOT_SHARED_FLAG}]
Generates a new framework version with the real Anthropic API and prints a report
(${AI_CALLS_TEXT}).
Without --project, uses the dev seed's project "${SEED_PROJECT_NAME}".
Runs only against a development database (DATABASE_URL on localhost, or a database name
containing "dev" or "test"), unless ${NOT_SHARED_FLAG} is passed.`;

export interface SmokeOptions {
  /** Defaults to the validated env (NODE_ENV, ANTHROPIC_API_KEY, DATABASE_URL); tests pass their own. */
  nodeEnv?: string;
  apiKey?: string;
  databaseUrl?: string;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/** Runs the smoke test and returns the exit code (0 success, 1 refused or failed). */
export async function runAiSmoke(argv: string[], options: SmokeOptions = {}): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));
  let args: SmokeArgs;
  try {
    args = parseSmokeArgs(argv);
  } catch (err) {
    error(`${(err as Error).message}\n\n${USAGE}`);
    return 1;
  }
  if (args.help) {
    log(USAGE);
    return 0;
  }
  const refusal = smokeRefusal({
    nodeEnv: options.nodeEnv ?? env.nodeEnv,
    apiKey: options.apiKey ?? env.anthropicApiKey,
    yes: args.yes,
    databaseUrl: options.databaseUrl ?? env.databaseUrl,
    notShared: args.notShared,
  });
  if (refusal) {
    error(refusal);
    return 1;
  }

  const project = args.projectId
    ? await prisma.project.findUnique({ where: { id: args.projectId } })
    : await prisma.project.findFirst({ where: { name: SEED_PROJECT_NAME }, orderBy: { createdAt: 'desc' } });
  if (!project) {
    error(args.projectId ? `Project ${args.projectId} not found.` : `Project "${SEED_PROJECT_NAME}" not found: run npm run seed, or pass --project <id>.`);
    return 1;
  }
  // Same documents as the generator: FGD and KII transcripts are never used for the framework.
  const documents = await prisma.document.count({ where: { projectId: project.id, parsingStatus: 'completed', qualitativeSource: false } });

  // Same as the generate route: a new version, then the generator (which records the served model).
  const latest = await prisma.framework.findFirst({ where: { projectId: project.id }, orderBy: { version: 'desc' } });
  const framework = await prisma.framework.create({
    data: { projectId: project.id, version: (latest?.version ?? 0) + 1, status: 'draft', aiModelUsed: resolveModel('main') },
  });
  log(`Project:   ${project.name} (${project.id})`);
  log(`Framework: version ${framework.version} (${framework.id})`);
  log(`Model:     ${resolveModel('main')} (AI_MODEL_MAIN)`);
  log(documents > 0
    ? `Documents: ${documents} parsed; the results chain is extracted from them.`
    : 'Documents: none parsed; the results chain comes from the project metadata (upload a proposal to include the structure step).');
  log('\nGenerating… (this can take a few minutes)\n');

  // AiCall.createdAt is set by the database: allow for a small clock difference.
  const started = new Date(Date.now() - CLOCK_MARGIN_MS);
  let failed = false;
  try {
    await generateFramework(framework.id, project.id);
  } catch (err) {
    failed = true;
    // AI errors name the feature and the problem; any other error only its class (it could echo stored values).
    error(`Generation failed: ${safeErrorSummary(err)}`);
    const stored = await prisma.framework.findUnique({ where: { id: framework.id }, select: { generationError: true } });
    error(stored?.generationError
      ? `Framework version ${framework.version} (${framework.id}) is marked as failed and is not the project's current framework: ${stored.generationError}`
      : `Framework version ${framework.version} (${framework.id}) was left without results or indicators.`);
  }

  if (!failed) {
    const stored = await prisma.framework.findUniqueOrThrow({ where: { id: framework.id }, select: { status: true, aiModelUsed: true } });
    const indicators = await prisma.indicator.findMany({
      where: { frameworkId: framework.id },
      orderBy: { sortOrder: 'asc' },
      include: { result: { select: { code: true } } },
    });
    const rows: SmokeIndicator[] = indicators.map(i => ({ ...i, resultCode: i.result?.code ?? null }));
    const results = await prisma.resultNode.count({ where: { frameworkId: framework.id } });

    log(`Framework status: ${stored.status}; served model: ${stored.aiModelUsed}; ${results} results; prompt version ${indicators[0]?.promptVersion ?? '—'}\n`);
    log(formatTable(['level', 'indicators'], levelRows(rows)));
    log(`\n${sheetSummaryLine(sheetSummary(rows))}\n`);
    log(formatTable(SHEET_HEADER, gapRows(rows)));
  }

  const calls = await prisma.aiCall.findMany({
    where: { projectId: project.id, feature: { startsWith: 'framework.' }, createdAt: { gte: started } },
    orderBy: { createdAt: 'asc' },
  });
  log('\nAI calls of this run\n');
  log(calls.length > 0 ? formatTable(AI_CALL_HEADER, aiCallRows(calls)) : '(no AiCall rows found)');
  return failed ? 1 : 0;
}

if (require.main === module) {
  runAiSmoke(process.argv.slice(2))
    .then(code => { process.exitCode = code; })
    .catch(err => {
      console.error(`AI smoke test failed: ${safeErrorSummary(err)}`);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
