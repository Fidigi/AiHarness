import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { installMockApi, mockSession } from './fixtures/mock-api';
import { mcpStateInventory } from './fixtures/mcp';

for (const scenario of [
  { name: 'desktop-dark', width: 1440, theme: 'dark' },
  { name: 'desktop-light', width: 1440, theme: 'light' },
  { name: 'mobile-dark', width: 390, theme: 'dark' },
  { name: 'mobile-light', width: 390, theme: 'light' },
] as const) {
  test(`${scenario.name} MCP hidden and per-tool exposure are canonical and keyboard accessible`, async ({ page }) => {
    await page.setViewportSize({ width: scenario.width, height: 900 });
    await page.addInitScript(theme => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme, lastSettingsSection: 'mcp' })), scenario.theme);
    const api = await installMockApi(page, { mcpConfig: mcpStateInventory() });
    await page.goto('/settings#mcp');
    const card = page.locator('#mcp').getByRole('article', { name: 'remote-docs: Configured', exact: true });
    await card.getByRole('button', { name: 'Test remote-docs', exact: true }).click();
    await card.getByText('Per-tool exposure overrides', { exact: true }).click();
    const perTool = card.getByRole('combobox', { name: 'Tool exposure for remote-docs / search_docs', exact: true });
    await perTool.selectOption('hidden');
    await expect(perTool).toHaveValue('hidden');
    await expect(perTool).toBeFocused();
    await expect(card.locator('.mcp-test-summary')).toHaveCount(0);
    await expect(card.getByRole('combobox', { name: 'Tool exposure for remote-docs', exact: true })).toHaveValue('deferred');
    expect(api.requests.filter(request => request.path === '/api/mcp/actions').at(-1)?.body).toMatchObject({
      action: 'set-exposure', scope: 'global', name: 'remote-docs', tool: 'search_docs', exposure: 'hidden',
    });
    await card.getByRole('combobox', { name: 'Tool exposure for remote-docs', exact: true }).selectOption('hidden');
    await expect(card.getByRole('combobox', { name: 'Tool exposure for remote-docs', exact: true })).toHaveValue('hidden');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
    const accessibility = await new AxeBuilder({ page }).include('.mcp-per-tool-exposure')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(accessibility.violations).toEqual([]);
    await expect(card).toHaveScreenshot(`mcp-hidden-tools-${scenario.name}.png`, { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02 });
    await page.reload();
    await page.locator('#mcp').getByText('Per-tool exposure overrides', { exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Tool exposure for remote-docs / search_docs', exact: true })).toHaveValue('hidden');
  });
}

test('bare /mcp navigates locally rather than sending a provider prompt', async ({ page }) => {
  const api = await installMockApi(page, { sessions: [mockSession('mcp-navigation', 'MCP navigation')] });
  await page.goto('/chat/mcp-navigation?cwd=%2Fworkspace');
  const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
  await composer.fill('/mcp'); await composer.press('Enter');
  await expect(page).toHaveURL(/\/settings#mcp$/);
  await expect(page.locator('#mcp')).toBeFocused();
  expect(api.requests.some(request => request.path === '/api/agent/runs' && request.method === 'POST')).toBe(false);
});

for (const owned of [false, true]) {
  test(`streaming /mcp respects ${owned ? 'extension ownership' : 'builtin navigation'}`, async ({ page }) => {
    const inventory = mcpStateInventory();
    inventory.command = owned ? { owner: 'extension', extensionId: 'fixture:owner', conflict: true }
      : { owner: 'builtin', conflict: false };
    const api = await installMockApi(page, { sessions: [mockSession('mcp-stream', 'Streaming')], holdAgentRun: true,
      mcpConfig: inventory, paletteItems: [{ name: 'mcp', description: 'Owned MCP', source: owned ? 'extension' : 'builtin' }] });
    await page.goto('/chat/mcp-stream');
    const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
    await composer.fill('Start'); await composer.press('Enter');
    await expect(page.getByRole('button', { name: 'Stop model' })).toBeVisible();
    api.setRunPhase('mcp-stream', 'streaming');
    await composer.fill('/mcp'); await page.getByRole('button', { name: 'Queue', exact: true }).click();
    if (owned) {
      await expect.poll(() => api.requests.some(request => request.path.endsWith('/commands/mcp') && request.method === 'POST')).toBe(true);
      await expect(page).toHaveURL(/\/chat\/mcp-stream/);
      await page.goto('/settings#mcp');
      await expect(page.locator('#mcp')).toContainText('fixture:owner owns /mcp');
    } else {
      await expect(page).toHaveURL(/\/settings#mcp$/);
      await expect(page.locator('#mcp')).toBeFocused();
    }
    expect(api.requests.filter(request => request.path === '/api/agent/runs' && request.method === 'POST')).toHaveLength(1);
    expect(api.requests.some(request => request.path.endsWith('/stop') || request.path.endsWith('/queue'))).toBe(false);
  });
}
