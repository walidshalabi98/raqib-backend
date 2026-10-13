/**
 * Whether ANTHROPIC_API_KEY looks like a real key (env-free; moved from scripts/ai-smoke.ts, which re-exports it;
 * design section 4.5). Used by the KPI availability check (POST answers 503 ai_not_configured without a real key,
 * design 1.2), the smoke script and the eval CLI. Never echoes the key (CLAUDE.md rule 3).
 */

/** Placeholder words that mark an example or test key (sk-ant-test-not-a-real-key, sk-ant-api03-your-key-here…). */
const PLACEHOLDER_WORD = /(^|[-_.])(test|placeholder|your|example|changeme|change-me|dummy|fake|xxx+|not-a-real)([-_.]|$)/i;

/** The shape of an Anthropic API key: "sk-ant-" and at least 20 more key characters. */
const ANTHROPIC_KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

/**
 * Why the key cannot be a real Anthropic API key (missing, a placeholder, or not shaped like sk-ant-…), or null when
 * it looks like one. The message never contains the key itself.
 */
export function apiKeyProblem(key: string | undefined): string | null {
  const value = (key ?? '').trim();
  if (!value) return 'ANTHROPIC_API_KEY is not set.';
  if (PLACEHOLDER_WORD.test(value)) return 'ANTHROPIC_API_KEY looks like a placeholder; set a real key in .env.';
  if (!ANTHROPIC_KEY_SHAPE.test(value)) return 'ANTHROPIC_API_KEY does not look like an Anthropic API key (sk-ant-…); set a real key in .env.';
  return null;
}
