/**
 * One-off backfill (owner decision, October 2026): removes phone numbers, ID numbers and email
 * addresses from text stored before Phase 3, when the parser did not redact yet:
 * Document.parsedText and every string value inside Document.aiAnalysis (keys, numbers, booleans
 * and null are kept exactly as stored). With --include-qualitative it also redacts the title,
 * content, location and facilitator of existing QualitativeEntry rows (entries saved since the
 * October 2026 change are redacted when saved). It uses redactPersonalData
 * (src/services/ai/redact.ts), the function the parser and the routes use, so text stored since
 * then does not change and a second run changes nothing.
 *
 *   npm run redact:backfill                                  # dry run (default): totals only, nothing is written
 *   npm run redact:backfill -- --apply                       # writes the changes (take a backup first)
 *   npm run redact:backfill -- --include-qualitative         # also existing qualitative entries
 *   npm run redact:backfill -- --verbose                     # also the ids of the rows that change
 *
 * Rows are read in id order, BATCH_SIZE at a time. A row is written only if the columns still hold
 * what was read (each UPDATE compares them), so a row edited or re-parsed while the script runs is
 * skipped, never overwritten; the summary then says to run the script again.
 *
 * Output: totals and, with --verbose, row ids. Never document text, model output, notes or file
 * names (CLAUDE.md rule 5). Kept free of the API configuration (src/config/env.ts): the CLI needs
 * DATABASE_URL alone.
 */
import type { PrismaClient } from '@prisma/client';
import { redactPersonalData, type RedactionCounts } from '../ai/redact';
import {
  addRedactions,
  noRedactions,
  QUALITATIVE_TEXT_FIELDS,
  redactionTotal,
  redactQualitativeFields,
  type QualitativeTextField,
} from '../qualitative/redactEntry';

/** Rows read per query. parsedText can be long, so batches stay small. */
export const REDACT_BACKFILL_BATCH_SIZE = 100;

/** The Phase 3 SQL that adds Document.aiAnalysis (and moves legacy analyses out of parsedText). */
export const PHASE3_SQL_FILE = 'prisma/sql/2026-10-12_phase3_ai_foundation.sql';

/** Columns this script needs that only the Phase 3 SQL adds. */
export const PHASE3_COLUMNS = ['Document.aiAnalysis'] as const;

/** The marker the pre-Phase 3 parser put between a document's text and its appended analysis. */
const LEGACY_ANALYSIS_MARKER = '---AI_ANALYSIS---';

/** Refusals with a message written here (safe to print); nothing was changed. */
export class RedactBackfillRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedactBackfillRefused';
  }
}

// ---------------------------------------------------------------------------------------------
// Pure functions (unit-tested)
// ---------------------------------------------------------------------------------------------

/**
 * Redacts every string value in a JSON text and copies everything else as it is: object keys,
 * numbers (with their exact digits), true/false/null, punctuation and whitespace. A value that
 * changes is written back with JSON.stringify. `json` must be valid JSON, as Postgres prints jsonb.
 *
 * Equivalent to walking the parsed value (objects and arrays recursively, strings redacted), but
 * a number is never parsed into a JavaScript double, so large or long numbers keep their digits.
 */
export function redactJsonText(json: string): { text: string; counts: RedactionCounts } {
  const counts = noRedactions();
  let out = '';
  let copied = 0;
  for (let i = 0; i < json.length; i++) {
    if (json[i] !== '"') continue;
    // In valid JSON a quote outside a string always opens one; find its closing quote.
    let end = i + 1;
    while (end < json.length && json[end] !== '"') end += json[end] === '\\' ? 2 : 1;
    // An object key is followed by ":" (after optional whitespace); a value never is.
    let next = end + 1;
    while (json[next] === ' ' || json[next] === '\n' || json[next] === '\r' || json[next] === '\t') next++;
    if (json[next] !== ':') {
      const value = JSON.parse(json.slice(i, end + 1)) as string;
      const redacted = redactPersonalData(value);
      if (redactionTotal(redacted.counts) > 0) {
        out += json.slice(copied, i) + JSON.stringify(redacted.text);
        copied = end + 1;
        addRedactions(counts, redacted.counts);
      }
    }
    i = end;
  }
  return { text: copied === 0 ? json : out + json.slice(copied), counts };
}

/** A Document row as the backfill reads it: aiAnalysis is the jsonb column as Postgres prints it. */
export interface StoredDocumentText {
  parsedText: string | null;
  aiAnalysis: string | null;
}

export interface DocumentRedactionPlan {
  /** The values to store (unchanged when nothing was found). */
  next: StoredDocumentText;
  parsedText: RedactionCounts;
  aiAnalysis: RedactionCounts;
  /** parsedText still holds a pre-Phase 3 analysis after '---AI_ANALYSIS---' (written by the old API after the Phase 3 SQL). */
  legacyMarker: boolean;
  /** That legacy analysis was a JSON object and no longer parses after redaction (a bare 9-digit number became a placeholder). */
  legacyAnalysisNoLongerJson: boolean;
}

/** Whether the text after the last legacy marker parses as JSON. */
function legacyAnalysisIsJson(parsedText: string): boolean {
  try {
    JSON.parse(parsedText.slice(parsedText.lastIndexOf(LEGACY_ANALYSIS_MARKER) + LEGACY_ANALYSIS_MARKER.length));
    return true;
  } catch {
    return false;
  }
}

/**
 * What the backfill does to one document: parsedText is redacted as plain text (also a legacy row
 * that still holds '---AI_ANALYSIS---' and an appended analysis), aiAnalysis with redactJsonText.
 */
export function planDocumentRedaction(row: StoredDocumentText): DocumentRedactionPlan {
  const parsed = row.parsedText === null ? { text: null, counts: noRedactions() } : redactPersonalData(row.parsedText);
  const analysis = row.aiAnalysis === null ? { text: null, counts: noRedactions() } : redactJsonText(row.aiAnalysis);
  const legacyMarker = row.parsedText !== null && row.parsedText.includes(LEGACY_ANALYSIS_MARKER);
  const legacyAnalysisNoLongerJson =
    legacyMarker && redactionTotal(parsed.counts) > 0 && legacyAnalysisIsJson(row.parsedText!) && !legacyAnalysisIsJson(parsed.text!);
  return {
    next: { parsedText: parsed.text, aiAnalysis: analysis.text },
    parsedText: parsed.counts,
    aiAnalysis: analysis.counts,
    legacyMarker,
    legacyAnalysisNoLongerJson,
  };
}

// ---------------------------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------------------------

/** The columns of `wanted` ("Table.column") that the database's current schema does not have. */
export async function missingColumns(prisma: PrismaClient, wanted: readonly string[]): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ name: string }[]>`
    SELECT table_name || '.' || column_name AS name
    FROM information_schema.columns
    WHERE table_schema = current_schema()`;
  const present = new Set(rows.map(r => r.name));
  return wanted.filter(column => !present.has(column));
}

/** The Phase 3 columns the backfill needs that are missing (none on a database with the Phase 3 schema). */
export function missingPhase3Columns(prisma: PrismaClient): Promise<string[]> {
  return missingColumns(prisma, PHASE3_COLUMNS);
}

export interface RedactStoredTextOptions {
  prisma: PrismaClient;
  /** Write the changes; otherwise a dry run that writes nothing. */
  apply?: boolean;
  /** Also redact existing QualitativeEntry rows (title, content, location, facilitator). */
  includeQualitative?: boolean;
  /** Also log the id of every row that changes, would change or was skipped. */
  verbose?: boolean;
  /** Rows per read (default REDACT_BACKFILL_BATCH_SIZE). */
  batchSize?: number;
  log?: (line: string) => void;
  /** The Phase 3 columns that are missing; default missingPhase3Columns. */
  checkSchema?: (prisma: PrismaClient) => Promise<string[]>;
}

interface TableReport {
  scanned: number;
  /** Rows with something to remove: changed (or, in a dry run, that would change) plus skipped. */
  found: number;
  /** Rows written (0 in a dry run). */
  changed: number;
  /** Rows edited by someone else between read and write, so not written (apply only). */
  skipped: number;
  /** Matches in the rows changed (dry run: in the rows that would change). */
  counts: RedactionCounts;
}

export interface DocumentBackfillReport extends TableReport {
  /** Documents whose parsedText changes (or would change). */
  parsedText: number;
  /** Documents whose aiAnalysis changes (or would change). */
  aiAnalysis: number;
  /** Documents whose parsedText still holds a legacy '---AI_ANALYSIS---' analysis. */
  legacyMarker: number;
  /** Of the documents that change, those whose legacy analysis no longer parses as JSON. */
  legacyAnalysisNoLongerJson: number;
}

export interface QualitativeBackfillReport extends TableReport {
  /** Entries per field that changes (or would change). */
  fields: Record<QualitativeTextField, number>;
}

export interface RedactStoredTextReport {
  apply: boolean;
  documents: DocumentBackfillReport;
  /** null when qualitative entries were not included. */
  qualitative: QualitativeBackfillReport | null;
}

function checkBatchSize(batchSize: number): void {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new RangeError(`batch size must be between 1 and 10000 (got ${batchSize})`);
  }
}

/** "parsedText, aiAnalysis (2 phone, 1 ID, 0 email)": field names and numbers only. */
function rowDetail(fields: string[], counts: RedactionCounts): string {
  return `${fields.join(', ')} (${counts.phone} phone, ${counts.idNumber} ID, ${counts.email} email)`;
}

async function redactDocuments(options: Required<Omit<RedactStoredTextOptions, 'checkSchema'>>): Promise<DocumentBackfillReport> {
  const { prisma, apply, verbose, batchSize, log } = options;
  const report: DocumentBackfillReport = {
    scanned: 0, found: 0, changed: 0, skipped: 0, counts: noRedactions(),
    parsedText: 0, aiAnalysis: 0, legacyMarker: 0, legacyAnalysisNoLongerJson: 0,
  };
  let cursor = '';
  for (;;) {
    // aiAnalysis as Postgres prints it: compared and redacted as text, so numbers keep their digits.
    const rows = await prisma.$queryRaw<({ id: string } & StoredDocumentText)[]>`
      SELECT "id", "parsedText", "aiAnalysis"::text AS "aiAnalysis"
      FROM "Document"
      WHERE "id" > ${cursor}
      ORDER BY "id"
      LIMIT ${batchSize}`;
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      report.scanned++;
      const plan = planDocumentRedaction(row);
      if (plan.legacyMarker) report.legacyMarker++;
      const fields = [
        ...(redactionTotal(plan.parsedText) > 0 ? ['parsedText'] : []),
        ...(redactionTotal(plan.aiAnalysis) > 0 ? ['aiAnalysis'] : []),
      ];
      if (fields.length === 0) continue;
      report.found++;
      const counts = addRedactions(addRedactions(noRedactions(), plan.parsedText), plan.aiAnalysis);

      if (apply) {
        // Written only if neither column changed since it was read (jsonb compared by value).
        const written = await prisma.$executeRaw`
          UPDATE "Document"
          SET "parsedText" = ${plan.next.parsedText}::text, "aiAnalysis" = ${plan.next.aiAnalysis}::jsonb
          WHERE "id" = ${row.id}
            AND "parsedText" IS NOT DISTINCT FROM ${row.parsedText}::text
            AND "aiAnalysis" IS NOT DISTINCT FROM ${row.aiAnalysis}::jsonb`;
        if (written === 0) {
          report.skipped++;
          if (verbose) log(`  document ${row.id}: skipped (changed while the script ran)`);
          continue;
        }
        report.changed++;
      }
      if (fields.includes('parsedText')) report.parsedText++;
      if (fields.includes('aiAnalysis')) report.aiAnalysis++;
      if (plan.legacyAnalysisNoLongerJson) report.legacyAnalysisNoLongerJson++;
      addRedactions(report.counts, counts);
      if (verbose) log(`  document ${row.id}: ${rowDetail(fields, counts)}`);
    }
  }
  return report;
}

async function redactQualitativeEntries(options: Required<Omit<RedactStoredTextOptions, 'checkSchema'>>): Promise<QualitativeBackfillReport> {
  const { prisma, apply, verbose, batchSize, log } = options;
  const report: QualitativeBackfillReport = {
    scanned: 0, found: 0, changed: 0, skipped: 0, counts: noRedactions(),
    fields: { title: 0, content: 0, location: 0, facilitator: 0 },
  };
  let cursor = '';
  for (;;) {
    const rows = await prisma.qualitativeEntry.findMany({
      where: { id: { gt: cursor } },
      orderBy: { id: 'asc' },
      take: batchSize,
      select: { id: true, title: true, content: true, location: true, facilitator: true },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      report.scanned++;
      const { id, ...stored } = row;
      const { values: next, counts } = redactQualitativeFields(stored);
      if (redactionTotal(counts) === 0) continue;
      report.found++;
      const fields = QUALITATIVE_TEXT_FIELDS.filter(field => next[field] !== stored[field]);

      if (apply) {
        // Written only if none of the four fields changed since it was read.
        const { count } = await prisma.qualitativeEntry.updateMany({ where: { id, ...stored }, data: next });
        if (count === 0) {
          report.skipped++;
          if (verbose) log(`  qualitative entry ${id}: skipped (changed while the script ran)`);
          continue;
        }
        report.changed++;
      }
      for (const field of fields) report.fields[field]++;
      addRedactions(report.counts, counts);
      if (verbose) log(`  qualitative entry ${id}: ${rowDetail(fields, counts)}`);
    }
  }
  return report;
}

/**
 * Runs the backfill (see the file comment). Throws RedactBackfillRefused, before reading any row,
 * when the Phase 3 columns are missing. Logs ids only with `verbose`; never any text.
 */
export async function redactStoredText(options: RedactStoredTextOptions): Promise<RedactStoredTextReport> {
  const {
    prisma, apply = false, includeQualitative = false, verbose = false, batchSize = REDACT_BACKFILL_BATCH_SIZE,
    log = line => console.log(line), checkSchema = missingPhase3Columns,
  } = options;
  checkBatchSize(batchSize);
  const missing = await checkSchema(prisma);
  if (missing.length > 0) {
    throw new RedactBackfillRefused(
      `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing: this database does not have the Phase 3 schema. ` +
      `Apply ${PHASE3_SQL_FILE} first (docs/DATA_MODEL.md §9), then run this again. Nothing was changed.`,
    );
  }
  const run = { prisma, apply, includeQualitative, verbose, batchSize, log };
  const documents = await redactDocuments(run);
  const qualitative = includeQualitative ? await redactQualitativeEntries(run) : null;
  return { apply, documents, qualitative };
}

// ---------------------------------------------------------------------------------------------
// CLI (scripts/redact-stored-text.ts)
// ---------------------------------------------------------------------------------------------

const CLI_OPTIONS = ['--apply', '--include-qualitative', '--verbose'];

function countsLine(counts: RedactionCounts): string {
  return `${counts.phone} phone numbers, ${counts.idNumber} ID numbers, ${counts.email} email addresses`;
}

/** The summary lines of a report: totals only. */
export function summaryLines(report: RedactStoredTextReport): string[] {
  const verb = report.apply ? 'changed' : 'would change';
  const d = report.documents;
  const lines = [
    `Documents: ${d.scanned} scanned, ${report.apply ? d.changed : d.found} ${verb} (parsedText ${d.parsedText}, aiAnalysis ${d.aiAnalysis})` +
      `${report.apply ? `, ${d.skipped} skipped` : ''}; ${report.apply ? 'removed' : 'to remove'}: ${countsLine(d.counts)}.`,
  ];
  if (d.legacyMarker > 0) {
    lines.push(
      `  ${d.legacyMarker} document(s) still hold a legacy '${LEGACY_ANALYSIS_MARKER}' analysis in parsedText; it is redacted as plain text.` +
        (d.legacyAnalysisNoLongerJson > 0
          ? ` In ${d.legacyAnalysisNoLongerJson} of them that analysis no longer parses as JSON afterwards (a bare 9-digit number became a placeholder), so readers use the document text instead.`
          : ''),
    );
  }
  const q = report.qualitative;
  if (q) {
    const f = q.fields;
    lines.push(
      `Qualitative entries: ${q.scanned} scanned, ${report.apply ? q.changed : q.found} ${verb} (title ${f.title}, content ${f.content}, location ${f.location}, facilitator ${f.facilitator})` +
        `${report.apply ? `, ${q.skipped} skipped` : ''}; ${report.apply ? 'removed' : 'to remove'}: ${countsLine(q.counts)}.`,
    );
  } else {
    lines.push('Qualitative entries: not included (add --include-qualitative to redact existing entries too).');
  }
  const skipped = d.skipped + (q?.skipped ?? 0);
  if (skipped > 0) lines.push(`${skipped} row(s) changed while the script ran and were not written: run the script again.`);
  if (!report.apply) {
    const found = d.found + (q?.found ?? 0);
    lines.push(found > 0 ? 'Dry run: nothing was changed. Take a backup, then run again with --apply to write these changes.' : 'Dry run: nothing was changed, and there is nothing to change.');
  }
  return lines;
}

export interface RedactStoredTextOutput {
  log: (line: string) => void;
  error: (line: string) => void;
}

/**
 * `npm run redact:backfill` (scripts/redact-stored-text.ts). Returns the exit code: 0 (also when
 * rows were skipped; the summary says to run again), or 1 for an unknown argument, a missing
 * DATABASE_URL, a database without the Phase 3 columns, or a database error (reported by class
 * name and Prisma code only: database messages can quote stored values).
 */
export async function runRedactStoredTextCli(
  prisma: PrismaClient,
  args: readonly string[],
  env: Record<string, string | undefined>,
  out: RedactStoredTextOutput = { log: line => console.log(line), error: line => console.error(line) },
  options: Pick<RedactStoredTextOptions, 'batchSize' | 'checkSchema'> = {},
): Promise<number> {
  const unknown = args.filter(a => !CLI_OPTIONS.includes(a));
  if (unknown.length > 0) {
    out.error(`Redact stored text: unknown argument ${unknown.join(', ')} (options: ${CLI_OPTIONS.join(', ')})`);
    return 1;
  }
  if (!env.DATABASE_URL?.trim()) {
    out.error('Redact stored text: DATABASE_URL is required (set it in .env or the environment). Nothing was changed.');
    return 1;
  }
  const apply = args.includes('--apply');
  out.log(apply
    ? 'Redact stored text: --apply writes the changes. Make sure a backup of this database was taken first (on Supabase: a recent backup or a pg_dump).'
    : 'Redact stored text: dry run, nothing is written. Take a backup of the database before running with --apply.');

  try {
    const report = await redactStoredText({
      prisma,
      apply,
      includeQualitative: args.includes('--include-qualitative'),
      verbose: args.includes('--verbose'),
      log: out.log,
      ...options,
    });
    for (const line of summaryLines(report)) out.log(line);
    return 0;
  } catch (err) {
    if (err instanceof RedactBackfillRefused) {
      out.error(`Redact stored text: ${err.message}`);
      return 1;
    }
    const code = (err as { code?: unknown } | null)?.code ?? (err as { errorCode?: unknown } | null)?.errorCode;
    const name = err instanceof Error ? err.name : 'unknown error';
    out.error(`Redact stored text failed: ${name}${typeof code === 'string' ? ` (${code})` : ''}. Rows written before the error stay redacted; run the script again.`);
    return 1;
  }
}
