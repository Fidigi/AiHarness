import { defineConfig } from '@playwright/test';
import base from './interaction-asset-load.config';

// Keep the actual production asset-fault lifetime for the complete queue matrix.
export default defineConfig({
  ...base,
  testMatch: ['interaction-single-asset-load.spec.ts', 'interaction-queue.spec.ts',
    'interaction-admission.spec.ts', 'interaction-asset-load.spec.ts'],
});
