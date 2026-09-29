import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@ai-harness/core': path.resolve(__dirname, '../core/src/index.ts'),
    },
  },
});
