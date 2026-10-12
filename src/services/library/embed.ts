import { Prisma, PrismaClient } from '@prisma/client';
// Type-only: the provider module reads the API env; the library seed must not need it.
import type { EmbeddingProvider } from '../ai/embeddings';
import { EMBEDDING_DIMENSIONS, toVectorLiteral } from './vector';

/** Entries per embed() call; each batch is stored before the next is sent, so a failure keeps the earlier batches. */
export const LIBRARY_EMBED_BATCH = 128;

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

/** Ids among `ids` whose embedding is NULL (sorted). */
export async function findLibraryIdsWithoutEmbedding(prisma: PrismaClient, ids: readonly string[]): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "IndicatorLibraryEntry" WHERE embedding IS NULL ORDER BY id`;
  const wanted = new Set(ids);
  return rows.map(r => r.id).filter(id => wanted.has(id));
}

export interface EmbedLibraryResult {
  /** Entries whose vector was stored. */
  embedded: number;
  /** Why embedding stopped early (the batches before it are stored), or null. Never contains library text. */
  error: string | null;
}

/**
 * Embeds the given library entries (input type "document") and stores the vectors with
 * `::vector`. Raw updates leave updatedAt alone: an embedding is not a content change.
 * Does nothing for a disabled provider. A failure stops the run and is returned, not thrown;
 * entries left without a vector are picked up by the next seed run.
 */
export async function embedLibraryEntries(
  prisma: PrismaClient,
  provider: EmbeddingProvider,
  ids: readonly string[],
  options: { batchSize?: number } = {},
): Promise<EmbedLibraryResult> {
  if (!provider.enabled || ids.length === 0) return { embedded: 0, error: null };
  if (provider.dimensions !== EMBEDDING_DIMENSIONS) {
    return { embedded: 0, error: `the ${provider.name} provider makes ${provider.dimensions}-dimension vectors; the library column holds ${EMBEDDING_DIMENSIONS}` };
  }

  const entries = await prisma.indicatorLibraryEntry.findMany({
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
      const literals = vectors.map((vector, i) => {
        if (vector.length !== EMBEDDING_DIMENSIONS) throw new Error(`vector for ${batch[i].id} has ${vector.length} dimensions (expected ${EMBEDDING_DIMENSIONS})`);
        return toVectorLiteral(vector);
      });
      await prisma.$transaction(batch.map((entry, i) =>
        prisma.$executeRaw`UPDATE "IndicatorLibraryEntry" SET embedding = ${literals[i]}::vector WHERE id = ${entry.id}`));
      embedded += batch.length;
    } catch (err) {
      return { embedded, error: describeEmbeddingFailure(err) };
    }
  }
  return { embedded, error: null };
}

/** Clears the stored vectors of these entries (their embedded text changed). For use inside a transaction. */
export function clearLibraryEmbeddings(prisma: PrismaClient, ids: readonly string[]) {
  return prisma.$executeRaw`UPDATE "IndicatorLibraryEntry" SET embedding = NULL WHERE id IN (${Prisma.join([...ids])})`;
}

function describeEmbeddingFailure(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}
