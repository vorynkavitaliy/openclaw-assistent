// @ts-check
import eslint from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // ─── Ignore patterns ────────────────────────────────────────
  { ignores: ['dist/', 'node_modules/', 'scripts/', '*.js', '!eslint.config.js'] },

  // ─── Base ESLint recommended ────────────────────────────────
  eslint.configs.recommended,

  // ─── TypeScript strict + type-checked rules ─────────────────
  ...tseslint.configs.recommendedTypeChecked,

  // ─── Prettier compat (disables conflicting format rules) ────
  prettierConfig,

  // ─── Global settings ────────────────────────────────────────
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // ─── Custom rules ───────────────────────────────────────────
  {
    rules: {
      // Allow unused vars prefixed with _
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

      // Return types: warn, not error
      '@typescript-eslint/explicit-function-return-type': 'off',

      // Allow any in specific cases (warn, not error)
      '@typescript-eslint/no-explicit-any': 'warn',

      // Prefer modern TS patterns
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',

      // Console is fine for CLI tools
      'no-console': 'off',

      // Floating promises must be handled
      '@typescript-eslint/no-floating-promises': 'error',

      // No misused promises (common async mistake)
      '@typescript-eslint/no-misused-promises': 'error',

      // Allow require() for dynamic config loading
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
