import { defineConfig, devices } from '@playwright/test';
import { validateBase } from './scripts/base-path.mjs';

const base = validateBase(process.env.DEMO_BASE ?? '/AiHarness/');
process.env.DEMO_E2E = '1';
export default defineConfig({
  testDir: '../e2e',
  testMatch: 'demo*.spec.ts',
  snapshotPathTemplate: `${import.meta.dirname}/visual-baselines/{testFilePath}/{arg}{ext}`,
  outputDir: './test-results',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'demo/playwright-report', open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:4173${base}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium' },
  },
  webServer: {
    command: 'node demo/scripts/serve.mjs',
    cwd: new URL('../', import.meta.url).pathname,
    url: `http://127.0.0.1:4173${base}`,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
