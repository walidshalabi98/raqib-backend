import { prisma } from '../../config/prisma';
import { normalizeEmail } from '../../utils/emailAddress';

/** The case-insensitive match on User.email (new addresses are stored lower-cased; older rows may hold capitals). */
export function emailMatches(typed: string) {
  return { equals: normalizeEmail(typed), mode: 'insensitive' as const };
}

/**
 * The account (with its organisation) for an email address typed in any capitals and with surrounding spaces, or
 * null. Two accounts that differ only in capitals can exist only from before addresses were stored lower-cased; then
 * the one stored exactly as typed is used, else the lower-cased one, else neither.
 */
export async function findUserByEmail(typed: string) {
  const email = normalizeEmail(typed);
  if (!email) return null;
  const matches = await prisma.user.findMany({
    where: { email: emailMatches(email) },
    include: { organization: true },
  });
  if (matches.length <= 1) return matches[0] ?? null;
  return matches.find(user => user.email === typed.trim()) ?? matches.find(user => user.email === email) ?? null;
}
