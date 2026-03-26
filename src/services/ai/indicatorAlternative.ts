import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../../config/prisma';
import { env } from '../../config/env';
import { SYSTEM_CONTEXT, generateAlternativesPrompt } from './prompts';

const anthropic = new Anthropic({ apiKey: env.anthropicApiKey });

export interface AlternativeIndicator {
  indicatorText: string;
  indicatorTextAr?: string;
  level: string;
  dataCollectionMethod: string;
  frequency: string;
  rationale: string;
  pros: string[];
  cons: string[];
}

export async function generateIndicatorAlternatives(
  indicatorId: string,
  projectId: string,
): Promise<AlternativeIndicator[]> {
  const indicator = await prisma.indicator.findUnique({
    where: { id: indicatorId },
  });
  if (!indicator) throw new Error(`Indicator ${indicatorId} not found`);

  const project = await prisma.project.findUnique({
    where: { id: projectId },
  });
  if (!project) throw new Error(`Project ${projectId} not found`);

  const prompt = generateAlternativesPrompt(
    {
      indicatorText: indicator.indicatorText,
      level: indicator.level,
      dataCollectionMethod: indicator.dataCollectionMethod,
    },
    {
      sector: project.sector,
      donor: project.donor,
      description: project.description || undefined,
    },
  );

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: SYSTEM_CONTEXT,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.type === 'text' ? block.text : '')
    .join('');

  try {
    const alternatives: AlternativeIndicator[] = JSON.parse(text);
    return alternatives;
  } catch {
    throw new Error('Failed to parse alternatives from AI response');
  }
}
