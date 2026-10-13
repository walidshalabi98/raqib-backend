/**
 * Where the KPI Assistant reads the indicator library from (design sections 2 and 4.3, D4; spec §A4 step 1): the
 * database (production; vectors read as `embedding::text`, no pgvector operator) or the seed file (eval and unit tests,
 * no database). No config/prisma or config/env import: the Prisma client is passed in (tests/kpiPurity.test.ts).
 */
import { Prisma } from '@prisma/client';
import type { CollectionMethod, Frequency, IndicatorDirection, IndicatorLevel, PrismaClient, Sector } from '@prisma/client';
import type { EmbeddingProvider } from '../ai/embeddingProviders';
import { libraryEmbeddingText } from '../library/embed';
import { loadLibraryFile } from '../library/load';
import { toLibraryContent } from '../library/seed';
import type { KpiLibraryEntry, LibrarySource } from './types';

/** The KpiLibraryEntry fields of IndicatorLibraryEntry. */
export const KPI_LIBRARY_SELECT = {
  id: true, sector: true, tags: true, level: true, name: true, nameAr: true, definition: true, unit: true,
  calculation: true, direction: true, disaggregation: true, methods: true, frequency: true, meansOfVerification: true,
  standardReference: true, standardFramework: true, isStandard: true, notes: true,
} satisfies Prisma.IndicatorLibraryEntrySelect;

/** "[0.1,0.2,…]" (pgvector text form) → numbers; null when malformed, empty or holding a non-finite number. */
export function parseVectorText(text: string): number[] | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  const body = trimmed.slice(1, -1).trim();
  if (body === '') return null;
  const values = body.split(',').map(part => (part.trim() === '' ? Number.NaN : Number(part)));
  return values.every(Number.isFinite) ? values : null;
}

/**
 * Database source (production). allEntries(): every IndicatorLibraryEntry with KPI_LIBRARY_SELECT, by id.
 * vectors(): SELECT "id", "embedding"::text AS v FROM "IndicatorLibraryEntry"
 * WHERE "embeddingModel" = ${model} AND "embedding" IS NOT NULL AND "id" = ANY(${ids})
 * (no operator, no cast to vector: works with pgvector in public or in `extensions`; D4). Malformed vectors are left out.
 */
export function dbLibrarySource(db: Pick<PrismaClient, 'indicatorLibraryEntry' | '$queryRaw'>): LibrarySource {
  return {
    async allEntries(): Promise<KpiLibraryEntry[]> {
      return db.indicatorLibraryEntry.findMany({ select: KPI_LIBRARY_SELECT, orderBy: { id: 'asc' } });
    },
    async vectors(model: string, ids: readonly string[]): Promise<Map<string, number[]>> {
      const out = new Map<string, number[]>();
      if (!model || ids.length === 0) return out;
      const rows = await db.$queryRaw<Array<{ id: string; v: string }>>`
        SELECT "id", "embedding"::text AS v FROM "IndicatorLibraryEntry"
        WHERE "embeddingModel" = ${model} AND "embedding" IS NOT NULL AND "id" = ANY(${[...ids]})`;
      for (const row of rows) {
        const vector = parseVectorText(row.v);
        if (vector) out.set(row.id, vector);
      }
      return out;
    },
  };
}

/** Prisma's DbNull/JsonNull (how toLibraryContent writes a JSON null) as a plain null, as the database returns it. */
const jsonValue = (value: unknown): unknown => (value === Prisma.DbNull || value === Prisma.JsonNull || value === undefined ? null : value);

/** An array field of LibraryContent (typed as a Prisma create input) as the plain array it always is. */
const list = <T>(value: unknown): T[] => (Array.isArray(value) ? [...value] as T[] : []);

/**
 * File source (eval and unit tests): loadLibraryFile() → toLibraryContent (library/seed.ts, the seeding mapping:
 * standardFramework = standardReference.framework, empty notes → null; Prisma.DbNull → null) → KpiLibraryEntry, so it
 * equals what seedLibrary stores (design m3). The file is read once, on first use. vectors(): the given in-memory
 * vectors (e.g. from embedLibraryInMemory) when `model` matches opts.model (or opts.model is not set); else none.
 */
export function fileLibrarySource(opts: { path?: string; vectors?: ReadonlyMap<string, number[]>; model?: string } = {}): LibrarySource {
  let entries: KpiLibraryEntry[] | null = null;
  const load = (): KpiLibraryEntry[] => {
    entries ??= loadLibraryFile(opts.path).entries
      .map(entry => {
        const content = toLibraryContent(entry);
        return {
          id: entry.id,
          sector: content.sector as Sector,
          tags: list<string>(content.tags),
          level: content.level as IndicatorLevel,
          name: content.name,
          nameAr: content.nameAr,
          definition: content.definition,
          unit: content.unit,
          calculation: jsonValue(content.calculation),
          direction: content.direction as IndicatorDirection,
          disaggregation: list<string>(content.disaggregation),
          methods: list<CollectionMethod>(content.methods),
          frequency: content.frequency as Frequency,
          meansOfVerification: content.meansOfVerification,
          standardReference: jsonValue(content.standardReference),
          standardFramework: content.standardFramework ?? null,
          isStandard: content.isStandard,
          notes: content.notes ?? null,
        };
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return entries;
  };
  return {
    async allEntries() {
      return load().map(e => ({ ...e }));
    },
    async vectors(model: string, ids: readonly string[]) {
      const out = new Map<string, number[]>();
      if (!opts.vectors || (opts.model !== undefined && opts.model !== model)) return out;
      for (const id of ids) {
        const vector = opts.vectors.get(id);
        if (vector) out.set(id, vector);
      }
      return out;
    },
  };
}

/**
 * Embeds the entries in memory (libraryEmbeddingText, input 'document', as the library seed does) for the eval's
 * vector mode; null when the provider is not enabled or returns no vectors. EmbeddingError propagates (the caller
 * decides whether to fall back to keywords). Library text only: no personal data.
 */
export async function embedLibraryInMemory(entries: readonly KpiLibraryEntry[], provider: EmbeddingProvider): Promise<Map<string, number[]> | null> {
  if (!provider.enabled || entries.length === 0) return null;
  const vectors = await provider.embed(entries.map(libraryEmbeddingText), 'document');
  if (!vectors || vectors.length !== entries.length) return null;
  return new Map(entries.map((entry, i) => [entry.id, vectors[i]]));
}
