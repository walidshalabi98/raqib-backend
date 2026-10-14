/**
 * retrieveCandidates: library candidates per result (knowledge/kpi-assistant-spec.md §A4 step 1; design sections
 * 1.4 and 4.3, D4, SDA-17): hard filter (sectors + 'other' + required-framework entries, minus exclusions), then vector
 * ranking with stored pgvector vectors read as text (cosine in TypeScript), or keyword ranking as the fallback (no
 * Voyage key, embed returns null or fails, or the library is not embedded for the provider's model). Only redacted
 * result statements are embedded (CLAUDE.md rule 5). Logs hold counts and error class names only.
 * Pure apart from the injected LibrarySource and EmbeddingProvider: no prisma, no env (tests/kpiPurity.test.ts).
 */
import type { Sector } from '@prisma/client';
import { librarySectorsFor } from '../ai/frameworkNormalize';
import { redactPersonalData } from '../ai/redact';
import { normaliseSearchText } from '../library/query';
import { isAccountabilityEntry } from './accountability';
import { exclusionsFor, scopedResults } from './scope';
import { warning } from './validate';
import type { ContextResult, KpiLibraryEntry, KpiPipelineDeps, KpiWarning, ProjectContext } from './types';

/** Top candidates per result (spec §A4 step 1 "top 8"). */
export const CANDIDATES_PER_RESULT = 8;
/** At most this many candidates in one model call (union of a batch's results + accountability entries; E4 applies it). */
export const MAX_CANDIDATES_PER_CALL = 40;

/** Ranking boosts of rankForResult (design 4.3). */
export const RANK_BOOSTS = { level: 0.10, donorFramework: 0.05, primarySector: 0.03 } as const;

/** A library entry with its ranking score (similarity + boosts, rankForResult). */
export interface RankedCandidate { entry: KpiLibraryEntry; score: number }

/** What retrieveCandidates hands to the model step and validation (spec §A4 step 1; design 4.3). */
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
  /** embed() requests made for the query texts (0 or 1); counts in KpiPipelineResult.embeddingCalls. */
  embeddingCalls?: number;
}

// ------------------------------------------------------------------ hard filter

/**
 * Sectors: librarySectorsFor(project sectors) (includes 'other'); plus entries whose standardFramework is in
 * donorRules.libraryFrameworks; plus accountability entries when humanitarian; minus exclusions (upper-case ids).
 * Spec §A4 step 1 "filter by sectors + 'other' + required-framework entries; exclude rejected ids".
 */
export function hardFilterLibrary(entries: readonly KpiLibraryEntry[], ctx: ProjectContext, exclude: ReadonlySet<string>): KpiLibraryEntry[] {
  const sectors = new Set<Sector>(librarySectorsFor(ctx.project.sectors));
  const frameworks = new Set(ctx.donorRules.libraryFrameworks);
  return entries.filter(entry => {
    if (exclude.has(entry.id.trim().toUpperCase())) return false;
    return sectors.has(entry.sector)
      || (entry.standardFramework !== null && frameworks.has(entry.standardFramework))
      || (ctx.project.humanitarian && isAccountabilityEntry(entry));
  });
}

// ------------------------------------------------------------------ keyword ranking

/** Words that carry no meaning for matching a result statement to an indicator (EN and AR, normalised like the text). */
const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those', 'have', 'has', 'had', 'are', 'was', 'were', 'been',
  'being', 'into', 'onto', 'their', 'they', 'them', 'its', 'our', 'your', 'who', 'whom', 'whose', 'which', 'what', 'when',
  'where', 'while', 'will', 'shall', 'would', 'can', 'could', 'may', 'might', 'must', 'should', 'all', 'any', 'each',
  'every', 'per', 'via', 'than', 'then', 'there', 'such', 'also', 'not', 'nor', 'but', 'about', 'more', 'most', 'other',
  'others', 'over', 'under', 'upon', 'within', 'without', 'through', 'between', 'among', 'across', 'after', 'before',
  'during', 'only', 'own', 'same', 'both', 'very', 'out', 'off', 'including', 'least', 'well', 'able', 'one', 'two',
  'project', 'projects', 'programme', 'program', 'target', 'targeted', 'targets',
  'في', 'من', 'الى', 'على', 'عن', 'مع', 'التي', 'الذي', 'الذين', 'اللذين', 'اللواتي', 'هذا', 'هذه', 'ذلك', 'تلك', 'هولاء', 'او',
  'ثم', 'كل', 'بين', 'حتي', 'عند', 'بعد', 'قبل', 'خلال', 'ضمن', 'لدي', 'عبر', 'حول', 'دون', 'غير', 'كما', 'ان', 'انه', 'لها',
  'لهم', 'بها', 'فيها', 'منها', 'عليها', 'المشروع', 'المستهدفه', 'المستهدفين',
].map(normaliseSearchText));

/** Tokens of ≥ 3 characters, letters or digits, not only digits. */
const MIN_TOKEN = 3;

/** normaliseSearchText, split, EN+AR stopwords removed, tokens ≥ 3 chars (pure numbers dropped), each token once. */
export function keywordTokens(text: string): string[] {
  const tokens = normaliseSearchText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length >= MIN_TOKEN && !/^\p{N}+$/u.test(t) && !STOPWORDS.has(t));
  return Array.from(new Set(tokens));
}

/** Equal, or one is a prefix of the other and both have ≥ 5 characters ("household"/"households", "water"/"waters"). */
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  return a.length >= 5 && b.length >= 5 && (a.startsWith(b) || b.startsWith(a));
}

interface EntryTokens { name: string[]; tags: string[]; definition: string[] }

const entryTokenCache = new WeakMap<KpiLibraryEntry, EntryTokens>();

function entryTokens(entry: KpiLibraryEntry): EntryTokens {
  let cached = entryTokenCache.get(entry);
  if (!cached) {
    cached = {
      name: keywordTokens(`${entry.name} ${entry.nameAr}`),
      tags: Array.from(new Set(entry.tags.flatMap(t => normaliseSearchText(t).split(/[_\s]+/)).filter(Boolean))),
      definition: keywordTokens(entry.definition),
    };
    entryTokenCache.set(entry, cached);
  }
  return cached;
}

/**
 * Weighted overlap in [0,1]: for each query token, 2 if it matches a name token (EN or AR), 1.5 a tag word (tags split
 * on _), 1 a definition token; match = equal, or one is a prefix of the other and both are ≥ 5 chars; score = Σ / (2 × tokens).
 * Spec §A4 step 1 keyword fallback (no embeddings).
 */
export function keywordScore(queryTokens: readonly string[], entry: KpiLibraryEntry): number {
  if (queryTokens.length === 0) return 0;
  const tokens = entryTokens(entry);
  let sum = 0;
  for (const q of queryTokens) {
    if (tokens.name.some(t => tokensMatch(q, t))) sum += 2;
    else if (tokens.tags.some(t => tokensMatch(q, t))) sum += 1.5;
    else if (tokens.definition.some(t => tokensMatch(q, t))) sum += 1;
  }
  return sum / (2 * queryTokens.length);
}

// ------------------------------------------------------------------ vector ranking

/** Cosine similarity; 0 when the vectors differ in length, are empty or one has no length (design D4: computed in code). */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  const value = dot / Math.sqrt(normA * normB);
  return Number.isFinite(value) ? value : 0;
}

/**
 * score = similarity + 0.10 if entry.level === result.level + 0.05 if standardFramework ∈ libraryFrameworks
 * + 0.03 if entry.sector === project primary sector; ties by id. Every pool entry, best first (spec §A4 step 1
 * "semantic ranking"; design 4.3).
 */
export function rankForResult(result: ContextResult, pool: readonly KpiLibraryEntry[], ctx: ProjectContext,
  similarity: (entry: KpiLibraryEntry) => number): RankedCandidate[] {
  const frameworks = new Set(ctx.donorRules.libraryFrameworks);
  const primary = ctx.project.sectors[0];
  return pool
    .map(entry => ({
      entry,
      score: similarity(entry)
        + (entry.level === result.level ? RANK_BOOSTS.level : 0)
        + (entry.standardFramework !== null && frameworks.has(entry.standardFramework) ? RANK_BOOSTS.donorFramework : 0)
        + (entry.sector === primary ? RANK_BOOSTS.primarySector : 0),
    }))
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id, 'en', { numeric: true }));
}

/** The text embedded or matched for a result: its English statement, redacted (code as a last resort). */
function queryText(result: ContextResult): string {
  const text = redactPersonalData(result.text ?? '').text.trim();
  return text || redactPersonalData(result.code).text.trim() || '-';
}

const errorClass = (err: unknown) => (err instanceof Error ? err.name || 'Error' : typeof err);

type FallbackReason = 'library_not_embedded' | 'no_vectors' | 'embedding_failed';

/**
 * Library candidates for every scoped result (spec §A4 step 1; design 4.3):
 * - pool = hardFilterLibrary(all entries, ctx, exclusionsFor(ctx) + the library ids of every existing indicator of the
 *   framework, which rule 18 would drop as near-duplicates);
 * - accountability = the pool's AC-01…AC-05 for humanitarian projects (framework and result scope; alternatives replace
 *   one indicator, so none), offered with every batch and therefore not ranked again per result;
 * - vector method only when the provider is enabled, every ranked pool entry has a stored vector for provider.model
 *   (checked first, so an unembedded library costs no Voyage call), and embed(redacted result texts, 'query') returns
 *   one vector per result; otherwise keyword for the whole run, with a keyword_fallback info warning when the provider
 *   was enabled. Embedding failures never fail the run;
 * - byResult = rankForResult(...) top CANDIDATES_PER_RESULT per result.
 */
export async function retrieveCandidates(ctx: ProjectContext, deps: Pick<KpiPipelineDeps, 'library' | 'embeddings'>): Promise<RetrievalResult> {
  const entries = await deps.library.allEntries();
  const library = new Map(entries.map(e => [e.id, e]));
  // Besides exclusionsFor: a library id an existing indicator of the framework already uses would only be dropped as a
  // near-duplicate by rule 18 (one library indicator measures one result, D12), so it is not offered in any scope.
  const exclude = exclusionsFor(ctx);
  for (const indicator of ctx.existingIndicators) {
    if (indicator.libraryId?.trim()) exclude.add(indicator.libraryId.trim().toUpperCase());
  }
  const pool = hardFilterLibrary(entries, ctx, exclude);
  const offersAccountability = ctx.project.humanitarian && ctx.scope.type !== 'alternatives';
  const accountability = offersAccountability
    ? pool.filter(isAccountabilityEntry).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
    : [];
  const ranked = offersAccountability ? pool.filter(e => !isAccountabilityEntry(e)) : pool;
  const results = scopedResults(ctx);

  const base = { accountability, library };
  if (results.length === 0) return { ...base, method: 'keyword', byResult: new Map(), warnings: [], embeddingCalls: 0 };

  const provider = deps.embeddings;
  let embeddingCalls = 0;
  let fallback: FallbackReason | null = null;
  let queryVectors: number[][] | null = null;
  let entryVectors = new Map<string, number[]>();

  // Nothing to rank (every entry excluded): no embedding call and no fallback note.
  const wantsVectors = provider.enabled && ranked.length > 0;
  if (wantsVectors && provider.model) {
    try {
      entryVectors = await deps.library.vectors(provider.model, ranked.map(e => e.id));
    } catch (err) {
      console.warn(`[KpiRetrieve] stored vectors unavailable (${errorClass(err)}), keyword fallback`);
      entryVectors = new Map();
    }
    if (ranked.some(e => !entryVectors.has(e.id))) {
      fallback = 'library_not_embedded';
    } else {
      try {
        embeddingCalls++;
        const vectors = await provider.embed(results.map(queryText), 'query');
        if (vectors && vectors.length === results.length) queryVectors = vectors;
        else fallback = 'no_vectors';
      } catch (err) {
        console.warn(`[KpiRetrieve] embedding failed (${errorClass(err)}), keyword fallback`);
        fallback = 'embedding_failed';
      }
    }
  }

  const byResult = new Map<string, RankedCandidate[]>();
  results.forEach((result, i) => {
    let similarity: (entry: KpiLibraryEntry) => number;
    if (queryVectors) {
      const query = queryVectors[i];
      similarity = entry => cosine(query, entryVectors.get(entry.id) ?? []);
    } else {
      const tokens = keywordTokens(queryText(result));
      similarity = entry => keywordScore(tokens, entry);
    }
    byResult.set(result.id, rankForResult(result, ranked, ctx, similarity).slice(0, CANDIDATES_PER_RESULT));
  });

  const method = queryVectors ? 'vector' : 'keyword';
  const warnings = method === 'keyword' && wantsVectors ? [warning('keyword_fallback', fallback ? { reason: fallback } : {})] : [];
  if (fallback && fallback !== 'embedding_failed') console.warn(`[KpiRetrieve] keyword fallback (${fallback}) for ${results.length} result(s)`);
  return { ...base, method, byResult, warnings, embeddingCalls };
}
