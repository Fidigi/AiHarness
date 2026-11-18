import { access } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { workspaceDefaultServer } from './workspace-default-server.mjs';
import { expect, test } from './fixtures/test-budget';
import { installMockApi } from './fixtures/mock-api';

test('production public server keeps invalid defaults recoverable without implicit workspace trust or executable generation', async ({ page }) => {
  const f = await workspaceDefaultServer();
  const turns: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/agent/runs')) turns.push(request.url());
  });
  try {
    await page.goto(f.url);
    await expect(page.locator('.workspace-selector').getByRole('alert')).toContainText('default workspace is unavailable');
    await expect(access(f.marker)).rejects.toThrow();
    await page.locator('.workspace-button').click();
    const picker = page.locator('.directory-picker');
    await picker.getByLabel('Workspace path').fill(f.cwd);
    await picker.getByRole('button', { name: 'Use this workspace', exact: true }).click();
    await page.getByRole('button', { name: 'Use without trusting', exact: true }).click();
    await expect(page).toHaveURL(`${f.url}/?cwd=${encodeURIComponent(f.cwd)}`);
    await expect(page.locator('.workspace-selector').getByRole('alert')).toHaveCount(0);
    await expect(page.locator('.workspace-button small')).toContainText('~/aih-workspace-default-');
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).current, key)).toBe(f.cwd);
    await expect(access(f.marker)).rejects.toThrow();
    await page.reload();
    await expect(page.locator('.workspace-button small')).toContainText('~/aih-workspace-default-');
    const validated = await page.request.post(`${f.url}/api/workspaces/validate`, { data: { cwd: f.cwd } });
    expect(validated.status()).toBe(200);
    expect((await validated.json()).operationTrusted).toBe(false);
    const reloaded = await page.request.post(`${f.url}/api/agent/reload`, { data: { cwd: f.cwd } });
    expect(reloaded.status()).toBe(200); expect((await reloaded.json()).errors).toEqual([]);
    await access(f.marker); await expect(access(f.projectMarker)).rejects.toThrow();
    expect(turns).toEqual([]);
  } finally { await f.close(); }
});

const key = 'ai-harness-workspaces-v1';
const descriptor = (cwd: string) => ({ id: cwd === '/workspace' ? 'workspace-e2e' : 'workspace-project', cwd,
  name: cwd.split('/').at(-1), displayPath: cwd === '/workspace' ? '~' : '~/project', trusted: true, operationTrusted: true });

for (const scenario of [
  { name: 'desktop-light', width: 1440, theme: 'light', locale: 'en' },
  { name: 'desktop-dark', width: 1440, theme: 'dark', locale: 'fr' },
  { name: 'mobile-light', width: 390, theme: 'light', locale: 'en' },
  { name: 'mobile-dark', width: 390, theme: 'dark', locale: 'fr' },
] as const) {
  test(`${scenario.name}: unavailable default is explicit, accessible and recoverable without granting authority`, async ({ page }) => {
    await page.setViewportSize({ width: scenario.width, height: 900 });
    await page.addInitScript(({ theme, locale }) => {
      localStorage.setItem('ai-harness-locale', locale);
      localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme, sidebarVisible: true, sound: false }));
    }, scenario);
    const api = await installMockApi(page);
    let defaults = 0;
    await page.route('**/api/workspaces/default', route => { defaults++; return route.fulfill({ status: 404, json: { code: 'not-found', error: 'The workspace path was not found.' } }); });
    await page.route('**/api/workspaces/validate', route => route.fulfill({ json: descriptor(route.request().postDataJSON().cwd) }));
    await page.goto('/');
    if (scenario.width < 960) await page.locator('.mobile-menu').click();
    const sidebar = page.locator('.sidebar');
    const alert = sidebar.getByRole('alert');
    await expect(alert).toContainText(scenario.locale === 'fr' ? 'par défaut est indisponible' : 'default workspace is unavailable');
    await expect(sidebar.locator('.workspace-button')).toContainText(scenario.locale === 'fr' ? 'Choisir un espace de travail' : 'Choose a workspace');
    expect(defaults).toBe(1);
    expect(await page.evaluate(key => localStorage.getItem(key), key)).toBeNull();
    expect(api.requests.some(request => request.path === '/api/agent/runs' && request.method === 'POST')).toBe(false);
    expect((await new AxeBuilder({ page }).include('.workspace-selector').analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
    await expect(sidebar.locator('.workspace-selector')).toHaveScreenshot(`workspace-unavailable-${scenario.name}.png`, { animations: 'disabled', caret: 'hide' });
    await sidebar.locator('.workspace-button').click();
    const picker = page.locator('.directory-picker');
    const input = picker.locator('input').first();
    await expect(input).toBeFocused();
    await input.fill('/workspace/project');
    await picker.getByRole('button', { name: scenario.locale === 'fr' ? 'Utiliser cet espace' : 'Use this workspace', exact: true }).click();
    await expect(page).toHaveURL(/cwd=%2Fworkspace%2Fproject/);
    if (scenario.width < 960 && await page.locator('.mobile-menu').getAttribute('aria-expanded') === 'false') await page.locator('.mobile-menu').click();
    await expect(sidebar.getByRole('alert')).toHaveCount(0);
    await expect(sidebar.locator('.workspace-button small')).toHaveText('~/project');
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).current, key)).toBe('/workspace/project');
  });
}

test('canonical default is persisted and revalidated after reload; relative/home display never becomes execution cwd', async ({ page }) => {
  const api = await installMockApi(page);
  let defaults = 0;
  const validated: string[] = [];
  await page.route('**/api/workspaces/default', route => { defaults++; return route.fulfill({ json: descriptor('/workspace') }); });
  await page.route('**/api/workspaces/validate', route => {
    const input = route.request().postDataJSON().cwd as string;
    validated.push(input);
    return route.fulfill({ json: descriptor(input === './project' || input === '~/project' ? '/workspace/project' : input) });
  });
  await page.goto('/');
  await expect(page.locator('.workspace-button small')).toHaveText('~');
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).current, key)).toBe('/workspace');
  await page.reload();
  await expect(page.locator('.workspace-button small')).toHaveText('~');
  expect(validated).toContain('/workspace'); expect(defaults).toBe(1);
  await page.goto('/?cwd=./project');
  await expect(page.locator('.workspace-button small')).toHaveText('~/project');
  expect(validated).toContain('./project');
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).current, key)).toBe('/workspace/project');
  await page.reload();
  await expect(page.locator('.workspace-button small')).toHaveText('~/project');
  expect(api.requests.filter(request => request.path === '/api/agent/runs' && request.method === 'POST')).toHaveLength(0);
});
