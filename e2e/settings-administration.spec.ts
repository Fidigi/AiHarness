import { expect, test } from './fixtures/test-budget';
import { installMockApi } from './fixtures/mock-api';
import { closeSettings } from './fixtures/settings-navigation';

for (const locale of ['en', 'fr'] as const) test(`defaults ${locale} recover an unreadable initial scope without reflecting server details`, async ({ page }) => {
  await page.addInitScript(locale => localStorage.setItem('ai-harness-locale', locale), locale);
  await installMockApi(page, { configurationScopes: { global: { model: 'saved-model' }, project: {} } });
  const fail = async (route: import('@playwright/test').Route) => route.fulfill({ status: 409, contentType: 'application/json',
    body: JSON.stringify({ error: 'private-server-detail' }) });
  await page.route('**/api/configuration/scope?**', fail);
  await page.goto('/settings#defaults');
  const defaults = page.locator('#defaults');
  await expect(defaults.getByRole('alert')).toContainText(locale === 'fr' ? 'La lecture sûre' : 'could not be read safely');
  await expect(defaults.getByRole('button', { name: locale === 'fr' ? 'Enregistrer' : 'Save', exact: true })).toBeDisabled();
  await expect(page.locator('body')).not.toContainText('private-server-detail');
  await page.unroute('**/api/configuration/scope?**', fail);
  await defaults.getByRole('button', { name: locale === 'fr' ? 'Recharger les paramètres sauvegardés' : 'Reload saved settings' }).click();
  await expect(defaults.getByRole('alert')).toHaveCount(0);
  await expect(defaults.getByLabel(locale === 'fr' ? 'Modèle' : 'Model', { exact: true })).toBeEnabled();
});

test('packages withdraw stale controls after failed canonical readback and recover by explicit refresh', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ai-harness-locale', 'en'));
  await installMockApi(page);
  await page.goto('/settings#plugins');
  const plugins = page.locator('#plugins');
  const checkbox = plugins.locator('fieldset[data-scope="global"]').getByRole('checkbox');
  await expect(checkbox).toBeChecked();
  const failure = async (route: import('@playwright/test').Route) => route.fulfill({ status: 500, contentType: 'application/json',
    body: JSON.stringify({ error: 'private-package-error' }) });
  await page.route('**/api/plugins', failure);
  await page.route('**/api/plugins?**', failure);
  await checkbox.uncheck();
  await expect(plugins.getByRole('alert')).toContainText('save result is uncertain');
  await expect(plugins.locator('.plugin-card')).toHaveCount(0);
  await expect(plugins).not.toContainText('private-package-error');
  await plugins.getByLabel('Package source').fill('npm:must-not-install');
  await expect(plugins.getByRole('button', { name: 'Install', exact: true })).toBeDisabled();
  await expect(plugins.getByRole('button', { name: 'Reload resources', exact: true })).toBeDisabled();
  await page.unroute('**/api/plugins?**', failure);
  await plugins.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(checkbox).toBeChecked();
  await expect(plugins.getByRole('alert')).toHaveCount(0);
});

test('a retired default save cannot reread or announce into a newer Settings lifetime', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ai-harness-locale', 'en'));
  const api = await installMockApi(page, { configurationScopes: { global: { model: 'original' }, project: { model: 'project' } } });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  await page.route('**/api/configuration/scope', async route => {
    entered(); await held;
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'retired-private-error' }) });
  });
  try {
    await page.goto('/settings#defaults');
    const defaults = page.locator('#defaults');
    await expect(defaults.getByLabel('Model', { exact: true })).toHaveValue('project');
    await defaults.getByLabel('Model', { exact: true }).fill('retired-draft');
    await defaults.getByRole('button', { name: 'Save', exact: true }).click(); await pending;
    await closeSettings(page);
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(defaults).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: false }).click();
    await expect(defaults.getByLabel('Model', { exact: true })).toHaveValue('project');
    await defaults.getByLabel('Model', { exact: true }).fill('newer-draft');
    const reads = api.requests.filter(request => request.path.startsWith('/api/configuration/')).length;
    const response = page.waitForResponse(response => response.url().endsWith('/api/configuration/scope') && response.request().method() === 'PATCH');
    release(); await response;
    // Browser-side fence: a fresh request/animation follows the settled handler.
    await page.evaluate(async () => { await fetch('/api/auth/status'); await new Promise(requestAnimationFrame); });
    await expect(defaults.getByLabel('Model', { exact: true })).toHaveValue('newer-draft');
    await expect(defaults.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await expect(page.locator('body')).not.toContainText('retired-private-error');
    await expect(defaults.getByRole('alert')).toHaveCount(0);
    expect(api.requests.filter(request => request.path.startsWith('/api/configuration/'))).toHaveLength(reads);
  } finally { release(); }
});

test('a retired package action cannot reread or announce into a newer Settings lifetime', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ai-harness-locale', 'en'));
  const api = await installMockApi(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  await page.route('**/api/plugins', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    entered(); await held;
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'retired-package-error' }) });
  });
  try {
    await page.goto('/settings#plugins');
    const plugins = page.locator('#plugins');
    const checkbox = plugins.locator('fieldset[data-scope="global"]').getByRole('checkbox');
    await expect(checkbox).toBeChecked(); await checkbox.uncheck(); await pending;
    await closeSettings(page);
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(plugins).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: false }).click();
    await expect(checkbox).toBeChecked();
    const reads = api.requests.filter(request => request.path === '/api/plugins').length;
    const response = page.waitForResponse(response => response.url().endsWith('/api/plugins') && response.request().method() === 'POST');
    release(); await response;
    await page.evaluate(async () => { await fetch('/api/auth/status'); await new Promise(requestAnimationFrame); });
    await expect(checkbox).toBeChecked();
    await expect(plugins.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('retired-package-error');
    expect(api.requests.filter(request => request.path === '/api/plugins')).toHaveLength(reads);
  } finally { release(); }
});
