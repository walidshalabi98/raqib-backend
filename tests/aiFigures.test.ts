import { describe, expect, it } from 'vitest';
import {
  indicatorProgress,
  parseIndicatorNumber,
  PROGRESS_NO_BASELINE_NOTE,
  progressTowardTarget,
  unverifiedFigures,
  valueTrend,
} from '../src/services/ai/indicatorFigures';

// Pure figure helpers of the AI services (CLAUDE.md rule 7, me-foundations §6). The basic cases of
// parseIndicatorNumber, progressTowardTarget and valueTrend are in aiHtml.test.ts.

describe('parseIndicatorNumber: strict separators', () => {
  it.each(['12,5', '1,2', '1,20', '12,5%', '1.200,50', '١٢٬٥'])('never reads a decimal comma or a broken thousands group as a number: %s', value => {
    expect(parseIndicatorNumber(value)).toBeNull();
  });

  it.each([
    ['12,500', 12500],
    ['1,200,000', 1200000],
    ['1,200.5', 1200.5],
    ['45 ٪', 45],
    ['0.35', 0.35],
  ])('reads %s as %s', (value, expected) => {
    expect(parseIndicatorNumber(value)).toBe(expected);
  });
});

describe('progressTowardTarget: no wrong "already calculated" figures', () => {
  it('is null for a decimal comma instead of 2300%', () => {
    expect(progressTowardTarget('10', '15', '12,5')).toBeNull();
    expect(progressTowardTarget('10', '15', '12.5')).toBe(50);
  });

  it('is null when percentages and plain proportions are mixed', () => {
    expect(progressTowardTarget('0.35', '50%', '45%')).toBeNull();
    expect(progressTowardTarget('35%', '0.5', '45%')).toBeNull();
    expect(progressTowardTarget('35%', '50%', '0.45')).toBeNull();
  });

  it('accepts a percent indicator whose values are written with and without the sign', () => {
    expect(progressTowardTarget('20%', '60%', '40')).toBe(50);
    expect(progressTowardTarget('0', '50%', '25%')).toBe(50);
    expect(progressTowardTarget('0.35', '0.5', '0.45')).toBe(67);
  });
});

describe('indicatorProgress', () => {
  const output = { level: 'output', unit: 'number', baselineValue: null, targetValue: '12,000', currentValue: '8,000' };

  it('gives an output count without a baseline its share of the target, flagged', () => {
    expect(indicatorProgress(output)).toEqual({ percent: 67, noBaseline: true });
    expect(indicatorProgress({ ...output, baselineValue: '  ' })).toEqual({ percent: 67, noBaseline: true });
    expect(indicatorProgress({ ...output, unit: 'households' })).toEqual({ percent: 67, noBaseline: true });
    expect(indicatorProgress({ ...output, level: 'activity' })).toEqual({ percent: 67, noBaseline: true });
    expect(PROGRESS_NO_BASELINE_NOTE).toBe('of target; no baseline recorded');
  });

  it('uses baseline to target whenever a baseline is recorded', () => {
    expect(indicatorProgress({ ...output, baselineValue: '0' })).toEqual({ percent: 67, noBaseline: false });
    expect(indicatorProgress({ ...output, baselineValue: '2,000' })).toEqual({ percent: 60, noBaseline: false });
    expect(indicatorProgress({ level: 'outcome', unit: 'percent', baselineValue: '20%', targetValue: '60%', currentValue: '40%' })).toEqual({ percent: 50, noBaseline: false });
  });

  it('gives nothing for outcomes, non-count units, unreadable values or a baseline that is not a number', () => {
    expect(indicatorProgress({ ...output, level: 'outcome' })).toBeNull();
    expect(indicatorProgress({ ...output, level: 'impact' })).toBeNull();
    for (const unit of ['percent', 'ratio', 'index', 'score', 'currency_usd', 'days', 'km', 'number per 1,000 people', null, '']) {
      expect(indicatorProgress({ ...output, unit })).toBeNull();
    }
    expect(indicatorProgress({ ...output, baselineValue: 'pending survey' })).toBeNull();
    expect(indicatorProgress({ ...output, targetValue: '0' })).toBeNull();
    expect(indicatorProgress({ ...output, currentValue: '8,0' })).toBeNull();
    expect(indicatorProgress({ ...output, currentValue: null })).toBeNull();
  });
});

describe('valueTrend: areas, dates and directions', () => {
  it('a "decrease" indicator rising from 22% to 30% is declining', () => {
    expect(valueTrend(['30%', '22%'], 'decrease')).toBe('declining');
  });

  it('compares only points of the same area as the latest', () => {
    const gaza = (value: string, date: string) => ({ value, date: new Date(date), area: 'Gaza' });
    const hebron = (value: string, date: string) => ({ value, date: new Date(date), area: 'Hebron' });
    expect(valueTrend([gaza('30', '2026-09-01'), hebron('22', '2026-06-01')])).toBe('insufficient_data');
    expect(valueTrend([gaza('30', '2026-09-01'), hebron('40', '2026-06-01'), gaza('25', '2026-03-01')])).toBe('improving');
    // Area names are compared without case or extra spaces; points without an area match each other.
    expect(valueTrend([{ value: '30', area: ' gaza ' }, { value: '35', area: 'Gaza' }])).toBe('declining');
    expect(valueTrend([{ value: '30', area: null }, { value: '20', area: '' }])).toBe('improving');
    expect(valueTrend([{ value: '30', area: null }, { value: '20', area: 'Gaza' }])).toBe('insufficient_data');
  });

  it('compares the latest value with one of an earlier date, never with another entry of the same day', () => {
    const points = [
      { value: '30', date: '2026-09-01', area: 'Gaza' },
      { value: '50', date: '2026-09-01', area: 'Gaza' },
      { value: '25', date: '2026-06-01', area: 'Gaza' },
    ];
    expect(valueTrend(points)).toBe('improving');
    expect(valueTrend(points.slice(0, 2))).toBe('insufficient_data');
  });

  it('"maintain": stable within 5% of the target, otherwise towards or away from it', () => {
    expect(valueTrend(['81', '80'], 'maintain', '80')).toBe('stagnant');
    expect(valueTrend(['76', '80'], 'maintain', '80')).toBe('stagnant');
    expect(valueTrend(['70', '80'], 'maintain', '80')).toBe('declining');
    expect(valueTrend(['78', '70'], 'maintain', '80')).toBe('improving');
    expect(valueTrend(['95', '85'], 'maintain', '80')).toBe('declining');
  });

  it('"maintain" without a usable target: stable within 5% of the previous value, otherwise declining', () => {
    expect(valueTrend(['51', '50'], 'maintain')).toBe('stagnant');
    expect(valueTrend(['60', '50'], 'maintain')).toBe('declining');
    expect(valueTrend(['40', '50'], 'maintain', 'about 50')).toBe('declining');
  });

  it('gives insufficient_data when the two values mix percentages and proportions', () => {
    expect(valueTrend(['0.35', '45%'])).toBe('insufficient_data');
    expect(valueTrend(['12,5', '10'])).toBe('insufficient_data');
  });
});

describe('unverifiedFigures', () => {
  const allowed = ['22%', '30%', '1,200', '8000', '2026-09-15', 'Average litres per person per day (Sphere minimum 15)', '12.5'];

  it('returns numbers that are not among the allowed figures, as written, once, in text order', () => {
    expect(unverifiedFigures('Rose from 22% to 30%, showing strong improvement of 36%.', allowed)).toEqual(['36%']);
    expect(unverifiedFigures('Reached 450 households, then 450 again and 2,500 people.', allowed)).toEqual(['450', '2,500']);
    expect(unverifiedFigures('', allowed)).toEqual([]);
  });

  it('accepts every allowed figure however it is written', () => {
    const text = 'Coverage 22 percent, then 30 %; 1200 kits; 8,000 households; 12.50 litres; ١٬٢٠٠ kits and ٢٢٪; Sphere 15 litres; on 15 September.';
    expect(unverifiedFigures(text, allowed)).toEqual([]);
  });

  it('checks Arabic-Indic digits, the Arabic percent sign and separators', () => {
    expect(unverifiedFigures('ارتفعت النسبة إلى ٣٦٪ وبلغ العدد ١٬٥٠٠ أسرة', allowed)).toEqual(['٣٦٪', '١٬٥٠٠']);
    expect(unverifiedFigures('بلغ المتوسط ١٢٫٥ لترًا', allowed)).toEqual([]);
    expect(unverifiedFigures('بلغ المتوسط ١٢٫٧ لترًا', allowed)).toEqual(['١٢٫٧']);
  });

  it('checks decimals and percentages, and never treats a calculated value as its rounded source', () => {
    expect(unverifiedFigures('Average of 12.7 litres', allowed)).toEqual(['12.7']);
    expect(unverifiedFigures('A 0.5 point change', allowed)).toEqual(['0.5']);
    expect(unverifiedFigures('Only 5% reached', allowed)).toEqual(['5%']);
    expect(unverifiedFigures('Rounded to 13 litres', allowed)).toEqual(['13']);
  });

  it('ignores years 1900–2100 and single-digit counts, but not 4-digit counts outside that range or with separators', () => {
    expect(unverifiedFigures('Since 1 July 2025, in 2026 and by 2030, 3 indicators in 2 areas were reviewed.', allowed)).toEqual([]);
    expect(unverifiedFigures('Dated 2026-09-15 and 15/09/2026.', allowed)).toEqual([]);
    expect(unverifiedFigures('In 1850 and 2150 there were 3,000 kits.', allowed)).toEqual(['1850', '2150', '3,000']);
  });

  it('skips numbers that are part of a code', () => {
    expect(unverifiedFigures('Outcome O1.2, Q3, COVID-19 and EU GERF 2.14 apply.', allowed)).toEqual(['2.14']);
  });

  it('reads a run that is not one number as a list or as a decimal comma, and reports it whole', () => {
    expect(unverifiedFigures('Values 22,30 and 12,5 were recorded', allowed)).toEqual([]);
    expect(unverifiedFigures('Values 22,31 were recorded', allowed)).toEqual(['22,31']);
    expect(unverifiedFigures('A value of 1.200.000', allowed)).toEqual(['1.200.000']);
  });

  it('reads every number in whole allowed texts, codes included, and works with no allowed figures', () => {
    expect(unverifiedFigures('Aligned with GERF 2.14: 450 kits, as in indicator 1.2', ['EU GERF 2.14 (result O1.2): 450 kits delivered'])).toEqual([]);
    expect(unverifiedFigures('450 kits', [])).toEqual(['450']);
  });

  it('never treats a year written with a separator as a year', () => {
    expect(unverifiedFigures('Reached 2,030 households by 2030', allowed)).toEqual(['2,030']);
  });
});
