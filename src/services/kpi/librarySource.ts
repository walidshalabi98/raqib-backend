/**
 * Where the KPI Assistant reads the indicator library from (design sections 2 and 4.3, D4): the database (production;
 * vectors read as `embedding::text`, no pgvector operator) or the seed file (eval and unit tests, no database).
 * No config/prisma or config/env import: the Prisma client is passed in.
 *
 * Step 0 stub (Phase 4 contracts): KPI_LIBRARY_SELECT and the signatures are final; E3 implements the bodies.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import type { EmbeddingProvider } from '../ai/embeddingProviders';
import type { KpiLibraryEntry, LibrarySource } from './types';

/** The KpiLibraryEntry fields of IndicatorLibraryEntry. */
export const KPI_LIBRARY_SELECT = {
  id: true, sector: true, tags: true, level: true, name: true, nameAr: true, definition: true, unit: true,
  calculation: true, direction: true, disaggregation: true, methods: true, frequency: true, meansOfVerification: true,
  standardReference: true, standardFramework: true, isStandard: true, notes: true,
} satisfies Prisma.IndicatorLibraryEntrySelect;

/**
 * Database source. vectors(): SELECT "id", "embedding"::text AS v FROM "IndicatorLibraryEntry"
 * WHERE "embeddingModel" = ${model} AND "embedding" IS NOT NULL AND "id" = ANY(${ids})
 * (no operator, no cast to vector: works with pgvector in public or in `extensions`).
 */
export function dbLibrarySource(_db: Pick<PrismaClient, 'indicatorLibraryEntry' | '$queryRaw'>): LibrarySource {
  throw new Error('Phase 4: not implemented (E3)');
}

/**
 * File source: loadLibraryFile() → toLibraryContent (library/seed.ts, the seeding mapping: standardFramework =
 * standardReference.framework, empty notes → null; Prisma.DbNull → null) → KpiLibraryEntry. No prisma/env import.
 */
export function fileLibrarySource(_opts?: { path?: string; vectors?: ReadonlyMap<string, number[]>; model?: string }): LibrarySource {
  throw new Error('Phase 4: not implemented (E3)');
}

/** Embeds the entries in memory (libraryEmbeddingText, input 'document'); null when the provider is not enabled. */
export async function embedLibraryInMemory(_entries: readonly KpiLibraryEntry[], _provider: EmbeddingProvider): Promise<Map<string, number[]> | null> {
  throw new Error('Phase 4: not implemented (E3)');
}

/** "[0.1,0.2,…]" (pgvector text form) → numbers; null when malformed. */
export function parseVectorText(_text: string): number[] | null {
  throw new Error('Phase 4: not implemented (E3)');
}
