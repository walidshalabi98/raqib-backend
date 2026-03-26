import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../../config/prisma';
import { env } from '../../config/env';
import {
  SYSTEM_CONTEXT,
  extractProjectStructurePrompt,
  generateFrameworkPrompt,
} from './prompts';

const anthropic = new Anthropic({ apiKey: env.anthropicApiKey });

export async function generateFramework(frameworkId: string, projectId: string): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      documents: { where: { parsingStatus: 'completed' } },
    },
  });

  if (!project) throw new Error(`Project ${projectId} not found`);

  const documentTexts = project.documents
    .map(d => d.parsedText)
    .filter((t): t is string => !!t);

  let projectStructure: Record<string, unknown>;

  if (documentTexts.length > 0) {
    // Step 1a: Extract project structure from documents
    console.log(`[FrameworkGenerator] Step 1: Extracting project structure from ${documentTexts.length} documents`);
    const structurePrompt = extractProjectStructurePrompt(documentTexts, {
      name: project.name,
      sector: project.sector,
      donor: project.donor,
      donorType: project.donorType,
      description: project.description || undefined,
      targetBeneficiaries: project.targetBeneficiaries || undefined,
      geographicScope: project.geographicScope || undefined,
    });

    const structureResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: SYSTEM_CONTEXT,
      messages: [{ role: 'user', content: structurePrompt }],
    });

    const structureText = structureResponse.content
      .filter(block => block.type === 'text')
      .map(block => block.type === 'text' ? block.text : '')
      .join('');

    try {
      projectStructure = JSON.parse(cleanJsonResponse(structureText));
    } catch {
      console.warn('[FrameworkGenerator] Failed to parse AI structure response, using metadata fallback');
      projectStructure = buildStructureFromMetadata(project);
    }
  } else {
    // Step 1b: No documents — build structure from project metadata
    console.log(`[FrameworkGenerator] Step 1: No documents available, using project metadata`);
    projectStructure = buildStructureFromMetadata(project);
  }

  // Step 2: Query template library for matching indicators
  console.log(`[FrameworkGenerator] Step 2: Querying template library`);
  const templates = await prisma.mETemplate.findMany({
    where: { sector: project.sector },
    take: 20,
  });

  const templateIndicators = templates.map(t => ({
    indicatorText: t.indicatorText,
    level: t.level,
    recommendedMethod: t.recommendedMethod,
    recommendedFrequency: t.recommendedFrequency,
  }));

  // Step 3: Generate full indicator set
  console.log(`[FrameworkGenerator] Step 3: Generating indicators`);
  const frameworkPrompt = generateFrameworkPrompt(
    projectStructure,
    templateIndicators,
    {
      sector: project.sector,
      donorType: project.donorType,
      targetBeneficiaries: project.targetBeneficiaries || undefined,
    },
  );

  const frameworkResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8192,
    system: SYSTEM_CONTEXT,
    messages: [{ role: 'user', content: frameworkPrompt }],
  });

  const indicatorsText = frameworkResponse.content
    .filter(block => block.type === 'text')
    .map(block => block.type === 'text' ? block.text : '')
    .join('');

  let indicators: Array<{
    indicatorText: string;
    indicatorTextAr?: string;
    level: string;
    dataCollectionMethod: string;
    frequency: string;
    baselineValue?: string;
    targetValue?: string;
    unit?: string;
    phases?: string[];
    aiRationale?: string;
  }>;

  try {
    indicators = JSON.parse(cleanJsonResponse(indicatorsText));
  } catch {
    throw new Error('Failed to parse indicators from AI response');
  }

  if (!Array.isArray(indicators) || indicators.length === 0) {
    throw new Error('AI returned empty or invalid indicator set');
  }

  // Validate enum values
  const validLevels = ['impact', 'outcome', 'output', 'activity'];
  const validMethods = ['hh_survey', 'fgd', 'kii', 'observation', 'document_review', 'participatory', 'secondary_data'];
  const validFrequencies = ['monthly', 'quarterly', 'biannual', 'annual', 'per_cohort', 'baseline_endline'];

  // Step 4: Create indicator records
  console.log(`[FrameworkGenerator] Step 4: Creating ${indicators.length} indicators`);
  for (let i = 0; i < indicators.length; i++) {
    const ind = indicators[i];
    const level = validLevels.includes(ind.level) ? ind.level : 'output';
    const method = validMethods.includes(ind.dataCollectionMethod) ? ind.dataCollectionMethod : 'hh_survey';
    const freq = validFrequencies.includes(ind.frequency) ? ind.frequency : 'quarterly';

    await prisma.indicator.create({
      data: {
        frameworkId,
        indicatorText: ind.indicatorText,
        indicatorTextAr: ind.indicatorTextAr,
        level: level as any,
        dataCollectionMethod: method as any,
        frequency: freq as any,
        baselineValue: ind.baselineValue,
        targetValue: ind.targetValue,
        unit: ind.unit,
        phases: ind.phases || ['baseline', 'midterm', 'endline'],
        aiRationale: ind.aiRationale,
        sortOrder: i,
      },
    });
  }

  // Update framework status
  await prisma.framework.update({
    where: { id: frameworkId },
    data: { status: 'expert_review' },
  });

  // Update project status
  await prisma.project.update({
    where: { id: projectId },
    data: { status: 'framework_review' },
  });

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
        message: `AI has generated an M&E framework for "${project.name}" with ${indicators.length} indicators. Please review.`,
        link: `/projects/${projectId}/framework`,
      },
    });
  }

  console.log(`[FrameworkGenerator] Framework generation complete for ${project.name} (${indicators.length} indicators)`);
}

/**
 * Build a project structure from metadata when no documents are available
 */
function buildStructureFromMetadata(project: any): Record<string, unknown> {
  const sectorGoals: Record<string, string> = {
    livelihoods: 'Improved livelihood opportunities and economic resilience for vulnerable communities',
    education: 'Enhanced quality and access to education for marginalized populations',
    health: 'Improved health outcomes and access to healthcare services',
    wash: 'Improved access to safe water, sanitation, and hygiene practices',
    protection: 'Enhanced protection of vulnerable populations and human rights',
    food_security: 'Improved food security and nutrition for vulnerable households',
    governance: 'Strengthened governance, transparency, and civic participation',
    agriculture: 'Enhanced agricultural productivity and sustainable farming practices',
    gender: 'Advanced gender equality and women\'s empowerment',
    youth: 'Improved opportunities and engagement for youth',
    other: 'Improved well-being of target communities',
  };

  return {
    goal: sectorGoals[project.sector] || sectorGoals.other,
    outcomes: [
      {
        text: `Outcome 1: ${project.description || `Improved ${project.sector} outcomes for target beneficiaries in ${project.geographicScope || 'Palestine'}`}`,
        outputs: [
          { text: 'Output 1.1: Service delivery and capacity building', activities: ['Direct service provision', 'Training and workshops'] },
          { text: 'Output 1.2: Community engagement and awareness', activities: ['Community mobilization', 'Awareness campaigns'] },
        ],
      },
      {
        text: `Outcome 2: Strengthened institutional and community capacity in ${project.sector}`,
        outputs: [
          { text: 'Output 2.1: Institutional strengthening', activities: ['Policy development support', 'Organizational capacity assessment'] },
        ],
      },
    ],
    beneficiaries: {
      total: project.targetBeneficiaries || 500,
      types: ['Direct beneficiaries', 'Indirect beneficiaries', 'Community members'],
      disaggregation: ['male', 'female', 'youth', 'pwd'],
    },
    timeline: {
      startDate: project.startDate,
      endDate: project.endDate,
      phases: ['Inception', 'Implementation', 'Monitoring', 'Evaluation'],
    },
    donorRequirements: getDonorRequirements(project.donorType),
    crossCuttingThemes: ['gender', 'environment', 'conflict_sensitivity', 'do_no_harm'],
  };
}

function getDonorRequirements(donorType: string): string[] {
  const requirements: Record<string, string[]> = {
    eu: ['ROM methodology compliance', 'Gender mainstreaming evidence', 'Results matrix alignment', 'Visibility guidelines'],
    usaid: ['AMELP compliance', 'Gender analysis', 'Environment screening', 'Do No Harm assessment'],
    giz: ['Results-based monitoring', 'Capacity development tracking', 'Sustainability indicators'],
    undp: ['SDG alignment', 'Human development indicators', 'South-South cooperation tracking'],
    unicef: ['Child rights-based indicators', 'Equity focus', 'HACT compliance'],
    sida: ['Results framework alignment', 'HRBA indicators', 'Conflict sensitivity analysis'],
    other: ['Standard logframe indicators', 'Gender-disaggregated data'],
  };
  return requirements[donorType] || requirements.other;
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
