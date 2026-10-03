import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    include: [
      'packages/core/src/**/*.test.ts',
      'packages/cli/src/**/*.test.ts',
      'packages/server/src/**/*.test.ts',
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
        'packages/server/src/**/*.ts',
        'packages/web/src/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.mock.ts',
        '**/tests/**',
      ],
      thresholds: {
        statements: 68,
        branches: 55,
        functions: 70,
        lines: 70,
      },
    },
  },
  resolve: {
    alias: [
      { find: '@ai-harness/core/shell-input', replacement: path.resolve(import.meta.dirname, 'packages/core/src/tools/shell-input.ts') },
      { find: '@ai-harness/core', replacement: path.resolve(import.meta.dirname, 'packages/core/src/index.ts') },
      { find: '@ai-harness/cli', replacement: path.resolve(import.meta.dirname, 'packages/cli/src/index.ts') },
      { find: '@ai-harness/server', replacement: path.resolve(import.meta.dirname, 'packages/server/src/index.ts') },
    ],
  },
});
