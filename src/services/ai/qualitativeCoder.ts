import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../../config/prisma';
import { env } from '../../config/env';
import { SYSTEM_CONTEXT, codeQualitativePrompt } from './prompts';

const anthropic = new Anthropic({ apiKey: env.anthropicApiKey });

export async function codeQualitativeEntry(entryId: string, projectId: string): Promise<void> {
  const entry = await prisma.qualitativeEntry.findUnique({
    where: { id: entryId },
  });
  if (!entry) throw new Error(`Qualitative entry ${entryId} not found`);

  const project = await prisma.project.findUnique({
    where: { id: projectId },
  });
  if (!project) throw new Error(`Project ${projectId} not found`);

  const prompt = codeQualitativePrompt(
    {
      title: entry.title,
      content: entry.content,
      entryType: entry.entryType,
    },
    {
      sector: project.sector,
      name: project.name,
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

  let analysis: {
    themes: string[];
    sentiment: string;
    keyQuotes: Array<{ quote: string; theme: string }>;
    summary: string;
    suggestedIndicatorLinks: Array<{ indicatorKeywords: string; relevance: string }>;
  };

  try {
    analysis = JSON.parse(text);
  } catch {
    throw new Error('Failed to parse qualitative coding from AI response');
  }

  // Try to link to actual indicators
  const framework = await prisma.framework.findFirst({
    where: { projectId },
    orderBy: { version: 'desc' },
    include: { indicators: true },
  });

  const linkedIndicatorIds: string[] = [];
  if (framework && analysis.suggestedIndicatorLinks) {
    for (const link of analysis.suggestedIndicatorLinks) {
      const keywords = link.indicatorKeywords.toLowerCase().split(' ');
      for (const indicator of framework.indicators) {
        const indicatorLower = indicator.indicatorText.toLowerCase();
        if (keywords.some(kw => indicatorLower.includes(kw))) {
          linkedIndicatorIds.push(indicator.id);
          break;
        }
      }
    }
  }

  await prisma.qualitativeEntry.update({
    where: { id: entryId },
    data: {
      themes: analysis.themes,
      sentiment: analysis.sentiment as any,
      linkedIndicators: linkedIndicatorIds.length > 0 ? linkedIndicatorIds : undefined,
    },
  });

  console.log(`[QualitativeCoder] Coded entry "${entry.title}" — ${analysis.themes.length} themes, sentiment: ${analysis.sentiment}`);
}
