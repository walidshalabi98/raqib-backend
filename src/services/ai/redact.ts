/**
 * Removes personal data that can be recognised reliably (phone numbers, ID numbers, email
 * addresses) from text before it is stored for AI use or sent to a model
 * (CLAUDE.md rule 5, knowledge/me-foundations.md §12).
 *
 * CONTRACT (other modules depend on it): redactPersonalData(text) → { text, counts }.
 * STATUS: contract stub; the patterns are being written. Until then it returns the text unchanged.
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

export function redactPersonalData(text: string): RedactionResult {
  return { text, counts: { phone: 0, idNumber: 0, email: 0 } };
}
