import { expect, type Page } from './test-budget.js';
import { closeSettings, selectSettingsCategory } from './settings-navigation';

/** Use the actual workspace owner; cwd query parameters are bootstrap hints only. */
export async function switchSettingsWorkspace(page: Page, cwd: string): Promise<void> {
  if (await page.locator('.settings-dialog').isVisible()) await closeSettings(page);
  // Opening the picker starts a canonical browse which also writes the path input.
  const browsed = page.waitForResponse(response => response.request().method() === 'GET'
    && new URL(response.url()).pathname === '/api/workspaces/browse');
  await page.locator('.workspace-button').click();
  await (await browsed).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const picker = page.locator('.directory-picker');
  await picker.getByLabel('Workspace path', { exact: true }).fill(cwd);
  const validated = page.waitForRequest(request => request.method() === 'POST'
    && new URL(request.url()).pathname === '/api/workspaces/validate');
  await picker.getByRole('button', { name: 'Use this workspace', exact: true }).click();
  expect((await validated).postDataJSON()).toEqual({ cwd });
  await expect(page.locator('.workspace-button')).toHaveAttribute('title', cwd);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('.settings-view')).toBeVisible();
}

export async function switchMcpWorkspace(page: Page, cwd: string): Promise<void> {
  await switchSettingsWorkspace(page, cwd);
  await selectSettingsCategory(page, 'mcp');
  await expect(page.locator('#mcp')).toBeVisible();
}
