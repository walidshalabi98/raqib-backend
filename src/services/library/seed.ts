import { Prisma, PrismaClient } from '@prisma/client';
// The env-free provider module: the library seed must run with DATABASE_URL alone.
import type { EmbeddingProvider } from '../ai/embeddingProviders';
import { allLibraryIds, clearLibraryEmbeddings, embedLibraryEntries, findLibraryIdsToEmbed, libraryEmbeddingText } from './embed';
import { LibraryEntryInput, loadLibraryFile } from './load';

export interface SeedLibraryResult {
  created: number;
  updated: number;
  unchanged: number;
  total: number;
  version: string;
  /** Ids stored in the database but missing from the file. They are kept, never deleted. */
  notInFile: string[];
  /** Entries embedded in this run (0 when skipped or when every entry already had a vector from the provider's model). */
  embedded: number;
  /** Why no embeddings were made, e.g. "VOYAGE_API_KEY is not set (keyword search is used)"; null when the provider ran. */
  embeddingsSkipped: string | null;
  /** Why embedding stopped early (content and earlier batches are saved; the rest are embedded on the next run), or null. */
  embeddingError: string | null;
}

export interface SeedLibraryOptions {
  /** Library file to load (default: knowledge/indicator-library.json). */
  path?: string;
  logger?: { warn: (message: string) => void };
  /**
   * Embedding provider (`npm run seed:library` passes createEmbeddingProvider() with the Voyage
   * settings). When it is enabled, every stored entry without a vector from the provider's model
   * is embedded after the upsert. Omitted or disabled: nothing is embedded and the library is
   * searched by keyword.
   */
  embeddings?: EmbeddingProvider;
  /** Re-embed every stored entry, even those that already have a vector from the provider's model. */
  reembedAll?: boolean;
}

/** Columns that hold library content. `version` and the timestamps are bookkeeping; `embedding` and `embeddingModel` are derived (see seedLibrary). */
const CONTENT_FIELDS = [
  'sector', 'tags', 'level', 'name', 'nameAr', 'definition', 'unit', 'calculation', 'direction', 'disaggregation',
  'methods', 'frequency', 'meansOfVerification', 'standardReference', 'standardFramework', 'isStandard', 'notes',
] as const;

type ContentField = typeof CONTENT_FIELDS[number];
export type LibraryContent = Pick<Prisma.IndicatorLibraryEntryUncheckedCreateInput, ContentField>;

const CONTENT_SELECT = Object.fromEntries([['id', true], ...CONTENT_FIELDS.map(f => [f, true])]) as
  Record<'id' | ContentField, true>;

/** Maps a file entry to the stored columns. Empty notes are stored as null. */
export function toLibraryContent(entry: LibraryEntryInput): LibraryContent {
  return {
    sector: entry.sector,
    tags: entry.tags,
    level: entry.level,
    name: entry.name,
    nameAr: entry.nameAr,
    definition: entry.definition,
    unit: entry.unit,
    calculation: entry.calculation ?? Prisma.DbNull,
    direction: entry.direction,
    disaggregation: entry.disaggregation,
    methods: entry.methods,
    frequency: entry.frequency,
    meansOfVerification: entry.meansOfVerification,
    standardReference: entry.standardReference ?? Prisma.DbNull,
    standardFramework: entry.standardReference?.framework ?? null,
    isStandard: entry.isStandard,
    notes: entry.notes.trim() === '' ? null : entry.notes,
  };
}

/**
 * JSON with object keys sorted at every depth (Postgres jsonb does not keep key
 * order) and array order preserved. Prisma's DbNull/JsonNull and undefined read as null.
 */
export function stableStringify(value: unknown): string {
  const normalise = (v: unknown): unknown => {
    if (v === undefined || v === null || v === Prisma.DbNull || v === Prisma.JsonNull) return null;
    if (Array.isArray(v)) return v.map(normalise);
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as object)
          .filter(k => (v as any)[k] !== undefined)
          .sort()
          .map(k => [k, normalise((v as any)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(normalise(value));
}

/** True when any content column of a stored row differs from the file. */
export function libraryContentDiffers(fromFile: LibraryContent, stored: Partial<Record<ContentField, unknown>>): boolean {
  return CONTENT_FIELDS.some(f => stableStringify(fromFile[f]) !== stableStringify(stored[f]));
}

/**
 * Loads knowledge/indicator-library.json into IndicatorLibraryEntry, upserting by id.
 * Idempotent: rows are created when missing and updated only when their content
 * differs from the file, so a second run writes nothing (updatedAt stays put).
 * `version` records the library release in which an entry was created or last changed.
 * Never deletes rows.
 *
 * Embeddings: an update that changes the embedded text (name, Arabic name, definition, tags)
 * clears the entry's vector in the same transaction, so a stale vector is never searched.
 * Then, with an enabled provider, every stored entry whose vector is missing or was made by
 * another model (`embeddingModel`) is embedded, entries kept outside the file included; a
 * second run embeds nothing, and a model change re-embeds everything on the next plain run.
 * An embedding failure is reported in `embeddingError`, not thrown: the content is saved and
 * the remaining vectors are made on the next run.
 */
export async function seedLibrary(prisma: PrismaClient, options: SeedLibraryOptions = {}): Promise<SeedLibraryResult> {
  const logger = options.logger ?? console;
  const { version, entries } = loadLibraryFile(options.path);
  const ids = entries.map(e => e.id);

  const existing = await prisma.indicatorLibraryEntry.findMany({ where: { id: { in: ids } }, select: CONTENT_SELECT });
  const storedById = new Map(existing.map(row => [row.id, row]));

  const toCreate: Prisma.IndicatorLibraryEntryCreateManyInput[] = [];
  const toUpdate: { id: string; data: LibraryContent & { version: string } }[] = [];
  const staleEmbeddings: string[] = [];
  for (const entry of entries) {
    const content = toLibraryContent(entry);
    const stored = storedById.get(entry.id);
    if (!stored) toCreate.push({ id: entry.id, ...content, version });
    else if (libraryContentDiffers(content, stored)) {
      toUpdate.push({ id: entry.id, data: { ...content, version } });
      if (libraryEmbeddingText(entry) !== libraryEmbeddingText(stored)) staleEmbeddings.push(entry.id);
    }
  }

  if (toCreate.length > 0 || toUpdate.length > 0) {
    await prisma.$transaction([
      ...(toCreate.length > 0 ? [prisma.indicatorLibraryEntry.createMany({ data: toCreate })] : []),
      ...toUpdate.map(u => prisma.indicatorLibraryEntry.update({ where: { id: u.id }, data: u.data, select: { id: true } })),
      ...(staleEmbeddings.length > 0 ? [clearLibraryEmbeddings(prisma, staleEmbeddings)] : []),
    ]);
  }

  const orphans = await prisma.indicatorLibraryEntry.findMany({
    where: { id: { notIn: ids } }, select: { id: true }, orderBy: { id: 'asc' },
  });
  const notInFile = orphans.map(o => o.id);
  if (notInFile.length > 0) {
    logger.warn(`Indicator library: ${notInFile.length} stored entr${notInFile.length === 1 ? 'y is' : 'ies are'} not in the file and were kept: ${notInFile.join(', ')}`);
  }

  const embedding = await embedEntries(prisma, options);

  return {
    created: toCreate.length,
    updated: toUpdate.length,
    unchanged: entries.length - toCreate.length - toUpdate.length,
    total: entries.length,
    version,
    notInFile,
    ...embedding,
  };
}

/** The embedding step of seedLibrary: stored entries without a vector from the provider's model (or all with reembedAll). */
async function embedEntries(
  prisma: PrismaClient,
  options: SeedLibraryOptions,
): Promise<Pick<SeedLibraryResult, 'embedded' | 'embeddingsSkipped' | 'embeddingError'>> {
  const provider = options.embeddings;
  if (!provider) return { embedded: 0, embeddingsSkipped: 'no embedding provider was given (keyword search is used)', embeddingError: null };
  if (!provider.enabled) {
    const reason = provider.disabledReason ?? `the ${provider.name} embedding provider is disabled`;
    return { embedded: 0, embeddingsSkipped: `${reason} (keyword search is used)`, embeddingError: null };
  }
  // A provider without a model name gets every entry here; embedLibraryEntries then refuses it with a clear error.
  const pending = options.reembedAll || !provider.model ? await allLibraryIds(prisma) : await findLibraryIdsToEmbed(prisma, provider.model);
  const { embedded, error } = await embedLibraryEntries(prisma, provider, pending);
  return { embedded, embeddingsSkipped: null, embeddingError: error };
}
