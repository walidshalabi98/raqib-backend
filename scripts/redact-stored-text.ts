/**
 * One-off backfill: removes phone numbers, ID numbers and email addresses from text stored before
 * Phase 3 (Document.parsedText and the string values of Document.aiAnalysis), and with
 * --include-qualitative from existing qualitative entries (title, content, location, facilitator).
 *
 *   npm run redact:backfill                                # dry run: prints totals, writes nothing
 *   npm run redact:backfill -- --apply                     # writes the changes (take a backup first)
 *   npm run redact:backfill -- --include-qualitative       # also existing qualitative entries
 *   npm run redact:backfill -- --verbose                   # also the ids of the rows that change
 *
 * Needs DATABASE_URL only (not the API environment) and a database with the Phase 3 schema.
 * Prints totals and ids only, never text or file names. A second --apply changes nothing.
 * The logic lives in src/services/maintenance/redactStoredText.ts, which never loads src/config/env.ts.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { runRedactStoredTextCli } from '../src/services/maintenance/redactStoredText';

const prisma = new PrismaClient();

runRedactStoredTextCli(prisma, process.argv.slice(2), process.env)
  .then(code => {
    process.exitCode = code;
  })
  .finally(() => prisma.$disconnect());
