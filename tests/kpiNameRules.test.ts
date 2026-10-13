import { describe, expect, it } from 'vitest';
import { loadLibraryFile } from '../src/services/library/load';
import { isDoubleBarrelled, nameHasTargetOrDirection, normalisedIndicatorName } from '../src/services/kpi/nameRules';

/**
 * KPI Assistant name rules (rules 3–4 of knowledge/kpi-assistant-spec.md §A4 step 3; me-foundations §2 rules 1–2;
 * design section 1.5, D13). Pure, no database.
 */

const library = loadLibraryFile().entries;

describe('rule 3: target or direction in the name (nameHasTargetOrDirection)', () => {
  // Copied from the Phase 3 hasDirectionalWording tests (tests/aiServices.test.ts) before indicatorAlternative.ts is
  // removed (design 3.1, m14): every name they flagged stays flagged, every name they accepted stays accepted.
  it.each([
    'Increase the number of trained teachers',
    'Improved access to clean water',
    'Reduced dropout rate',
    'To achieve 80% school attendance',
    '% of households with income above the poverty line to 80%',
    'Number of girls enrolled increased by 20%',
    'زيادة نسبة الأسر التي تحصل على مياه آمنة',
    'تحسين جودة التعليم',
    'Increase FCS to 80%',
  ])('flags the Phase 3 directional or target wording: %s', name => {
    expect(nameHasTargetOrDirection(name)).toBe(true);
  });

  it.each([
    '% of households with an acceptable Food Consumption Score',
    'Number of teachers trained in learner-centred methods (by sex)',
    'Lower secondary completion rate',
    'Average litres of water per person per day (Sphere minimum 15 litres)',
    'نسبة الأسر ذات درجة استهلاك غذائي مقبولة',
  ])('accepts the Phase 3 neutral wording: %s', name => {
    expect(nameHasTargetOrDirection(name)).toBe(false);
  });

  it.each([
    // the spec's own patterns
    ['increase to', '% of households with safe water increased to 75'],
    ['by 20%', 'Number of youth employed by 20%'],
    ['by N percent', 'Household income raised by 15 percent'],
    ['reach as a word', '% of target households we reach with hygiene kits'],
    ['digits followed by %', 'Water access for 90% of displaced households'],
    ['digits followed by ٪ (Arabic-Indic)', 'Water access for ٩٠٪ of displaced households'],
    ['a change verb anywhere', 'Food consumption score of households improved by the project'],
    ['decreased to', 'Dropout rate decreased to 5'],
    ['leading Ensure', 'Ensure safe water for all households'],
    ['leading Strengthened', 'Strengthened capacity of water committees'],
    ['leading Minimise', 'Minimise open defecation'],
    ['leading Reaching', 'Reaching 500 households with hygiene kits'],
  ])('flags %s: %s', (_label, name) => {
    expect(nameHasTargetOrDirection(name)).toBe(true);
  });

  it.each([
    ['leading زيادة', 'زيادة عدد المتدربين'],
    ['leading رفع', 'رفع نسبة الالتحاق بالمدارس'],
    ['leading الوصول إلى', 'الوصول إلى المياه الآمنة لجميع الأسر'],
    ['leading الوصول الى (no hamza)', 'الوصول الى المياه الآمنة'],
    ['leading ضمان', 'ضمان حصول الأسر على المياه'],
    ['leading تقليص', 'تقليص معدل التسرب'],
    ['بنسبة N%', 'عدد الأسر التي تحصل على المياه بنسبة 20%'],
    ['إلى N٪ (Arabic-Indic)', 'نسبة الأسر التي تحصل على المياه إلى ٨٠٪'],
    ['بنسبة N بالمئة', 'دخل الأسر بنسبة 15 بالمئة'],
    ['leading verb with diacritics', 'زِيَادَة عدد المتدربين'],
  ])('flags Arabic %s: %s', (_label, nameAr) => {
    expect(nameHasTargetOrDirection('% of households with safe water', nameAr)).toBe(true);
  });

  // Definitional thresholds are not targets (D13, critique M3).
  it.each([
    '% of pregnant women receiving at least 4 antenatal care visits',
    '% of households using at least 15 litres of water per person per day',
    'Number of children aged 6–59 months screened for acute malnutrition',
    'Number of children under 5 vaccinated',
    'Number of children up to 5 years enrolled in early learning',
    '% of households in hard-to-reach areas with access to safe water',
    '% of households in hard to reach areas with access to safe water',
    'Number of people reached by hygiene promotion sessions',
    '% of women aged 15–49 using modern contraception',
    'Number of children aged from 6 to 59 months screened',
    'Number of people reaching the clinic within one hour',
    'Number of jobs supported or sustained by the project',
    '% of supported MSMEs reporting increased sales 12 months after support',
  ])('does not flag the definitional threshold or neutral name: %s', name => {
    expect(nameHasTargetOrDirection(name)).toBe(false);
  });

  it('flags none of the library names, in English or Arabic', () => {
    expect(library.length).toBeGreaterThanOrEqual(63);
    const flagged = library.filter(e => nameHasTargetOrDirection(e.name) || nameHasTargetOrDirection(e.nameAr) || nameHasTargetOrDirection(e.name, e.nameAr));
    expect(flagged.map(e => e.id)).toEqual([]);
  });

  it('checks the Arabic name too, and ignores empty names', () => {
    expect(nameHasTargetOrDirection('% of households with safe water', 'تحسين الوصول إلى المياه')).toBe(true);
    expect(nameHasTargetOrDirection('% of households with safe water', null)).toBe(false);
    expect(nameHasTargetOrDirection('', '')).toBe(false);
  });
});

describe('rule 4: double-barrelled names (isDoubleBarrelled)', () => {
  it.each([
    '% of youth employed and satisfied',
    '% of households with water and % with soap',
    'Number of trainees and number of graduates',
    '% of farmers trained and/or percentage of farmers certified',
    'Average income and average savings of households',
    'Number of women aware and confident',
    '% of caregivers trained and literate.',
  ])('flags two measurements: %s', name => {
    expect(isDoubleBarrelled(name)).toBe(true);
  });

  it.each([
    '% of households with a handwashing facility with soap and water observed',
    'Number of people with access to improved drinking water and/or sanitation as a result of the project',
    'Number of water points constructed or rehabilitated and functional at handover',
    '% of households with water and soap',
    'Number of displaced people and host community members protected or assisted',
    '% of complaints and feedback responded to within the agreed timeframe',
    'Number of women of reproductive age, adolescent girls and children under five reached by nutrition interventions',
  ])('does not flag one measurement: %s', name => {
    expect(isDoubleBarrelled(name)).toBe(false);
  });

  it('flags none of the library names (11 hold " and ", WA-04 and AG-01 hold "and/or")', () => {
    const withAnd = library.filter(e => / and /.test(e.name));
    expect(withAnd.length).toBeGreaterThanOrEqual(11);
    expect(library.filter(e => e.name.includes('and/or')).map(e => e.id)).toEqual(expect.arrayContaining(['WA-04', 'AG-01']));
    expect(library.filter(e => isDoubleBarrelled(e.name)).map(e => e.id)).toEqual([]);
  });
});

describe('normalisedIndicatorName', () => {
  it('lower-cases, keeps letters, digits and %, and folds everything else to single spaces', () => {
    expect(normalisedIndicatorName('  % of Households — using  a basic (drinking) water-service. ')).toBe('% of households using a basic drinking water service');
    expect(normalisedIndicatorName('نسبة الأسر، المستهدفة')).toBe('نسبة الأسر المستهدفة');
    expect(normalisedIndicatorName('Number of people (by sex)')).toBe(normalisedIndicatorName('number of PEOPLE by sex'));
    expect(normalisedIndicatorName('...')).toBe('');
  });
});

describe('rule 3 after the Phase 4 review (SPEC-3, SPEC-9)', () => {
  it.each([
    ['a target value', 'Number of displaced households receiving food vouchers (target: 3,500)'],
    ['"target of N"', 'Number of youth trained (target of 500)'],
    ['a leading count', '3,500 displaced households receiving food vouchers'],
    ['"at least N" at the start', 'At least 3,500 households receive food vouchers'],
    ['a count with its target date', 'Number of youth trained, 500 by end of project'],
    ['a count by a year', 'Number of teachers trained, 1,200 by 2027'],
    ['a leading comparative', 'Higher % of households with acceptable FCS'],
    ['a leading "More"', 'More households with acceptable FCS'],
    ['a change by a factor', 'Doubling the number of households with acceptable FCS'],
    ['a change by a factor (halving)', 'Halving the share of households using crisis coping strategies'],
  ])('flags %s: %s', (_label, name) => {
    expect(nameHasTargetOrDirection(name)).toBe(true);
  });

  it.each([
    ['المستهدف with a value', 'عدد الأسر النازحة التي تتلقى قسائم غذائية (المستهدف: 3500)'],
    ['a leading count', '3500 أسرة نازحة تتلقى قسائم غذائية'],
    ['a leading count in Arabic-Indic digits', '٣٥٠٠ أسرة نازحة تتلقى قسائم غذائية'],
    ['a change by a factor', 'مضاعفة عدد الأسر ذات الاستهلاك الغذائي المقبول'],
  ])('flags the Arabic %s: %s', (_label, nameAr) => {
    expect(nameHasTargetOrDirection('Number of displaced households receiving food vouchers', nameAr)).toBe(true);
  });

  it.each([
    'Reduced Coping Strategies Index (rCSI) score of target households',
    'Enhanced Vegetation Index (EVI) of rehabilitated rangeland',
    'Improved drinking water sources: % of households using one',
    'Improved sanitation facilities per 100 people',
    '% of target households with an acceptable FCS',
    '% of pregnant women receiving at least 4 antenatal care visits',
    'Number of children aged 6–59 months screened for acute malnutrition',
    'Number of households with acceptable FCS (from 40 to 70)', // D13: "from N to M" is not rule 3's; validate.ts checks the numbers
  ])('does not flag the standard name or definitional wording: %s', name => {
    expect(nameHasTargetOrDirection(name, 'نسبة الأسر المستهدفة التي لديها استهلاك غذائي مقبول')).toBe(false);
  });

  it('still flags a standard name that holds a percentage target', () => {
    expect(nameHasTargetOrDirection('Reduced Coping Strategies Index below 10 for 80% of households')).toBe(true);
  });

  it('flags none of the 63 library names (EN and AR) with the new patterns', () => {
    expect(library.filter(e => nameHasTargetOrDirection(e.name, e.nameAr)).map(e => e.id)).toEqual([]);
  });
});

describe('rule 3 after the finisher re-check: names that only start like a direction or a count', () => {
  it.each([
    'Higher education gross enrolment ratio',
    'Greater Amman Municipality service satisfaction score',
    'Better Cotton farmers trained (number)',
    'Larger farms adopting drip irrigation (number)',
    'More than one meal per day: % of households',
    '24-hour recall dietary diversity score',
    '5-year-old children enrolled in kindergarten (number)',
    '1,000-day window: % of pregnant women counselled',
    '3W reporting completeness rate',
    '12 months after training: share of graduates employed',
  ])('does not flag %s', name => {
    expect(nameHasTargetOrDirection(name)).toBe(false);
    expect(nameHasTargetOrDirection(name, 'مؤشر')).toBe(false);
  });

  it.each([
    'Higher % of households with acceptable FCS',
    'More households with acceptable FCS',
    'Fewer children out of school',
    'Better access to safe drinking water among displaced households',
    'Lower share of households using crisis coping strategies',
    '3,500 displaced households receiving food vouchers',
    '500-1,000 households reached with hygiene kits',
    'At least 3,500 households receive food vouchers',
  ])('still flags %s', name => {
    expect(nameHasTargetOrDirection(name)).toBe(true);
  });
});
