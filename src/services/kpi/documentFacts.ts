/**
 * DOCUMENT FACTS: sentences of the project's own uploaded documents that hold a number, each with a kind from cue
 * words (knowledge/kpi-assistant-spec.md §A3 documentFacts; me-foundations §6; design sections 1.3, 4.3, D14).
 * Input text is already redacted and stripped of the AI analysis (documentTextForAi). Pure: no prisma, no env.
 *
 * Step 0 stub (Phase 4 contracts): constants and signatures are final; E3 implements the bodies.
 */
import type { VerifiedFigure } from '../ai/frameworkNormalize';
import type { DocumentFact } from './types';

export const MAX_DOCUMENT_FACTS = 40;
export const MAX_FACTS_PER_DOCUMENT = 15;
export const MAX_EXCERPT_CHARS = 300;

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

/**
 * Splits a document's own text into candidate sentences (exported for tests): at line breaks, tabs and "|"; and after
 * ". ! ? ؟" only when followed by whitespace (or the end of the text) and the "." is not part of an abbreviation
 * (e.g., i.e., etc., approx., no., vs., fig., dr., mr., ms., a single letter, or a number before it like "No. 5").
 * Never between digits ("22.5", "1.200", "١٢٫٥" stay whole). ";" does not split (a clause shares its sentence's cue).
 */
export function splitSentences(_text: string): string[] {
  throw new Error('Phase 4: not implemented (E3)');
}

/**
 * 'target' (only target cues, or the segment contains a verified target), 'baseline' (only baseline cues), 'mixed'
 * (both), null (none).
 */
export function factKind(_excerpt: string, _verifiedTargets?: readonly string[]): DocumentFact['kind'] {
  throw new Error('Phase 4: not implemented (E3)');
}

/**
 * docs[].text must already be documentTextForAi(parsedText).text and docs[].fileName redacted. verifiedTargets =
 * target strings of aiAnalysis.targetsMentioned with verified === true (pointers only).
 */
export function extractDocumentFacts(_docs: ReadonlyArray<{ id: string; fileName: string; text: string; verifiedTargets?: readonly string[] }>): DocumentFact[] {
  throw new Error('Phase 4: not implemented (E3)');
}

/** Generation path: one fact per verified figure (excerpt = quote, fileName = source, kind kept, documentId ''). */
export function factsFromVerifiedFigures(_figures: readonly VerifiedFigure[]): DocumentFact[] {
  throw new Error('Phase 4: not implemented (E3)');
}
