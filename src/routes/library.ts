import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { authenticate } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { buildLibraryWhere, LIBRARY_ENTRY_SELECT, LibraryQuery, matchesLibrarySearch, parseLibraryQuery } from '../services/library/query';

// The indicator library is global reference data (not organisation-owned), loaded with `npm run seed:library`.
const router = Router();

// GET /api/indicator-library?sector=wash,health&level=outcome&framework=gerf&isStandard=true&q=water
router.get('/', authenticate, asyncHandler(async (req: Request, res: Response) => {
  let filters: LibraryQuery;
  try {
    filters = parseLibraryQuery(req.query);
  } catch (err: any) {
    throw new AppError(400, err.message);
  }

  const entries = await prisma.indicatorLibraryEntry.findMany({
    where: buildLibraryWhere(filters),
    select: LIBRARY_ENTRY_SELECT,
    orderBy: { id: 'asc' },
  });
  res.json(filters.q ? entries.filter(e => matchesLibrarySearch(e, filters.q)) : entries);
}));

// GET /api/indicator-library/:id — ids are upper case ("FS-01"); " fs-01 " finds the same entry, as libraryId does on indicators.
router.get('/:id', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const entry = await prisma.indicatorLibraryEntry.findUnique({
    where: { id: req.params.id.trim().toUpperCase() },
    select: LIBRARY_ENTRY_SELECT,
  });
  if (!entry) throw new AppError(404, 'Library entry not found');
  res.json(entry);
}));

export default router;
