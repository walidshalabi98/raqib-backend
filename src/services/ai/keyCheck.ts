/**
 * Whether ANTHROPIC_API_KEY looks like a real key (env-free; moved from scripts/ai-smoke.ts, which re-exports it;
 * design section 4.5). Used by the KPI availability check, the smoke script and the eval CLI.
 *
 * Step 0 stub (Phase 4 contracts): the signature is final; E5 moves the implementation here.
 */

/** Why the key cannot be used (missing, placeholder, not sk-ant-…), or null when it looks real. Never echoes the key. */
export function apiKeyProblem(_key: string | undefined): string | null {
  throw new Error('Phase 4: not implemented (E5)');
}
