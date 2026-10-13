import { Resend } from 'resend';
import { env } from '../config/env';
import { generateResetToken, RESET_LINK_LIFETIME, SET_PASSWORD_LINK_LIFETIME } from './tokens';

/**
 * Email through Resend (docs/SECURITY_SETUP.md §9). Without RESEND_API_KEY nothing is sent; then, outside
 * development, the only log line is "[Email] <kind> not sent: email is not configured (user <id>)". No log line
 * ever holds a reset link, a token, a password or an email address, except the readable [DEV] line for a reset
 * link when NODE_ENV=development. Resend errors are logged by their name only (their message may quote the
 * recipient).
 *
 * No email carries a password: an invitation and an admin's reset carry a single-use link to set one (72
 * hours), "Forgot password?" a single-use link for one hour. Every email is in English and Arabic, the
 * person's language first, each part marked with its language and direction.
 */

export interface EmailRecipient {
  id: string;
  email: string;
}

/** A recipient a set-password link can be made for: the link carries the fingerprint of the current hash. */
export interface LinkRecipient extends EmailRecipient {
  passwordHash: string;
  /** "en" or "ar": the language shown first (English when unknown). */
  languagePref?: string | null;
}

type EmailKind = 'password reset' | 'invite' | 'admin reset';
type Language = 'en' | 'ar';

/** True when emails can be sent (RESEND_API_KEY is set). */
export function emailConfigured(): boolean {
  return Boolean(env.resendApiKey);
}

let client: { key: string; resend: Resend } | null = null;

function resendClient(): Resend {
  if (!client || client.key !== env.resendApiKey) client = { key: env.resendApiKey, resend: new Resend(env.resendApiKey) };
  return client.resend;
}

/** A Resend error name or a thrown error's class name, reduced to a short identifier. */
function errorLabel(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(value) ? value : 'unknown_error';
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

/** A subject line on one line. */
function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

/** Sends one email; true when Resend accepted it. Never throws. */
async function deliver(kind: EmailKind, user: EmailRecipient, subject: string, html: string): Promise<boolean> {
  try {
    const { error } = await resendClient().emails.send({ from: env.emailFrom, to: user.email, subject: oneLine(subject), html });
    if (error) {
      console.error(`[Email] ${kind} not sent: Resend error ${errorLabel(error.name)} (user ${user.id})`);
      return false;
    }
    console.log(`[Email] ${kind} sent (user ${user.id})`);
    return true;
  } catch (err) {
    console.error(`[Email] ${kind} not sent: ${errorLabel((err as Error)?.name)} (user ${user.id})`);
    return false;
  }
}

function logNotConfigured(kind: EmailKind, user: EmailRecipient): void {
  console.log(`[Email] ${kind} not sent: email is not configured (user ${user.id})`);
}

/** APP_URL without a trailing slash, so links never hold "//". */
const appUrl = () => env.appUrl.replace(/\/+$/, '');

/** The page a link opens: `${APP_URL}/reset-password?token=…` (the same page sets a first password). */
function setPasswordUrl(user: LinkRecipient, lifetime: typeof RESET_LINK_LIFETIME | typeof SET_PASSWORD_LINK_LIFETIME): string {
  return `${appUrl()}/reset-password?token=${encodeURIComponent(generateResetToken(user, lifetime))}`;
}

/** One language's part of an email. Plain text: everything is escaped when rendered. */
export interface EmailPart {
  subject: string;
  heading: string;
  paragraphs: string[];
  linkText: string;
}

const preferredLanguage = (pref: string | null | undefined): Language => (pref === 'ar' ? 'ar' : 'en');

/**
 * The email in both languages: the preferred one first (its subject is the email's subject), each part in a
 * block with its own `lang` and `dir`, then the brand line.
 */
export function bilingualEmail(parts: Record<Language, EmailPart>, url: string, preferred: Language): { subject: string; html: string } {
  const order: Language[] = preferred === 'ar' ? ['ar', 'en'] : ['en', 'ar'];
  const block = (lang: Language) => {
    const part = parts[lang];
    const dir = lang === 'ar' ? 'rtl' : 'ltr';
    const align = lang === 'ar' ? 'right' : 'left';
    return [
      `<div lang="${lang}" dir="${dir}" style="text-align:${align}">`,
      `<h2>${escapeHtml(part.heading)}</h2>`,
      ...part.paragraphs.map(text => `<p>${escapeHtml(text)}</p>`),
      `<p><a href="${escapeHtml(url)}">${escapeHtml(part.linkText)}</a></p>`,
      '</div>',
    ].join('\n');
  };
  const html = [
    '<!doctype html>',
    `<html lang="${order[0]}" dir="${order[0] === 'ar' ? 'rtl' : 'ltr'}"><body>`,
    block(order[0]),
    '<hr>',
    block(order[1]),
    '<p lang="en" dir="ltr">Raqib by Momentum Labs</p>',
    '</body></html>',
  ].join('\n');
  return { subject: parts[order[0]].subject, html };
}

/**
 * Sends a set-password link, or (without email) logs that nothing was sent. The token is made only when the
 * email can go out. True when Resend accepted it. Never throws.
 */
async function sendLink(
  kind: EmailKind,
  user: LinkRecipient,
  lifetime: typeof RESET_LINK_LIFETIME | typeof SET_PASSWORD_LINK_LIFETIME,
  parts: Record<Language, EmailPart>,
  devLine: () => string,
): Promise<boolean> {
  let message: { subject: string; html: string };
  try {
    if (!emailConfigured()) {
      if (env.nodeEnv === 'development') console.log(devLine());
      else logNotConfigured(kind, user);
      return false;
    }
    message = bilingualEmail(parts, setPasswordUrl(user, lifetime), preferredLanguage(user.languagePref));
  } catch (err) {
    console.error(`[Email] ${kind} not sent: ${errorLabel((err as Error)?.name)} (user ${user.id})`);
    return false;
  }
  return deliver(kind, user, message.subject, message.html);
}

/**
 * "Forgot password?": emails a one-hour, single-use reset link. Without email nothing is created or sent; in
 * development the link is logged as a readable [DEV] line instead. Never throws: forgot-password does not
 * wait for it.
 */
export function sendPasswordResetEmail(user: LinkRecipient): Promise<boolean> {
  return sendLink('password reset', user, RESET_LINK_LIFETIME, {
    en: {
      subject: 'Reset your Raqib password',
      heading: 'Reset your Raqib password',
      paragraphs: [
        'Open the link below to choose a new password. The link works once, for one hour.',
        'If you did not ask for this, ignore this email: your password stays the same.',
      ],
      linkText: 'Choose a new password',
    },
    ar: {
      subject: 'إعادة تعيين كلمة المرور في رقيب',
      heading: 'إعادة تعيين كلمة المرور في رقيب',
      paragraphs: [
        'افتح الرابط أدناه لاختيار كلمة مرور جديدة. يعمل الرابط مرة واحدة فقط، ولمدة ساعة واحدة.',
        'إذا لم تطلب ذلك، فتجاهل هذه الرسالة، وستبقى كلمة مرورك كما هي.',
      ],
      linkText: 'اختيار كلمة مرور جديدة',
    },
  }, () => `[DEV] Password reset link for ${user.email}: ${setPasswordUrl(user, RESET_LINK_LIFETIME)}`);
}

/**
 * An invitation: a single-use link (72 hours) to set a first password, never a password. Without email
 * nothing is sent (the API shows a temporary password once to the inviting admin instead), and the log line
 * holds neither. True when sent.
 */
export function sendInviteEmail(user: LinkRecipient, orgName: string): Promise<boolean> {
  const org = oneLine(orgName);
  return sendLink('invite', user, SET_PASSWORD_LINK_LIFETIME, {
    en: {
      subject: `You have been invited to ${org} on Raqib`,
      heading: 'Welcome to Raqib',
      paragraphs: [
        `You have been invited to join ${org} on Raqib, the monitoring and evaluation platform.`,
        'Open the link below to choose your password. The link works once, for 72 hours. After that, ask your organisation\'s admin for a new one.',
      ],
      linkText: 'Choose your password',
    },
    ar: {
      subject: `دعوة للانضمام إلى ${org} على رقيب`,
      heading: 'مرحبًا بك في رقيب',
      paragraphs: [
        `تمت دعوتك للانضمام إلى ${org} على رقيب، منصة المتابعة والتقييم.`,
        'افتح الرابط أدناه لاختيار كلمة المرور الخاصة بك. يعمل الرابط مرة واحدة فقط، ولمدة 72 ساعة. بعد ذلك، اطلب رابطًا جديدًا من مسؤول مؤسستك.',
      ],
      linkText: 'اختيار كلمة المرور',
    },
  }, () => `[DEV] Invite for ${user.email} not emailed (email is not configured); the temporary password was shown to the inviting admin.`);
}

/**
 * An admin reset the user's password (POST /api/users/:id/reset-password): a single-use link (72 hours) to
 * choose a new one, never a password. Without email nothing is sent (the API shows a temporary password once
 * to the admin instead). True when sent.
 */
export function sendAdminResetEmail(user: LinkRecipient): Promise<boolean> {
  return sendLink('admin reset', user, SET_PASSWORD_LINK_LIFETIME, {
    en: {
      subject: 'Your Raqib password was reset',
      heading: 'Your Raqib password was reset',
      paragraphs: [
        'An administrator of your organisation reset your password. Your previous password and any earlier reset links no longer work.',
        'Open the link below to choose a new password. The link works once, for 72 hours.',
      ],
      linkText: 'Choose a new password',
    },
    ar: {
      subject: 'أُعيد تعيين كلمة مرورك في رقيب',
      heading: 'أُعيد تعيين كلمة مرورك في رقيب',
      paragraphs: [
        'أعاد أحد مسؤولي مؤسستك تعيين كلمة مرورك. لم تعد كلمة مرورك السابقة ولا أي روابط سابقة لإعادة التعيين صالحة.',
        'افتح الرابط أدناه لاختيار كلمة مرور جديدة. يعمل الرابط مرة واحدة فقط، ولمدة 72 ساعة.',
      ],
      linkText: 'اختيار كلمة مرور جديدة',
    },
  }, () => `[DEV] Password reset by an admin for ${user.email} not emailed (email is not configured); the temporary password was shown to the admin.`);
}
