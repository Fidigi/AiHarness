import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { installMockApi, mockSession } from './fixtures/mock-api';

for (const viewport of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'mobile', width: 390, height: 844 }]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${viewport.name}-${theme} saves independent composer defaults and warns about project precedence`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(theme => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme, locale: 'en' })), theme);
      const source = { ...mockSession('defaults-source', 'Running source'), thinking: 'high', model: 'mock-model' };
      const api = await installMockApi(page, { sessions: [source], holdAgentRun: true,
        configurationScopes: { global: { provider: 'mock', model: 'old-default', thinking: 'low', toolPreset: 'read-only' },
          project: { model: 'project-model', thinking: 'minimal' } } });
      await page.goto('/chat/defaults-source');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.getByRole('textbox', { name: 'Message composer' }).fill('Keep this run active');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Stop model', exact: true })).toBeVisible();
      const mutationsBefore = api.requests.filter(request => request.method === 'PATCH' && request.path.startsWith('/api/sessions/')).length;
      await page.getByLabel('New-session reasoning defaults').click();
      await page.getByRole('button', { name: 'Save current reasoning as global default' }).click();
      await expect.poll(() => api.requests.filter(request => request.path === '/api/configuration/defaults').at(-1)?.body)
        .toEqual({ kind: 'thinking', thinking: 'high', projectId: 'workspace-e2e' });
      const global = () => page.evaluate(async () => fetch('/api/configuration/scope?scope=global').then(response => response.json()));
      await expect.poll(global).toMatchObject({ values: { model: 'old-default', thinking: 'high', toolPreset: 'read-only' } });
      await page.getByLabel('New-session model defaults').click();
      await page.getByRole('button', { name: 'Save current model as global default' }).click();
      await expect.poll(global).toMatchObject({ values: { provider: 'mock', model: 'mock-model', thinking: 'high', toolPreset: 'read-only' } });
      await expect(page.locator('.input-container')).toContainText('project or environment settings still override');
      expect(api.requests.filter(request => request.method === 'PATCH' && request.path.startsWith('/api/sessions/'))).toHaveLength(mutationsBefore);
      expect(api.requests.filter(request => request.method === 'POST' && (request.path.endsWith('/stop') || request.path.endsWith('/messages')))).toHaveLength(0);
      expect(api.requests.filter(request => request.path === '/api/agent/runs' && request.method === 'POST')).toHaveLength(1);
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator('.input-container')).toHaveScreenshot(`composer-defaults-${viewport.name}-${theme}.png`);
      expect((await new AxeBuilder({ page }).include('.input-container').analyze()).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

      await page.goto('/settings');
      const defaults = page.getByRole('heading', { name: 'Provider and model defaults' }).locator('..');
      await defaults.getByRole('combobox', { name: 'Scope', exact: true }).selectOption('global');
      await expect(defaults.getByLabel('Model', { exact: true })).toHaveValue('mock-model');
      await defaults.getByRole('combobox', { name: 'Thinking level', exact: true }).selectOption('xhigh');
      expect((await new AxeBuilder({ page }).include('#defaults').analyze()).violations).toEqual([]);
      await defaults.getByRole('button', { name: 'Save', exact: true }).click();
      await expect.poll(() => api.requests.filter(request => request.path === '/api/configuration/scope' && request.method === 'PATCH').at(-1)?.body)
        .toEqual({ scope: 'global', values: { thinking: 'xhigh' } });
      await expect(defaults.getByRole('status')).toContainText('project or environment');
      await expect.poll(global).toMatchObject({ values: { model: 'mock-model', thinking: 'xhigh', toolPreset: 'read-only' } });
      const dismiss = page.locator('.status-center').getByRole('button', { name: 'Close', exact: true });
      for (let remaining = await dismiss.count(); remaining > 0; remaining -= 1) await dismiss.first().click();
      await expect(defaults).toHaveScreenshot(`settings-defaults-${viewport.name}-${theme}.png`);
      expect((await new AxeBuilder({ page }).include('#defaults').analyze()).violations).toEqual([]);
    });
  }
}

test('blocks unreadable defaults and gives a new draft fresh inherited values without mutating its history', async ({ page }) => {
  const api = await installMockApi(page, { configurationScopes: { global: { provider: 'mock', model: 'inherited-model', thinking: 'minimal' }, project: {} } });
  await page.goto('/');
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Message composer' });
  await expect(input).toBeVisible();
  await input.fill('Use the new defaults');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => api.requests.find(request => request.path === '/api/agent/runs' && request.method === 'POST')?.body)
    .toMatchObject({ model: 'inherited-model', thinking: 'minimal', settingOverrides: [] });
  await page.route('**/api/configuration/scope?**', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Configuration cannot be read safely.' }) }));
  await page.goto('/settings');
  const defaults = page.getByRole('heading', { name: 'Provider and model defaults' }).locator('..');
  await expect(defaults.getByRole('alert')).toBeVisible();
  await expect(defaults.getByLabel('Model', { exact: true })).toBeDisabled();
  await expect(defaults.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(api.requests.filter(request => request.path === '/api/configuration/scope' && request.method === 'PATCH')).toHaveLength(0);
  await page.route('**/api/configuration/effective?**', route => route.fulfill({ status: 409, contentType: 'application/json',
    body: JSON.stringify({ error: 'Configuration cannot be read safely.' }) }));
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message composer' }).fill('Retain this unsent draft');
  await expect(page.locator('.status-center')).toContainText('Configuration cannot be read safely.');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Message composer' })).toHaveValue('Retain this unsent draft');
  expect(api.requests.filter(request => request.path === '/api/agent/runs' && request.method === 'POST')).toHaveLength(1);
});
