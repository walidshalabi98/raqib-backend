/**
 * DOCUMENT FACTS: sentences of the project's own uploaded documents that hold a number, each with a kind from cue
 * words (knowledge/kpi-assistant-spec.md §A3 documentFacts; me-foundations §6: baselines and targets only from uploaded
 * documents, by string match; design sections 1.3, 4.3, 6.4, D14). Input text is already redacted and stripped of the
 * AI analysis (documentTextForAi); the analysis is stripped again here, so text after ---AI_ANALYSIS--- is never a fact
 * (rule 14). Every excerpt is a substring of its document's own text: sentences are split only at sentence punctuation
 * followed by whitespace (never inside a number) and long sentences are cut at whitespace, never after a digit, so an
 * excerpt edge never cuts a number. Pure: no prisma, no env (tests/kpiPurity.test.ts).
 */
import { AI_ANALYSIS_MARKER, excerptSupportsValue, normaliseForMatch, stripAiAnalysis } from '../ai/frameworkNormalize';
import type { VerifiedFigure } from '../ai/frameworkNormalize';
import { REDACTION_PLACEHOLDERS } from '../ai/redact';
import type { DocumentFact } from './types';

/** At most 40 facts per context (spec §A3 documentFacts; design 1.3), at most 15 from one document. */
export const MAX_DOCUMENT_FACTS = 40;
export const MAX_FACTS_PER_DOCUMENT = 15;
/** Excerpt length limit (design 1.3); longer sentences are cut at whitespace. */
export const MAX_EXCERPT_CHARS = 300;
/** Shorter segments are headings or table cells, too short to tell what a number means. */
export const MIN_EXCERPT_CHARS = 20;

/** Cue words, matched in normaliseForMatch(excerpt) at word boundaries (EN) or as tokens (AR, after Arabic normalisation). */
export const FACT_CUES: { target: readonly string[]; baseline: readonly string[] } = {
  target: [
    'target', 'targets', 'will', 'by the end', 'expected', 'planned', 'aim', 'aims', 'goal', 'achieve', 'reach',
    'المستهدف', 'هدف', 'سيتم', 'بحلول', 'نهدف', 'الوصول إلى',
  ],
  baseline: [
    'baseline', 'currently', 'at present', 'as of', 'survey found', 'assessment found', 'found that',
    'حاليًا', 'حاليا', 'خط الأساس', 'أظهر المسح', 'أظهرت الدراسة',
  ],
};

// ------------------------------------------------------------------ sentences

/** Line breaks, tabs, form feeds and table cell separators always end a segment. */
const HARD_BREAK = /[\r\n\t\f\v|\u2028\u2029]+/;
/** Sentence punctuation (EN and AR question mark). */
const SENTENCE_END = new Set(['.', '!', '?', '؟']);
/** Closing quotes and brackets that may follow the sentence punctuation ("done." or (done.)). */
const CLOSERS = new Set(['"', "'", '”', '’', '»', ')', ']']);
/** Abbreviations whose full stop never ends a sentence (lower case, without the final "."). */
const ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'etc', 'approx', 'vs', 'fig', 'figs', 'dr', 'mr', 'mrs', 'ms', 'prof', 'st', 'cf', 'al', 'incl', 'ref',
  'ca', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'govt', 'dept',
]);

/** True when the "." at `at` (in `line`) ends a sentence; `next` is the index after the punctuation run. */
function isFullStop(line: string, at: number, next: number): boolean {
  const token = /[\p{L}.]+$/u.exec(line.slice(Math.max(0, at - 24), at))?.[0].replace(/^\.+/, '').toLowerCase() ?? '';
  if (token === '') return true; // after a number, "%" or a bracket: "trained 300." ends a sentence
  if (/^\p{L}$/u.test(token)) return false; // a single letter: an initial or a list label ("J.", "a.")
  if (/^(?:\p{L}\.)+\p{L}$/u.test(token)) return false; // initialisms: e.g, i.e, u.n
  if (token === 'no' || token === 'nos') return !/^\s*\p{Nd}/u.test(line.slice(next)); // "No. 5" vs "the answer was no."
  return !ABBREVIATIONS.has(token);
}

/** Splits one line (no hard breaks) at sentence ends: punctuation (+ closers) followed by whitespace or the line end. */
function splitLine(line: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    if (!SENTENCE_END.has(line[i])) continue;
    let j = i;
    while (j + 1 < line.length && (SENTENCE_END.has(line[j + 1]) || CLOSERS.has(line[j + 1]))) j++;
    const after = line[j + 1];
    const run = line.slice(i, j + 1);
    const endsSentence = (after === undefined || /\s/.test(after))
      && !/\.\./.test(run) // an ellipsis written as dots continues the sentence
      && (line[i] !== '.' || isFullStop(line, i, j + 1));
    if (endsSentence) {
      out.push(line.slice(start, j + 1));
      start = j + 1;
    }
    i = j;
  }
  out.push(line.slice(start));
  return out;
}

/**
 * Splits a document's own text into candidate sentences (exported for tests): at line breaks, tabs and "|"; and after
 * ". ! ? ؟" only when followed by whitespace (or the end of the text) and the "." is not part of an abbreviation
 * (e.g., i.e., etc., approx., no., vs., fig., dr., mr., ms., a single letter, or a number before it like "No. 5").
 * Never between digits ("22.5", "1.200", "١٢٫٥" stay whole). ";" does not split (a clause shares its sentence's cue).
 * Segments are trimmed; empty ones are dropped. Each segment is a substring of `text`.
 */
export function splitSentences(text: string): string[] {
  return text.split(HARD_BREAK).flatMap(splitLine).map(s => s.trim()).filter(s => s !== '');
}

// ------------------------------------------------------------------ cue words

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ARABIC_LETTER = /[؀-ۿ]/;
const ARABIC_DIACRITICS = '[ً-ْـ]*';
const ARABIC_VARIANTS: Readonly<Record<string, string>> = { ا: '[اأإآ]', ي: '[يى]', ة: '[ةه]', ه: '[هة]' };
const normaliseArabic = (s: string) => s.replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي');

/**
 * "target(s)" used as an adjective ("target households", "target areas") describes who is reached, not an intended
 * value: "45% of target households treat water" is context, never a target (me-foundations §6; design M1).
 */
const TARGET_ADJECTIVE_NOUNS = '(?:households?|groups?|populations?|areas?|communit(?:y|ies)|beneficiar(?:y|ies)|schools?'
  + '|localit(?:y|ies)|locations?|villages?|governorates?|municipalit(?:y|ies)|famil(?:y|ies)|people|persons?|individuals?'
  + '|children|women|men|girls?|boys?|youths?|farmers?|participants?|sites?|facilit(?:y|ies)|districts?|camps?|regions?'
  + '|neighbou?rhoods?|caregivers?|students?|teachers?|audiences?|crops?)';

/** Extra guards per English cue (beyond word boundaries). */
const CUE_GUARDS: Readonly<Record<string, { before?: string; after?: string }>> = {
  target: { after: `(?!\\s+${TARGET_ADJECTIVE_NOUNS}(?![\\p{L}\\p{N}]))` },
  targets: { after: `(?!\\s+${TARGET_ADJECTIVE_NOUNS}(?![\\p{L}\\p{N}]))` },
  // "hard-to-reach areas" describes where people live, not an intended value.
  reach: { before: '(?<!hard[\\s-]to[\\s-])' },
};

/**
 * The pattern of one FACT_CUES entry in normaliseForMatch(text): English cues at word boundaries (multi-word cues with
 * any whitespace); Arabic cues as tokens, with optional proclitics (و/ف, ب/ل/ك, the article) and any diacritics,
 * hamza and alif-maqsura variants, so offsets stay offsets in the normalised text.
 */
function cuePattern(cue: string): RegExp {
  const lower = normaliseForMatch(cue).trim();
  if (!ARABIC_LETTER.test(lower)) {
    const body = lower.split(/\s+/).map(escapeRegExp).join('\\s+');
    const guard = CUE_GUARDS[lower] ?? {};
    return new RegExp(`${guard.before ?? ''}(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])${guard.after ?? ''}`, 'gu');
  }
  const bare = normaliseArabic(lower);
  const body = Array.from(bare)
    .map(ch => (ch === ' ' ? '\\s+' : ARABIC_VARIANTS[ch] ?? escapeRegExp(ch)))
    .join(ARABIC_DIACRITICS);
  const article = bare.startsWith('ال') ? '' : '(?:[اأإآ]ل)?';
  return new RegExp(`(?<!\\p{L})(?:[وف])?(?:[بلك])?${article}${body}(?!\\p{L})`, 'gu');
}

const CUE_PATTERNS: ReadonlyArray<{ kind: 'baseline' | 'target'; pattern: RegExp }> = [
  ...FACT_CUES.target.map(cue => ({ kind: 'target' as const, pattern: cuePattern(cue) })),
  ...FACT_CUES.baseline.map(cue => ({ kind: 'baseline' as const, pattern: cuePattern(cue) })),
];

/** A cue word found in an excerpt; start/end are offsets in normaliseForMatch(stripAiAnalysis(excerpt)). */
export interface FactCue { kind: 'baseline' | 'target'; start: number; end: number }

/**
 * Every FACT_CUES occurrence in the excerpt, in text order (one per position: "حاليًا" and "حاليا" match once).
 * Offsets are in normaliseForMatch(stripAiAnalysis(excerpt)), the text standaloneValueOffsets measures values in, so
 * rules 8–9 can take the kind of the nearest cue before a value in a 'mixed' fact (design M1, D14).
 */
export function factCuePositions(excerpt: string): FactCue[] {
  const text = normaliseForMatch(stripAiAnalysis(excerpt));
  const seen = new Set<string>();
  const out: FactCue[] = [];
  for (const { kind, pattern } of CUE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      const key = `${kind}:${start}:${match[0].length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, start, end: start + match[0].length });
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

// ------------------------------------------------------------------ numbers and verified targets

/** A number in normalised text (ASCII digits; separators inside), not glued to a letter ("o1.2" is a code). */
const NUMBER_TOKEN = /(?<![\p{L}\p{N}])\d+(?:[.,]\d+)*%?/gu;

const isYear = (token: string) => /^\d{4}$/.test(token) && Number(token) >= 1900 && Number(token) <= 2100;

/** True when the text holds a number that is not a year 1900–2100 on its own. */
function hasFactNumber(text: string): boolean {
  for (const [token] of normaliseForMatch(text).matchAll(NUMBER_TOKEN)) {
    if (!isYear(token)) return true;
  }
  return false;
}

/**
 * A verified target is a usable pointer only when it holds a figure worth checking (like documentParser's check: not a
 * year, and at least 10, or a percentage or a decimal): a bare "3" would mark unrelated sentences as targets.
 */
function usableTargetFigures(target: string): string[] {
  const figures = Array.from(normaliseForMatch(target).matchAll(NUMBER_TOKEN), m => m[0]).filter(f => !isYear(f));
  return figures.some(f => /[%.]/.test(f) || Number(f.replace(/,/g, '')) >= 10) ? figures : [];
}

/** The excerpt holds the verified target: written as given, or every non-year figure of it standing alone. */
function containsVerifiedTarget(excerpt: string, target: string): boolean {
  const figures = usableTargetFigures(target);
  if (figures.length === 0) return false;
  return excerptSupportsValue(excerpt, target) || figures.every(f => excerptSupportsValue(excerpt, f));
}

// ------------------------------------------------------------------ kinds, ranking

/**
 * 'target' (only target cues, or the segment contains a verified target), 'baseline' (only baseline cues), 'mixed'
 * (both, or baseline cues plus a verified target), null (none: context for the model, never evidence for a baseline or a
 * target). Rules 8–9 (D14): a target sentence never supplies a baseline, a baseline sentence never a target.
 */
export function factKind(excerpt: string, verifiedTargets?: readonly string[]): DocumentFact['kind'] {
  const cues = factCuePositions(excerpt);
  const target = cues.some(c => c.kind === 'target') || (verifiedTargets ?? []).some(t => containsVerifiedTarget(excerpt, t));
  const baseline = cues.some(c => c.kind === 'baseline');
  if (target && baseline) return 'mixed';
  if (target) return 'target';
  if (baseline) return 'baseline';
  return null;
}

/** Ranking score: 3 per cue, 5 when a verified target is in the segment, 1 per "%". */
function factScore(excerpt: string, verifiedTargets: readonly string[]): number {
  const cues = factCuePositions(excerpt).length;
  const verified = verifiedTargets.some(t => containsVerifiedTarget(excerpt, t)) ? 5 : 0;
  const percents = (normaliseForMatch(excerpt).match(/%/g) ?? []).length;
  return 3 * cues + verified + percents;
}

/**
 * The segment, or its first MAX_EXCERPT_CHARS characters cut at whitespace that does not follow a digit (so neither
 * edge can cut a number such as "1 200" or "45 %"); null when no such cut leaves MIN_EXCERPT_CHARS characters.
 */
function clipExcerpt(segment: string): string | null {
  if (segment.length <= MAX_EXCERPT_CHARS) return segment;
  for (let cut = MAX_EXCERPT_CHARS; cut >= MIN_EXCERPT_CHARS; cut--) {
    if (/\s/u.test(segment[cut]) && !/[\s\p{Nd}]/u.test(segment[cut - 1])) {
      const kept = segment.slice(0, cut).trimEnd();
      return kept.length >= MIN_EXCERPT_CHARS ? kept : null;
    }
  }
  return null;
}

const PLACEHOLDERS = Object.values(REDACTION_PLACEHOLDERS);

interface RankedFact { fact: DocumentFact; score: number; docIndex: number; position: number }

const byRank = (a: RankedFact, b: RankedFact) => b.score - a.score || a.docIndex - b.docIndex || a.position - b.position;

/**
 * docs[].text must already be documentTextForAi(parsedText).text and docs[].fileName redacted. verifiedTargets =
 * target strings of aiAnalysis.targetsMentioned with verified === true (pointers only: model output never becomes
 * evidence, it only points at a sentence of the document itself).
 *
 * Algorithm (design 4.3): splitSentences; drop segments holding a redaction placeholder (most likely a personal record)
 * or the AI analysis marker; keep 20–300 characters (longer: cut at whitespace); keep segments with a number that is
 * not a year alone; kind = factKind; score = 3 × cues + 5 for a verified target + 1 per "%"; best first (ties in
 * document order); ≤ 15 per document, ≤ 40 in all; repeated excerpts once.
 */
export function extractDocumentFacts(docs: ReadonlyArray<{ id: string; fileName: string; text: string; verifiedTargets?: readonly string[] }>): DocumentFact[] {
  const ranked: RankedFact[] = [];
  const seen = new Set<string>();
  docs.forEach((doc, docIndex) => {
    const verified = (doc.verifiedTargets ?? []).filter(t => typeof t === 'string' && usableTargetFigures(t).length > 0);
    const own: RankedFact[] = [];
    splitSentences(stripAiAnalysis(doc.text)).forEach((segment, position) => {
      if (segment.length < MIN_EXCERPT_CHARS || segment.includes(AI_ANALYSIS_MARKER)) return;
      if (PLACEHOLDERS.some(p => segment.includes(p))) return;
      const excerpt = clipExcerpt(segment);
      if (excerpt === null || !hasFactNumber(excerpt) || seen.has(excerpt)) return;
      seen.add(excerpt);
      own.push({
        fact: { documentId: doc.id, fileName: doc.fileName, excerpt, kind: factKind(excerpt, verified) },
        score: factScore(excerpt, verified),
        docIndex,
        position,
      });
    });
    ranked.push(...own.sort(byRank).slice(0, MAX_FACTS_PER_DOCUMENT));
  });
  return ranked.sort(byRank).slice(0, MAX_DOCUMENT_FACTS).map(r => r.fact);
}

/**
 * Generation path (design 1.3, 6.4): one fact per verified figure of the structure step (excerpt = quote, fileName =
 * source, documentId ''). The figure's kind is kept; when the quote's own cue words point the other way (or both ways)
 * the fact becomes 'mixed', so each number in the quote takes the kind of the nearest cue before it and a baseline in a
 * target quote never becomes a target (D14).
 */
export function factsFromVerifiedFigures(figures: readonly VerifiedFigure[]): DocumentFact[] {
  return figures.map(f => {
    const cueKind = factKind(f.quote);
    const kind = cueKind === null || cueKind === f.kind ? f.kind : 'mixed';
    return { documentId: '', fileName: f.source, excerpt: f.quote, kind };
  });
}
