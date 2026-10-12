import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import base from '../playwright.config';
export default defineConfig({ ...base, testDir: '.', testMatch: 'session-title-production.browser.ts', retries: 0, workers: 1,
  use: { ...base.use, baseURL: 'http://127.0.0.1:3099', serviceWorkers: 'block' },
  webServer: { cwd: fileURLToPath(new URL('..', import.meta.url)), command: 'node e2e/session-title-production-server.mjs', url: 'http://127.0.0.1:3099/health', reuseExistingServer: false, timeout: 120000 },
});
