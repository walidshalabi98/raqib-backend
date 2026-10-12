import { describe, expect, it } from 'vitest';
import { escapeHtml, htmlList, htmlParagraphs } from '../src/services/ai/html';
import { parseIndicatorNumber, progressTowardTarget, valueTrend } from '../src/services/ai/indicatorFigures';

describe('escapeHtml', () => {
  it('escapes the five HTML special characters', () => {
    expect(escapeHtml(`<script>alert("x") & 'y'</script>`)).toBe('&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;');
  });

  it('escapes an existing entity again (no double-unescaping)', () => {
    expect(escapeHtml('&lt;b&gt;')).toBe('&amp;lt;b&amp;gt;');
  });

  it('turns null and undefined into "" and other values into strings', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(0)).toBe('0');
  });

  it('leaves Arabic and plain text unchanged', () => {
    expect(escapeHtml('نسبة الأسر — 45%')).toBe('نسبة الأسر — 45%');
  });

  it('cannot break out of a quoted attribute', () => {
    const attr = `<meta content="${escapeHtml('x" onload="alert(1)')}">`;
    expect(attr).toBe('<meta content="x&quot; onload=&quot;alert(1)">');
  });
});

describe('htmlParagraphs', () => {
  it('makes one escaped paragraph per non-empty line', () => {
    expect(htmlParagraphs('First line\n\n  <b>Second</b>  \r\nThird')).toBe('<p>First line</p>\n<p>&lt;b&gt;Second&lt;/b&gt;</p>\n<p>Third</p>');
  });

  it('returns "" for empty, blank, null or undefined text', () => {
    expect(htmlParagraphs('')).toBe('');
    expect(htmlParagraphs(' \n \n')).toBe('');
    expect(htmlParagraphs(null)).toBe('');
    expect(htmlParagraphs(undefined)).toBe('');
  });
});

describe('htmlList', () => {
  it('makes an escaped unordered list of the non-empty items', () => {
    expect(htmlList(['One', ' ', '<img src=x onerror=alert(1)>'])).toBe('<ul><li>One</li><li>&lt;img src=x onerror=alert(1)&gt;</li></ul>');
  });

  it('makes an ordered list when asked', () => {
    expect(htmlList(['a', 'b'], true)).toBe('<ol><li>a</li><li>b</li></ol>');
  });

  it('returns "" when there are no items', () => {
    expect(htmlList([])).toBe('');
    expect(htmlList(['', '  '])).toBe('');
    expect(htmlList(null)).toBe('');
  });
});

describe('parseIndicatorNumber', () => {
  it.each([
    ['45', 45],
    ['45%', 45],
    [' 12.5 % ', 12.5],
    ['1,200', 1200],
    ['-3', -3],
    ['٤٥٪', 45],
    ['۱۲۰۰', 1200],
    ['١٢٫٥', 12.5],
    ['١٬٢٠٠', 1200],
  ])('reads %s as %s', (input, expected) => {
    expect(parseIndicatorNumber(input)).toBe(expected);
  });

  it.each([null, undefined, '', '  ', 'about 40', '40-50', 'yes', '12 households', '1.2.3', 'N/A'])('returns null for %s', input => {
    expect(parseIndicatorNumber(input as string | null | undefined)).toBeNull();
  });

  it('passes finite numbers through and rejects NaN and Infinity', () => {
    expect(parseIndicatorNumber(7)).toBe(7);
    expect(parseIndicatorNumber(Number.NaN)).toBeNull();
    expect(parseIndicatorNumber(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('progressTowardTarget', () => {
  it('is the share of the way from baseline to target, rounded', () => {
    expect(progressTowardTarget('20%', '60%', '40%')).toBe(50);
    expect(progressTowardTarget('0', '1,200', '400')).toBe(33);
    expect(progressTowardTarget('10', '10', '10')).toBeNull();
  });

  it('works for indicators that should decrease', () => {
    expect(progressTowardTarget('40', '20', '30')).toBe(50);
  });

  it('can be negative or above 100', () => {
    expect(progressTowardTarget('20', '60', '10')).toBe(-25);
    expect(progressTowardTarget('20', '60', '80')).toBe(150);
  });

  it('is null when a value is missing or not a plain number', () => {
    expect(progressTowardTarget(null, '60', '40')).toBeNull();
    expect(progressTowardTarget('20', undefined, '40')).toBeNull();
    expect(progressTowardTarget('20', '60', 'pending baseline')).toBeNull();
  });
});

describe('valueTrend', () => {
  it('compares the two most recent numeric values (newest first)', () => {
    expect(valueTrend(['50', '40', '90'])).toBe('improving');
    expect(valueTrend(['30', '40'])).toBe('declining');
    expect(valueTrend(['40', '40'])).toBe('stagnant');
  });

  it('reverses for indicators whose desired direction is decrease', () => {
    expect(valueTrend(['30', '40'], 'decrease')).toBe('improving');
    expect(valueTrend(['50', '40'], 'decrease')).toBe('declining');
    expect(valueTrend(['50', '40'], 'increase')).toBe('improving');
  });

  it('skips values that are not numbers', () => {
    expect(valueTrend(['n/a', '50', 'x', '40'])).toBe('improving');
  });

  it('needs two numeric values', () => {
    expect(valueTrend([])).toBe('insufficient_data');
    expect(valueTrend(['50'])).toBe('insufficient_data');
    expect(valueTrend(['50', 'pending'])).toBe('insufficient_data');
  });
});
