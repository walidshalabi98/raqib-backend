import { randomBytes } from 'crypto';
import bcrypt from 'bcrypt';
import { prisma } from '../../config/prisma';
import { AppError } from '../../middleware/errorHandler';
import {
  generateTemporaryPassword,
  normalizePassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_PROBLEM_MESSAGES,
  passwordLength,
  PasswordProblem,
  passwordProblems,
} from '../../utils/passwordPolicy';

/**
 * Setting passwords: the policy (src/utils/passwordPolicy.ts) applied to change, reset and admin-set passwords,
 * hashing, temporary passwords and the single-use update. Passwords and hashes are never logged.
 */

export const BCRYPT_ROUNDS = 12;

/** Hashes the password's NFC form (normalizePassword), the form every comparison uses. */
export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(normalizePassword(password), BCRYPT_ROUNDS);
}

/**
 * True when `password` is the one `passwordHash` was made from. The NFC form is compared first; a password
 * whose typed form differs is also compared as typed, so a hash made before passwords were normalised (or by
 * the seed of an older version) still matches.
 */
export async function passwordIsCorrect(password: string, passwordHash: string): Promise<boolean> {
  const normalized = normalizePassword(password);
  if (await bcrypt.compare(normalized, passwordHash)) return true;
  return normalized !== password && bcrypt.compare(password, passwordHash);
}

/**
 * A hash of a random value nobody knows: an account that cannot sign in until an admin resets its password
 * (the dev seed's other accounts when SEED_PASSWORD is set).
 */
export function unusablePasswordHash(): Promise<string> {
  return bcrypt.hash(randomBytes(32).toString('hex'), BCRYPT_ROUNDS);
}

let dummyHash: Promise<string> | null = null;

/**
 * A hash of a random value nobody knows, made once (started when the auth routes load). Sign-in compares the
 * password with it when the email is unknown, so an unknown email takes as long to refuse as a wrong password
 * and the answer time does not tell which emails have an account.
 */
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= unusablePasswordHash();
  return dummyHash;
}

/**
 * The user for a sign-in, or null for a wrong password or an unknown email. Both cost one bcrypt comparison
 * of the same cost, so they take as long.
 */
export async function verifySignIn<U extends { passwordHash: string }>(user: U | null, password: string): Promise<U | null> {
  if (!user) {
    await passwordIsCorrect(password, await dummyPasswordHash());
    return null;
  }
  return (await passwordIsCorrect(password, user.passwordHash)) ? user : null;
}

export interface NewPasswordContext {
  email: string;
  /** The account's organisation: the new password may not contain its name. */
  organizationName?: string | null;
  /** The current password in plain text, when known (change password). */
  currentPassword?: string;
  /** The current hash, when the plain text is not known (reset link, admin reset): the new password must not match it. */
  passwordHash?: string;
}

/** The first problem with a new password, or null when it meets the policy. */
export async function newPasswordProblem(password: string, context: NewPasswordContext): Promise<PasswordProblem | null> {
  const problems = passwordProblems(password, {
    email: context.email, currentPassword: context.currentPassword, organizationName: context.organizationName,
  });
  if (problems.length > 0) return problems[0];
  if (context.currentPassword === undefined && context.passwordHash && passwordLength(password) <= PASSWORD_MAX_LENGTH
    && (await passwordIsCorrect(password, context.passwordHash))) {
    return 'password_same_as_current';
  }
  return null;
}

/** Throws 400 with the problem's message and code when the new password does not meet the policy. */
export async function assertNewPassword(password: string, context: NewPasswordContext): Promise<void> {
  const problem = await newPasswordProblem(password, context);
  if (problem) throw new AppError(400, PASSWORD_PROBLEM_MESSAGES[problem], problem);
}

/** A new temporary password that meets the policy for this account, with its hash. */
export async function issueTemporaryPassword(
  context: { email: string; passwordHash?: string; organizationName?: string | null },
): Promise<{ password: string; passwordHash: string }> {
  // A 16-character random password fails the policy only if it happens to contain the email's local part.
  for (let attempt = 0; attempt < 20; attempt++) {
    const password = generateTemporaryPassword();
    if (!(await newPasswordProblem(password, context))) return { password, passwordHash: await hashPassword(password) };
  }
  throw new Error('Could not generate a temporary password');
}

/**
 * Replaces the user's password hash only if it is still `expectedHash` (compare and swap), so one reset link
 * or one change request wins and a second one using the same old state fails. True when replaced.
 */
export async function replacePasswordHash(userId: string, expectedHash: string, newHash: string): Promise<boolean> {
  const { count } = await prisma.user.updateMany({ where: { id: userId, passwordHash: expectedHash }, data: { passwordHash: newHash } });
  return count === 1;
}
