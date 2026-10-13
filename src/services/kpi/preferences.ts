/**
 * orgPreferences: what the organisation's past decisions on suggestions exclude or prefer (knowledge/kpi-assistant-spec.md
 * §A3 orgPreferences; BUILD_GUIDE Phase 4 criterion 4; design section 8.3, D9). The pure functions take decided rows;
 * loadOrgPreferences reads them, scoped to the organisation (CLAUDE.md rule 1). Reject notes are never read.
 */
import type { CollectionMethod, DonorType, PrismaClient, SuggestionRejectReason, SuggestionStatus } from '@prisma/client';
import type { OrgPreferences } from './types';

/** Where a rejection excludes the library id (D9; owner sign-off). Every scope includes the project where it was rejected. */
export const REJECTION_SCOPE: Readonly<Record<SuggestionRejectReason, 'organisation' | 'donor' | 'project'>> = {
  not_relevant: 'organisation', too_costly_to_measure: 'organisation', other: 'organisation',
  donor_not_required: 'donor', duplicate: 'project', wording: 'project',
};

/** Decisions older than this are not used (section 8.3). */
export const PREFERENCE_WINDOW_MONTHS = 24;
/** At most this many decided rows are read, newest first (a safety bound; the latest decisions are the ones that count). */
export const MAX_PREFERENCE_ROWS = 5000;
/** preferredMethods: a method needs this many acceptances and this acceptance rate, and at most 3 are sent. */
export const PREFERRED_METHOD_MIN_ACCEPTS = 3;
export const PREFERRED_METHOD_MIN_RATE = 0.6;
export const MAX_PREFERRED_METHODS = 3;

/** One decided suggestion of the organisation, as the pure preference rules read it (section 8.3). */
export interface PreferenceRow { libraryId: string | null; status: SuggestionStatus; rejectReason: SuggestionRejectReason | null;
  decidedAt: Date; projectId: string; donorType: DonorType; method: CollectionMethod }

const ACCEPTED: ReadonlySet<SuggestionStatus> = new Set<SuggestionStatus>(['accepted', 'edited_accepted']);
const DECIDED: ReadonlySet<SuggestionStatus> = new Set<SuggestionStatus>(['accepted', 'edited_accepted', 'rejected']);

/** True when a decided row speaks for the target project: acceptances always; rejections by REJECTION_SCOPE (D9). */
function appliesTo(row: PreferenceRow, target: { projectId: string; donorType: DonorType }): boolean {
  if (ACCEPTED.has(row.status)) return true;
  if (row.status !== 'rejected') return false;
  if (row.projectId === target.projectId) return true;
  // A rejection without a reason (never written by the API) counts for its own project only.
  const scope = row.rejectReason ? REJECTION_SCOPE[row.rejectReason] : 'project';
  if (scope === 'organisation') return true;
  if (scope === 'donor') return row.donorType === target.donorType;
  return false;
}

/**
 * Library ids (upper case, sorted) whose latest decision that applies to the target project is a rejection (section
 * 8.3, D9; BUILD_GUIDE Phase 4 criterion 4): acceptances always apply; a rejection applies in its own project and, by
 * REJECTION_SCOPE, in every project (organisation) or every project of the same donor type (donor). So a later
 * acceptance anywhere in the organisation lifts an exclusion (the only undo in Phase 4). On equal decision times the
 * acceptance counts as the later one. Rows without a libraryId and undecided rows are ignored.
 */
export function rejectedLibraryIdsFor(rows: readonly PreferenceRow[], target: { projectId: string; donorType: DonorType }): string[] {
  const latest = new Map<string, PreferenceRow>();
  for (const row of rows) {
    const id = row.libraryId?.trim().toUpperCase();
    if (!id || !appliesTo(row, target)) continue;
    const current = latest.get(id);
    const later = !current
      || row.decidedAt.getTime() > current.decidedAt.getTime()
      || (row.decidedAt.getTime() === current.decidedAt.getTime() && ACCEPTED.has(row.status));
    if (later) latest.set(id, row);
  }
  return Array.from(latest.entries())
    .filter(([, row]) => row.status === 'rejected')
    .map(([id]) => id)
    .sort();
}

/**
 * Collection methods this organisation usually accepts (section 8.3; a soft hint for the model only): per method,
 * accepts = accepted + edited_accepted and total = decided; preferred when accepts ≥ 3 and accepts / total ≥ 0.6;
 * ordered by accepts (then by name); at most 3. Rows of any libraryId count.
 */
export function preferredMethodsFrom(rows: readonly PreferenceRow[]): CollectionMethod[] {
  const counts = new Map<CollectionMethod, { accepts: number; total: number }>();
  for (const row of rows) {
    if (!DECIDED.has(row.status)) continue;
    const c = counts.get(row.method) ?? { accepts: 0, total: 0 };
    c.total += 1;
    if (ACCEPTED.has(row.status)) c.accepts += 1;
    counts.set(row.method, c);
  }
  return Array.from(counts.entries())
    .filter(([, c]) => c.accepts >= PREFERRED_METHOD_MIN_ACCEPTS && c.accepts / c.total >= PREFERRED_METHOD_MIN_RATE)
    .sort(([ma, a], [mb, b]) => b.accepts - a.accepts || ma.localeCompare(mb))
    .slice(0, MAX_PREFERRED_METHODS)
    .map(([method]) => method);
}

/** `now` minus PREFERENCE_WINDOW_MONTHS calendar months (UTC). */
export function preferenceWindowStart(now: Date): Date {
  const start = new Date(now.getTime());
  start.setUTCMonth(start.getUTCMonth() - PREFERENCE_WINDOW_MONTHS);
  return start;
}

/**
 * The organisation's decided suggestions of the last 24 months → OrgPreferences for one project (section 8.3). Every row
 * is scoped to `organizationId` through its project (CLAUDE.md rule 1): another organisation's decisions never apply.
 */
export async function loadOrgPreferences(db: Pick<PrismaClient, 'kpiSuggestion'>, input: { organizationId: string; projectId: string; donorType: DonorType; now: Date }): Promise<OrgPreferences> {
  const rows = await db.kpiSuggestion.findMany({
    where: {
      project: { organizationId: input.organizationId },
      status: { in: ['accepted', 'edited_accepted', 'rejected'] },
      decidedAt: { gte: preferenceWindowStart(input.now) },
    },
    select: {
      libraryId: true, status: true, rejectReason: true, decidedAt: true, projectId: true, method: true,
      project: { select: { donorType: true } },
    },
    orderBy: [{ decidedAt: 'desc' }, { id: 'asc' }],
    take: MAX_PREFERENCE_ROWS,
  });
  const decided: PreferenceRow[] = rows.flatMap(r => (r.decidedAt ? [{
    libraryId: r.libraryId, status: r.status, rejectReason: r.rejectReason, decidedAt: r.decidedAt,
    projectId: r.projectId, donorType: r.project.donorType, method: r.method,
  }] : []));
  return {
    rejectedLibraryIds: rejectedLibraryIdsFor(decided, { projectId: input.projectId, donorType: input.donorType }),
    preferredMethods: preferredMethodsFrom(decided),
  };
}
