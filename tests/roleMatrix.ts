import type { UserRole } from '@prisma/client';

/**
 * The role decision for every route (docs/SECURITY_SETUP.md §8). tests/roles.test.ts fails when a
 * registered route is missing here, when an entry has no route, or when a route's guard differs from its
 * entry. Add every new route with a role decision. Literal role lists on purpose: a change to
 * src/middleware/roles.ts must not silently widen access.
 *
 * - an array: `authenticate`, then `authorize(...)` with exactly these roles;
 * - 'all': any signed-in user of the organisation (`authenticate`, no role guard); donor viewers get the
 *   donor projection where the route has personal data (§8);
 * - 'self': signed in, and the route only touches the caller's own records;
 * - 'public': no sign-in (health, sign-in, refresh, password reset);
 * - 'webhook': an organisation webhook token (`authenticateWebhook` on the webhooks router);
 * - 'signed-url': a short-lived signed URL the API issued after its own check.
 */
export type Access = readonly UserRole[] | 'all' | 'public' | 'webhook' | 'signed-url' | 'self';

export const STAFF = ['org_admin', 'platform_admin', 'me_officer'] as const satisfies readonly UserRole[];
export const ADMIN = ['org_admin', 'platform_admin'] as const satisfies readonly UserRole[];
export const PA = ['platform_admin'] as const satisfies readonly UserRole[];

export const ROLE_MATRIX: Record<string, Access> = {
  // Public and token-authenticated
  'get /api/health': 'public',
  'post /api/auth/login': 'public',
  'post /api/auth/refresh': 'public',
  'post /api/auth/forgot-password': 'public',
  'post /api/auth/reset-password': 'public',
  'post /api/webhooks/manasati': 'webhook',
  'post /api/webhooks/kobotoolbox': 'webhook',
  'get /api/files/local': 'signed-url',
  // Organisation and users
  'get /api/organizations/:id': 'all',
  'patch /api/organizations/:id': ADMIN,
  'get /api/organizations/:id/webhook-tokens': ADMIN,
  'post /api/organizations/:id/webhook-tokens': ADMIN,
  'delete /api/organizations/:id/webhook-tokens/:tokenId': ADMIN,
  'get /api/users/': ADMIN,
  'post /api/users/invite': ADMIN,
  'patch /api/users/:id': ADMIN,
  'delete /api/users/:id': ADMIN,
  // Projects and documents
  'get /api/projects/': 'all',
  'post /api/projects/': ADMIN,
  'get /api/projects/:id': 'all', // donors: donor-visible documents only
  'patch /api/projects/:id': STAFF,
  'get /api/projects/:id/export': 'all', // donors: the donor export, no beneficiaries
  'delete /api/projects/:id': ADMIN,
  'get /api/projects/:id/documents': 'all', // donors: donor-visible documents only
  'post /api/projects/:id/documents': STAFF, // AI document analysis
  'get /api/documents/:id/download': 'all', // donors: 404 for hidden documents
  'delete /api/documents/:id': STAFF,
  'get /api/documents/:id/status': 'all', // donors: 404 for hidden documents
  // Frameworks, results and indicators
  'get /api/projects/:id/framework': 'all',
  'post /api/projects/:id/framework/generate': STAFF,
  'get /api/frameworks/:id/status': 'all',
  'patch /api/frameworks/:id/approve': ADMIN,
  'post /api/projects/:id/framework/manual': STAFF,
  'post /api/frameworks/:id/indicators': STAFF,
  'get /api/frameworks/:id/indicators': 'all',
  'patch /api/indicators/:id': STAFF,
  'post /api/indicators/:id/alternative': STAFF,
  'patch /api/indicators/:id/approve': ADMIN,
  'delete /api/indicators/:id': STAFF,
  'get /api/frameworks/:id/results': 'all',
  'post /api/frameworks/:id/results': STAFF,
  'patch /api/results/:id': STAFF,
  'delete /api/results/:id': STAFF,
  // Assessments, data, qualitative, reports
  'get /api/projects/:id/assessments': 'all', // donors: no AI text, price or report location
  'post /api/projects/:id/assessments': STAFF,
  'patch /api/assessments/:id': ADMIN,
  'get /api/assessments/:id/report': 'all', // donors: report null (unreviewed AI output)
  'get /api/assessments/:id/estimate': 'all',
  'get /api/indicators/:id/data': 'all', // donors: staff-entered results (no notes, author, unlisted areas); survey rows as monthly aggregates
  'post /api/indicators/:id/data': STAFF,
  'post /api/projects/:id/data/bulk': STAFF,
  'get /api/projects/:id/qualitative': 'all', // donors: type, month and participants only
  'post /api/projects/:id/qualitative': STAFF,
  'post /api/projects/:id/qualitative/upload': STAFF,
  'get /api/qualitative/:id': 'all', // donors: type, month and participants only
  'post /api/qualitative/:id/code': STAFF,
  'get /api/projects/:id/reports': 'all', // donors: published reports only
  'post /api/projects/:id/reports/generate': STAFF,
  'get /api/reports/:id': 'all', // donors: 404 for drafts
  'get /api/reports/:id/status': 'all', // donors: 404 for drafts
  // Dashboard
  'get /api/dashboard/projects/:id/dashboard': 'all', // donors: projected recent activity and areas
  'get /api/dashboard/overview': 'all',
  'get /api/dashboard/projects/:id/risks': STAFF, // runs a model on a GET
  // Notifications and templates
  'get /api/notifications/': 'self',
  'patch /api/notifications/:id/read': 'self',
  'patch /api/notifications/read-all': 'self',
  'get /api/templates/': 'all',
  'post /api/templates/': PA,
  'post /api/templates/bulk-import': PA,
  'patch /api/templates/:id': PA,
  'delete /api/templates/:id': PA,
  // Beneficiaries (personal data: records are staff only; donors get the stats summary)
  'get /api/projects/:id/beneficiaries': STAFF,
  'post /api/projects/:id/beneficiaries': STAFF,
  'get /api/beneficiaries/:id': STAFF,
  'patch /api/beneficiaries/:id': STAFF,
  'post /api/beneficiaries/:id/services': STAFF,
  'get /api/projects/:id/beneficiaries/stats': 'all', // donors: the donor summary, small counts hidden, others rounded
  // Exports
  'get /api/projects/:id/export/indicators': 'all', // donors: as for indicator data
  'get /api/projects/:id/export/beneficiaries': STAFF,
  // Indicator library (global)
  'get /api/indicator-library/': 'all',
  'get /api/indicator-library/:id': 'all',
};

/** Routes that call (or will soon call) an AI model. None may be open to donor viewers. */
export const AI_ROUTES: ReadonlySet<string> = new Set([
  'post /api/projects/:id/documents', // document analysis
  'post /api/projects/:id/framework/generate',
  'post /api/indicators/:id/alternative',
  'post /api/projects/:id/assessments',
  'post /api/projects/:id/qualitative',
  'post /api/projects/:id/qualitative/upload',
  'post /api/qualitative/:id/code',
  'post /api/projects/:id/reports/generate',
  'get /api/dashboard/projects/:id/risks',
]);

/** Non-GET routes allowed without `authorize`, with the reason. The roles test fails if this list changes without review. */
export const NON_GET_WITHOUT_AUTHORIZE: Readonly<Record<string, string>> = {
  'post /api/auth/login': 'before sign-in; authLimiter',
  'post /api/auth/refresh': 'refresh token',
  'post /api/auth/forgot-password': 'before sign-in; authLimiter',
  'post /api/auth/reset-password': 'reset token',
  'post /api/webhooks/manasati': 'organisation webhook token (authenticateWebhook)',
  'post /api/webhooks/kobotoolbox': 'organisation webhook token (authenticateWebhook)',
  'patch /api/notifications/:id/read': "the caller's own notifications only (userId filter)",
  'patch /api/notifications/read-all': "the caller's own notifications only (userId filter)",
};
