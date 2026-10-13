/**
 * retrieveCandidates: library candidates per result (knowledge/kpi-assistant-spec.md §A4 step 1; design sections
 * 1.4 and 4.3, D4): hard filter (sectors + 'other' + required-framework entries, minus exclusions), then vector
 * ranking with stored pgvector vectors read as text (cosine in TypeScript), or keyword ranking as the fallback.
 * Pure apart from the injected LibrarySource and EmbeddingProvider: no prisma, no env.
 *
 * Step 0 stub (Phase 4 contracts): constants, types and signatures are final; E3 implements the bodies.
 */
import type { ContextResult, KpiLibraryEntry, KpiPipelineDeps, KpiWarning, ProjectContext } from './types';

export const CANDIDATES_PER_RESULT = 8;
export const MAX_CANDIDATES_PER_CALL = 40;

export interface RankedCandidate { entry: KpiLibraryEntry; score: number }

export interface RetrievalResult {
  method: 'vector' | 'keyword';
  /** Key ContextResult.id, ≤ 8, best first. */
  byResult: Map<string, RankedCandidate[]>;
  /** AC-01..AC-05 when humanitarian (not excluded). */
  accountability: KpiLibraryEntry[];
  /** Whole library (for validation). */
  library: Map<string, KpiLibraryEntry>;
  /** keyword_fallback (info) when embeddings were not used although enabled. */
  warnings: KpiWarning[];
}

/**
 * Sectors: librarySectorsFor(project sectors) (includes 'other'); plus entries whose standardFramework is in
 * donorRules.libraryFrameworks; plus accountability entries when humanitarian; minus exclusions.
 */
export function hardFilterLibrary(_entries: readonly KpiLibraryEntry[], _ctx: ProjectContext, _exclude: ReadonlySet<string>): KpiLibraryEntry[] {
  throw new Error('Phase 4: not implemented (E3)');
}

/** normaliseSearchText, split, EN+AR stopwords removed, tokens ≥ 3 chars. */
export function keywordTokens(_text: string): string[] {
  throw new Error('Phase 4: not implemented (E3)');
}

/**
 * Weighted overlap in [0,1]: for each query token, 2 if it matches a name token (EN or AR), 1.5 a tag word (tags split
 * on _), 1 a definition token; match = equal, or one is a prefix of the other and both are ≥ 5 chars; score = Σ / (2 × tokens).
 */
export function keywordScore(_queryTokens: readonly string[], _entry: KpiLibraryEntry): number {
  throw new Error('Phase 4: not implemented (E3)');
}

export function cosine(_a: readonly number[], _b: readonly number[]): number {
  throw new Error('Phase 4: not implemented (E3)');
}

/**
 * score = similarity + 0.10 if entry.level === result.level + 0.05 if standardFramework ∈ libraryFrameworks
 * + 0.03 if entry.sector === project primary sector; ties by id.
 */
export function rankForResult(_result: ContextResult, _pool: readonly KpiLibraryEntry[], _ctx: ProjectContext,
  _similarity: (entry: KpiLibraryEntry) => number): RankedCandidate[] {
  throw new Error('Phase 4: not implemented (E3)');
}

/**
 * Vector method only when the provider is enabled, embed(redactedTexts, 'query') returns vectors, and every
 * hard-filtered entry has a stored vector for provider.model; otherwise keyword for the whole run.
 */
export async function retrieveCandidates(_ctx: ProjectContext, _deps: Pick<KpiPipelineDeps, 'library' | 'embeddings'>): Promise<RetrievalResult> {
  throw new Error('Phase 4: not implemented (E3)');
}
