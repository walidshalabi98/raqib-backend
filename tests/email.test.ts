import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Resend is never called for real: the fake records every email and answers as each test says.
const send = vi.hoisted(() => vi.fn());
const constructed = vi.hoisted(() => [] as string[]);
vi.mock('resend', () => ({
  Resend: class {
    emails = { send };
    constructor(key: string) { constructed.push(key); }
  },
}));

import jwt from 'jsonwebtoken';
import { DEFAULT_EMAIL_FROM, env } from '../src/config/env';
import { bilingualEmail, emailConfigured, sendAdminResetEmail, sendInviteEmail, sendPasswordResetEmail } from '../src/utils/email';
import { passwordFingerprint, verifyResetToken } from '../src/utils/tokens';

/**
 * src/utils/email.ts: email-off mode logs only the user id; nothing secret ever reaches a log line; no email
 * carries a password (invitations and admin resets carry a single-use set-password link); every email is in
 * English and Arabic, the person's language first.
 */

const USER = {
  id: '11111111-2222-4333-8444-555555555555',
  email: 'samira.tester@example.org',
  passwordHash: '$2b$12$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ01234',
};
const ARABIC_USER = { ...USER, languagePref: 'ar' };
const original = { resendApiKey: env.resendApiKey, nodeEnv: env.nodeEnv, emailFrom: env.emailFrom, appUrl: env.appUrl, jwtSecret: env.jwtSecret };
let lines: string[] = [];

beforeEach(() => {
  lines = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  }
  send.mockReset();
});

afterEach(() => {
  Object.assign(env, original);
  vi.restoreAllMocks();
});

const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/;

/** No log line holds a token, a reset link, the email address or the hash. */
function expectNothingSecretLogged() {
  for (const line of lines) {
    expect(line).not.toMatch(JWT);
    expect(line).not.toContain('reset-password');
    expect(line).not.toContain(USER.email);
    expect(line).not.toContain(USER.passwordHash);
  }
}

/** The single set-password link in an email's HTML, and its decoded token. */
function linkIn(html: string): { url: string; token: string } {
  const links = [...html.matchAll(/href="([^"]+)"/g)].map(match => match[1]);
  expect(new Set(links).size).toBe(1);
  const url = links[0];
  const match = /^https:\/\/raqib\.example\.org\/reset-password\?token=([^"&]+)$/.exec(url);
  expect(match, url).not.toBeNull();
  return { url, token: decodeURIComponent(match![1]) };
}

/** Lifetime of a token in seconds. */
const lifetime = (token: string) => {
  const payload = jwt.decode(token) as { iat: number; exp: number };
  return payload.exp - payload.iat;
};

describe('email is not configured (no RESEND_API_KEY)', () => {
  beforeEach(() => { env.resendApiKey = ''; });

  it('emailConfigured() is false', () => {
    expect(emailConfigured()).toBe(false);
  });

  it.each(['test', 'production'] as const)('in %s, logs only "[Email] <kind> not sent: email is not configured" with the user id', async nodeEnv => {
    env.nodeEnv = nodeEnv;
    expect(await sendPasswordResetEmail(USER)).toBe(false);
    expect(await sendInviteEmail(USER, 'Org A')).toBe(false);
    expect(await sendAdminResetEmail(USER)).toBe(false);
    expect(lines).toEqual([
      `[Email] password reset not sent: email is not configured (user ${USER.id})`,
      `[Email] invite not sent: email is not configured (user ${USER.id})`,
      `[Email] admin reset not sent: email is not configured (user ${USER.id})`,
    ]);
    expect(send).not.toHaveBeenCalled();
    expect(constructed).toEqual([]);
    expectNothingSecretLogged();
  });

  it('in development, keeps the readable reset link only; the invite and admin reset lines hold no link', async () => {
    env.nodeEnv = 'development';
    env.appUrl = 'http://localhost:5173/';
    await sendPasswordResetEmail(USER);
    await sendInviteEmail(USER, 'Org A');
    await sendAdminResetEmail(USER);
    expect(lines[0]).toMatch(new RegExp(`^\\[DEV\\] Password reset link for ${USER.email}: http://localhost:5173/reset-password\\?token=eyJ`));
    expect(lines.slice(1)).toHaveLength(2);
    for (const line of lines.slice(1)) {
      expect(line).toMatch(/^\[DEV\] /);
      expect(line).not.toMatch(JWT);
      expect(line).not.toContain('reset-password');
    }
    expect(send).not.toHaveBeenCalled();
  });
});

describe('email is configured', () => {
  beforeEach(() => {
    env.resendApiKey = 're_test_not_a_real_key';
    env.nodeEnv = 'production';
    env.appUrl = 'https://raqib.example.org';
  });

  it('sends a one-hour, single-use reset link from EMAIL_FROM to the user and logs the user id only', async () => {
    expect(emailConfigured()).toBe(true);
    send.mockResolvedValue({ data: { id: 'email-1' }, error: null });
    expect(await sendPasswordResetEmail(USER)).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    const message = send.mock.calls[0][0];
    expect(message.from).toBe(DEFAULT_EMAIL_FROM);
    expect(message.from).toBe('Raqib by Momentum Labs <noreply@raqib.momentumlabs.ps>');
    expect(message.to).toBe(USER.email);
    expect(message.subject).toBe('Reset your Raqib password');
    const { token } = linkIn(message.html);
    expect(verifyResetToken(token)).toEqual({ id: USER.id, pwd: passwordFingerprint(USER.passwordHash) });
    expect(lifetime(token)).toBe(3600);
    expect(lines).toEqual([`[Email] password reset sent (user ${USER.id})`]);
    expectNothingSecretLogged();
  });

  it('an invitation carries a 72-hour set-password link and never a password; it uses EMAIL_FROM and escapes the organisation name', async () => {
    env.emailFrom = 'Raqib Staging <staging@raqib.example.org>';
    send.mockResolvedValue({ data: { id: 'email-2' }, error: null });
    expect(await sendInviteEmail(USER, 'Org <b>A</b> & "partners"')).toBe(true);
    const message = send.mock.calls[0][0];
    expect(message.from).toBe('Raqib Staging <staging@raqib.example.org>');
    const { token } = linkIn(message.html);
    expect(verifyResetToken(token)).toEqual({ id: USER.id, pwd: passwordFingerprint(USER.passwordHash) });
    expect(lifetime(token)).toBe(72 * 3600);
    expect(message.html).not.toMatch(/temporary password|كلمة المرور المؤقتة/i);
    expect(message.html).toContain('Org &lt;b&gt;A&lt;/b&gt; &amp; &quot;partners&quot;');
    expect(message.html).not.toContain('<b>A</b>');
    expect(message.html).not.toContain('/login');
    expect(lines).toEqual([`[Email] invite sent (user ${USER.id})`]);
    expectNothingSecretLogged();
  });

  it('an admin reset carries a 72-hour set-password link and never a password', async () => {
    send.mockResolvedValue({ data: { id: 'email-3' }, error: null });
    expect(await sendAdminResetEmail(USER)).toBe(true);
    const message = send.mock.calls[0][0];
    expect(message).toMatchObject({ to: USER.email, subject: 'Your Raqib password was reset' });
    const { token } = linkIn(message.html);
    expect(lifetime(token)).toBe(72 * 3600);
    expect(message.html).not.toMatch(/temporary password/i);
    expect(lines).toEqual([`[Email] admin reset sent (user ${USER.id})`]);
    expectNothingSecretLogged();
  });

  it.each([
    ['English (or no preference)', USER, 'en', 'Reset your Raqib password'],
    ['Arabic', ARABIC_USER, 'ar', 'إعادة تعيين كلمة المرور في رقيب'],
  ] as const)('a user who prefers %s gets both languages, theirs first, each marked with its language and direction', async (_label, user, first, subject) => {
    send.mockResolvedValue({ data: { id: 'email-5' }, error: null });
    await sendPasswordResetEmail(user);
    const { html, subject: sent } = send.mock.calls[0][0];
    expect(sent).toBe(subject);
    const blocks = [...html.matchAll(/<div lang="(en|ar)" dir="(ltr|rtl)"/g)].map(match => [match[1], match[2]]);
    expect(blocks).toEqual(first === 'ar' ? [['ar', 'rtl'], ['en', 'ltr']] : [['en', 'ltr'], ['ar', 'rtl']]);
    expect(html).toMatch(new RegExp(`<html lang="${first}" dir="${first === 'ar' ? 'rtl' : 'ltr'}">`));
    expect(html).toContain('Choose a new password');
    expect(html).toContain('اختيار كلمة مرور جديدة');
    expect(html).toContain('Raqib by Momentum Labs');
  });

  it('bilingualEmail escapes every text and the link', () => {
    const part = { subject: 's', heading: '<h>', paragraphs: ['a & b'], linkText: '"x"' };
    const { html } = bilingualEmail({ en: part, ar: part }, 'https://x.example/?a=1&b="2"', 'en');
    expect(html).toContain('<h2>&lt;h&gt;</h2>');
    expect(html).toContain('<p>a &amp; b</p>');
    expect(html).toContain('href="https://x.example/?a=1&amp;b=&quot;2&quot;"');
    expect(html).toContain('>&quot;x&quot;</a>');
  });

  it('checks the Resend result: an {error} answer is logged by its name only and returns false', async () => {
    send.mockResolvedValue({ data: null, error: { name: 'validation_error', message: `Invalid \`to\` field: ${USER.email}` } });
    expect(await sendInviteEmail(USER, 'Org A')).toBe(false);
    expect(lines).toEqual([`[Email] invite not sent: Resend error validation_error (user ${USER.id})`]);
    expectNothingSecretLogged();
  });

  it('a thrown error is logged by its class name only, never its message, and returns false', async () => {
    send.mockRejectedValue(Object.assign(new TypeError(`fetch failed for ${USER.email}`), { cause: USER.passwordHash }));
    expect(await sendAdminResetEmail(USER)).toBe(false);
    expect(lines).toEqual([`[Email] admin reset not sent: TypeError (user ${USER.id})`]);
    send.mockRejectedValue('a string with a token eyJhbGciOiJIUzI1NiJ9.e30.abc');
    expect(await sendPasswordResetEmail(USER)).toBe(false);
    expect(lines[1]).toBe(`[Email] password reset not sent: unknown_error (user ${USER.id})`);
    expectNothingSecretLogged();
  });

  it('an error name that is not a short identifier is not logged as given', async () => {
    send.mockResolvedValue({ data: null, error: { name: `bad name ${USER.email}`, message: 'x' } });
    expect(await sendInviteEmail(USER, 'Org A')).toBe(false);
    expect(lines).toEqual([`[Email] invite not sent: Resend error unknown_error (user ${USER.id})`]);
  });

  it('never throws (forgot-password does not wait for it): a failure to make the link is logged by class name only', async () => {
    env.jwtSecret = '';
    for (const nodeEnv of ['production', 'development'] as const) {
      env.nodeEnv = nodeEnv;
      await expect(sendPasswordResetEmail(USER)).resolves.toBe(false);
    }
    await expect(sendInviteEmail(USER, 'Org A')).resolves.toBe(false);
    expect(lines).toEqual([
      `[Email] password reset not sent: Error (user ${USER.id})`,
      `[Email] password reset not sent: Error (user ${USER.id})`,
      `[Email] invite not sent: Error (user ${USER.id})`,
    ]);
    expect(send).not.toHaveBeenCalled();
    env.resendApiKey = '';
    await expect(sendPasswordResetEmail(USER)).resolves.toBe(false);
    expect(lines[3]).toBe(`[Email] password reset not sent: Error (user ${USER.id})`);
    expectNothingSecretLogged();
  });

  it('puts the subject on one line', async () => {
    send.mockResolvedValue({ data: { id: 'email-4' }, error: null });
    await sendInviteEmail(USER, 'Org A\r\nBcc: someone@example.org');
    expect(send.mock.calls[0][0].subject).toBe('You have been invited to Org A Bcc: someone@example.org on Raqib');
  });
});
