// Donor labels and indicator rules used in prompts (knowledge/me-foundations.md §10).

/**
 * The DG ECHO indicator cap, in the one wording every prompt and the metadata fallback use
 * (me-foundations.md §2 and §10: the cap applies per sub-sector, which a result stands for in a
 * Raqib framework). The prompts ask for it; nothing trims a generated framework to it yet:
 * enforcement is Phase 5 monitoring rule R5_FRAMEWORK_GAP ("result exceeding donor cap",
 * knowledge/kpi-assistant-spec.md), which warns on any framework, generated or edited by hand.
 */
export const ECHO_INDICATOR_CAP = 'at most 3 indicators per result (sub-sector), 4 with one justified custom indicator';

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
  echo: `DG ECHO: prefer Key Result Indicators; ${ECHO_INDICATOR_CAP}; a baseline is compulsory (at the latest in the interim report); source and method must be specific; definitions must not contain targets or data sources. Disaggregate by sex, age and disability.`,
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
