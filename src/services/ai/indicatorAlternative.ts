import { prisma } from '../../config/prisma';
import { generateStructured } from './client';
import { redactPersonalData } from './redact';
import {
  ALTERNATIVES_PROMPT_VERSION,
  ALTERNATIVES_SCHEMA,
  ALTERNATIVES_SYSTEM,
  AlternativesAnswer,
  generateAlternativesPrompt,
} from './prompts/alternatives';

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

/** At most this many alternatives are returned. */
const MAX_ALTERNATIVES = 5;
const MAX_LIST_ITEMS = 5;

/**
 * Asks the model (fast tier) for alternative indicators to an indicator of the project. AI errors
 * propagate (typed errors from ./errors; their messages hold no prompt or model text).
 */
export async function generateIndicatorAlternatives(
  indicatorId: string,
  projectId: string,
): Promise<AlternativeIndicator[]> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
  });
  if (!project) throw new Error(`Project ${projectId} not found`);

  // The indicator must belong to one of the project's frameworks.
  const indicator = await prisma.indicator.findFirst({
    where: { id: indicatorId, framework: { projectId } },
    include: { result: { select: { code: true, text: true } } },
  });
  if (!indicator) throw new Error(`Indicator ${indicatorId} not found`);

  const prompt = generateAlternativesPrompt(
    {
      indicatorText: indicator.indicatorText,
      level: indicator.level,
      dataCollectionMethod: indicator.dataCollectionMethod,
      frequency: indicator.frequency,
      definition: indicator.definition,
      unit: indicator.unit,
      resultText: indicator.result?.text,
      resultCode: indicator.result?.code,
    },
    {
      sector: project.sector,
      donor: project.donor,
      donorType: project.donorType,
      description: project.description ? redactPersonalData(project.description).text : null,
      humanitarian: project.humanitarian,
    },
  );

  const result = await generateStructured({
    feature: 'indicator.alternatives',
    model: 'fast',
    effort: 'low',
    system: ALTERNATIVES_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    schema: ALTERNATIVES_SCHEMA,
    promptVersion: ALTERNATIVES_PROMPT_VERSION,
    maxTokens: 4000,
    context: { organizationId: project.organizationId, projectId: project.id },
  });

  const alternatives = normalizeAlternatives(result.data, { level: indicator.level, indicatorText: indicator.indicatorText });
  console.log(`[IndicatorAlternatives] ${alternatives.length} alternatives for indicator ${indicatorId} (${result.model}, ${result.promptVersion})`);
  return alternatives;
}

/**
 * Whether an indicator text states a direction or a target instead of what is measured
 * (me-foundations §2 rule 2): "Increase the number of…", "Improved access…", "… to 80%", "زيادة…".
 */
export function hasDirectionalWording(text: string): boolean {
  const value = text.trim();
  const leadingVerb = /^(?:to\s+)?(?:increas|decreas|reduc|improv|rais|achiev|reach|ensur|enhanc|strengthen|boost|expand|minimi[sz]|maximi[sz])\w*\b/i;
  const leadingArabic = /^(?:زيادة|تقليل|خفض|تحسين|رفع|تعزيز|الوصول\s+إلى|ضمان|تقليص)/;
  const target = /\b(?:to|by)\s+(?:at\s+least\s+)?\d[\d,.]*\s*%/i;
  return leadingVerb.test(value) || leadingArabic.test(value) || target.test(value);
}

/**
 * Tidies the model's answer: trims text, drops empty, duplicate and directional alternatives (and
 * any that repeat the current indicator), caps list sizes, and sets every level to the current
 * indicator's level.
 */
export function normalizeAlternatives(
  answer: AlternativesAnswer,
  current: { level: string; indicatorText: string },
): AlternativeIndicator[] {
  const key = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
  const seen = new Set<string>([key(current.indicatorText)]);
  const list = (values: string[]) => (values ?? []).map(v => (v ?? '').trim()).filter(Boolean).slice(0, MAX_LIST_ITEMS);
  const out: AlternativeIndicator[] = [];

  for (const alt of answer.alternatives ?? []) {
    const indicatorText = (alt.indicatorText ?? '').trim();
    if (!indicatorText || seen.has(key(indicatorText)) || hasDirectionalWording(indicatorText)) continue;
    seen.add(key(indicatorText));
    const indicatorTextAr = (alt.indicatorTextAr ?? '').trim();
    out.push({
      indicatorText,
      ...(indicatorTextAr ? { indicatorTextAr } : {}),
      level: current.level,
      dataCollectionMethod: alt.dataCollectionMethod,
      frequency: alt.frequency,
      rationale: (alt.rationale ?? '').trim(),
      pros: list(alt.pros),
      cons: list(alt.cons),
    });
    if (out.length >= MAX_ALTERNATIVES) break;
  }
  return out;
}
