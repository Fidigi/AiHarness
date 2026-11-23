import { defineConfig } from '@playwright/test';
import base from '../playwright.config';
import os from 'node:os';
import path from 'node:path';
export default defineConfig({
  ...base, testDir: '.', testMatch: ['linked-modal-boundary.spec.ts', 'linked-directories.spec.ts'], testIgnore: [],
  use: { ...base.use, serviceWorkers: 'block' },
  webServer: {
    command: 'node packages/server/dist/web-cli.js --port 3080 --no-open', cwd: process.cwd(),
    url: 'http://localhost:3080/health', reuseExisting: false, timeout: 120_000,
    env: { AI_HARNESS_DATA_DIR: path.join(os.tmpdir(), 'aih-linked-modal-boundary-' + process.pid),
      AI_HARNESS_DEFAULT_CWD: process.cwd(), AI_HARNESS_ALLOWED_ROOTS: process.cwd(),
      AI_HARNESS_ALLOWED_ORIGINS: 'http://localhost:3080' },
  },
});
