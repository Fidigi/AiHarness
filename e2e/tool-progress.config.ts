import { defineConfig } from '@playwright/test';
import base from '../playwright.config';
import os from 'node:os';
import path from 'node:path';

const dataDirectory = process.env.AI_HARNESS_E2E_PROGRESS_DATA_DIR ??= path.join(os.tmpdir(), `aiharness-playwright-progress-${process.pid}`);

// Disposable encryption only for the real local upstream's non-secret test key.
// Product sources/APIs remain untouched; never use operator credentials.
export default defineConfig({
  ...base,
  fullyParallel: false,
  testDir: '.',
  testMatch: 'tool-progress.spec.ts',
  testIgnore: [],
  // Genuine lazy-import network faults must not be served from the PWA cache
  // or interrupted by the first service-worker controller reload.
  use: { ...base.use, serviceWorkers: 'block' },
  webServer: (Array.isArray(base.webServer) ? base.webServer : [base.webServer!]).map((server, index) => ({
    ...server,
    ...(index === 1 ? {
      command: 'npm run preview --workspace @ai-harness/web -- --port 3080 --host 0.0.0.0',
    } : {}),
    env: { ...server.env, AI_HARNESS_DATA_DIR: dataDirectory, AI_HARNESS_MASTER_KEY: '11'.repeat(32) },
  })),
});
