import { describe, expect, it } from 'vitest';
import {
  BREAKDOWN_LIMITS, breakdownRules, formatNumber, isCountUnit, isPercentIndicatorText, isPercentUnit, parseNumeric,
  validateBreakdown,
} from '../src/services/dataPoints/breakdown';
import { INDICATOR_UNITS } from '../src/services/ai/prompts/framework';

/** Runs validateBreakdown and returns its errors (fails the test when it passes). */
function errorsOf(breakdown: unknown, value = '218', unit: string | null = 'number'): string[] {
  const result = validateBreakdown(breakdown, { value, unit });
  if (result.ok === true) throw new Error(`expected errors, got ${JSON.stringify(result.breakdown)}`);
  return result.errors;
}

/** Runs validateBreakdown and returns the normalised breakdown (fails the test when it is rejected). */
function breakdownOf(breakdown: unknown, value = '218', unit: string | null = 'number') {
  const result = validateBreakdown(breakdown, { value, unit });
  if (result.ok === false) throw new Error(`expected success, got ${result.errors.join('; ')}`);
  return result.breakdown;
}

function categories(n: number, each = 1): Record<string, number> {
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, each]));
}

describe('isCountUnit', () => {
  it.each([
    'number', 'Number', ' NUMBER ', 'count', '#', 'people', 'persons', 'individuals',
    'households', 'Beneficiaries', 'participants', 'number of people', 'number_of_households', 'numbers',
  ])('treats %j as a count', unit => {
    expect(isCountUnit(unit)).toBe(true);
  });

  it.each([
    null, undefined, '', '   ', 'percent', '%', 'score', 'currency_ils', 'litres_per_person_per_day', 'hectares', 'yes_no', 'days', 'USD',
  ])('does not treat %j as a count (a blank unit is not a count)', unit => {
    expect(isCountUnit(unit as string | null | undefined)).toBe(false);
  });

  // The shared unit list (prompts/framework.ts INDICATOR_UNITS): only 'number' is a count.
  it('treats only "number" of the shared unit list as a count', () => {
    expect(INDICATOR_UNITS.filter(unit => isCountUnit(unit))).toEqual(['number']);
    for (const unit of ['ratio', 'index', 'score', 'currency_usd', 'currency_eur', 'currency_jod', 'currency_ils', 'days', 'hours', 'minutes', 'km']) {
      expect(breakdownRules(unit, 'Number of people per functioning latrine'), unit).toBe('none');
    }
  });

  it.each([
    'number per 1,000 live births', 'Number per 100k', 'number_per_1000', 'number/km2', 'number ratio', 'number index', 'number rate',
  ])('does not treat the rate or ratio %j as a count', unit => {
    expect(isCountUnit(unit)).toBe(false);
  });
});

describe('validateBreakdown with ratio, index and other non-count units', () => {
  it('accepts categories that do not add up to the value (a ratio is no count)', () => {
    // 55 people per latrine overall; 48 in one location and 62 in the other.
    const location = { location: { khan_younis: 48, deir_al_balah: 62 } };
    expect(breakdownOf(location, '55', 'ratio')).toEqual(location);
    expect(breakdownOf({ sex: { female: 0.97, male: 1.03 } }, '1', 'index')).toEqual({ sex: { female: 0.97, male: 1.03 } });
    expect(breakdownOf({ location: { north: 320, south: 410 } }, '365', 'currency_usd')).toEqual({ location: { north: 320, south: 410 } });
    expect(breakdownOf({ location: { north: 40, south: 25 } }, '32', 'minutes')).toEqual({ location: { north: 40, south: 25 } });
    expect(breakdownOf(location, '55', 'number per 1,000 people')).toEqual(location);
    // The same breakdown is rejected for a count.
    expect(errorsOf(location, '55', 'number')).toEqual(['location: categories add up to 110 but the value is 55']);
  });
});

describe('isPercentIndicatorText', () => {
  it.each([
    '% of households with acceptable Food Consumption Score',
    '  %age of girls enrolled',
    'Percentage of children vaccinated',
    'Percent of trainees employed after six months',
    'Proportion of women in leadership roles',
    'Share of income spent on food',
    'Primary school completion rate',
    'Rate of GBV cases referred within 24 hours',
    'نسبة الأسر ذات درجة استهلاك غذائي مقبولة',
    'النسبة المئوية للأطفال الملتحقين',
    'معدل إتمام المرحلة الأساسية',
  ])('reads %j as a percentage', text => {
    expect(isPercentIndicatorText(text)).toBe(true);
  });

  it.each([
    null, undefined, '', 'Number of youth completing vocational training', 'Households reached with cash assistance',
    'Number of accurate reports submitted', 'Number of shared water points rehabilitated', 'Average coping strategy score',
    'عدد الشباب الذين أكملوا التدريب المهني',
  ])('does not read %j as a percentage', text => {
    expect(isPercentIndicatorText(text as string | null | undefined)).toBe(false);
  });
});

describe('breakdownRules', () => {
  it('uses the unit when there is one', () => {
    expect(breakdownRules('people', '% of households')).toBe('count');
    expect(breakdownRules('percent', 'Number of youth')).toBe('percent');
    expect(breakdownRules('score', '% of households')).toBe('none');
  });

  it('infers percent rules from the text when the unit is blank, and otherwise applies no sum check', () => {
    expect(breakdownRules(null, '% of households with acceptable FCS')).toBe('percent');
    expect(breakdownRules('  ', 'نسبة الأسر')).toBe('percent');
    expect(breakdownRules(undefined, 'Number of youth trained')).toBe('none');
    expect(breakdownRules('', undefined)).toBe('none');
  });
});

describe('isPercentUnit', () => {
  it.each(['%', 'percent', 'Percentage', ' PERCENT ', '% of households'])('treats %j as a percentage', unit => {
    expect(isPercentUnit(unit)).toBe(true);
  });

  it.each([null, undefined, '', 'number', 'score', 'people'])('does not treat %j as a percentage', unit => {
    expect(isPercentUnit(unit as string | null | undefined)).toBe(false);
  });
});

describe('parseNumeric', () => {
  it.each([
    [12, 12], [0, 0], [-3.5, -3.5], ['12', 12], [' 12 ', 12], ['12.5', 12.5], ['.5', 0.5], ['+4', 4], ['1e3', 1000],
    ['1,200', 1200], ['12,345,678.9', 12345678.9], ['١٢٠', 120], ['۱۲۰', 120], ['١٢٫٥', 12.5], ['١٬٢٠٠', 1200],
  ])('parses %j as %d', (input, expected) => {
    expect(parseNumeric(input)).toBe(expected);
  });

  it.each([
    '', '   ', 'abc', '12 people', 'N/A', '0x10', '1,20', '12,34.5', '1e400', 'Infinity', NaN, Infinity, null, undefined,
    true, {}, [], [12],
  ])('rejects %j', input => {
    expect(parseNumeric(input)).toBeNull();
  });
});

describe('formatNumber', () => {
  it('prints integers as they are and trims floating-point noise', () => {
    expect(formatNumber(218)).toBe('218');
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatNumber(12.5)).toBe('12.5');
  });
});

describe('validateBreakdown: shape', () => {
  it('accepts no breakdown', () => {
    expect(validateBreakdown(null, { value: '10', unit: 'number' })).toEqual({ ok: true, breakdown: null });
    expect(validateBreakdown(undefined, { value: '10', unit: 'number' })).toEqual({ ok: true, breakdown: null });
    expect(validateBreakdown({}, { value: '10', unit: 'number' })).toEqual({ ok: true, breakdown: null });
  });

  it('accepts the example from the build guide', () => {
    const breakdown = { sex: { female: 120, male: 98 }, disability: { yes: 12, no: 206 } };
    expect(breakdownOf(breakdown)).toEqual(breakdown);
  });

  it.each([[[1, 2]], ['sex'], [12], [true]])('rejects a breakdown that is not an object (%j)', input => {
    expect(errorsOf(input)).toEqual([expect.stringMatching(/^breakdown must be an object of dimensions/)]);
  });

  it('rejects a dimension that is not an object of categories', () => {
    expect(errorsOf({ sex: 218 })[0]).toMatch(/^sex: must be an object of categories.*\(got 218\)/);
    expect(errorsOf({ sex: ['female', 'male'] })[0]).toMatch(/^sex: must be an object of categories.*\(got a list\)/);
    expect(errorsOf({ sex: null })[0]).toMatch(/\(got null\)/);
  });

  it('requires at least one category per dimension', () => {
    expect(errorsOf({ sex: {} })).toEqual(['sex: needs at least one category']);
  });

  it.each(['sex', 'age', 'disability', 'location', 'displacement_status', 'sex_of_household_head', 'age2'])(
    'accepts the dimension name %j',
    dimension => {
      expect(breakdownOf({ [dimension]: { a: 218 } })).toEqual({ [dimension]: { a: 218 } });
    },
  );

  it.each(['Sex', 'sex of head', '1age', '_sex', 'age-group', 'جنس', '', '__proto__'])('rejects the dimension name %j', dimension => {
    const errors = errorsOf({ [dimension]: { a: 218 } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('is not a valid dimension name');
  });

  it('allows 10 dimensions and rejects 11', () => {
    const ten = Object.fromEntries(Array.from({ length: BREAKDOWN_LIMITS.maxDimensions }, (_, i) => [`d${i}`, { all: 218 }]));
    expect(Object.keys(breakdownOf(ten)!)).toHaveLength(10);
    const eleven = { ...ten, d10: { all: 218 } };
    expect(errorsOf(eleven)).toContain('breakdown can have at most 10 dimensions (got 11)');
  });

  it('allows 50 categories per dimension and rejects 51', () => {
    expect(Object.keys(breakdownOf({ location: categories(50) }, '50')!.location)).toHaveLength(50);
    expect(errorsOf({ location: categories(51) }, '51')).toEqual(['location: can have at most 50 categories (got 51)']);
  });

  it('trims category names and keeps names in any language', () => {
    expect(breakdownOf({ sex: { ' female ': 120, 'ذكر': 98 } })).toEqual({ sex: { female: 120, 'ذكر': 98 } });
  });

  it('rejects empty category names', () => {
    expect(errorsOf({ sex: { '': 218 } })).toEqual(['sex: category names must not be empty']);
    expect(errorsOf({ sex: { '   ': 218 } })).toEqual(['sex: category names must not be empty']);
  });

  it('allows category names of 60 characters and rejects 61', () => {
    const sixty = 'x'.repeat(60);
    expect(breakdownOf({ location: { [sixty]: 218 } })).toEqual({ location: { [sixty]: 218 } });
    expect(errorsOf({ location: { ['x'.repeat(61)]: 218 } })[0]).toMatch(/^location: category "x+\.\.\." is longer than 60 characters$/);
  });

  it('rejects two categories that are the same after trimming', () => {
    expect(errorsOf({ sex: { female: 100, 'female ': 118 } })).toEqual(['sex: category "female" appears more than once']);
  });

  it('keeps a "__proto__" category as an ordinary category', () => {
    const parsed = JSON.parse('{"group": {"__proto__": 18, "other": 200}}');
    const result = breakdownOf(parsed)!;
    expect(Object.keys(result.group)).toEqual(['__proto__', 'other']);
    expect(Object.getPrototypeOf(result.group)).toBe(Object.prototype);
  });
});

describe('validateBreakdown: values', () => {
  it('converts numeric strings to numbers', () => {
    expect(breakdownOf({ sex: { female: '120', male: ' 98 ' } })).toEqual({ sex: { female: 120, male: 98 } });
    expect(breakdownOf({ sex: { female: '١٢٠', male: '٩٨' } })).toEqual({ sex: { female: 120, male: 98 } });
  });

  it('accepts zero', () => {
    expect(breakdownOf({ sex: { female: 218, male: 0 } })).toEqual({ sex: { female: 218, male: 0 } });
  });

  it.each([
    ['abc', '"abc"'], ['', '""'], [null, 'null'], [true, 'true'], [{ n: 1 }, 'an object'], [[1], 'a list'],
  ])('rejects the category value %j', (value, shown) => {
    expect(errorsOf({ sex: { female: value, male: 98 } })).toEqual([`sex: "female" must be a number (got ${shown})`]);
  });

  it('rejects negative values', () => {
    expect(errorsOf({ sex: { female: -1, male: 219 } })).toEqual(['sex: "female" must not be negative (got -1)']);
    expect(errorsOf({ sex: { female: '-0.5', male: 218.5 } })).toEqual(['sex: "female" must not be negative (got -0.5)']);
  });

  it('reports every problem at once', () => {
    const errors = errorsOf({ sex: { female: 'x', male: -2 }, Age: { all: 218 }, disability: { yes: 10, no: 10 } });
    expect(errors).toEqual([
      'sex: "female" must be a number (got "x")',
      'sex: "male" must not be negative (got -2)',
      expect.stringContaining('"Age" is not a valid dimension name'),
      'disability: categories add up to 20 but the value is 218',
    ]);
  });
});

describe('validateBreakdown: count units add up to the value', () => {
  it('reports a dimension that does not add up, with both numbers', () => {
    expect(errorsOf({ sex: { female: 120, male: 90 } })).toEqual(['sex: categories add up to 210 but the value is 218']);
  });

  it('checks every dimension separately', () => {
    const errors = errorsOf({ sex: { female: 120, male: 98 }, disability: { yes: 12, no: 200 } });
    expect(errors).toEqual(['disability: categories add up to 212 but the value is 218']);
  });

  it.each(['number', 'people', 'households', 'Number of participants'])('applies the check for the unit %j', unit => {
    expect(errorsOf({ sex: { female: 1, male: 1 } }, '3', unit)).toEqual(['sex: categories add up to 2 but the value is 3']);
  });

  it('accepts sums within the 1e-6 tolerance and rejects anything beyond it', () => {
    expect(breakdownOf({ a: { x: 0.1, y: 0.2 } }, '0.3')).toEqual({ a: { x: 0.1, y: 0.2 } });
    expect(breakdownOf({ a: { x: 100, y: 118.0000009 } }, '218')).toBeTruthy();
    expect(errorsOf({ a: { x: 100, y: 118.000002 } }, '218')).toEqual(['a: categories add up to 218.000002 but the value is 218']);
  });

  it('reads the value with the same number rules (thousands separators, Arabic digits)', () => {
    expect(breakdownOf({ sex: { female: 600, male: 600 } }, '1,200')).toEqual({ sex: { female: 600, male: 600 } });
    expect(breakdownOf({ sex: { female: 120, male: 98 } }, '٢١٨')).toEqual({ sex: { female: 120, male: 98 } });
  });

  it('requires a numeric value instead of silently skipping the sum check', () => {
    const message = 'value must be a number to record a breakdown for a count indicator';
    expect(errorsOf({ sex: { female: 1, male: 1 } }, 'pending')).toEqual([message]);
    expect(errorsOf({ sex: { female: 1, male: 1 } }, '12 people', 'people')).toEqual([message]);
    // Reported once, together with the other problems.
    expect(errorsOf({ sex: { female: 'x' }, age: { all: 1 } }, 'Yes')).toEqual([message, 'sex: "female" must be a number (got "x")']);
  });

  it('accepts a non-numeric value without a breakdown', () => {
    expect(validateBreakdown(undefined, { value: 'pending', unit: 'people' })).toEqual({ ok: true, breakdown: null });
    expect(validateBreakdown({}, { value: 'pending', unit: 'people' })).toEqual({ ok: true, breakdown: null });
  });
});

describe('validateBreakdown: indicators without a unit', () => {
  it.each([null, '', '   '])('applies no sum check for the unit %j when the text is not a percentage', unit => {
    const result = validateBreakdown({ sex: { female: 4, male: 5 } }, { value: '10', unit, indicatorText: 'Number of youth trained' });
    expect(result).toEqual({ ok: true, breakdown: { sex: { female: 4, male: 5 } } });
    // Nor without any text, and a non-numeric value is fine.
    expect(validateBreakdown({ sex: { female: 4 } }, { value: 'pending', unit })).toEqual({ ok: true, breakdown: { sex: { female: 4 } } });
  });

  it('applies the percent rules when the text reads as a percentage', () => {
    const opts = { value: '61', unit: null, indicatorText: '% of households with acceptable FCS' };
    expect(validateBreakdown({ sex: { female: 64.5, male: 58 } }, opts)).toEqual({ ok: true, breakdown: { sex: { female: 64.5, male: 58 } } });
    expect(validateBreakdown({ sex: { female: 120, male: 58 } }, opts)).toEqual({
      ok: false, errors: ['sex: "female" must be between 0 and 100 for a percentage (got 120)'],
    });
    expect(validateBreakdown({ sex: { female: 101 } }, { value: '61', unit: '', indicatorText: 'نسبة الأسر' }).ok).toBe(false);
  });

  it('lets an explicit unit win over the text', () => {
    expect(validateBreakdown({ sex: { female: 120, male: 98 } }, { value: '218', unit: 'people', indicatorText: '% of households' }).ok).toBe(true);
  });
});

describe('validateBreakdown: percentages', () => {
  it('accepts categories between 0 and 100 without a sum check', () => {
    const breakdown = { sex: { female: 64.5, male: 58 }, location: { hebron: 0, gaza: 100 } };
    expect(breakdownOf(breakdown, '61', 'percent')).toEqual(breakdown);
    expect(breakdownOf({ sex: { female: '64.5' } }, '61', '%')).toEqual({ sex: { female: 64.5 } });
  });

  it('rejects categories above 100', () => {
    expect(errorsOf({ sex: { female: 100.5, male: 58 } }, '61', 'percentage')).toEqual([
      'sex: "female" must be between 0 and 100 for a percentage (got 100.5)',
    ]);
  });

  it('rejects negative percentages', () => {
    expect(errorsOf({ sex: { female: -1 } }, '61', 'percent')).toEqual(['sex: "female" must not be negative (got -1)']);
  });
});

describe('validateBreakdown: other units', () => {
  it.each(['score', 'currency_ils', 'litres_per_person_per_day', 'yes_no'])('does not check sums or bounds for %j', unit => {
    expect(breakdownOf({ sex: { female: 250, male: 180.5 } }, '12', unit)).toEqual({ sex: { female: 250, male: 180.5 } });
  });

  it('still requires non-negative numbers', () => {
    expect(errorsOf({ sex: { female: -3 } }, '12', 'score')).toEqual(['sex: "female" must not be negative (got -3)']);
  });
});
