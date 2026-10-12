import { defineConfig } from '@playwright/test';
import base from '../playwright.config';

// Run after the genuine production Vite build in the same container. The normal
// build/budget command is checked separately; this does not change its limits.
const servers = Array.isArray(base.webServer) ? base.webServer : [base.webServer!];
export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: 'interaction-single-asset-load.spec.ts',
  testIgnore: [],
  // Isolate chunk network failures from the PWA's first-install controller reload.
  use: { ...base.use, serviceWorkers: 'block' },
  webServer: [servers[0], {
    command: 'npm exec --workspace @ai-harness/web -- vite preview --host 0.0.0.0 --port 3080',
    url: 'http://localhost:3080', reuseExisting: false, timeout: 120_000,
  }],
});
