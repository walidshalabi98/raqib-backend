/**
 * AI framework generation (BUILD_GUIDE Phase 2 task 7, Phase 3): two structured-output calls on the
 * main tier through the AI client, then deterministic normalisation (frameworkNormalize.ts).
 * 1. "framework.structure": the coded results chain and the figures quoted in the documents
 *    (skipped without documents; the results chain is then built from the project's metadata).
 * 2. "framework.indicators": one draft reference sheet per indicator.
 * Only aggregates and redacted document text reach the model; logs hold counts and ids only.
 */

import { IndicatorLevel, Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { generateStructured } from './client';
import { AiInvalidOutputError, AiOutputTruncatedError } from './errors';
import { redactPersonalData } from './redact';
import {
  FRAMEWORK_INDICATORS_SCHEMA,
  FRAMEWORK_INDICATORS_SYSTEM,
  FRAMEWORK_PROMPT_VERSION,
  FRAMEWORK_STRUCTURE_SYSTEM,
  FrameworkProjectInfo,
  PROJECT_STRUCTURE_SCHEMA,
  extractProjectStructurePrompt,
  generateFrameworkPrompt,
} from './prompts/framework';
import {
  LibraryEntryReference,
  ProjectStructure,
  SourceDocument,
  buildStructureFromMetadata,
  documentTextForAi,
  extractIndicatorList,
  librarySectorsFor,
  linkedLibraryIds,
  normalizeIndicators,
  normalizeProjectStructure,
  planResultNodes,
  projectSectors,
  selectLibraryCandidates,
  structureForPrompt,
} from './frameworkNormalize';

/** Token limits and timeouts (thinking counts towards max tokens; the client retries a cut-off answer once with twice the limit). */
const STRUCTURE_CALL = { maxTokens: 12_000, timeoutMs: 180_000 } as const;
const INDICATORS_CALL = { maxTokens: 32_000, timeoutMs: 300_000 } as const;

const LEVEL_ORDER: IndicatorLevel[] = ['impact', 'outcome', 'output', 'activity'];

/** Library entry fields used for the prompt candidates and for checking the model's indicators against linked entries. */
const LIBRARY_ENTRY_SELECT = {
  id: true, sector: true, name: true, definition: true, unit: true, level: true, methods: true, frequency: true,
  disaggregation: true, standardReference: true, isStandard: true, notes: true, meansOfVerification: true, calculation: true,
} satisfies Prisma.IndicatorLibraryEntrySelect;

export async function generateFramework(frameworkId: string, projectId: string): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      documents: { where: { parsingStatus: 'completed' } },
    },
  });

  if (!project) throw new Error(`Project ${projectId} not found`);

  const framework = await prisma.framework.findUnique({
    where: { id: frameworkId },
    select: { projectId: true, _count: { select: { resultNodes: true, indicators: true } } },
  });
  if (!framework || framework.projectId !== projectId) throw new Error(`Framework ${frameworkId} not found for project ${projectId}`);
  // A retried job must not duplicate the results chain; a new version is generated instead.
  if (framework._count.resultNodes > 0 || framework._count.indicators > 0) {
    throw new Error(`Framework ${frameworkId} already has results or indicators; generate a new framework version instead`);
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
  const projectInfo: FrameworkProjectInfo = {
    name: project.name,
    sector: project.sector,
    sectors,
    humanitarian: project.humanitarian,
    donor: project.donor,
    donorType: project.donorType,
    // Organisational text, but staff sometimes add a contact number: redact it like the documents.
    description: project.description ? redactPersonalData(project.description).text : undefined,
    targetBeneficiaries: project.targetBeneficiaries || undefined,
    geographicScope: project.geographicScope || undefined,
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
  if (!structure) structure = buildStructureFromMetadata(project);

  // Step 2: Indicator library candidates (project sectors + cross-cutting; accountability entries for humanitarian projects)
  console.log(`[FrameworkGenerator] Step 2: Querying indicator library`);
  const libraryRows = await prisma.indicatorLibraryEntry.findMany({
    where: {
      OR: [
        { sector: { in: librarySectorsFor(sectors) } },
        ...(project.humanitarian ? [{ id: { startsWith: 'AC-' } }] : []),
      ],
    },
    select: LIBRARY_ENTRY_SELECT,
  });
  const candidates = selectLibraryCandidates(libraryRows, { sectors, humanitarian: project.humanitarian });

  // Every library id is accepted (not only the candidates): the model may know a better-fitting entry.
  const libraryIndex = await prisma.indicatorLibraryEntry.findMany({ select: { id: true } });
  const knownLibraryIds = new Set(libraryIndex.map(e => e.id));

  // Step 3: Generate the indicator set
  console.log(`[FrameworkGenerator] Step 3: Generating indicators (${candidates.length} library candidates)`);
  const frameworkPrompt = generateFrameworkPrompt(
    structureForPrompt(structure),
    candidates,
    projectInfo,
    { hasDocuments: documentTexts.length > 0 },
  );

  // Errors propagate: the framework stays as it was and the job fails.
  const indicatorAnswer = await generateStructured({
    feature: 'framework.indicators',
    model: 'main',
    effort: 'medium',
    ...INDICATORS_CALL,
    system: FRAMEWORK_INDICATORS_SYSTEM,
    messages: [{ role: 'user', content: frameworkPrompt }],
    schema: FRAMEWORK_INDICATORS_SCHEMA,
    promptVersion: FRAMEWORK_PROMPT_VERSION,
    context,
  });
  const parsedIndicators = indicatorAnswer.data;
  // The served model (it may differ from the configured one after a server-side fallback).
  const aiModel = indicatorAnswer.model;

  if (extractIndicatorList(parsedIndicators).length === 0) {
    throw new Error('AI returned empty or invalid indicator set');
  }

  // Linked library entries (standard reference, sex disaggregation, standard thresholds): the loaded rows,
  // plus any linked entry outside the candidate sectors.
  const libraryEntries = new Map<string, LibraryEntryReference>(libraryRows.map(e => [e.id, e]));
  const missingLibraryIds = linkedLibraryIds(parsedIndicators).filter(id => knownLibraryIds.has(id) && !libraryEntries.has(id));
  if (missingLibraryIds.length > 0) {
    const linkedRows = await prisma.indicatorLibraryEntry.findMany({ where: { id: { in: missingLibraryIds } }, select: LIBRARY_ENTRY_SELECT });
    for (const entry of linkedRows) libraryEntries.set(entry.id, entry);
  }

  // Step 4: Create the results chain and the indicators together, so a failure leaves no partial framework
  const plan = planResultNodes(structure);
  const { resultCount, indicatorCount } = await prisma.$transaction(async tx => {
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
      // Keep the plan's order (goal, outcomes, outputs, activities) for the "first node of a level" fallback.
      for (const p of rows) {
        const node = created.find(c => c.code === p.code);
        if (node) nodes.push(node);
      }
    }

    const payloads = normalizeIndicators(parsedIndicators, {
      frameworkId,
      resultNodes: nodes,
      knownLibraryIds,
      libraryEntries,
      documents,
      aiModel,
      promptVersion: FRAMEWORK_PROMPT_VERSION,
    });
    if (payloads.length === 0) throw new Error('AI returned empty or invalid indicator set');

    console.log(`[FrameworkGenerator] Step 4: Creating ${nodes.length} results and ${payloads.length} indicators`);
    await tx.indicator.createMany({ data: payloads });

    // Update framework status
    await tx.framework.update({
      where: { id: frameworkId },
      data: { status: 'expert_review', aiModelUsed: aiModel },
    });

    // Update project status
    await tx.project.update({
      where: { id: projectId },
      data: { status: 'framework_review' },
    });

    return { resultCount: nodes.length, indicatorCount: payloads.length };
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
        message: `AI has generated an M&E framework for "${project.name}" with ${indicatorCount} indicators across ${resultCount} results. Please review.`,
        link: `/projects/${projectId}/framework`,
      },
    });
  }

  console.log(`[FrameworkGenerator] Framework generation complete for ${project.name} (${resultCount} results, ${indicatorCount} indicators)`);
}
