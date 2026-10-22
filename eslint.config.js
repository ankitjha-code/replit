import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/*.d.ts',
      'apps/api/src/generated/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'smart'],
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  {
    files: ['apps/api/src/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'dockerode',
              message: 'Container access belongs behind the ExecutionProvider abstraction.',
            },
            {
              name: 'node:child_process',
              message:
                'The control plane never runs commands on its host. Execution belongs behind the ExecutionProvider abstraction.',
            },
            {
              name: 'child_process',
              message:
                'The control plane never runs commands on its host. Execution belongs behind the ExecutionProvider abstraction.',
            },
          ],
          patterns: [
            {
              group: ['**/apps/web/**', '**/web/src/**', '@platform/web'],
              message: 'The backend must not import frontend code.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/api/src/execution/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/web/**', '**/web/src/**', '@platform/web'],
              message: 'The backend must not import frontend code.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/api/src/http/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@prisma/client',
              message:
                'Database access belongs in the repository layer. Call a service from HTTP code.',
            },
            {
              name: 'dockerode',
              message: 'Container access belongs behind the ExecutionProvider abstraction.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/api/**', '**/api/src/**', '@platform/api'],
              message:
                'The frontend must not import backend internals. Share types via @platform/shared.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/ui/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['radix-ui', 'radix-ui/*'],
              message:
                'Radix is wrapped by the primitives in src/ui (Dialog, Menu, Tooltip, Tabs, ...). Import those instead.',
            },
            {
              group: ['@phosphor-icons/react', '@phosphor-icons/react/*'],
              message: 'Icons come from src/ui/icons.ts, which holds the one set the product uses.',
            },
            {
              group: ['**/apps/api/**', '**/api/src/**', '@platform/api'],
              message:
                'The frontend must not import backend internals. Share types via @platform/shared.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['**/*.config.{js,ts}', '**/vitest.config.ts', 'eslint.config.js', 'scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },

  prettier,
);
