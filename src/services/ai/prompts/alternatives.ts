export function generateAlternativesPrompt(
  currentIndicator: { indicatorText: string; level: string; dataCollectionMethod: string },
  projectContext: { sector: string; donor: string; description?: string },
): string {
  return `You are reviewing the following M&E indicator and need to suggest 3 alternatives.

CURRENT INDICATOR:
- Text: ${currentIndicator.indicatorText}
- Level: ${currentIndicator.level}
- Current method: ${currentIndicator.dataCollectionMethod}

PROJECT CONTEXT:
- Sector: ${projectContext.sector}
- Donor: ${projectContext.donor}
${projectContext.description ? `- Description: ${projectContext.description}` : ''}

Generate 3 alternative indicators that:
1. Measure a similar dimension but with a different approach
2. Use different data collection methods where appropriate
3. Are SMART and appropriate for the Palestinian context

Return a JSON array:
[
  {
    "indicatorText": "...",
    "indicatorTextAr": "...",
    "level": "${currentIndicator.level}",
    "dataCollectionMethod": "...",
    "frequency": "...",
    "rationale": "Why this alternative might be better",
    "pros": ["..."],
    "cons": ["..."]
  }
]

Return ONLY valid JSON array, no markdown or explanation.`;
}
