/**
 * Removes personal data that can be recognised reliably (phone numbers, ID numbers, email
 * addresses) from text before it is stored for AI use or sent to a model
 * (CLAUDE.md rule 5, knowledge/me-foundations.md §12).
 *
 * CONTRACT (other modules depend on it): redactPersonalData(text) → { text, counts }.
 *
 * Pure function, no I/O. Handles ASCII, Arabic-Indic (٠-٩) and Extended Arabic-Indic (۰-۹)
 * digits and Arabic text around them. Names and street addresses cannot be recognised
 * reliably by patterns, so prompts must still tell the model never to output them.
 *
 * What is removed:
 * - email addresses;
 * - phone numbers (before ID numbers): international numbers with a + or 00 prefix,
 *   970/972 mobiles written without the prefix, local mobiles 05X + 7 digits and local
 *   landlines 0[2489] + 7 digits, with optional single separators (space, dash, dot, parentheses);
 * - ID numbers: a standalone run of exactly 9 digits (Palestinian ID numbers have 9 digits).
 *
 * What is kept: years and dates, amounts with thousands separators, decimals, percentages,
 * short numbers, codes such as "O1.2" or "EU GERF 2.14", grant numbers with slashes, other
 * digit runs (8 digits, 10+ digits) that are not phone numbers, and timestamps.
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

// ---------------------------------------------------------------------------
// Matching runs on a "shadow" copy of the text with the same length: Arabic digits become
// ASCII digits, space and dash variants become " " and "-", and invisible direction marks
// become spaces. Every mapped character is one UTF-16 code unit, so match positions in the
// shadow are positions in the original text.
// ---------------------------------------------------------------------------

const SHADOW_CHARS = /[\u0660-\u0669\u06F0-\u06F9\u066A-\u066C\u00A0\u2000-\u200A\u202F\u205F\u3000\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;

function shadowChar(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660); // Arabic-Indic digits
  if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0); // Extended Arabic-Indic digits
  if (code === 0x066a) return '%'; // Arabic percent sign
  if (code === 0x066b) return '.'; // Arabic decimal separator
  if (code === 0x066c) return ','; // Arabic thousands separator
  if ((code >= 0x2010 && code <= 0x2015) || code === 0x2212 || code === 0xfe58 || code === 0xfe63 || code === 0xff0d) return '-';
  return ' '; // no-break, thin and other spaces; direction marks
}

function toShadow(text: string): string {
  return text.replace(SHADOW_CHARS, shadowChar);
}

// One digit, optionally preceded by ")", one separator and "(" (e.g. "059) 912-3456").
const STEP = String.raw`\)?[ .\-]?\(?\d`;

const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])/g;

/** Phone patterns, tried in this order. `local` patterns get the date check (they have no +/00 prefix). */
const PHONE_PATTERNS: { re: RegExp; local: boolean }[] = [
  // +970 / +972 (or 00970 / 00972), optional "(0)" trunk digit, then 8 (landline) or 9 (mobile) digits.
  { re: new RegExp(String.raw`\(?(?:\+|00)97[02]\)?(?:[ .\-]?\(0\))?(?:${STEP}){8,9}(?!\d)`, 'g'), local: false },
  // Any other country: + or 00, a country code, then 7–14 subscriber digits (8–17 digits in all).
  { re: new RegExp(String.raw`\(?(?:\+|00)[1-9](?:${STEP}){7,16}(?!\d)`, 'g'), local: false },
  // 970 / 972 mobiles written without + or 00: 970 59 912 3456, 972599123456.
  { re: new RegExp(String.raw`\(?97[02]\)?[ .\-]?5\d(?:${STEP}){7}(?!\d)`, 'g'), local: false },
  // Local mobiles: 05X + 7 digits (0599123456, 059-912-3456, 0599 123 456, (059) 912 3456).
  { re: new RegExp(String.raw`\(?05\d(?:${STEP}){7}(?!\d)`, 'g'), local: true },
  // Local landlines: 0[2489] + 7 digits (02-298-1234, 08 282 1234, 022981234, (02) 298 1234).
  { re: new RegExp(String.raw`\(?0[2489](?:${STEP}){7}(?!\d)`, 'g'), local: true },
];

const ID_NUMBER = /(?<!\d)\d{9}(?!\d)/g;

/** A day.month.year date inside a local phone candidate ("02.10.2026 9" is a date and an hour, not a phone). */
const DATE_INSIDE = /(?<!\d)\d{1,2}([./-])\d{1,2}\1(?:\d{4}|\d{2})(?!\d)/;

/** A currency just before or after a 9-digit run marks an amount, not an ID number. */
const CURRENCY_BEFORE = /(?:[$€£₪]|(?<![A-Za-z])(?:USD|EUR|ILS|NIS|GBP|JOD)|شيكل|شيقل|دولار|يورو|دينار) ?$/i;
const CURRENCY_AFTER = /^ ?(?:[$€£₪]|(?:USD|EUR|ILS|NIS|GBP|JOD)(?![A-Za-z])|شيكل|شيقل|دولار|يورو|دينار)/i;

const LETTER = /[\p{L}\p{M}]/u;
const ARABIC_SCRIPT = /[\p{Script=Arabic}\u0640]/u;
const DIGIT = /\p{Nd}/u;

type Kind = 'phone' | 'idNumber';

function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && LETTER.test(ch);
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && DIGIT.test(ch);
}

/**
 * Letters that make a number part of a code ("INV0599123456", "AB123456789"). Arabic letters do not:
 * one-letter Arabic prefixes are written attached to the next word ("و0599123456" = "and 0599123456"),
 * and a missing space in Arabic text must not let a phone or ID number through.
 */
function isCodeLetter(ch: string | undefined): boolean {
  return isLetter(ch) && !ARABIC_SCRIPT.test(ch!);
}

/** Whether the character(s) before a candidate show it is part of a longer token (a code, a decimal, a range, a path). */
function blockedBefore(s: string, start: number, kind: Kind): boolean {
  if (start === 0) return false;
  const prev = s[start - 1];
  const before = s[start - 2];
  if (prev === '_' || isDigit(prev)) return true;
  // "Tel(02) 298 1234": an opening parenthesis separates the number from the word.
  if (isCodeLetter(prev)) return s[start] !== '(';
  // Decimals ("0.123456789") and, for ID numbers, ranges and joined codes ("2026-412345678"). A phone after
  // "digits-" is still a phone ("401234567-0599123456").
  if (prev === '.' && isDigit(before)) return true;
  if (prev === '-' && isDigit(before)) return kind === 'idNumber';
  // Grant and file numbers use slashes ("ENI/2026/412345678"); a phone after "]/" (a removed phone) is still a phone.
  if (prev === '/' || prev === '\\') return kind === 'idNumber' || isDigit(before) || isLetter(before);
  return false;
}

/** Whether the character(s) after a candidate show it is part of a longer token. */
function blockedAfter(s: string, end: number, kind: Kind): boolean {
  if (end >= s.length) return false;
  const next = s[end];
  if (next === '_' || next === '%' || isDigit(next) || isCodeLetter(next)) return true;
  if (next === '.' && isDigit(s[end + 1])) return true;
  // A phone followed by "-7" (an extension) or "/5" (a second number sharing the prefix) is still a phone.
  if (kind === 'idNumber') {
    if (next === '/' || next === '\\') return true;
    if (next === '-' && isDigit(s[end + 1])) return true;
  }
  return false;
}

type Range = [start: number, end: number];

function acceptPhone(s: string, start: number, end: number, local: boolean): Range | null {
  // Keep an opening parenthesis that wraps the whole number outside the match: "(0599123456)" → "([phone removed])".
  if (s[start] === '(' && !s.slice(start, end).includes(')')) start += 1;
  if (blockedBefore(s, start, 'phone') || blockedAfter(s, end, 'phone')) return null;
  if (local && DATE_INSIDE.test(s.slice(start, end))) return null;
  return [start, end];
}

function acceptIdNumber(s: string, start: number, end: number): Range | null {
  if (blockedBefore(s, start, 'idNumber') || blockedAfter(s, end, 'idNumber')) return null;
  if (CURRENCY_BEFORE.test(s.slice(Math.max(0, start - 8), start)) || CURRENCY_AFTER.test(s.slice(end, end + 8))) return null;
  return [start, end];
}

interface State {
  text: string;
  shadow: string;
}

/**
 * Replaces every accepted match of `re` in the state with `placeholder`; returns the number of replacements.
 * `accept` returns the range to replace (possibly narrowed), or null to reject the candidate.
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
  for (const { re, local } of PHONE_PATTERNS) {
    const phone = replacePass(state, re, (s, start, end) => acceptPhone(s, start, end, local), REDACTION_PLACEHOLDERS.phone);
    counts.phone += phone;
    removed += phone;
  }
  const id = replacePass(state, ID_NUMBER, acceptIdNumber, REDACTION_PLACEHOLDERS.idNumber);
  counts.idNumber += id;
  removed += id;
  return removed;
}

export function redactPersonalData(text: string): RedactionResult {
  const counts: RedactionCounts = { phone: 0, idNumber: 0, email: 0 };
  if (!text) return { text: text ?? '', counts };

  const state: State = { text, shadow: toShadow(text) };
  // A removal can free a neighbour that was blocked by it ("0599123456/0599654321"), so repeat until
  // nothing changes. Every removal deletes digits or an "@" that placeholders do not contain, so this
  // ends; it also makes the function idempotent (redacting twice gives the same text).
  while (redactRound(state, counts) > 0) { /* repeat */ }
  return { text: state.text, counts };
}
