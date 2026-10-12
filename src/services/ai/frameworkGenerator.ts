import Anthropic from '@anthropic-ai/sdk';
import { IndicatorLevel, Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { env } from '../../config/env';
import { SYSTEM_CONTEXT } from './prompts/system';
import {
  FRAMEWORK_PROMPT_VERSION,
  FrameworkProjectInfo,
  extractProjectStructurePrompt,
  generateFrameworkPrompt,
} from './prompts/framework';
import {
  LibraryEntryReference,
  ProjectStructure,
  SourceDocument,
  buildStructureFromMetadata,
  extractIndicatorList,
  librarySectorsFor,
  linkedLibraryIds,
  normalizeIndicators,
  normalizeProjectStructure,
  planResultNodes,
  projectSectors,
  selectLibraryCandidates,
  stripAiAnalysis,
  structureForPrompt,
} from './frameworkNormalize';

const anthropic = new Anthropic({ apiKey: env.anthropicApiKey });

/** Model used for framework generation; stored on each indicator (Indicator.aiModel). Phase 3 moves model ids to config. */
export const FRAMEWORK_MODEL = 'claude-sonnet-4-20250514';

const LEVEL_ORDER: IndicatorLevel[] = ['impact', 'outcome', 'output', 'activity'];

/** Library entry fields used for the prompt candidates and for checking the model's indicators against linked entries. */
const LIBRARY_ENTRY_SELECT = {
  id: true, sector: true, name: true, definition: true, unit: true, level: true, methods: true, frequency: true,
  disaggregation: true, standardReference: true, isStandard: true, notes: true, meansOfVerification: true, calculation: true,
} satisfies Prisma.IndicatorLibraryEntrySelect;

function responseText(response: Anthropic.Messages.Message): string {
  return response.content
    .filter(block => block.type === 'text')
    .map(block => block.type === 'text' ? block.text : '')
    .join('');
}

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

  // Parsed document text is redacted by the document parser (no phone or ID numbers). The parser appends its own
  // AI analysis after a marker; only the document's own text is used (prompts and evidence), so model output never
  // "proves" a baseline or target.
  const documents: SourceDocument[] = project.documents
    .map(d => ({ fileName: d.fileName, text: stripAiAnalysis(d.parsedText ?? '') }))
    .filter(d => d.text.trim() !== '');
  const documentTexts = documents.map(d => d.text);

  const sectors = projectSectors(project);
  const projectInfo: FrameworkProjectInfo = {
    name: project.name,
    sector: project.sector,
    sectors,
    humanitarian: project.humanitarian,
    donor: project.donor,
    donorType: project.donorType,
    description: project.description || undefined,
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

    const structureResponse = await anthropic.messages.create({
      model: FRAMEWORK_MODEL,
      max_tokens: 8192,
      system: SYSTEM_CONTEXT,
      messages: [{ role: 'user', content: structurePrompt }],
    });

    try {
      structure = normalizeProjectStructure(JSON.parse(cleanJsonResponse(responseText(structureResponse))), { documentTexts });
    } catch {
      structure = null;
    }
    if (!structure) console.warn('[FrameworkGenerator] Failed to parse AI structure response, using metadata fallback');
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

  const frameworkResponse = await anthropic.messages.create({
    model: FRAMEWORK_MODEL,
    max_tokens: 16000,
    system: SYSTEM_CONTEXT,
    messages: [{ role: 'user', content: frameworkPrompt }],
  });

  let parsedIndicators: unknown;
  try {
    parsedIndicators = JSON.parse(cleanJsonResponse(responseText(frameworkResponse)));
  } catch {
    const cutOff = frameworkResponse.stop_reason === 'max_tokens' ? ' (the response was cut off at max_tokens)' : '';
    throw new Error(`Failed to parse indicators from AI response${cutOff}`);
  }

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
      aiModel: FRAMEWORK_MODEL,
      promptVersion: FRAMEWORK_PROMPT_VERSION,
    });
    if (payloads.length === 0) throw new Error('AI returned empty or invalid indicator set');

    console.log(`[FrameworkGenerator] Step 4: Creating ${nodes.length} results and ${payloads.length} indicators`);
    await tx.indicator.createMany({ data: payloads });

    // Update framework status
    await tx.framework.update({
      where: { id: frameworkId },
      data: { status: 'expert_review', aiModelUsed: FRAMEWORK_MODEL },
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

/**
 * Clean AI response that might have markdown code fences
 */
function cleanJsonResponse(text: string): string {
  let cleaned = text.trim();
  // Remove markdown code fences
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
  else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  return cleaned.trim();
}
