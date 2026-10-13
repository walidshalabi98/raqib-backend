import { UserRole } from '@prisma/client';

/**
 * Role groups used by `authorize(...)` and by the donor projections (docs/SECURITY_SETUP.md §8).
 * tests/roles.test.ts holds the role decision for every route.
 */

/** May write, run AI features and see beneficiary-level personal data. */
export const STAFF_ROLES = ['org_admin', 'platform_admin', 'me_officer'] as const satisfies readonly UserRole[];

/** Organisation settings, users, approvals, project create/archive. */
export const ADMIN_ROLES = ['org_admin', 'platform_admin'] as const satisfies readonly UserRole[];

/** The global template library. */
export const PLATFORM_ROLES = ['platform_admin'] as const satisfies readonly UserRole[];

const STAFF: ReadonlySet<string> = new Set(STAFF_ROLES);

/**
 * Deny by default: true only for a known staff role. donor_viewer, a missing role or any other value →
 * false, so the caller gets the donor (personal-data-free) view. (`authenticate` already refuses access
 * tokens without an organisation or a role; this is the second line.)
 */
export function hasStaffRole(user: { role?: unknown } | null | undefined): boolean {
  const role = user?.role;
  return typeof role === 'string' && STAFF.has(role);
}
