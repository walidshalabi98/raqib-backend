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
    expect(factKind('The plan for 2027 has 12 municipalities.', ['2027'])).toBeNull();
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
    // The long sentence's number sits after the cut: the cut excerpt has no number left, so it is dropped.
    expect(facts.some(f => f.excerpt.startsWith('The baseline survey found that'))).toBe(false);
    expect(facts.map(f => f.excerpt)).toContain('Currently 30% of girls attend secondary school in the area.');
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

  it('one fact per figure: excerpt = quote, fileName = source, documentId empty, kind kept', () => {
    expect(factsFromVerifiedFigures([figure({}), figure({ kind: 'baseline', value: '45%', quote: '45% of households treat water at home.' })])).toEqual([
      { documentId: '', fileName: 'proposal.pdf', excerpt: 'The action will rehabilitate 18 community water points.', kind: 'target' },
      { documentId: '', fileName: 'proposal.pdf', excerpt: '45% of households treat water at home.', kind: 'baseline' },
    ]);
  });

  it('a quote whose cue words point the other way (or both ways) becomes mixed, so a baseline in it never becomes a target', () => {
    const [fact] = factsFromVerifiedFigures([figure({ value: '75%', quote: 'The baseline survey found 45% of households treat water; the target is 75%.' })]);
    expect(fact.kind).toBe('mixed');
    expect(kindOfValue(fact, '45%')).toBe('baseline');
    expect(kindOfValue(fact, '75%')).toBe('target');
    expect(factsFromVerifiedFigures([figure({ quote: 'Currently 18 water points need repair.' })])[0].kind).toBe('mixed');
  });
});
