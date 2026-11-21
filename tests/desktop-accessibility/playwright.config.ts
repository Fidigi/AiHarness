import { defineConfig } from '@playwright/test';
import path from 'node:path';

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: 'settings.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  updateSnapshots: 'none',
  outputDir: '/tmp/desktop-accessibility/results',
  reporter: [['list'], ['json', { outputFile: '/tmp/desktop-accessibility/report.json' }],
    ['html', { outputFolder: '/tmp/desktop-accessibility/report', open: 'never' }]],
  webServer: {
    command: 'node --no-maglev node_modules/vite/bin/vite.js preview --configLoader native --config .docker/accessibility/preview.config.mjs --host 127.0.0.1 --port 3080 --strictPort',
    cwd: path.resolve(import.meta.dirname, '../..'),
    url: 'http://127.0.0.1:3080',
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
