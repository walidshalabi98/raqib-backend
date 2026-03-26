export const SYSTEM_CONTEXT = `You are an expert M&E (Monitoring & Evaluation) specialist for development projects in Palestine. You have deep expertise in:
- Designing results frameworks and logframes for NGOs and INGOs
- Creating SMART indicators aligned with donor requirements (USAID, EU, GIZ, UNDP, UNICEF, SIDA)
- Data collection methodologies appropriate for the Palestinian context
- Humanitarian and development sector standards
- Bilingual (English/Arabic) M&E frameworks

You always produce structured, professional outputs that follow international M&E best practices while being contextually appropriate for Palestine.`;

export function extractProjectStructurePrompt(documentTexts: string[], projectInfo: {
  name: string;
  sector: string;
  donor: string;
  donorType: string;
  description?: string;
  targetBeneficiaries?: number;
  geographicScope?: string;
}): string {
  return `Analyze the following project documents and extract the project structure.

PROJECT INFO:
- Name: ${projectInfo.name}
- Sector: ${projectInfo.sector}
- Donor: ${projectInfo.donor} (${projectInfo.donorType})
${projectInfo.description ? `- Description: ${projectInfo.description}` : ''}
${projectInfo.targetBeneficiaries ? `- Target Beneficiaries: ${projectInfo.targetBeneficiaries}` : ''}
${projectInfo.geographicScope ? `- Geographic Scope: ${projectInfo.geographicScope}` : ''}

DOCUMENTS:
${documentTexts.map((text, i) => `--- Document ${i + 1} ---\n${text.slice(0, 8000)}`).join('\n\n')}

Extract and return a JSON object with this exact structure:
{
  "goal": "The overall project goal/impact statement",
  "outcomes": [
    {
      "text": "Outcome statement",
      "outputs": [
        {
          "text": "Output statement",
          "activities": ["Activity 1", "Activity 2"]
        }
      ]
    }
  ],
  "beneficiaries": {
    "total": number,
    "types": ["Type 1", "Type 2"],
    "disaggregation": ["male", "female", "youth", "pwd"]
  },
  "timeline": {
    "startDate": "YYYY-MM-DD",
    "endDate": "YYYY-MM-DD",
    "phases": ["Phase 1: ...", "Phase 2: ..."]
  },
  "donorRequirements": ["Requirement 1", "Requirement 2"],
  "crossCuttingThemes": ["gender", "environment", "conflict_sensitivity"]
}

Return ONLY valid JSON, no markdown or explanation.`;
}

export function generateFrameworkPrompt(
  projectStructure: Record<string, unknown>,
  templateIndicators: Array<{ indicatorText: string; level: string; recommendedMethod: string; recommendedFrequency: string }>,
  projectInfo: { sector: string; donorType: string; targetBeneficiaries?: number },
): string {
  return `Based on the following project structure and reference indicators, generate a complete M&E framework.

PROJECT STRUCTURE:
${JSON.stringify(projectStructure, null, 2)}

REFERENCE INDICATORS FROM TEMPLATE LIBRARY (use these as inspiration, adapt as needed):
${templateIndicators.map(t => `- [${t.level}] ${t.indicatorText} (Method: ${t.recommendedMethod}, Freq: ${t.recommendedFrequency})`).join('\n')}

REQUIREMENTS:
- Sector: ${projectInfo.sector}
- Donor type: ${projectInfo.donorType}
- Target beneficiaries: ${projectInfo.targetBeneficiaries || 'Not specified'}
- Include indicators at all levels: impact (1-2), outcome (3-5), output (5-8), activity (3-5)
- All indicators must be SMART (Specific, Measurable, Achievable, Relevant, Time-bound)
- Include appropriate data collection methods for the Palestinian context
- Set realistic frequencies
- Suggest baseline and target values where possible

Return a JSON array of indicators:
[
  {
    "indicatorText": "...",
    "indicatorTextAr": "...",
    "level": "impact|outcome|output|activity",
    "dataCollectionMethod": "hh_survey|fgd|kii|observation|document_review|participatory|secondary_data",
    "frequency": "monthly|quarterly|biannual|annual|per_cohort|baseline_endline",
    "baselineValue": "0" or null,
    "targetValue": "..." or null,
    "unit": "%" or "number" or "score" etc.,
    "phases": ["baseline", "midterm", "endline"],
    "aiRationale": "Brief explanation of why this indicator was chosen and how it links to the results chain",
    "startDate": "ISO date string (e.g. 2025-01-15) — estimated start date for data collection on this indicator, based on project start/end dates and the indicator's phase",
    "endDate": "ISO date string (e.g. 2025-12-31) — estimated deadline for achieving the target",
    "responsibility": "Suggested responsible party, e.g. 'M&E Officer', 'Field Team', 'Project Manager', 'Data Analyst', 'Community Mobilizer'",
    "milestones": [
      {"label": "Baseline data collection", "date": "2025-03-01", "completed": false},
      {"label": "Midterm review", "date": "2025-06-15", "completed": false}
    ]
  }
]

IMPORTANT for timeline fields:
- Use the project start and end dates from the PROJECT STRUCTURE above to derive realistic startDate and endDate values for each indicator.
- Impact-level indicators should span the full project period. Output/activity indicators should have shorter, earlier timelines.
- Milestones should include key data collection events and review points relevant to the indicator.
- Responsibility should match the indicator level: impact/outcome indicators to senior staff, output/activity to field teams.

Return ONLY valid JSON array, no markdown or explanation.`;
}

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

export function writeNarrativePrompt(
  projectInfo: { name: string; sector: string; donor: string; periodStart?: string; periodEnd?: string },
  indicators: Array<{
    indicatorText: string;
    level: string;
    status: string;
    baselineValue?: string;
    targetValue?: string;
    currentValue?: string;
    dataPoints: Array<{ value: string; date: string }>;
  }>,
  donorFormat?: string,
): string {
  return `Write a professional M&E narrative report for the following project data.

PROJECT: ${projectInfo.name}
SECTOR: ${projectInfo.sector}
DONOR: ${projectInfo.donor}
${projectInfo.periodStart ? `PERIOD: ${projectInfo.periodStart} to ${projectInfo.periodEnd}` : ''}
${donorFormat ? `DONOR FORMAT: Follow ${donorFormat} reporting guidelines` : ''}

INDICATOR DATA:
${indicators.map(ind => `
[${ind.level.toUpperCase()}] ${ind.indicatorText}
  Status: ${ind.status}
  Baseline: ${ind.baselineValue || 'N/A'} | Target: ${ind.targetValue || 'N/A'} | Current: ${ind.currentValue || 'N/A'}
  Recent data: ${ind.dataPoints.map(dp => `${dp.value} (${dp.date})`).join(', ') || 'No data'}
`).join('')}

Write a 500-800 word narrative that:
1. Opens with an executive summary of overall progress
2. Discusses achievements and progress against targets
3. Highlights any indicators that are off-track or at-risk with analysis
4. Notes geographic or demographic patterns if available
5. Provides recommendations for the next reporting period
6. Uses professional M&E language appropriate for ${projectInfo.donor}

The narrative should be data-driven, referencing specific indicator values and trends.`;
}

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
