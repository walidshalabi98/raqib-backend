import type { IndicatorLevel } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The real pipeline (context, retrieval on the seeded library, the real client.ts with a fake SDK, validation and
// persistence), so a run that finishes after its project was archived is the real executor's behaviour.
vi.unmock('../src/services/kpi/pipeline');
vi.mock('../src/services/kpi/availability', async importOriginal => {
  const original = await importOriginal<typeof import('../src/services/kpi/availability')>();
  return { ...original, kpiAssistantStatus: vi.fn(() => ({ ...original.kpiAssistantStatus(), aiConfigured: true })) };
});
// A hook into a run's save transaction: findCurrentFramework called with a transaction client (not the shared Prisma
// client) is the save's framework re-check, right after it claimed its run row. Armed by one test, used once.
const { saveTransactionHook } = vi.hoisted(() => ({ saveTransactionHook: { current: null as null | (() => Promise<void>) } }));
vi.mock('../src/services/frameworks/current', async importOriginal => {
  const original = await importOriginal<typeof import('../src/services/frameworks/current')>();
  const { prisma: shared } = await import('../src/config/prisma');
  return {
    ...original,
    findCurrentFramework: async (...args: Parameters<typeof original.findCurrentFramework>) => {
      const hook = saveTransactionHook.current;
      if (hook && args[0] !== shared) {
        saveTransactionHook.current = null;
        await hook();
      }
      return original.findCurrentFramework(...args);
    },
  };
});

import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { PROJECT_ARCHIVED_MESSAGE } from '../src/middleware/access';
import { configureAiClientForTests, resetAiClientForTests } from '../src/services/ai/client';
import { seedLibrary } from '../src/services/library/seed';
import type { KpiModelAnswer } from '../src/services/kpi/types';
import { fakeSdk, libraryEntry, rawFromEntry, rawMessage, suggestForLines } from './aiFakes';
import {
  createKpiRunRow, createKpiSuggestionRow, createOrgFixture, hasTestDatabase, kpiValidatedSuggestionFixture, OrgFixture, resetDatabase,
  waitForLockWaiter,
} from './helpers';
import { KPI_ROUTES } from './roleMatrix';
import { routeLayers } from './routeStack';

/**
 * The KPI Assistant on archived and deleted projects (owner decision of 13 October 2026; docs/SECURITY_SETUP.md §5 and
 * §8.6 item 15, docs/DATA_MODEL.md §5): every KPI write answers 409 project_archived through the access choke point and
 * again under the project lock; reads stay open; a run that finishes after an archive stores pending suggestions only;
 * a permanent delete removes every KPI row of the project and nothing of another project.
 */

const ARCHIVED = { message: PROJECT_ARCHIVED_MESSAGE, code: 'project_archived' };

/** Every model call fails the test: none may happen on an archived project. */
function refusingSdk() {
  return fakeSdk(() => new Error('no model call is expected on an archived project'));
}

/** Answers from the prompt: up to two library candidates per SUGGEST FOR line, copied from the library. */
function answerFromPrompt(body: Record<string, any>): KpiModelAnswer {
  const lines = suggestForLines(body.messages[0].content as string);
  const suggestions = lines.flatMap(line => line.candidates.slice(0, 2)
    .map(id => rawFromEntry(libraryEntry(id), line.code, { level: line.level as 'impact' | 'outcome' | 'output' })));
  return { suggestions, frameworkWarnings: [] };
}

/** A WASH project of the organisation with one framework, two outcomes the library has indicators for, and no indicator. */
async function washProject(fx: OrgFixture, name: string) {
  const project = await prisma.project.create({
    data: {
      organizationId: fx.org.id, name, sector: 'wash', sectors: ['wash'], donor: 'EU', donorType: 'eu',
      startDate: new Date('2026-02-01'), endDate: new Date('2027-07-31'), status: 'active',
    },
  });
  const framework = await prisma.framework.create({ data: { projectId: project.id, version: 1 } });
  const o1 = await prisma.resultNode.create({
    data: { frameworkId: framework.id, level: 'outcome', code: 'O1', text: 'Displaced households have reliable access to safe drinking water', sortOrder: 1 },
  });
  const o2 = await prisma.resultNode.create({
    data: { frameworkId: framework.id, level: 'outcome', code: 'O2', text: 'Target households practise safe hygiene, including handwashing with soap', sortOrder: 2 },
  });
  return { project, framework, o1, o2 };
}

/** A project with a framework, outcome O1, an indicator on it and a completed run with one pending suggestion. */
async function projectWithSuggestion(fx: OrgFixture, name: string) {
  const project = await prisma.project.create({
    data: {
      organizationId: fx.org.id, name, sector: 'education', donor: 'EU', donorType: 'eu', status: 'active',
      startDate: new Date('2026-01-01'), endDate: new Date('2027-12-31'),
    },
  });
  const framework = await prisma.framework.create({ data: { projectId: project.id, version: 1 } });
  const result = await prisma.resultNode.create({ data: { frameworkId: framework.id, level: 'outcome', code: 'O1', text: `Outcome of ${name}` } });
  const indicator = await prisma.indicator.create({
    data: {
      frameworkId: framework.id, resultId: result.id, indicatorText: `Indicator of ${name}`, level: 'outcome',
      dataCollectionMethod: 'hh_survey', frequency: 'quarterly', phases: ['baseline', 'endline'],
    },
  });
  const run = await createKpiRunRow({ projectId: project.id, frameworkId: framework.id, resultId: result.id, requestedBy: fx.officer.id });
  const suggestion = await createKpiSuggestionRow({ run, suggestion: kpiValidatedSuggestionFixture(result, project) });
  return { project, framework, result, indicator, run, suggestion };
}

/** Every KPI row and indicator of a project, and the project row, to show that a refused write changed nothing. */
async function kpiSnapshot(projectId: string) {
  return {
    project: await prisma.project.findUniqueOrThrow({ where: { id: projectId } }),
    runs: await prisma.kpiSuggestionRun.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
    suggestions: await prisma.kpiSuggestion.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
    indicators: await prisma.indicator.findMany({ where: { framework: { projectId } }, orderBy: { id: 'asc' } }),
    aiCalls: await prisma.aiCall.count({ where: { projectId } }),
  };
}

describe.skipIf(!hasTestDatabase)('the KPI Assistant on archived and deleted projects', () => {
  let a: OrgFixture;
  let b: OrgFixture;

  beforeAll(async () => {
    await resetDatabase();
    await seedLibrary(prisma, { logger: { warn: () => undefined } });
    configureAiClientForTests({ sleep: async () => undefined });
    a = await createOrgFixture('ka');
    b = await createOrgFixture('kb');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    resetAiClientForTests();
  });

  describe('an archived project: every KPI write is refused, every read still works', () => {
    let p: Awaited<ReturnType<typeof projectWithSuggestion>>;
    let alternative: { id: string };
    let rejected: { id: string };

    beforeAll(async () => {
      p = await projectWithSuggestion(a, 'KPI archived: refusals');
      // An alternative of the indicator (accept with replaceSource) and a rejected card (alternatives by suggestionId).
      alternative = await createKpiSuggestionRow({
        run: p.run, suggestion: kpiValidatedSuggestionFixture(p.result, p.project, { name: 'Alternative wording', rank: 2 }),
        data: { alternativeOfIndicatorId: p.indicator.id },
      });
      rejected = await createKpiSuggestionRow({
        run: p.run, suggestion: kpiValidatedSuggestionFixture(p.result, p.project, { name: 'Rejected wording', rank: 3 }),
        status: 'rejected', decision: { decidedBy: a.officer.id, rejectReason: 'wording' },
      });
      const archived = await request(app).post(`/api/projects/${p.project.id}/archive`).set('Authorization', a.adminAuth);
      expect(archived.status).toBe(200);
    });

    it('answers 409 project_archived to every KPI write route (start a run in every scope, alternatives, accept, edit & accept, reject) and changes nothing', async () => {
      const sdk = refusingSdk();
      configureAiClientForTests({ anthropic: sdk.client });
      const id = p.project.id;
      const attempts: { route: string; send: () => request.Test }[] = [
        { route: 'post /api/projects/:id/kpi-suggestions', send: () => request(app).post(`/api/projects/${id}/kpi-suggestions`).send({ scope: 'framework' }) },
        { route: 'post /api/projects/:id/kpi-suggestions', send: () => request(app).post(`/api/projects/${id}/kpi-suggestions`).send({ scope: 'result', resultId: p.result.id }) },
        { route: 'post /api/projects/:id/kpi-suggestions', send: () => request(app).post(`/api/projects/${id}/kpi-suggestions`).send({ scope: 'alternatives', indicatorId: p.indicator.id }) },
        { route: 'post /api/projects/:id/kpi-suggestions', send: () => request(app).post(`/api/projects/${id}/kpi-suggestions`).send({ scope: 'alternatives', suggestionId: p.suggestion.id }) },
        { route: 'post /api/projects/:id/kpi-suggestions', send: () => request(app).post(`/api/projects/${id}/kpi-suggestions`).send({ scope: 'alternatives', suggestionId: rejected.id }) },
        // An invalid body is not even read: the archived rule comes first.
        { route: 'post /api/projects/:id/kpi-suggestions', send: () => request(app).post(`/api/projects/${id}/kpi-suggestions`).send({ scope: 'everything' }) },
        { route: 'post /api/indicators/:id/alternative', send: () => request(app).post(`/api/indicators/${p.indicator.id}/alternative`).send({}) },
        { route: 'post /api/kpi-suggestions/:id/accept', send: () => request(app).post(`/api/kpi-suggestions/${p.suggestion.id}/accept`).send({}) },
        { route: 'post /api/kpi-suggestions/:id/accept', send: () => request(app).post(`/api/kpi-suggestions/${p.suggestion.id}/accept`).send({ edits: { indicatorText: 'Edited while archived', targetValue: '60' } }) },
        { route: 'post /api/kpi-suggestions/:id/accept', send: () => request(app).post(`/api/kpi-suggestions/${alternative.id}/accept`).send({ replaceSource: true }) },
        { route: 'post /api/kpi-suggestions/:id/reject', send: () => request(app).post(`/api/kpi-suggestions/${p.suggestion.id}/reject`).send({ reason: 'not_relevant', note: 'Not now' }) },
        { route: 'post /api/kpi-suggestions/:id/reject', send: () => request(app).post(`/api/kpi-suggestions/${alternative.id}/reject`).send({ reason: 'wording' }) },
      ];
      // Guard: every KPI write route the app registers is attempted here (a new one fails until it is added).
      const registered = new Set(routeLayers(app).map(r => r.key));
      const kpiWrites = KPI_ROUTES.filter(key => !key.startsWith('get ') && registered.has(key)).sort();
      expect(kpiWrites).toHaveLength(KPI_ROUTES.filter(key => !key.startsWith('get ')).length);
      expect(Array.from(new Set(attempts.map(t => t.route))).sort()).toEqual(kpiWrites);

      const before = await kpiSnapshot(id);
      for (const auth of [a.officerAuth, a.adminAuth]) {
        for (const [i, attempt] of attempts.entries()) {
          const res = await attempt.send().set('Authorization', auth);
          expect(res.status, `${attempt.route} #${i + 1}`).toBe(409);
          expect(res.body, `${attempt.route} #${i + 1}`).toEqual(ARCHIVED);
        }
      }
      expect(await kpiSnapshot(id)).toEqual(before);
      expect(before.suggestions.find(s => s.id === p.suggestion.id)?.status).toBe('pending');
      expect(before.suggestions.find(s => s.id === alternative.id)?.status).toBe('pending');
      expect(sdk.sent).toHaveLength(0);
      // Donor viewers are still refused by role first, and another organisation still gets 404.
      expect((await request(app).post(`/api/kpi-suggestions/${p.suggestion.id}/accept`).set('Authorization', a.donorAuth).send({})).status).toBe(403);
      expect((await request(app).post(`/api/kpi-suggestions/${p.suggestion.id}/accept`).set('Authorization', b.adminAuth).send({})).status).toBe(404);
    });

    it('still serves every KPI read of the archived project to staff', async () => {
      const reads = [
        `/api/projects/${p.project.id}/kpi-suggestions`,
        `/api/projects/${p.project.id}/kpi-suggestions?status=all`,
        `/api/kpi-suggestion-runs/${p.run.id}`,
        `/api/frameworks/${p.framework.id}/indicator-quality`,
        '/api/kpi-assistant/status',
      ];
      // Guard: every KPI read route is listed.
      const getRoutes = KPI_ROUTES.filter(key => key.startsWith('get '));
      expect(getRoutes).toHaveLength(4);
      for (const auth of [a.officerAuth, a.adminAuth]) {
        for (const path of reads) {
          const res = await request(app).get(path).set('Authorization', auth);
          expect(res.status, path).toBe(200);
        }
        const list = await request(app).get(`/api/projects/${p.project.id}/kpi-suggestions`).set('Authorization', auth);
        expect(list.body.suggestions.map((s: { id: string }) => s.id).sort()).toEqual([p.suggestion.id, alternative.id].sort());
        expect(list.body.suggestions.every((s: { status: string }) => s.status === 'pending')).toBe(true);
        const all = await request(app).get(`/api/projects/${p.project.id}/kpi-suggestions?status=all`).set('Authorization', auth);
        expect(all.body.suggestions.map((s: { id: string }) => s.id)).toContain(rejected.id);
        const poll = await request(app).get(`/api/kpi-suggestion-runs/${p.run.id}`).set('Authorization', auth);
        expect(poll.body.run).toMatchObject({ id: p.run.id, status: 'completed' });
      }
    });

    it('accepts and rejects again once the project is restored', async () => {
      const restored = await request(app).post(`/api/projects/${p.project.id}/restore`).set('Authorization', a.adminAuth);
      expect(restored.status).toBe(200);
      expect(restored.body.status).toBe('active');
      const rejectedNow = await request(app).post(`/api/kpi-suggestions/${alternative.id}/reject`).set('Authorization', a.officerAuth).send({ reason: 'wording' });
      expect(rejectedNow.status).toBe(200);
      expect(rejectedNow.body.suggestion.status).toBe('rejected');
      const accepted = await request(app).post(`/api/kpi-suggestions/${p.suggestion.id}/accept`).set('Authorization', a.officerAuth).send({});
      expect(accepted.status).toBe(201);
      expect(accepted.body.suggestion).toMatchObject({ status: 'accepted', indicatorId: accepted.body.indicator.id });
      expect(accepted.body.indicator).toMatchObject({ provenance: 'ai_suggested', resultId: p.result.id });
    });
  });

  describe('a KPI write that passed its access check just before an archive committed', () => {
    /**
     * Archives the project (as the org admin, through the API) right after the first organisation-scoped lookup of
     * `model.findFirst` for `id` returns, i.e. after the route's access check and before its transaction.
     */
    function archiveAfterAccessCheck(model: 'kpiSuggestion' | 'project', id: string, projectId: string) {
      const delegate = prisma[model] as unknown as { findFirst: (args: unknown) => Promise<unknown> };
      const realFindFirst = delegate.findFirst.bind(delegate);
      const state: { held: boolean; archive?: request.Response } = { held: false };
      vi.spyOn(delegate, 'findFirst').mockImplementation((async (args: { where?: { id?: unknown } }) => {
        const found = await realFindFirst(args);
        if (!state.held && args?.where?.id === id) {
          state.held = true;
          state.archive = await request(app).post(`/api/projects/${projectId}/archive`).set('Authorization', a.adminAuth);
        }
        return found;
      }) as never);
      return state;
    }

    it('accept waits for the archive, then answers 409 project_archived: no indicator, the suggestion stays pending', async () => {
      const p = await projectWithSuggestion(a, 'KPI race: accept');
      const before = await kpiSnapshot(p.project.id);
      const race = archiveAfterAccessCheck('kpiSuggestion', p.suggestion.id, p.project.id);

      const res = await request(app).post(`/api/kpi-suggestions/${p.suggestion.id}/accept`).set('Authorization', a.officerAuth)
        .send({ edits: { indicatorText: 'Edited just before the archive' } });
      expect(race.archive?.status).toBe(200);
      expect(res.status).toBe(409);
      expect(res.body).toEqual(ARCHIVED);
      vi.restoreAllMocks();

      const after = await kpiSnapshot(p.project.id);
      expect(after.project.status).toBe('archived');
      expect(after.indicators).toEqual(before.indicators);
      expect(after.suggestions).toEqual(before.suggestions);
      expect(after.suggestions.find(s => s.id === p.suggestion.id)).toMatchObject({ status: 'pending', decidedAt: null, indicatorId: null });
    });

    it('reject waits for the archive, then answers 409 project_archived: the suggestion stays pending', async () => {
      const p = await projectWithSuggestion(a, 'KPI race: reject');
      const before = await kpiSnapshot(p.project.id);
      const race = archiveAfterAccessCheck('kpiSuggestion', p.suggestion.id, p.project.id);

      const res = await request(app).post(`/api/kpi-suggestions/${p.suggestion.id}/reject`).set('Authorization', a.officerAuth).send({ reason: 'not_relevant' });
      expect(race.archive?.status).toBe(200);
      expect(res.status).toBe(409);
      expect(res.body).toEqual(ARCHIVED);
      vi.restoreAllMocks();
      expect((await kpiSnapshot(p.project.id)).suggestions).toEqual(before.suggestions);
    });

    it('a suggestion run waits for the archive, then answers 409 project_archived: no run, no model call', async () => {
      const p = await projectWithSuggestion(a, 'KPI race: run');
      const sdk = refusingSdk();
      configureAiClientForTests({ anthropic: sdk.client });
      const before = await kpiSnapshot(p.project.id);
      const race = archiveAfterAccessCheck('project', p.project.id, p.project.id);

      const res = await request(app).post(`/api/projects/${p.project.id}/kpi-suggestions`).set('Authorization', a.officerAuth)
        .send({ scope: 'result', resultId: p.result.id });
      expect(race.archive?.status).toBe(200);
      expect(res.status).toBe(409);
      expect(res.body).toEqual(ARCHIVED);
      vi.restoreAllMocks();

      const after = await kpiSnapshot(p.project.id);
      expect(after.runs).toEqual(before.runs);
      expect(after.suggestions).toEqual(before.suggestions);
      expect(after.aiCalls).toBe(0);
      expect(sdk.sent).toHaveLength(0);
    });
  });

  it('a suggestion run that finishes after its project was archived stores pending suggestions only: no indicator, the project unchanged, accepting refused until restore', async () => {
    const w = await washProject(a, 'KPI late run: water');
    let archivedRow: Awaited<ReturnType<typeof prisma.project.findUniqueOrThrow>> | undefined;
    let archiveStatus: number | undefined;
    // The admin archives the project while the model is answering; the run then validates and saves.
    const sdk = fakeSdk(async body => {
      if (!archivedRow) {
        archiveStatus = (await request(app).post(`/api/projects/${w.project.id}/archive`).set('Authorization', a.adminAuth)).status;
        archivedRow = await prisma.project.findUniqueOrThrow({ where: { id: w.project.id } });
      }
      return rawMessage(body.model, answerFromPrompt(body));
    });
    configureAiClientForTests({ anthropic: sdk.client });

    const res = await request(app).post(`/api/projects/${w.project.id}/kpi-suggestions`).set('Authorization', a.officerAuth)
      .send({ scope: 'result', resultId: w.o1.id });
    expect(archiveStatus).toBe(200);
    expect(sdk.sent).toHaveLength(1);
    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({ status: 'completed', scope: 'result' });
    const stored = res.body.suggestions as { id: string; status: string; indicatorId: string | null }[];
    expect(stored.length).toBeGreaterThanOrEqual(1);
    expect(stored.every(s => s.status === 'pending' && s.indicatorId === null)).toBe(true);

    // No indicator was created, and the project row is exactly as the archive left it.
    expect(await prisma.indicator.count({ where: { framework: { projectId: w.project.id } } })).toBe(0);
    expect(await prisma.project.findUniqueOrThrow({ where: { id: w.project.id } })).toEqual(archivedRow);

    // The stored cards stay pending while the project is archived: accept, reject and new runs are refused.
    const first = stored[0];
    const refused = [
      request(app).post(`/api/kpi-suggestions/${first.id}/accept`).send({}),
      request(app).post(`/api/kpi-suggestions/${first.id}/reject`).send({ reason: 'not_relevant' }),
      request(app).post(`/api/projects/${w.project.id}/kpi-suggestions`).send({ scope: 'alternatives', suggestionId: first.id }),
    ];
    for (const attempt of refused) {
      const answer = await attempt.set('Authorization', a.officerAuth);
      expect(answer.status).toBe(409);
      expect(answer.body).toEqual(ARCHIVED);
    }
    const listed = await request(app).get(`/api/projects/${w.project.id}/kpi-suggestions`).set('Authorization', a.officerAuth);
    expect(listed.status).toBe(200);
    expect(listed.body.suggestions.map((s: { id: string }) => s.id).sort()).toEqual(stored.map(s => s.id).sort());
    expect(listed.body.suggestions.every((s: { status: string }) => s.status === 'pending')).toBe(true);
    expect(sdk.sent).toHaveLength(1);

    // Restored: the officer can accept the card the late run stored.
    expect((await request(app).post(`/api/projects/${w.project.id}/restore`).set('Authorization', a.adminAuth)).status).toBe(200);
    const accepted = await request(app).post(`/api/kpi-suggestions/${first.id}/accept`).set('Authorization', a.officerAuth).send({});
    expect(accepted.status).toBe(201);
    expect(await prisma.indicator.count({ where: { framework: { projectId: w.project.id } } })).toBe(1);
  });

  it('a suggestion run that finishes after its project was deleted forever leaves no KPI row behind', async () => {
    const w = await washProject(a, 'KPI late run: deleted');
    let deleteStatus: number | undefined;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sdk = fakeSdk(async body => {
      if (deleteStatus === undefined) {
        deleteStatus = (await request(app).delete(`/api/projects/${w.project.id}`).set('Authorization', a.adminAuth).send({ confirmName: w.project.name })).status;
      }
      return rawMessage(body.model, answerFromPrompt(body));
    });
    configureAiClientForTests({ anthropic: sdk.client });

    const res = await request(app).post(`/api/projects/${w.project.id}/kpi-suggestions`).set('Authorization', a.officerAuth)
      .send({ scope: 'result', resultId: w.o1.id });
    expect(deleteStatus).toBe(200);
    // The run row went with the project: the request cannot report on it.
    expect(res.status).toBe(404);
    expect(await prisma.project.count({ where: { id: w.project.id } })).toBe(0);
    expect(await prisma.kpiSuggestionRun.count({ where: { projectId: w.project.id } })).toBe(0);
    expect(await prisma.kpiSuggestion.count({ where: { projectId: w.project.id } })).toBe(0);
    expect(await prisma.indicator.count({ where: { frameworkId: w.framework.id } })).toBe(0);
    // The cost of the model call is kept, without the project (AiCall cost history).
    expect(await prisma.aiCall.count({ where: { organizationId: a.org.id, projectId: null, feature: { startsWith: 'kpi' } } })).toBeGreaterThanOrEqual(1);
  });

  it('delete forever while a run is saving its cards: both take the project row first and queue (no deadlock); the delete answers 200 and no KPI row is left', async () => {
    const w = await washProject(a, 'KPI late run: deleted while saving');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let deletion: Promise<{ status: number; body: unknown }> | undefined;
    // Inside the run's save transaction, after it claimed its run row: the admin deletes the project, and the save goes on
    // once the delete waits for a lock. Taken in opposite orders, the two would deadlock and PostgreSQL would abort one
    // of them (the delete answering 409 conflict, or the run failing 'internal').
    saveTransactionHook.current = async () => {
      deletion = request(app).delete(`/api/projects/${w.project.id}`).set('Authorization', a.adminAuth)
        .send({ confirmName: w.project.name }).then(answer => answer);
      await waitForLockWaiter();
    };
    const sdk = fakeSdk(async body => rawMessage(body.model, answerFromPrompt(body)));
    configureAiClientForTests({ anthropic: sdk.client });

    const res = await request(app).post(`/api/projects/${w.project.id}/kpi-suggestions`).set('Authorization', a.officerAuth)
      .send({ scope: 'result', resultId: w.o1.id });
    expect(saveTransactionHook.current).toBeNull();
    expect(deletion).toBeDefined();
    const deleted = await deletion!;
    expect(deleted.body).toMatchObject({ deleted: true, removed: { kpiSuggestionRuns: 1 } });
    expect(deleted.status).toBe(200);
    expect(sdk.sent).toHaveLength(1);
    // The run saved its cards, then the delete removed them with the project; the request may find its run already gone.
    expect([200, 404]).toContain(res.status);
    expect(await prisma.project.count({ where: { id: w.project.id } })).toBe(0);
    expect(await prisma.kpiSuggestionRun.count({ where: { projectId: w.project.id } })).toBe(0);
    expect(await prisma.kpiSuggestion.count({ where: { projectId: w.project.id } })).toBe(0);
    expect(await prisma.framework.count({ where: { id: w.framework.id } })).toBe(0);
    // Neither transaction was aborted: the run did not fail.
    expect(errors.mock.calls.flat().map(String).filter(line => line.includes('[KpiRun]'))).toEqual([]);
  });

  it('delete forever removes the KPI suggestions in every state and their runs, and no KPI row of another project', async () => {
    const project = await prisma.project.create({
      data: {
        organizationId: a.org.id, name: 'KPI delete: every state', sector: 'education', donor: 'EU', donorType: 'eu', status: 'active',
        startDate: new Date('2026-01-01'), endDate: new Date('2027-12-31'),
      },
    });
    // An older framework version and the current one, each with KPI rows.
    const v1 = await prisma.framework.create({ data: { projectId: project.id, version: 1, status: 'approved' } });
    const v2 = await prisma.framework.create({ data: { projectId: project.id, version: 2 } });
    const oldResult = await prisma.resultNode.create({ data: { frameworkId: v1.id, level: 'outcome', code: 'O1', text: 'Old outcome' } });
    const goal = await prisma.resultNode.create({ data: { frameworkId: v2.id, level: 'impact', code: 'Goal', text: 'Goal' } });
    const outcome = await prisma.resultNode.create({ data: { frameworkId: v2.id, parentId: goal.id, level: 'outcome', code: 'O1', text: 'Outcome' } });
    const output = await prisma.resultNode.create({ data: { frameworkId: v2.id, parentId: outcome.id, level: 'output', code: 'O1.1', text: 'Output' } });
    const indicator = (frameworkId: string, resultId: string, text: string) => prisma.indicator.create({
      data: { frameworkId, resultId, indicatorText: text, level: 'outcome', dataCollectionMethod: 'hh_survey', frequency: 'quarterly', phases: [] },
    });
    const oldInd = await indicator(v1.id, oldResult.id, 'Old indicator');
    const ind1 = await indicator(v2.id, outcome.id, 'Existing outcome indicator');
    const accepted = await indicator(v2.id, outcome.id, 'Accepted from a suggestion');
    const edited = await indicator(v2.id, output.id, 'Edited and accepted from a suggestion');

    const runOld = await createKpiRunRow({ projectId: project.id, frameworkId: v1.id, resultId: oldResult.id, requestedBy: a.officer.id });
    const runResult = await createKpiRunRow({ projectId: project.id, frameworkId: v2.id, resultId: outcome.id, requestedBy: a.officer.id });
    const runFailed = await createKpiRunRow({
      projectId: project.id, frameworkId: v2.id, data: { status: 'failed', errorCode: 'ai_unavailable', error: 'The AI service is not available.', suggestionCount: 0 },
    });
    type CardExtra = Partial<Pick<Parameters<typeof createKpiSuggestionRow>[0], 'status' | 'decision' | 'data'>>;
    const card = (run: { id: string; projectId: string; frameworkId: string }, result: { id: string; code: string; level: IndicatorLevel },
      name: string, extra: CardExtra = {}) => createKpiSuggestionRow({ run, suggestion: kpiValidatedSuggestionFixture(result, project, { name }), ...extra });
    const oldPending = await card(runOld, oldResult, 'Old pending');
    const pending = await card(runResult, outcome, 'Pending card');
    const acceptedCard = await card(runResult, outcome, 'Accepted card', { status: 'accepted', decision: { decidedBy: a.officer.id, indicatorId: accepted.id } });
    const editedCard = await card(runResult, output, 'Edited card', { status: 'edited_accepted', decision: { decidedBy: a.officer.id, indicatorId: edited.id } });
    const rejectedCard = await card(runResult, outcome, 'Rejected card', { status: 'rejected', decision: { decidedBy: a.officer.id, rejectReason: 'too_costly_to_measure', rejectNote: 'Too costly' } });
    const expiredCard = await card(runResult, output, 'Expired card', { status: 'expired' });
    // Alternatives: of an indicator (a running alternatives run whose source is that indicator) and of a suggestion.
    const runAltIndicator = await createKpiRunRow({
      projectId: project.id, frameworkId: v2.id, resultId: outcome.id,
      data: { scope: 'alternatives', sourceIndicatorId: ind1.id, status: 'running', step: 'model', finishedAt: null, updatedAt: new Date() },
    });
    const runAltSuggestion = await createKpiRunRow({
      projectId: project.id, frameworkId: v2.id, resultId: outcome.id, data: { scope: 'alternatives', sourceSuggestionId: pending.id },
    });
    const altOfIndicator = await card(runAltIndicator, outcome, 'Alternative of an indicator', { data: { alternativeOfIndicatorId: ind1.id } });
    const altOfSuggestion = await card(runAltSuggestion, outcome, 'Alternative of a suggestion', { data: { alternativeOfSuggestionId: pending.id } });
    const altRejected = await card(runAltSuggestion, outcome, 'Rejected alternative', {
      status: 'rejected', decision: { decidedBy: a.officer.id, rejectReason: 'wording' }, data: { alternativeOfSuggestionId: pending.id },
    });
    const aiCall = await prisma.aiCall.create({
      data: {
        feature: 'kpi.suggest', model: 'claude-sonnet-5-5', promptVersion: 'kpi-v2', status: 'success', latencyMs: 900,
        inputTokens: 900, outputTokens: 300, estimatedCostUsd: 0.0072, organizationId: a.org.id, projectId: project.id,
      },
    });
    const runIds = [runOld, runResult, runFailed, runAltIndicator, runAltSuggestion].map(r => r.id);
    const suggestionIds = [oldPending, pending, acceptedCard, editedCard, rejectedCard, expiredCard, altOfIndicator, altOfSuggestion, altRejected].map(s => s.id);
    expect(await prisma.kpiSuggestion.count({ where: { projectId: project.id } })).toBe(9);
    expect(new Set((await prisma.kpiSuggestion.findMany({ where: { projectId: project.id } })).map(s => s.status)))
      .toEqual(new Set(['pending', 'accepted', 'edited_accepted', 'rejected', 'expired']));

    // Every KPI row of the other projects (the same organisation's fixture project, and organisation B), as they are.
    const others = async () => ({
      runs: await prisma.kpiSuggestionRun.findMany({ where: { projectId: { in: [a.project.id, b.project.id] } }, orderBy: { id: 'asc' } }),
      suggestions: await prisma.kpiSuggestion.findMany({ where: { projectId: { in: [a.project.id, b.project.id] } }, orderBy: { id: 'asc' } }),
    });
    const othersBefore = await others();
    expect(othersBefore.runs.length).toBeGreaterThanOrEqual(2);
    expect(othersBefore.suggestions.length).toBeGreaterThanOrEqual(2);

    const res = await request(app).delete(`/api/projects/${project.id}`).set('Authorization', a.adminAuth).send({ confirmName: project.name });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      deleted: true,
      removed: {
        frameworks: 2, resultNodes: 4, indicators: 4, assessments: 0, dataPoints: 0, qualitativeEntries: 0, beneficiaries: 0,
        beneficiaryServices: 0, reports: 0, documents: 0, notifications: 0, kpiSuggestions: 9, kpiSuggestionRuns: 5,
        storageFilesRemoved: 0, storageFilesFailed: 0,
      },
    });

    // Every KPI row of the project is gone, by project and by id.
    expect(await prisma.kpiSuggestion.count({ where: { projectId: project.id } })).toBe(0);
    expect(await prisma.kpiSuggestionRun.count({ where: { projectId: project.id } })).toBe(0);
    expect(await prisma.kpiSuggestion.count({ where: { id: { in: suggestionIds } } })).toBe(0);
    expect(await prisma.kpiSuggestionRun.count({ where: { id: { in: runIds } } })).toBe(0);
    expect(await prisma.indicator.count({ where: { id: { in: [oldInd.id, ind1.id, accepted.id, edited.id] } } })).toBe(0);
    expect(await prisma.framework.count({ where: { projectId: project.id } })).toBe(0);
    // The other projects' KPI rows are untouched; the AI cost history stays, without the project.
    expect(await others()).toEqual(othersBefore);
    expect(await prisma.aiCall.findUniqueOrThrow({ where: { id: aiCall.id } })).toMatchObject({ projectId: null, organizationId: a.org.id, feature: 'kpi.suggest' });

    // The audit row counts the KPI rows too.
    let row: { previousValue: unknown } | null = null;
    await vi.waitFor(async () => {
      row = await prisma.auditLog.findFirst({ where: { entity: 'projects', entityId: project.id, action: `DELETE /api/projects/${project.id}` } });
      expect(row).not.toBeNull();
    });
    expect(row!.previousValue).toMatchObject({ name: project.name, status: 'active', removed: { kpiSuggestions: 9, kpiSuggestionRuns: 5, indicators: 4 } });
  });

  it('archived projects stay out of the dashboard overview and the project list with their KPI work, which their own pages still show', async () => {
    const p = await projectWithSuggestion(a, 'KPI archived: overview');
    await prisma.indicator.update({ where: { id: p.indicator.id }, data: { status: 'off_track' } });
    const overview = async () => (await request(app).get('/api/dashboard/overview').set('Authorization', a.adminAuth)).body;

    const live = await overview();
    expect(live.projects.map((x: { id: string }) => x.id)).toContain(p.project.id);
    expect(live.alerts.map((x: { indicatorId: string }) => x.indicatorId)).toContain(p.indicator.id);

    expect((await request(app).post(`/api/projects/${p.project.id}/archive`).set('Authorization', a.adminAuth)).status).toBe(200);
    const shelved = await overview();
    expect(shelved.projects.map((x: { id: string }) => x.id)).not.toContain(p.project.id);
    expect(shelved.alerts.map((x: { indicatorId: string }) => x.indicatorId)).not.toContain(p.indicator.id);
    expect(shelved.totalProjects).toBe(shelved.projects.length);
    const list = await request(app).get('/api/projects').set('Authorization', a.officerAuth);
    expect(list.body.map((x: { id: string }) => x.id)).not.toContain(p.project.id);
    const archivedList = await request(app).get('/api/projects?archived=true').set('Authorization', a.officerAuth);
    expect(archivedList.body.map((x: { id: string }) => x.id)).toContain(p.project.id);

    // The project's own pages (read-only) keep its KPI work.
    const kpi = await request(app).get(`/api/projects/${p.project.id}/kpi-suggestions`).set('Authorization', a.officerAuth);
    expect(kpi.status).toBe(200);
    expect(kpi.body.suggestions.map((s: { id: string }) => s.id)).toEqual([p.suggestion.id]);
    const dashboard = await request(app).get(`/api/dashboard/projects/${p.project.id}/dashboard`).set('Authorization', a.officerAuth);
    expect(dashboard.status).toBe(200);
  });
});
