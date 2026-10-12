/**
 * Loads knowledge/indicator-library.json into the IndicatorLibraryEntry table.
 * Idempotent and non-destructive: creates missing entries, updates only entries
 * whose content changed, never deletes. Safe to run in any environment.
 *
 * With VOYAGE_API_KEY set, entries without an embedding are embedded (Voyage, VOYAGE_MODEL,
 * default voyage-4, 1024 dimensions); a second run embeds nothing. Without the key the
 * library is searched by keyword and no embedding is made.
 *
 *   npm run seed:library
 *   npm run seed:library -- path/to/draft-library.json   # check and load another file
 *   npm run seed:library -- --reembed                    # re-embed every entry (after changing VOYAGE_MODEL)
 */
import 'dotenv/config';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { getEmbeddingProvider } from '../src/services/ai/embeddings';
import { LibraryValidationError } from '../src/services/library/load';
import { seedLibrary } from '../src/services/library/seed';

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter(a => a.startsWith('--') && a !== '--reembed');
  if (unknown.length > 0) throw new Error(`unknown option ${unknown.join(', ')} (the only option is --reembed)`);
  const file = args.find(a => !a.startsWith('--'));

  const embeddings = getEmbeddingProvider();
  const r = await seedLibrary(prisma, { path: file ? path.resolve(file) : undefined, embeddings, reembedAll: args.includes('--reembed') });
  console.log(`Indicator library ${r.version}: ${r.total} entries (${r.created} created, ${r.updated} updated, ${r.unchanged} unchanged)`);

  if (r.embeddingsSkipped) {
    console.log(`Embeddings skipped: ${r.embeddingsSkipped}`);
  } else {
    const note = r.embedded === 0 && !r.embeddingError ? ' (every entry already has one)' : '';
    console.log(`Embeddings (${embeddings.name} ${embeddings.model}): ${r.embedded} embedded${note}`);
  }
  if (r.embeddingError) {
    console.error(`Embeddings failed: ${r.embeddingError}\nThe library content was saved; entries without an embedding are embedded on the next run.`);
    process.exitCode = 1;
  }
}

main()
  .catch(err => {
    if (err instanceof LibraryValidationError) console.error(err.message);
    else console.error('Indicator library seed failed:', err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
