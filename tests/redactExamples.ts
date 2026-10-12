/**
 * Example strings for redactPersonalData, shared by tests/redact.test.ts (exact output and counts)
 * and tests/redactStoredText.test.ts (idempotence of the backfill).
 */
import { REDACTION_PLACEHOLDERS, RedactionCounts } from '../src/services/ai/redact';

export const P = REDACTION_PLACEHOLDERS.phone;
export const I = REDACTION_PLACEHOLDERS.idNumber;
export const E = REDACTION_PLACEHOLDERS.email;

const NBSP = String.fromCharCode(0x00a0);
const RLM = String.fromCharCode(0x200f);
const EN_DASH = String.fromCharCode(0x2013);
const ZWSP = String.fromCharCode(0x200b);
const ZWNJ = String.fromCharCode(0x200c);
const SOFT_HYPHEN = String.fromCharCode(0x00ad);
const BOM = String.fromCharCode(0xfeff);
const FULLWIDTH_AT = String.fromCharCode(0xff20);
const FULLWIDTH_STOP = String.fromCharCode(0xff0e);

export function counts(phone: number, idNumber: number, email: number): RedactionCounts {
  return { phone, idNumber, email };
}

/** [input, expected text, expected counts] */
export const POSITIVES: [string, string, RedactionCounts][] = [
  // International phones (+ or 00 prefix)
  ['Call +970 59 912 3456 for details.', `Call ${P} for details.`, counts(1, 0, 0)],
  ['WhatsApp: 00972-59-912-3456', `WhatsApp: ${P}`, counts(1, 0, 0)],
  ['US office: +1 202 555 0143.', `US office: ${P}.`, counts(1, 0, 0)],
  ['Office (+970) 2 298 1234 (Ramallah)', `Office ${P} (Ramallah)`, counts(1, 0, 0)],
  ['Mobile +970 (0)59 912 3456', `Mobile ${P}`, counts(1, 0, 0)],
  ['+970599123456', P, counts(1, 0, 0)],
  ['+970-2-298-1234', P, counts(1, 0, 0)],
  ['London +44 20 7946 0958 or +44-20-7946-0958', `London ${P} or ${P}`, counts(2, 0, 0)],
  ['tel:+970599123456', `tel:${P}`, counts(1, 0, 0)],
  ['970 59 912 3456 and 972599123456', `${P} and ${P}`, counts(2, 0, 0)],
  // Local mobiles 05X + 7 digits
  ['0599123456', P, counts(1, 0, 0)],
  ['Contact Ahmad on 059-912-3456 or 0599 123 456.', `Contact Ahmad on ${P} or ${P}.`, counts(2, 0, 0)],
  ['(059) 912 3456', P, counts(1, 0, 0)],
  ['0599-123456 / 059-9123456 / 059.912.3456', `${P} / ${P} / ${P}`, counts(3, 0, 0)],
  ['Call (0599123456) today', `Call (${P}) today`, counts(1, 0, 0)],
  ['0599123456 0569876543', `${P} ${P}`, counts(2, 0, 0)],
  ['0599123456/0599654321', `${P}/${P}`, counts(2, 0, 0)],
  ['0599123456-7', `${P}-7`, counts(1, 0, 0)],
  [`0599${NBSP}123${NBSP}456`, P, counts(1, 0, 0)],
  [`0599${EN_DASH}123456`, P, counts(1, 0, 0)],
  [`${RLM}0599123456${RLM}`, `${RLM}${P}${RLM}`, counts(1, 0, 0)],
  // Pairs, double spaces, tabs, a line break or an invisible character inside the number
  ['05 99 12 34 56', P, counts(1, 0, 0)],
  ['Mobile: 05-99-12-34-56.', `Mobile: ${P}.`, counts(1, 0, 0)],
  ['0599-12-34-56', P, counts(1, 0, 0)],
  ['0599  123456', P, counts(1, 0, 0)],
  ['059\t912\t3456', P, counts(1, 0, 0)],
  ['0599\n123456', P, counts(1, 0, 0)],
  ['call 059 912\n3456 today', `call ${P} today`, counts(1, 0, 0)],
  ['0599\r\n123456', P, counts(1, 0, 0)],
  [`059${ZWSP}9123456`, P, counts(1, 0, 0)],
  [`0599${ZWNJ}123456`, P, counts(1, 0, 0)],
  [`0599${SOFT_HYPHEN}123456`, P, counts(1, 0, 0)],
  [`${BOM}0599123456`, `${BOM}${P}`, counts(1, 0, 0)],
  ['+970  599123456', P, counts(1, 0, 0)],
  // Latin letters or "_" written against a complete phone number
  ['Mobile0599123456', `Mobile${P}`, counts(1, 0, 0)],
  ['phone0599123456x', `phone${P}x`, counts(1, 0, 0)],
  ['Tel_022981234', `Tel_${P}`, counts(1, 0, 0)],
  ['INV0599123456', `INV${P}`, counts(1, 0, 0)], // known trade-off: a code with a complete phone number loses it
  // Slashes: chains, labels and links
  ['0599123456/0599123457/0599123458/0599123459', `${P}/${P}/${P}/${P}`, counts(4, 0, 0)],
  ['x0599123456/0599123457', `x${P}/${P}`, counts(2, 0, 0)],
  ['Tel/0599123456', `Tel/${P}`, counts(1, 0, 0)],
  ['هاتف/0599123456', `هاتف/${P}`, counts(1, 0, 0)],
  ['wa.me/970599123456', `wa.me/${P}`, counts(1, 0, 0)],
  ['2026/0599123456', `2026/${P}`, counts(1, 0, 0)],
  // 970 / 972 landlines without + or 00
  ['970 2 298 1234', P, counts(1, 0, 0)],
  ['Office 972-2-298-1234.', `Office ${P}.`, counts(1, 0, 0)],
  // Local landlines 0[2489] + 7 digits
  ['Office: 02-298-1234', `Office: ${P}`, counts(1, 0, 0)],
  ['Gaza 08 282 1234, Hebron 022981234', `Gaza ${P}, Hebron ${P}`, counts(2, 0, 0)],
  ['(02) 298 1234 and 04-2501234 and 09 238 1234', `${P} and ${P} and ${P}`, counts(3, 0, 0)],
  ['Tel(02) 298 1234', `Tel${P}`, counts(1, 0, 0)],
  // Arabic text, Arabic-Indic and Extended Arabic-Indic digits
  ['للتواصل: ٠٥٩٩١٢٣٤٥٦ أو ٠٢-٢٩٨-١٢٣٤', `للتواصل: ${P} أو ${P}`, counts(2, 0, 0)],
  ['جوال المنسقة ۰۵۹۹۱۲۳۴۵۶', `جوال المنسقة ${P}`, counts(1, 0, 0)],
  ['هاتف ٠٥٩٩١٢٣٤٥٦ و٠٥٦٢٢٢٣٣٣٤', `هاتف ${P} و${P}`, counts(2, 0, 0)],
  ['رقم الهاتف +٩٧٠٥٩٩١٢٣٤٥٦ والبريد sara@example.ps', `رقم الهاتف ${P} والبريد ${E}`, counts(1, 0, 1)],
  ['الهاتف0599123456', `الهاتف${P}`, counts(1, 0, 0)],
  ['رقم الهوية: ٤٠١٢٣٤٥٦٧ للمستفيدة', `رقم الهوية: ${I} للمستفيدة`, counts(0, 1, 0)],
  ['هوية رقم ۴۰۱۲۳۴۵۶۷.', `هوية رقم ${I}.`, counts(0, 1, 0)],
  ['الهوية401234567', `الهوية${I}`, counts(0, 1, 0)],
  // ID numbers: standalone runs of exactly 9 digits
  ['ID 401234567.', `ID ${I}.`, counts(0, 1, 0)],
  ['ID:401234567', `ID:${I}`, counts(0, 1, 0)],
  ['Beneficiary #401234567 (female, 34)', `Beneficiary #${I} (female, 34)`, counts(0, 1, 0)],
  ['Ref-401234567', `Ref-${I}`, counts(0, 1, 0)],
  ['IDs: 401234567, 987654321; 123456789', `IDs: ${I}, ${I}; ${I}`, counts(0, 3, 0)],
  ['599123456', I, counts(0, 1, 0)],
  // ID numbers after a label written against them, or joined by a slash to a label or to other personal data
  ['ID401234567', `ID${I}`, counts(0, 1, 0)],
  ['No401234567 and Nr.401234567', `No${I} and Nr.${I}`, counts(0, 2, 0)],
  ['NID_401234567', `NID_${I}`, counts(0, 1, 0)],
  ['هوية_401234567', `هوية_${I}`, counts(0, 1, 0)],
  ['ID/401234567', `ID/${I}`, counts(0, 1, 0)],
  ['هوية/401234567', `هوية/${I}`, counts(0, 1, 0)],
  ['رقم الهوية/٤٠١٢٣٤٥٦٧', `رقم الهوية/${I}`, counts(0, 1, 0)],
  ['IDs 401234567/401234568', `IDs ${I}/${I}`, counts(0, 2, 0)],
  ['401234567/402345678/403456789', `${I}/${I}/${I}`, counts(0, 3, 0)],
  ['401234567/0599123456', `${I}/${P}`, counts(1, 1, 0)],
  ['0599123456/401234567', `${P}/${I}`, counts(1, 1, 0)],
  ['ahmad@example.org/401234567', `${E}/${I}`, counts(0, 1, 1)],
  ['Ahmad/401234567', `Ahmad/${I}`, counts(0, 1, 0)],
  ['ENI/2026/412345678/412345679', `ENI/2026/${I}/${I}`, counts(0, 2, 0)],
  // Spreadsheet rows (the parser joins cells with commas)
  ['1,Amal,401234567,0599123456,F,34', `1,Amal,${I},${P},F,34`, counts(1, 1, 0)],
  ['"401234567","0599 123 456"', `"${I}","${P}"`, counts(1, 1, 0)],
  ['401234567-0599123456', `${I}-${P}`, counts(1, 1, 0)],
  ['401234567 00972599123456', `${I} ${P}`, counts(1, 1, 0)],
  // Emails
  ['Write to ahmad.k@example.org.', `Write to ${E}.`, counts(0, 0, 1)],
  ['mailto:a.b+c@mail.example.co.uk', `mailto:${E}`, counts(0, 0, 1)],
  ['Contact: ali@ngo.ps، 0599123456', `Contact: ${E}، ${P}`, counts(1, 0, 1)],
  ['ahmad0599123456@gmail.com', E, counts(0, 0, 1)],
  ['first.last_99@sub.domain.ps; other@x.io', `${E}; ${E}`, counts(0, 0, 2)],
  ['user@xn--mgbh0fb.xn--ygbi2ammx', E, counts(0, 0, 1)],
  ['أحمد@مثال.فلسطين', E, counts(0, 0, 1)],
  ['راسلوا ahmad@مثال.ps للمزيد', `راسلوا ${E} للمزيد`, counts(0, 0, 1)],
  [`Ahmad${FULLWIDTH_AT}ngo.ps`, E, counts(0, 0, 1)],
  [`ahmad@ngo${FULLWIDTH_STOP}ps`, E, counts(0, 0, 1)],
  ["o'brien@ngo.org", E, counts(0, 0, 1)],
  ["Write to 'ahmad@ngo.org'.", `Write to '${E}'.`, counts(0, 0, 1)],
  ['البريد ahmad@ngo.psوالهاتف 0599123456', `البريد ${E}والهاتف ${P}`, counts(1, 0, 1)],
  ['ahmad@ngo.ps0599123456', `${E}${P}`, counts(1, 0, 1)],
];

/** Text that must come back unchanged. */
export const NEGATIVES: string[] = [
  // Years, dates and times
  'In 2026 the project reached 1,250 households.',
  '2026-10-12', '12/10/2026', '12.10.2026', '05/10/2026', '08-10-2026', '2026/10/12',
  'Collected on 02.10.2026 9:30 and 09.10.2026 10:00.',
  '2026-10-12T08:30:00Z', '2026-10-12T08:30:00.123456789Z', '2026-10-12 08:30:00',
  'من ١٢/١٠/٢٠٢٦ إلى ٣١/١٢/٢٠٢٧',
  // Amounts with thousands separators, decimals, percentages, short numbers
  'Budget: 1,200,000 EUR; 12,500,000 USD; 123,456,789 ILS.',
  'الميزانية ١٬٢٠٠٬٠٠٠ يورو',
  '3.14 and 0.5 and 1234.5678',
  '0.123456789 and 123456789.5',
  '22% of women; ٢٢٪ من النساء',
  '45 teachers, 120 schools, 3 governorates',
  '100000000-200000000',
  'USD 123456789 and 123456789 ILS and $123456789',
  'المبلغ 123456789 شيكل',
  // Codes and references
  'O1.2 contributes to EU GERF 2.14 and SDG 6.1.1.',
  'GERF 2.32, Output 1.1.3, Activity A2.4',
  'Grant ENI/2026/412345678 and ECHO/-ME/BUD/2026/91012',
  'ECHO/412345678, REF/401234567 and (ENI/2026/412345678)',
  'File C:\\grants\\2026\\412345678.pdf',
  'Contract 2026-412345678',
  'AB123456789 and 123456789x',
  'Ref401234567, FILE_401234567 and 2026_401234567',
  // Lists of short numbers are not pair-grouped phone numbers
  'Months 01 02 03 04 05 06 07 08 09 10 11 12',
  '05.10.2026 and 05-12-34',
  // 8-digit and 10+-digit runs that are not phones
  '12345678', '1234567890', '12345678901', '1728721800', '0229812345',
  // Plain text and the placeholders themselves
  'No personal data here.',
  `${P} ${I} ${E}`,
  '',
];
