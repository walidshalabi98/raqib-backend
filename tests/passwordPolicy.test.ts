import bcrypt from 'bcrypt';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/middleware/errorHandler';
import {
  assertNewPassword,
  hashPassword,
  issueTemporaryPassword,
  newPasswordProblem,
  passwordIsCorrect,
  verifySignIn,
} from '../src/services/auth/passwords';
import {
  COMMON_PASSWORDS,
  emailParts,
  generateTemporaryPassword,
  isGuessablePassword,
  normalizePassword,
  organisationNameParts,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_PROBLEM_MESSAGES,
  passwordLength,
  passwordProblems,
  TEMPORARY_PASSWORD_ALPHABET,
  TEMPORARY_PASSWORD_LENGTH,
} from '../src/utils/passwordPolicy';

/** The one password policy (docs/SECURITY_SETUP.md §9): pure checks, the generator and the hash-aware wrapper. */

const EMAIL = 'Walid.Tester@example.org';

describe('passwordProblems', () => {
  it('accepts a password of 10 to 200 characters that differs from the current one and avoids the email', () => {
    expect(passwordProblems('olive-tree-42', { email: EMAIL })).toEqual([]);
    expect(passwordProblems('Kq7mWx3pZr', { email: EMAIL })).toEqual([]);
    expect(passwordProblems('Kq7m'.repeat(PASSWORD_MAX_LENGTH / 4), { email: EMAIL, currentPassword: 'b'.repeat(12) })).toEqual([]);
  });

  it('needs at least 10 characters', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(10);
    expect(passwordProblems('Kq7mWx3pZ', { email: EMAIL })).toEqual(['password_too_short']);
    expect(passwordProblems('a'.repeat(9), { email: EMAIL })).toEqual(['password_too_short']);
    expect(passwordProblems('', { email: EMAIL })).toEqual(['password_too_short']);
  });

  it('allows at most 200 characters', () => {
    expect(PASSWORD_MAX_LENGTH).toBe(200);
    expect(passwordProblems('a'.repeat(201), { email: EMAIL })).toEqual(['password_too_long']);
  });

  it('counts characters, not UTF-16 units: Arabic letters and emoji count once', () => {
    expect(passwordLength('كلمةسرطويلة')).toBe(11);
    expect(passwordLength('🔒'.repeat(10))).toBe(10);
    const emoji = (n: number) => Array.from('🔒🌿🌙⭐'.repeat(60)).slice(0, n).join('');
    expect(passwordProblems(emoji(9), { email: EMAIL })).toEqual(['password_too_short']);
    expect(passwordProblems(emoji(10), { email: EMAIL })).toEqual([]);
    expect(passwordProblems(emoji(200), { email: EMAIL })).toEqual([]);
    expect(passwordProblems(emoji(201), { email: EMAIL })).toEqual(['password_too_long']);
  });

  it('refuses the current password (exact match only)', () => {
    expect(passwordProblems('olive-tree-42', { email: EMAIL, currentPassword: 'olive-tree-42' })).toEqual(['password_same_as_current']);
    expect(passwordProblems('Olive-tree-42', { email: EMAIL, currentPassword: 'olive-tree-42' })).toEqual([]);
  });

  it("refuses a password containing the email's local part, in any case", () => {
    for (const password of ['walid.tester2026', 'my-WALID.TESTER-pw', 'xxWalid.Testerxx']) {
      expect(passwordProblems(password, { email: EMAIL }), password).toEqual(['password_contains_email']);
    }
    expect(passwordProblems('walid-tester-2026', { email: EMAIL })).toEqual([]);
  });

  it('also refuses the part before a "+" tag, and ignores local parts shorter than 3 characters', () => {
    expect(passwordProblems('samira-is-here-1', { email: 'samira+ngo@example.org' })).toEqual(['password_contains_email']);
    expect(passwordProblems('samira+ngo-pass', { email: 'samira+ngo@example.org' })).toEqual(['password_contains_email']);
    expect(emailParts('al@example.org')).toEqual([]);
    expect(passwordProblems('alpine-al-path', { email: 'al@example.org' })).toEqual([]);
    expect(emailParts('abc@example.org')).toEqual(['abc']);
    expect(emailParts('not-an-email')).toEqual([]);
    expect(emailParts('@example.org')).toEqual([]);
  });

  it('lists every problem, in a fixed order', () => {
    expect(passwordProblems('walid', { email: 'walid@example.org', currentPassword: 'walid' }))
      .toEqual(['password_too_short', 'password_same_as_current', 'password_contains_email']);
  });

  it('refuses only spaces, one repeated character or fewer than 4 different characters (any case)', () => {
    for (const password of [' '.repeat(10), 'aaaaaaaaaa', 'AaAaAaAaAa', '1212121212', 'abcabcabca', '\t \t \t \t \t ']) {
      expect(passwordProblems(password, { email: EMAIL }), JSON.stringify(password)).toEqual(['password_too_simple']);
    }
    expect(passwordProblems('abcdabcdab', { email: EMAIL })).toEqual([]);
  });

  it('refuses common passwords, also with digits or symbols around them, and the product name (SR-6)', () => {
    for (const password of [
      '1234567890', '0987654321', 'password12', 'Password2026!', 'P@ssw0rd-2026', 'qwertyuiop', 'Qwertyuiop1',
      '1q2w3e4r5t', 'iloveyou2026', 'Welcome-123', 'Palestine2026', '2026 jerusalem', 'Momentum2026', 'raqib12345',
      'my raqib password', 'فلسطين2026', 'كلمة المرور 1', 'رقيب-2026-سري',
    ]) {
      expect(passwordProblems(password, { email: EMAIL }), password).toEqual(['password_too_common']);
    }
    // A password that only contains a common word is fine: the list matches whole passwords.
    for (const password of ['my garden path 1984', 'password-of-the-olive-grove', 'qwerty and some more words']) {
      expect(passwordProblems(password, { email: EMAIL }), password).toEqual([]);
    }
  });

  it('refuses a password containing the organisation name or one of its distinctive words', () => {
    const organizationName = 'Al Nayzak Foundation';
    expect(organisationNameParts(organizationName)).toEqual(['alnayzakfoundation', 'nayzak']);
    expect(organisationNameParts('Momentum Labs')).toEqual(['momentumlabs', 'momentum']);
    expect(organisationNameParts('جمعية الإغاثة الزراعية')).toEqual(['جمعيةالإغاثةالزراعية', 'الإغاثة', 'الزراعية']);
    expect(organisationNameParts('Palestinian Youth Association')).toEqual(['palestinianyouthassociation', 'palestinian', 'youth']);
    expect(organisationNameParts('')).toEqual([]);
    expect(organisationNameParts(null)).toEqual([]);
    for (const password of ['Nayzak-2026-pw', 'al nayzak foundation 1', 'my-NAYZAK-key']) {
      expect(passwordProblems(password, { email: EMAIL, organizationName }), password).toEqual(['password_too_common']);
    }
    expect(passwordProblems('foundation-garden-7', { email: EMAIL, organizationName })).toEqual([]);
    expect(passwordProblems('Nayzak-2026-pw', { email: EMAIL })).toEqual([]);
    expect(isGuessablePassword('الزراعية-2026-x', 'جمعية الإغاثة الزراعية')).toBe(true);
  });

  it('keeps the blocklist in its compared form (lower case, NFC, no spaces)', () => {
    for (const word of COMMON_PASSWORDS) {
      expect(word).toBe(normalizePassword(word).toLowerCase().replace(/\s+/gu, ''));
    }
    expect(COMMON_PASSWORDS.has('رامالله')).toBe(true);
    // The web app has the same list (raqib-frontend src/lib/passwordPolicy.ts), with the same count in its test.
    expect(COMMON_PASSWORDS.size).toBe(118);
  });

  it('compares the NFC form: the same Arabic text composed differently is the same password', () => {
    const composed = 'آمنة-حديقة-2026';
    const decomposed = 'ا\u0653منة-حديقة-2026';
    expect(composed).not.toBe(decomposed);
    expect(normalizePassword(decomposed)).toBe(composed);
    expect(passwordLength(normalizePassword(decomposed))).toBe(passwordLength(composed));
    expect(passwordProblems(decomposed, { email: EMAIL, currentPassword: composed })).toEqual(['password_same_as_current']);
  });

  it('has a message for every problem that never repeats the password or the email', () => {
    for (const message of Object.values(PASSWORD_PROBLEM_MESSAGES)) {
      expect(message).toMatch(/^The new password/);
      expect(message).not.toMatch(/walid|@example/i);
    }
  });
});

describe('generateTemporaryPassword', () => {
  it('draws 16 characters from an alphabet without look-alike characters', () => {
    expect(TEMPORARY_PASSWORD_LENGTH).toBeGreaterThanOrEqual(16);
    expect(TEMPORARY_PASSWORD_ALPHABET).toHaveLength(56);
    expect(TEMPORARY_PASSWORD_ALPHABET).not.toMatch(/[0O1lIo]/);
    expect(new Set(TEMPORARY_PASSWORD_ALPHABET).size).toBe(TEMPORARY_PASSWORD_ALPHABET.length);
    for (let i = 0; i < 200; i++) {
      const password = generateTemporaryPassword();
      expect(password).toHaveLength(16);
      expect(password).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789]{16}$/);
      expect(passwordProblems(password, { email: 'tester@example.org' })).toEqual([]);
    }
  });

  it('uses every character of the alphabet and repeats no password', () => {
    const seen = new Set<string>();
    const characters = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const password = generateTemporaryPassword();
      seen.add(password);
      for (const ch of password) characters.add(ch);
    }
    expect(seen.size).toBe(1000);
    expect(characters.size).toBe(TEMPORARY_PASSWORD_ALPHABET.length);
  });

  it('takes its randomness from the given source (crypto.randomInt by default) and refuses short lengths', () => {
    const indexes: number[] = [];
    const password = generateTemporaryPassword(16, max => { indexes.push(max); return 0; });
    expect(password).toBe('A'.repeat(16));
    expect(indexes).toEqual(Array(16).fill(56));
    expect(generateTemporaryPassword(24)).toHaveLength(24);
    expect(() => generateTemporaryPassword(15)).toThrow(RangeError);
    expect(() => generateTemporaryPassword(201)).toThrow(RangeError);
    expect(() => generateTemporaryPassword(16.5)).toThrow(RangeError);
  });
});

describe('newPasswordProblem (with the stored hash)', () => {
  it('refuses a new password equal to the current one known only by its hash', async () => {
    const passwordHash = await bcrypt.hash('olive-tree-42', 4);
    expect(await newPasswordProblem('olive-tree-42', { email: EMAIL, passwordHash })).toBe('password_same_as_current');
    expect(await newPasswordProblem('olive-tree-43', { email: EMAIL, passwordHash })).toBeNull();
  });

  it('runs the pure checks first and works with a placeholder hash', async () => {
    expect(await newPasswordProblem('short', { email: EMAIL, passwordHash: 'x' })).toBe('password_too_short');
    expect(await newPasswordProblem('olive-tree-42', { email: EMAIL, passwordHash: 'x' })).toBeNull();
  });

  it('assertNewPassword throws a 400 AppError with the message and the code', async () => {
    const error = await assertNewPassword('walid.tester-1', { email: EMAIL }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ statusCode: 400, code: 'password_contains_email', message: PASSWORD_PROBLEM_MESSAGES.password_contains_email });
    await expect(assertNewPassword('olive-tree-42', { email: EMAIL })).resolves.toBeUndefined();
  });
});

describe('issueTemporaryPassword', () => {
  it('returns a policy-compliant temporary password and its bcrypt hash', async () => {
    const { password, passwordHash } = await issueTemporaryPassword({ email: EMAIL, passwordHash: 'x' });
    expect(password).toMatch(/^[A-Za-z2-9]{16}$/);
    expect(passwordProblems(password, { email: EMAIL })).toEqual([]);
    expect(passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(await bcrypt.compare(password, passwordHash)).toBe(true);
  });
});

describe('hashing and comparing passwords (NFC)', () => {
  it('a password set in one composed form signs in with the other', async () => {
    const composed = 'آمنة-حديقة-2026';
    const decomposed = 'ا\u0653منة-حديقة-2026';
    const hash = await hashPassword(decomposed);
    expect(await passwordIsCorrect(composed, hash)).toBe(true);
    expect(await passwordIsCorrect(decomposed, hash)).toBe(true);
    expect(await passwordIsCorrect('آمنة-حديقة-2027', hash)).toBe(false);
  });

  it('a hash made from the typed form before normalisation still matches that form', async () => {
    const decomposed = 'ا\u0653منة-حديقة-2026';
    const legacy = await bcrypt.hash(decomposed, 4);
    expect(await passwordIsCorrect(decomposed, legacy)).toBe(true);
  });
});

describe('verifySignIn (SR-3: an unknown email costs one bcrypt comparison too)', () => {
  it('compares against a dummy hash when there is no user, and refuses', async () => {
    const compare = vi.spyOn(bcrypt, 'compare');
    try {
      expect(await verifySignIn(null, 'olive-tree-42')).toBeNull();
      expect(compare).toHaveBeenCalledOnce();
      const [, hash] = compare.mock.calls[0];
      expect(hash).toMatch(/^\$2[aby]\$12\$/);
      compare.mockClear();
      const user = { id: 'u1', passwordHash: await bcrypt.hash('olive-tree-42', 4) };
      expect(await verifySignIn(user, 'olive-tree-43')).toBeNull();
      expect(compare).toHaveBeenCalledOnce();
      expect(await verifySignIn(user, 'olive-tree-42')).toBe(user);
    } finally {
      compare.mockRestore();
    }
  });
});
