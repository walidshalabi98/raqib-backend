import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Files where only client.ts and models.ts may use the Anthropic SDK (or any other @anthropic-ai
 * package), and outputSchema.ts only its JSON schema transform.
 */
const AI_RULE_FILES = ['src/**/*.ts', 'scripts/**/*.ts', 'prisma/**/*.ts'];
const SDK_MESSAGE =
  'Call the model through generateStructured() in src/services/ai/client.ts (CLAUDE.md rule 4); only client.ts and models.ts may import the Anthropic SDK or another @anthropic-ai package (outputSchema.ts: the JSON schema transform only).';

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
    // CLAUDE.md rule 4: AI calls go through src/services/ai/client.ts only (also in scripts and the seed).
    files: AI_RULE_FILES,
    // outputSchema.ts uses only the SDK's JSON schema transform (no client, no model calls).
    ignores: ['src/services/ai/client.ts', 'src/services/ai/models.ts', 'src/services/ai/outputSchema.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['@anthropic-ai/*'],
          message: SDK_MESSAGE,
        }],
      }],
    },
  },
  {
    // The same rule for dynamic import() and require(), which no-restricted-imports does not see.
    // (esquery regexes cannot contain "/", hence "." after the scope.)
    files: AI_RULE_FILES,
    ignores: ['src/services/ai/client.ts', 'src/services/ai/models.ts'],
    rules: {
      'no-restricted-syntax': ['error',
        { selector: 'ImportExpression[source.value=/^@anthropic-ai./]', message: SDK_MESSAGE },
        { selector: 'ImportExpression > TemplateLiteral.source[quasis.0.value.raw=/^@anthropic-ai./]', message: SDK_MESSAGE },
        { selector: "CallExpression[callee.name='require'][arguments.0.value=/^@anthropic-ai./]", message: SDK_MESSAGE },
      ],
    },
  },
  {
    files: ['src/services/ai/outputSchema.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          regex: '^@anthropic-ai/(?!sdk/lib/transform-json-schema$)',
          message: 'outputSchema.ts may import only the SDK JSON schema transform; model calls go through client.ts (CLAUDE.md rule 4).',
        }],
      }],
    },
  },
);
