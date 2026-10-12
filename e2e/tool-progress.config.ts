import { defineConfig } from '@playwright/test';
import base from '../playwright.config';

// Disposable encryption only for the real local upstream's non-secret test key.
// Product sources/APIs remain untouched; never use operator credentials.
export default defineConfig({
  ...base,
  fullyParallel: false,
  testDir: '.',
  testMatch: 'tool-progress.spec.ts',
  webServer: (Array.isArray(base.webServer) ? base.webServer : [base.webServer!]).map(server => ({
    ...server,
    env: { ...server.env, AI_HARNESS_MASTER_KEY: '11'.repeat(32) },
  })),
});
