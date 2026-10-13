import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { DEV_DEMO_PASSWORD, SEED_ACCOUNTS, seedPasswordPlan } from '../prisma/seedAccounts';

/**
 * The dev seed's accounts (SR-4): outside local development SEED_PASSWORD must meet the password policy and is
 * the org admin's alone; the other accounts get passwords nobody knows, handed out later by an admin reset.
 */

describe('seedPasswordPlan', () => {
  it('never runs in production', () => {
    expect(seedPasswordPlan('production', 'Olive-grove-staging-7')).toMatchObject({ kind: 'refuse', reason: expect.stringMatching(/production/) });
  });

  it('local development without SEED_PASSWORD: the shared demo password', () => {
    expect(seedPasswordPlan('development', undefined)).toEqual({ kind: 'sharedDemo', password: DEV_DEMO_PASSWORD });
    expect(seedPasswordPlan('development', '')).toEqual({ kind: 'sharedDemo', password: DEV_DEMO_PASSWORD });
  });

  it('anywhere else SEED_PASSWORD is required', () => {
    expect(seedPasswordPlan('test', undefined)).toMatchObject({ kind: 'refuse', reason: expect.stringMatching(/SEED_PASSWORD/) });
  });

  it('a policy-compliant SEED_PASSWORD becomes the org admin\'s password only', () => {
    for (const nodeEnv of ['test', 'development']) {
      expect(seedPasswordPlan(nodeEnv, 'Olive-grove-staging-7')).toEqual({ kind: 'adminOnly', password: 'Olive-grove-staging-7' });
    }
  });

  it.each([
    ['shorter than 10 characters (the old 8-character minimum)', 'Olive-gr7'],
    ['containing "admin" (the admin email name)', 'admin2026xyz'],
    ['containing "donor" (another seeded account)', 'my-donor-key-7'],
    ['containing the organisation or product name', 'Momentum2026'],
    ['a common password', 'Password2026!'],
    ['one repeated character', 'xxxxxxxxxxxx'],
  ])('refuses a SEED_PASSWORD %s, and says why without repeating it', (_label, seedPassword) => {
    const plan = seedPasswordPlan('test', seedPassword);
    expect(plan.kind).toBe('refuse');
    if (plan.kind !== 'refuse') return;
    expect(plan.reason).toMatch(/^SEED_PASSWORD does not meet the password policy/);
    expect(plan.reason).not.toContain(seedPassword);
  });

  it('seeds the three demo accounts', () => {
    expect(Object.values(SEED_ACCOUNTS)).toEqual(['admin@momentumlabs.ps', 'me@momentumlabs.ps', 'donor@momentumlabs.ps']);
  });
});

describe('prisma/seed.ts', () => {
  const seed = readFileSync(path.join(__dirname, '../prisma/seed.ts'), 'utf8');

  it('uses the plan, never one shared hash outside development, and never prints SEED_PASSWORD', () => {
    expect(seed).toContain('seedPasswordPlan(nodeEnv, process.env.SEED_PASSWORD)');
    expect(seed).toContain('passwordHash: adminHash');
    expect(seed.match(/passwordHash: await otherHash\(\)/g)).toHaveLength(2);
    expect(seed).toContain("passwordPlan.kind === 'sharedDemo' ? hashPassword(passwordPlan.password) : unusablePasswordHash()");
    expect(seed).not.toMatch(/console\.\w+\([^)]*SEED_PASSWORD\}/);
    // The password is printed only for the local demo password (development without SEED_PASSWORD).
    const printed = [...seed.matchAll(/\$\{passwordPlan\.password\}/g)].map(match => match.index!);
    const demoBranch = seed.indexOf("if (passwordPlan.kind === 'sharedDemo') {\n    console.log");
    const otherBranch = seed.indexOf('} else {', demoBranch);
    expect(printed).toHaveLength(3);
    for (const at of printed) expect(at > demoBranch && at < otherBranch).toBe(true);
  });
});
