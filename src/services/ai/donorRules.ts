/**
 * Donor rules for the KPI Assistant (knowledge/kpi-assistant-spec.md §A3 donorRules; me-foundations §10; design
 * section 4.3). Env-free: imported by the pure KPI modules and the eval. All 12 DonorType values have rules
 * (un_women is missing from the spec table; usaid is a legacy donor type since 1 July 2025).
 */
import type { DonorType } from '@prisma/client';
import type { DonorRules } from '../kpi/types';

const AGENCY_FRAMEWORKS = ['Agency strategic plan', 'SDG'];

/** Rules per donor type: cap per result (existing + suggested), labels for the model, library frameworks for the hard filter, notes. */
export const DONOR_RULES: Readonly<Record<DonorType, Omit<DonorRules, 'donorType'>>> = {
  eu: {
    maxIndicatorsPerResult: null,
    requiredFrameworks: ['GERF Level 2', 'GAP III'],
    libraryFrameworks: ['EU GERF'],
    notes: [
      'Use GERF Level 2 indicators first, then other predefined OPSYS indicators (including GAP III); custom only when nothing fits.',
      'Sex or gender disaggregation is mandatory for people counts.',
    ],
  },
  echo: {
    maxIndicatorsPerResult: 3,
    requiredFrameworks: ['ECHO KRIs'],
    // No ECHO Key Result Indicators in the library yet.
    libraryFrameworks: [],
    notes: [
      'Baseline compulsory (at the latest in the interim report).',
      'Sources and methods must be specific.',
      'Custom indicators must be SMART and contain no target or data source.',
    ],
  },
  undp: { maxIndicatorsPerResult: null, requiredFrameworks: AGENCY_FRAMEWORKS, libraryFrameworks: ['SDG'], notes: ['Align with SDG codes where possible.'] },
  unicef: { maxIndicatorsPerResult: null, requiredFrameworks: AGENCY_FRAMEWORKS, libraryFrameworks: ['SDG'], notes: ['Align with SDG codes where possible.'] },
  unfpa: { maxIndicatorsPerResult: null, requiredFrameworks: AGENCY_FRAMEWORKS, libraryFrameworks: ['SDG'], notes: ['Align with SDG codes where possible.'] },
  wfp: {
    maxIndicatorsPerResult: null,
    requiredFrameworks: AGENCY_FRAMEWORKS,
    libraryFrameworks: ['SDG', 'WFP', 'WFP CARI'],
    notes: ['Align with WFP corporate indicators and SDG codes where possible.'],
  },
  un_women: {
    maxIndicatorsPerResult: null,
    requiredFrameworks: AGENCY_FRAMEWORKS,
    libraryFrameworks: ['SDG'],
    notes: ['Align with SDG 5 and UN Women strategic plan indicators where possible.'],
  },
  giz: { maxIndicatorsPerResult: null, requiredFrameworks: ['Sector standards'], libraryFrameworks: [], notes: [] },
  sida: { maxIndicatorsPerResult: null, requiredFrameworks: ['Sector standards'], libraryFrameworks: [], notes: [] },
  fcdo: { maxIndicatorsPerResult: null, requiredFrameworks: ['Sector standards'], libraryFrameworks: [], notes: [] },
  other: { maxIndicatorsPerResult: null, requiredFrameworks: ['Sector standards'], libraryFrameworks: [], notes: [] },
  usaid: {
    maxIndicatorsPerResult: null,
    requiredFrameworks: [],
    libraryFrameworks: [],
    notes: ['Legacy awards only; programmes now administered by the US State Department.'],
  },
};

/**
 * The donor rules for a project's donor type (spec §A3 donorRules; me-foundations §10), as fresh copies: callers may
 * change the returned lists without changing DONOR_RULES. An unknown value (a row written before a DonorType was added)
 * gets the rules of 'other'.
 */
export function donorRulesFor(donorType: DonorType): DonorRules {
  const rules = DONOR_RULES[donorType] ?? DONOR_RULES.other;
  return {
    donorType,
    maxIndicatorsPerResult: rules.maxIndicatorsPerResult,
    requiredFrameworks: [...rules.requiredFrameworks],
    libraryFrameworks: [...rules.libraryFrameworks],
    notes: [...rules.notes],
  };
}
