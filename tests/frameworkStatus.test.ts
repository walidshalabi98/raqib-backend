import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { INTERRUPTED_GENERATION_MESSAGE, INTERRUPTED_GENERATION_MS, generationFailure } from '../src/routes/frameworks';
import { createOrgFixture, hasTestDatabase, OrgFixture, resetDatabase } from './helpers';

/**
 * A failed AI framework generation (Framework.generationError, or an empty AI draft left by an
 * interrupted run) is reported as "failed" by GET /frameworks/:id/status, and never replaces the
 * project's current framework: the newest version without a generationError.
 */

const MINUTE = 60 * 1000;

describe('generationFailure', () => {
  const now = new Date('2026-10-12T12:00:00Z');
  const draft = {
    generationError: null, status: 'draft', aiModelUsed: 'claude-sonnet-5-5', generatedAt: new Date(now.getTime() - MINUTE), resultCount: 0, indicatorCount: 0,
  };

  it('reports the recorded generation error', () => {
    expect(generationFailure({ ...draft, generationError: 'The AI model declined the request (framework.indicators).' }, now))
      .toBe('The AI model declined the request (framework.indicators).');
  });

  it('reports an empty AI draft as interrupted only after the time limit', () => {
    expect(INTERRUPTED_GENERATION_MS).toBe(45 * MINUTE);
    expect(generationFailure(draft, now)).toBeNull();
    expect(generationFailure({ ...draft, generatedAt: new Date(now.getTime() - 45 * MINUTE) }, now)).toBeNull();
    expect(generationFailure({ ...draft, generatedAt: new Date(now.getTime() - 46 * MINUTE) }, now)).toBe(INTERRUPTED_GENERATION_MESSAGE);
  });

  it('never reports a manual framework, a framework with content or a reviewed framework as interrupted', () => {
    const old = { ...draft, generatedAt: new Date(now.getTime() - 60 * MINUTE) };
    expect(generationFailure({ ...old, aiModelUsed: 'manual' }, now)).toBeNull();
    expect(generationFailure({ ...old, resultCount: 3 }, now)).toBeNull();
    expect(generationFailure({ ...old, indicatorCount: 1 }, now)).toBeNull();
    expect(generationFailure({ ...old, status: 'approved' }, now)).toBeNull();
  });
});

describe.skipIf(!hasTestDatabase)('framework status and the current framework', () => {
  let fx: OrgFixture;

  beforeEach(async () => {
    await resetDatabase();
    fx = await createOrgFixture('status');
  });

  const status = (frameworkId: string) => request(app).get(`/api/frameworks/${frameworkId}/status`).set('Authorization', fx.officerAuth);
  const current = () => request(app).get(`/api/projects/${fx.project.id}/framework`).set('Authorization', fx.officerAuth);

  it('reports a failed version as failed with its message, and the project keeps showing the previous version', async () => {
    const failed = await prisma.framework.create({
      data: { projectId: fx.project.id, version: 2, status: 'draft', aiModelUsed: 'claude-sonnet-5-5', generationError: 'The AI request failed (framework.indicators, HTTP 529, after 4 attempts).' },
    });

    const res = await status(failed.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ frameworkId: failed.id, status: 'failed', message: 'The AI request failed (framework.indicators, HTTP 529, after 4 attempts).' });

    const shown = await current();
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({ id: fx.framework.id, version: 1 });
    expect(shown.body.indicators.map((i: { id: string }) => i.id)).toEqual([fx.indicator.id]);
  });

  it('shows no framework when every version failed', async () => {
    const project = await prisma.project.create({
      data: {
        organizationId: fx.org.id, name: 'New project', sector: 'wash', donor: 'DG ECHO', donorType: 'echo',
        startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'),
      },
    });
    await prisma.framework.create({ data: { projectId: project.id, version: 1, status: 'draft', generationError: 'The AI model declined the request (framework.structure).' } });
    const shown = await request(app).get(`/api/projects/${project.id}/framework`).set('Authorization', fx.officerAuth);
    expect(shown.status).toBe(200);
    expect(shown.body).toBeNull();
  });

  it('reports a running generation as processing and an interrupted one as failed', async () => {
    const running = await prisma.framework.create({ data: { projectId: fx.project.id, version: 2, status: 'draft', aiModelUsed: 'claude-sonnet-5-5' } });
    expect((await status(running.id)).body).toMatchObject({ frameworkId: running.id, status: 'processing' });
    // A running generation is the newest version without an error: the project shows it, as before Phase 3.
    expect((await current()).body).toMatchObject({ id: running.id, version: 2 });

    await prisma.framework.update({ where: { id: running.id }, data: { generatedAt: new Date(Date.now() - INTERRUPTED_GENERATION_MS - MINUTE) } });
    expect((await status(running.id)).body).toEqual({ frameworkId: running.id, status: 'failed', message: INTERRUPTED_GENERATION_MESSAGE });
  });

  it('reports a framework with indicators as completed, and a recorded error wins over an empty draft', async () => {
    const res = await status(fx.framework.id);
    expect(res.body).toMatchObject({ frameworkId: fx.framework.id, status: 'completed' });
    expect(res.body.framework.indicators).toHaveLength(1);

    const manual = await prisma.framework.create({
      data: { projectId: fx.project.id, version: 2, status: 'draft', aiModelUsed: 'manual', generatedAt: new Date(Date.now() - 60 * MINUTE) },
    });
    expect((await status(manual.id)).body).toMatchObject({ status: 'processing' });
  });

  it('refuses to approve a failed version', async () => {
    const failed = await prisma.framework.create({
      data: { projectId: fx.project.id, version: 2, status: 'draft', generationError: 'The AI model declined the request (framework.indicators).' },
    });
    const res = await request(app).patch(`/api/frameworks/${failed.id}/approve`).set('Authorization', fx.adminAuth);
    expect(res.status).toBe(409);
    expect(res.body.error ?? res.body.message).toMatch(/failed to generate/);
    expect(await prisma.framework.findUniqueOrThrow({ where: { id: failed.id } })).toMatchObject({ status: 'draft', approvedAt: null });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: fx.project.id } })).status).toBe('setup');
  });

  it('numbers new versions after failed ones', async () => {
    await prisma.framework.create({ data: { projectId: fx.project.id, version: 2, status: 'draft', generationError: 'The AI model declined the request (framework.indicators).' } });
    const generate = await request(app).post(`/api/projects/${fx.project.id}/framework/generate`).set('Authorization', fx.officerAuth);
    expect(generate.status).toBe(202);
    expect(await prisma.framework.findUniqueOrThrow({ where: { id: generate.body.frameworkId } })).toMatchObject({ version: 3, generationError: null });
    const manual = await request(app).post(`/api/projects/${fx.project.id}/framework/manual`).set('Authorization', fx.officerAuth).send({});
    expect(manual.status).toBe(201);
    expect(manual.body.version).toBe(4);
  });
});
