/**
 * pgvector helpers. Kept free of the API configuration (src/config/env.ts) so the library
 * seed, which `npm run seed` also runs, needs only DATABASE_URL; the embedding provider
 * itself lives in src/services/ai/embeddings.ts (which re-exports these).
 */

/** Matches IndicatorLibraryEntry.embedding vector(1024) (Voyage voyage-4 with output_dimension 1024). */
export const EMBEDDING_DIMENSIONS = 1024;

/** pgvector text form, '[0.1,0.2,…]', for `${literal}::vector` in raw SQL. Rejects empty vectors and non-finite numbers. */
export function toVectorLiteral(vector: readonly number[]): string {
  if (!Array.isArray(vector) || vector.length === 0) throw new RangeError('A vector needs at least one number');
  for (let i = 0; i < vector.length; i++) {
    if (typeof vector[i] !== 'number' || !Number.isFinite(vector[i])) {
      throw new RangeError(`Vector value [${i}] is not a finite number`);
    }
  }
  return `[${vector.join(',')}]`;
}
