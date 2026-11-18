import { expect, test } from './fixtures/test-budget.js';
import { installMockApi } from './fixtures/mock-api.js';
import { mcpStateInventory } from './fixtures/mcp.js';
import { switchMcpWorkspace } from './fixtures/mcp-navigation.js';

for (const action of ['test', 'exposure'] as const) {
  test(`MCP rejects an obsolete ${action} response after a mounted workspace replacement`, async ({ page }) => {
    const original = mcpStateInventory();
    await installMockApi(page, { mcpConfig: original });
    await page.route(/\/api\/mcp(?:\?|$)/, route => {
      const inventory = mcpStateInventory();
      const cwd = new URL(route.request().url()).searchParams.get('cwd') ?? '/workspace';
      inventory.project!.cwd = cwd;
      inventory.servers[0]!.envNames = [cwd === '/workspace/other' ? 'CURRENT_WORKSPACE' : 'ORIGINAL_WORKSPACE'];
      return route.fulfill({ json: inventory });
    });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const endpoint = action === 'test' ? '/api/mcp/test' : '/api/mcp/actions';
    const old = mcpStateInventory();
    old.servers[0]!.envNames = ['OBSOLETE_WORKSPACE'];
    old.servers[0]!.exposure = 'hidden';
    await page.route(`**${endpoint}`, async route => {
      await gate;
      await route.fulfill({ json: action === 'test' ? {
        scope: 'global', name: 'remote-docs', configKey: original.servers[0]!.configKey,
        result: { state: 'failed', testedAt: new Date().toISOString(), durationMs: 1,
          tools: [], toolCount: 0, resources: 0, resourceTemplates: 0, prompts: 0,
          error: 'OBSOLETE_TEST_REPORT' },
      } : { inventory: old } });
    });
    try {
      await page.goto('/settings?cwd=%2Fworkspace#mcp');
      const section = page.locator('#mcp');
      const started = page.waitForRequest(request => new URL(request.url()).pathname === endpoint && request.method() === 'POST');
      if (action === 'test') await section.getByRole('button', { name: 'Test remote-docs', exact: true }).click();
      else await section.getByRole('combobox', { name: 'Tool exposure for remote-docs', exact: true }).selectOption('hidden');
      await started;
      await switchMcpWorkspace(page, '/workspace/other');
      const detail = section.getByRole('region', { name: 'Server details: Global configuration / remote-docs', exact: true });
      await expect(detail).toContainText('CURRENT_WORKSPACE');
      const finished = page.waitForResponse(response => new URL(response.url()).pathname === endpoint);
      release();
      await (await finished).finished();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(detail).toContainText('CURRENT_WORKSPACE');
      await expect(section).not.toContainText('OBSOLETE_WORKSPACE');
      await expect(section).not.toContainText('OBSOLETE_TEST_REPORT');
      await expect(section.getByRole('combobox', { name: 'Tool exposure for remote-docs', exact: true })).toHaveValue('deferred');
      await expect(section.getByRole('button', { name: 'Test remote-docs', exact: true })).toBeEnabled();
    } finally { release(); }
  });
}

test('MCP coordinates selected sign-in, import exclusion and a cancelled terminal state against a delayed poll', async ({ page }) => {
  const inventory = mcpStateInventory();
  inventory.servers[0]!.usesOAuth = true;
  await installMockApi(page, { mcpConfig: inventory });
  const flowId = '00000000-0000-4000-8000-000000000456';
  const flow = (phase: 'authorize' | 'cancelled') => ({
    flowId, scope: 'global', name: 'remote-docs', configKey: inventory.servers[0]!.configKey,
    phase, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...(phase === 'authorize' ? { authorizationUrl: 'https://login.example.test/authorize?state=public-state' } : {}),
  });
  let releasePoll!: () => void;
  const gate = new Promise<void>(resolve => { releasePoll = resolve; });
  let releaseStart!: () => void;
  const startGate = new Promise<void>(resolve => { releaseStart = resolve; });
  await page.route('**/api/mcp/oauth/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith('/status')) {
      await route.fulfill({ json: { statuses: [{ scope: 'global', name: 'remote-docs',
        configKey: inventory.servers[0]!.configKey, available: true, signedIn: false, stateStored: false }] } });
    } else if (pathname.endsWith('/start')) {
      await startGate;
      await route.fulfill({ json: flow('authorize') });
    } else if (pathname.endsWith(`/flows/${flowId}`)) {
      if (request.method() === 'DELETE') await route.fulfill({ json: flow('cancelled') });
      else { await gate; await route.fulfill({ json: flow('authorize') }); }
    } else await route.fulfill({ status: 404, json: { error: 'Unexpected OAuth request.' } });
  });
  try {
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');
    await section.locator('.mcp-import-panel > summary').click();
    await section.locator('#mcp-import-text').fill('https://new.example.test');
    const preview = section.getByRole('button', { name: 'Preview', exact: true });
    await expect(preview).toBeEnabled();
    await section.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(preview).toBeDisabled();
    await expect(section.getByRole('button', { name: 'Test remote-docs', exact: true })).toBeDisabled();
    const polled = page.waitForRequest(request => request.method() === 'GET' && request.url().endsWith(`/flows/${flowId}`));
    releaseStart();
    const link = section.getByRole('link', { name: 'Open the authorization page', exact: true });
    await expect(link).toBeVisible();
    await polled;
    await section.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
    await expect(section).toContainText('OAuth sign-in was cancelled.');
    await expect(link).toHaveCount(0);
    const finished = page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith(`/flows/${flowId}`));
    releasePoll();
    await (await finished).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(section).toContainText('OAuth sign-in was cancelled.');
    await expect(link).toHaveCount(0);
    await expect(section.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
    await expect(preview).toBeEnabled();
  } finally { releaseStart(); releasePoll(); }
});
