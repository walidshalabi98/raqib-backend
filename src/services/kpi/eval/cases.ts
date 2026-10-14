/**
 * KPI Assistant evaluation cases (knowledge/kpi-eval-cases.json; knowledge/kpi-assistant-spec.md §A8; design
 * section 10.2). Fictional projects; no personal data. Loaded with zod v3; unknown assertion types are rejected.
 * Env-free: the eval CLI imports this module before it has set up the environment (design 10.1).
 */
import fs from 'fs';
import nodePath from 'path';
import { z } from 'zod';
import { DonorType, Sector } from '@prisma/client';
import { donorRulesFor } from '../../ai/donorRules';
import { sortResultNodes } from '../../indicators/hierarchy';
import { factKind } from '../documentFacts';
import type { ContextResult, DocumentFact, DocumentText, KpiScope, ProjectContext, SuggestableLevel } from '../types';

/** Source of the evaluation cases (CLAUDE.md "Read first"). */
export const DEFAULT_EVAL_CASES_PATH = nodePath.resolve(__dirname, '../../../../knowledge/kpi-eval-cases.json');

/** The assertion types of kpi-eval-cases.json meta.assertionTypes (each optional per case). */
export interface EvalAssertions {
  mustIncludeAnyLibraryIds?: string[];
  /** Key = result id (= code) of the case. */
  mustIncludeLibraryIdForResult?: Record<string, string[]>;
  levelsPresent?: SuggestableLevel[];
  maxPerResult?: number;
  peopleIndicatorsHaveSex?: boolean;
  noTargetsWithoutBasis?: boolean;
  noTargetInName?: boolean;
  hasAccountabilityIndicator?: boolean;
  arabicNamesPresent?: boolean;
  minQualityScoreAverage?: number;
}

/** Every assertion type, in the order of meta.assertionTypes (the order the checkers report in). */
export const EVAL_ASSERTION_TYPES = [
  'mustIncludeAnyLibraryIds', 'mustIncludeLibraryIdForResult', 'levelsPresent', 'maxPerResult', 'peopleIndicatorsHaveSex',
  'noTargetsWithoutBasis', 'noTargetInName', 'hasAccountabilityIndicator', 'arabicNamesPresent', 'minQualityScoreAverage',
] as const satisfies readonly (keyof EvalAssertions)[];

/** A case's project, as in the JSON. */
export interface EvalCaseProject {
  name: string;
  sectors: Sector[];
  donor: string;
  donorType: DonorType;
  /** YYYY-MM-DD. */
  startDate: string;
  endDate: string;
  geographicScope: string | null;
  targetBeneficiaries: number | null;
  humanitarian: boolean;
  description: string | null;
}

/** One evaluation case of kpi-eval-cases.json (spec §A8; design 10.2): a fictional project, its results chain, document facts and assertions. */
export interface EvalCase {
  id: string;
  project: EvalCaseProject;
  /** ids are the result codes (e.g. "O1.1"). */
  resultsChain: Array<{ id: string; level: SuggestableLevel; text: string; parentId: string | null }>;
  documentFacts: Array<{ documentId: string; fileName: string; excerpt: string }>;
  assertions: EvalAssertions;
}

const LEVELS = ['impact', 'outcome', 'output'] as const;
const text = z.string({ required_error: 'is required' }).trim().min(1, 'must not be empty');
const isoDate = z.string({ required_error: 'is required' }).regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date as YYYY-MM-DD')
  .refine(v => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), 'must be a real date');
const libraryIds = z.array(z.string().regex(/^[A-Z]{2}-\d{2}$/, 'must look like "WA-01"')).min(1, 'must list at least one library id');

const assertionsSchema = z.object({
  mustIncludeAnyLibraryIds: libraryIds.optional(),
  mustIncludeLibraryIdForResult: z.record(text, libraryIds).optional(),
  levelsPresent: z.array(z.enum(LEVELS)).min(1).optional(),
  maxPerResult: z.number().int().positive().optional(),
  peopleIndicatorsHaveSex: z.boolean().optional(),
  noTargetsWithoutBasis: z.boolean().optional(),
  noTargetInName: z.boolean().optional(),
  hasAccountabilityIndicator: z.boolean().optional(),
  arabicNamesPresent: z.boolean().optional(),
  minQualityScoreAverage: z.number().min(0).max(100).optional(),
}).strict();

const caseSchema = z.object({
  id: text,
  project: z.object({
    name: text,
    sectors: z.array(z.nativeEnum(Sector)).min(1, 'must list at least one sector'),
    donor: text,
    donorType: z.nativeEnum(DonorType),
    startDate: isoDate,
    endDate: isoDate,
    geographicScope: z.string().nullable(),
    targetBeneficiaries: z.number().int().nonnegative().nullable(),
    humanitarian: z.boolean(),
    description: z.string().nullable(),
  }).strict(),
  resultsChain: z.array(z.object({ id: text, level: z.enum(LEVELS), text, parentId: z.string().nullable() }).strict())
    .min(1, 'must list at least one result'),
  documentFacts: z.array(z.object({ documentId: text, fileName: text, excerpt: text }).strict()),
  assertions: assertionsSchema,
}).strict().superRefine((c, ctx) => {
  const ids = c.resultsChain.map(r => r.id);
  ids.forEach((id, i) => {
    if (ids.indexOf(id) !== i) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['resultsChain', i, 'id'], message: `repeats result id ${id}` });
  });
  c.resultsChain.forEach((r, i) => {
    if (r.parentId !== null && !ids.includes(r.parentId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['resultsChain', i, 'parentId'], message: `names unknown result ${r.parentId}` });
    }
  });
  for (const key of Object.keys(c.assertions.mustIncludeLibraryIdForResult ?? {})) {
    if (!ids.includes(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['assertions', 'mustIncludeLibraryIdForResult', key], message: 'is not a result id of the case' });
    }
  }
  if (c.project.endDate < c.project.startDate) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['project', 'endDate'], message: 'is before startDate' });
});

const fileSchema = z.object({
  meta: z.object({ version: text }).passthrough(),
  cases: z.array(caseSchema).min(1, 'must list at least one case'),
}).superRefine((file, ctx) => {
  const ids = file.cases.map(c => c.id);
  ids.forEach((id, i) => {
    if (ids.indexOf(id) !== i) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cases', i, 'id'], message: `repeats case id ${id}` });
  });
});

/**
 * Reads and validates the evaluation cases (spec §A8; design 10.2) with zod v3: unknown keys, including unknown
 * assertion types, are rejected; result ids are unique, parents and per-result assertion keys name results of the case.
 * Throws an Error naming every failing path (never file contents). Default path: knowledge/kpi-eval-cases.json.
 */
export function loadEvalCases(path: string = DEFAULT_EVAL_CASES_PATH): { version: string; cases: EvalCase[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read the evaluation cases (${nodePath.basename(path)}): ${(err as NodeJS.ErrnoException)?.code ?? (err as Error)?.name ?? 'Error'}`);
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.slice(0, 20).map(issue => `${issue.path.join('.') || 'root'}: ${issue.message}`);
    throw new Error(`Invalid evaluation cases (${nodePath.basename(path)}): ${problems.join('; ')}`);
  }
  return { version: parsed.data.meta.version, cases: parsed.data.cases as EvalCase[] };
}

/**
 * The ProjectContext of a case (design 10.2; spec §A3): ids = codes; results in display order (sortResultNodes, the JSON
 * order breaks ties); facts kind = factKind(excerpt) (documentFacts.ts, the same cue rules as uploaded documents);
 * documentTexts = one DocumentText per excerpt (the case facts are whole sentences); donorRulesFor; empty preferences;
 * no existing indicators. Default scope: framework.
 */
export function caseToContext(c: EvalCase, scope: KpiScope = { type: 'framework' }): ProjectContext {
  const resultsChain: ContextResult[] = sortResultNodes(c.resultsChain.map((r, i) => ({ ...r, code: r.id, sortOrder: i })))
    .map(r => ({ id: r.id, code: r.code, level: r.level, text: r.text, textAr: null, parentId: r.parentId }));
  const documentFacts: DocumentFact[] = c.documentFacts.map(f => ({
    documentId: f.documentId, fileName: f.fileName, excerpt: f.excerpt, kind: factKind(f.excerpt),
  }));
  const documentTexts: DocumentText[] = c.documentFacts.map(f => ({ documentId: f.documentId, fileName: f.fileName, text: f.excerpt }));
  return {
    project: {
      id: c.id,
      name: c.project.name,
      sectors: [...c.project.sectors],
      donor: c.project.donor,
      donorType: c.project.donorType,
      startDate: c.project.startDate,
      endDate: c.project.endDate,
      geographicScope: c.project.geographicScope,
      targetBeneficiaries: c.project.targetBeneficiaries,
      humanitarian: c.project.humanitarian,
      description: c.project.description,
    },
    resultsChain,
    scope,
    existingIndicators: [],
    pendingSuggestions: [],
    documentFacts,
    documentTexts,
    orgPreferences: { rejectedLibraryIds: [], preferredMethods: [] },
    donorRules: donorRulesFor(c.project.donorType),
    alternativesFor: null,
  };
}

/** The first outcome of a case in display order (the result-scope latency check, design 10.2), or null. */
export function firstOutcome(c: EvalCase): ContextResult | null {
  return caseToContext(c).resultsChain.find(r => r.level === 'outcome') ?? null;
}
