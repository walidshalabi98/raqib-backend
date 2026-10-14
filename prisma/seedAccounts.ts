import { PASSWORD_PROBLEM_MESSAGES, passwordProblems } from '../src/utils/passwordPolicy';

/**
 * Who the dev seed creates and with which password (prisma/seed.ts). Pure, so tests/seedAccounts.test.ts can
 * check every case without a database.
 *
 * - Local development without SEED_PASSWORD: the three demo accounts share the documented demo password, on a
 *   laptop only.
 * - With SEED_PASSWORD (required anywhere else, such as staging): only the org admin gets it, and it must meet
 *   the password policy for every seeded account. The M&E officer and the donor viewer get a random password
 *   nobody knows: the admin hands each tester their own one-time temporary password from Settings → Team members
 *   → Reset password, so whoever has the donor or officer login never knows the admin's password.
 */

export const SEED_ORGANISATION_NAME = 'Momentum Labs';

export const SEED_ACCOUNTS = {
  admin: 'admin@momentumlabs.ps',
  officer: 'me@momentumlabs.ps',
  donor: 'donor@momentumlabs.ps',
} as const;

/** The local-only demo password (README), used only under NODE_ENV=development without SEED_PASSWORD. */
export const DEV_DEMO_PASSWORD = 'admin123';

export type SeedPasswordPlan =
  | { kind: 'refuse'; reason: string }
  /** Local development: every demo account signs in with `password`. */
  | { kind: 'sharedDemo'; password: string }
  /** SEED_PASSWORD: the org admin signs in with `password`; the other accounts have no usable password yet. */
  | { kind: 'adminOnly'; password: string };

export function seedPasswordPlan(nodeEnv: string, seedPassword: string | undefined): SeedPasswordPlan {
  if (nodeEnv === 'production') {
    return { kind: 'refuse', reason: 'NODE_ENV is "production". The seed deletes all existing data.' };
  }
  if (!seedPassword) {
    if (nodeEnv === 'development') return { kind: 'sharedDemo', password: DEV_DEMO_PASSWORD };
    return { kind: 'refuse', reason: 'set SEED_PASSWORD (the org admin\'s password) when NODE_ENV is not "development".' };
  }
  const problems = new Set(Object.values(SEED_ACCOUNTS).flatMap(email =>
    passwordProblems(seedPassword, { email, organizationName: SEED_ORGANISATION_NAME })));
  if (problems.size > 0) {
    const reasons = [...problems].map(problem => PASSWORD_PROBLEM_MESSAGES[problem].replace(/^The new password/, 'SEED_PASSWORD'));
    return { kind: 'refuse', reason: `SEED_PASSWORD does not meet the password policy (docs/SECURITY_SETUP.md §9): ${reasons.join(' ')}` };
  }
  return { kind: 'adminOnly', password: seedPassword };
}
