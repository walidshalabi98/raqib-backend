/**
 * Loads knowledge/indicator-library.json into the IndicatorLibraryEntry table.
 * Idempotent and non-destructive: creates missing entries, updates only entries
 * whose content changed, never deletes. Safe to run in any environment.
 *
 * Needs DATABASE_URL only (not the API environment). With VOYAGE_API_KEY set, every entry
 * without a vector from VOYAGE_MODEL (default voyage-4, 1024 dimensions) is embedded: missing
 * vectors, and vectors made by another model, so a model change heals on the next run; a
 * second run embeds nothing. Without the key the library is searched by keyword.
 *
 *   npm run seed:library
 *   npm run seed:library -- path/to/draft-library.json   # check and load another file
 *   npm run seed:library -- --reembed                    # re-embed every entry, even up-to-date ones
 *
 * The logic lives in src/services/library/seedCli.ts, which never loads src/config/env.ts.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { runLibrarySeed } from '../src/services/library/seedCli';

const prisma = new PrismaClient();

runLibrarySeed(prisma, process.argv.slice(2), process.env)
  .then(code => {
    process.exitCode = code;
  })
  .finally(() => prisma.$disconnect());
