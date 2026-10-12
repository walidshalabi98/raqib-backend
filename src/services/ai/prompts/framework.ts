import type { LibraryCandidate } from '../frameworkNormalize';
import { donorGuidance, donorLabel } from './donors';

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
