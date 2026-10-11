import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { assertFrameworkAccess, assertResultAccess } from '../middleware/access';
import { authenticate, authorize } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { isValidParentLevel, parentLevelProblem, sortResultNodes } from '../services/indicators/hierarchy';
import { assertResultCodeFree, loadParentResult } from '../services/indicators/references';
import { RESULT_NODE_INCLUDE } from '../services/indicators/selects';
import { parseResultCreate, parseResultUpdate } from '../services/indicators/validation';

// Results chain (impact > outcome > output > activity) of a framework. See services/indicators/hierarchy.ts.
const router = Router();

const HAS_CHILDREN = 'Remove or move its child results first';

// GET /api/frameworks/:id/results — every result node, in display order
router.get('/frameworks/:id/results', authenticate, asyncHandler(async (req: Request, res: Response) => {
  await assertFrameworkAccess(req, req.params.id);

  const nodes = await prisma.resultNode.findMany({
    where: { frameworkId: req.params.id },
    include: RESULT_NODE_INCLUDE,
  });
  res.json(sortResultNodes(nodes));
}));

// POST /api/frameworks/:id/results
router.post('/frameworks/:id/results', authenticate, authorize('org_admin', 'platform_admin', 'me_officer'), asyncHandler(async (req: Request, res: Response) => {
  const framework = await assertFrameworkAccess(req, req.params.id);
  const input = parseResultCreate(req.body);

  const parent = input.parentId ? await loadParentResult(framework.id, input.parentId) : null;
  if (parent && !isValidParentLevel(input.level, parent.level)) {
    throw new AppError(400, parentLevelProblem(input.level, parent.level));
  }
  await assertResultCodeFree(framework.id, input.code);

  // Default: after its siblings (same parent and level).
  let sortOrder = input.sortOrder;
  if (sortOrder === undefined) {
    const last = await prisma.resultNode.findFirst({
      where: { frameworkId: framework.id, level: input.level, parentId: parent?.id ?? null },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    sortOrder = (last?.sortOrder ?? -1) + 1;
  }

  const node = await prisma.resultNode.create({
    data: {
      frameworkId: framework.id,
      parentId: parent?.id ?? null,
      level: input.level,
      code: input.code,
      text: input.text,
      textAr: input.textAr ?? null,
      sortOrder,
    },
    include: RESULT_NODE_INCLUDE,
  });

  res.status(201).json(node);
}));

// PATCH /api/results/:id
router.patch('/results/:id', authenticate, authorize('org_admin', 'platform_admin', 'me_officer'), asyncHandler(async (req: Request, res: Response) => {
  const node = await assertResultAccess(req, req.params.id);
  const input = parseResultUpdate(req.body);

  const level = input.level ?? node.level;
  const parentId = input.parentId === undefined ? node.parentId : input.parentId;
  if (parentId === node.id) throw new AppError(400, 'A result cannot be its own parent');

  // The (new or existing) parent must be in the same framework and one level above.
  if (parentId) {
    const parent = await loadParentResult(node.frameworkId, parentId);
    if (!isValidParentLevel(level, parent.level)) throw new AppError(400, parentLevelProblem(level, parent.level));
  }

  // A level change must keep every child valid. (Strict one-level steps also make cycles impossible.)
  if (level !== node.level) {
    const children = await prisma.resultNode.findMany({ where: { parentId: node.id }, select: { code: true, level: true } });
    const misfits = children.filter(child => !isValidParentLevel(child.level, level));
    if (misfits.length > 0) {
      throw new AppError(
        400,
        `Cannot change this result to ${level}: its child results ${misfits.map(c => c.code).join(', ')} would no longer fit. ${parentLevelProblem(misfits[0].level, level)} ${HAS_CHILDREN}.`,
      );
    }
  }

  if (input.code !== undefined) await assertResultCodeFree(node.frameworkId, input.code, node.id);

  const updated = await prisma.resultNode.update({
    where: { id: node.id },
    data: {
      ...(input.level !== undefined && { level: input.level }),
      ...(input.code !== undefined && { code: input.code }),
      ...(input.text !== undefined && { text: input.text }),
      ...(input.textAr !== undefined && { textAr: input.textAr }),
      ...(input.parentId !== undefined && { parentId: input.parentId }),
      ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
    },
    include: RESULT_NODE_INCLUDE,
  });

  res.json(updated);
}));

// DELETE /api/results/:id — refused while it has child results; its indicators are unlinked (ON DELETE SET NULL)
router.delete('/results/:id', authenticate, authorize('org_admin', 'platform_admin', 'me_officer'), asyncHandler(async (req: Request, res: Response) => {
  const node = await assertResultAccess(req, req.params.id);

  const children = await prisma.resultNode.count({ where: { parentId: node.id } });
  if (children > 0) throw new AppError(409, HAS_CHILDREN);

  const unlinkedIndicators = await prisma.indicator.count({ where: { resultId: node.id } });
  try {
    await prisma.resultNode.delete({ where: { id: node.id } });
  } catch (err) {
    // A child added between the check and the delete (parent FK is ON DELETE RESTRICT).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') throw new AppError(409, HAS_CHILDREN);
    throw err;
  }

  res.json({ message: 'Result deleted', unlinkedIndicators });
}));

export default router;
