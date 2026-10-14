import { describe, expect, it } from 'vitest';
import { AI_ANALYSIS_MARKER, standaloneValueOffsets } from '../src/services/ai/frameworkNormalize';
import type { VerifiedFigure } from '../src/services/ai/frameworkNormalize';
import { REDACTION_PLACEHOLDERS, redactPersonalData } from '../src/services/ai/redact';
import {
  FACT_CUES, MAX_DOCUMENT_FACTS, MAX_EXCERPT_CHARS, MAX_FACTS_PER_DOCUMENT, extractDocumentFacts, factCuePositions, factKind,
  factsFromVerifiedFigures, splitSentences,
} from '../src/services/kpi/documentFacts';
import { valueKindInFact } from '../src/services/kpi/validate';
import type { DocumentFact } from '../src/services/kpi/types';

/**
 * DOCUMENT FACTS (spec §A3 documentFacts; me-foundations §6; design 1.3, 4.3, 6.4, D14, B1, M1). Every text here is made
 * up; the phone number below is a fictitious test value that the redactor removes.
 */

const doc = (text: string, extra: Partial<{ id: string; fileName: string; verifiedTargets: string[] }> = {}) =>
  ({ id: extra.id ?? 'doc-1', fileName: extra.fileName ?? 'proposal.pdf', text, verifiedTargets: extra.verifiedTargets });

/** The kind of the value at its first standalone occurrence in the fact (E2's valueKindInFact on my offsets). */
const kindOfValue = (fact: DocumentFact, value: string) => valueKindInFact(fact, standaloneValueOffsets(fact.excerpt, value)[0].start);

describe('splitSentences', () => {
  it('splits at line breaks, tabs and "|", and after . ! ? ؟ followed by whitespace', () => {
    expect(splitSentences('First line\nSecond line\tthird cell | fourth cell')).toEqual(['First line', 'Second line', 'third cell', 'fourth cell']);
    expect(splitSentences('We trained 300 youth. Then we placed them! Did it work? Yes.')).toEqual([
      'We trained 300 youth.', 'Then we placed them!', 'Did it work?', 'Yes.',
    ]);
    expect(splitSentences('هل تحسن الوصول إلى المياه؟ نعم بنسبة كبيرة.')).toEqual(['هل تحسن الوصول إلى المياه؟', 'نعم بنسبة كبيرة.']);
  });

  it('never splits inside a number (decimals, thousands dots, Arabic separators)', () => {
    expect(splitSentences('The rate rose to 22.5% in 2025. Next sentence.')).toEqual(['The rate rose to 22.5% in 2025.', 'Next sentence.']);
    expect(splitSentences('Yield reached 4.5 kg per dunum.')).toEqual(['Yield reached 4.5 kg per dunum.']);
    expect(splitSentences('We reached 1.200 households last year.')).toEqual(['We reached 1.200 households last year.']);
    expect(splitSentences('بلغت النسبة ١٢٫٥٪ من الأسر.')).toEqual(['بلغت النسبة ١٢٫٥٪ من الأسر.']);
  });

  it('keeps abbreviations, initials and "No. 5" inside the sentence', () => {
    expect(splitSentences('Facilities, e.g. 5 schools and 2 clinics, were assessed.')).toEqual(['Facilities, e.g. 5 schools and 2 clinics, were assessed.']);
    expect(splitSentences('Small towns, i.e. under 10,000 people, etc. are covered.')).toEqual(['Small towns, i.e. under 10,000 people, etc. are covered.']);
    expect(splitSentences('See Fig. 3 and approx. 40 sites vs. 30 last year.')).toEqual(['See Fig. 3 and approx. 40 sites vs. 30 last year.']);
    expect(splitSentences('Dr. Smith and J. Doe visited site No. 5 today.')).toEqual(['Dr. Smith and J. Doe visited site No. 5 today.']);
    expect(splitSentences('The answer was no. Then the survey started.')).toEqual(['The answer was no.', 'Then the survey started.']);
  });

  it('does not split on ";" or inside an ellipsis, and keeps closing quotes with their sentence', () => {
    expect(splitSentences('Target: 900 youth (50% women) complete training; 60% employed within six months.'))
      .toEqual(['Target: 900 youth (50% women) complete training; 60% employed within six months.']);
    expect(splitSentences('The figures ... show 45% coverage.')).toEqual(['The figures ... show 45% coverage.']);
    expect(splitSentences('He said "done." Then he left.')).toEqual(['He said "done."', 'Then he left.']);
  });

  it('returns substrings of the text, trimmed, without empty segments', () => {
    const text = '  A first sentence.   A second one!\n\n\t| \nlast  ';
    const parts = splitSentences(text);
    expect(parts).toEqual(['A first sentence.', 'A second one!', 'last']);
    for (const p of parts) expect(text.includes(p)).toBe(true);
  });
});

describe('factKind and cue words', () => {
  it('target, baseline, mixed and null from cue words', () => {
    expect(factKind('Target: 900 youth (50% women) complete training; 60% employed within six months.')).toBe('target');
    expect(factKind('The action will rehabilitate 18 community water points and distribute 4,000 hygiene kits.')).toBe('target');
    expect(factKind('The household survey found that 22.5% of households had access to safe water')).toBe('baseline');
    expect(factKind('The 2025 baseline survey found 45% of households treat water; the target is 75% by 2027.')).toBe('mixed');
    expect(factKind('The governorate has 12 municipalities and 3 hospitals.')).toBeNull();
  });

  it('a verified target makes a sentence without cues a target, and a baseline sentence mixed', () => {
    expect(factKind('Distribution of 4,000 hygiene kits in Khan Younis.', ['4,000 hygiene kits'])).toBe('target');
    expect(factKind('Distribution of 4,000 hygiene kits in Khan Younis.', ['4,000'])).toBe('target');
    expect(factKind('Currently 4,000 hygiene kits are in stock.', ['4,000'])).toBe('mixed');
    // A verified target that is not in the sentence, a bare small number or a year is no pointer.
    expect(factKind('Distribution of 4,000 hygiene kits in Khan Younis.', ['75%'])).toBeNull();
    expect(factKind('The governorate has 12 municipalities and 3 hospitals.', ['3'])).toBeNull();
    expect(factKind('The map for 2027 shows 12 municipalities.', ['2027'])).toBeNull();
  });

  it('Arabic cues are tokens with proclitics and spelling variants', () => {
    expect(factKind('سيتم تأهيل 18 نقطة مياه مجتمعية.')).toBe('target');
    expect(factKind('القيمة المستهدف الوصول إليها هي 75٪.')).toBe('target');
    expect(factKind('وبحلول نهاية المشروع ستصل التغطية إلى 60٪.')).toBe('target');
    expect(factKind('أظهر المسح أن 45٪ من الأسر تعالج المياه.')).toBe('baseline');
    expect(factKind('حاليا تحصل 30٪ من الأسر على المياه.')).toBe('baseline');
    expect(factKind('حاليًا تحصل 30٪ من الأسر على المياه.')).toBe('baseline');
    expect(factKind('بلغ خط الأساس 45٪ والهدف 75٪.')).toBe('mixed');
    // "المستهدفة" (targeted, an adjective) and "يهدف" are not cues.
    expect(factKind('تحصل 30٪ من الأسر المستهدفة على المياه.')).toBeNull();
  });

  it('"target households" and "hard-to-reach" are descriptions, not cues; "reached" is not "reach"', () => {
    expect(factKind('45% of target households treat their drinking water.')).toBeNull();
    expect(factKind('Among target areas, 12 villages have no network.')).toBeNull();
    expect(factKind('30% of households in hard-to-reach areas have a latrine.')).toBeNull();
    expect(factKind('30% of households in hard to reach areas have a latrine.')).toBeNull();
    expect(factKind('The project reached 1,200 households.')).toBeNull();
    expect(factKind('The project targets 500 households.')).toBe('target');
    expect(factKind('We aim to reach 500 households.')).toBe('target');
  });

  it('factCuePositions lists each cue once, in text order, with offsets in the normalised text', () => {
    const cues = factCuePositions('The 2025 baseline survey found 45% of households treat water; the target is 75% by 2027.');
    expect(cues.map(c => c.kind)).toEqual(['baseline', 'baseline', 'target']);
    expect(factCuePositions('حاليًا 30٪').length).toBe(1);
    expect(FACT_CUES.target).toContain('will');
    expect(FACT_CUES.baseline).toContain('baseline');
  });

  it('in a mixed fact each value takes the kind of the nearest cue before it (45 baseline, 75 target)', () => {
    const [fact] = extractDocumentFacts([doc('The 2025 baseline survey found 45% of households treat water; the target is 75% by 2027.')]);
    expect(fact.kind).toBe('mixed');
    expect(kindOfValue(fact, '45%')).toBe('baseline');
    expect(kindOfValue(fact, '75%')).toBe('target');
  });
});

describe('the kind of each value comes from its own clause (SPEC-2)', () => {
  const only = (text: string) => {
    const facts = extractDocumentFacts([doc(text)]);
    expect(facts).toHaveLength(1);
    return facts[0];
  };

  it('"currently plans to train 600" is a plan: a target fact, 600 a target', () => {
    const fact = only('The organisation currently plans to train 600 young women and men in Hebron.');
    expect(fact.kind).toBe('target');
    expect(kindOfValue(fact, '600')).toBe('target');
    expect(FACT_CUES.target).toEqual(expect.arrayContaining(['plan', 'plans', 'planned']));
    // "currently" alone still marks a baseline.
    expect(kindOfValue(only('The project currently serves 1,200 households in the camp.'), '1,200')).toBe('baseline');
  });

  it('"As of the end of year two, 450 graduates will have found work": 450 is a target', () => {
    const fact = only('As of the end of year two, 450 graduates will have found work.');
    expect(kindOfValue(fact, '450')).toBe('target');
  });

  it('"75% …, up from 45% in the 2025 survey, will …": mixed, 75% target and 45% baseline', () => {
    const fact = only('By the end of the project, 75% of households, up from 45% in the 2025 survey, will treat their drinking water.');
    expect(fact.kind).toBe('mixed');
    expect(kindOfValue(fact, '75%')).toBe('target');
    expect(kindOfValue(fact, '45%')).toBe('baseline');
  });

  it('"from 30% at baseline to 60% by the end of 2027": 30% baseline, 60% target (EN and AR); ranges and years are no change', () => {
    const fact = only('The target is to raise the share of households treating water from 30% at baseline to 60% by the end of 2027.');
    expect(fact.kind).toBe('mixed');
    expect(kindOfValue(fact, '30%')).toBe('baseline');
    expect(kindOfValue(fact, '60%')).toBe('target');
    const arabic = only('سيتم رفع نسبة الأسر التي تعالج المياه من ٣٠٪ إلى ٦٠٪ بحلول نهاية عام ٢٠٢٧.');
    expect(kindOfValue(arabic, '30%')).toBe('baseline');
    expect(kindOfValue(arabic, '60%')).toBe('target');
    // An age range and a period are not baseline-to-target statements: the numbers keep the sentence's cue.
    const range = only('The project will screen 500 children aged from 6 to 59 months in the camps.');
    expect(kindOfValue(range, '59')).toBe('target');
    expect(kindOfValue(only('The project will run from 2026 to 2028 in 12 villages of Hebron.'), '2026')).toBe('target');
  });

  it('a cue after the value labels it when its clause has none before it ("45% … currently treat water")', () => {
    const fact = only('45% of households currently treat water and the project will raise this to 75%.');
    expect(kindOfValue(fact, '45%')).toBe('baseline');
    expect(kindOfValue(fact, '75%')).toBe('target');
  });

  it('a time cue before a value yields to the value\'s own plan verb, with or without a comma (re-check SPEC-2 a)', () => {
    expect(kindOfValue(only('As of the end of year two 450 graduates will have found work.'), '450')).toBe('target');
    expect(kindOfValue(only('Currently 600 young people are planned to be trained.'), '600')).toBe('target');
    expect(kindOfValue(only('The organisation currently intends to train 600 young people.'), '600')).toBe('target');
    expect(FACT_CUES.target).toEqual(expect.arrayContaining(['intend to', 'intends to', 'intended to']));
    // The plan verb of another clause or another number does not take the value: these stay baselines.
    expect(kindOfValue(only('Currently 45% of households have an acceptable FCS and the project will raise this to 70% by 2027.'), '45%')).toBe('baseline');
    expect(kindOfValue(only('Currently 600 young people are trained each year and 900 will be trained by 2027.'), '600')).toBe('baseline');
    expect(kindOfValue(only('Currently 45% of households treat water which will rise to 70% by 2027.'), '45%')).toBe('baseline');
  });

  it('a reference value inside a target sentence is a baseline, never a target (re-check SPEC-2 b)', () => {
    for (const text of [
      'By 2027, 75% of households will have acceptable FCS compared with 45% in 2025.',
      'By 2027, 75% of households will have acceptable FCS against 45% in 2025.',
      'The project will raise acceptable FCS to 75% (45% in 2025).',
      'By 2027, 75% of households will have acceptable FCS, compared with 45% at baseline.',
      'Acceptable FCS stood at 45% in 2025 and is expected to reach 75% by 2027.',
      'Acceptable FCS was 45% in 2025 and is expected to reach 75% by 2027.',
      'The project expects acceptable FCS to reach 75% by 2027 from 45% in 2025.',
    ]) {
      const fact = only(text);
      expect(kindOfValue(fact, '45%'), text).toBe('baseline');
      expect(kindOfValue(fact, '75%'), text).toBe('target');
    }
    // A comparison point that is not dated as the starting value is neither a baseline nor a target.
    const national = only('The project will raise acceptable FCS to 75% by 2027, compared with 60% nationally.');
    expect(kindOfValue(national, '60%')).toBeNull();
    expect(kindOfValue(national, '75%')).toBe('target');
    // A value dated in the planned year stays a target.
    expect(kindOfValue(only('The project will reach 75% of households in 2027 and keep 3,500 enrolled by 2027.'), '75%')).toBe('target');
  });

  it('a word ending in "age" before "from X to Y" is no age range (finisher re-check SPEC-2: coverage, percentage, average)', () => {
    for (const [text, x, y] of [
      ['The project will increase vaccination coverage from 60% to 85% by 2027.', '60%', '85%'],
      ['The project will reduce the percentage from 40% to 20% by 2027.', '40%', '20%'],
      ['The project will raise the average from 3.2 to 4.5 by 2027.', '3.2', '4.5'],
      ['The shortage from 30% to 10% is the aim of the action.', '30%', '10%'],
      ['Increase coverage from 40% to 70% by 2027.', '40%', '70%'],
      ['Coverage is expected to increase from the current 40% to 70%.', '40%', '70%'],
    ]) {
      const fact = only(text);
      expect(fact.kind, text).toBe('mixed');
      expect(kindOfValue(fact, x), text).toBe('baseline');
      expect(kindOfValue(fact, y), text).toBe('target');
    }
    // Real ranges keep their sentence's cue: "aged from 6 to 59 months", "between 15 and 29".
    expect(kindOfValue(only('Children aged from 6 to 59 months will be screened.'), '6')).toBe('target');
    expect(kindOfValue(only('The project will train youth aged between 15 and 29 in Hebron.'), '15')).toBe('target');
  });

  it('plan and expect verbs in English and Arabic state a plan; the noun "plan" and "N planned <noun>" do not (finisher re-check SPEC-2)', () => {
    for (const [text, value] of [
      ['Currently, the organisation expects 450 graduates to find work.', '450'],
      ['The organisation is currently planning to train 600 young people.', '600'],
      ['حاليا يخطط المشروع لتدريب 600 شاب.', '600'],
      ['حاليا، من المخطط تدريب 600 شاب.', '600'],
      ['حاليا، من المتوقع أن يجد 450 خريجا عملا.', '450'],
      ['The project plans to rehabilitate 12 water points in the camp.', '12'],
    ]) expect(kindOfValue(only(text), value), text).toBe('target');
    // The noun is context: no cue, so no fact kind and no baseline or target evidence.
    expect(factKind('Under the 2025 response plan, 12,000 households received food vouchers.')).toBeNull();
    expect(factKind('The work plan foresees 12 training sessions for 300 teachers.')).toBeNull();
    // "the 12 planned water points": 12 is planned, 3 (dated "as of") is what was reached.
    const progress = only('As of June 2026, 3 of the 12 planned water points had been rehabilitated.');
    expect(kindOfValue(progress, '3')).toBe('baseline');
    expect(kindOfValue(progress, '12')).toBe('target');
    // "planned" as a verb still announces a plan.
    expect(kindOfValue(only('Currently 600 young people are planned to be trained.'), '600')).toBe('target');
  });

  it('a value dated "last year" or "today" is a baseline inside a target sentence (finisher re-check SPEC-2)', () => {
    const lastYear = only('The project will raise acceptable FCS to 75%; it was 45% last year.');
    expect(kindOfValue(lastYear, '45%')).toBe('baseline');
    expect(kindOfValue(lastYear, '75%')).toBe('target');
    const today = only('Today only 20% of women participate in committees; the project aims for 40%.');
    expect(kindOfValue(today, '20%')).toBe('baseline');
    expect(kindOfValue(today, '40%')).toBe('target');
  });

  it('"stood at" labels a baseline and "at endline" a target', () => {
    const fact = only('45% at baseline, 70% at endline.');
    expect(fact.kind).toBe('mixed');
    expect(kindOfValue(fact, '45%')).toBe('baseline');
    expect(kindOfValue(fact, '70%')).toBe('target');
  });
});

describe('extractDocumentFacts', () => {
  it('keeps whole sentences: 22.5%, 4.5 kg, 1.200, e.g. 5 schools and ١٢٫٥٪ are never cut', () => {
    const text = [
      'The household survey found that 22.5% of households had access to safe water',
      'Average yield was 4.5 kg per dunum among supported farmers.',
      'The project currently serves 1.200 households in the camp.',
      'Facilities, e.g. 5 schools and 2 clinics, were assessed by the team.',
      'تحصل حاليا ١٢٫٥٪ من الأسر على مياه آمنة للشرب.',
    ].join('\n');
    const facts = extractDocumentFacts([doc(text)]);
    const excerpts = facts.map(f => f.excerpt);
    expect(excerpts).toContain('The household survey found that 22.5% of households had access to safe water');
    expect(excerpts).toContain('Average yield was 4.5 kg per dunum among supported farmers.');
    expect(excerpts).toContain('The project currently serves 1.200 households in the camp.');
    expect(excerpts).toContain('Facilities, e.g. 5 schools and 2 clinics, were assessed by the team.');
    expect(excerpts).toContain('تحصل حاليا ١٢٫٥٪ من الأسر على مياه آمنة للشرب.');
    expect(facts.find(f => f.excerpt.includes('22.5%'))!.kind).toBe('baseline');
    // "22" never stands alone in the "22.5%" excerpt (rules 8–9 check (a)).
    expect(standaloneValueOffsets(facts.find(f => f.excerpt.includes('22.5%'))!.excerpt, '22')).toEqual([]);
  });

  it('the CASE-02 logframe line is one target fact and the CASE-01 proposal line is a target fact', () => {
    const facts = extractDocumentFacts([
      doc('Target: 900 youth (50% women) complete training; 60% employed within six months.', { id: 'd2', fileName: 'logframe.xlsx' }),
      doc('The action will rehabilitate 18 community water points and distribute 4,000 hygiene kits.', { id: 'd1' }),
    ]);
    expect(facts).toEqual(expect.arrayContaining([
      { documentId: 'd2', fileName: 'logframe.xlsx', excerpt: 'Target: 900 youth (50% women) complete training; 60% employed within six months.', kind: 'target' },
      { documentId: 'd1', fileName: 'proposal.pdf', excerpt: 'The action will rehabilitate 18 community water points and distribute 4,000 hygiene kits.', kind: 'target' },
    ]));
    // A target sentence never supplies a baseline: the value's kind there is 'target'.
    expect(kindOfValue(facts.find(f => f.documentId === 'd1')!, '18')).toBe('target');
  });

  it('drops segments without a number, with only years, shorter than 20 characters, or holding a redaction placeholder', () => {
    const phone = '0599123456'; // fictitious number in a test line
    const redacted = redactPersonalData(`Contact the field officer on ${phone} for the 45 kits.`).text;
    expect(redacted).toContain(REDACTION_PLACEHOLDERS.phone);
    const facts = extractDocumentFacts([doc([
      'This sentence has no figure at all, only words.',
      'The project runs from 2026 to 2028 in Hebron.',
      'Only 12 kits.',
      redacted,
      `The ${REDACTION_PLACEHOLDERS.idNumber} record lists 3 children and 40 visits.`,
      'The baseline is 2026 and 45% of households treat water.',
    ].join('\n'))]);
    expect(facts.map(f => f.excerpt)).toEqual(['The baseline is 2026 and 45% of households treat water.']);
    for (const f of facts) for (const p of Object.values(REDACTION_PLACEHOLDERS)) expect(f.excerpt).not.toContain(p);
  });

  it('a number only after the marker is never a fact', () => {
    const text = `The baseline survey found 45% of households treat water.\n${AI_ANALYSIS_MARKER}\nThe target is 99% by 2027 according to the analysis.`;
    const facts = extractDocumentFacts([doc(text)]);
    expect(facts.map(f => f.excerpt)).toEqual(['The baseline survey found 45% of households treat water.']);
    expect(facts.some(f => f.excerpt.includes('99'))).toBe(false);
  });

  it('every excerpt is a substring of its document text, and long sentences are cut at whitespace, never after a digit', () => {
    const filler = 'the community water committee met with the municipality and the partners to agree on the plan '.repeat(4);
    const long = `The baseline survey found that ${filler}in the end 45 % of households treat water at home and the rest do not.`;
    expect(long.length).toBeGreaterThan(MAX_EXCERPT_CHARS);
    const cutAfterNumber = `${'x'.repeat(MAX_EXCERPT_CHARS - 12)} target 1 200 households will be reached.`;
    const text = [long, cutAfterNumber, 'Currently 30% of girls attend secondary school in the area.'].join('\n');
    const facts = extractDocumentFacts([doc(text)]);
    for (const f of facts) {
      expect(text.includes(f.excerpt)).toBe(true);
      expect(f.excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
      expect(f.excerpt).not.toMatch(/\d$/);
    }
    // The long sentence's number sits after character 300: a window around it keeps "45 %" whole (AI-3).
    expect(facts.some(f => f.excerpt.startsWith('The baseline survey found that'))).toBe(false);
    expect(facts.some(f => f.excerpt.includes('45 % of households treat water at home'))).toBe(true);
    expect(facts.map(f => f.excerpt)).toContain('Currently 30% of girls attend secondary school in the area.');
  });

  it('AI-3 (DB path): a target after character 300 of a long sentence still becomes a fact the validator can use', () => {
    const lead = 'Under the second specific objective, and in close coordination with the WASH cluster, the municipality and the water authority, '
      + 'and after the rehabilitation of the network in the informal displacement sites of the governorate, and once the community water '
      + 'committees have agreed the distribution schedule with the site managers, ';
    const sentence = `${lead}the action will ensure that by the end of 2027, 75% of displaced households have access to safe water.`;
    expect(sentence.indexOf('75%')).toBeGreaterThan(MAX_EXCERPT_CHARS);
    const text = `Introduction.\n${sentence}`;
    const facts = extractDocumentFacts([doc(text)]);
    const fact = facts.find(f => f.excerpt.includes('75%'));
    expect(fact).toBeDefined();
    expect(fact!.excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    expect(text.includes(fact!.excerpt)).toBe(true);
    expect(fact!.kind).toBe('target');
    expect(kindOfValue(fact!, '75%')).toBe('target');
    // Two numbers far apart in one long sentence give one window each.
    const two = `In 2025 the assessment found that 1,200 households had access, ${'and the partners agreed the schedule with the site managers '.repeat(5)}while the action will reach 3,500 households.`;
    const windows = extractDocumentFacts([doc(two)]).map(f => f.excerpt);
    expect(windows.some(e => e.includes('1,200'))).toBe(true);
    expect(windows.some(e => e.includes('3,500'))).toBe(true);
    for (const e of windows) expect(two.includes(e)).toBe(true);
  });

  it('ranks by cue words, the verified-target boost and "%", then document order; caps 15 per document and 40 in all', () => {
    const plain = (i: number) => `Line ${i}: the district has ${i + 10} schools and clinics.`;
    const facts = extractDocumentFacts([doc([
      plain(1),
      'Currently 30% of households treat water at home.',
      'Distribution of 4,000 hygiene kits in Khan Younis.',
      'The target is 75% of households by the end of the project.',
    ].join('\n'), { verifiedTargets: ['4,000 hygiene kits'] })]);
    expect(facts.map(f => f.excerpt)).toEqual([
      'The target is 75% of households by the end of the project.', // 2 cues + 1 %
      'Distribution of 4,000 hygiene kits in Khan Younis.', // verified target
      'Currently 30% of households treat water at home.', // 1 cue + 1 %
      'Line 1: the district has 11 schools and clinics.',
    ]);
    expect(facts[1].kind).toBe('target');

    const many = Array.from({ length: 30 }, (_, i) => plain(i)).join('\n');
    const capped = extractDocumentFacts([1, 2, 3, 4].map(n => doc(many.replace(/Line/g, `Doc ${n} line`), { id: `d${n}` })));
    expect(capped).toHaveLength(MAX_DOCUMENT_FACTS);
    // 15 per document, 40 in all: equal scores keep document order, so d3 gets the last 10 places and d4 none.
    expect(['d1', 'd2', 'd3', 'd4'].map(id => capped.filter(f => f.documentId === id).length))
      .toEqual([MAX_FACTS_PER_DOCUMENT, MAX_FACTS_PER_DOCUMENT, MAX_DOCUMENT_FACTS - 2 * MAX_FACTS_PER_DOCUMENT, 0]);
    // Equal scores keep document order.
    expect(capped[0].excerpt).toBe('Doc 1 line 0: the district has 10 schools and clinics.');
    // The per-document cap keeps the best 15, not the first 15.
    const best = extractDocumentFacts([doc(`${many}\nThe target is 75% of households by the end of the project.`)]);
    expect(best).toHaveLength(MAX_FACTS_PER_DOCUMENT);
    expect(best[0].excerpt).toBe('The target is 75% of households by the end of the project.');
  });

  it('keeps redacted input redacted and the file name as given; a repeated sentence is listed once', () => {
    const text = 'Currently 30% of households treat water at home.\nCurrently 30% of households treat water at home.';
    const facts = extractDocumentFacts([doc(text, { fileName: 'baseline [phone removed].pdf' }), doc(text, { id: 'doc-2' })]);
    expect(facts).toEqual([{ documentId: 'doc-1', fileName: 'baseline [phone removed].pdf', excerpt: 'Currently 30% of households treat water at home.', kind: 'baseline' }]);
  });
});

describe('factsFromVerifiedFigures (framework generation path)', () => {
  const figure = (over: Partial<VerifiedFigure>): VerifiedFigure => ({
    resultCode: 'O1', kind: 'target', value: '18', description: 'water points', source: 'proposal.pdf',
    quote: 'The action will rehabilitate 18 community water points.', ...over,
  });

  it('one fact per quote with its verified figures: excerpt = quote, fileName = source, documentId empty, kind of the figures', () => {
    expect(factsFromVerifiedFigures([figure({}), figure({ kind: 'baseline', value: '45%', quote: '45% of households treat water at home.' })])).toEqual([
      { documentId: '', fileName: 'proposal.pdf', excerpt: 'The action will rehabilitate 18 community water points.', kind: 'target',
        figures: [{ value: '18', kind: 'target', resultCode: 'O1' }] },
      { documentId: '', fileName: 'proposal.pdf', excerpt: '45% of households treat water at home.', kind: 'baseline',
        figures: [{ value: '45%', kind: 'baseline', resultCode: 'O1' }] },
    ]);
  });

  it('collapses figures of one quote into one fact (AI-3): a baseline and a target make it mixed', () => {
    const quote = 'The target is to raise the share of households treating water from 30% at baseline to 60% by the end of 2027.';
    const facts = factsFromVerifiedFigures([figure({ kind: 'baseline', value: '30%', quote }), figure({ kind: 'target', value: '60%', quote }),
      figure({ kind: 'target', value: '60%', quote })]);
    expect(facts).toEqual([{ documentId: '', fileName: 'proposal.pdf', excerpt: quote, kind: 'mixed', figures: [
      { value: '30%', kind: 'baseline', resultCode: 'O1' }, { value: '60%', kind: 'target', resultCode: 'O1' },
    ] }]);
  });

  it('leaves out a quote holding a redaction placeholder, as the request path does (PD-1)', () => {
    const quote = redactPersonalData('Contact coordinator on 0599123456 to confirm the 1,200 households.').text; // fictitious number
    expect(quote).toContain(REDACTION_PLACEHOLDERS.phone);
    expect(factsFromVerifiedFigures([figure({ value: '1,200', quote })])).toEqual([]);
    expect(factsFromVerifiedFigures([figure({ value: '1,200', quote }), figure({})])).toHaveLength(1);
  });
});
