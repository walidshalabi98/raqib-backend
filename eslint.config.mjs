import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'storage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mts'],
    languageOptions: { globals: globals.node },
    rules: {
      // The codebase uses `any` at AI-response and Prisma boundaries; tightened in Phase 3.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // Express augments the global Express namespace.
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
    },
  },
  {
    // CLAUDE.md rule 4: AI calls go through src/services/ai/client.ts only.
    files: ['src/**/*.ts'],
    // outputSchema.ts uses only the SDK's JSON schema transform (no client, no model calls).
    ignores: ['src/services/ai/client.ts', 'src/services/ai/models.ts', 'src/services/ai/outputSchema.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['@anthropic-ai/sdk', '@anthropic-ai/sdk/*'],
          message: 'Call the model through generateStructured() in src/services/ai/client.ts (CLAUDE.md rule 4); only client.ts, models.ts and outputSchema.ts may import the Anthropic SDK.',
        }],
      }],
    },
  },
  {
    files: ['src/services/ai/outputSchema.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          regex: '^@anthropic-ai/sdk(?!/lib/transform-json-schema$)(/.*)?$',
          message: 'outputSchema.ts may import only the SDK JSON schema transform; model calls go through client.ts (CLAUDE.md rule 4).',
        }],
      }],
    },
  },
);
