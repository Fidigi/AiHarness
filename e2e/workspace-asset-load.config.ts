import { defineConfig } from '@playwright/test';
import base from '../playwright.config';

const servers = Array.isArray(base.webServer) ? base.webServer : [base.webServer!];
export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: 'workspace-asset-load.spec.ts',
  // Network fault tests must not be hidden by a PWA controller/cache reload.
  use: { ...base.use, serviceWorkers: 'block' },
  webServer: [servers[0], {
    command: 'npm exec --workspace @ai-harness/web -- vite preview --host 0.0.0.0 --port 3080',
    url: 'http://localhost:3080', reuseExisting: false, timeout: 120_000,
  }],
});
