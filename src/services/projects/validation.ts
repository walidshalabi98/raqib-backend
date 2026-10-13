import { DonorType, Prisma, Project, ProjectStatus, Sector } from '@prisma/client';
import { z } from 'zod';
import { dateField, enumField, formatIssues, optionalNumber, optionalText, requiredText } from '../dataPoints/fields';

/**
 * Request-body validation for POST /api/projects and PATCH /api/projects/:id.
 * Pure functions: the route passes in the stored project for a patch.
 *
 * `sector` is the primary sector; `sectors` lists every sector of the project
 * and always includes the primary one (BUILD_GUIDE Phase 2 task 4).
 */

export type ParseResult<T> = { ok: true; data: T } | { ok: false; errors: string[] };

/** Project.budgetUsd is DECIMAL(12, 2). */
export const MAX_BUDGET_USD = 9_999_999_999.99;
/** Project.targetBeneficiaries is a Postgres INTEGER. */
export const MAX_TARGET_BENEFICIARIES = 2_147_483_647;

const sectorsField = z
  .array(enumField(Sector), { invalid_type_error: 'must be a list of sectors' })
  .superRefine((list, ctx) => {
    const seen = new Set<Sector>();
    const repeated = new Set<Sector>();
    for (const s of list) {
      if (seen.has(s)) repeated.add(s);
      seen.add(s);
    }
    if (repeated.size > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must not list a sector twice (${Array.from(repeated).join(', ')})` });
    }
  });

const humanitarianField = z.boolean({ invalid_type_error: 'must be true or false' });

const createSchema = z
  .object({
    name: requiredText(),
    nameAr: optionalText(),
    description: optionalText(),
    sector: enumField(Sector),
    sectors: sectorsField.optional(),
    donor: requiredText(),
    donorType: enumField(DonorType),
    budgetUsd: optionalNumber({ max: MAX_BUDGET_USD }),
    startDate: dateField(),
    endDate: dateField(),
    targetBeneficiaries: optionalNumber({ integer: true, max: MAX_TARGET_BENEFICIARIES }),
    geographicScope: optionalText(),
    humanitarian: humanitarianField.optional(),
  }, { invalid_type_error: 'must be a JSON object' })
  .superRefine((d, ctx) => {
    if (d.endDate < d.startDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endDate'], message: 'must be on or after startDate' });
    }
  });

const updateSchema = z.object({
  name: requiredText().optional(),
  nameAr: optionalText(),
  description: optionalText(),
  sector: enumField(Sector).optional(),
  sectors: sectorsField.optional(),
  donor: requiredText().optional(),
  donorType: enumField(DonorType).optional(),
  budgetUsd: optionalNumber({ max: MAX_BUDGET_USD }),
  startDate: dateField().optional(),
  endDate: dateField().optional(),
  targetBeneficiaries: optionalNumber({ integer: true, max: MAX_TARGET_BENEFICIARIES }),
  geographicScope: optionalText(),
  // Archiving has its own route (POST /api/projects/:id/archive, admins only, recorded for restore).
  status: enumField(ProjectStatus)
    .refine(status => status !== 'archived', { message: 'cannot be set to archived here: archive the project instead' })
    .optional(),
  humanitarian: humanitarianField.optional(),
}, { invalid_type_error: 'must be a JSON object' });

/**
 * The primary sector first, then the other sectors in their given order,
 * without repeats: mergeSectors('health', ['wash', 'health']) → ['health', 'wash'].
 */
export function mergeSectors(primary: Sector, sectors: readonly Sector[] = []): Sector[] {
  return Array.from(new Set<Sector>([primary, ...sectors]));
}

export type ProjectCreateData = Omit<Prisma.ProjectUncheckedCreateInput, 'organizationId'>;

/** Validates the body of POST /api/projects. `sectors` defaults to [sector] and always includes it. */
export function parseProjectCreate(body: unknown): ParseResult<ProjectCreateData> {
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return { ok: false, errors: formatIssues(parsed.error) };
  const d = parsed.data;
  return {
    ok: true,
    data: {
      name: d.name,
      nameAr: d.nameAr ?? undefined,
      description: d.description ?? undefined,
      sector: d.sector,
      sectors: mergeSectors(d.sector, d.sectors),
      donor: d.donor,
      donorType: d.donorType,
      budgetUsd: d.budgetUsd ?? undefined,
      startDate: d.startDate,
      endDate: d.endDate,
      targetBeneficiaries: d.targetBeneficiaries ?? undefined,
      geographicScope: d.geographicScope ?? undefined,
      humanitarian: d.humanitarian ?? undefined,
    },
  };
}

export type StoredProject = Pick<Project, 'sector' | 'sectors' | 'startDate' | 'endDate'>;

/**
 * Validates the body of PATCH /api/projects/:id against the stored project.
 * Only the fields sent are changed; optional text and numbers can be cleared
 * with null. When `sector` or `sectors` changes, the stored `sectors` keep the
 * (new) primary sector first; sectors are never dropped implicitly.
 */
export function parseProjectUpdate(body: unknown, current: StoredProject): ParseResult<Prisma.ProjectUncheckedUpdateInput> {
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return { ok: false, errors: formatIssues(parsed.error) };
  const d = parsed.data;

  if (d.startDate !== undefined || d.endDate !== undefined) {
    const start = d.startDate ?? current.startDate;
    const end = d.endDate ?? current.endDate;
    if (end < start) return { ok: false, errors: ['endDate must be on or after startDate'] };
  }

  const data: Prisma.ProjectUncheckedUpdateInput = {};
  if (d.name !== undefined) data.name = d.name;
  if (d.nameAr !== undefined) data.nameAr = d.nameAr;
  if (d.description !== undefined) data.description = d.description;
  if (d.sector !== undefined) data.sector = d.sector;
  if (d.donor !== undefined) data.donor = d.donor;
  if (d.donorType !== undefined) data.donorType = d.donorType;
  if (d.budgetUsd !== undefined) data.budgetUsd = d.budgetUsd;
  if (d.startDate !== undefined) data.startDate = d.startDate;
  if (d.endDate !== undefined) data.endDate = d.endDate;
  if (d.targetBeneficiaries !== undefined) data.targetBeneficiaries = d.targetBeneficiaries;
  if (d.geographicScope !== undefined) data.geographicScope = d.geographicScope;
  if (d.status !== undefined) data.status = d.status;
  if (d.humanitarian !== undefined) data.humanitarian = d.humanitarian;

  // Projects created before Phase 2 may have an empty list; it stands for [sector].
  const stored = current.sectors.length > 0 ? current.sectors : [current.sector];
  const primary = d.sector ?? current.sector;
  if (d.sector !== undefined || d.sectors !== undefined || !current.sectors.includes(current.sector)) {
    data.sectors = mergeSectors(primary, d.sectors ?? stored);
  }

  return { ok: true, data };
}
