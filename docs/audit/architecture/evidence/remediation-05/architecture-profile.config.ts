// Comparative browser-only probe: retain the real Vite host and use the frozen,
// already-emitted Server/Core. Standard build/type/E2E gates are not replaced.
import base from './playwright.config';
const servers = base.webServer as Array<{ command: string }>;
export default {
  ...base,
  testMatch: 'performance.spec.ts',
  workers: 1,
  retries: 0,
  reporter: 'line',
  outputDir: 'test-results/profile-comparison',
  webServer: [{ ...servers[0], command: 'node packages/server/dist/index.js --port 3099' }, servers[1]],
};
