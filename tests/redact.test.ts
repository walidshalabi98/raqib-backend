import { describe, expect, it } from 'vitest';
import { redactPersonalData, REDACTION_PLACEHOLDERS } from '../src/services/ai/redact';
import { counts, E, I, NEGATIVES, P, POSITIVES } from './redactExamples';

describe('redactPersonalData: removes phone numbers, ID numbers and emails', () => {
  it.each(POSITIVES)('%j', (input, expected, expectedCounts) => {
    const result = redactPersonalData(input);
    expect(result.text).toBe(expected);
    expect(result.counts).toEqual(expectedCounts);
  });
});

describe('redactPersonalData: keeps years, dates, amounts and codes', () => {
  it.each(NEGATIVES.map(n => [n]))('%j', input => {
    const result = redactPersonalData(input);
    expect(result.text).toBe(input);
    expect(result.counts).toEqual(counts(0, 0, 0));
  });
});

describe('redactPersonalData: properties', () => {
  it('is idempotent: redacting twice gives the same text and finds nothing new', () => {
    for (const [input] of POSITIVES) {
      const once = redactPersonalData(input);
      const twice = redactPersonalData(once.text);
      expect(twice.text).toBe(once.text);
      expect(twice.counts).toEqual(counts(0, 0, 0));
    }
    for (const input of NEGATIVES) expect(redactPersonalData(redactPersonalData(input).text).text).toBe(input);
  });

  it('does not match its own placeholders', () => {
    const text = Object.values(REDACTION_PLACEHOLDERS).join(' / ');
    expect(redactPersonalData(text)).toEqual({ text, counts: counts(0, 0, 0) });
  });

  it('counts each kind in a mixed English and Arabic document', () => {
    const doc = [
      'Field coordinator: Ahmad (0599 123 456, ahmad@example.org), ID 401234567.',
      'المنسقة: سارة، هاتف ٠٥٦٩٨٧٦٥٤٣، هوية ٩٨٧٦٥٤٣٢١، بريد sara@example.ps',
      'Target: 1,200 households (45% female-headed) by 31/12/2027 under EU GERF 2.14.',
      'Office +970 2 298 1234; grant ENI/2026/412345678.',
    ].join('\n');
    const result = redactPersonalData(doc);
    expect(result.counts).toEqual(counts(3, 2, 2));
    expect(result.text).toContain('Target: 1,200 households (45% female-headed) by 31/12/2027 under EU GERF 2.14.');
    expect(result.text).toContain('grant ENI/2026/412345678.');
    expect(result.text).not.toMatch(/0599|401234567|@/);
    expect(result.text).not.toMatch(/[٠-٩]{9}/);
    // Only the matches change: everything else is kept in place.
    expect(result.text.split('\n')).toHaveLength(4);
    expect(result.text).toContain(`Field coordinator: Ahmad (${P}, ${E}), ID ${I}.`);
  });

  it('preserves the surrounding text exactly, including characters outside the Basic Multilingual Plane', () => {
    const input = 'Report 📄 for 0599123456 ✓';
    expect(redactPersonalData(input).text).toBe(`Report 📄 for ${P} ✓`);
  });

  it('removes a long slash-joined list in one pass: 5 000 numbers and 1 MB of text in under a second', () => {
    const phones = Array.from({ length: 5000 }, (_, i) => `0599${String(100000 + i)}`).join('/');
    const ids = Array.from({ length: 5000 }, (_, i) => String(401000000 + i)).join('/');
    const text = 'The project reached 1,250 households in 2026. '.repeat(22_000); // about 1 MB
    for (const chain of [phones, ids]) {
      const started = Date.now();
      const result = redactPersonalData(`${text}Contacts: ${chain}.\n${text}`);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(result.counts.phone + result.counts.idNumber).toBe(5000);
      expect(result.text).not.toMatch(/\d{9}/);
    }
  });

  it('stays fast on adversarial input', () => {
    for (const input of ["a'".repeat(400_000), 'a.'.repeat(400_000), 'a@'.repeat(400_000), `a@${'bb.'.repeat(250_000)}`, '05 '.repeat(300_000), 'ECHO/412345678/'.repeat(50_000)]) {
      const started = Date.now();
      redactPersonalData(input);
      expect(Date.now() - started).toBeLessThan(1000);
    }
  });

  it('keeps the known trade-offs', () => {
    // An ID number written against a name or another non-label word, or in groups, is kept.
    expect(redactPersonalData('AhmadAli401234567').counts).toEqual(counts(0, 0, 0));
    expect(redactPersonalData('ID 401 234 567').counts).toEqual(counts(0, 0, 0));
    // Five pair-grouped numbers on their own are read as a phone number.
    expect(redactPersonalData('05 06 07 08 09').text).toBe(P);
  });

  it('handles empty and very long input quickly', () => {
    expect(redactPersonalData('')).toEqual({ text: '', counts: counts(0, 0, 0) });
    const rows = 'Name,401234567,0599123456,ahmad@example.org,2026-10-12,1,200\n'.repeat(5000);
    const started = Date.now();
    const result = redactPersonalData(rows + 'a'.repeat(200_000) + '1'.repeat(200_000));
    expect(result.counts).toEqual(counts(5000, 5000, 5000));
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
