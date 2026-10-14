import fs from 'fs';
import path from 'path';
import { DonorType, Sector } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/config/prisma';
import { donorRulesFor } from '../src/services/ai/donorRules';
import { EmbeddingError, NoopEmbeddingProvider, toVectorLiteral } from '../src/services/ai/embeddingProviders';
import type { EmbeddingInputType, EmbeddingProvider } from '../src/services/ai/embeddingProviders';
import { libraryEmbeddingText } from '../src/services/library/embed';
import { loadLibraryFile } from '../src/services/library/load';
import { seedLibrary } from '../src/services/library/seed';
import { ACCOUNTABILITY_IDS } from '../src/services/kpi/accountability';
import {
  KPI_LIBRARY_SELECT, dbLibrarySource, embedLibraryInMemory, fileLibrarySource, parseVectorText,
} from '../src/services/kpi/librarySource';
import {
  CANDIDATES_PER_RESULT, RANK_BOOSTS, cosine, hardFilterLibrary, keywordScore, keywordTokens, rankForResult, retrieveCandidates,
} from '../src/services/kpi/retrieve';
import type { ContextResult, KpiLibraryEntry, KpiScope, LibrarySource, ProjectContext } from '../src/services/kpi/types';
import { hasTestDatabase, resetDatabase } from './helpers';

/**
 * Retrieval (spec §A4 step 1; design 1.4, 4.3, D4, SDA-17) and the library sources. Pure parts use the library file;
 * the database parts need TEST_DATABASE_URL. No real embedding provider is ever called: providers here are fakes.
 */

const LIBRARY = loadLibraryFile().entries;
const fileSource = fileLibrarySource();
let ENTRIES: KpiLibraryEntry[] = [];
const entry = (id: string) => ENTRIES.find(e => e.id === id)!;

beforeEach(async () => {
  ENTRIES = await fileSource.allEntries();
});

function makeContext(over: {
  sectors?: Sector[]; donorType?: DonorType; humanitarian?: boolean; results?: ContextResult[]; scope?: KpiScope;
  rejected?: string[]; existing?: ProjectContext['existingIndicators']; alternativesFor?: ProjectContext['alternativesFor'];
} = {}): ProjectContext {
  const donorType = over.donorType ?? 'other';
  return {
    project: {
      id: 'p1', name: 'Test project', sectors: over.sectors ?? ['wash'], donor: 'Donor', donorType,
      startDate: '2026-01-01', endDate: '2027-12-31', geographicScope: null, targetBeneficiaries: null,
      humanitarian: over.humanitarian ?? false, description: null,
    },
    resultsChain: over.results ?? [
      { id: 'r-o1', code: 'O1', level: 'outcome', text: 'Households have access to sufficient safe drinking water', textAr: null, parentId: null },
    ],
    scope: over.scope ?? { type: 'framework' },
    existingIndicators: over.existing ?? [],
    pendingSuggestions: [],
    documentFacts: [],
    documentTexts: [],
    orgPreferences: { rejectedLibraryIds: over.rejected ?? [], preferredMethods: [] },
    donorRules: donorRulesFor(donorType),
    alternativesFor: over.alternativesFor ?? null,
  };
}

/** An enabled fake provider: vectors come from `vectorFor(text)`; records every call. */
class FakeEmbeddings implements EmbeddingProvider {
  readonly name = 'fake';
  readonly dimensions = 3;
  readonly enabled = true;
  readonly calls: Array<{ texts: string[]; inputType: EmbeddingInputType }> = [];
  constructor(readonly model: string, private readonly vectorFor: (text: string) => number[] | null = () => [1, 0, 0]) {}
  async embed(texts: string[], inputType: EmbeddingInputType): Promise<number[][] | null> {
    this.calls.push({ texts, inputType });
    const vectors = texts.map(this.vectorFor);
    return vectors.some(v => v === null) ? null : vectors as number[][];
  }
}

/** A provider whose embed() is the given function (records calls). */
function providerWith(embed: EmbeddingProvider['embed'], model = 'fake-1'): EmbeddingProvider & { calls: number } {
  const provider = { name: 'fake', model, dimensions: 3, enabled: true, calls: 0, embed: async (t: string[], i: EmbeddingInputType) => {
    provider.calls += 1;
    return embed(t, i);
  } };
  return provider;
}

const unit = (angle: number) => [Math.cos(angle), Math.sin(angle), 0];

describe('hardFilterLibrary', () => {
  it('hard filter keeps sector, other and EU GERF entries for an EU project; drops rejected ids', () => {
    const ctx = makeContext({ sectors: ['livelihoods'], donorType: 'eu' });
    const ids = hardFilterLibrary(ENTRIES, ctx, new Set(['LV-03'])).map(e => e.id);
    expect(ids).toEqual(expect.arrayContaining(['LV-01', 'LV-02', 'AC-01', 'AC-06', 'EN-01']));
    // EU GERF entries of other sectors come in for an EU project (spec §A4 step 1 "+ required-framework entries").
    expect(ids).toEqual(expect.arrayContaining(['WA-04', 'HE-01', 'GV-01', 'FS-04']));
    expect(ids).not.toContain('WA-01'); // wash, Sphere: not a project sector, not a donor framework
    expect(ids).not.toContain('ED-02');
    expect(ids).not.toContain('LV-03'); // excluded
    // Every kept entry is explained by a rule.
    for (const e of hardFilterLibrary(ENTRIES, ctx, new Set())) {
      expect(['livelihoods', 'other'].includes(e.sector) || e.standardFramework === 'EU GERF').toBe(true);
    }
  });

  it('adds related library sectors (mhpss → protection) and the agency frameworks (UNICEF → SDG)', () => {
    const ids = hardFilterLibrary(ENTRIES, makeContext({ sectors: ['mhpss'], donorType: 'unicef' }), new Set()).map(e => e.id);
    expect(ids).toEqual(expect.arrayContaining(['PR-01', 'PR-06', 'ED-02']));
    expect(ids).not.toContain('WA-01');
  });

  it('exclusion matching ignores case', () => {
    const ids = hardFilterLibrary(ENTRIES, makeContext({ sectors: ['wash'] }), new Set(['WA-01'])).map(e => e.id);
    expect(ids).not.toContain('WA-01');
    expect(ids).toContain('WA-02');
  });
});

describe('keyword ranking', () => {
  it('keywordTokens: normalised, stopwords and short or numeric tokens removed, each token once', () => {
    expect(keywordTokens('The Households have access to SAFE water and safe water, 2026 & 15 l')).toEqual(['households', 'access', 'safe', 'water']);
    expect(keywordTokens('حصول الأسر على المياه الآمنة في المخيم')).toEqual(['حصول', 'الاسر', 'المياه', 'الامنه', 'المخيم']);
    expect(keywordTokens('')).toEqual([]);
  });

  it('keywordScore: 2 for a name token, 1.5 for a tag word, 1 for a definition token; prefixes need 5 characters', () => {
    const e: KpiLibraryEntry = { ...entry('WA-01'), name: 'Water volume per person', nameAr: 'كمية المياه', tags: ['water_quantity', 'sphere'], definition: 'Litres collected for drinking.' };
    expect(keywordScore(['water'], e)).toBe(1); // 2 / (2 × 1)
    expect(keywordScore(['quantity'], e)).toBe(0.75); // tag word
    expect(keywordScore(['drinking'], e)).toBe(0.5); // definition
    expect(keywordScore(['waters'], e)).toBe(1); // prefix, both ≥ 5
    expect(keywordScore(['per'], e)).toBe(0); // "per" is a stopword in the name, never a match
    expect(keywordScore(['vol'], e)).toBe(0); // prefix shorter than 5
    expect(keywordScore(['المياه'], e)).toBe(1); // Arabic name
    expect(keywordScore(['water', 'quantity', 'drinking', 'nothing'], e)).toBeCloseTo((2 + 1.5 + 1 + 0) / 8);
    expect(keywordScore([], e)).toBe(0);
  });

  it('cosine', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1, 1], [-1, -1])).toBeCloseTo(-1);
    expect(cosine([3, 4], [6, 8])).toBeCloseTo(1);
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
    expect(cosine([], [])).toBe(0);
    expect(cosine([0, 0], [1, 0])).toBe(0);
  });

  it('rankForResult adds the level, donor-framework and primary-sector boosts; ties by id', () => {
    const ctx = makeContext({ sectors: ['wash', 'health'], donorType: 'eu' });
    const result: ContextResult = { id: 'r', code: 'O1', level: 'outcome', text: 'x', textAr: null, parentId: null };
    const ranked = rankForResult(result, [entry('HE-01'), entry('WA-04'), entry('WA-02'), entry('WA-01'), entry('HE-02')], ctx, () => 0);
    const score = Object.fromEntries(ranked.map(r => [r.entry.id, r.score]));
    expect(score['WA-02']).toBeCloseTo(RANK_BOOSTS.level + RANK_BOOSTS.primarySector); // outcome, wash
    expect(score['WA-04']).toBeCloseTo(RANK_BOOSTS.donorFramework + RANK_BOOSTS.primarySector); // output, EU GERF, wash
    expect(score['HE-01']).toBeCloseTo(RANK_BOOSTS.donorFramework); // output, EU GERF, secondary sector
    expect(score['HE-02']).toBeCloseTo(RANK_BOOSTS.level); // outcome, secondary sector
    expect(ranked.map(r => r.entry.id)).toEqual(['WA-01', 'WA-02', 'HE-02', 'WA-04', 'HE-01']);
  });
});

// ------------------------------------------------------------------ eval expectations (knowledge/kpi-eval-cases.json)

interface EvalCaseJson {
  id: string;
  project: { name: string; sectors: Sector[]; donor: string; donorType: DonorType; startDate: string; endDate: string;
    geographicScope: string | null; targetBeneficiaries: number | null; humanitarian: boolean; description: string | null };
  resultsChain: Array<{ id: string; level: 'impact' | 'outcome' | 'output'; text: string; parentId: string | null }>;
  assertions: { mustIncludeLibraryIdForResult?: Record<string, string[]>; mustIncludeAnyLibraryIds?: string[]; hasAccountabilityIndicator?: boolean };
}

const EVAL_CASES: EvalCaseJson[] = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../knowledge/kpi-eval-cases.json'), 'utf8')).cases;

function evalContext(c: EvalCaseJson): ProjectContext {
  return {
    ...makeContext({ sectors: c.project.sectors, donorType: c.project.donorType, humanitarian: c.project.humanitarian }),
    project: { id: c.id, ...c.project },
    resultsChain: c.resultsChain.map(r => ({ id: r.id, code: r.id, level: r.level, text: r.text, textAr: null, parentId: r.parentId })),
  };
}

describe('retrieveCandidates meets the eval expectations with keywords only (no embeddings)', () => {
  it.each(EVAL_CASES.map(c => [c.id, c] as const))("every eval case's expected library ids appear in the top-8 keyword candidates of their result (%s)", async (_id, c) => {
    const retrieval = await retrieveCandidates(evalContext(c), { library: fileSource, embeddings: new NoopEmbeddingProvider() });
    expect(retrieval.method).toBe('keyword');
    expect(retrieval.warnings).toEqual([]); // the provider is disabled: no fallback note
    const idsOf = (resultId: string) => (retrieval.byResult.get(resultId) ?? []).map(r => r.entry.id);
    for (const [resultId, expected] of Object.entries(c.assertions.mustIncludeLibraryIdForResult ?? {})) {
      expect(idsOf(resultId)).toEqual(expect.arrayContaining(expected));
    }
    const everywhere = new Set(c.resultsChain.flatMap(r => idsOf(r.id)));
    for (const id of c.assertions.mustIncludeAnyLibraryIds ?? []) expect(everywhere.has(id)).toBe(true);
    if (c.assertions.hasAccountabilityIndicator) expect(retrieval.accountability.map(e => e.id)).toEqual([...ACCOUNTABILITY_IDS]);
    for (const list of retrieval.byResult.values()) expect(list.length).toBeLessThanOrEqual(CANDIDATES_PER_RESULT);
    expect(retrieval.byResult.size).toBe(c.resultsChain.length);
  });
});

describe('retrieveCandidates', () => {
  it('humanitarian project always gets AC-01..AC-05 (not AC-06, FS-06 or HE-04) in the candidates, not ranked again per result', async () => {
    const ctx = makeContext({ sectors: ['food_security', 'health'], humanitarian: true });
    const retrieval = await retrieveCandidates(ctx, { library: fileSource, embeddings: new NoopEmbeddingProvider() });
    expect(retrieval.accountability.map(e => e.id)).toEqual(['AC-01', 'AC-02', 'AC-03', 'AC-04', 'AC-05']);
    const ranked = [...retrieval.byResult.values()].flat().map(r => r.entry.id);
    for (const id of ACCOUNTABILITY_IDS) expect(ranked).not.toContain(id);
    // A non-humanitarian project gets none.
    const plain = await retrieveCandidates(makeContext({ sectors: ['wash'] }), { library: fileSource, embeddings: new NoopEmbeddingProvider() });
    expect(plain.accountability).toEqual([]);
  });

  it('a rejected accountability entry is not offered; the whole library is returned for validation', async () => {
    const ctx = makeContext({ humanitarian: true, rejected: ['AC-01'] });
    const retrieval = await retrieveCandidates(ctx, { library: fileSource, embeddings: new NoopEmbeddingProvider() });
    expect(retrieval.accountability.map(e => e.id)).toEqual(['AC-02', 'AC-03', 'AC-04', 'AC-05']);
    expect(retrieval.library.size).toBe(LIBRARY.length);
    expect(retrieval.library.get('AC-01')?.name).toBe(entry('AC-01').name);
  });

  it('drops org-rejected ids and the library ids of existing indicators', async () => {
    const ctx = makeContext({
      rejected: ['WA-02'],
      existing: [{ id: 'i1', resultId: 'r-o1', name: 'x', nameAr: null, level: 'outcome', unit: 'percent', libraryId: 'WA-01', method: 'hh_survey' }],
    });
    const retrieval = await retrieveCandidates(ctx, { library: fileSource, embeddings: new NoopEmbeddingProvider() });
    const ids = retrieval.byResult.get('r-o1')!.map(r => r.entry.id);
    expect(ids).not.toContain('WA-01');
    expect(ids).not.toContain('WA-02');
    expect(ids).toContain('WA-03');
  });

  it('result scope never offers a library id an existing indicator on another result already uses (rule 18 would drop it)', async () => {
    const results: ContextResult[] = [
      { id: 'r-o1', code: 'O1', level: 'outcome', text: 'Households have access to sufficient safe drinking water', textAr: null, parentId: null },
      { id: 'r-o2', code: 'O2', level: 'outcome', text: 'Households practise key hygiene behaviours', textAr: null, parentId: null },
    ];
    const ctx = makeContext({
      results, scope: { type: 'result', resultId: 'r-o1' }, humanitarian: true,
      existing: [
        { id: 'i1', resultId: 'r-o2', name: 'x', nameAr: null, level: 'outcome', unit: 'percent', libraryId: 'WA-02', method: 'hh_survey' },
        { id: 'i2', resultId: 'r-o2', name: 'y', nameAr: null, level: 'outcome', unit: 'percent', libraryId: 'ac-01', method: 'hh_survey' },
      ],
    });
    const retrieval = await retrieveCandidates(ctx, { library: fileSource, embeddings: new NoopEmbeddingProvider() });
    expect([...retrieval.byResult.keys()]).toEqual(['r-o1']);
    expect(retrieval.byResult.get('r-o1')!.map(r => r.entry.id)).not.toContain('WA-02');
    expect(retrieval.accountability.map(e => e.id)).toEqual(['AC-02', 'AC-03', 'AC-04', 'AC-05']);
  });

  it('alternatives: only the source result, the source library id excluded, no accountability list', async () => {
    const results: ContextResult[] = [
      { id: 'r-o1', code: 'O1', level: 'outcome', text: 'Households have access to sufficient safe drinking water', textAr: null, parentId: null },
      { id: 'r-o2', code: 'O2', level: 'outcome', text: 'Households practise key hygiene behaviours', textAr: null, parentId: null },
    ];
    const ctx = makeContext({
      humanitarian: true, results,
      scope: { type: 'alternatives', indicatorId: null, suggestionId: 's1' },
      alternativesFor: {
        kind: 'suggestion', id: 's1', resultId: 'r-o1', name: 'Water', nameAr: null, definition: null, unit: 'percent',
        method: 'hh_survey', libraryId: 'WA-02', reason: 'rejected', rejectReason: 'wording', problems: [],
      },
    });
    const retrieval = await retrieveCandidates(ctx, { library: fileSource, embeddings: new NoopEmbeddingProvider() });
    expect([...retrieval.byResult.keys()]).toEqual(['r-o1']);
    expect(retrieval.byResult.get('r-o1')!.map(r => r.entry.id)).not.toContain('WA-02');
    expect(retrieval.accountability).toEqual([]);
  });

  it('nothing in scope: no ranking and no embedding call', async () => {
    const provider = new FakeEmbeddings('fake-1');
    const ctx = makeContext({ scope: { type: 'result', resultId: 'missing' } });
    const retrieval = await retrieveCandidates(ctx, { library: fileLibrarySource({ vectors: new Map(), model: 'fake-1' }), embeddings: provider });
    expect(retrieval.byResult.size).toBe(0);
    expect(provider.calls).toHaveLength(0);
    expect(retrieval.embeddingCalls).toBe(0);
  });

  describe('vector method', () => {
    const results: ContextResult[] = [
      { id: 'r-o1', code: 'O1', level: 'outcome', text: 'Water reaches every household (call 0599123456)', textAr: null, parentId: null },
      { id: 'r-o11', code: 'O1.1', level: 'output', text: 'Water points rehabilitated', textAr: null, parentId: 'r-o1' },
    ];
    /** Every entry gets a vector; the 8 "nearest" entries for the query [1,0,0] are at a small angle, the others far away. */
    const NEAREST = ['WA-06', 'AC-06', 'EN-02', 'WA-03', 'DG-01', 'WA-05', 'EN-01', 'WA-04'];
    const vectorsFor = (ids: string[]) => new Map(ids.map(id => {
      const at = NEAREST.indexOf(id);
      return [id, at === -1 ? unit(1.2 + ids.indexOf(id) * 0.001) : unit(at * 0.02)] as const;
    }));

    it('vector ranking with fake vectors returns the nearest 8 per result (one query embed call with redacted texts)', async () => {
      const ids = ENTRIES.map(e => e.id);
      const provider = new FakeEmbeddings('fake-1');
      const library = fileLibrarySource({ vectors: vectorsFor(ids), model: 'fake-1' });
      const retrieval = await retrieveCandidates(makeContext({ results }), { library, embeddings: provider });
      expect(retrieval.method).toBe('vector');
      expect(retrieval.warnings).toEqual([]);
      expect(retrieval.embeddingCalls).toBe(1);
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0].inputType).toBe('query');
      expect(provider.calls[0].texts).toEqual(['Water reaches every household (call [phone removed])', 'Water points rehabilitated']);
      for (const r of results) {
        const top = retrieval.byResult.get(r.id)!;
        expect(top).toHaveLength(CANDIDATES_PER_RESULT);
        expect(top.map(c => c.entry.id).sort()).toEqual([...NEAREST].sort());
      }
    });

    it('falls back to keywords (info note) when embed returns null', async () => {
      const library = fileLibrarySource({ vectors: vectorsFor(ENTRIES.map(e => e.id)), model: 'fake-1' });
      const provider = new FakeEmbeddings('fake-1', () => null);
      const retrieval = await retrieveCandidates(makeContext({ results }), { library, embeddings: provider });
      expect(retrieval.method).toBe('keyword');
      expect(retrieval.embeddingCalls).toBe(1);
      expect(retrieval.warnings.map(w => [w.code, w.severity, w.penalty])).toEqual([['keyword_fallback', 'info', 0]]);
      expect(retrieval.byResult.get('r-o11')!.map(c => c.entry.id)[0]).toBe('WA-06');
    });

    it('falls back to keywords when embed throws an EmbeddingError, and logs the class name only', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const library = fileLibrarySource({ vectors: vectorsFor(ENTRIES.map(e => e.id)), model: 'fake-1' });
        const provider = providerWith(async () => { throw new EmbeddingError('Voyage embeddings request timed out after 8000 ms', null, true, 2); });
        const retrieval = await retrieveCandidates(makeContext({ results }), { library, embeddings: provider });
        expect(retrieval.method).toBe('keyword');
        expect(retrieval.warnings.map(w => w.code)).toEqual(['keyword_fallback']);
        expect(provider.calls).toBe(1);
        const logged = warn.mock.calls.map(args => args.join(' ')).join('\n');
        expect(logged).toContain('[KpiRetrieve] embedding failed (EmbeddingError), keyword fallback');
        expect(logged).not.toContain('Water');
        expect(logged).not.toContain('timed out');
      } finally {
        warn.mockRestore();
      }
    });

    it('falls back to keywords without any embed call when a ranked entry has no vector for the provider model', async () => {
      const ids = ENTRIES.map(e => e.id);
      const provider = new FakeEmbeddings('fake-1');
      const missingOne = vectorsFor(ids.filter(id => id !== 'WA-01'));
      const retrieval = await retrieveCandidates(makeContext({ results }), { library: fileLibrarySource({ vectors: missingOne, model: 'fake-1' }), embeddings: provider });
      expect(retrieval.method).toBe('keyword');
      expect(provider.calls).toHaveLength(0);
      expect(retrieval.embeddingCalls).toBe(0);
      expect(retrieval.warnings.map(w => [w.code, w.params])).toEqual([['keyword_fallback', { reason: 'library_not_embedded' }]]);
      // Vectors of another model never count.
      const otherModel = await retrieveCandidates(makeContext({ results }), { library: fileLibrarySource({ vectors: vectorsFor(ids), model: 'older-model' }), embeddings: provider });
      expect(otherModel.method).toBe('keyword');
      expect(provider.calls).toHaveLength(0);
    });

    it('falls back to keywords when the stored vectors cannot be read', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const library: LibrarySource = { allEntries: () => fileSource.allEntries(), vectors: async () => { throw new TypeError('connection lost'); } };
        const retrieval = await retrieveCandidates(makeContext({ results }), { library, embeddings: new FakeEmbeddings('fake-1') });
        expect(retrieval.method).toBe('keyword');
        expect(warn.mock.calls.map(a => a.join(' ')).join('\n')).toContain('stored vectors unavailable (TypeError)');
      } finally {
        warn.mockRestore();
      }
    });

    it('the no-op provider means keyword retrieval without a fallback note', async () => {
      const retrieval = await retrieveCandidates(makeContext({ results }), { library: fileSource, embeddings: new NoopEmbeddingProvider() });
      expect(retrieval).toMatchObject({ method: 'keyword', warnings: [], embeddingCalls: 0 });
    });
  });
});

describe('library sources', () => {
  it('parseVectorText reads the pgvector text form and rejects anything else', () => {
    expect(parseVectorText('[0.1,0.2,-3]')).toEqual([0.1, 0.2, -3]);
    expect(parseVectorText(' [1, 2e-3 ,3] ')).toEqual([1, 0.002, 3]);
    expect(parseVectorText('[]')).toBeNull();
    expect(parseVectorText('[1,,2]')).toBeNull();
    expect(parseVectorText('[1,a]')).toBeNull();
    expect(parseVectorText('1,2')).toBeNull();
    expect(parseVectorText('[NaN,1]')).toBeNull();
    expect(parseVectorText('[Infinity]')).toBeNull();
  });

  it('fileLibrarySource maps through toLibraryContent: standardFramework derived, empty notes null, JSON nulls plain', async () => {
    expect(ENTRIES).toHaveLength(LIBRARY.length);
    for (const file of LIBRARY) {
      const e = entry(file.id);
      expect(e.standardFramework).toBe(file.standardReference?.framework ?? null);
      expect(e.notes).toBe(file.notes.trim() === '' ? null : file.notes);
      expect(e.calculation).toEqual(file.calculation ?? null);
      expect(e.standardReference).toEqual(file.standardReference ?? null);
      expect(Object.keys(e).sort()).toEqual(Object.keys(KPI_LIBRARY_SELECT).sort());
    }
    // Callers get copies.
    const first = (await fileSource.allEntries())[0];
    first.name = 'changed';
    expect((await fileSource.allEntries())[0].name).not.toBe('changed');
  });

  it('fileLibrarySource vectors: the given vectors for the matching model and the requested ids only', async () => {
    const vectors = new Map([['WA-01', [1, 0]], ['WA-02', [0, 1]]]);
    const source = fileLibrarySource({ vectors, model: 'm1' });
    expect(await source.vectors('m1', ['WA-01', 'WA-03'])).toEqual(new Map([['WA-01', [1, 0]]]));
    expect((await source.vectors('m2', ['WA-01'])).size).toBe(0);
    expect((await fileLibrarySource({ vectors }).vectors('any', ['WA-02'])).size).toBe(1);
    expect((await fileSource.vectors('m1', ['WA-01'])).size).toBe(0);
  });

  it('embedLibraryInMemory embeds libraryEmbeddingText as documents; null for a disabled provider', async () => {
    const provider = new FakeEmbeddings('fake-1', text => [text.length, 1, 0]);
    const subset = ENTRIES.slice(0, 3);
    const vectors = await embedLibraryInMemory(subset, provider);
    expect(provider.calls).toEqual([{ texts: subset.map(libraryEmbeddingText), inputType: 'document' }]);
    expect([...vectors!.keys()]).toEqual(subset.map(e => e.id));
    expect(vectors!.get(subset[0].id)).toEqual([libraryEmbeddingText(subset[0]).length, 1, 0]);
    expect(await embedLibraryInMemory(subset, new NoopEmbeddingProvider())).toBeNull();
    await expect(embedLibraryInMemory(subset, providerWith(async () => { throw new EmbeddingError('failed'); }))).rejects.toBeInstanceOf(EmbeddingError);
  });
});

describe.skipIf(!hasTestDatabase)('dbLibrarySource (database)', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedLibrary(prisma, { logger: { warn: () => undefined } });
  });
  afterEach(async () => {
    await resetDatabase();
  });

  const storeVector = (id: string, vector: number[], model: string) => prisma.$executeRaw`
    UPDATE "IndicatorLibraryEntry" SET embedding = ${toVectorLiteral(vector)}::vector, "embeddingModel" = ${model} WHERE id = ${id}`;
  const dims = (k: number) => Array.from({ length: 1024 }, (_, i) => (i === k ? 1 : i === 1023 ? 0.5 : 0));

  it('the file source equals what seedLibrary stores (KPI_LIBRARY_SELECT fields), entry by entry', async () => {
    const fromDb = await dbLibrarySource(prisma).allEntries();
    expect(fromDb).toHaveLength(LIBRARY.length);
    const fromFile = new Map(ENTRIES.map(e => [e.id, e]));
    for (const row of fromDb) expect(row).toEqual(fromFile.get(row.id));
  });

  it('vectors() reads embedding::text for the given model and ids only', async () => {
    await storeVector('WA-01', dims(0), 'fake-embed-1');
    await storeVector('WA-02', dims(1), 'fake-embed-1');
    await storeVector('WA-03', dims(2), 'other-model');
    const vectors = await dbLibrarySource(prisma).vectors('fake-embed-1', ['WA-01', 'WA-03', 'WA-04']);
    expect([...vectors.keys()]).toEqual(['WA-01']);
    expect(vectors.get('WA-01')).toEqual(dims(0));
    expect((await dbLibrarySource(prisma).vectors('fake-embed-1', [])).size).toBe(0);
  });

  it('retrieveCandidates uses the stored vectors end to end when every pool entry is embedded', async () => {
    await prisma.$executeRaw`UPDATE "IndicatorLibraryEntry" SET embedding = array_fill(0.5, ARRAY[1024])::vector, "embeddingModel" = 'fake-embed-1'`;
    await storeVector('WA-06', dims(5), 'fake-embed-1');
    const provider = new FakeEmbeddings('fake-embed-1', () => dims(5));
    const ctx = makeContext({ results: [{ id: 'r', code: 'O1.1', level: 'output', text: 'Water points rehabilitated', textAr: null, parentId: null }] });
    const retrieval = await retrieveCandidates(ctx, { library: dbLibrarySource(prisma), embeddings: provider });
    expect(retrieval.method).toBe('vector');
    expect(retrieval.byResult.get('r')![0].entry.id).toBe('WA-06');
    // One entry without a vector: keyword fallback, no embed call.
    await prisma.$executeRaw`UPDATE "IndicatorLibraryEntry" SET embedding = NULL WHERE id = 'WA-01'`;
    const again = await retrieveCandidates(ctx, { library: dbLibrarySource(prisma), embeddings: provider });
    expect(again.method).toBe('keyword');
    expect(provider.calls).toHaveLength(1);
  });
});
