/**
 * `npm run seed:library` (scripts/seed-library.ts). Kept free of the API configuration
 * (src/config/env.ts): the library loads into any database with DATABASE_URL alone, plus
 * VOYAGE_API_KEY and VOYAGE_MODEL to embed it. JWT secrets, ANTHROPIC_API_KEY and the Supabase
 * storage settings are not needed.
 */
import nodePath from 'path';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { createEmbeddingProvider, DEFAULT_VOYAGE_MODEL, type EmbeddingSettings } from '../ai/embeddingProviders';
import { LibraryValidationError } from './load';
import { seedLibrary } from './seed';

/** Trimmed; unset or blank reads as missing (so `NAME=` in .env behaves like a missing line), as in src/config/env.ts. */
const setting = (schema: z.ZodTypeAny) =>
  z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined), schema);

const settingsSchema = z.object({
  DATABASE_URL: setting(z.string({ required_error: 'is required' })),
  VOYAGE_API_KEY: setting(z.string().optional()),
  VOYAGE_MODEL: setting(z.string().default(DEFAULT_VOYAGE_MODEL)),
});

/** The settings `npm run seed:library` reads: DATABASE_URL (read by Prisma; checked here for a clear message) and the Voyage settings. */
export function librarySeedSettings(env: Record<string, string | undefined>): EmbeddingSettings {
  const parsed = settingsSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`invalid configuration: ${parsed.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  }
  return { voyageApiKey: parsed.data.VOYAGE_API_KEY ?? null, voyageModel: parsed.data.VOYAGE_MODEL };
}

export interface LibrarySeedOutput {
  log: (line: string) => void;
  error: (line: string) => void;
}

/**
 * Loads the library file (default knowledge/indicator-library.json, or the one path argument)
 * and embeds what needs it. `--reembed` re-embeds every entry. Returns the exit code: 0, or 1
 * for invalid input, an invalid file or an embedding failure (the content is saved even then).
 */
export async function runLibrarySeed(
  prisma: PrismaClient,
  args: readonly string[],
  env: Record<string, string | undefined>,
  out: LibrarySeedOutput = { log: line => console.log(line), error: line => console.error(line) },
): Promise<number> {
  try {
    const unknown = args.filter(a => a.startsWith('--') && a !== '--reembed');
    if (unknown.length > 0) throw new Error(`unknown option ${unknown.join(', ')} (the only option is --reembed)`);
    const files = args.filter(a => !a.startsWith('--'));
    if (files.length > 1) throw new Error(`give at most one library file (got ${files.length})`);

    const embeddings = createEmbeddingProvider(librarySeedSettings(env));
    const reembedAll = args.includes('--reembed');
    const r = await seedLibrary(prisma, {
      path: files[0] ? nodePath.resolve(files[0]) : undefined,
      embeddings,
      reembedAll,
      logger: { warn: out.error },
    });
    out.log(`Indicator library ${r.version}: ${r.total} entries (${r.created} created, ${r.updated} updated, ${r.unchanged} unchanged)`);

    if (r.embeddingsSkipped) {
      out.log(`Embeddings skipped: ${r.embeddingsSkipped}`);
      return 0;
    }
    const note = r.embedded === 0 && !r.embeddingError ? ` (every entry already has a ${embeddings.model} embedding)` : '';
    out.log(`Embeddings (${embeddings.name} ${embeddings.model}): ${r.embedded} embedded${note}`);
    if (r.embeddingError) {
      out.error(`Embeddings failed: ${r.embeddingError}`);
      out.error(`The library content was saved. Entries without a ${embeddings.model} embedding${reembedAll ? ' (including those the re-embed did not reach)' : ''} are embedded on the next run.`);
      return 1;
    }
    return 0;
  } catch (err) {
    if (err instanceof LibraryValidationError) out.error(err.message);
    else out.error(`Indicator library seed failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
