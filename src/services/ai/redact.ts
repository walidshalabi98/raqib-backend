/**
 * Removes personal data that can be recognised reliably (phone numbers, ID numbers, email
 * addresses) from text before it is stored for AI use or sent to a model
 * (CLAUDE.md rule 5, knowledge/me-foundations.md §12).
 *
 * CONTRACT (other modules depend on it): redactPersonalData(text) → { text, counts }.
 *
 * Pure function, no I/O, linear in the length of the text. Handles ASCII, Arabic-Indic (٠-٩) and
 * Extended Arabic-Indic (۰-۹) digits and Arabic text around them. Names and street addresses
 * cannot be recognised reliably by patterns, so prompts must still tell the model never to output them.
 *
 * What is removed:
 * - email addresses, also with Arabic or other non-Latin letters, punycode domains (xn--),
 *   apostrophes in the local part and fullwidth "＠" or "．";
 * - phone numbers (before ID numbers): international numbers with a + or 00 prefix, 970/972
 *   mobiles and landlines written without the prefix, local mobiles 05X + 7 digits (also in
 *   pairs: 05 99 12 34 56) and local landlines 0[2489] + 7 digits. Between the digits: a dash, a
 *   dot, one or two spaces or tabs, a line break, parentheses, or an invisible character (zero-width
 *   space, soft hyphen). A phone number is removed even when a Latin word is written against it
 *   ("Mobile0599123456") or a slash joins it to something else ("Tel/0599123456", "0599123456/0599654321");
 * - ID numbers: a run of exactly 9 digits (Palestinian ID numbers have 9 digits) that is not part of
 *   a longer token. Written against Latin letters, it is removed only after a label ("ID401234567",
 *   "No401234567"). Joined by a slash, it is kept only when the other side is part of a code (a year
 *   or other number, an upper-case code: "ENI/2026/412345678"), never next to another ID number.
 *
 * What is kept: years and dates, amounts with thousands separators or a currency, decimals,
 * percentages, short numbers, codes such as "O1.2", "EU GERF 2.14", "AB123456789" or
 * "Ref401234567", grant numbers with slashes, ranges and joined codes ("2026-412345678"), other
 * digit runs (8 digits, 10+ digits) that are not phone numbers, and timestamps.
 *
 * Known trade-offs: a code made of Latin letters and a complete phone number ("INV0599123456")
 * loses the number; an ID number written against a name ("AhmadAli401234567") or in groups
 * ("401 234 567") is kept.
 */

export interface RedactionCounts {
  phone: number;
  idNumber: number;
  email: number;
}

export interface RedactionResult {
  /** The text with each match replaced by a placeholder such as "[phone removed]". */
  text: string;
  /** How many matches of each kind were removed (numbers only; safe to log). */
  counts: RedactionCounts;
}

export const REDACTION_PLACEHOLDERS: Readonly<Record<keyof RedactionCounts, string>> = {
  phone: '[phone removed]',
  idNumber: '[ID number removed]',
  email: '[email removed]',
};

const PLACEHOLDERS = Object.values(REDACTION_PLACEHOLDERS);

// ---------------------------------------------------------------------------
// Matching runs on a "shadow" copy of the text with the same length: Arabic digits become
// ASCII digits, space and dash variants become " " and "-", fullwidth "＠" and "．" become "@"
// and ".", and invisible characters (direction marks, zero-width spaces and joiners, soft
// hyphens, byte order marks) become spaces. Every mapped character is one UTF-16 code unit,
// so match positions in the shadow are positions in the original text.
// ---------------------------------------------------------------------------

const SHADOW_CHARS = /[\u0660-\u0669\u06F0-\u06F9\u066A-\u066C\u00A0\u2000-\u200A\u202F\u205F\u3000\u200B-\u200F\u2060\uFEFF\u00AD\u061C\u202A-\u202E\u2066-\u2069\u2010-\u2015\u2212\uFE58\uFE63\uFF0D\uFF20\uFE6B\uFF0E]/g;

function shadowChar(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660); // Arabic-Indic digits
  if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0); // Extended Arabic-Indic digits
  if (code === 0x066a) return '%'; // Arabic percent sign
  if (code === 0x066b) return '.'; // Arabic decimal separator
  if (code === 0x066c) return ','; // Arabic thousands separator
  if ((code >= 0x2010 && code <= 0x2015) || code === 0x2212 || code === 0xfe58 || code === 0xfe63 || code === 0xff0d) return '-';
  if (code === 0xff20 || code === 0xfe6b) return '@'; // fullwidth and small commercial at
  if (code === 0xff0e) return '.'; // fullwidth full stop
  return ' '; // no-break, thin and other spaces; direction marks; zero-width and soft-hyphen characters
}

function toShadow(text: string): string {
  return text.replace(SHADOW_CHARS, shadowChar);
}

// Between two digits of a phone number: a dash or a dot, one or two spaces or tabs, or one line break
// (with a space or tab around it). Two line breaks (a new paragraph or table cell) end the number.
const SEP = String.raw`(?:[.\-]|[ \t]{1,2}|[ \t]?\r?\n[ \t]?)`;
// One digit, optionally preceded by ")", a separator and "(" (e.g. "059) 912-3456").
const STEP = String.raw`\)?${SEP}?\(?\d`;

// Letters, marks and digits of an email address (any script); the local part may also hold . _ % + - and apostrophes.
const EMAIL_WORD = String.raw`[\p{L}\p{M}\p{Nd}]`;
const EMAIL_LOCAL_EDGE = String.raw`[\p{L}\p{M}\p{Nd}_%+\-]`;
const EMAIL_LOCAL_INNER = String.raw`[\p{L}\p{M}\p{Nd}._%+'\u2019\-]`;
const EMAIL_LABEL = String.raw`[\p{L}\p{M}\p{Nd}\-]+`;
// Top-level domain: Latin letters, punycode ("xn--ygbi2ammx") or Arabic letters ("فلسطين").
const EMAIL_TLD = String.raw`(?:xn--[A-Za-z0-9\-]+(?![A-Za-z0-9\-])|[A-Za-z]{2,}(?![A-Za-z0-9\-])|[\p{Script=Arabic}\p{M}]{2,}(?![\p{L}\p{M}\p{Nd}\-]))`;
// The address starts at the start of a word: not after another address character, and not after an
// apostrophe inside a word ("o'brien": only one candidate per word, so the search stays linear).
const EMAIL = new RegExp(
  String.raw`(?<![\p{L}\p{M}\p{Nd}._%+\-]|${EMAIL_WORD}['\u2019])${EMAIL_LOCAL_EDGE}(?:${EMAIL_LOCAL_INNER}*${EMAIL_LOCAL_EDGE})?@${EMAIL_LABEL}(?:\.${EMAIL_LABEL})*\.${EMAIL_TLD}`,
  'gu',
);

interface PhonePattern {
  re: RegExp;
  /** No + or 00 prefix: a candidate that holds a date is a date. */
  local: boolean;
  /**
   * A complete number with a valid prefix: Latin letters or "_" written against it do not make it
   * part of a code ("Mobile0599123456", "0599123456x").
   */
  letters: boolean;
  /** Written in pairs ("05 99 12 34 56"): inside a longer list of numbers it is not a phone number. */
  pairs?: boolean;
}

/** Phone patterns, tried in this order. */
const PHONE_PATTERNS: PhonePattern[] = [
  // +970 / +972 (or 00970 / 00972), optional "(0)" trunk digit, then 8 (landline) or 9 (mobile) digits.
  { re: new RegExp(String.raw`\(?(?:\+|00)97[02]\)?(?:${SEP}?\(0\))?(?:${STEP}){8,9}(?!\d)`, 'g'), local: false, letters: true },
  // Any other country: + or 00, a country code, then 7–14 subscriber digits (8–17 digits in all).
  { re: new RegExp(String.raw`\(?(?:\+|00)[1-9](?:${STEP}){7,16}(?!\d)`, 'g'), local: false, letters: false },
  // 970 / 972 mobiles written without + or 00: 970 59 912 3456, 972599123456.
  { re: new RegExp(String.raw`\(?97[02]\)?${SEP}?5\d(?:${STEP}){7}(?!\d)`, 'g'), local: false, letters: true },
  // 970 / 972 landlines written without + or 00: 970 2 298 1234.
  { re: new RegExp(String.raw`\(?97[02]\)?${SEP}?[2489](?:${STEP}){7}(?!\d)`, 'g'), local: true, letters: true },
  // Local mobiles: 05X + 7 digits (0599123456, 059-912-3456, 0599 123 456, (059) 912 3456).
  { re: new RegExp(String.raw`\(?05\d(?:${STEP}){7}(?!\d)`, 'g'), local: true, letters: true },
  // Local mobiles in pairs: 05 99 12 34 56, 05-99-12-34-56.
  { re: /\(?05[ .-]\d\d(?:[ .-]\d\d){3}(?!\d)/g, local: true, letters: true, pairs: true },
  // Local landlines: 0[2489] + 7 digits (02-298-1234, 08 282 1234, 022981234, (02) 298 1234).
  { re: new RegExp(String.raw`\(?0[2489](?:${STEP}){7}(?!\d)`, 'g'), local: true, letters: true },
];

const ID_NUMBER = /(?<!\d)\d{9}(?!\d)/g;

/** A day.month.year (or month.day.year) date inside a local phone candidate ("02.10.2026 9" is a date and an hour). */
const DATE_INSIDE = /(?<!\d)(?=(\d{1,2})([./-])(\d{1,2})\2(?:\d{4}|\d{2})(?!\d))/g;

/** A currency just before or after a 9-digit run marks an amount, not an ID number. */
const CURRENCY_BEFORE = /(?:[$€£₪]|(?<![A-Za-z])(?:USD|EUR|ILS|NIS|GBP|JOD)|شيكل|شيقل|دولار|يورو|دينار) ?$/i;
const CURRENCY_AFTER = /^ ?(?:[$€£₪]|(?:USD|EUR|ILS|NIS|GBP|JOD)(?![A-Za-z])|شيكل|شيقل|دولار|يورو|دينار)/i;

/**
 * Latin words that label an ID number written against it ("ID401234567", "NID_401234567") or
 * joined to it by a slash ("ID/401234567"). "Ref" is not one: "Ref401234567" is a reference code.
 */
const ID_LABELS = new Set(['id', 'ids', 'nid', 'idno', 'idnr', 'no', 'nos', 'nr', 'num', 'number']);
const SLASH_LABELS = new Set([...ID_LABELS, 'tel', 'phone', 'mob', 'mobile', 'fax']);

const LETTER = /[\p{L}\p{M}]/u;
const ARABIC_SCRIPT = /[\p{Script=Arabic}\u0640]/u;
const DIGIT = /\p{Nd}/u;
const SPACE = /\s/;
const SLASHES = new Set(['/', '\\']);

type Kind = 'phone' | 'idNumber';

function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && LETTER.test(ch);
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && DIGIT.test(ch);
}

/**
 * Letters that make a number part of a code ("AB123456789"). Arabic letters do not: one-letter
 * Arabic prefixes are written attached to the next word ("و0599123456" = "and 0599123456"), and a
 * missing space in Arabic text must not let a phone or ID number through.
 */
function isCodeLetter(ch: string | undefined): boolean {
  return isLetter(ch) && !ARABIC_SCRIPT.test(ch!);
}

/** Whether the run of Latin letters that ends at `end` (exclusive) is an ID label such as "ID" or "No". */
function idLabelBefore(s: string, end: number): boolean {
  let i = end;
  while (i > 0 && end - i < 8 && isCodeLetter(s[i - 1])) i--;
  return !isCodeLetter(s[i - 1]) && ID_LABELS.has(s.slice(i, end).toLowerCase());
}

/** Whether the character(s) before a candidate show it is part of a longer token (a code, a decimal, a range). */
function blockedBefore(s: string, start: number, kind: Kind, letters: boolean): boolean {
  if (start === 0) return false;
  const prev = s[start - 1];
  const before = s[start - 2];
  if (isDigit(prev)) return true;
  if (kind === 'phone') {
    // "Tel(02) 298 1234" and "Tel+44 20 7946 0958": the parenthesis or "+" separates the number from the word.
    if (prev === '_' || isCodeLetter(prev)) return !letters && s[start] !== '(' && s[start] !== '+';
  } else {
    // "ID401234567" and "ID_401234567" are ID numbers; "AB123456789" and "FILE_123456789" are codes.
    // After Arabic text ("هوية_401234567") a 9-digit run is always an ID number.
    if (isCodeLetter(prev)) return !idLabelBefore(s, start);
    if (prev === '_') return isDigit(before) || (isCodeLetter(before) && !idLabelBefore(s, start - 1));
  }
  // Decimals ("0.123456789") and, for ID numbers, ranges and joined codes ("2026-412345678"). A phone after
  // "digits-" is still a phone ("401234567-0599123456").
  if (prev === '.' && isDigit(before)) return true;
  if (prev === '-' && isDigit(before)) return kind === 'idNumber';
  return false;
}

/** Whether the character(s) after a candidate show it is part of a longer token. */
function blockedAfter(s: string, end: number, kind: Kind, letters: boolean): boolean {
  if (end >= s.length) return false;
  const next = s[end];
  if (next === '%' || isDigit(next)) return true;
  if (next === '_' || isCodeLetter(next)) return kind === 'idNumber' || !letters;
  if (next === '.' && isDigit(s[end + 1])) return true;
  // A phone followed by "-7" (an extension) is still a phone; an ID number followed by "-7" is part of a range or code.
  if (kind === 'idNumber' && next === '-' && isDigit(s[end + 1])) return true;
  return false;
}

/** Inside a list of numbers ("01 02 03 04 05 06 07 08 09 10"), a pair-grouped candidate is not a phone number. */
function insideNumberList(s: string, start: number, end: number): boolean {
  const separator = (ch: string | undefined) => ch === ' ' || ch === '.' || ch === '-';
  return (separator(s[start - 1]) && isDigit(s[start - 2])) || (separator(s[end]) && isDigit(s[end + 1]));
}

function holdsDate(candidate: string): boolean {
  if (!/[./-]/.test(candidate)) return false;
  for (const m of candidate.matchAll(DATE_INSIDE)) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    if (a >= 1 && b >= 1 && ((a <= 31 && b <= 12) || (a <= 12 && b <= 31))) return true;
  }
  return false;
}

/**
 * What a slash joins to a 9-digit run (`slash` is the slash's index, `dir` the side: -1 before, +1 after):
 * - 'personal': another ID number, or a phone number, ID number or email address already removed;
 * - 'code': part of a code, such as a year or other number ("ENI/2026/…"), letters with digits, or an
 *   upper-case code ("ECHO", "ENI") that is not a label;
 * - 'other': a word or label ("ID", "هوية", "Ahmad"), or nothing.
 * Looks at one token of at most 40 characters, so the cost per candidate is constant.
 */
function acrossSlash(s: string, slash: number, dir: -1 | 1): 'personal' | 'code' | 'other' {
  if (PLACEHOLDERS.some(p => (dir === 1 ? s.startsWith(p, slash + 1) : s.endsWith(p, slash)))) return 'personal';
  let i = slash;
  const inToken = (ch: string | undefined) => ch !== undefined && !SPACE.test(ch) && !SLASHES.has(ch);
  while (Math.abs(i - slash) < 40 && inToken(s[i + dir])) i += dir;
  const segment = dir === 1 ? s.slice(slash + 1, i + 1) : s.slice(i, slash);
  const token = segment.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (!token) return 'other';
  if (/^\d+$/.test(token)) return token.length === 9 ? 'personal' : 'code';
  if (/\d/.test(token)) return 'code';
  if (SLASH_LABELS.has(token.toLowerCase())) return 'other';
  return /^[A-Z]{2,}$/.test(token) ? 'code' : 'other';
}

/** Whether a slash joins the 9-digit run to a code ("ENI/2026/412345678") and not to other personal data. */
function slashJoinsCode(s: string, start: number, end: number): boolean {
  const before = SLASHES.has(s[start - 1]) ? acrossSlash(s, start - 1, -1) : 'other';
  const after = SLASHES.has(s[end]) ? acrossSlash(s, end, 1) : 'other';
  if (before === 'personal' || after === 'personal') return false;
  return before === 'code' || after === 'code';
}

type Range = [start: number, end: number];

function acceptPhone(s: string, start: number, end: number, pattern: PhonePattern): Range | null {
  // Keep an opening parenthesis that wraps the whole number outside the match: "(0599123456)" → "([phone removed])".
  if (s[start] === '(' && !s.slice(start, end).includes(')')) start += 1;
  if (blockedBefore(s, start, 'phone', pattern.letters) || blockedAfter(s, end, 'phone', pattern.letters)) return null;
  if (pattern.pairs && insideNumberList(s, start, end)) return null;
  if (pattern.local && holdsDate(s.slice(start, end))) return null;
  return [start, end];
}

function acceptIdNumber(s: string, start: number, end: number): Range | null {
  if (blockedBefore(s, start, 'idNumber', false) || blockedAfter(s, end, 'idNumber', false)) return null;
  if (slashJoinsCode(s, start, end)) return null;
  if (CURRENCY_BEFORE.test(s.slice(Math.max(0, start - 8), start)) || CURRENCY_AFTER.test(s.slice(end, end + 8))) return null;
  return [start, end];
}

interface State {
  text: string;
  shadow: string;
}

/**
 * Replaces every accepted match of `re` in the state with `placeholder`; returns the number of replacements.
 * `accept` returns the range to replace (possibly narrowed), or null to reject the candidate. Candidates are
 * judged on the text as it was before this pass, so every item of a chain ("a/b/c") is judged the same way.
 */
function replacePass(state: State, re: RegExp, accept: (s: string, start: number, end: number) => Range | null, placeholder: string): number {
  const ranges: Range[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(state.shadow)) !== null) {
    const start = m.index;
    const range = accept(state.shadow, start, start + m[0].length);
    if (range) {
      ranges.push(range);
      re.lastIndex = range[1];
    } else {
      // Try again from the next character: a later start may still be a valid match.
      re.lastIndex = start + 1;
    }
  }
  if (ranges.length === 0) return 0;

  let text = '';
  let shadow = '';
  let at = 0;
  for (const [start, end] of ranges) {
    text += state.text.slice(at, start) + placeholder;
    shadow += state.shadow.slice(at, start) + placeholder;
    at = end;
  }
  state.text = text + state.text.slice(at);
  state.shadow = shadow + state.shadow.slice(at);
  return ranges.length;
}

/** One round: emails, then phone numbers, then ID numbers (so a phone is never counted as an ID). */
function redactRound(state: State, counts: RedactionCounts): number {
  let removed = 0;
  const email = replacePass(state, EMAIL, (_s, start, end) => [start, end], REDACTION_PLACEHOLDERS.email);
  counts.email += email;
  removed += email;
  for (const pattern of PHONE_PATTERNS) {
    const phone = replacePass(state, pattern.re, (s, start, end) => acceptPhone(s, start, end, pattern), REDACTION_PLACEHOLDERS.phone);
    counts.phone += phone;
    removed += phone;
  }
  const id = replacePass(state, ID_NUMBER, acceptIdNumber, REDACTION_PLACEHOLDERS.idNumber);
  counts.idNumber += id;
  removed += id;
  return removed;
}

/**
 * A removal can free a neighbour that an earlier pass rejected (an email address written against a phone
 * number: "ahmad@ngo.ps0599123456"), so rounds repeat until nothing changes. A whole chain ("a/b/c/…") is
 * handled in one round, so the number of rounds does not grow with the text; the cap keeps it so.
 */
const MAX_ROUNDS = 4;

export function redactPersonalData(text: string): RedactionResult {
  const counts: RedactionCounts = { phone: 0, idNumber: 0, email: 0 };
  if (!text) return { text: text ?? '', counts };

  const state: State = { text, shadow: toShadow(text) };
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (redactRound(state, counts) === 0) break;
  }
  return { text: state.text, counts };
}
