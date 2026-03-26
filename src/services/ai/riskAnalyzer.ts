import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../../config/prisma';
import { env } from '../../config/env';

const anthropic = new Anthropic({ apiKey: env.anthropicApiKey });

export interface RiskAlert {
  indicatorId: string;
  indicatorText: string;
  level: string;
  currentValue: number | null;
  targetValue: number | null;
  status: string;
  riskLevel: 'critical' | 'high' | 'medium' | 'low';
  trend: 'declining' | 'stagnant' | 'improving';
  aiAnalysis: string;
  suggestedActions: string[];
  estimatedImpact: string;
}

export async function analyzeProjectRisks(projectId: string): Promise<RiskAlert[]> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
  });
  if (!project) return [];

  const framework = await prisma.framework.findFirst({
    where: { projectId, status: { in: ['approved', 'active', 'expert_review', 'client_review'] } },
    orderBy: { version: 'desc' },
    include: {
      indicators: {
        include: {
          dataPoints: {
            orderBy: { collectionDate: 'desc' },
            take: 10,
          },
        },
      },
    },
  });

  if (!framework) return [];
  const atRiskIndicators = framework.indicators.filter(
    (ind) => ind.status === 'off_track' || ind.status === 'at_risk'
  );

  if (atRiskIndicators.length === 0) return [];

  // Build context for AI
  const indicatorContext = atRiskIndicators.map((ind) => ({
    id: ind.id,
    text: ind.indicatorText,
    level: ind.level,
    status: ind.status,
    baseline: ind.baselineValue,
    target: ind.targetValue,
    current: ind.currentValue,
    dataPoints: ind.dataPoints.map((dp) => ({
      value: dp.value,
      date: dp.collectionDate.toISOString().split('T')[0],
    })),
  }));

  const prompt = `You are an M&E risk analyst for development projects in Palestine.

Analyze these at-risk/off-track indicators and provide actionable risk assessments:

Project: ${project.name}
Sector: ${project.sector}
Donor: ${project.donor}

Indicators requiring attention:
${JSON.stringify(indicatorContext, null, 2)}

For EACH indicator, provide a JSON array with:
{
  "indicatorId": "the indicator id",
  "riskLevel": "critical|high|medium|low",
  "trend": "declining|stagnant|improving",
  "analysis": "2-3 sentence analysis of why this indicator is at risk",
  "suggestedActions": ["action 1", "action 2", "action 3"],
  "estimatedImpact": "Brief description of impact if not addressed"
}

Return ONLY a valid JSON array. No markdown.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const aiResults = JSON.parse(cleaned);

    return atRiskIndicators.map((ind) => {
      const aiResult = aiResults.find((r: any) => r.indicatorId === ind.id) || {};
      return {
        indicatorId: ind.id,
        indicatorText: ind.indicatorText,
        level: ind.level,
        currentValue: ind.currentValue ? parseFloat(ind.currentValue.toString()) : null,
        targetValue: ind.targetValue ? parseFloat(ind.targetValue.toString()) : null,
        status: ind.status,
        riskLevel: aiResult.riskLevel || (ind.status === 'off_track' ? 'high' : 'medium'),
        trend: aiResult.trend || 'stagnant',
        aiAnalysis: aiResult.analysis || 'Indicator needs attention.',
        suggestedActions: aiResult.suggestedActions || ['Review data collection methods', 'Consult with field team'],
        estimatedImpact: aiResult.estimatedImpact || 'May affect project outcomes if not addressed.',
      };
    });
  } catch (err: any) {
    console.error('Risk analysis AI failed:', err.message);
    // Return basic risk info without AI
    return atRiskIndicators.map((ind) => ({
      indicatorId: ind.id,
      indicatorText: ind.indicatorText,
      level: ind.level,
      currentValue: ind.currentValue ? parseFloat(ind.currentValue.toString()) : null,
      targetValue: ind.targetValue ? parseFloat(ind.targetValue.toString()) : null,
      status: ind.status,
      riskLevel: (ind.status === 'off_track' ? 'high' : 'medium') as 'high' | 'medium',
      trend: 'stagnant' as const,
      aiAnalysis: `This ${ind.level} indicator is ${ind.status.replace('_', ' ')} and requires attention.`,
      suggestedActions: ['Review data collection methods', 'Consult with field team', 'Consider timeline adjustments'],
      estimatedImpact: 'May affect project outcomes if not addressed promptly.',
    }));
  }
}
