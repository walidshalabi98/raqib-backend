import { Prisma, PrismaClient } from '@prisma/client';
import { LibraryEntryInput, loadLibraryFile } from './load';

export interface SeedLibraryResult {
  created: number;
  updated: number;
  unchanged: number;
  total: number;
  version: string;
  /** Ids stored in the database but missing from the file. They are kept, never deleted. */
  notInFile: string[];
}

export interface SeedLibraryOptions {
  /** Library file to load (default: knowledge/indicator-library.json). */
  path?: string;
  logger?: { warn: (message: string) => void };
}

/** Columns that hold library content. `version` and the timestamps are bookkeeping; `embedding` is never touched here. */
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
 * Never deletes rows and never touches `embedding`.
 */
export async function seedLibrary(prisma: PrismaClient, options: SeedLibraryOptions = {}): Promise<SeedLibraryResult> {
  const logger = options.logger ?? console;
  const { version, entries } = loadLibraryFile(options.path);
  const ids = entries.map(e => e.id);

  const existing = await prisma.indicatorLibraryEntry.findMany({ where: { id: { in: ids } }, select: CONTENT_SELECT });
  const storedById = new Map(existing.map(row => [row.id, row]));

  const toCreate: Prisma.IndicatorLibraryEntryCreateManyInput[] = [];
  const toUpdate: { id: string; data: LibraryContent & { version: string } }[] = [];
  for (const entry of entries) {
    const content = toLibraryContent(entry);
    const stored = storedById.get(entry.id);
    if (!stored) toCreate.push({ id: entry.id, ...content, version });
    else if (libraryContentDiffers(content, stored)) toUpdate.push({ id: entry.id, data: { ...content, version } });
  }

  if (toCreate.length > 0 || toUpdate.length > 0) {
    await prisma.$transaction([
      ...(toCreate.length > 0 ? [prisma.indicatorLibraryEntry.createMany({ data: toCreate })] : []),
      ...toUpdate.map(u => prisma.indicatorLibraryEntry.update({ where: { id: u.id }, data: u.data, select: { id: true } })),
    ]);
  }

  const orphans = await prisma.indicatorLibraryEntry.findMany({
    where: { id: { notIn: ids } }, select: { id: true }, orderBy: { id: 'asc' },
  });
  const notInFile = orphans.map(o => o.id);
  if (notInFile.length > 0) {
    logger.warn(`Indicator library: ${notInFile.length} stored entr${notInFile.length === 1 ? 'y is' : 'ies are'} not in the file and were kept: ${notInFile.join(', ')}`);
  }

  return {
    created: toCreate.length,
    updated: toUpdate.length,
    unchanged: entries.length - toCreate.length - toUpdate.length,
    total: entries.length,
    version,
    notInFile,
  };
}
