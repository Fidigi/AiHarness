import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: [
      'packages/core/src/**/*.test.ts',
      'packages/cli/src/**/*.test.ts',
      'packages/web/src/**/*.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.*/**',
      '**/e2e/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: [
        'packages/core/src/**/*.ts',
        'packages/cli/src/**/*.ts',
        'packages/web/src/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.mock.ts',
        '**/tests/**',
      ],
    },
  },
});
