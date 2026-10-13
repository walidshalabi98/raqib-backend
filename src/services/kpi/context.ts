/**
 * buildProjectContext: everything one KPI run knows about the project (knowledge/kpi-assistant-spec.md §A3; design
 * sections 1.3 and 4.3). Every query is scoped to the organisation (CLAUDE.md rule 1) and every free text is redacted
 * (CLAUDE.md rule 5): no beneficiary data, names, phone or ID numbers reach the context. Redacted fields (tested one by
 * one): project name, donor, description, geographic scope; result code, text, textAr; indicator text and Arabic text;
 * pending suggestion name; alternatives source name, nameAr, definition, problems; document file name (clipped to 200
 * characters) and document text (documentTextForAi). Reject notes are never loaded. Logs hold ids and counts only.
 */
import type { DonorType, IndicatorLevel, PrismaClient, Sector } from '@prisma/client';
import { codeKey, documentTextForAi, projectSectors } from '../ai/frameworkNormalize';
import type { ResultNodePlan, SourceDocument, VerifiedFigure } from '../ai/frameworkNormalize';
import { donorRulesFor } from '../ai/donorRules';
import { redactPersonalData } from '../ai/redact';
import { findCurrentFramework } from '../frameworks/current';
import { sortResultNodes } from '../indicators/hierarchy';
import { extractDocumentFacts, factsFromVerifiedFigures } from './documentFacts';
import { loadOrgPreferences } from './preferences';
import { scoreExistingIndicator } from './validate';
import type {
  AlternativesSource, ContextIndicator, ContextPendingSuggestion, ContextResult, DocumentText, KpiScope, KpiWarning,
  OrgPreferences, ProjectContext, SuggestableLevel,
} from './types';

/** The project, framework or scope target is gone ('not_found') or no longer current ('stale'). Messages are safe (no stored text). */
export class KpiContextError extends Error {
  constructor(readonly code: 'not_found' | 'stale', message: string) {
    super(message);
    this.name = 'KpiContextError';
  }
}

/** File names are clipped after redaction: they are shown in prompts, cited by rule 10 and stored on accept. */
export const MAX_CONTEXT_FILE_NAME_CHARS = 200;

const redact = (value: string): string => redactPersonalData(value).text;
const redactNullable = (value: string | null | undefined): string | null => (value == null ? null : redact(value));
const redactFileName = (value: string): string => redact(value).slice(0, MAX_CONTEXT_FILE_NAME_CHARS);
const ymd = (date: Date): string => date.toISOString().slice(0, 10);
const isSuggestable = (level: IndicatorLevel): level is SuggestableLevel => level !== 'activity';
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const stringField = (record: Record<string, unknown>, key: string): string | null => (typeof record[key] === 'string' ? record[key] as string : null);

/**
 * Code collisions after codeKey (trimmed, upper case, no spaces: "O1" and "o 1") get " (2)", " (3)" … in chain order, so
 * every code in the context is unique by codeKey and rule x1 / resolveResult can map a model's resultCode back to one
 * id (design D2, SDA-14). The first occurrence keeps its code; a suffixed code that would collide again takes the next
 * number. Returns copies; ids are unchanged (pure; exported for tests).
 */
export function uniqueResultCodes<T extends { code: string }>(results: readonly T[]): T[] {
  const taken = new Set<string>();
  return results.map(result => {
    let code = result.code;
    for (let n = 2; taken.has(codeKey(code)); n++) code = `${result.code} (${n})`;
    taken.add(codeKey(code));
    return code === result.code ? { ...result } : { ...result, code };
  });
}

/** English warning messages of a source (severity 'warning' only: info notes are not problems), redacted. */
function problemMessages(warnings: unknown): string[] {
  if (!Array.isArray(warnings)) return [];
  return warnings
    .filter((w): w is KpiWarning => isObject(w) && typeof w.message === 'string' && w.severity === 'warning')
    .map(w => redact(w.message))
    .filter(Boolean);
}

type Db = PrismaClient;

interface ScopeInput { organizationId: string; frameworkId: string; scope: KpiScope; chainIds: ReadonlySet<string> }

/** The source of an alternatives run (spec §A2 trigger 3; design 1.3 alternativesFor, D6, D21), or null for other scopes. */
async function loadAlternativesSource(db: Db, input: ScopeInput): Promise<AlternativesSource | null> {
  const { scope } = input;
  if (scope.type !== 'alternatives') return null;
  const gone = () => new KpiContextError('not_found', 'The indicator or suggestion of this request no longer exists or is not linked to a result.');

  if (scope.indicatorId !== null) {
    const indicator = await db.indicator.findFirst({
      where: { id: scope.indicatorId, frameworkId: input.frameworkId, framework: { project: { organizationId: input.organizationId } } },
      select: {
        id: true, resultId: true, indicatorText: true, indicatorTextAr: true, definition: true, unit: true,
        dataCollectionMethod: true, libraryId: true, calculation: true, meansOfVerification: true,
      },
    });
    if (!indicator || !indicator.resultId || !input.chainIds.has(indicator.resultId)) throw gone();
    const quality = scoreExistingIndicator(indicator);
    return {
      kind: 'indicator',
      id: indicator.id,
      resultId: indicator.resultId,
      name: redact(indicator.indicatorText),
      nameAr: redactNullable(indicator.indicatorTextAr),
      definition: redactNullable(indicator.definition),
      unit: indicator.unit,
      method: indicator.dataCollectionMethod,
      libraryId: indicator.libraryId,
      reason: quality.needsAlternatives ? 'weak' : 'requested',
      rejectReason: null,
      problems: problemMessages(quality.warnings),
    };
  }

  const suggestion = await db.kpiSuggestion.findFirst({
    where: { id: scope.suggestionId, frameworkId: input.frameworkId, project: { organizationId: input.organizationId } },
    // rejectNote is never loaded (design 4.3): the note is never sent to a model.
    select: { id: true, resultId: true, libraryId: true, method: true, status: true, rejectReason: true, warnings: true, payload: true },
  });
  if (!suggestion || !suggestion.resultId || !input.chainIds.has(suggestion.resultId)) throw gone();
  const payload = isObject(suggestion.payload) ? suggestion.payload : {};
  const problems = problemMessages(suggestion.warnings);
  const penalised = Array.isArray(suggestion.warnings)
    && suggestion.warnings.some(w => isObject(w) && typeof w.penalty === 'number' && w.penalty > 0);
  return {
    kind: 'suggestion',
    id: suggestion.id,
    resultId: suggestion.resultId,
    name: redact(stringField(payload, 'name') ?? ''),
    nameAr: redactNullable(stringField(payload, 'nameAr')),
    definition: redactNullable(stringField(payload, 'definition')),
    unit: stringField(payload, 'unit'),
    method: suggestion.method,
    libraryId: suggestion.libraryId,
    reason: suggestion.status === 'rejected' ? 'rejected' : penalised ? 'weak' : 'requested',
    rejectReason: suggestion.rejectReason,
    problems,
  };
}

/** Facts and full texts of the project's completed, non-qualitative documents (design 1.3 documentFacts/documentTexts). */
async function loadDocuments(db: Db, organizationId: string, projectId: string): Promise<{ documentFacts: ProjectContext['documentFacts']; documentTexts: DocumentText[] }> {
  const rows = await db.document.findMany({
    // FGD and KII transcripts are coded by the qualitative entry only, never sent to a model here.
    where: { projectId, project: { organizationId }, parsingStatus: 'completed', qualitativeSource: false },
    select: { id: true, fileName: true, parsedText: true, aiAnalysis: true },
    orderBy: [{ uploadedAt: 'asc' }, { id: 'asc' }],
  });
  let removed = 0;
  const docs = rows
    .map(row => {
      const own = documentTextForAi(row.parsedText);
      removed += own.removed;
      const analysis = isObject(row.aiAnalysis) ? row.aiAnalysis : {};
      const mentioned: unknown[] = Array.isArray(analysis.targetsMentioned) ? analysis.targetsMentioned : [];
      const verifiedTargets = mentioned.flatMap(t => (isObject(t) && t.verified === true && typeof t.target === 'string' ? [redact(t.target)] : []));
      return { id: row.id, fileName: redactFileName(row.fileName), text: own.text, verifiedTargets };
    })
    .filter(d => d.text.trim() !== '');
  if (removed > 0) console.warn(`[KpiContext] ${projectId}: removed ${removed} phone, ID or email matches from unredacted document text`);
  const documentFacts = extractDocumentFacts(docs);
  const withFacts = new Set(documentFacts.map(f => f.documentId));
  const documentTexts = docs.filter(d => withFacts.has(d.id)).map(d => ({ documentId: d.id, fileName: d.fileName, text: d.text }));
  return { documentFacts, documentTexts };
}

/**
 * DB path: everything scoped to organizationId (defence in depth) and to frameworkId; every free text redacted.
 * withDocuments false (request preview, section 7.2): documentFacts/documentTexts [] and no parsedText is loaded.
 * Throws KpiContextError 'not_found' when the project, the framework or the scope target is gone (or not suggestable),
 * 'stale' when the framework is no longer the project's current one.
 */
export async function buildProjectContext(db: PrismaClient, input: { organizationId: string; projectId: string; frameworkId: string; scope: KpiScope; now: Date },
  options?: { withDocuments?: boolean }): Promise<ProjectContext> {
  const { organizationId, projectId, frameworkId, scope } = input;
  const project = await db.project.findFirst({
    where: { id: projectId, organizationId },
    select: {
      id: true, name: true, sector: true, sectors: true, donor: true, donorType: true, startDate: true, endDate: true,
      geographicScope: true, targetBeneficiaries: true, humanitarian: true, description: true,
    },
  });
  if (!project) throw new KpiContextError('not_found', 'The project of this request no longer exists.');
  const framework = await db.framework.findFirst({ where: { id: frameworkId, projectId }, select: { id: true } });
  if (!framework) throw new KpiContextError('not_found', 'The framework of this request no longer exists.');
  const current = await findCurrentFramework(db, projectId);
  if (current?.id !== frameworkId) throw new KpiContextError('stale', 'A newer framework version exists; suggestions were not made for the old one.');

  // Independent reads run together (latency budget: BUILD_GUIDE Phase 4 criterion 3).
  const [nodes, indicators, pending, documents, orgPreferences] = await Promise.all([
    db.resultNode.findMany({
      where: { frameworkId, level: { not: 'activity' }, framework: { projectId } },
      select: { id: true, code: true, level: true, text: true, textAr: true, parentId: true, sortOrder: true },
    }),
    db.indicator.findMany({
      where: { frameworkId, framework: { projectId } },
      select: { id: true, resultId: true, indicatorText: true, indicatorTextAr: true, level: true, unit: true, libraryId: true, dataCollectionMethod: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    }),
    db.kpiSuggestion.findMany({
      where: { frameworkId, projectId, status: 'pending', project: { organizationId } },
      select: { id: true, resultId: true, libraryId: true, payload: true },
      orderBy: [{ createdAt: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
    }),
    options?.withDocuments === false
      ? Promise.resolve({ documentFacts: [], documentTexts: [] })
      : loadDocuments(db, organizationId, projectId),
    loadOrgPreferences(db, { organizationId, projectId, donorType: project.donorType, now: input.now }),
  ]);

  const resultsChain: ContextResult[] = uniqueResultCodes(sortResultNodes(nodes).flatMap(n => (isSuggestable(n.level) ? [{
    id: n.id,
    code: redact(n.code),
    level: n.level,
    text: redact(n.text),
    textAr: redactNullable(n.textAr),
    parentId: n.parentId,
  }] : [])));
  const chainIds = new Set(resultsChain.map(r => r.id));
  if (scope.type === 'result' && !chainIds.has(scope.resultId)) {
    throw new KpiContextError('not_found', 'The result of this request no longer exists or cannot have indicators.');
  }

  const existingIndicators: ContextIndicator[] = indicators.map(i => ({
    id: i.id,
    resultId: i.resultId,
    name: redact(i.indicatorText),
    nameAr: redactNullable(i.indicatorTextAr),
    level: i.level,
    unit: i.unit,
    libraryId: i.libraryId,
    method: i.dataCollectionMethod,
  }));
  const pendingSuggestions: ContextPendingSuggestion[] = pending.map(s => ({
    id: s.id,
    resultId: s.resultId,
    libraryId: s.libraryId,
    name: redact(isObject(s.payload) ? stringField(s.payload, 'name') ?? '' : ''),
  }));
  const alternativesFor = await loadAlternativesSource(db, { organizationId, frameworkId, scope, chainIds });

  return {
    project: {
      id: project.id,
      name: redact(project.name),
      sectors: projectSectors(project),
      donor: redact(project.donor),
      donorType: project.donorType,
      startDate: ymd(project.startDate),
      endDate: ymd(project.endDate),
      geographicScope: redactNullable(project.geographicScope),
      targetBeneficiaries: project.targetBeneficiaries,
      humanitarian: project.humanitarian,
      description: redactNullable(project.description),
    },
    resultsChain,
    scope,
    existingIndicators,
    pendingSuggestions,
    documentFacts: documents.documentFacts,
    documentTexts: documents.documentTexts,
    orgPreferences,
    donorRules: donorRulesFor(project.donorType),
    alternativesFor,
  };
}

/**
 * Framework generation path (spec §A2 last row; design 1.2, 4.6): ids = codes, existing indicators [], facts from
 * verified figures (factsFromVerifiedFigures), documentTexts = the generator's redacted SourceDocuments (file names
 * redacted and clipped like the DB path, so a fact's file name is the one rules 8–10 find and cite). Activities are
 * skipped; results in sortResultNodes order with unique codes; scope 'framework'. Every free text is redacted again.
 */
export function contextFromGeneration(input: {
  project: { id: string; name: string; sectors: Sector[]; donor: string; donorType: DonorType; startDate: string; endDate: string;
             geographicScope: string | null; targetBeneficiaries: number | null; humanitarian: boolean; description: string | null };
  /** Activities skipped. */
  plan: readonly ResultNodePlan[];
  verifiedFigures: readonly VerifiedFigure[];
  documents: readonly SourceDocument[];
  orgPreferences: OrgPreferences;
}): ProjectContext {
  const { project } = input;
  const nodes = input.plan.flatMap(n => (isSuggestable(n.level) ? [{ ...n, level: n.level }] : []));
  const resultsChain: ContextResult[] = uniqueResultCodes(sortResultNodes(nodes).map(n => ({
    id: n.code,
    code: redact(n.code),
    level: n.level,
    text: redact(n.text),
    textAr: redactNullable(n.textAr),
    parentId: n.parentCode,
  })));
  const figures = input.verifiedFigures.map(f => ({ ...f, source: redactFileName(f.source), quote: redact(f.quote) }));
  const documentTexts: DocumentText[] = input.documents
    .map(d => ({ documentId: '', fileName: redactFileName(d.fileName), text: redact(d.text) }))
    .filter(d => d.text.trim() !== '');
  return {
    project: {
      ...project,
      sectors: [...project.sectors],
      name: redact(project.name),
      donor: redact(project.donor),
      geographicScope: redactNullable(project.geographicScope),
      description: redactNullable(project.description),
    },
    resultsChain,
    scope: { type: 'framework' },
    existingIndicators: [],
    pendingSuggestions: [],
    documentFacts: factsFromVerifiedFigures(figures),
    documentTexts,
    orgPreferences: { rejectedLibraryIds: [...input.orgPreferences.rejectedLibraryIds], preferredMethods: [...input.orgPreferences.preferredMethods] },
    donorRules: donorRulesFor(project.donorType),
    alternativesFor: null,
  };
}
