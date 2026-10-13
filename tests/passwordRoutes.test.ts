import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Resend is never called for real: the fake records every email and answers as each test says.
const send = vi.hoisted(() => vi.fn());
vi.mock('resend', () => ({
  Resend: class {
    emails = { send };
  },
}));

import app from '../src/app';
import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { generateAccessToken, generateRefreshToken, generateResetToken, passwordFingerprint, RESET_TOKEN_AUDIENCE } from '../src/utils/tokens';
import { bearer, createOrgFixture, hasTestDatabase, OrgFixture, resetDatabase } from './helpers';

/**
 * Sign-in gaps closed for staging (owner approval of 13 October 2026): invite and admin reset show a temporary
 * password once when email is off (or the email failed), change password, single-use reset links, sessions that
 * end when the password changes, and nothing secret in any log line, audit row or email (docs/SECURITY_SETUP.md §9).
 */

type User = OrgFixture['admin'];

/** Every console line written while this file runs. */
const lines: string[] = [];
/** Every password, token and link this file saw: none may appear in a console line or an audit row. */
const secrets = new Set<string>();
const keep = <T extends string>(value: T): T => { secrets.add(value); return value; };

const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/;
const ALPHABET = /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789]{16}$/;

async function setPassword(user: { id: string }, password: string): Promise<string> {
  const passwordHash = await bcrypt.hash(keep(password), 4);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
  return passwordHash;
}

const hashOf = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).passwordHash;
const login = (email: string, password: string) => request(app).post('/api/auth/login').send({ email, password });
const changePassword = (auth: string, body: object) => request(app).post('/api/auth/change-password').set('Authorization', auth).send(body);
const resetWithLink = (token: string, newPassword: string) => request(app).post('/api/auth/reset-password').send({ token, newPassword: keep(newPassword) });
const adminReset = (auth: string, id: string) => request(app).post(`/api/users/${id}/reset-password`).set('Authorization', auth);
const refresh = (refreshToken: string) => request(app).post('/api/auth/refresh').send({ refreshToken });

/** Signs in and returns the session's tokens (kept as secrets). */
async function signIn(email: string, password: string): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await login(email, password);
  expect(res.status, email).toBe(200);
  return { accessToken: keep(res.body.accessToken), refreshToken: keep(res.body.refreshToken) };
}

/** The set-password link in an email's HTML: its token, which is what the reset page posts. */
function emailedToken(html: string): string {
  const match = new RegExp(`href="${env.appUrl}/reset-password\\?token=([^"]+)"`).exec(html);
  expect(match).not.toBeNull();
  keep(match![0]);
  return keep(decodeURIComponent(match![1]));
}

/** A reset link for the user's current password, as forgot-password would email it. */
async function resetLink(user: { id: string }): Promise<string> {
  return keep(generateResetToken({ id: user.id, passwordHash: await hashOf(user.id) }));
}

function emailOn() {
  beforeEach(() => {
    env.resendApiKey = 're_test_not_a_real_key';
    send.mockReset();
    send.mockResolvedValue({ data: { id: 'email-1' }, error: null });
  });
  afterEach(() => {
    env.resendApiKey = '';
  });
}

describe.skipIf(!hasTestDatabase)('passwords and sign-in', () => {
  let a: OrgFixture;
  let b: OrgFixture;
  let platformA: User;
  let platformB: User;

  beforeAll(async () => {
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    }
    env.resendApiKey = '';
    await resetDatabase();
    a = await createOrgFixture('a');
    b = await createOrgFixture('b');
    platformA = await prisma.user.create({
      data: { organizationId: a.org.id, email: 'platform-a@example.org', passwordHash: 'x', fullName: 'Platform a', role: 'platform_admin' },
    });
    platformB = await prisma.user.create({
      data: { organizationId: b.org.id, email: 'platform-b@example.org', passwordHash: 'x', fullName: 'Platform b', role: 'platform_admin' },
    });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  describe('POST /api/users/invite', () => {
    it('without email: 201 with the temporary password once (no-store), emailSent false; the invitee can sign in with it', async () => {
      const res = await request(app).post('/api/users/invite').set('Authorization', a.adminAuth)
        .send({ email: 'new-officer@example.org', fullName: 'New officer', role: 'me_officer' });
      expect(res.status).toBe(201);
      expect(Object.keys(res.body).sort()).toEqual(['createdAt', 'email', 'emailSent', 'fullName', 'id', 'role', 'temporaryPassword']);
      expect(res.body).toMatchObject({ email: 'new-officer@example.org', role: 'me_officer', emailSent: false });
      expect(res.headers['cache-control']).toBe('no-store');
      const temporaryPassword = keep(res.body.temporaryPassword as string);
      expect(temporaryPassword).toMatch(ALPHABET);

      expect((await login('new-officer@example.org', temporaryPassword)).status).toBe(200);
      expect(lines).toContain(`[Email] invite not sent: email is not configured (user ${res.body.id})`);
      expect(send).not.toHaveBeenCalled();
    });

    it('gives every invitee a different password', async () => {
      const passwords = [];
      for (const email of ['donor-x@example.org', 'donor-y@example.org']) {
        const res = await request(app).post('/api/users/invite').set('Authorization', a.adminAuth)
          .send({ email, fullName: 'Donor', role: 'donor_viewer' });
        expect(res.status).toBe(201);
        passwords.push(keep(res.body.temporaryPassword));
      }
      expect(passwords[0]).not.toBe(passwords[1]);
    });

    it('refuses missing fields, an unknown role, an existing email and (for org admins) the platform admin role', async () => {
      const invite = (body: object) => request(app).post('/api/users/invite').set('Authorization', a.adminAuth).send(body);
      expect((await invite({ email: 'z@example.org', fullName: 'Z' })).status).toBe(400);
      expect((await invite({ email: { contains: '@' }, fullName: 'Z', role: 'me_officer' })).status).toBe(400);
      expect((await invite({ email: 'z@example.org', fullName: 'Z', role: 'admin' })).body).toEqual({ message: 'Unknown role' });
      expect((await invite({ email: a.officer.email, fullName: 'Z', role: 'me_officer' })).status).toBe(409);
      expect((await invite({ email: 'z@example.org', fullName: 'Z', role: 'platform_admin' })).status).toBe(403);
      expect(await prisma.user.count({ where: { email: 'z@example.org' } })).toBe(0);
    });

    it('M&E officers and donor viewers get 403 and nobody is created', async () => {
      for (const auth of [a.officerAuth, a.donorAuth]) {
        const res = await request(app).post('/api/users/invite').set('Authorization', auth)
          .send({ email: 'sneaky@example.org', fullName: 'Sneaky', role: 'org_admin' });
        expect(res.status).toBe(403);
        expect(res.body.temporaryPassword).toBeUndefined();
      }
      expect(await prisma.user.count({ where: { email: 'sneaky@example.org' } })).toBe(0);
    });

    describe('with email configured', () => {
      emailOn();

      it('emails a single-use link to choose a password, never a password; the answer holds none: emailSent true', async () => {
        const res = await request(app).post('/api/users/invite').set('Authorization', a.adminAuth)
          .send({ email: 'mailed@example.org', fullName: 'Mailed', role: 'me_officer' });
        expect(res.status).toBe(201);
        expect(res.body.emailSent).toBe(true);
        expect(res.body).not.toHaveProperty('temporaryPassword');
        expect(send).toHaveBeenCalledOnce();
        const message = send.mock.calls[0][0];
        expect(message).toMatchObject({ to: 'mailed@example.org', from: 'Raqib by Momentum Labs <noreply@raqib.momentumlabs.ps>' });
        expect(message.html).not.toMatch(/temporary password|<strong>/i);
        const token = emailedToken(message.html);
        expect((await resetWithLink(token, 'Olive-first-pw-1')).status).toBe(200);
        expect((await login('mailed@example.org', 'Olive-first-pw-1')).status).toBe(200);
        expect((await resetWithLink(token, 'Olive-second-pw-2')).status).toBe(401);
      });

      it('a Resend error: emailSent false, and the temporary password once instead (no-store), so the account is usable', async () => {
        send.mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'The domain is not verified' } });
        const res = await request(app).post('/api/users/invite').set('Authorization', a.adminAuth)
          .send({ email: 'bounced@example.org', fullName: 'Bounced', role: 'me_officer' });
        expect(res.status).toBe(201);
        expect(res.body.emailSent).toBe(false);
        expect(res.headers['cache-control']).toBe('no-store');
        const temporaryPassword = keep(res.body.temporaryPassword as string);
        expect(temporaryPassword).toMatch(ALPHABET);
        emailedToken(send.mock.calls[0][0].html);
        expect((await login('bounced@example.org', temporaryPassword)).status).toBe(200);
        expect(lines).toContain(`[Email] invite not sent: Resend error validation_error (user ${res.body.id})`);
      });
    });
  });

  describe('POST /api/users/:id/reset-password', () => {
    it('an org admin resets an officer: a new temporary password once; the old password and older reset links stop working', async () => {
      await setPassword(a.officer, 'Officer-old-password-1');
      const olderLink = await resetLink(a.officer);

      const res = await adminReset(a.adminAuth, a.officer.id);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['emailSent', 'id', 'temporaryPassword']);
      expect(res.body).toMatchObject({ id: a.officer.id, emailSent: false });
      expect(res.headers['cache-control']).toBe('no-store');
      const temporaryPassword = keep(res.body.temporaryPassword as string);
      expect(temporaryPassword).toMatch(ALPHABET);

      expect((await login(a.officer.email, 'Officer-old-password-1')).status).toBe(401);
      expect((await login(a.officer.email, temporaryPassword)).status).toBe(200);
      const link = await resetWithLink(olderLink, 'Brand-new-password-1');
      expect(link.status).toBe(401);
      expect(link.body.code).toBe('reset_link_invalid');
      expect(lines).toContain(`[Email] admin reset not sent: email is not configured (user ${a.officer.id})`);
    });

    it('a second reset gives another password', async () => {
      const first = keep((await adminReset(a.adminAuth, a.donor.id)).body.temporaryPassword);
      const second = keep((await adminReset(a.adminAuth, a.donor.id)).body.temporaryPassword);
      expect(first).not.toBe(second);
      expect((await login(a.donor.email, first)).status).toBe(401);
      expect((await login(a.donor.email, second)).status).toBe(200);
    });

    it('an org admin cannot reset a platform admin (403, unchanged); a platform admin can reset an org admin', async () => {
      const before = await hashOf(platformA.id);
      const refused = await adminReset(a.adminAuth, platformA.id);
      expect(refused.status).toBe(403);
      expect(refused.body.temporaryPassword).toBeUndefined();
      expect(await hashOf(platformA.id)).toBe(before);

      const allowed = await adminReset(bearer(platformA), a.admin.id);
      expect(allowed.status).toBe(200);
      expect((await login(a.admin.email, keep(allowed.body.temporaryPassword))).status).toBe(200);
    });

    it('refuses the caller\'s own account: use change password (400)', async () => {
      for (const user of [a.admin, platformA]) {
        const before = await hashOf(user.id);
        const res = await adminReset(bearer(user), user.id);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ message: 'Use Change password for your own account.', code: 'use_change_password' });
        expect(await hashOf(user.id)).toBe(before);
      }
    });

    it('organisation isolation first: another organisation\'s user answers 404 whatever the roles, and an unknown id too', async () => {
      const beforeB = await Promise.all([b.officer.id, b.admin.id, platformB.id].map(hashOf));
      for (const [auth, target] of [
        [a.adminAuth, b.officer.id], [a.adminAuth, platformB.id], [bearer(platformA), b.admin.id], [bearer(platformA), platformB.id],
        [a.adminAuth, '00000000-0000-0000-0000-000000000000'], [a.adminAuth, 'not-a-uuid'],
      ]) {
        const res = await adminReset(auth, target);
        expect(res.status, target).toBe(404);
        expect(res.body).toEqual({ message: 'User not found' });
      }
      expect(await Promise.all([b.officer.id, b.admin.id, platformB.id].map(hashOf))).toEqual(beforeB);
    });

    it('M&E officers and donor viewers get 403 and nothing changes', async () => {
      const before = await hashOf(a.admin.id);
      for (const auth of [a.officerAuth, a.donorAuth]) {
        const res = await adminReset(auth, a.admin.id);
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ message: 'Insufficient permissions' });
      }
      expect(await hashOf(a.admin.id)).toBe(before);
    });

    describe('with email configured', () => {
      emailOn();

      it('emails a single-use link to choose a new password, never a password: emailSent true', async () => {
        await setPassword(a.officer, 'Officer-before-reset-1');
        const res = await adminReset(a.adminAuth, a.officer.id);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ id: a.officer.id, emailSent: true });
        expect(send).toHaveBeenCalledOnce();
        const message = send.mock.calls[0][0];
        expect(message.to).toBe(a.officer.email);
        expect(message.html).not.toMatch(/temporary password|<strong>/i);
        expect((await login(a.officer.email, 'Officer-before-reset-1')).status).toBe(401);
        const token = emailedToken(message.html);
        expect((await resetWithLink(token, 'Officer-after-reset-2')).status).toBe(200);
        expect((await login(a.officer.email, 'Officer-after-reset-2')).status).toBe(200);
        expect(lines).toContain(`[Email] admin reset sent (user ${a.officer.id})`);
      });

      it('a failed email: emailSent false and the temporary password once instead', async () => {
        send.mockRejectedValue(new TypeError('fetch failed'));
        const res = await adminReset(a.adminAuth, a.donor.id);
        expect(res.status).toBe(200);
        expect(res.body.emailSent).toBe(false);
        expect(res.headers['cache-control']).toBe('no-store');
        expect((await login(a.donor.email, keep(res.body.temporaryPassword))).status).toBe(200);
        emailedToken(send.mock.calls[0][0].html);
        expect(lines).toContain(`[Email] admin reset not sent: TypeError (user ${a.donor.id})`);
      });
    });
  });

  describe('POST /api/auth/change-password', () => {
    it.each([
      ['an org admin', () => a.admin],
      ['an M&E officer', () => a.officer],
      ['a donor viewer', () => a.donor],
      ['a platform admin', () => platformA],
    ] as const)('%s changes their own password: 200 with a new token pair (no-store); the new one signs in, the old one no longer does', async (_label, who) => {
      const user = who();
      const fresh = keep(`Fresh-secret-${user.id.slice(0, 8)}-9`);
      await setPassword(user, `Current-password-${user.role}`);
      const res = await changePassword(bearer(user), { currentPassword: `Current-password-${user.role}`, newPassword: fresh });
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'refreshToken']);
      expect(res.headers['cache-control']).toBe('no-store');
      keep(res.body.accessToken);
      keep(res.body.refreshToken);
      // The caller's session continues with the new pair.
      expect((await request(app).get('/api/projects').set('Authorization', `Bearer ${res.body.accessToken}`)).status).toBe(200);
      expect((await refresh(res.body.refreshToken)).status).toBe(200);
      expect((await login(user.email, fresh)).status).toBe(200);
      expect((await login(user.email, `Current-password-${user.role}`)).status).toBe(401);
    });

    it('a wrong current password answers 400 with a clear message, and nothing changes', async () => {
      const hash = await setPassword(a.officer, 'Officer-current-pw-1');
      const res = await changePassword(a.officerAuth, { currentPassword: keep('Not-the-password-1'), newPassword: keep('Officer-next-pw-1') });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ message: 'The current password is incorrect.', code: 'current_password_incorrect' });
      expect(await hashOf(a.officer.id)).toBe(hash);
    });

    it.each([
      ['too short', 'Short-1', 'password_too_short'],
      ['too long', 'L'.repeat(201), 'password_too_long'],
      ['the current password', 'Officer-current-pw-1', 'password_same_as_current'],
      ['the email local part', 'my-ME-A-password-1', 'password_contains_email'],
      ['only spaces', ' '.repeat(12), 'password_too_simple'],
      ['one repeated character', 'zzzzzzzzzzzz', 'password_too_simple'],
      ['a common password', 'Password2026!', 'password_too_common'],
      ['the product name', 'Raqib-staging-2026', 'password_too_common'],
      ['the organisation name', 'my-ORG-A-key-2026', 'password_too_common'],
    ])('a new password that is %s answers 400 with its code, and nothing changes', async (_label, newPassword, code) => {
      const hash = await setPassword(a.officer, 'Officer-current-pw-1');
      const res = await changePassword(a.officerAuth, { currentPassword: 'Officer-current-pw-1', newPassword: keep(newPassword) });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(code);
      expect(res.body.message).toMatch(/^The new password/);
      expect(await hashOf(a.officer.id)).toBe(hash);
    });

    it('needs both fields as strings', async () => {
      for (const body of [{}, { currentPassword: 'Officer-current-pw-1' }, { newPassword: 'Officer-next-pw-1' }, { currentPassword: 1, newPassword: ['x'] }]) {
        const res = await changePassword(a.officerAuth, body);
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Current password and new password are required');
      }
    });

    it('needs a valid access token: none, a reset token, or a token whose organisation is not the user\'s answer 401', async () => {
      await setPassword(a.officer, 'Officer-current-pw-1');
      const body = { currentPassword: 'Officer-current-pw-1', newPassword: keep('Officer-hijack-pw-1') };
      expect((await request(app).post('/api/auth/change-password').send(body)).status).toBe(401);
      expect((await changePassword(`Bearer ${await resetLink(a.officer)}`, body)).status).toBe(401);
      const otherOrg = `Bearer ${generateAccessToken({
        id: a.officer.id, email: a.officer.email, organizationId: b.org.id, role: 'me_officer', fullName: a.officer.fullName,
      })}`;
      expect((await changePassword(otherOrg, body)).status).toBe(401);
      expect((await login(a.officer.email, 'Officer-current-pw-1')).status).toBe(200);
    });

    it('an older reset link stops working after a change', async () => {
      await setPassword(a.officer, 'Officer-current-pw-1');
      const link = await resetLink(a.officer);
      expect((await changePassword(a.officerAuth, { currentPassword: 'Officer-current-pw-1', newPassword: keep('Officer-changed-pw-2') })).status).toBe(200);
      const res = await resetWithLink(link, 'Officer-from-link-pw-3');
      expect(res.status).toBe(401);
      expect((await login(a.officer.email, 'Officer-changed-pw-2')).status).toBe(200);
    });
  });

  describe('POST /api/auth/forgot-password', () => {
    it('gives the same answer for known and unknown addresses; without email it sends nothing and logs the user id only', async () => {
      const from = lines.length;
      const known = await request(app).post('/api/auth/forgot-password').send({ email: a.officer.email });
      const unknown = await request(app).post('/api/auth/forgot-password').send({ email: 'nobody@example.org' });
      expect(known.status).toBe(200);
      expect(unknown.status).toBe(200);
      expect(known.body).toEqual(unknown.body);
      expect(known.body).toEqual({ message: 'If an account exists with that email, a reset link has been sent.' });
      await vi.waitFor(() => expect(lines.slice(from)).toContain(`[Email] password reset not sent: email is not configured (user ${a.officer.id})`));
      expect(lines.slice(from).filter(line => line.startsWith('[Email]'))).toHaveLength(1);
      expect(send).not.toHaveBeenCalled();
    });

    it('needs an email', async () => {
      expect((await request(app).post('/api/auth/forgot-password').send({})).status).toBe(400);
      expect((await request(app).post('/api/auth/forgot-password').send({ email: { not: 'x' } })).status).toBe(400);
    });

    describe('with email configured', () => {
      emailOn();

      it('emails a link to APP_URL/reset-password that works once', async () => {
        await setPassword(a.officer, 'Officer-forgot-pw-1');
        const res = await request(app).post('/api/auth/forgot-password').send({ email: a.officer.email });
        expect(res.status).toBe(200);
        await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
        const message = send.mock.calls[0][0];
        expect(message.to).toBe(a.officer.email);
        const match = new RegExp(`href="${env.appUrl}/reset-password\\?token=([^"]+)"`).exec(message.html);
        expect(match).not.toBeNull();
        const token = keep(decodeURIComponent(match![1]));
        keep(match![0]);

        expect((await resetWithLink(token, 'Officer-via-email-pw-2')).status).toBe(200);
        const again = await resetWithLink(token, 'Officer-via-email-pw-3');
        expect(again.status).toBe(401);
        expect((await login(a.officer.email, 'Officer-via-email-pw-2')).status).toBe(200);
        expect(lines).toContain(`[Email] password reset sent (user ${a.officer.id})`);
      });

      it('sends nothing for an unknown address', async () => {
        const res = await request(app).post('/api/auth/forgot-password').send({ email: 'nobody@example.org' });
        expect(res.status).toBe(200);
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(send).not.toHaveBeenCalled();
      });
    });
  });

  describe('POST /api/auth/reset-password', () => {
    it('a link works once: the second use answers 401 reset_link_invalid', async () => {
      await setPassword(a.donor, 'Donor-current-pw-1');
      const link = await resetLink(a.donor);
      const first = await resetWithLink(link, 'Donor-new-pw-2');
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ message: 'Password has been reset successfully.' });
      const second = await resetWithLink(link, 'Donor-new-pw-3');
      expect(second.status).toBe(401);
      expect(second.body).toEqual({
        message: 'This reset link is invalid or has expired, or it was already used. Ask for a new one.', code: 'reset_link_invalid',
      });
      expect((await login(a.donor.email, 'Donor-new-pw-2')).status).toBe(200);
    });

    it('two requests at once with the same link: exactly one succeeds', async () => {
      await setPassword(a.donor, 'Donor-current-pw-1');
      const link = await resetLink(a.donor);
      const results = await Promise.all([resetWithLink(link, 'Donor-race-pw-A1'), resetWithLink(link, 'Donor-race-pw-B1')]);
      expect(results.map(r => r.status).sort()).toEqual([200, 401]);
      const winner = results[0].status === 200 ? 'Donor-race-pw-A1' : 'Donor-race-pw-B1';
      expect((await login(a.donor.email, winner)).status).toBe(200);
    });

    it.each([
      ['too short', 'Short-1', 'password_too_short'],
      ['the current password', 'Donor-current-pw-1', 'password_same_as_current'],
      ['the email local part', 'xx-DONOR-A-xx-1', 'password_contains_email'],
    ])('a new password that is %s answers 400, and the link still works afterwards', async (_label, newPassword, code) => {
      await setPassword(a.donor, 'Donor-current-pw-1');
      const link = await resetLink(a.donor);
      const res = await resetWithLink(link, newPassword);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(code);
      expect((await resetWithLink(link, 'Recovered-policy-pw-1')).status).toBe(200);
    });

    it('refuses an expired, old-style, foreign or malformed token, an access token, and a deleted user\'s link (401)', async () => {
      const hash = await setPassword(a.donor, 'Donor-current-pw-1');
      const sign = (payload: object, options: jwt.SignOptions) => keep(jwt.sign(payload, env.jwtSecret, options));
      const claims = { id: a.donor.id, purpose: 'reset', pwd: passwordFingerprint(hash) };
      const invite = await request(app).post('/api/users/invite').set('Authorization', a.adminAuth)
        .send({ email: 'leaver@example.org', fullName: 'Leaver', role: 'donor_viewer' });
      keep(invite.body.temporaryPassword);
      const leaverLink = await resetLink({ id: invite.body.id });
      expect((await request(app).delete(`/api/users/${invite.body.id}`).set('Authorization', a.adminAuth)).status).toBe(200);

      const tokens = [
        sign(claims, { expiresIn: -10, audience: RESET_TOKEN_AUDIENCE }),
        sign({ id: a.donor.id, purpose: 'reset' }, { expiresIn: '1h' }),
        sign(claims, { expiresIn: '1h' }),
        keep(jwt.sign(claims, 'another-secret-0123456789abcdef0123456789', { expiresIn: '1h', audience: RESET_TOKEN_AUDIENCE })),
        a.donorAuth.replace('Bearer ', ''),
        'not-a-token',
        leaverLink,
      ];
      for (const token of tokens) {
        const res = await resetWithLink(token, 'Donor-hijacked-pw-1');
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('reset_link_invalid');
      }
      expect(await hashOf(a.donor.id)).toBe(hash);
    });

    it('needs a token and a new password', async () => {
      expect((await request(app).post('/api/auth/reset-password').send({ token: 'x' })).status).toBe(400);
      expect((await request(app).post('/api/auth/reset-password').send({ newPassword: 'Donor-some-pw-1' })).status).toBe(400);
      expect((await request(app).post('/api/auth/reset-password').send({ token: 1, newPassword: 2 })).status).toBe(400);
    });
  });

  describe('sessions end when the password changes (SR-1)', () => {
    it('a session keeps working while the password stays: refresh rotates the pair', async () => {
      await setPassword(a.officer, 'Officer-session-pw-1');
      const session = await signIn(a.officer.email, 'Officer-session-pw-1');
      const first = await refresh(session.refreshToken);
      expect(first.status).toBe(200);
      const second = await refresh(keep(first.body.refreshToken));
      expect(second.status).toBe(200);
      keep(second.body.accessToken);
      keep(second.body.refreshToken);
    });

    it('an admin reset ends every session of the account (a stolen refresh token stops working)', async () => {
      await setPassword(a.officer, 'Officer-session-pw-1');
      const session = await signIn(a.officer.email, 'Officer-session-pw-1');
      const rotated = keep((await refresh(session.refreshToken)).body.refreshToken);
      const reset = await adminReset(a.adminAuth, a.officer.id);
      expect(reset.status).toBe(200);
      keep(reset.body.temporaryPassword);
      for (const token of [session.refreshToken, rotated]) {
        const res = await refresh(token);
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ message: 'Your session has ended. Sign in again.', code: 'session_ended' });
      }
    });

    it('change password ends the other sessions; the caller continues with the pair it got back', async () => {
      await setPassword(a.officer, 'Officer-session-pw-1');
      const phone = await signIn(a.officer.email, 'Officer-session-pw-1');
      const laptop = await signIn(a.officer.email, 'Officer-session-pw-1');
      const res = await changePassword(`Bearer ${laptop.accessToken}`, { currentPassword: 'Officer-session-pw-1', newPassword: keep('Officer-session-pw-2') });
      expect(res.status).toBe(200);
      expect((await refresh(phone.refreshToken)).status).toBe(401);
      expect((await refresh(laptop.refreshToken)).status).toBe(401);
      expect((await refresh(keep(res.body.refreshToken))).status).toBe(200);
    });

    it('using a reset link ends every session of the account', async () => {
      await setPassword(a.officer, 'Officer-session-pw-1');
      const session = await signIn(a.officer.email, 'Officer-session-pw-1');
      expect((await resetWithLink(await resetLink(a.officer), 'Officer-session-pw-3')).status).toBe(200);
      expect((await refresh(session.refreshToken)).status).toBe(401);
    });

    it('refuses a refresh token from before fingerprints, a deleted user\'s token, and anything that is not a refresh token', async () => {
      const hash = await setPassword(a.officer, 'Officer-session-pw-1');
      const old = keep(jwt.sign({ id: a.officer.id }, env.jwtRefreshSecret, { expiresIn: '7d' }));
      const unknown = keep(generateRefreshToken({ id: '00000000-0000-0000-0000-000000000000', passwordHash: hash }));
      for (const token of [old, unknown, a.officerAuth.replace('Bearer ', ''), await resetLink(a.officer), 'not-a-token']) {
        const res = await refresh(token);
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('session_ended');
      }
      expect((await request(app).post('/api/auth/refresh').send({})).status).toBe(400);
    });
  });

  describe('refresh tokens are kept apart from other tokens even with one value for both secrets (SR-2)', () => {
    it('a used reset link and an access token are refused at /refresh', async () => {
      const original = env.jwtRefreshSecret;
      try {
        env.jwtRefreshSecret = env.jwtSecret;
        await setPassword(a.donor, 'Donor-secret-pw-1');
        const link = await resetLink(a.donor);
        expect((await resetWithLink(link, 'Donor-secret-pw-2')).status).toBe(200);
        expect((await resetWithLink(link, 'Donor-secret-pw-3')).status).toBe(401);
        expect((await refresh(link)).status).toBe(401);
        const fresh = await resetLink(a.donor);
        expect((await refresh(fresh)).status).toBe(401);
        expect((await refresh(a.donorAuth.replace('Bearer ', ''))).status).toBe(401);
      } finally {
        env.jwtRefreshSecret = original;
      }
    });
  });

  describe('sign-in (SR-3, SR-6)', () => {
    it('an unknown email costs a bcrypt comparison too, and answers like a wrong password', async () => {
      await setPassword(a.officer, 'Officer-signin-pw-1');
      const compare = vi.spyOn(bcrypt, 'compare');
      try {
        const unknown = await login('nobody-at-all@example.org', 'Officer-signin-pw-1');
        expect(compare).toHaveBeenCalledOnce();
        const wrong = await login(a.officer.email, 'Officer-signin-pw-2');
        expect(compare).toHaveBeenCalledTimes(2);
        expect(unknown.status).toBe(401);
        expect(unknown.body).toEqual(wrong.body);
        expect(unknown.body).toEqual({ message: 'Invalid email or password' });
      } finally {
        compare.mockRestore();
      }
    });

    it('needs an email and a password as text', async () => {
      for (const body of [{}, { email: a.officer.email }, { email: { not: 'x' }, password: 'x' }, { email: a.officer.email, password: ['x'] }]) {
        expect((await request(app).post('/api/auth/login').send(body)).status).toBe(400);
      }
    });

    it('an Arabic password set in one composed form signs in when typed in the other (NFC)', async () => {
      await setPassword(a.officer, 'Officer-nfc-pw-1');
      const composed = keep('آمنة-حديقة-الزيتون');
      const decomposed = keep('ا\u0653منة-حديقة-الزيتون');
      expect((await changePassword(a.officerAuth, { currentPassword: 'Officer-nfc-pw-1', newPassword: decomposed })).status).toBe(200);
      expect((await login(a.officer.email, composed)).status).toBe(200);
      expect((await login(a.officer.email, decomposed)).status).toBe(200);
      const same = await changePassword(a.officerAuth, { currentPassword: composed, newPassword: decomposed });
      expect(same.status).toBe(400);
      expect(same.body.code).toBe('password_same_as_current');
    });

    it('finds the account whatever capitals and surrounding spaces the email is typed with', async () => {
      await setPassword(a.officer, 'Officer-case-pw-1');
      expect(a.officer.email).toBe('me-a@example.org');
      expect((await login(' ME-A@Example.ORG ', 'Officer-case-pw-1')).status).toBe(200);
      expect((await login('Me-A@example.org', 'Officer-case-pw-2')).status).toBe(401);
    });
  });

  describe('email addresses are stored and looked up trimmed and lower-cased', () => {
    const invite = (body: object) => request(app).post('/api/users/invite').set('Authorization', a.adminAuth).send(body);

    it('an invite stores the address lower-cased, and the same address in other capitals is refused as existing', async () => {
      const res = await invite({ email: '  Mixed.Case@Example.ORG ', fullName: 'Mixed case', role: 'me_officer' });
      expect(res.status).toBe(201);
      keep(res.body.temporaryPassword);
      expect(res.body.email).toBe('mixed.case@example.org');
      expect((await prisma.user.findUniqueOrThrow({ where: { id: res.body.id } })).email).toBe('mixed.case@example.org');
      expect((await login('MIXED.CASE@example.org', res.body.temporaryPassword)).status).toBe(200);

      const again = await invite({ email: 'mixed.CASE@example.org', fullName: 'Mixed case', role: 'me_officer' });
      expect(again.status).toBe(409);
      expect(await prisma.user.count({ where: { email: { equals: 'mixed.case@example.org', mode: 'insensitive' } } })).toBe(1);
    });

    it('forgot password finds the account when the address is typed in capitals', async () => {
      const from = lines.length;
      const res = await request(app).post('/api/auth/forgot-password').send({ email: ` ${a.officer.email.toUpperCase()} ` });
      expect(res.status).toBe(200);
      await vi.waitFor(() => expect(lines.slice(from)).toContain(`[Email] password reset not sent: email is not configured (user ${a.officer.id})`));
    });

    it('an email of spaces only is refused like a missing one', async () => {
      expect((await login('   ', 'Officer-case-pw-1')).status).toBe(400);
      expect((await request(app).post('/api/auth/forgot-password').send({ email: '   ' })).status).toBe(400);
      expect((await invite({ email: '   ', fullName: 'Nobody', role: 'me_officer' })).status).toBe(400);
    });
  });

  describe('platform admins are managed by platform admins only (SR-5)', () => {
    it('an org admin can neither demote nor remove a platform admin, so cannot reset them through a demotion', async () => {
      const before = await prisma.user.findUniqueOrThrow({ where: { id: platformA.id } });
      const demote = await request(app).patch(`/api/users/${platformA.id}`).set('Authorization', a.adminAuth).send({ role: 'org_admin' });
      expect(demote.status).toBe(403);
      expect(demote.body).toEqual({ message: "Only a platform admin can change a platform admin's account" });
      const rename = await request(app).patch(`/api/users/${platformA.id}`).set('Authorization', a.adminAuth).send({ fullName: 'Renamed' });
      expect(rename.status).toBe(403);
      const remove = await request(app).delete(`/api/users/${platformA.id}`).set('Authorization', a.adminAuth);
      expect(remove.status).toBe(403);
      expect(remove.body).toEqual({ message: 'Only a platform admin can remove a platform admin' });
      expect((await adminReset(a.adminAuth, platformA.id)).status).toBe(403);
      expect(await prisma.user.findUniqueOrThrow({ where: { id: platformA.id } })).toEqual(before);
    });

    it('a platform admin can still change another platform admin; org admins still manage everyone else', async () => {
      const second = await prisma.user.create({
        data: { organizationId: a.org.id, email: 'platform-a2@example.org', passwordHash: 'x', fullName: 'Platform a2', role: 'platform_admin' },
      });
      const renamed = await request(app).patch(`/api/users/${second.id}`).set('Authorization', bearer(platformA)).send({ fullName: 'Platform a two' });
      expect(renamed.status).toBe(200);
      const officerRename = await request(app).patch(`/api/users/${a.officer.id}`).set('Authorization', a.adminAuth).send({ fullName: a.officer.fullName });
      expect(officerRename.status).toBe(200);
      expect((await request(app).delete(`/api/users/${second.id}`).set('Authorization', bearer(platformA))).status).toBe(200);
    });

    it('another organisation\'s platform admin still answers 404 first', async () => {
      expect((await request(app).patch(`/api/users/${platformB.id}`).set('Authorization', a.adminAuth).send({ role: 'org_admin' })).status).toBe(404);
      expect((await request(app).delete(`/api/users/${platformB.id}`).set('Authorization', a.adminAuth)).status).toBe(404);
    });
  });

  describe('nothing secret is kept', () => {
    it('no console line holds a password, a reset token or a reset link', () => {
      expect(secrets.size).toBeGreaterThan(30);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).not.toMatch(JWT);
        expect(line).not.toContain('reset-password?token');
        for (const secret of secrets) expect(line.includes(secret), `a console line holds a secret: ${line.slice(0, 80)}`).toBe(false);
      }
    });

    it('no audit row holds a password or a token (field names only)', async () => {
      const rows = await prisma.auditLog.findMany();
      expect(rows.length).toBeGreaterThan(10);
      const text = JSON.stringify(rows);
      expect(text).not.toMatch(JWT);
      for (const secret of secrets) expect(text.includes(secret)).toBe(false);
      const change = rows.find(row => row.action === 'POST /api/auth/change-password' && (row.newValue as { status: number }).status === 200);
      expect(change?.newValue).toEqual({ status: 200, fields: ['currentPassword', 'newPassword'] });
      const reset = rows.find(row => row.action.endsWith('/reset-password') && row.entity === 'users');
      expect(reset).toMatchObject({ entity: 'users', newValue: { status: 200, fields: [] } });
    });
  });
});
