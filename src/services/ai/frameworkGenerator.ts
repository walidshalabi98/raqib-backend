/**
 * AI framework generation (BUILD_GUIDE Phase 2 task 7, Phase 3, Phase 4): the structure call, then the KPI pipeline,
 * then one transaction that writes the results chain and the indicators.
 * 1. "framework.structure" (main tier, unchanged since Phase 3): the coded results chain and the figures quoted in the
 *    documents (skipped without documents; the results chain is then built from the project's metadata).
 * 2. Indicators through the KPI Assistant pipeline (knowledge/kpi-assistant-spec.md §A2 last row; design section 4.6,
 *    D19): contextFromGeneration (planned results with codes as ids, verified document figures as facts) →
 *    runKpiPipeline with feature id "framework.indicators" (batches of ≤ 4 results, 3 at a time, prompt kpi-v2, run
 *    deadline 10 minutes) → validated drafts. Every generated indicator passes the same validation as a suggestion;
 *    responsibility, assumptions, baseline method and date, phases, milestones and intermediate targets are server
 *    defaults ("to be confirmed"), and the indicator dates are the project dates (D22).
 * Generated indicators are written directly as `ai_generated` (no KpiSuggestion rows: the wizard reviews indicators).
 * Only aggregates and redacted text reach the model; logs hold counts and ids only. FGD and KII transcripts
 * (Document.qualitativeSource) are never used: qualitative coding covers them.
 * When a run fails, the version keeps a safe message in Framework.generationError and is never the project's current
 * framework (the newest version without a generationError). AiError subclasses (KpiPipelineError included) propagate
 * unchanged, so the stored messages stay those of Phase 3.
 */

import { IndicatorLevel, Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { toIndicatorCreateData } from '../indicators/validation';
import { KPI_RUN_DEADLINE_MS } from '../kpi/callModel';
import { contextFromGeneration } from '../kpi/context';
import { productionPipelineDeps } from '../kpi/deps';
import { draftToCreateInput } from '../kpi/draft';
import { runKpiPipeline } from '../kpi/pipeline';
import { loadOrgPreferences } from '../kpi/preferences';
import { generateStructured } from './client';
import { AiError, AiInvalidOutputError, AiOutputTruncatedError, safeErrorSummary } from './errors';
import { redactPersonalData } from './redact';
import {
  FRAMEWORK_PROMPT_VERSION,
  FRAMEWORK_STRUCTURE_SYSTEM,
  FrameworkProjectInfo,
  PROJECT_STRUCTURE_SCHEMA,
  extractProjectStructurePrompt,
} from './prompts/framework';
import { KPI_PROMPT_VERSION } from './prompts/kpi';
import {
  ProjectStructure,
  SourceDocument,
  buildStructureFromMetadata,
  documentTextForAi,
  normalizeProjectStructure,
  planResultNodes,
  projectSectors,
  verifyDocumentFigures,
} from './frameworkNormalize';

/** Token limit and timeout of the structure call (thinking counts towards max tokens; the client retries a cut-off answer once with twice the limit). */
const STRUCTURE_CALL = { maxTokens: 12_000, timeoutMs: 180_000 } as const;

/** Feature id of the indicator step's model calls (AiCall rows and logs keep the Phase 3 id; the prompt is KPI_PROMPT_VERSION, kpi-v2). */
export const FRAMEWORK_INDICATORS_FEATURE = 'framework.indicators';

const LEVEL_ORDER: IndicatorLevel[] = ['impact', 'outcome', 'output', 'activity'];

const EMPTY_INDICATOR_SET = 'AI returned empty or invalid indicator set';
const PROJECT_GONE = 'The project of this framework no longer exists.';

/** A failure of the generator itself, with a message that is safe to store and show (no prompt, document or model text). */
export class FrameworkGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameworkGenerationError';
  }
}

/**
 * The message stored in Framework.generationError for a failed run: the AiError or
 * FrameworkGenerationError message (built without prompt, document or answer text), otherwise only
 * the error's class name, because database and library errors can echo stored values.
 */
export function generationFailureMessage(err: unknown): string {
  const message = err instanceof AiError || err instanceof FrameworkGenerationError
    ? err.message
    : `Framework generation failed because of an internal error (${safeErrorSummary(err)}).`;
  return message.length > 500 ? `${message.slice(0, 499)}…` : message;
}

/**
 * Generates the results chain and indicators of an empty framework version. On failure it records
 * generationError on the version (only while it is still empty, so a retried job never marks a
 * finished framework as failed) and rethrows, so every caller (route, worker, ai:smoke) gets it.
 */
export async function generateFramework(frameworkId: string, projectId: string): Promise<void> {
  try {
    await runGeneration(frameworkId, projectId);
  } catch (err) {
    await prisma.framework.updateMany({
      where: { id: frameworkId, projectId, resultNodes: { none: {} }, indicators: { none: {} } },
      data: { generationError: generationFailureMessage(err) },
    }).catch(recordErr => console.error(`[FrameworkGenerator] Could not record the failure of ${frameworkId}: ${safeErrorSummary(recordErr)}`));
    throw err;
  }
}

/** Free text written by staff: redacted like the documents before it reaches a prompt (CLAUDE.md rule 5). */
function redacted(value: string): string;
function redacted(value: string | null): string | null;
function redacted(value: string | null): string | null {
  return value ? redactPersonalData(value).text : value;
}

async function runGeneration(frameworkId: string, projectId: string): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      // FGD and KII transcripts are coded by the qualitative entry only, never sent here.
      documents: { where: { parsingStatus: 'completed', qualitativeSource: false } },
    },
  });

  if (!project) throw new FrameworkGenerationError(PROJECT_GONE);

  const framework = await prisma.framework.findUnique({
    where: { id: frameworkId },
    select: { projectId: true, generationError: true, _count: { select: { resultNodes: true, indicators: true } } },
  });
  if (!framework || framework.projectId !== projectId) throw new FrameworkGenerationError('The framework version does not belong to this project.');
  // A retried job must not duplicate the results chain; a new version is generated instead.
  if (framework._count.resultNodes > 0 || framework._count.indicators > 0) {
    throw new Error(`Framework ${frameworkId} already has results or indicators; generate a new framework version instead`);
  }
  // A retried run is in progress again: the status route reports "processing", not the earlier failure.
  if (framework.generationError) {
    await prisma.framework.update({ where: { id: frameworkId }, data: { generationError: null } });
  }

  // Only the documents' own, redacted text is used, for the prompt and as evidence for baselines and targets.
  let removed = 0;
  const documents: SourceDocument[] = project.documents
    .map(d => {
      const own = documentTextForAi(d.parsedText);
      removed += own.removed;
      return { fileName: d.fileName, text: own.text };
    })
    .filter(d => d.text.trim() !== '');
  const documentTexts = documents.map(d => d.text);
  if (removed > 0) console.warn(`[FrameworkGenerator] Removed ${removed} phone, ID or email matches from unredacted document text`);
  const context = { organizationId: project.organizationId, projectId };

  const sectors = projectSectors(project);
  // Organisational free text, but staff sometimes add a contact number: every free-text field that
  // reaches a prompt (here and through the metadata structure) is redacted like the documents.
  const description = redacted(project.description);
  const geographicScope = redacted(project.geographicScope);
  const projectInfo: FrameworkProjectInfo = {
    name: redacted(project.name),
    sector: project.sector,
    sectors,
    humanitarian: project.humanitarian,
    donor: redacted(project.donor),
    donorType: project.donorType,
    description: description || undefined,
    targetBeneficiaries: project.targetBeneficiaries || undefined,
    geographicScope: geographicScope || undefined,
    startDate: project.startDate.toISOString().slice(0, 10),
    endDate: project.endDate.toISOString().slice(0, 10),
  };

  let structure: ProjectStructure | null = null;

  if (documentTexts.length > 0) {
    // Step 1a: Extract the coded results chain from documents
    console.log(`[FrameworkGenerator] Step 1: Extracting project structure from ${documentTexts.length} documents`);
    const structurePrompt = extractProjectStructurePrompt(documentTexts, projectInfo);

    try {
      const answer = await generateStructured({
        feature: 'framework.structure',
        model: 'main',
        effort: 'medium',
        ...STRUCTURE_CALL,
        system: FRAMEWORK_STRUCTURE_SYSTEM,
        messages: [{ role: 'user', content: structurePrompt }],
        schema: PROJECT_STRUCTURE_SCHEMA,
        promptVersion: FRAMEWORK_PROMPT_VERSION,
        context,
      });
      structure = normalizeProjectStructure(answer.data, { documentTexts });
      if (!structure) console.warn('[FrameworkGenerator] The AI structure has no goal or outcomes, using metadata fallback');
    } catch (err) {
      // An unusable answer falls back to the metadata structure; refusals and request failures stop the job.
      if (!(err instanceof AiInvalidOutputError || err instanceof AiOutputTruncatedError)) throw err;
      console.warn(`[FrameworkGenerator] Unusable AI structure answer (${err.name}), using metadata fallback`);
    }
  } else {
    // Step 1b: No documents — build the results chain from project metadata
    console.log(`[FrameworkGenerator] Step 1: No documents available, using project metadata`);
  }
  if (!structure) structure = buildStructureFromMetadata({ ...project, description, geographicScope });
  // The only document values the indicators may use: figures whose quote is found in a document.
  const verifiedFigures = verifyDocumentFigures(structure.documentFigures, documents);
  const plan = planResultNodes(structure);

  // Step 2: indicators through the KPI pipeline (spec §A2 last row; design 4.6, D19): candidates from the library,
  // batches of results, validation; the organisation's rejected library ids are excluded as in every KPI run.
  const orgPreferences = await loadOrgPreferences(prisma, {
    organizationId: project.organizationId, projectId, donorType: project.donorType, now: new Date(),
  });
  const kpiContext = contextFromGeneration({
    project: {
      id: projectId,
      name: projectInfo.name,
      sectors,
      donor: projectInfo.donor,
      donorType: project.donorType,
      startDate: projectInfo.startDate as string,
      endDate: projectInfo.endDate as string,
      geographicScope,
      targetBeneficiaries: project.targetBeneficiaries ?? null,
      humanitarian: project.humanitarian,
      description,
    },
    plan,
    verifiedFigures,
    documents,
    orgPreferences,
  });
  console.log(`[FrameworkGenerator] Step 2: KPI pipeline for ${kpiContext.resultsChain.length} results (${verifiedFigures.length} verified document figures)`);
  // Errors propagate unchanged (AiError subclasses, KpiPipelineError included): the framework stays empty and the job fails.
  const kpi = await runKpiPipeline(kpiContext, productionPipelineDeps(), {
    feature: FRAMEWORK_INDICATORS_FEATURE,
    callContext: context,
    deadlineMs: KPI_RUN_DEADLINE_MS,
  });
  // An appended accountability indicator alone is no indicator set: the model's answers gave nothing usable.
  if (!kpi.suggestions.some(s => s.origin === 'model')) throw new FrameworkGenerationError(EMPTY_INDICATOR_SET);
  // The served model of the first successful call (it may differ from the configured one after a server-side fallback).
  const aiModel = kpi.model ?? 'unknown';
  console.log(`[FrameworkGenerator] KPI pipeline: ${kpi.suggestions.length} indicators from ${kpi.calls.length} calls, ${kpi.frameworkWarnings.length} framework warnings, retrieval ${kpi.retrieval}`);
  // AI-2: results left without an indicator (result_failed, result_empty) are named in the admins' notification, so the
  // review starts with them instead of a framework that silently lacks indicators.
  const withoutIndicators = Array.from(new Set(kpi.frameworkWarnings
    .filter(w => w.code === 'result_failed' || w.code === 'result_empty')
    .map(w => redactPersonalData(String(w.params.code ?? '')).text.trim())
    .filter(Boolean)));
  if (withoutIndicators.length > 0) console.warn(`[FrameworkGenerator] ${withoutIndicators.length} result(s) without generated indicators`);

  // Step 3: Create the results chain and the indicators together, so a failure leaves no partial framework
  const { resultCount, indicatorCount } = await prisma.$transaction(async tx => {
    // The project row first, like delete forever (project, then its frameworks), archive, restore, edits and framework
    // approval: a delete that overlaps this write waits for it and then removes the new rows with the project, instead of
    // deadlocking with it. FOR NO KEY UPDATE is the lock the status update below takes anyway; it does not hold up rows
    // added to the project meanwhile (their key-share locks). A project deleted forever meanwhile: nothing is written.
    const lockedProject = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR NO KEY UPDATE`;
    if (lockedProject.length === 0) throw new FrameworkGenerationError(PROJECT_GONE);

    const idByCode = new Map<string, string>();
    const nodes: Array<{ id: string; code: string; level: IndicatorLevel; parentId: string | null }> = [];
    for (const level of LEVEL_ORDER) {
      const rows = plan.filter(p => p.level === level);
      if (rows.length === 0) continue;
      const created = await tx.resultNode.createManyAndReturn({
        data: rows.map(p => ({
          frameworkId,
          level: p.level,
          code: p.code,
          text: p.text,
          textAr: p.textAr,
          sortOrder: p.sortOrder,
          parentId: p.parentCode ? idByCode.get(p.parentCode) ?? null : null,
        })),
        select: { id: true, code: true, level: true, parentId: true },
      });
      for (const node of created) idByCode.set(node.code, node.id);
      for (const p of rows) {
        const node = created.find(c => c.code === p.code);
        if (node) nodes.push(node);
      }
    }

    // Suggestions come in chain order; their resultId is the plan code (contextFromGeneration: ids = codes).
    const data: Prisma.IndicatorUncheckedCreateInput[] = [];
    let skipped = 0;
    for (const suggestion of kpi.suggestions) {
      const resultId = idByCode.get(suggestion.resultId);
      if (!resultId) {
        skipped += 1;
        continue;
      }
      let input;
      try {
        input = draftToCreateInput({ ...suggestion.draft, resultId });
      } catch {
        // Drafts always pass the indicator checks (validate.ts); one that does not is skipped, never half-written.
        skipped += 1;
        continue;
      }
      data.push({
        ...toIndicatorCreateData(frameworkId, { ...input, provenance: 'ai_generated' }, { sortOrder: data.length, resultLevel: suggestion.level }),
        aiModel,
        promptVersion: KPI_PROMPT_VERSION,
      });
    }
    if (skipped > 0) console.warn(`[FrameworkGenerator] ${skipped} generated indicator(s) skipped (no result node or failed the indicator checks)`);
    if (data.length === 0) throw new FrameworkGenerationError(EMPTY_INDICATOR_SET);

    console.log(`[FrameworkGenerator] Step 3: Creating ${nodes.length} results and ${data.length} indicators`);
    await tx.indicator.createMany({ data });

    // Update framework status
    await tx.framework.update({
      where: { id: frameworkId },
      data: { status: 'expert_review', aiModelUsed: aiModel, generationError: null },
    });

    // Update project status. A project archived while its framework was being generated stays archived (it is
    // read-only until restored, and restore puts back the status it had when archived).
    await tx.project.updateMany({
      where: { id: projectId, status: { not: 'archived' } },
      data: { status: 'framework_review' },
    });

    return { resultCount: nodes.length, indicatorCount: data.length };
  }, { maxWait: 10_000, timeout: 60_000 });

  // Create notification for admins
  const admins = await prisma.user.findMany({
    where: {
      organizationId: project.organizationId,
      role: { in: ['org_admin', 'platform_admin'] },
    },
  });

  for (const admin of admins) {
    await prisma.notification.create({
      data: {
        userId: admin.id,
        type: 'framework_approved',
        title: 'M&E Framework Generated',
        message: `AI has generated an M&E framework for "${project.name}" with ${indicatorCount} indicators across ${resultCount} results.`
          + (withoutIndicators.length > 0 ? ` No indicator could be generated for ${withoutIndicators.join(', ')}; add one or ask the KPI Assistant.` : '')
          + ' Please review.',
        link: `/projects/${projectId}/framework`,
      },
    });
  }

  console.log(`[FrameworkGenerator] Framework generation complete for project ${projectId} (${resultCount} results, ${indicatorCount} indicators)`);
}
