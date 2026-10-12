import { z } from 'zod';
import { IndicatorLevel, Prisma, Sector } from '@prisma/client';

/** Every column except the derived `embedding` (an Unsupported pgvector column Prisma never returns) and `embeddingModel`. */
export const LIBRARY_ENTRY_SELECT = {
  id: true,
  sector: true,
  tags: true,
  level: true,
  name: true,
  nameAr: true,
  definition: true,
  unit: true,
  calculation: true,
  direction: true,
  disaggregation: true,
  methods: true,
  frequency: true,
  meansOfVerification: true,
  standardReference: true,
  standardFramework: true,
  isStandard: true,
  notes: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.IndicatorLibraryEntrySelect;

const SECTORS = Object.values(Sector);
const LEVELS = Object.values(IndicatorLevel);

/** Query values arrive as a string, a repeated parameter (array) or not at all; empty values mean "no filter". */
const queryText = z.preprocess(
  v => {
    const list = (Array.isArray(v) ? v : [v]).filter(x => typeof x === 'string').map(x => (x as string).trim()).filter(Boolean);
    return list.length > 0 ? list.join(',') : undefined;
  },
  z.string().optional(),
);

export const libraryQuerySchema = z.object({
  sector: queryText.transform((v, ctx) => {
    if (v === undefined) return undefined;
    const values = Array.from(new Set(v.split(',').map(s => s.trim()).filter(Boolean)));
    const invalid = values.filter(s => !SECTORS.includes(s as Sector));
    if (invalid.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `unknown sector ${invalid.map(s => `"${s}"`).join(', ')}; use one or more of: ${SECTORS.join(', ')}`,
      });
      return z.NEVER;
    }
    return values as Sector[];
  }),
  level: queryText.refine(v => v === undefined || LEVELS.includes(v as IndicatorLevel), {
    message: `must be one of: ${LEVELS.join(', ')}`,
  }).transform(v => v as IndicatorLevel | undefined),
  framework: queryText.refine(v => v === undefined || v.length <= 100, { message: 'must be at most 100 characters' }),
  isStandard: queryText.refine(v => v === undefined || v === 'true' || v === 'false', {
    message: 'must be true or false',
  }).transform(v => (v === undefined ? undefined : v === 'true')),
  q: queryText.refine(v => v === undefined || v.length <= 200, { message: 'must be at most 200 characters' }),
});

export type LibraryQuery = z.infer<typeof libraryQuerySchema>;

/** Parses the list query; throws an Error whose message names every bad parameter. */
export function parseLibraryQuery(query: unknown): LibraryQuery {
  const result = libraryQuerySchema.safeParse(query ?? {});
  if (!result.success) {
    const problems = result.error.issues.map(i => `${i.path.join('.')} ${i.message}`);
    throw new Error(`Invalid filter: ${problems.join('; ')}`);
  }
  return result.data;
}

/** Database filter for the structured parameters (the text search `q` runs in memory, see matchesLibrarySearch). */
export function buildLibraryWhere(filters: LibraryQuery): Prisma.IndicatorLibraryEntryWhereInput {
  return {
    ...(filters.sector && { sector: { in: filters.sector } }),
    ...(filters.level && { level: filters.level }),
    // Contains, so "GERF" finds "EU GERF" and "IASC MHPSS" finds both IASC frameworks.
    ...(filters.framework && { standardFramework: { contains: filters.framework, mode: 'insensitive' as const } }),
    ...(filters.isStandard !== undefined && { isStandard: filters.isStandard }),
  };
}

/**
 * Lower-cases and folds text for search: Unicode NFKC, Arabic diacritics and
 * tatweel removed, alef/yaa/taa marbuta/hamza carriers unified, whitespace collapsed.
 */
export function normaliseSearchText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, '') // harakat, Quranic marks, tatweel
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627') // آ أ إ ٱ → ا
    .replace(/\u0649/g, '\u064A') // ى → ي
    .replace(/\u0629/g, '\u0647') // ة → ه
    .replace(/\u0624/g, '\u0648') // ؤ → و
    .replace(/\u0626/g, '\u064A') // ئ → ي
    .replace(/\s+/g, ' ')
    .trim();
}

type Searchable = { id: string; name: string; nameAr: string; definition: string; tags: string[] };

/**
 * True when the entry matches the search text: the whole query equals a tag
 * (spaces read as underscores) or the id, or every word of the query appears in
 * the English name, Arabic name or definition (or equals a tag). Case- and
 * diacritic-insensitive.
 */
export function matchesLibrarySearch(entry: Searchable, q: string | undefined): boolean {
  const query = q ? normaliseSearchText(q) : '';
  if (!query) return true;
  const tags = entry.tags.map(normaliseSearchText);
  if (tags.includes(query) || tags.includes(query.replace(/ /g, '_')) || entry.id.toLowerCase() === query) return true;
  const haystack = [entry.name, entry.nameAr, entry.definition].map(normaliseSearchText).join('\n');
  return query.split(' ').every(term => haystack.includes(term) || tags.includes(term));
}
