import { IndicatorLevel } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError } from '../../middleware/errorHandler';

/**
 * Checks ids an indicator payload refers to (not the URL id). Throws 400 so a
 * result from another framework (or another organisation) or an unknown
 * library entry cannot be attached.
 */
export async function assertIndicatorReferences(
  frameworkId: string,
  input: { resultId?: string | null; libraryId?: string | null },
): Promise<{ result: { id: string; level: IndicatorLevel } | null }> {
  let result: { id: string; level: IndicatorLevel } | null = null;
  if (input.resultId) {
    result = await prisma.resultNode.findFirst({
      where: { id: input.resultId, frameworkId },
      select: { id: true, level: true },
    });
    if (!result) throw new AppError(400, 'resultId must be a result in the same framework as the indicator');
  }
  if (input.libraryId) {
    const entry = await prisma.indicatorLibraryEntry.findUnique({ where: { id: input.libraryId }, select: { id: true } });
    if (!entry) throw new AppError(400, `libraryId "${input.libraryId}" is not in the indicator library`);
  }
  return { result };
}

/** Loads a parent result for a result payload; 400 unless it is in the same framework. */
export async function loadParentResult(frameworkId: string, parentId: string): Promise<{ id: string; level: IndicatorLevel }> {
  const parent = await prisma.resultNode.findFirst({
    where: { id: parentId, frameworkId },
    select: { id: true, level: true },
  });
  if (!parent) throw new AppError(400, 'parentId must be a result in the same framework');
  return parent;
}

/** True when two result codes are the same, ignoring case only ("o_1" = "O_1", but "OX1" ≠ "O_1"). */
export function sameResultCode(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * 409 when another result in the framework already uses the code (case-insensitive).
 * Compared exactly in code: Prisma's case-insensitive `equals` becomes ILIKE, where
 * "_" and "%" are wildcards. A framework has tens of results, so loading the codes is cheap.
 */
export async function assertResultCodeFree(frameworkId: string, code: string, exceptId?: string): Promise<void> {
  const others = await prisma.resultNode.findMany({
    where: { frameworkId, ...(exceptId && { id: { not: exceptId } }) },
    select: { code: true },
  });
  if (others.some(other => sameResultCode(other.code, code))) {
    throw new AppError(409, `A result with code "${code}" already exists in this framework`);
  }
}
