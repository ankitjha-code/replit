import root from '../../eslint.config.js';

export const uiBoundary = {
  files: ['apps/web/src/**/*.{ts,tsx}', 'src/**/*.{ts,tsx}'],
  ignores: ['apps/web/src/ui/**', 'src/ui/**'],
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
};

export default [...root, uiBoundary];
