import { prisma } from '../../config/prisma';
import { generateStructured } from './client';
import { redactPersonalData } from './redact';
import {
  codeQualitativePrompt,
  QUALITATIVE_PROMPT_VERSION,
  QUALITATIVE_SCHEMA,
  QUALITATIVE_SYSTEM,
  QualitativeAnswer,
} from './prompts/qualitative';

const MAX_THEMES = 10;
const MAX_THEME_LENGTH = 200;

/**
 * Codes a qualitative entry with the model (fast tier): themes, sentiment and links to the
 * project's indicators, stored on the entry. The title and content are redacted before they are
 * sent (CLAUDE.md rule 5). Logs hold ids and counts only, never entry text or model output.
 */
export async function codeQualitativeEntry(entryId: string, projectId: string): Promise<void> {
  const entry = await prisma.qualitativeEntry.findFirst({
    where: { id: entryId, projectId },
  });
  if (!entry) throw new Error(`Qualitative entry ${entryId} not found`);

  const project = await prisma.project.findUnique({
    where: { id: projectId },
  });
  if (!project) throw new Error(`Project ${projectId} not found`);

  const title = redactPersonalData(entry.title);
  const content = redactPersonalData(entry.content);
  const removed = sumCounts(title.counts) + sumCounts(content.counts);

  const prompt = codeQualitativePrompt(
    {
      title: title.text,
      content: content.text,
      entryType: entry.entryType,
    },
    {
      sector: project.sector,
      name: project.name,
    },
  );

  const result = await generateStructured({
    feature: 'qualitative.coding',
    model: 'fast',
    effort: 'low',
    system: QUALITATIVE_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    schema: QUALITATIVE_SCHEMA,
    promptVersion: QUALITATIVE_PROMPT_VERSION,
    maxTokens: 4000,
    context: { organizationId: project.organizationId, projectId: project.id },
  });
  const analysis = result.data;
  const themes = normalizeThemes(analysis.themes);

  // Link to the indicators of the current framework (the newest version whose generation did not fail).
  const framework = await prisma.framework.findFirst({
    where: { projectId, generationError: null },
    orderBy: { version: 'desc' },
    include: { indicators: { select: { id: true, indicatorText: true, indicatorTextAr: true } } },
  });
  const linkedIndicatorIds = framework ? linkIndicators(analysis.suggestedIndicatorLinks, framework.indicators) : [];

  await prisma.qualitativeEntry.update({
    where: { id: entryId },
    data: {
      themes,
      sentiment: analysis.sentiment,
      linkedIndicators: linkedIndicatorIds.length > 0 ? linkedIndicatorIds : undefined,
    },
  });

  console.log(`[QualitativeCoder] Coded entry ${entryId}: ${themes.length} themes, sentiment ${analysis.sentiment}, ${linkedIndicatorIds.length} linked indicators (${removed} personal data items redacted; ${result.model})`);
}

function sumCounts(counts: { phone: number; idNumber: number; email: number }): number {
  return counts.phone + counts.idNumber + counts.email;
}

/** Trimmed, redacted, de-duplicated themes (at most MAX_THEMES). */
export function normalizeThemes(themes: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of themes ?? []) {
    const theme = redactPersonalData((raw ?? '').trim()).text.slice(0, MAX_THEME_LENGTH);
    const key = theme.toLowerCase();
    if (!theme || seen.has(key)) continue;
    seen.add(key);
    out.push(theme);
    if (out.length >= MAX_THEMES) break;
  }
  return out;
}

/** Words that appear in most indicators and say nothing about the topic. */
const STOP_WORDS = new Set([
  'number', 'percentage', 'percent', 'proportion', 'rate', 'total', 'people', 'persons', 'with', 'from', 'that', 'this',
  'which', 'their', 'have', 'been', 'more', 'less', 'other', 'among', 'project', 'indicator', 'data', 'access', 'level',
  'عدد', 'نسبة', 'التي', 'الذين', 'على', 'إلى', 'من', 'في',
]);

/** The topic keywords of a link: lower-case words of at least 3 letters (4 for Latin script) that are not stop words. */
export function linkKeywords(indicatorKeywords: string): string[] {
  const words = (indicatorKeywords ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const keep = words.filter(w => !STOP_WORDS.has(w) && w.length >= (/^[\p{Script=Latin}\p{N}]+$/u.test(w) ? 4 : 3));
  return [...new Set(keep)];
}

/**
 * Maps the model's suggested links to indicator ids: for each link, the indicator whose English or
 * Arabic text contains the most of its keywords (at least one). Ids are unique, in link order.
 */
export function linkIndicators(
  links: QualitativeAnswer['suggestedIndicatorLinks'],
  indicators: readonly { id: string; indicatorText: string; indicatorTextAr?: string | null }[],
): string[] {
  const texts = indicators.map(ind => `${ind.indicatorText} ${ind.indicatorTextAr ?? ''}`.toLowerCase());
  const linked: string[] = [];
  for (const link of links ?? []) {
    const keywords = linkKeywords(link.indicatorKeywords);
    if (keywords.length === 0) continue;
    let best = -1;
    let bestScore = 0;
    texts.forEach((text, i) => {
      const score = keywords.filter(kw => text.includes(kw)).length;
      if (score > bestScore) {
        best = i;
        bestScore = score;
      }
    });
    if (best >= 0 && !linked.includes(indicators[best].id)) linked.push(indicators[best].id);
  }
  return linked;
}
