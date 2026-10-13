import { describe, expect, it } from 'vitest';
import {
  AI_CALLS_TEXT, apiKeyProblem, gapRows, referenceSheetStatus, SHEET_HEADER, sheetSummary, sheetSummaryLine, smokeRefusal,
} from '../scripts/ai-smoke';
import { BASELINE_DATE_TO_BE_CONFIRMED, INTERMEDIATE_TARGETS_TO_BE_CONFIRMED, TO_BE_CONFIRMED } from '../src/services/ai/frameworkNormalize';
import { apiKeyProblem as sharedKeyCheck } from '../src/services/ai/keyCheck';
import { KPI_BATCH_MAX_RESULTS, KPI_MAX_CALLS_PER_RUN } from '../src/services/kpi/callModel';

/**
 * scripts/ai-smoke.ts report (owner request, Phase 4): fields still "to be confirmed" are never counted as filled and
 * are reported apart from missing fields; the help text names the AI calls a run makes. The helpers of the script that
 * already existed are tested in tests/frameworkGeneration.integration.test.ts.
 */

/** A reference sheet with every field filled (an output indicator: no baseline date needed). */
const filled = {
  indicatorText: 'Number of water points rehabilitated', indicatorTextAr: 'عدد نقاط المياه المؤهلة', level: 'output', unit: 'number',
  definition: 'Water points repaired and working at handover.', calculation: null, direction: 'increase', disaggregation: ['location'],
  meansOfVerification: 'Handover certificates signed by the water utility', baselineDate: null, baselineMethod: 'Project records at start',
  targetJustification: 'Proposal target of the action', intermediateTargets: [{ date: '2026-12-31', value: '10' }],
  assumptions: 'Materials can enter the area', responsibility: 'WASH engineer',
};

/** What framework generation writes when nothing is known yet (Phase 3/4 "to be confirmed" texts). */
const generated = {
  ...filled,
  level: 'outcome',
  indicatorText: '% of target households using at least a basic drinking water service',
  unit: 'percent',
  calculation: { numerator: 'Households on the basic rung', denominator: 'Households surveyed', formula: 'numerator ÷ denominator × 100', rounding: TO_BE_CONFIRMED },
  disaggregation: ['sex_of_household_head'],
  baselineMethod: `${TO_BE_CONFIRMED}. ${BASELINE_DATE_TO_BE_CONFIRMED}`,
  targetJustification: `Proposed method: baseline + 10 percentage points — confirm after baseline. ${INTERMEDIATE_TARGETS_TO_BE_CONFIRMED}`,
  intermediateTargets: [],
  assumptions: TO_BE_CONFIRMED,
  responsibility: TO_BE_CONFIRMED,
};

describe('referenceSheetStatus: "to be confirmed" is not filled', () => {
  it('a complete sheet has nothing to confirm and nothing missing', () => {
    expect(referenceSheetStatus(filled)).toEqual({ toBeConfirmed: [], missing: [] });
  });

  it('lists every field still marked "to be confirmed", including a proposed target method and the date and intermediate-target markers', () => {
    expect(referenceSheetStatus(generated)).toEqual({
      toBeConfirmed: ['calculation', 'baselineDate', 'baselineMethod', 'intermediateTargets', 'targetJustification', 'assumptions', 'responsibility'],
      missing: [],
    });
  });

  it('reports empty fields, a generic means of verification and a missing sex disaggregation as missing, not as to be confirmed', () => {
    expect(referenceSheetStatus({
      ...filled, indicatorText: 'Number of women trained', indicatorTextAr: '', definition: '', disaggregation: [],
      meansOfVerification: 'project reports', intermediateTargets: [],
    })).toEqual({ toBeConfirmed: [], missing: ['indicatorTextAr', 'definition', 'disaggregation', 'meansOfVerification', 'intermediateTargets'] });
  });

  it('an open baseline date of an outcome is to be confirmed only when the baseline method says so', () => {
    const outcome = { ...filled, level: 'outcome' };
    expect(referenceSheetStatus(outcome).missing).toEqual(['baselineDate']);
    expect(referenceSheetStatus({ ...outcome, baselineMethod: `Pending baseline survey. ${BASELINE_DATE_TO_BE_CONFIRMED}` }))
      .toEqual({ toBeConfirmed: ['baselineDate'], missing: [] });
    // A date that is set is filled even when the method still carries the old marker.
    expect(referenceSheetStatus({ ...outcome, baselineDate: '2026-03-01', baselineMethod: `Survey. ${BASELINE_DATE_TO_BE_CONFIRMED}` }))
      .toEqual({ toBeConfirmed: [], missing: [] });
  });
});

describe('report rows and summary', () => {
  const rows = [
    { ...filled, resultCode: 'O1.1', level: 'output' as const },
    { ...generated, resultCode: 'O1', level: 'outcome' as const },
    { ...filled, resultCode: null, level: 'output' as const, indicatorText: 'Kits', definition: null },
  ];

  it('one column for fields to be confirmed and one for missing fields', () => {
    expect(SHEET_HEADER).toEqual(['result', 'level', 'indicator', 'to be confirmed', 'missing']);
    expect(gapRows(rows)).toEqual([
      ['O1.1', 'output', 'Number of water points rehabilitated', 'none', 'none'],
      ['O1', 'outcome', '% of target households using at least a basic drinking water service',
        'calculation, baselineDate, baselineMethod, intermediateTargets, targetJustification, assumptions, responsibility', 'none'],
      ['—', 'output', 'Kits', 'none', 'definition'],
    ]);
  });

  it('counts an indicator as complete only when no field is missing or to be confirmed', () => {
    const summary = sheetSummary(rows);
    expect(summary).toEqual({ total: 3, complete: 1, withToBeConfirmed: 1, withMissing: 1 });
    expect(sheetSummaryLine(summary)).toBe(
      'Reference sheets: 1 of 3 indicators complete (every field filled); 1 with fields still "to be confirmed"; 1 with missing fields',
    );
  });
});

describe('help text and key check', () => {
  it('names the AI calls of a run from the KPI pipeline limits', () => {
    expect(AI_CALLS_TEXT).toBe(`main-tier calls: one for the results chain when the project has parsed documents, then one per batch of up to ${KPI_BATCH_MAX_RESULTS} results for the indicators (at most ${KPI_MAX_CALLS_PER_RUN})`);
    const key = ['sk', 'ant', 'api03', 'Ab9'.repeat(30)].join('-');
    expect(smokeRefusal({ nodeEnv: 'development', apiKey: key, yes: false, databaseUrl: 'postgresql://u:p@localhost/raqib' }))
      .toBe(`This calls the real Anthropic API (${AI_CALLS_TEXT}; it costs a little money) and adds a framework version. Re-run with --yes to continue.`);
    expect(smokeRefusal({ nodeEnv: 'development', apiKey: key, yes: false, databaseUrl: 'postgresql://u:p@localhost/raqib' })).not.toMatch(/two main-tier calls/);
  });

  it('re-exports the shared key check (src/services/ai/keyCheck.ts)', () => {
    expect(apiKeyProblem).toBe(sharedKeyCheck);
    expect(sharedKeyCheck('sk-ant-test-not-a-real-key')).toMatch(/placeholder/);
    expect(sharedKeyCheck(undefined)).toMatch(/not set/);
    expect(sharedKeyCheck('sk-proj-abcdefghijklmnopqrstuvwxyz')).toMatch(/does not look like an Anthropic API key/);
    expect(sharedKeyCheck(['sk', 'ant', 'api03', 'Zz7'.repeat(10)].join('-'))).toBeNull();
  });
});
