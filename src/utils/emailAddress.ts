/**
 * The stored form of an email address: trimmed and lower-cased. Accounts are stored and looked up in this form,
 * so "Name@Example.org " at sign-in finds the account invited as "name@example.org".
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
