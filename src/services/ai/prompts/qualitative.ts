export function codeQualitativePrompt(
  entry: { title: string; content: string; entryType: string },
  projectContext: { sector: string; name: string },
): string {
  return `Perform thematic coding and analysis on the following qualitative data entry.

PROJECT: ${projectContext.name} (${projectContext.sector})
ENTRY TYPE: ${entry.entryType}
TITLE: ${entry.title}

CONTENT:
${entry.content}

Analyze the content and return a JSON object:
{
  "themes": ["theme1", "theme2", "theme3"],
  "sentiment": "positive|neutral|negative|mixed",
  "keyQuotes": [
    { "quote": "...", "theme": "..." }
  ],
  "summary": "Brief 2-3 sentence summary of key findings",
  "suggestedIndicatorLinks": [
    { "indicatorKeywords": "keywords that might match indicators", "relevance": "how this data relates" }
  ]
}

Return ONLY valid JSON, no markdown or explanation.`;
}
