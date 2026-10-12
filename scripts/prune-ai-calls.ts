/**
 * Deletes AiCall log rows older than the retention period (AI_CALL_RETENTION_MONTHS, default 24
 * calendar months). The worker does this every night; this script runs it by hand.
 *
 *   npm run ai-calls:prune             # dry run: prints the cutoff and how many rows are older
 *   npm run ai-calls:prune -- --apply  # deletes them, in batches of 5000
 *
 * Needs DATABASE_URL only (not the API environment). Prints numbers only, never row contents.
 * The logic lives in src/services/maintenance/aiCallRetention.ts, which never loads src/config/env.ts.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { runAiCallPruneCli } from '../src/services/maintenance/aiCallRetention';

const prisma = new PrismaClient();

runAiCallPruneCli(prisma, process.argv.slice(2), process.env)
  .then(code => {
    process.exitCode = code;
  })
  .finally(() => prisma.$disconnect());
