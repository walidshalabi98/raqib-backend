import { randomInt } from 'crypto';

/**
 * The one password policy (docs/SECURITY_SETUP.md §9), used for a changed password, a password set through a
 * reset link and every temporary password an admin hands out. Pure: no database, no hashing. The check that a
 * new password differs from a current one known only by its hash is in src/services/auth/passwords.ts.
 */

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;
/**
 * The email check applies to local parts of at least this many characters: a shorter one ("al@…") would
 * forbid ordinary letter pairs in every password.
 */
export const EMAIL_PART_MIN_LENGTH = 3;

export type PasswordProblem =
  | 'password_too_short'
  | 'password_too_long'
  | 'password_same_as_current'
  | 'password_contains_email'
  | 'password_too_simple'
  | 'password_too_common';

/** A password must use at least this many different characters (so not "aaaaaaaaaa", "1212121212" or only spaces). */
export const PASSWORD_MIN_DISTINCT_CHARACTERS = 4;

/** The API's message for each problem (also sent as `code`, so the web app can show its own EN/AR text). */
export const PASSWORD_PROBLEM_MESSAGES: Readonly<Record<PasswordProblem, string>> = {
  password_too_short: `The new password must be at least ${PASSWORD_MIN_LENGTH} characters long.`,
  password_too_long: `The new password must be at most ${PASSWORD_MAX_LENGTH} characters long.`,
  password_same_as_current: 'The new password must be different from the current password.',
  password_contains_email: 'The new password must not contain the part of your email address before the @.',
  password_too_simple: `The new password must use at least ${PASSWORD_MIN_DISTINCT_CHARACTERS} different characters.`,
  password_too_common: 'The new password is too easy to guess: it is a common password or contains the name of Raqib or of your organisation.',
};

export interface PasswordContext {
  /** The account's email address: the password may not contain its local part. */
  email: string;
  /** The current password in plain text, when the caller knows it (change password). */
  currentPassword?: string;
  /** The account's organisation: the password may not contain its name. */
  organizationName?: string | null;
}

/**
 * The form a password is checked, hashed and compared in: Unicode NFC, so the same Arabic (or accented) text
 * typed on another keyboard, whose characters may arrive composed differently, is the same password.
 */
export function normalizePassword(password: string): string {
  return password.normalize('NFC');
}

/** Length in characters (Unicode code points), so an Arabic or emoji character counts once. */
export function passwordLength(password: string): number {
  return Array.from(password).length;
}

/**
 * The parts of an email address a password may not contain, in lower case: the local part, and for a
 * sub-address ("name+tag@…") also the part before the "+". Parts shorter than EMAIL_PART_MIN_LENGTH are left out.
 */
export function emailParts(email: string): string[] {
  const at = email.lastIndexOf('@');
  if (at <= 0) return [];
  const local = email.slice(0, at).trim().toLowerCase();
  const parts = new Set([local, local.split('+')[0]]);
  return [...parts].filter(part => passwordLength(part) >= EMAIL_PART_MIN_LENGTH);
}

/**
 * Passwords people choose most often, and words anyone would try first against an NGO platform in Palestine,
 * in lower case without spaces (NIST SP 800-63B §3.1.1.2 asks for such a list). A password is refused when it
 * is one of these once spaces, and digits or symbols at its start and end, are removed: "Password2026!" and
 * "1234567890" are refused, "my garden path 1984" is not. The web app has the same list
 * (src/lib/passwordPolicy.ts in raqib-frontend).
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  'password', 'passw0rd', 'p@ssword', 'p@ssw0rd', 'mypassword', 'newpassword', 'password1', 'changeme', 'default',
  'secret', 'letmein', 'welcome', 'iloveyou', 'loveyou', 'trustno1', 'whatever', 'qwerty', 'qwertyuiop',
  'qwertyuiop[]', 'asdfghjkl', 'asdfghjkl;', 'zxcvbnm', 'zxcvbnm,./', 'qazwsx', 'qazwsxedc', '1qaz2wsx', 'zaq12wsx',
  '1q2w3e4r', '1q2w3e4r5t', '1q2w3e4r5t6y', 'q1w2e3r4t5', 'abc123', 'abcdef', 'abcdefgh', 'abcdefghij', 'abcd1234',
  '0123456789', '1234567890', '0987654321', '9876543210', '12345678910', '123123123', '1231231231', '123456789a',
  'a123456789', 'admin', 'administrator', 'root', 'user', 'guest', 'test', 'testing', 'login', 'access', 'master',
  'monkey', 'dragon', 'shadow', 'sunshine', 'princess', 'football', 'baseball', 'soccer', 'superman', 'batman',
  'starwars', 'freedom', 'computer', 'internet', 'samsung', 'iphone', 'google', 'facebook', 'hello', 'helloworld',
  'temporary', 'temppassword', 'security', 'monitoring', 'evaluation', 'palestine', 'falastin', 'filastin',
  'jerusalem', 'alquds', 'quds', 'ramallah', 'gaza', 'nablus', 'hebron', 'bethlehem', 'jenin', 'jericho', 'allah',
  'bismillah', 'alhamdulillah', 'inshallah', 'mashallah', 'mohammad', 'mohammed', 'muhammad', 'ahmad', 'ahmed',
  'habibi', 'yalla', 'marhaba', 'salam', 'كلمةالسر', 'كلمةمرور', 'كلمةالمرور', 'فلسطين', 'القدس', 'غزة', 'رام الله',
  'بسمالله', 'الحمدلله', 'مرحبا', 'حبيبي',
].map(word => normalizePassword(word).replace(/\s+/gu, '')));

/** Names a password may not contain, whatever surrounds them: the product's, in English and Arabic. */
export const PRODUCT_NAMES: readonly string[] = ['raqib', 'momentum', 'رقيب', 'مومنتوم'];

/** Words of an organisation name that say nothing about it on their own, so a password may contain them. */
const GENERIC_ORGANISATION_WORDS = new Set([
  'organisation', 'organization', 'association', 'foundation', 'society', 'centre', 'center', 'institute',
  'international', 'network', 'committee', 'council', 'union', 'group', 'trust', 'company', 'services',
  'جمعية', 'الجمعية', 'مؤسسة', 'المؤسسة', 'منظمة', 'المنظمة', 'المركز', 'اتحاد', 'الاتحاد', 'الدولية', 'شركة', 'الشركة',
].map(word => normalizePassword(word)));

/** Lower case, NFC, letters and digits only (any script). */
function compact(text: string): string {
  return normalizePassword(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * The parts of an organisation name a password may not contain: the whole name without spaces, and each word of
 * at least 5 letters that is not generic ("Al Nayzak Foundation" gives "alnayzakfoundation" and "nayzak").
 */
export function organisationNameParts(name: string | null | undefined): string[] {
  if (!name) return [];
  const words = normalizePassword(name).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const parts = new Set<string>();
  const whole = compact(name);
  if (passwordLength(whole) >= 4) parts.add(whole);
  for (const word of words) {
    if (passwordLength(word) >= 5 && !GENERIC_ORGANISATION_WORDS.has(word)) parts.add(word);
  }
  return [...parts];
}

/** True when the password is a common one, or contains the product's or the organisation's name. */
export function isGuessablePassword(password: string, organizationName?: string | null): boolean {
  const lower = normalizePassword(password).toLowerCase();
  const joined = lower.replace(/\s+/gu, '');
  const core = joined.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
  if (COMMON_PASSWORDS.has(joined) || (core !== '' && COMMON_PASSWORDS.has(core))) return true;
  const letters = compact(password);
  return [...PRODUCT_NAMES, ...organisationNameParts(organizationName)].some(name => letters.includes(name));
}

/**
 * Every problem with a new password, in a fixed order; an empty list means it meets the policy. The password is
 * checked in its NFC form (normalizePassword), as it is hashed.
 */
export function passwordProblems(password: string, context: PasswordContext): PasswordProblem[] {
  const problems: PasswordProblem[] = [];
  const normalized = normalizePassword(password);
  const length = passwordLength(normalized);
  if (length < PASSWORD_MIN_LENGTH) problems.push('password_too_short');
  if (length > PASSWORD_MAX_LENGTH) problems.push('password_too_long');
  if (context.currentPassword !== undefined && normalized === normalizePassword(context.currentPassword)) {
    problems.push('password_same_as_current');
  }
  const lower = normalized.toLowerCase();
  if (emailParts(context.email).some(part => lower.includes(part))) problems.push('password_contains_email');
  // A password of the wrong length is refused already; these two describe an acceptable length only.
  if (length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH) {
    if (new Set(Array.from(lower)).size < PASSWORD_MIN_DISTINCT_CHARACTERS) problems.push('password_too_simple');
    if (isGuessablePassword(normalized, context.organizationName)) problems.push('password_too_common');
  }
  return problems;
}

/**
 * Characters of a temporary password: letters and digits without the look-alikes 0/O/o, 1/l/I, so a tester can
 * read one off a screen. 56 characters: about 5.8 bits each.
 */
export const TEMPORARY_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
/** 16 characters from the alphabet: about 93 bits. */
export const TEMPORARY_PASSWORD_LENGTH = 16;

/**
 * A random temporary password from TEMPORARY_PASSWORD_ALPHABET, drawn with crypto.randomInt (uniform, no modulo
 * bias). `randomIndex` is replaceable for tests only.
 */
export function generateTemporaryPassword(
  length: number = TEMPORARY_PASSWORD_LENGTH,
  randomIndex: (max: number) => number = randomInt,
): string {
  if (!Number.isInteger(length) || length < TEMPORARY_PASSWORD_LENGTH || length > PASSWORD_MAX_LENGTH) {
    throw new RangeError(`A temporary password needs ${TEMPORARY_PASSWORD_LENGTH} to ${PASSWORD_MAX_LENGTH} characters`);
  }
  let password = '';
  for (let i = 0; i < length; i++) password += TEMPORARY_PASSWORD_ALPHABET[randomIndex(TEMPORARY_PASSWORD_ALPHABET.length)];
  return password;
}
