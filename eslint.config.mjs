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
);
