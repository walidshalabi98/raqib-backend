import fs from 'fs';
import nodePath from 'path';
import { z } from 'zod';
import { CollectionMethod, Frequency, IndicatorDirection, Sector } from '@prisma/client';

/** Source of truth for the indicator library (CLAUDE.md "Read first"). */
export const DEFAULT_LIBRARY_PATH = nodePath.resolve(__dirname, '../../../knowledge/indicator-library.json');

const LIBRARY_ID = /^[A-Z]{2}-\d{2}$/;
const ARABIC_LETTER = /[\u0600-\u06FF]/;

const nonEmpty = z.string({ required_error: 'is required' }).trim().min(1, 'must not be empty');
const stringList = z.array(nonEmpty, { required_error: 'is required', invalid_type_error: 'must be an array of strings' });

function enumValues(values: Record<string, string>): string {
  return Object.values(values).join(', ');
}

function enumErrorMap(allowed: string): z.ZodErrorMap {
  return (issue, ctx) => {
    if (issue.code === 'invalid_type' && ctx.data === undefined) return { message: 'is required' };
    if (issue.code === 'invalid_enum_value' || issue.code === 'invalid_type') return { message: `must be one of: ${allowed}` };
    return { message: ctx.defaultError };
  };
}

function nativeEnum<T extends Record<string, string>>(values: T) {
  return z.nativeEnum(values, { errorMap: enumErrorMap(enumValues(values)) });
}

const calculationSchema = z.object({
  numerator: z.string().optional(),
  denominator: z.string().optional(),
  formula: z.string().optional(),
  aggregation: z.string().optional(),
  rounding: z.string().optional(),
}).strict();

const standardReferenceSchema = z.object({
  framework: nonEmpty,
  code: nonEmpty,
  url: z.string().url('must be a valid URL').optional(),
}).strict();

/** Library levels: activities are tracked as tasks, not indicators (me-foundations.md §1). */
export const LIBRARY_LEVELS = ['impact', 'outcome', 'output'] as const;

function buildEntrySchema(units: readonly string[]) {
  return z.object({
    id: z.string({ required_error: 'is required' }).regex(LIBRARY_ID, 'must look like "FS-01" (two capital letters, a hyphen, two digits)'),
    sector: nativeEnum(Sector),
    tags: stringList,
    level: z.enum(LIBRARY_LEVELS, { errorMap: enumErrorMap(LIBRARY_LEVELS.join(', ')) }),
    name: nonEmpty,
    nameAr: nonEmpty.refine(v => ARABIC_LETTER.test(v), 'must contain Arabic text'),
    definition: nonEmpty,
    unit: z.string({ required_error: 'is required' })
      .refine(u => units.includes(u), `must be one of the units in meta.enums.unit: ${units.join(', ')}`),
    calculation: calculationSchema.nullable(),
    direction: nativeEnum(IndicatorDirection),
    disaggregation: stringList,
    methods: z.array(nativeEnum(CollectionMethod), { required_error: 'is required', invalid_type_error: 'must be an array' })
      .min(1, 'must list at least one collection method'),
    frequency: nativeEnum(Frequency),
    meansOfVerification: nonEmpty,
    standardReference: standardReferenceSchema.nullable(),
    isStandard: z.boolean({ required_error: 'is required', invalid_type_error: 'must be true or false' }),
    notes: z.string({ required_error: 'is required (use "" when there are no notes)' }),
  }, { invalid_type_error: 'must be an object' }).strict();
}

/** One validated entry of knowledge/indicator-library.json. */
export type LibraryEntryInput = z.infer<ReturnType<typeof buildEntrySchema>>;

export interface LibraryFile {
  version: string;
  entries: LibraryEntryInput[];
}

const fileSchema = z.object({
  meta: z.object({
    version: nonEmpty,
    enums: z.object({
      unit: z.array(nonEmpty, { required_error: 'is required' }).min(1, 'must list at least one unit'),
    }).passthrough(),
  }).passthrough(),
  indicators: z.array(z.unknown(), { required_error: 'is required', invalid_type_error: 'must be an array' })
    .min(1, 'must contain at least one entry'),
});

/** Thrown when the library file is missing or invalid; `problems` lists every issue found. */
export class LibraryValidationError extends Error {
  constructor(public source: string, public problems: string[]) {
    super(`Indicator library ${source} is invalid (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n${problems.map(p => `  - ${p}`).join('\n')}`);
    this.name = 'LibraryValidationError';
  }
}

function formatPath(path: (string | number)[]): string {
  return path.reduce<string>((out, part) => (typeof part === 'number' ? `${out}[${part}]` : out ? `${out}.${part}` : part), '');
}

/**
 * Validates parsed library JSON. Every entry is checked, and all problems are
 * reported together in one LibraryValidationError.
 */
export function validateLibraryData(data: unknown, source = 'data'): LibraryFile {
  const file = fileSchema.safeParse(data);
  if (!file.success) {
    throw new LibraryValidationError(source, file.error.issues.map(i => `${formatPath(i.path) || '(file)'}: ${i.message}`));
  }

  const units = file.data.meta.enums.unit;
  const entrySchema = buildEntrySchema(units);
  const problems: string[] = [];
  const entries: LibraryEntryInput[] = [];
  const firstIndexById = new Map<string, number>();

  file.data.indicators.forEach((raw, index) => {
    const rawId = raw && typeof raw === 'object' && typeof (raw as any).id === 'string' ? (raw as any).id as string : undefined;
    const label = `indicators[${index}]${rawId ? ` (${rawId})` : ''}`;

    if (rawId !== undefined) {
      const first = firstIndexById.get(rawId);
      if (first !== undefined) problems.push(`${label}: duplicate id "${rawId}" (first used by indicators[${first}])`);
      else firstIndexById.set(rawId, index);
    }

    const parsed = entrySchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        if (issue.code === 'unrecognized_keys') {
          problems.push(`${label}: unknown field${issue.keys.length === 1 ? '' : 's'} ${issue.keys.map(k => `"${formatPath([...issue.path, k])}"`).join(', ')}`);
        } else {
          const field = formatPath(issue.path);
          problems.push(`${label}${field ? `.${field}` : ''}: ${issue.message}`);
        }
      }
      return;
    }

    if (parsed.data.isStandard && !parsed.data.standardReference) {
      problems.push(`${label}.standardReference: is required when isStandard is true`);
      return;
    }
    entries.push(parsed.data);
  });

  if (problems.length > 0) throw new LibraryValidationError(source, problems);
  return { version: file.data.meta.version, entries };
}

/** Reads and validates the indicator library file (default: knowledge/indicator-library.json). */
export function loadLibraryFile(path: string = DEFAULT_LIBRARY_PATH): LibraryFile {
  const relative = nodePath.relative(process.cwd(), path);
  const source = relative && !relative.startsWith('..') ? relative : path;
  let text: string;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (err: any) {
    throw new LibraryValidationError(source, [`cannot read the file: ${err.code === 'ENOENT' ? 'file not found' : err.message}`]);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err: any) {
    throw new LibraryValidationError(source, [`not valid JSON: ${err.message}`]);
  }
  return validateLibraryData(data, source);
}
