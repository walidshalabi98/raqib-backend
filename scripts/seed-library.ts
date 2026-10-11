/**
 * Loads knowledge/indicator-library.json into the IndicatorLibraryEntry table.
 * Idempotent and non-destructive: creates missing entries, updates only entries
 * whose content changed, never deletes. Safe to run in any environment.
 *
 *   npm run seed:library
 *   npm run seed:library -- path/to/draft-library.json   # check and load another file
 */
import 'dotenv/config';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { LibraryValidationError } from '../src/services/library/load';
import { seedLibrary } from '../src/services/library/seed';

const prisma = new PrismaClient();

async function main() {
  const file = process.argv[2];
  const r = await seedLibrary(prisma, { path: file ? path.resolve(file) : undefined });
  console.log(`Indicator library ${r.version}: ${r.total} entries (${r.created} created, ${r.updated} updated, ${r.unchanged} unchanged)`);
}

main()
  .catch(err => {
    if (err instanceof LibraryValidationError) console.error(err.message);
    else console.error('Indicator library seed failed:', err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
