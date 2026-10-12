import request from 'supertest';
import { IndicatorLevel } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import {
  compareResultNodes, isValidParentLevel, LEVEL_RANK, LEVELS_TOP_DOWN, parentLevelOf, parentLevelProblem, sortResultNodes,
} from '../src/services/indicators/hierarchy';
import { sameResultCode } from '../src/services/indicators/references';
import { describeIssues, parseResultCreate, parseResultUpdate, resultCreateSchema } from '../src/services/indicators/validation';
import { AppError } from '../src/middleware/errorHandler';
import { bearer, createOrgFixture, hasTestDatabase, OrgFixture, resetDatabase } from './helpers';

const LEVELS: IndicatorLevel[] = ['impact', 'outcome', 'output', 'activity'];

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(400);
    return (err as AppError).message;
  }
  throw new Error('expected a 400 AppError');
}

describe('results-chain hierarchy', () => {
  it('ranks levels from impact down to activity', () => {
    expect(LEVELS_TOP_DOWN).toEqual(LEVELS);
    expect(LEVELS.map(l => LEVEL_RANK[l])).toEqual([0, 1, 2, 3]);
    expect(LEVELS.map(parentLevelOf)).toEqual([null, 'impact', 'outcome', 'output']);
  });

  it('allows no parent at every level', () => {
    for (const level of LEVELS) expect(isValidParentLevel(level, null)).toBe(true);
  });

  it('allows exactly the parent one level above', () => {
    const allowed = new Set(['outcome<impact', 'output<outcome', 'activity<output']);
    for (const child of LEVELS) {
      for (const parent of LEVELS) {
        expect(isValidParentLevel(child, parent), `${child} under ${parent}`).toBe(allowed.has(`${child}<${parent}`));
      }
    }
  });

  it('never gives an impact a parent', () => {
    for (const parent of LEVELS) expect(isValidParentLevel('impact', parent)).toBe(false);
  });

  it('explains a wrong parent level', () => {
    expect(parentLevelProblem('output', 'impact')).toBe('An output result must sit under an outcome result, not under an impact result.');
    expect(parentLevelProblem('impact', 'outcome')).toMatch(/impact result cannot have a parent/);
  });

  it('sorts by level, then sortOrder, then code with numbers in order', () => {
    const nodes = [
      { code: 'O10', level: 'outcome' as const, sortOrder: 0 },
      { code: 'A1', level: 'activity' as const, sortOrder: 0 },
      { code: 'O2', level: 'outcome' as const, sortOrder: 0 },
      { code: 'O1.1', level: 'output' as const, sortOrder: 1 },
      { code: 'O1.2', level: 'output' as const, sortOrder: 0 },
      { code: 'Goal', level: 'impact' as const, sortOrder: 5 },
      { code: 'O3', level: 'outcome' as const, sortOrder: -1 },
    ];
    expect(sortResultNodes(nodes).map(n => n.code)).toEqual(['Goal', 'O3', 'O2', 'O10', 'O1.2', 'O1.1', 'A1']);
    expect(nodes[0].code).toBe('O10'); // input untouched
    expect(compareResultNodes(nodes[2], nodes[0])).toBeLessThan(0);
  });
});

describe('sameResultCode', () => {
  it('ignores case only; "_" and "%" are ordinary characters', () => {
    expect(sameResultCode('O1', 'o1')).toBe(true);
    expect(sameResultCode('O_1', 'o_1')).toBe(true);
    expect(sameResultCode('O_1', 'OX1')).toBe(false);
    expect(sameResultCode('O%', 'O1.1')).toBe(false);
    expect(sameResultCode('O1', 'O1.1')).toBe(false);
  });
});

describe('result payload validation', () => {
  it('accepts a minimal create payload and trims text', () => {
    expect(parseResultCreate({ level: 'outcome', code: ' O1 ', text: '  Better access  ' })).toEqual({
      level: 'outcome', code: 'O1', text: 'Better access',
    });
  });

  it('accepts every field and clears empty Arabic text', () => {
    expect(parseResultCreate({
      level: 'output', code: 'O1.1', text: 'Trained teachers', textAr: '  ', parentId: 'p-1', sortOrder: 3,
    })).toEqual({ level: 'output', code: 'O1.1', text: 'Trained teachers', textAr: null, parentId: 'p-1', sortOrder: 3 });
    expect(parseResultCreate({ level: 'output', code: 'X', text: 'T', textAr: 'معلمون مدربون' }).textAr).toBe('معلمون مدربون');
  });

  it('strips unknown keys', () => {
    const parsed = parseResultCreate({ level: 'impact', code: 'Goal', text: 'T', frameworkId: 'other', id: 'x', children: [] });
    expect(parsed).toEqual({ level: 'impact', code: 'Goal', text: 'T' });
  });

  it('names every failing field', () => {
    const message = messageOf(() => parseResultCreate({ level: 'goal', text: '   ', sortOrder: -1 }));
    expect(message).toMatch(/^Invalid result: /);
    expect(message).toContain('level must be one of: impact, outcome, output, activity');
    expect(message).toContain('code is required');
    expect(message).toContain('text cannot be empty');
    expect(message).toContain('sortOrder cannot be negative');
  });

  it('reports a missing level as required and limits lengths', () => {
    const result = resultCreateSchema.safeParse({ code: 'x'.repeat(51), text: 'ok' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(describeIssues(result.error)).toBe('level is required; code must be at most 50 characters');
    }
  });

  it('rejects a body that is not an object', () => {
    expect(messageOf(() => parseResultCreate(['x']))).toBe('Invalid result: the request body must be a JSON object');
  });

  it('accepts any subset on update, and null to detach the parent', () => {
    expect(parseResultUpdate({})).toEqual({});
    expect(parseResultUpdate({ parentId: null, text: ' New ' })).toEqual({ parentId: null, text: 'New' });
    expect(parseResultUpdate({ parentId: '' })).toEqual({ parentId: null });
    expect(messageOf(() => parseResultUpdate({ code: '' }))).toContain('code cannot be empty');
    expect(messageOf(() => parseResultUpdate({ level: null }))).toContain('level must be one of');
    expect(messageOf(() => parseResultUpdate({ sortOrder: 1.5 }))).toContain('sortOrder must be a whole number');
  });
});

describe.skipIf(!hasTestDatabase)('results chain API', () => {
  let a: OrgFixture;
  let b: OrgFixture;
  let viewerAuth: string;
  let otherFrameworkId: string;
  const ids: Record<string, string> = {};

  const post = (body: object, auth = a.adminAuth, frameworkId = a.framework.id) =>
    request(app).post(`/api/frameworks/${frameworkId}/results`).set('Authorization', auth).send(body);
  const patch = (id: string, body: object, auth = a.adminAuth) =>
    request(app).patch(`/api/results/${id}`).set('Authorization', auth).send(body);
  const del = (id: string, auth = a.adminAuth) => request(app).delete(`/api/results/${id}`).set('Authorization', auth);

  beforeAll(async () => {
    await resetDatabase();
    a = await createOrgFixture('a');
    b = await createOrgFixture('b');
    const viewer = await prisma.user.create({
      data: { organizationId: a.org.id, email: 'viewer-a@example.org', passwordHash: 'x', fullName: 'Viewer A', role: 'donor_viewer' },
    });
    viewerAuth = bearer(viewer);
    // A second framework of the same project and organisation.
    otherFrameworkId = (await prisma.framework.create({ data: { projectId: a.project.id, version: 2 } })).id;
    await prisma.resultNode.create({ data: { frameworkId: otherFrameworkId, level: 'impact', code: 'Goal', text: 'Other goal' } });
  });

  it('lists the fixture result with counts', async () => {
    const res = await request(app).get(`/api/frameworks/${a.framework.id}/results`).set('Authorization', viewerAuth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: a.result.id, frameworkId: a.framework.id, parentId: null, level: 'outcome', code: 'O1', text: 'Outcome a',
      _count: { indicators: 1, children: 0 },
    });
  });

  it('creates a full chain: impact > outcome > output > activity', async () => {
    const goal = await post({ level: 'impact', code: 'Goal', text: 'Improved learning in Hebron', textAr: 'تحسين التعلم في الخليل' });
    expect(goal.status).toBe(201);
    expect(goal.body).toMatchObject({ level: 'impact', code: 'Goal', parentId: null, sortOrder: 0, textAr: 'تحسين التعلم في الخليل', _count: { indicators: 0, children: 0 } });
    ids.goal = goal.body.id;

    const outcome = await post({ level: 'outcome', code: 'O2', text: 'Teachers use active methods', parentId: ids.goal });
    expect(outcome.status).toBe(201);
    expect(outcome.body).toMatchObject({ parentId: ids.goal, sortOrder: 0 });
    ids.o2 = outcome.body.id;

    const output = await post({ level: 'output', code: 'O2.1', text: 'Teachers trained', parentId: ids.o2 });
    expect(output.status).toBe(201);
    ids.o21 = output.body.id;

    const second = await post({ level: 'output', code: 'O2.2', text: 'Kits delivered', parentId: ids.o2 });
    expect(second.body.sortOrder).toBe(1); // after its sibling
    ids.o22 = second.body.id;

    const activity = await post({ level: 'activity', code: 'A2.1.1', text: 'Run workshops', parentId: ids.o21 }, a.officerAuth);
    expect(activity.status).toBe(201);
    ids.a211 = activity.body.id;
  });

  it('rejects a parent at the wrong level', async () => {
    const outcomeUnderOutput = await post({ level: 'outcome', code: 'O9', text: 'x', parentId: ids.o21 });
    expect(outcomeUnderOutput.status).toBe(400);
    expect(outcomeUnderOutput.body.message).toBe('An outcome result must sit under an impact result, not under an output result.');

    const activityUnderOutcome = await post({ level: 'activity', code: 'A9', text: 'x', parentId: ids.o2 });
    expect(activityUnderOutcome.status).toBe(400);

    const impactWithParent = await post({ level: 'impact', code: 'G2', text: 'x', parentId: ids.goal });
    expect(impactWithParent.status).toBe(400);
    expect(impactWithParent.body.message).toMatch(/impact result cannot have a parent/);
  });

  it('rejects a parent outside the framework', async () => {
    const unknown = await post({ level: 'output', code: 'O9.1', text: 'x', parentId: '00000000-0000-0000-0000-000000000000' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toBe('parentId must be a result in the same framework');

    const otherFrameworkGoal = await prisma.resultNode.findFirstOrThrow({ where: { frameworkId: otherFrameworkId } });
    const sameOrgOtherFramework = await post({ level: 'outcome', code: 'O9', text: 'x', parentId: otherFrameworkGoal.id });
    expect(sameOrgOtherFramework.status).toBe(400);

    const otherOrg = await post({ level: 'output', code: 'O9.1', text: 'x', parentId: b.result.id });
    expect(otherOrg.status).toBe(400);
  });

  it('rejects invalid payloads with the failing fields, and duplicate codes', async () => {
    const invalid = await post({ level: 'goal', code: '', text: 'x' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.message).toContain('level must be one of');
    expect(invalid.body.message).toContain('code cannot be empty');

    const duplicate = await post({ level: 'outcome', code: 'o2', text: 'Duplicate', parentId: ids.goal });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.message).toBe('A result with code "o2" already exists in this framework');

    // The same code is fine in another framework.
    const elsewhere = await post({ level: 'outcome', code: 'O2', text: 'Other' }, a.adminAuth, otherFrameworkId);
    expect(elsewhere.status).toBe(201);
  });

  it('checks duplicate codes exactly, ignoring case only ("_" and "%" are not wildcards)', async () => {
    const fw = await prisma.framework.create({ data: { projectId: a.project.id, version: -2 } });
    const create = (code: string) => post({ level: 'outcome', code, text: code }, a.adminAuth, fw.id);
    expect((await create('O_1')).status).toBe(201);
    expect((await create('OX1')).status).toBe(201);
    const clash = await create('o_1');
    expect(clash.status).toBe(409);
    expect(clash.body.message).toBe('A result with code "o_1" already exists in this framework');

    // A new code with "_" or "%" must not match other existing codes as a pattern.
    expect((await create('A1B')).status).toBe(201);
    expect((await create('A_B')).status).toBe(201);
    expect((await create('P1')).status).toBe(201);
    const percent = await create('P%');
    expect(percent.status).toBe(201);
    // On update too.
    expect((await patch(percent.body.id, { code: 'O%' })).status).toBe(200);
    expect((await patch(percent.body.id, { code: 'ox1' })).status).toBe(409);

    await prisma.resultNode.deleteMany({ where: { frameworkId: fw.id } });
    await prisma.framework.delete({ where: { id: fw.id } });
  });

  it('lets donor viewers read but not write', async () => {
    expect((await post({ level: 'impact', code: 'V', text: 'x' }, viewerAuth)).status).toBe(403);
    expect((await patch(ids.goal, { text: 'x' }, viewerAuth)).status).toBe(403);
    expect((await del(ids.a211, viewerAuth)).status).toBe(403);
  });

  it('returns results in display order with counts', async () => {
    await post({ level: 'outcome', code: 'O10', text: 'Tenth', parentId: ids.goal, sortOrder: 1 });
    const res = await request(app).get(`/api/frameworks/${a.framework.id}/results`).set('Authorization', a.adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.map((n: any) => n.code)).toEqual(['Goal', 'O1', 'O2', 'O10', 'O2.1', 'O2.2', 'A2.1.1']);
    const byCode = Object.fromEntries(res.body.map((n: any) => [n.code, n._count]));
    expect(byCode.Goal).toEqual({ indicators: 0, children: 2 });
    expect(byCode.O2).toEqual({ indicators: 0, children: 2 });
    expect(byCode.O1).toEqual({ indicators: 1, children: 0 });
  });

  it('updates text, Arabic text, code and sort order', async () => {
    const res = await patch(ids.o22, { text: '  Learning kits delivered ', textAr: 'توزيع حقائب تعليمية', code: 'O2.3', sortOrder: 7 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      text: 'Learning kits delivered', textAr: 'توزيع حقائب تعليمية', code: 'O2.3', sortOrder: 7, parentId: ids.o2, updatedIndicators: 0,
    });

    const cleared = await patch(ids.o22, { textAr: '' });
    expect(cleared.body.textAr).toBeNull();

    // Changing only the case of its own code is not a clash.
    expect((await patch(ids.o22, { code: 'o2.3' })).status).toBe(200);
    expect((await patch(ids.o22, { code: 'O2.1' })).status).toBe(409);
  });

  it('attaches the fixture outcome to the goal and detaches it again', async () => {
    const attached = await patch(a.result.id, { parentId: ids.goal });
    expect(attached.status).toBe(200);
    expect(attached.body.parentId).toBe(ids.goal);

    const detached = await patch(a.result.id, { parentId: null });
    expect(detached.status).toBe(200);
    expect(detached.body.parentId).toBeNull();
  });

  it('refuses to make a result its own parent', async () => {
    const res = await patch(ids.o2, { parentId: ids.o2 });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('A result cannot be its own parent');
  });

  it('checks the hierarchy when the level or parent changes', async () => {
    // O2.1 has an activity child, so it cannot become an outcome.
    const breaksChild = await patch(ids.o21, { level: 'outcome', parentId: ids.goal });
    expect(breaksChild.status).toBe(400);
    expect(breaksChild.body.message).toContain('A2.1.1');
    expect(breaksChild.body.message).toContain('Remove or move its child results first');

    // O2 sits under the goal, so it cannot become an output without a new parent.
    const breaksParent = await patch(ids.o2, { level: 'output' });
    expect(breaksParent.status).toBe(400);
    expect(breaksParent.body.message).toBe('An output result must sit under an outcome result, not under an impact result.');

    // An impact keeps no parent.
    const impactWithParent = await patch(ids.o2, { level: 'impact' });
    expect(impactWithParent.status).toBe(400);

    // Moving the output to a parent at the wrong level.
    const wrongParent = await patch(ids.o22, { parentId: ids.goal });
    expect(wrongParent.status).toBe(400);

    // Leaf activity becomes an output under an outcome: valid, and its indicators follow it.
    const linked = await prisma.indicator.create({
      data: {
        frameworkId: a.framework.id, resultId: ids.a211, indicatorText: 'Workshops held', level: 'activity',
        dataCollectionMethod: 'document_review', frequency: 'monthly', phases: ['ongoing'],
      },
    });
    const promoted = await patch(ids.a211, { level: 'output', parentId: ids.o2 });
    expect(promoted.status).toBe(200);
    expect(promoted.body).toMatchObject({ level: 'output', parentId: ids.o2, updatedIndicators: 1 });
    expect((await prisma.indicator.findUniqueOrThrow({ where: { id: linked.id } })).level).toBe('output');

    // ...and back down under an output.
    const demoted = await patch(ids.a211, { level: 'activity', parentId: ids.o21 });
    expect(demoted.status).toBe(200);
    expect(demoted.body).toMatchObject({ level: 'activity', parentId: ids.o21, updatedIndicators: 1 });
    expect((await prisma.indicator.findUniqueOrThrow({ where: { id: linked.id } })).level).toBe('activity');
    await prisma.indicator.delete({ where: { id: linked.id } });

    // A refused level change leaves its indicators alone (O2.1 still has the activity child).
    const underO21 = await prisma.indicator.create({
      data: {
        frameworkId: a.framework.id, resultId: ids.o21, indicatorText: 'Teachers trained', level: 'output',
        dataCollectionMethod: 'document_review', frequency: 'monthly', phases: ['ongoing'],
      },
    });
    expect((await patch(ids.o21, { level: 'outcome', parentId: ids.goal })).status).toBe(400);
    expect((await prisma.indicator.findUniqueOrThrow({ where: { id: underO21.id } })).level).toBe('output');
    await prisma.indicator.delete({ where: { id: underO21.id } });

    // Changing a level is fine when every child still fits (the goal's children are outcomes).
    expect((await patch(ids.goal, { text: 'Goal text only' })).status).toBe(200);
  });

  it('validates update payloads and ignores unknown keys', async () => {
    const invalid = await patch(ids.o2, { level: 'goal', text: '' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.message).toContain('level must be one of');
    expect(invalid.body.message).toContain('text cannot be empty');

    const before = await prisma.resultNode.findUniqueOrThrow({ where: { id: ids.o2 } });
    const ignored = await patch(ids.o2, { frameworkId: otherFrameworkId, id: 'new-id' });
    expect(ignored.status).toBe(200);
    expect(await prisma.resultNode.findUniqueOrThrow({ where: { id: ids.o2 } })).toEqual(before);

    const foreignParent = await patch(ids.o2, { parentId: b.result.id });
    expect(foreignParent.status).toBe(400);
  });

  it('refuses to delete a result with children (409)', async () => {
    const res = await del(ids.o2);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Remove or move its child results first');
    expect(await prisma.resultNode.findUnique({ where: { id: ids.o2 } })).not.toBeNull();
  });

  it('deletes a leaf result and unlinks its indicators', async () => {
    const res = await del(a.result.id, a.officerAuth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Result deleted', unlinkedIndicators: 1 });
    expect(await prisma.resultNode.findUnique({ where: { id: a.result.id } })).toBeNull();
    const indicator = await prisma.indicator.findUniqueOrThrow({ where: { id: a.indicator.id } });
    expect(indicator.resultId).toBeNull();
    expect(indicator.indicatorText).toBe('Indicator a');

    expect((await del(a.result.id)).status).toBe(404);
  });

  it('deletes a chain from the bottom up', async () => {
    expect((await del(ids.a211)).status).toBe(200);
    expect((await del(ids.o21)).status).toBe(200);
    expect((await del(ids.o22)).status).toBe(200);
    expect((await del(ids.o2)).status).toBe(200);
  });

  it('includes ordered result nodes and each indicator result in the project framework', async () => {
    const outcome = await post({ level: 'outcome', code: 'O1', text: 'Re-created outcome', parentId: ids.goal });
    await prisma.indicator.update({ where: { id: a.indicator.id }, data: { resultId: outcome.body.id } });

    // Make the second framework of the project the older one so the fixture framework stays the latest.
    await prisma.framework.update({ where: { id: otherFrameworkId }, data: { version: 0 } });
    const res = await request(app).get(`/api/projects/${a.project.id}/framework`).set('Authorization', a.adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(a.framework.id);
    // sortOrder before code: O10 was given sortOrder 1; the re-created O1 defaults to after it (2).
    expect(res.body.resultNodes.map((n: any) => [n.code, n.sortOrder])).toEqual([['Goal', 0], ['O10', 1], ['O1', 2]]);
    expect(res.body.resultNodes[0]._count).toEqual({ indicators: 0, children: 2 });
    expect(res.body.indicators).toHaveLength(1);
    expect(res.body.indicators[0].result).toEqual({ id: outcome.body.id, code: 'O1', level: 'outcome', text: 'Re-created outcome' });
    expect(res.body.indicators[0]._count).toEqual({ dataPoints: 1 });
  });

  it('cascades result nodes when their framework is deleted', async () => {
    const fw = await prisma.framework.create({ data: { projectId: a.project.id, version: -1 } });
    const top = await post({ level: 'impact', code: 'G', text: 'x' }, a.adminAuth, fw.id);
    const middle = await post({ level: 'outcome', code: 'O', text: 'x', parentId: top.body.id }, a.adminAuth, fw.id);
    await post({ level: 'output', code: 'O.1', text: 'x', parentId: middle.body.id }, a.adminAuth, fw.id);
    expect(await prisma.resultNode.count({ where: { frameworkId: fw.id } })).toBe(3);
    // The parent link (ON DELETE RESTRICT) must not block the framework cascade.
    await prisma.framework.delete({ where: { id: fw.id } });
    expect(await prisma.resultNode.count({ where: { frameworkId: fw.id } })).toBe(0);
  });
});
