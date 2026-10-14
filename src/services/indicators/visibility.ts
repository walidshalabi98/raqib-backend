/**
 * Donor viewers see approved indicators only, never raw suggestions or unreviewed AI indicators
 * (knowledge/kpi-assistant-spec.md §A1 "As a donor viewer, I see only approved indicators, never raw
 * suggestions"; docs/BUILD_GUIDE.md §2 "Donor viewer: read-only access to approved indicators and reports";
 * design section 4.7).
 *
 * The rule in one place, so every read applies it the same way: for a donor viewer, a response leaves out
 * unapproved indicators and the rows that belong to them (their data points) and every figure a dashboard
 * computes from those rows. Plain record counts (`_count.*` on projects and result nodes, beneficiary
 * `serviceCount`) and report narratives are not filtered by approval (docs/DATA_MODEL.md §12); the donor
 * projections of src/services/privacy/donorView.ts apply on top (docs/SECURITY_SETUP.md §8).
 * Staff roles (STAFF_ROLES) see every indicator of their own organisation (organisation isolation is separate:
 * src/middleware/access.ts, CLAUDE.md rule 1).
 */
import type { Prisma } from '@prisma/client';
import { hasStaffRole } from '../../middleware/roles';

/** The caller as the visibility rule sees it: only the role matters. */
type Viewer = { role?: unknown } | null | undefined;

/**
 * True when this user may only see approved indicators. Deny by default (docs/SECURITY_SETUP.md §8): every caller
 * without a known staff role (src/middleware/roles.ts STAFF_ROLES) is treated as a donor viewer, so a donor viewer,
 * a token without a role or a route that forgets `authenticate` all fail closed. Spec §A1.
 */
function approvedOnly(user: Viewer): boolean {
  return !hasStaffRole(user);
}

/**
 * The indicator filter for a read made by `user`: `{ isApproved: true }` for a donor viewer (or any caller without a
 * staff role), `{}` for staff (me-foundations §1 glossary "KPI"; spec §A1: donor viewers see approved indicators only). Spread it into an
 * indicator `where` (`{ frameworkId, ...indicatorVisibilityWhere(req.user) }`) or use it as a relation filter.
 */
export function indicatorVisibilityWhere(user: Viewer): Prisma.IndicatorWhereInput {
  return approvedOnly(user) ? { isApproved: true } : {};
}

/**
 * The data point filter for a read made by `user`: data points of approved indicators only for a donor viewer,
 * `{}` (no condition, no join) for staff. Spec §A1; design section 4.7 (dashboard recent activity).
 */
export function dataPointVisibilityWhere(user: Viewer): Prisma.DataPointWhereInput {
  return approvedOnly(user) ? { indicator: indicatorVisibilityWhere(user) } : {};
}

/**
 * Whether `user` may see this indicator: always for staff; for a donor viewer (or any caller without a staff role)
 * only when the indicator is approved (spec §A1). Routes answer 404 "Indicator not found" otherwise, as for another
 * organisation's id, so unapproved ids cannot be probed.
 */
export function canSeeIndicator(user: Viewer, indicator: { isApproved: boolean }): boolean {
  return !approvedOnly(user) || indicator.isApproved;
}
