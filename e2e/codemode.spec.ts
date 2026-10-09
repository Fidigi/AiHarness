import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { ToolSettings } from '@ai-harness/core';
import { installMockApi } from './fixtures/mock-api';

function sandboxSettings(): ToolSettings {
  return { scope: 'project', source: 'workspace-e2e', preset: 'default', powershellAvailable: false, powershellEnabled: false,
    codemode: { enabled: false, mode: 'on', inlineBudget: 3000, selfTest: { state: 'passed', engine: 'QuickJS' } },
    tools: [
      { name: 'read', description: 'Read a workspace file', extensionId: 'builtin:workspace-tools', enabled: true, available: true },
      { name: 'write', description: 'Write a workspace file', extensionId: 'builtin:workspace-tools', enabled: true, available: true },
      { name: 'codemode', description: 'Bounded QuickJS scripts with authorized nested tools', extensionId: 'builtin:codemode', enabled: true, available: true, disabledReason: 'automatic' },
      { name: 'tool_search', description: 'Discover eligible metadata; never grants permission', extensionId: 'builtin:tool-search', enabled: true, available: true, disabledReason: 'automatic' },
      { name: 'powershell', description: 'Run PowerShell', extensionId: 'builtin:workspace-tools', enabled: false, available: false, unavailableReason: 'Windows only' },
    ] };
}

async function accessible(page: Page, selector: string, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  const result = await new AxeBuilder({ page }).include(selector)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(result.violations).toEqual([]);
}

for (const scenario of [
  { name: 'desktop-dark', width: 1440, theme: 'dark' },
  { name: 'desktop-light', width: 1440, theme: 'light' },
  { name: 'mobile-dark', width: 390, theme: 'dark' },
  { name: 'mobile-light', width: 390, theme: 'light' },
] as const) {
  test(`${scenario.name} Code mode saves scoped settings, displays limits and disabled reasons`, async ({ page }) => {
    // A tall viewport keeps the entire settings section inside its scrollport.
    await page.setViewportSize({ width: scenario.width, height: 1400 });
    await page.addInitScript(theme => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({
      version: 4, theme, lastSettingsSection: 'tools',
    })), scenario.theme);
    const api = await installMockApi(page, { toolSettings: sandboxSettings() });
    await page.goto('/settings#tools');
    const tools = page.locator('#tools');
    await expect(tools.getByRole('status')).toContainText('Sandbox self-test passed');
    await tools.getByLabel('Scope').selectOption('project');
    await tools.getByLabel('Code mode activation').selectOption('on');
    await expect(tools.getByLabel('Code mode activation')).toHaveValue('on');
    await tools.getByLabel('Tool presentation').selectOption('only');
    await expect(tools.getByLabel('Tool presentation')).toHaveValue('only');
    const budget = tools.getByLabel('Inline declaration budget (estimated tokens)');
    await budget.fill('500'); await budget.press('Tab');
    await expect.poll(() => api.requests.filter(request => request.path === '/api/tools' && request.method === 'PATCH').at(-1)?.body)
      .toMatchObject({ projectId: 'workspace-e2e', cwd: '/workspace', codemodeEnabled: true, codemodeMode: 'only', codemodeInlineBudget: 500 });
    await tools.getByLabel('Default tool preset').selectOption('read-only');
    await expect(tools.locator('.tool-settings-list label').filter({ hasText: 'write' })).toContainText('Disabled by the read-only preset.');
    await expect(tools).toContainText('Discovery is not authorization');
    await expect(tools).toContainText('32 MiB');
    await accessible(page, '#tools', scenario.width);
    await tools.scrollIntoViewIfNeeded();
    const bottomRow = await tools.locator('.tool-settings-list label').last().boundingBox();
    expect(bottomRow).not.toBeNull();
    expect(bottomRow!.y + bottomRow!.height).toBeLessThanOrEqual(1400);
    await expect(tools).toHaveScreenshot(`codemode-settings-${scenario.name}.png`, { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02 });
    await tools.getByLabel('Scope').selectOption('global');
    await expect(tools.getByLabel('Code mode activation')).toHaveValue('automatic');
    await expect(tools.getByLabel('Tool presentation')).toHaveValue('on');
    await tools.getByLabel('Scope').selectOption('project');
    await expect(tools.getByLabel('Tool presentation')).toHaveValue('only');
    await expect(budget).toHaveValue('500');
    const gets = api.requests.filter(request => request.path === '/api/tools' && request.method === 'GET').length;
    await page.reload();
    await expect(page.locator('#tools').getByRole('status')).toContainText('Sandbox self-test passed');
    expect(api.requests.filter(request => request.path === '/api/tools' && request.method === 'GET').length).toBeGreaterThan(gets);
    expect(api.requests.some(request => request.path.includes('execute') || request.path === '/api/agent/runs')).toBe(false);
  });

}

test('failed sandbox health is visible and cannot activate execution from Settings', async ({ page }) => {
  const settings = sandboxSettings();
  settings.codemode!.selfTest.state = 'failed';
  settings.tools.find(tool => tool.name === 'codemode')!.available = false;
  settings.tools.find(tool => tool.name === 'codemode')!.disabledReason = 'sandbox-unavailable';
  const api = await installMockApi(page, { toolSettings: settings });
  await page.goto('/settings#tools');
  await expect(page.locator('#tools').getByRole('status')).toContainText('execution disabled');
  await expect(page.getByLabel('Code mode activation')).toBeDisabled();
  await expect(page.locator('.tool-settings-list label').filter({ hasText: 'codemode' }).locator('input')).toBeDisabled();
  expect(api.requests.some(request => request.method === 'PATCH')).toBe(false);
});
