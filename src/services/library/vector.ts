/**
 * pgvector helpers. Kept free of the API configuration (src/config/env.ts) so the library
 * seed, which `npm run seed` also runs, needs only DATABASE_URL; the embedding providers live
 * in src/services/ai/embeddingProviders.ts (re-exported, with these, by embeddings.ts).
 */
import { Prisma } from '@prisma/client';

/** Matches IndicatorLibraryEntry.embedding vector(1024) (Voyage voyage-4 with output_dimension 1024). */
export const EMBEDDING_DIMENSIONS = 1024;

/** pgvector text form, '[0.1,0.2,…]', cast with the column type (see libraryVectorType) in raw SQL. Rejects empty vectors and non-finite numbers. */
export function toVectorLiteral(vector: readonly number[]): string {
  if (!Array.isArray(vector) || vector.length === 0) throw new RangeError('A vector needs at least one number');
  for (let i = 0; i < vector.length; i++) {
    if (typeof vector[i] !== 'number' || !Number.isFinite(vector[i])) {
      throw new RangeError(`Vector value [${i}] is not a finite number`);
    }
  }
  return `[${vector.join(',')}]`;
}

/**
 * The type names format_type() can give the embedding column: `vector(1024)` when pgvector's
 * schema is on the search path, otherwise schema-qualified (`extensions.vector(1024)`, or a
 * quoted schema such as `"Extensions".vector(1024)`). Nothing else is ever spliced into SQL.
 */
const VECTOR_TYPE = new RegExp(`^(?:(?:[a-z_][a-z0-9_]*|"[A-Za-z_][A-Za-z0-9_]*")\\.)?vector\\(${EMBEDDING_DIMENSIONS}\\)$`);

/** True for a vector(1024) type name as format_type() writes it, optionally schema-qualified. */
export function isLibraryVectorType(type: string): boolean {
  return VECTOR_TYPE.test(type);
}

/** The column type as raw SQL for a cast (`${literal}::${vectorTypeSql(type)}`). Throws for anything but an allowed vector(1024) name. */
export function vectorTypeSql(type: string): Prisma.Sql {
  if (!isLibraryVectorType(type)) {
    throw new Error(`the IndicatorLibraryEntry.embedding column has type ${JSON.stringify(type).slice(0, 80)}; expected vector(${EMBEDDING_DIMENSIONS})`);
  }
  return Prisma.raw(type);
}

/**
 * The type of IndicatorLibraryEntry.embedding as this connection must write it, ready for a cast.
 *
 * A bare `::vector` depends on the search path. On Supabase pgvector lives in the `extensions`
 * schema, and Prisma sets search_path to the URL's `schema` parameter (`?schema=public`), so
 * `vector` is not found there. format_type() names the column's own type and qualifies it with
 * its schema whenever that schema is not on the search path. Look it up once per run (the same
 * connection settings apply to every pooled connection). Throws when the column is missing or
 * is not vector(1024).
 */
export async function libraryVectorType(db: Pick<Prisma.TransactionClient, '$queryRaw'>): Promise<Prisma.Sql> {
  const rows = await db.$queryRaw<{ type: string }[]>`
    SELECT format_type(a.atttypid, a.atttypmod) AS type
    FROM pg_attribute a
    WHERE a.attrelid = to_regclass('"IndicatorLibraryEntry"') AND a.attname = 'embedding' AND NOT a.attisdropped`;
  if (rows.length === 0) throw new Error('the IndicatorLibraryEntry.embedding column was not found (is the Phase 2 migration applied?)');
  return vectorTypeSql(rows[0].type);
}
