import type { LibraryCandidate } from './frameworkNormalize';

export const SYSTEM_CONTEXT = `You are an expert M&E (Monitoring & Evaluation) specialist for development and humanitarian projects in Palestine. You have deep expertise in:
- Designing results frameworks and logframes for NGOs and INGOs
- Creating SMART indicators aligned with donor requirements (EU and DG ECHO, GIZ, UNDP, UNICEF, WFP, UNFPA, UN Women, FCDO, Sida; USAID is a legacy donor since 1 July 2025)
- Data collection methodologies appropriate for the Palestinian context
- Humanitarian and development sector standards (Sphere, WFP food security indicators, JMP, IASC MHPSS, Core Humanitarian Standard)
- Bilingual (English/Arabic) M&E frameworks

You always produce structured, professional outputs that follow international M&E best practices while being contextually appropriate for Palestine.`;

/** Version of the framework generator prompts, stored on every generated indicator (Indicator.promptVersion). */
export const FRAMEWORK_PROMPT_VERSION = 'framework-v3';

export interface FrameworkProjectInfo {
  name: string;
  sector: string;
  /** All project sectors, primary first. */
  sectors: string[];
  humanitarian: boolean;
  donor: string;
  donorType: string;
  description?: string;
  targetBeneficiaries?: number;
  geographicScope?: string;
  startDate?: string;
  endDate?: string;
}

const DONOR_LABELS: Record<string, string> = {
  eu: 'European Union (Global Europe; DG INTPA / DG MENA)',
  echo: 'DG ECHO (EU humanitarian aid)',
  usaid: 'USAID (legacy donor type: USAID stopped administering awards on 1 July 2025)',
  giz: 'GIZ / BMZ',
  undp: 'UNDP',
  unicef: 'UNICEF',
  wfp: 'WFP',
  unfpa: 'UNFPA',
  un_women: 'UN Women',
  fcdo: 'FCDO',
  sida: 'Sida',
  other: 'Other donor',
};

/** Donor-specific indicator rules (knowledge/me-foundations.md §10). */
const DONOR_GUIDANCE: Record<string, string> = {
  eu: 'Use relevant EU GERF Level 2 indicators first (standardReferenceCode such as "EU GERF 2.14"), then other predefined OPSYS indicators (including Gender Action Plan III); write a custom indicator only when nothing predefined fits. Sex disaggregation is mandatory for people-count indicators; age and disability are expected.',
  echo: 'DG ECHO: prefer Key Result Indicators; at most 3 indicators per result (4 if one custom indicator is justified); a baseline is compulsory (at the latest in the interim report); source and method must be specific; definitions must not contain targets or data sources. Disaggregate by sex, age and disability.',
  usaid: 'USAID is a legacy donor type: existing awards may still use USAID-era indicator reference sheets. Use standard sector indicators.',
  undp: 'Align with UNDP Strategic Plan indicators and the SDG global indicator framework.',
  unicef: 'Align with UNICEF Strategic Plan indicators and the SDG global indicator framework; child-focused and equity-focused disaggregation (sex, age, disability).',
  wfp: 'Use WFP corporate indicators where relevant (Food Consumption Score, rCSI, Livelihood Coping Strategies) and align with the SDG global indicator framework.',
  unfpa: 'Align with UNFPA Strategic Plan indicators (sexual and reproductive health, GBV) and the SDG global indicator framework.',
  un_women: 'Align with UN Women Strategic Plan indicators and SDG 5; sex-disaggregated and gender-specific indicators.',
  fcdo: 'Results-based logframe with milestones; disaggregate by sex and disability; use standard sector indicators and SDG alignment.',
  giz: 'Results-based monitoring with a logframe; use standard sector indicators and SDG alignment.',
  sida: 'Results-based logframe with a human rights-based approach; use standard sector indicators and SDG alignment.',
  other: 'Results-based logframe; use standard sector indicators and SDG alignment.',
};

export function donorLabel(donorType: string): string {
  return DONOR_LABELS[donorType] ?? DONOR_LABELS.other;
}

export function donorGuidance(donorType: string): string {
  return DONOR_GUIDANCE[donorType] ?? DONOR_GUIDANCE.other;
}

function projectInfoLines(info: FrameworkProjectInfo): string {
  return [
    `- Name: ${info.name}`,
    `- Primary sector: ${info.sector}`,
    `- All sectors: ${(info.sectors.length > 0 ? info.sectors : [info.sector]).join(', ')}`,
    `- Humanitarian project: ${info.humanitarian ? 'yes' : 'no'}`,
    `- Donor: ${info.donor} — ${donorLabel(info.donorType)} (donor type: ${info.donorType})`,
    info.description ? `- Description: ${info.description}` : '',
    info.targetBeneficiaries ? `- Target beneficiaries: ${info.targetBeneficiaries}` : '',
    info.geographicScope ? `- Geographic scope: ${info.geographicScope}` : '',
    info.startDate ? `- Project start date: ${info.startDate}` : '',
    info.endDate ? `- Project end date: ${info.endDate}` : '',
  ].filter(Boolean).join('\n');
}

export function extractProjectStructurePrompt(documentTexts: string[], projectInfo: FrameworkProjectInfo): string {
  return `Analyze the following project documents and extract the project's results chain (goal → outcomes → outputs → activities).

PROJECT INFO:
${projectInfoLines(projectInfo)}

DOCUMENTS:
${documentTexts.map((text, i) => `--- Document ${i + 1} ---\n${text.slice(0, 8000)}`).join('\n\n')}

Extract and return a JSON object with this exact structure:
{
  "goal": { "code": "G", "text": "The overall goal/impact statement", "textAr": "The same statement in Modern Standard Arabic" },
  "outcomes": [
    {
      "code": "O1",
      "text": "Outcome statement",
      "textAr": "...",
      "outputs": [
        {
          "code": "O1.1",
          "text": "Output statement",
          "textAr": "...",
          "activities": ["Activity 1", "Activity 2"]
        }
      ]
    }
  ],
  "beneficiaries": {
    "total": number or null,
    "types": ["Type 1", "Type 2"],
    "disaggregation": ["sex", "age", "disability", "location", "displacement_status"]
  },
  "timeline": {
    "startDate": "YYYY-MM-DD",
    "endDate": "YYYY-MM-DD",
    "phases": ["Phase 1: ...", "Phase 2: ..."]
  },
  "donorRequirements": ["Requirement 1", "Requirement 2"],
  "crossCuttingThemes": ["gender", "disability_inclusion", "conflict_sensitivity"],
  "documentFigures": [
    {
      "resultCode": "O1",
      "kind": "baseline" or "target",
      "value": "the value exactly as written in the document, e.g. 22% or 800",
      "description": "what the value measures",
      "quote": "the sentence from the document that contains the value"
    }
  ]
}

RULES:
- Codes: "G" for the goal, "O1", "O2"… for outcomes, "O1.1", "O1.2"… for the outputs of outcome O1. If the documents number their results differently, keep the same order but use these codes.
- Use the documents' own results where they exist; do not add results the documents do not support. Keep each statement to one sentence.
- Outcomes describe changes among people or institutions; outputs describe products and services the project delivers; activities are actions of the team.
- Arabic text (textAr) must be Modern Standard Arabic suitable for donor and ministry readers.
- documentFigures: list only baseline and target values that are written in the documents, copied exactly (same digits and symbols). Never estimate or calculate a value. Use an empty array when the documents contain none.
- Do not include names, phone numbers, ID numbers or addresses of individuals.

Return ONLY valid JSON, no markdown or explanation.`;
}

function candidateLine(c: LibraryCandidate): string {
  const ref = c.standardReference && typeof c.standardReference === 'object'
    ? (c.standardReference as { framework?: string; code?: string })
    : null;
  return [
    `- ${c.id} [${c.level}] ${c.name}`,
    `unit: ${c.unit}`,
    `methods: ${c.methods.join(', ')}`,
    `frequency: ${c.frequency}`,
    `disaggregation: ${c.disaggregation.join(', ') || 'none'}`,
    ref?.framework ? `standard: ${[ref.framework, ref.code].filter(Boolean).join(' ')}` : 'standard: none (common practice)',
    `definition: ${c.definition}`,
  ].join(' | ');
}

export function generateFrameworkPrompt(
  projectStructure: Record<string, unknown>,
  candidates: LibraryCandidate[],
  projectInfo: FrameworkProjectInfo,
  options: { hasDocuments: boolean },
): string {
  return `Based on the following project structure and indicator library candidates, generate the indicators of the project's M&E framework.

PROJECT INFO:
${projectInfoLines(projectInfo)}

PROJECT STRUCTURE (results chain with codes; documentFigures are baseline and target values quoted from the project documents):
${JSON.stringify(projectStructure, null, 2)}

INDICATOR LIBRARY CANDIDATES (prefer these; adapt the wording to the project and keep the candidate id as libraryId):
${candidates.length > 0 ? candidates.map(candidateLine).join('\n') : '- none available: write custom indicators'}

DONOR GUIDANCE:
${donorGuidance(projectInfo.donorType)}

REQUIREMENTS:
- Every indicator measures one result of the structure: set resultCode to that result's code ("G", "O1", "O1.1"…). Level must match the result: impact for the goal, outcome for outcomes, output for outputs.
- Do not write activity indicators: activities are tracked as tasks and milestones, not as indicators.
- Counts: 1-2 indicators for the goal, 2-4 per outcome, 2-3 per output${projectInfo.donorType === 'echo' ? ' (never more than 3 per result for DG ECHO)' : ''}.
- Standard first: prefer a library candidate or another recognised standard (donor framework, cluster standard) over a custom indicator; set libraryId only to the id of a candidate listed above (otherwise null) and standardReferenceCode to the framework code (e.g. "EU GERF 2.38", "IASC MHPSS O5.4") when aligned, otherwise null.
- indicatorText: neutral wording that names what is measured — never the target or the desired direction ("% of households with an acceptable Food Consumption Score", not "Increase to 80% the households…"); one dimension only (no "and/or" joining two measurements). Not duplicated within the framework.
- indicatorTextAr: the same indicator in Modern Standard Arabic.
- unit: one of number, percent, score, litres_per_person_per_day, hectares, dunums, megawatts, tonnes_co2eq, currency_ils, kg_per_dunum, yes_no. Percentages must have calculation.numerator and calculation.denominator.
- disaggregation: snake_case keys. Sex is the minimum for every indicator that counts or measures people (use sex_of_household_head for household indicators); age and disability (Washington Group questions) are expected${projectInfo.humanitarian || ['eu', 'echo'].includes(projectInfo.donorType) ? ' and required for this project' : ' in humanitarian and EU-funded work'}; add location and displacement_status where relevant.
- dataCollectionMethod: outputs are usually counted from records (document_review); outcomes from surveys (hh_survey) with qualitative explanation; impact from secondary data (secondary_data, e.g. PCBS).
- meansOfVerification: the specific source and tool (e.g. "Household survey, FCS module, n≈400, representative of target households"; "Training attendance sheets and certificates register"). Never generic answers such as "project reports".
- Account for movement restrictions and access constraints (Gaza, Area C): suggest remote methods where field access is uncertain and state this in assumptions.
${projectInfo.humanitarian ? '- Humanitarian project: include at least one accountability to affected people indicator (prefer AC-01 to AC-05) and disaggregate people-level indicators by sex, age and disability.\n' : ''}
BASELINES AND TARGETS — never invent numbers:
- baselineValue: only a value written in the project documents (see documentFigures), copied exactly, with baselineBasis "document". Otherwise baselineValue "" and baselineBasis "none". baselineMethod says how and when the baseline is or will be measured ("pending baseline survey, planned for <month year>").
- targetValue: only (a) a value written in the project documents, copied exactly (targetBasis "document"), or (b) a standard threshold written in the linked library candidate (its standard or definition), such as the Sphere minimum of 15 litres per person per day (targetBasis "standard_threshold", with that candidate's id as libraryId; a threshold that is not written in the linked library entry is removed). Otherwise targetValue "" and targetBasis "method_only" (describe in targetJustification how the target will be set from the baseline, e.g. "baseline + 10 percentage points, consistent with similar programmes; confirm after the baseline survey") or "none".
- targetJustification: where the target comes from, or the proposed method (relative to the baseline) when there is no document value.
${options.hasDocuments ? '' : '- No project documents were provided: every baselineBasis must be "none" and no targetBasis may be "document".\n'}
Return a JSON array of indicators:
[
  {
    "resultCode": "O1",
    "level": "impact|outcome|output",
    "indicatorText": "...",
    "indicatorTextAr": "...",
    "libraryId": "LV-01" or null,
    "standardReferenceCode": "EU GERF 2.14" or null,
    "definition": "What exactly counts; key terms defined",
    "unit": "percent",
    "calculation": { "numerator": "...", "denominator": "...", "formula": "numerator ÷ denominator × 100" },
    "direction": "increase|decrease|maintain",
    "disaggregation": ["sex", "age", "disability", "location"],
    "dataCollectionMethod": "hh_survey|fgd|kii|observation|document_review|participatory|secondary_data",
    "frequency": "monthly|quarterly|biannual|annual|per_cohort|baseline_endline",
    "meansOfVerification": "...",
    "baselineValue": "",
    "baselineBasis": "document|none",
    "baselineMethod": "...",
    "targetValue": "",
    "targetBasis": "document|standard_threshold|method_only|none",
    "targetJustification": "...",
    "assumptions": "Assumptions and data limitations",
    "responsibility": "Suggested responsible role, e.g. 'M&E Officer', 'Field Team', 'Project Manager'",
    "phases": ["baseline", "midterm", "endline"],
    "startDate": "YYYY-MM-DD — estimated start of data collection for this indicator",
    "endDate": "YYYY-MM-DD — estimated date by which the target should be reached",
    "milestones": [
      {"label": "Baseline data collection", "date": "YYYY-MM-DD", "completed": false},
      {"label": "Midterm review", "date": "YYYY-MM-DD", "completed": false}
    ],
    "aiRationale": "2-3 sentences: why this indicator fits this result and this donor"
  }
]

IMPORTANT for timeline fields:
- Use the project start and end dates to derive realistic startDate and endDate values for each indicator.
- Impact-level indicators span the full project period; output indicators have shorter, earlier timelines.
- Milestones include key data collection events and review points relevant to the indicator.
- Responsibility matches the level: impact/outcome indicators to senior staff, output indicators to field teams.

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
