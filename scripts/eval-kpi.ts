/**
 * KPI Assistant evaluation (knowledge/kpi-assistant-spec.md §A8; design section 10): runs the cases of
 * knowledge/kpi-eval-cases.json through the same runKpiPipeline as production, checks their assertions, prints a
 * summary table and stores the report in eval-results/ (git-ignored).
 *
 *   npm run eval:kpi -- --yes [--case CASE-01-GAZA-WASH-ECHO]… [--max-usd 3] [--embeddings] [--no-result-check] [--out eval-results]
 *   npm run eval:kpi -- --fake [--case …]     # deterministic fake model: no key, no network, free
 *
 * Never uses a database: before anything loads the configuration, DATABASE_URL and DIRECT_URL are always replaced with
 * an unusable placeholder (whatever .env, the shell or CI set), the AiCall logger is replaced by an in-memory one, the
 * library comes from knowledge/indicator-library.json, and deps.ts / dbLibrarySource are never imported. The real run
 * refuses without a real ANTHROPIC_API_KEY and without --yes. Prints ids, counts and numbers only; never prompt,
 * document or model text.
 *
 * This module must not import anything that loads src/config/env.ts at the top: those modules are imported
 * dynamically after the environment is prepared.
 */
import nodePath from 'path';
import { parseArgs } from 'util';
import dotenv from 'dotenv';
import type { AiCallRecord } from '../src/services/ai/client';
import { safeErrorSummary } from '../src/services/ai/errors';
import { apiKeyProblem } from '../src/services/ai/keyCheck';
import { DEFAULT_EVAL_CASES_PATH, loadEvalCases, type EvalCase } from '../src/services/kpi/eval/cases';
import { evalPassed } from '../src/services/kpi/eval/metrics';
import { formatSummaryTable, writeReport } from '../src/services/kpi/eval/report';

/** What DATABASE_URL and DIRECT_URL always become: nothing listens on port 9, so a stray query fails at once. */
export const EVAL_DATABASE_PLACEHOLDER = 'postgresql://unused:unused@127.0.0.1:9/unused_eval';
/** ANTHROPIC_API_KEY in --fake mode (never a real key; ANTHROPIC_BASE_URL points at port 9 as well). */
export const FAKE_EVAL_API_KEY = 'sk-ant-fake-eval-placeholder';
/** ANTHROPIC_BASE_URL in --fake mode: a closed local port, so a stray real call fails at once (design 10.1). */
export const FAKE_EVAL_BASE_URL = 'http://127.0.0.1:9';
/** JWT secrets when missing (the configuration requires them; the evaluation never signs a token). */
export const EVAL_JWT_PLACEHOLDER = 'eval-placeholder-secret-never-used-0123456789';
/** Default spending cap of a real run in US dollars (design 10.1, §12 item 10). */
export const DEFAULT_MAX_USD = 3;
/** Default report directory (git-ignored; spec §A8 "eval-results/"). */
export const DEFAULT_OUT_DIR = 'eval-results';

/** Exit code when the run is complete and every target passed (design 10.3). */
export const EXIT_PASSED = 0;
/** Exit code when a target failed or the run is incomplete (design 10.3). */
export const EXIT_FAILED = 1;
/** Exit code of a refusal: one line, nothing written (design 10.1). */
export const EXIT_REFUSED = 2;

/** The parsed command-line options of npm run eval:kpi (design 10.1). */
export interface EvalCliArgs {
  yes: boolean;
  fake: boolean;
  /** --case, repeatable; [] = every case. */
  cases: string[];
  maxUsd: number;
  embeddings: boolean;
  /** False with --no-result-check. */
  resultCheck: boolean;
  out: string;
  help: boolean;
}

/** The --help text (design 10.1). */
export const USAGE = `Usage:
  npm run eval:kpi -- --yes [--case <id>]… [--max-usd ${DEFAULT_MAX_USD}] [--embeddings] [--no-result-check] [--out ${DEFAULT_OUT_DIR}]
  npm run eval:kpi -- --fake [--case <id>]… [--no-result-check] [--out ${DEFAULT_OUT_DIR}]
Runs knowledge/kpi-eval-cases.json through the KPI Assistant pipeline and prints a summary table.
  --yes              confirm the real run: it calls the Anthropic API (about US$1-2 for all 8 cases)
  --fake             deterministic fake model: no key, no network, free
  --case <id>        run only this case (repeatable)
  --max-usd <n>      start no new case once the spend reaches n US dollars (default ${DEFAULT_MAX_USD})
  --embeddings       vector retrieval: embeds the library in memory with Voyage (needs VOYAGE_API_KEY)
  --no-result-check  skip the result-scope latency run of each case
  --out <dir>        directory of the JSON report (default ${DEFAULT_OUT_DIR}, git-ignored)
Never uses a database. Exit codes: 0 every target passed, 1 a target failed or the run is incomplete, 2 refused.`;

/** Parses the options (util.parseArgs, strict): throws on an unknown option, a positional argument or a bad --max-usd. */
export function parseEvalArgs(argv: string[]): EvalCliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      yes: { type: 'boolean', default: false },
      fake: { type: 'boolean', default: false },
      case: { type: 'string', multiple: true },
      'max-usd': { type: 'string' },
      embeddings: { type: 'boolean', default: false },
      'no-result-check': { type: 'boolean', default: false },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  let maxUsd = DEFAULT_MAX_USD;
  if (values['max-usd'] !== undefined) {
    maxUsd = Number(values['max-usd']);
    if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error('--max-usd must be a positive number of US dollars');
  }
  const out = values.out?.trim();
  if (values.out !== undefined && !out) throw new Error('--out must name a directory');
  return {
    yes: values.yes === true,
    fake: values.fake === true,
    cases: (values.case ?? []).map(c => c.trim()).filter(Boolean),
    maxUsd,
    embeddings: values.embeddings === true,
    resultCheck: values['no-result-check'] !== true,
    out: out || DEFAULT_OUT_DIR,
    help: values.help === true,
  };
}

/**
 * Why the evaluation must not run (one line), or null (design 10.1): NODE_ENV=production; --embeddings with --fake
 * (the fake mode makes no network call); real mode with apiKeyProblem(ANTHROPIC_API_KEY) (missing, placeholder or not
 * sk-ant-…); real mode without --yes; --embeddings without VOYAGE_API_KEY. Never echoes a key.
 */
export function evalRefusal(args: EvalCliArgs, environment: Record<string, string | undefined>): string | null {
  if ((environment.NODE_ENV ?? '').trim() === 'production') return 'Refusing to run: NODE_ENV is "production"; the evaluation is a development tool.';
  if (args.fake && args.embeddings) return 'Refusing to run: --embeddings calls Voyage, so it cannot be combined with --fake (no network).';
  if (!args.fake) {
    const keyProblem = apiKeyProblem(environment.ANTHROPIC_API_KEY);
    if (keyProblem) return `Refusing to run: ${keyProblem} The real evaluation needs a real key; npm run eval:kpi -- --fake runs without one.`;
    if (!args.yes) return 'Refusing to run: this calls the real Anthropic API; about US$1-2 for all 8 cases; re-run with --yes.';
  }
  if (args.embeddings && !(environment.VOYAGE_API_KEY ?? '').trim()) return 'Refusing to run: --embeddings needs VOYAGE_API_KEY.';
  return null;
}

/**
 * Prepares process.env before anything loads the configuration (design 10.1, SDA-09): DATABASE_URL and DIRECT_URL are
 * always the unusable placeholder; the JWT secrets get a placeholder when missing or too short; in --fake mode the
 * Anthropic key is a placeholder and ANTHROPIC_BASE_URL points at a closed local port.
 */
export function prepareEvalEnvironment(args: Pick<EvalCliArgs, 'fake'>, environment: Record<string, string | undefined> = process.env): void {
  environment.DATABASE_URL = EVAL_DATABASE_PLACEHOLDER;
  environment.DIRECT_URL = EVAL_DATABASE_PLACEHOLDER;
  for (const name of ['JWT_SECRET', 'JWT_REFRESH_SECRET']) {
    if ((environment[name] ?? '').trim().length < 32) environment[name] = EVAL_JWT_PLACEHOLDER;
  }
  if (args.fake) {
    environment.ANTHROPIC_API_KEY = FAKE_EVAL_API_KEY;
    environment.ANTHROPIC_BASE_URL = FAKE_EVAL_BASE_URL;
  }
}

/** The cases to run: every case, or the --case ids in file order; throws naming an unknown id. */
export function selectCases(all: readonly EvalCase[], ids: readonly string[]): EvalCase[] {
  if (ids.length === 0) return [...all];
  const known = new Set(all.map(c => c.id));
  const unknown = ids.filter(id => !known.has(id));
  if (unknown.length > 0) throw new Error(`unknown case ${unknown.join(', ')} (known: ${all.map(c => c.id).join(', ')})`);
  const wanted = new Set(ids);
  return all.filter(c => wanted.has(c.id));
}

/**
 * The shared system prompt version the real calls used, from the in-memory AiCall records (the client builds and sends
 * that prompt; scripts never load it themselves: CLAUDE.md rule 4, tests/aiGuard.test.ts); null when no call reached the
 * client (--fake: the fake model gets no system prompt).
 */
export function systemPromptVersionOf(records: readonly Pick<AiCallRecord, 'systemPromptVersion'>[]): string | null {
  return records.find(r => r.systemPromptVersion)?.systemPromptVersion ?? null;
}

/** Output channels of runEvalCli (tests capture them; default console). */
export interface EvalCliIo {
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/** Runs the evaluation CLI and returns the exit code (0 passed, 1 failed or incomplete, 2 refused). */
export async function runEvalCli(argv: string[], io: EvalCliIo = {}): Promise<number> {
  const log = io.log ?? ((line: string) => console.log(line));
  const error = io.error ?? ((line: string) => console.error(line));

  let args: EvalCliArgs;
  try {
    args = parseEvalArgs(argv);
  } catch (err) {
    error(`Refusing to run: ${(err as Error).message}. See npm run eval:kpi -- --help.`);
    return EXIT_REFUSED;
  }
  if (args.help) {
    log(USAGE);
    return EXIT_PASSED;
  }

  // The keys may live in .env; dotenv never overrides variables the shell already set.
  dotenv.config();
  const refusal = evalRefusal(args, process.env);
  if (refusal) {
    error(refusal);
    return EXIT_REFUSED;
  }

  let cases: EvalCase[];
  let casesVersion: string;
  try {
    const file = loadEvalCases();
    casesVersion = file.version;
    cases = selectCases(file.cases, args.cases);
  } catch (err) {
    error(`Refusing to run: ${(err as Error).message}.`);
    return EXIT_REFUSED;
  }

  prepareEvalEnvironment(args);
  const { env } = await import('../src/config/env');
  if (env.databaseUrl !== EVAL_DATABASE_PLACEHOLDER) {
    error('Refusing to run: the configuration was loaded before the evaluation replaced DATABASE_URL; run the script on its own.');
    return EXIT_REFUSED;
  }

  const client = await import('../src/services/ai/client');
  const records: AiCallRecord[] = [];
  client.setAiCallLogger(async record => {
    records.push(record);
    return null;
  });
  try {
    const [{ runEval }, { fakeKpiModelCaller, FAKE_KPI_MODEL }, { fileLibrarySource, embedLibraryInMemory }, providers, { loadLibraryFile }] = await Promise.all([
      import('../src/services/kpi/eval/runner'),
      import('../src/services/kpi/eval/fakeModel'),
      import('../src/services/kpi/librarySource'),
      import('../src/services/ai/embeddingProviders'),
      import('../src/services/library/load'),
    ]);

    let library = fileLibrarySource();
    let embeddings: import('../src/services/ai/embeddingProviders').EmbeddingProvider = new providers.NoopEmbeddingProvider('keyword retrieval (no --embeddings)');
    if (args.embeddings) {
      embeddings = new providers.VoyageEmbeddingProvider({ apiKey: env.voyageApiKey ?? '', model: env.voyageModel });
      const vectors = await embedLibraryInMemory(await library.allEntries(), embeddings);
      if (!vectors) throw new Error('the library could not be embedded');
      library = fileLibrarySource({ vectors, model: embeddings.model ?? undefined });
      log(`Embedded ${vectors.size} library entries in memory (${embeddings.model}).`);
    }
    const callModel = args.fake
      ? fakeKpiModelCaller()
      : (await import('../src/services/kpi/callModel')).defaultModelCaller;

    log(`Running ${cases.length} case(s) in ${args.fake ? 'fake' : 'real'} mode${args.fake ? '' : ` (spending cap US$${args.maxUsd})`}…`);
    const report = await runEval({
      cases,
      deps: { library, embeddings, callModel, now: () => new Date() },
      maxUsd: args.maxUsd,
      resultCheck: args.resultCheck,
      now: () => new Date(),
      log,
      info: {
        mode: args.fake ? 'fake' : 'real',
        models: args.fake ? { main: FAKE_KPI_MODEL, fast: FAKE_KPI_MODEL } : { main: client.resolveModel('main'), fast: client.resolveModel('fast') },
        // Filled from the AiCall records after the run: only the client loads the shared system prompt (CLAUDE.md rule 4).
        systemPromptVersion: null,
        libraryVersion: loadLibraryFile().version,
        casesFile: { path: nodePath.relative(process.cwd(), DEFAULT_EVAL_CASES_PATH) || DEFAULT_EVAL_CASES_PATH, version: casesVersion },
        retrieval: args.embeddings ? 'vector' : 'keyword',
      },
    });

    report.systemPromptVersion = systemPromptVersionOf(records);
    const file = writeReport(nodePath.resolve(args.out), report);
    log('');
    log(formatSummaryTable(report));
    if (!args.fake) log(`AI calls logged in memory (no database): ${records.length}`);
    const relative = nodePath.relative(process.cwd(), file);
    log(`Saved ${relative && !relative.startsWith('..') ? relative : file}`);
    return evalPassed(report.summary) ? EXIT_PASSED : EXIT_FAILED;
  } catch (err) {
    error(`Evaluation failed: ${safeErrorSummary(err)}`);
    return EXIT_FAILED;
  } finally {
    client.setAiCallLogger(null);
  }
}

if (require.main === module) {
  runEvalCli(process.argv.slice(2))
    .then(code => { process.exitCode = code; })
    .catch(err => {
      console.error(`Evaluation failed: ${safeErrorSummary(err)}`);
      process.exitCode = EXIT_FAILED;
    });
}
