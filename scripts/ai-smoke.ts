/**
 * Manual end-to-end check of framework generation with the REAL Anthropic API (BUILD_GUIDE Phase 3
 * acceptance: "A framework generation on the seed project completes and stores indicators with all
 * new fields filled or explicitly marked 'to be confirmed'"). It costs a little money.
 *
 *   npm run ai:smoke -- --yes                      # the dev seed's "Gaza Emergency WASH and Cash Response" project
 *   npm run ai:smoke -- --yes --project <projectId>
 *
 * It creates a new framework version (like POST /api/projects/:id/framework/generate), runs the
 * generator inline, then prints the indicators per level, the reference-sheet gaps of every indicator
 * and the AiCall rows of the run. Nothing is deleted: a failed run leaves an empty draft version.
 * Refuses in production and with a placeholder ANTHROPIC_API_KEY. Prints ids, counts, indicator
 * wording and gap names only; never prompts, document text or raw model output.
 */
import { parseArgs } from 'util';
import type { AiCall, IndicatorLevel } from '@prisma/client';
import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { resolveModel } from '../src/services/ai/client';
import { generateFramework } from '../src/services/ai/frameworkGenerator';
import { ReferenceSheetFields, referenceSheetGaps } from '../src/services/ai/frameworkNormalize';

/** The dev seed's project without a framework (prisma/seed.ts: "try framework generation here"). */
export const SEED_PROJECT_NAME = 'Gaza Emergency WASH and Cash Response';

const LEVELS: IndicatorLevel[] = ['impact', 'outcome', 'output', 'activity'];

/** AiCall rows created up to this long before the run started still count as the run's (database clock). */
const CLOCK_MARGIN_MS = 5_000;

export interface SmokeArgs {
  yes: boolean;
  projectId: string | null;
  help: boolean;
}

/** Parses --yes, --project <id> and --help; throws on unknown options. */
export function parseSmokeArgs(argv: string[]): SmokeArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      yes: { type: 'boolean', default: false },
      project: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const projectId = values.project?.trim() || null;
  return { yes: values.yes === true, projectId, help: values.help === true };
}

const PLACEHOLDER_WORD = /(^|[-_.])(test|placeholder|your|example|changeme|change-me|dummy|fake|xxx+|not-a-real)([-_.]|$)/i;

/** Why the key cannot be a real Anthropic API key, or null when it looks like one. */
export function apiKeyProblem(key: string | undefined): string | null {
  const value = (key ?? '').trim();
  if (!value) return 'ANTHROPIC_API_KEY is not set.';
  if (PLACEHOLDER_WORD.test(value)) return 'ANTHROPIC_API_KEY looks like a placeholder; set a real key in .env.';
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(value)) return 'ANTHROPIC_API_KEY does not look like an Anthropic API key (sk-ant-…); set a real key in .env.';
  return null;
}

/** Why the smoke test must not run, or null. */
export function smokeRefusal(opts: { nodeEnv: string; apiKey: string | undefined; yes: boolean }): string | null {
  if (opts.nodeEnv === 'production') return 'Refusing to run: NODE_ENV is "production". Run the smoke test against a development database.';
  const keyProblem = apiKeyProblem(opts.apiKey);
  if (keyProblem) return `Refusing to run: ${keyProblem}`;
  if (!opts.yes) return 'This calls the real Anthropic API (two main-tier calls; it costs a little money) and adds a framework version. Re-run with --yes to continue.';
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

/** Rows "result, level, indicator, gaps" (gaps from referenceSheetGaps; "none" when complete). */
export function gapRows(indicators: readonly SmokeIndicator[]): string[][] {
  return indicators.map(i => {
    const gaps = referenceSheetGaps(i);
    return [i.resultCode ?? '—', i.level, shorten(i.indicatorText, 70), gaps.length > 0 ? gaps.join(', ') : 'none'];
  });
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

const USAGE = `Usage: npm run ai:smoke -- --yes [--project <projectId>]
Generates a new framework version with the real Anthropic API and prints a report.
Without --project, uses the dev seed's project "${SEED_PROJECT_NAME}".`;

export interface SmokeOptions {
  /** Defaults to the validated env (NODE_ENV, ANTHROPIC_API_KEY); tests pass their own. */
  nodeEnv?: string;
  apiKey?: string;
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
  const refusal = smokeRefusal({ nodeEnv: options.nodeEnv ?? env.nodeEnv, apiKey: options.apiKey ?? env.anthropicApiKey, yes: args.yes });
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
  const documents = await prisma.document.count({ where: { projectId: project.id, parsingStatus: 'completed' } });

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
    // AI errors name the feature and the problem, never prompt text or model output.
    error(`Generation failed: ${(err as Error)?.name ?? 'Error'}: ${(err as Error)?.message ?? String(err)}`);
    error(`Framework version ${framework.version} is left as an empty draft (${framework.id}).`);
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
    const complete = rows.filter(i => referenceSheetGaps(i).length === 0).length;

    log(`Framework status: ${stored.status}; served model: ${stored.aiModelUsed}; ${results} results; prompt version ${indicators[0]?.promptVersion ?? '—'}\n`);
    log(formatTable(['level', 'indicators'], levelRows(rows)));
    log(`\nReference-sheet gaps (fields still "to be confirmed"): ${complete} of ${rows.length} indicators complete\n`);
    log(formatTable(['result', 'level', 'indicator', 'gaps'], gapRows(rows)));
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
      console.error(`AI smoke test failed: ${(err as Error)?.message ?? String(err)}`);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
