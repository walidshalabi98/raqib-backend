import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { AI_ANALYSIS_MARKER, verifyDocumentFigures } from '../src/services/ai/frameworkNormalize';
import { redactPersonalData } from '../src/services/ai/redact';
import { extractDocumentFacts } from '../src/services/kpi/documentFacts';
import type { ResultNodePlan, VerifiedFigure } from '../src/services/ai/frameworkNormalize';
import { seedLibrary } from '../src/services/library/seed';
import { KpiContextError, buildProjectContext, contextFromGeneration, uniqueResultCodes } from '../src/services/kpi/context';
import type { KpiScope, ProjectContext } from '../src/services/kpi/types';
import {
  createKpiRunRow, createKpiSuggestionRow, createOrgFixture, hasTestDatabase, kpiValidatedSuggestionFixture, resetDatabase,
} from './helpers';
import type { OrgFixture } from './helpers';

/**
 * buildProjectContext and contextFromGeneration (spec §A3; design 1.3, 4.3, SDA-08, SDA-14). The phone numbers below are
 * fictitious test values in the formats the redactor removes; none may reach a context.
 */
const PHONE = '0599123456';
const PHONE_2 = '+970 59 912 3456';
const PLACEHOLDER = '[phone removed]';
const leaks = (value: unknown) => {
  const text = JSON.stringify(value);
  return text.includes(PHONE) || text.includes('599123456') || text.includes('912 3456');
};

describe('uniqueResultCodes', () => {
  it('codes that collide after codeKey get " (2)", " (3)" in chain order; ids and other fields are kept', () => {
    const out = uniqueResultCodes([
      { id: 'a', code: 'O1', text: 'first' }, { id: 'b', code: 'O 1', text: 'second' }, { id: 'c', code: 'o1', text: 'third' },
      { id: 'd', code: 'O2', text: 'fourth' },
    ]);
    expect(out).toEqual([
      { id: 'a', code: 'O1', text: 'first' }, { id: 'b', code: 'O 1 (2)', text: 'second' }, { id: 'c', code: 'o1 (3)', text: 'third' },
      { id: 'd', code: 'O2', text: 'fourth' },
    ]);
  });

  it('a suffixed code never collides with another code', () => {
    expect(uniqueResultCodes([{ code: 'O1' }, { code: 'O1 (2)' }, { code: 'O 1' }]).map(r => r.code)).toEqual(['O1', 'O1 (2)', 'O 1 (3)']);
  });

  it('returns copies', () => {
    const input = [{ code: 'O1' }];
    const [copy] = uniqueResultCodes(input);
    copy.code = 'X';
    expect(input[0].code).toBe('O1');
  });
});

describe('contextFromGeneration (framework generation path)', () => {
  const plan: ResultNodePlan[] = [
    { code: 'G', level: 'impact', text: 'Reduced water-borne disease', textAr: 'تقليل الأمراض', parentCode: null, sortOrder: 0 },
    { code: 'O1', level: 'outcome', text: `Households have safe water (call ${PHONE})`, textAr: null, parentCode: 'G', sortOrder: 0 },
    { code: 'O1.1', level: 'output', text: 'Water points rehabilitated', textAr: null, parentCode: 'O1', sortOrder: 0 },
    { code: 'A1.1.1', level: 'activity', text: 'Rehabilitate water points', textAr: null, parentCode: 'O1.1', sortOrder: 0 },
    { code: 'O 1', level: 'outcome', text: 'Second outcome', textAr: null, parentCode: 'G', sortOrder: 1 },
  ];
  const figures: VerifiedFigure[] = [{
    resultCode: 'O1.1', kind: 'target', value: '18', description: 'water points', source: `proposal ${PHONE}.pdf`,
    quote: 'The action will rehabilitate 18 community water points.',
  }];

  it('ids = codes, activities skipped, unique codes, facts from verified figures, documentTexts with redacted file names', () => {
    const ctx = contextFromGeneration({
      project: {
        id: 'p1', name: 'Water project', sectors: ['wash'], donor: 'DG ECHO', donorType: 'echo', startDate: '2026-11-01', endDate: '2027-10-31',
        geographicScope: `Khan Younis (${PHONE_2})`, targetBeneficiaries: 24000, humanitarian: true, description: null,
      },
      plan,
      verifiedFigures: figures,
      documents: [{ fileName: `proposal ${PHONE}.pdf`, text: 'The action will rehabilitate 18 community water points.' }],
      orgPreferences: { rejectedLibraryIds: ['AC-01'], preferredMethods: ['observation'] },
    });
    expect(ctx.resultsChain.map(r => [r.id, r.code, r.level, r.parentId])).toEqual([
      ['G', 'G', 'impact', null], ['O1', 'O1', 'outcome', 'G'], ['O 1', 'O 1 (2)', 'outcome', 'G'], ['O1.1', 'O1.1', 'output', 'O1'],
    ]);
    expect(ctx.resultsChain[1].text).toBe(`Households have safe water (call ${PLACEHOLDER})`);
    expect(ctx.scope).toEqual({ type: 'framework' });
    expect(ctx).toMatchObject({ existingIndicators: [], pendingSuggestions: [], alternativesFor: null });
    expect(ctx.documentFacts).toEqual([
      { documentId: '', fileName: `proposal ${PLACEHOLDER}.pdf`, excerpt: 'The action will rehabilitate 18 community water points.', kind: 'target',
        figures: [{ value: '18', kind: 'target', resultCode: 'O1.1' }] },
    ]);
    expect(ctx.documentTexts).toEqual([{ documentId: '', fileName: `proposal ${PLACEHOLDER}.pdf`, text: 'The action will rehabilitate 18 community water points.' }]);
    expect(ctx.donorRules).toMatchObject({ donorType: 'echo', maxIndicatorsPerResult: 3 });
    expect(ctx.orgPreferences).toEqual({ rejectedLibraryIds: ['AC-01'], preferredMethods: ['observation'] });
    expect(ctx.project.geographicScope).toBe(`Khan Younis (${PLACEHOLDER})`);
    expect(leaks(ctx)).toBe(false);
  });

  it('PD-1: a verified figure whose quote held personal data is no fact (as on the request path)', () => {
    // Fictitious name and number; the structure step quotes the redacted document text, so the quote verifies.
    const raw = `Contact coordinator Rasha Odeh on ${PHONE} to confirm the 1,200 households. The action will rehabilitate 18 community water points.`;
    const redacted = redactPersonalData(raw).text;
    const quote = 'Contact coordinator Rasha Odeh on [phone removed] to confirm the 1,200 households.';
    expect(redacted).toContain(quote);
    const verified = verifyDocumentFigures([
      { resultCode: 'O1.1', kind: 'target', value: '1,200', description: 'households', quote },
      { resultCode: 'O1.1', kind: 'target', value: '18', description: 'water points', quote: 'The action will rehabilitate 18 community water points.' },
    ], [{ fileName: 'proposal.pdf', text: redacted }]);
    expect(verified).toHaveLength(2);
    const ctx = contextFromGeneration({
      project: {
        id: 'p1', name: 'Water project', sectors: ['wash'], donor: 'DG ECHO', donorType: 'echo', startDate: '2026-11-01', endDate: '2027-10-31',
        geographicScope: null, targetBeneficiaries: null, humanitarian: false, description: null,
      },
      plan,
      verifiedFigures: verified,
      documents: [{ fileName: 'proposal.pdf', text: redacted }],
      orgPreferences: { rejectedLibraryIds: [], preferredMethods: [] },
    });
    expect(ctx.documentFacts.map(f => f.excerpt)).toEqual(['The action will rehabilitate 18 community water points.']);
    expect(JSON.stringify(ctx.documentFacts)).not.toContain('Rasha');
    expect(extractDocumentFacts([{ id: 'd', fileName: 'proposal.pdf', text: redacted }]).map(f => f.excerpt)).not.toContain(quote);
  });
});

describe.skipIf(!hasTestDatabase)('buildProjectContext (database)', () => {
  let a: OrgFixture;
  let b: OrgFixture;
  const NOW = new Date('2026-10-13T08:00:00Z');
  const ids: Record<string, string> = {};

  /** A database client that records which model methods were called, with their arguments. */
  function recordingDb(calls: Array<{ call: string; args: unknown }>): PrismaClient {
    return new Proxy(prisma, {
      get(target, prop, receiver) {
        const delegate = Reflect.get(target, prop, receiver);
        if (typeof prop !== 'string' || !['document', 'kpiSuggestion'].includes(prop)) return delegate;
        return new Proxy(delegate, {
          get(d, method) {
            const fn = Reflect.get(d, method);
            return typeof fn === 'function' ? (args: unknown) => {
              calls.push({ call: `${prop}.${String(method)}`, args });
              return fn.call(d, args);
            } : fn;
          },
        });
      },
    });
  }

  const build = (scope: KpiScope = { type: 'framework' }, over: Partial<{ organizationId: string; projectId: string; frameworkId: string }> = {}, options?: { withDocuments?: boolean }) =>
    buildProjectContext(prisma, {
      organizationId: a.org.id, projectId: a.project.id, frameworkId: a.framework.id, scope, now: NOW, ...over,
    }, options);

  beforeAll(async () => {
    await resetDatabase();
    await seedLibrary(prisma, { logger: { warn: () => undefined } });
    a = await createOrgFixture('ctx-a');
    b = await createOrgFixture('ctx-b');

    await prisma.project.update({
      where: { id: a.project.id },
      data: {
        name: `Water for Khan Younis ${PHONE}`, donor: `DG ECHO desk ${PHONE_2}`, donorType: 'echo', sector: 'wash', sectors: ['wash', 'health'],
        humanitarian: true, description: `Water trucking; field contact ${PHONE}.`, geographicScope: `Khan Younis, call ${PHONE}`, targetBeneficiaries: 24000,
      },
    });
    // Results: impact G (textAr with a phone number), O1 (fixture outcome), "O 1" (collides with O1), an output whose code
    // holds a phone number, and an activity (never in the context).
    const g = await prisma.resultNode.create({ data: { frameworkId: a.framework.id, level: 'impact', code: 'G', text: 'Reduced water-borne disease', textAr: `تقليل الأمراض ${PHONE}` } });
    await prisma.resultNode.update({ where: { id: a.result.id }, data: { parentId: g.id, text: 'Households have sufficient safe water', sortOrder: 0 } });
    const o1b = await prisma.resultNode.create({ data: { frameworkId: a.framework.id, level: 'outcome', code: 'O 1', text: 'Households practise hygiene', parentId: g.id, sortOrder: 1 } });
    const out = await prisma.resultNode.create({ data: { frameworkId: a.framework.id, level: 'output', code: `O1.1 ${PHONE}`, text: 'Water points rehabilitated', parentId: a.result.id } });
    const act = await prisma.resultNode.create({ data: { frameworkId: a.framework.id, level: 'activity', code: 'A1.1.1', text: 'Rehabilitate water points', parentId: out.id } });
    Object.assign(ids, { g: g.id, o1b: o1b.id, out: out.id, act: act.id });

    // Indicators: the fixture one on O1, one with a phone number in its Arabic name on the output.
    const weak = await prisma.indicator.create({
      data: {
        frameworkId: a.framework.id, resultId: out.id, indicatorText: 'Increase water points to 18', indicatorTextAr: `زيادة نقاط المياه ${PHONE}`,
        level: 'output', dataCollectionMethod: 'document_review', frequency: 'quarterly', phases: ['baseline'], unit: 'number', libraryId: 'WA-06',
        definition: `Water points checked by the engineer (${PHONE})`,
      },
    });
    ids.weak = weak.id;

    // Suggestions: the fixture pending one (O1); a pending one on the output with a phone number in its name; a rejected one
    // on O1 with a reject note (never loaded).
    const run = await createKpiRunRow({ projectId: a.project.id, frameworkId: a.framework.id, resultId: out.id });
    const outNode = { id: out.id, code: out.code, level: out.level };
    const pendingOut = await createKpiSuggestionRow({ run, suggestion: kpiValidatedSuggestionFixture(outNode, undefined, { name: `Water points functional ${PHONE}`, libraryId: 'WA-06', isCustom: false }) });
    const rejected = await createKpiSuggestionRow({
      run,
      suggestion: kpiValidatedSuggestionFixture(a.result, undefined, {
        libraryId: 'WA-02', isCustom: false, nameAr: `نسبة الأسر ${PHONE}`,
        warnings: [
          { code: 'target_in_name', severity: 'warning', message: 'Move the target out of the name.', params: {}, penalty: 15 },
          { code: 'sex_added', severity: 'info', message: 'Sex disaggregation added because the indicator counts people.', params: {}, penalty: 0 },
        ],
      }),
      status: 'rejected',
      decision: { rejectReason: 'not_relevant', rejectNote: `Ask Ahmad on ${PHONE}`, decidedAt: new Date('2026-09-01T00:00:00Z') },
    });
    Object.assign(ids, { pendingOut: pendingOut.id, rejected: rejected.id });

    // Documents: a completed one (phone in the file name and the text, an AI analysis after the marker), a qualitative
    // transcript (never used), a pending one (the fixture's) and one in organisation B.
    await prisma.document.create({
      data: {
        projectId: a.project.id, uploadedBy: a.officer.id, fileName: `baseline ${PHONE}.pdf`, fileUrl: 'x', fileType: 'proposal', parsingStatus: 'completed',
        parsedText: [
          'The 2025 baseline survey found 45% of households treat water; the target is 75% by 2027.',
          `For questions call the coordinator on ${PHONE} about the 18 water points.`,
          'The action will rehabilitate 18 community water points and distribute 4,000 hygiene kits.',
          'Distribution of 2,500 jerrycans in the camps.',
          AI_ANALYSIS_MARKER,
          'Summary: the target is 99% coverage.',
        ].join('\n'),
        aiAnalysis: { targetsMentioned: [{ indicator: 'jerrycans', target: '2,500 jerrycans', timeline: '', verified: true }, { indicator: 'x', target: '9,999', verified: false }] },
      },
    });
    await prisma.document.create({
      data: {
        projectId: a.project.id, uploadedBy: a.officer.id, fileName: 'fgd.docx', fileUrl: 'x', fileType: 'other', parsingStatus: 'completed',
        qualitativeSource: true, parsedText: 'Transcript: the target is 60% of women by the end of the year.',
      },
    });
    await prisma.document.create({
      data: {
        projectId: b.project.id, uploadedBy: b.officer.id, fileName: 'other-org.pdf', fileUrl: 'x', fileType: 'proposal', parsingStatus: 'completed',
        parsedText: 'The target is 70% of households by the end of the project.',
      },
    });
  });

  afterAll(async () => {
    await resetDatabase();
  });

  it('redacts a phone number in the description (and every other project text); sectors, dates and donor rules from the project', async () => {
    const ctx = await build();
    expect(ctx.project).toEqual({
      id: a.project.id, name: `Water for Khan Younis ${PLACEHOLDER}`, sectors: ['wash', 'health'], donor: `DG ECHO desk ${PLACEHOLDER}`, donorType: 'echo',
      startDate: '2026-01-01', endDate: '2027-12-31', geographicScope: `Khan Younis, call ${PLACEHOLDER}`, targetBeneficiaries: 24000,
      humanitarian: true, description: `Water trucking; field contact ${PLACEHOLDER}.`,
    });
    expect(ctx.donorRules).toMatchObject({ donorType: 'echo', maxIndicatorsPerResult: 3 });
    expect(ctx.scope).toEqual({ type: 'framework' });
    expect(ctx.alternativesFor).toBeNull();
  });

  it('results chain: activities are excluded; order is impact, outcome, output; codes O1 and "O 1" become O1 and "O 1 (2)" and map back to their own ids', async () => {
    const ctx = await build();
    expect(ctx.resultsChain.map(r => [r.id, r.code, r.level])).toEqual([
      [ids.g, 'G', 'impact'], [a.result.id, 'O1', 'outcome'], [ids.o1b, 'O 1 (2)', 'outcome'], [ids.out, `O1.1 ${PLACEHOLDER}`, 'output'],
    ]);
    expect(ctx.resultsChain.some(r => r.id === ids.act)).toBe(false);
    expect(ctx.resultsChain[0].textAr).toBe(`تقليل الأمراض ${PLACEHOLDER}`);
    expect(ctx.resultsChain[3].parentId).toBe(a.result.id);
  });

  it('lists the framework\'s indicators only (and its pending suggestions), redacted', async () => {
    const ctx = await build();
    expect(ctx.existingIndicators.map(i => i.id).sort()).toEqual([a.indicator.id, ids.weak].sort());
    expect(ctx.existingIndicators.find(i => i.id === ids.weak)).toEqual({
      id: ids.weak, resultId: ids.out, name: 'Increase water points to 18', nameAr: `زيادة نقاط المياه ${PLACEHOLDER}`, level: 'output', unit: 'number',
      libraryId: 'WA-06', method: 'document_review',
    });
    expect(ctx.pendingSuggestions.map(s => s.id).sort()).toEqual([a.kpiSuggestion.id, ids.pendingOut].sort());
    expect(ctx.pendingSuggestions.find(s => s.id === ids.pendingOut)).toEqual({ id: ids.pendingOut, resultId: ids.out, libraryId: 'WA-06', name: `Water points functional ${PLACEHOLDER}` });
  });

  it('documentFacts come from completed, non-qualitative documents of the project, with kinds; documentTexts hold their redacted text', async () => {
    const ctx = await build();
    const byExcerpt = new Map(ctx.documentFacts.map(f => [f.excerpt, f]));
    expect(byExcerpt.get('The 2025 baseline survey found 45% of households treat water; the target is 75% by 2027.')?.kind).toBe('mixed');
    expect(byExcerpt.get('The action will rehabilitate 18 community water points and distribute 4,000 hygiene kits.')?.kind).toBe('target');
    // The verified target of the AI analysis marks its own sentence (pointer only).
    expect(byExcerpt.get('Distribution of 2,500 jerrycans in the camps.')?.kind).toBe('target');
    expect(ctx.documentFacts).toHaveLength(3); // the line with the phone number is dropped, nothing after the marker
    for (const fact of ctx.documentFacts) expect(fact.fileName).toBe(`baseline ${PLACEHOLDER}.pdf`);
    expect(ctx.documentFacts.some(f => /99%|60%|70%/.test(f.excerpt))).toBe(false); // AI analysis, transcript, other organisation
    expect(ctx.documentTexts).toHaveLength(1);
    expect(ctx.documentTexts[0].documentId).toBe(ctx.documentFacts[0].documentId);
    expect(ctx.documentTexts[0].fileName).toBe(`baseline ${PLACEHOLDER}.pdf`);
    expect(ctx.documentTexts[0].text).toContain(`call the coordinator on ${PLACEHOLDER}`);
    expect(ctx.documentTexts[0].text).not.toContain(AI_ANALYSIS_MARKER);
    for (const fact of ctx.documentFacts) expect(ctx.documentTexts[0].text.includes(fact.excerpt)).toBe(true);
  });

  it('a phone number in a file name, a result code, a result textAr or an indicator\'s Arabic name never reaches the context', async () => {
    for (const scope of [
      { type: 'framework' } as const,
      { type: 'alternatives', indicatorId: ids.weak, suggestionId: null } as const,
      { type: 'alternatives', indicatorId: null, suggestionId: ids.rejected } as const,
    ]) {
      const ctx = await build(scope);
      expect(leaks(ctx)).toBe(false);
      expect(JSON.stringify(ctx)).toContain(PLACEHOLDER);
    }
  });

  it('withDocuments false (request preview): no document is loaded and facts and texts are empty', async () => {
    const calls: Array<{ call: string; args: unknown }> = [];
    const ctx = await buildProjectContext(recordingDb(calls), {
      organizationId: a.org.id, projectId: a.project.id, frameworkId: a.framework.id, scope: { type: 'framework' }, now: NOW,
    }, { withDocuments: false });
    expect(ctx.documentFacts).toEqual([]);
    expect(ctx.documentTexts).toEqual([]);
    expect(calls.filter(c => c.call.startsWith('document.'))).toEqual([]);
    expect(ctx.resultsChain).toHaveLength(4);
  });

  it('alternatives context carries the source and its problems, and lists pending suggestions of the source result', async () => {
    const ctx = await build({ type: 'alternatives', indicatorId: ids.weak, suggestionId: null });
    expect(ctx.alternativesFor).toEqual({
      kind: 'indicator', id: ids.weak, resultId: ids.out, name: 'Increase water points to 18', nameAr: `زيادة نقاط المياه ${PLACEHOLDER}`,
      definition: `Water points checked by the engineer (${PLACEHOLDER})`, unit: 'number', method: 'document_review', libraryId: 'WA-06',
      reason: 'weak', rejectReason: null, problems: ['Move the target out of the name.'],
    });
    expect(ctx.pendingSuggestions.filter(s => s.resultId === ids.out).map(s => s.id)).toEqual([ids.pendingOut]);
  });

  it('alternatives of a rejected suggestion: reason rejected with its reject reason and warning problems; the reject note is never loaded', async () => {
    const calls: Array<{ call: string; args: unknown }> = [];
    const ctx = await buildProjectContext(recordingDb(calls), {
      organizationId: a.org.id, projectId: a.project.id, frameworkId: a.framework.id,
      scope: { type: 'alternatives', indicatorId: null, suggestionId: ids.rejected }, now: NOW,
    });
    expect(ctx.alternativesFor).toMatchObject({
      kind: 'suggestion', id: ids.rejected, resultId: a.result.id, nameAr: `نسبة الأسر ${PLACEHOLDER}`, unit: 'percent', method: 'observation',
      libraryId: 'WA-02', reason: 'rejected', rejectReason: 'not_relevant', problems: ['Move the target out of the name.'],
    });
    expect(JSON.stringify(ctx)).not.toContain('Ahmad');
    const suggestionReads = calls.filter(c => c.call.startsWith('kpiSuggestion.'));
    expect(suggestionReads.length).toBeGreaterThan(0);
    for (const read of suggestionReads) {
      const select = (read.args as { select?: Record<string, unknown> }).select;
      expect(select).toBeDefined();
      expect(select).not.toHaveProperty('rejectNote');
    }
    // The organisation's not_relevant rejection of WA-02 is an exclusion (orgPreferences).
    expect(ctx.orgPreferences.rejectedLibraryIds).toEqual(['WA-02']);
  });

  it('result scope: the scoped result must be a non-activity result of the framework', async () => {
    const ctx = await build({ type: 'result', resultId: a.result.id });
    expect(ctx.scope).toEqual({ type: 'result', resultId: a.result.id });
    await expect(build({ type: 'result', resultId: ids.act })).rejects.toMatchObject({ code: 'not_found' });
    await expect(build({ type: 'result', resultId: b.result.id })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('alternatives sources outside the framework or without a result are not found', async () => {
    await expect(build({ type: 'alternatives', indicatorId: b.indicator.id, suggestionId: null })).rejects.toMatchObject({ code: 'not_found' });
    await expect(build({ type: 'alternatives', indicatorId: null, suggestionId: b.kpiSuggestion.id })).rejects.toMatchObject({ code: 'not_found' });
    const unlinked = await prisma.indicator.create({
      data: { frameworkId: a.framework.id, indicatorText: 'No result', level: 'output', dataCollectionMethod: 'document_review', frequency: 'quarterly', phases: [] },
    });
    try {
      await expect(build({ type: 'alternatives', indicatorId: unlinked.id, suggestionId: null })).rejects.toBeInstanceOf(KpiContextError);
    } finally {
      await prisma.indicator.delete({ where: { id: unlinked.id } });
    }
  });

  it('scoped to the organisation: another organisation\'s id or project is not found; an old framework version is stale', async () => {
    await expect(build({ type: 'framework' }, { organizationId: b.org.id })).rejects.toMatchObject({ code: 'not_found' });
    await expect(build({ type: 'framework' }, { frameworkId: b.framework.id })).rejects.toMatchObject({ code: 'not_found' });
    const v2 = await prisma.framework.create({ data: { projectId: a.project.id, version: 2 } });
    try {
      const error = await build().catch((err: unknown) => err);
      expect(error).toBeInstanceOf(KpiContextError);
      expect(error).toMatchObject({ code: 'stale' });
      // A failed newer version does not make the older one stale.
      await prisma.framework.update({ where: { id: v2.id }, data: { generationError: 'The AI model declined the request.' } });
      await expect(build()).resolves.toBeDefined();
    } finally {
      await prisma.framework.delete({ where: { id: v2.id } });
    }
  });

  it('organisation B\'s context never holds organisation A\'s data', async () => {
    const ctx: ProjectContext = await buildProjectContext(prisma, {
      organizationId: b.org.id, projectId: b.project.id, frameworkId: b.framework.id, scope: { type: 'framework' }, now: NOW,
    });
    expect(ctx.existingIndicators.map(i => i.id)).toEqual([b.indicator.id]);
    expect(ctx.pendingSuggestions.map(s => s.id)).toEqual([b.kpiSuggestion.id]);
    expect(ctx.orgPreferences.rejectedLibraryIds).toEqual([]);
    expect(ctx.documentFacts.map(f => f.excerpt)).toEqual(['The target is 70% of households by the end of the project.']);
  });
});
