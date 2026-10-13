/**
 * Donor viewers see approved indicators only, never raw suggestions or unreviewed AI indicators
 * (knowledge/kpi-assistant-spec.md §A1 "As a donor viewer, I see only approved indicators, never raw
 * suggestions"; docs/BUILD_GUIDE.md §2 "Donor viewer: read-only access to approved indicators and reports";
 * design section 4.7).
 *
 * The rule in one place, so every read applies it the same way: for a donor viewer, a response leaves out
 * unapproved indicators and the rows that belong to them (their data points, beneficiary services linked to
 * them) and every figure a dashboard computes from those rows. Plain record counts (`_count.*` on projects and
 * result nodes, beneficiary `serviceCount`) and report narratives are not filtered (docs/DATA_MODEL.md §12).
 * Every other role sees every indicator of its own organisation (organisation isolation is separate:
 * src/middleware/access.ts, CLAUDE.md rule 1).
 */
import type { Prisma, UserRole } from '@prisma/client';

/** The role that only ever sees approved indicators (spec §A1). */
const APPROVED_ONLY_ROLE: UserRole = 'donor_viewer';

/**
 * True when this user may only see approved indicators (a donor viewer). A missing user is treated as a donor
 * viewer, so a route that forgets `authenticate` fails closed. Spec §A1.
 */
function approvedOnly(user: { role: UserRole } | undefined): boolean {
  return !user || user.role === APPROVED_ONLY_ROLE;
}

/**
 * The indicator filter for a read made by `user`: `{ isApproved: true }` for a donor viewer, `{}` for every other
 * role (me-foundations §1 glossary "KPI"; spec §A1: donor viewers see approved indicators only). Spread it into an
 * indicator `where` (`{ frameworkId, ...indicatorVisibilityWhere(req.user) }`) or use it as a relation filter.
 */
export function indicatorVisibilityWhere(user: { role: UserRole } | undefined): Prisma.IndicatorWhereInput {
  return approvedOnly(user) ? { isApproved: true } : {};
}

/**
 * The data point filter for a read made by `user`: data points of approved indicators only for a donor viewer,
 * `{}` (no condition, no join) for every other role. Spec §A1; design section 4.7 (dashboard recent activity).
 */
export function dataPointVisibilityWhere(user: { role: UserRole } | undefined): Prisma.DataPointWhereInput {
  return approvedOnly(user) ? { indicator: indicatorVisibilityWhere(user) } : {};
}

/**
 * Whether `user` may see this indicator: always for every role but donor viewer; for a donor viewer only when the
 * indicator is approved (spec §A1). Routes answer 404 "Indicator not found" otherwise, as for another
 * organisation's id, so unapproved ids cannot be probed.
 */
export function canSeeIndicator(user: { role: UserRole } | undefined, indicator: { isApproved: boolean }): boolean {
  return !approvedOnly(user) || indicator.isApproved;
}
