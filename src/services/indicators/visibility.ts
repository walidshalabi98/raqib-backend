/**
 * Donor viewers see approved indicators only, never raw suggestions or unreviewed AI indicators
 * (knowledge/kpi-assistant-spec.md §A1; design section 4.7).
 *
 * Step 0 stub (Phase 4 contracts): signatures are final; E1 implements the bodies.
 */
import type { Prisma, UserRole } from '@prisma/client';

/** me-foundations / spec §A1: donor viewers see approved indicators only. {} for every other role. */
export function indicatorVisibilityWhere(_user: { role: UserRole } | undefined): Prisma.IndicatorWhereInput {
  throw new Error('Phase 4: not implemented (E1)');
}

export function canSeeIndicator(_user: { role: UserRole } | undefined, _indicator: { isApproved: boolean }): boolean {
  throw new Error('Phase 4: not implemented (E1)');
}
