import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from './fixtures/test-budget.js';
import { installMockApi } from './fixtures/mock-api.js';
import { mcpStateInventory } from './fixtures/mcp.js';
import { switchMcpWorkspace } from './fixtures/mcp-navigation.js';

const key = 'ai-harness-mcp-selection-v1';
const scopeLabels = { global: 'Global configuration', project: 'Project configuration' };
const button = (page: Page, scope: keyof typeof scopeLabels, name: string) => page.locator('#mcp')
  .getByRole('button', { name: `Show details for ${scopeLabels[scope]} / ${name}`, exact: true });
const detail = (page: Page, scope: keyof typeof scopeLabels, name: string) => page.locator('#mcp')
  .getByRole('region', { name: `Server details: ${scopeLabels[scope]} / ${name}`, exact: true });

test('MCP keeps one selected server detail across reload and restores the Settings section', async ({ page }) => {
  const api = await installMockApi(page, { mcpConfig: mcpStateInventory() });
  await page.goto('/settings#mcp');
  const section = page.locator('#mcp');
  await expect(button(page, 'global', 'local-tools')).toBeVisible();
  await button(page, 'global', 'local-tools').click();
  const selected = detail(page, 'global', 'local-tools');
  await expect(selected).toBeVisible();
  await expect(selected).toContainText('env.CACHE_DIR reads host variables: CACHE_DIR');
  await expect(detail(page, 'global', 'remote-docs')).toHaveCount(0);
  await page.reload();
  await expect(selected).toBeVisible();
  await expect(button(page, 'global', 'local-tools')).toHaveAttribute('aria-expanded', 'true');
  await page.goto('/settings');
  await expect(selected).toBeVisible();
  await expect(section.getByRole('heading', { name: 'MCP servers', exact: true })).toBeInViewport();
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key)).toEqual({ version: 1, entries: [
    { cwd: '/workspace', scope: 'global', name: 'local-tools' },
  ] });
  expect(api.requests.filter(request => request.path === '/api/mcp/test' || request.path.startsWith('/api/mcp/oauth/flows'))).toEqual([]);
});

test('MCP distinguishes same-name scopes and invalidates a removed selected detail without falling into the other scope', async ({ page }) => {
  await installMockApi(page, { mcpConfig: mcpStateInventory() });
  await page.goto('/settings#mcp');
  const section = page.locator('#mcp');
  await button(page, 'project', 'shared').click();
  await expect(detail(page, 'project', 'shared')).toBeVisible();
  const next = mcpStateInventory();
  next.servers = next.servers.filter(server => server.scope !== 'project');
  await page.route(/\/api\/mcp(?:\?|$)/, route => route.fulfill({ json: next }));
  await section.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(section.getByRole('status').filter({ hasText: 'The selected server is no longer available. Select another server.' })).toBeVisible();
  await expect(section.getByRole('region', { name: /^Server details:/ })).toHaveCount(0);
  await expect(button(page, 'global', 'shared')).toHaveAttribute('aria-expanded', 'false');
});

test('MCP opens explicit fresh rows with colliding escaped labels but never restores an ambiguous descriptor', async ({ page }) => {
  const inventory = mcpStateInventory();
  const invalid = inventory.servers.find(server => !server.valid)!;
  const valid = inventory.servers.find(server => server.name === 'remote-docs')!;
  inventory.servers = [
    { ...invalid, configKey: '3'.repeat(64) },
    { ...valid, name: invalid.name, configKey: '4'.repeat(64) },
  ];
  await installMockApi(page, { mcpConfig: inventory });
  await page.goto('/settings#mcp');
  const choices = button(page, 'global', invalid.name);
  await expect(choices).toHaveCount(2);
  await choices.nth(1).click();
  await expect(detail(page, 'global', invalid.name)).toContainText('https://docs.example.test/');
  expect(await page.evaluate(key => localStorage.getItem(key), key)).not.toContain('configKey');
  await page.reload();
  await expect(page.locator('#mcp')).toContainText('The selected server is no longer available. Select another server.');
  await expect(page.locator('#mcp').getByRole('region', { name: /^Server details:/ })).toHaveCount(0);
  await choices.nth(0).click();
  await expect(detail(page, 'global', invalid.name)).toContainText('The server name is empty, too long, or contains hidden characters.');
  await choices.nth(1).click();
  await expect(detail(page, 'global', invalid.name)).toContainText('https://docs.example.test/');
});

test('MCP works and restores a global selection without a project or implicit execution', async ({ page }) => {
  const inventory = mcpStateInventory();
  delete inventory.project;
  inventory.files = inventory.files.filter(file => file.scope === 'global');
  inventory.servers = inventory.servers.filter(server => server.scope === 'global');
  const api = await installMockApi(page, { mcpConfig: inventory });
  await page.route('**/api/workspaces/default', route => route.fulfill({ status: 404, json: { error: 'No default workspace.' } }));
  const reads: string[] = [];
  await page.route(/\/api\/mcp(?:\?|$)/, route => {
    reads.push(route.request().url());
    return route.fulfill({ json: inventory });
  });
  await page.goto('/settings#mcp');
  const section = page.locator('#mcp');
  await button(page, 'global', 'local-tools').click();
  await expect(section.locator('fieldset[data-scope="project"]')).toHaveCount(0);
  await page.reload();
  await expect(detail(page, 'global', 'local-tools')).toBeVisible();
  expect(reads.length).toBeGreaterThanOrEqual(2);
  expect(reads.every(url => !new URL(url).searchParams.has('cwd'))).toBe(true);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key)).toEqual({ version: 1, entries: [
    { cwd: null, scope: 'global', name: 'local-tools' },
  ] });
  expect(api.requests.filter(request => request.method === 'POST' && (request.path.startsWith('/api/mcp/') || request.path === '/api/agent/runs'))).toEqual([]);
});

test('MCP restores independent project selections through workspace navigation and a trust-locked inventory', async ({ page }) => {
  await installMockApi(page, { mcpConfig: mcpStateInventory() });
  await page.route(/\/api\/mcp(?:\?|$)/, route => {
    const inventory = mcpStateInventory();
    const cwd = new URL(route.request().url()).searchParams.get('cwd');
    if (cwd) {
      inventory.project!.cwd = cwd;
      for (const file of inventory.files) if (file.scope === 'project') file.path = `${cwd}/.ai-harness/mcp.json`;
      for (const server of inventory.servers) if (server.scope === 'project') server.sourcePath = `${cwd}/.ai-harness/mcp.json`;
    } else {
      delete inventory.project;
      inventory.files = inventory.files.filter(file => file.scope === 'global');
      inventory.servers = inventory.servers.filter(server => server.scope === 'global');
    }
    return route.fulfill({ json: inventory });
  });
  await page.goto('/settings?cwd=%2Fworkspace#mcp');
  const section = page.locator('#mcp');
  await button(page, 'project', 'shared').click();
  await switchMcpWorkspace(page, '/workspace/other');
  await button(page, 'global', 'local-tools').click();
  await switchMcpWorkspace(page, '/workspace');
  await expect(detail(page, 'project', 'shared')).toBeVisible();
  await switchMcpWorkspace(page, '/workspace/other');
  await expect(detail(page, 'global', 'local-tools')).toBeVisible();
  await button(page, 'project', 'shared').click();
  const locked = mcpStateInventory();
  locked.project = { cwd: '/workspace/other', contentTrusted: false, requiresTrust: true,
    decision: false, inherited: false, trustError: false };
  locked.servers = locked.servers.filter(server => server.scope !== 'project');
  const file = locked.files.find(file => file.scope === 'project')!;
  file.contentRead = false;
  file.problems = [{ reason: 'trust-required', message: 'Project trust required.' }];
  await page.route(/\/api\/mcp(?:\?|$)/, route => route.fulfill({ json: locked }));
  await section.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(section).toContainText('Project server names and values are not read before trust.');
  await expect(section.getByRole('region', { name: /^Server details:/ })).toHaveCount(0);
  await expect(button(page, 'project', 'shared')).toHaveCount(0);
});

test('MCP Test selects its report and excludes add and selection intent while the request is pending', async ({ page }) => {
  await installMockApi(page, { mcpConfig: mcpStateInventory() });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/mcp/test', async route => { await gate; await route.fallback(); });
  try {
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');
    await section.locator('.mcp-import-panel > summary').click();
    await section.locator('#mcp-import-text').fill('https://new.example.test');
    const preview = section.getByRole('button', { name: 'Preview', exact: true });
    await expect(preview).toBeEnabled();
    await section.getByRole('button', { name: 'Test local-tools', exact: true }).click();
    await expect(detail(page, 'global', 'local-tools')).toBeVisible();
    await expect(preview).toBeDisabled();
    await expect(button(page, 'project', 'shared')).toBeDisabled();
    await expect(section.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
    release();
    await expect(section.getByRole('region', { name: 'Last connection test for local-tools', exact: true })).toBeVisible();
    await expect(preview).toBeEnabled();
  } finally { release(); }
});

for (const scenario of [
  { width: 1440, theme: 'light', locale: 'en', button: 'Show details for Project configuration / shared', region: 'Server details: Project configuration / shared' },
  { width: 390, theme: 'dark', locale: 'fr', button: 'Afficher les détails de Configuration du projet / shared', region: 'Détails du serveur : Configuration du projet / shared' },
] as const) {
  test(`MCP selected detail is keyboard-accessible and bounded at ${scenario.width}px/${scenario.locale}`, async ({ page }) => {
    await page.setViewportSize({ width: scenario.width, height: 900 });
    await page.addInitScript(({ theme, locale }) => {
      localStorage.setItem('ai-harness-locale', locale);
      localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme, lastSettingsSection: 'mcp' }));
    }, scenario);
    await installMockApi(page, { mcpConfig: mcpStateInventory() });
    await page.goto('/settings#mcp');
    const selectedButton = page.getByRole('button', { name: scenario.button, exact: true });
    await selectedButton.focus();
    await selectedButton.press('Enter');
    await expect(selectedButton).toBeFocused();
    await expect(selectedButton).toHaveAttribute('aria-expanded', 'true');
    const selectedDetail = page.getByRole('region', { name: scenario.region, exact: true });
    await expect(selectedDetail).toBeVisible();
    await expect(selectedDetail).toHaveCSS('display', 'grid');
    await expect(selectedDetail).toHaveAttribute('id', (await selectedButton.getAttribute('aria-controls'))!);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
    expect((await new AxeBuilder({ page }).include('#mcp').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
  });
}
