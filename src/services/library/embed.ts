import { Prisma, PrismaClient } from '@prisma/client';
// The env-free provider module: the library seed must run with DATABASE_URL alone.
import type { EmbeddingProvider } from '../ai/embeddingProviders';
import { EMBEDDING_DIMENSIONS, libraryVectorType, toVectorLiteral } from './vector';

/** Entries per embed() call; each batch is stored before the next is sent, so a failure keeps the earlier batches. */
export const LIBRARY_EMBED_BATCH = 128;

/** A Prisma client or an interactive transaction: the embedding queries need no $transaction. */
export type LibraryDb = Prisma.TransactionClient;

type EmbeddableEntry = { name?: string | null; nameAr?: string | null; definition?: string | null; tags?: string[] | null };

/**
 * The text embedded for a library entry: English name, Arabic name, definition and tags
 * (underscores read as spaces). Library text is reference material with no personal data.
 */
export function libraryEmbeddingText(entry: EmbeddableEntry): string {
  const tags = (entry.tags ?? []).map(t => t.replace(/_/g, ' ').trim()).filter(Boolean);
  return [entry.name, entry.nameAr, entry.definition, tags.length > 0 ? `Tags: ${tags.join(', ')}` : '']
    .map(part => (part ?? '').trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * Ids of the stored entries (sorted) that need a vector from `model`: no embedding yet, or one
 * made by another model (or recorded without a model). Vectors of different models cannot be
 * compared, so a model change, or a re-embed that failed half way, heals on the next plain run.
 * Covers every stored entry, including those kept after leaving the library file.
 */
export async function findLibraryIdsToEmbed(db: LibraryDb, model: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM "IndicatorLibraryEntry"
    WHERE embedding IS NULL OR "embeddingModel" IS DISTINCT FROM ${model}
    ORDER BY id`;
  return rows.map(r => r.id);
}

/** Ids of every stored entry (sorted), for a forced re-embed. */
export async function allLibraryIds(db: LibraryDb): Promise<string[]> {
  const rows = await db.indicatorLibraryEntry.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
  return rows.map(r => r.id);
}

export interface EmbedLibraryResult {
  /** Entries whose vector was stored. */
  embedded: number;
  /** Why embedding stopped early (the batches before it are stored), or null. Never contains library text. */
  error: string | null;
}

/**
 * Embeds the given library entries (input type "document") and stores each vector with the
 * provider's model in `embeddingModel`. The vectors are cast to the column's own type, looked up
 * once per call (libraryVectorType), so pgvector may live in a schema that is not on the search
 * path (Supabase's `extensions`). Raw updates leave updatedAt alone: an embedding is not a
 * content change. Each batch is one UPDATE, so it is stored whole or not at all.
 * Does nothing for a disabled provider. A failure stops the run and is returned, not thrown;
 * entries left without a current vector are picked up by the next seed run.
 */
export async function embedLibraryEntries(
  db: LibraryDb,
  provider: EmbeddingProvider,
  ids: readonly string[],
  options: { batchSize?: number } = {},
): Promise<EmbedLibraryResult> {
  if (!provider.enabled || ids.length === 0) return { embedded: 0, error: null };
  if (provider.dimensions !== EMBEDDING_DIMENSIONS) {
    return { embedded: 0, error: `the ${provider.name} provider makes ${provider.dimensions}-dimension vectors; the library column holds ${EMBEDDING_DIMENSIONS}` };
  }
  const model = provider.model?.trim();
  if (!model) return { embedded: 0, error: `the ${provider.name} provider names no model; every stored vector records the model that made it` };

  let vectorType: Prisma.Sql;
  try {
    vectorType = await libraryVectorType(db);
  } catch (err) {
    return { embedded: 0, error: describeEmbeddingFailure(err) };
  }

  const entries = await db.indicatorLibraryEntry.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, name: true, nameAr: true, definition: true, tags: true },
    orderBy: { id: 'asc' },
  });
  const batchSize = Math.max(1, options.batchSize ?? LIBRARY_EMBED_BATCH);
  let embedded = 0;

  for (let start = 0; start < entries.length; start += batchSize) {
    const batch = entries.slice(start, start + batchSize);
    try {
      const vectors = await provider.embed(batch.map(libraryEmbeddingText), 'document');
      if (!vectors) throw new Error(`the ${provider.name} provider returned no vectors`);
      if (vectors.length !== batch.length) throw new Error(`the ${provider.name} provider returned ${vectors.length} vectors for ${batch.length} entries`);
      const rows = vectors.map((vector, i) => {
        if (vector.length !== EMBEDDING_DIMENSIONS) throw new Error(`vector for ${batch[i].id} has ${vector.length} dimensions (expected ${EMBEDDING_DIMENSIONS})`);
        return Prisma.sql`(${batch[i].id}, ${toVectorLiteral(vector)})`;
      });
      embedded += await db.$executeRaw`
        UPDATE "IndicatorLibraryEntry" AS e
        SET embedding = v.vector::${vectorType}, "embeddingModel" = ${model}
        FROM (VALUES ${Prisma.join(rows)}) AS v(id, vector)
        WHERE e.id = v.id`;
    } catch (err) {
      return { embedded, error: describeEmbeddingFailure(err) };
    }
  }
  return { embedded, error: null };
}

/** Clears the stored vectors, and the model that made them, of these entries (their embedded text changed). For use inside a transaction. */
export function clearLibraryEmbeddings(prisma: PrismaClient, ids: readonly string[]) {
  return prisma.$executeRaw`UPDATE "IndicatorLibraryEntry" SET embedding = NULL, "embeddingModel" = NULL WHERE id IN (${Prisma.join([...ids])})`;
}

function describeEmbeddingFailure(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}
