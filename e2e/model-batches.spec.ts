import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { ModelCatalog, ResourceEnableChange } from '@ai-harness/core';
import { installMockApi } from './fixtures/mock-api';

async function resources(page: Page, delayModelResponse?: (sequence: number) => Promise<void>) {
  let models: ModelCatalog = { updatedAt: '2025-01-01T12:00:00.000Z', enabledScope: 'global', enabledSource: 'global', providers:
    ['openai', 'azure'].map(provider => ({ provider, configured: true, models: ['visible-on', 'visible-off', 'hidden'].map(id => ({
      key: `${provider}:${id}`, provider, id, name: id, available: true, enabled: id !== 'visible-off', source: 'published',
      capabilities: { reasoning: false, imageInput: false, toolCalls: true },
    })) })) };
  const requests: { resource: string; body: { changes: ResourceEnableChange[]; projectId?: string } }[] = [];
  await installMockApi(page, { modelCatalog: models });
  await page.route('**/api/models/enabled/batch', async route => {
    const body = route.request().postDataJSON() as typeof requests[number]['body'];
    requests.push({ resource: 'models', body });
    const outcomes = body.changes.map(change => ({ ...change, status: 'changed' }));
    const changes = new Map(body.changes.map(change => [change.key, change.enabled]));
    models = { ...models, enabledScope: 'project', enabledSource: body.projectId!, providers: models.providers.map(group => ({
      ...group, models: group.models.map(model => ({ ...model, enabled: changes.get(model.key) ?? model.enabled })),
    })) };
    const response = JSON.stringify({ outcomes, catalog: models });
    await delayModelResponse?.(requests.length);
    await route.fulfill({ contentType: 'application/json', body: response });
  });
  await page.route('**/api/models?*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(models) }));
  return { requests };
}

for (const viewport of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'mobile', width: 390, height: 844 }]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${viewport.name}-${theme} model provider groups preserve hidden rows and save only changed selectors`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(theme => {
        localStorage.setItem('ai-harness-locale', 'en');
        localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme }));
      }, theme);
      const api = await resources(page);
      await page.goto('/settings');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const model = page.locator('#model');
      await model.locator('summary').click();
      await model.getByRole('searchbox').fill('visible');
      const openai = model.locator('fieldset[data-provider="openai"]');
      await openai.getByRole('button', { name: 'Enable displayed', exact: true }).click();
      await expect.poll(() => api.requests).toEqual([{ resource: 'models', body: {
        changes: [{ key: 'openai:visible-off', enabled: true }], projectId: 'workspace-e2e',
      } }]);
      await expect(model.getByRole('list', { name: 'Batch outcomes' })).toContainText('visible-off: changed');
      await expect(openai.getByRole('button', { name: 'Enable displayed', exact: true })).toBeDisabled();
      await openai.getByRole('button', { name: 'Disable displayed', exact: true }).click();
      await expect.poll(() => api.requests[1]?.body).toEqual({ changes: [
        { key: 'openai:visible-on', enabled: false }, { key: 'openai:visible-off', enabled: false },
      ], projectId: 'workspace-e2e' });
      await expect(openai.locator('label').filter({ hasText: 'visible-on' }).getByRole('checkbox')).not.toBeChecked();
      await model.getByRole('searchbox').fill('');
      await expect(openai.locator('label').filter({ hasText: 'hidden' }).getByRole('checkbox')).toBeChecked();
      await expect(model.locator('fieldset[data-provider="azure"]').locator('label').filter({ hasText: 'visible-on' }).getByRole('checkbox')).toBeChecked();
      // Individual toggles still save one selector via the same real batch contract.
      await openai.locator('label').filter({ hasText: 'visible-on' }).getByRole('checkbox').click();
      await expect.poll(() => api.requests[2]?.body.changes).toEqual([{ key: 'openai:visible-on', enabled: true }]);
      await expect(openai.locator('label').filter({ hasText: 'visible-on' }).getByRole('checkbox')).toBeChecked();
      await page.evaluate(() => document.fonts.ready);
      await model.getByRole('searchbox').fill('visible');
      await expect(openai).toHaveScreenshot(`models-batches-${viewport.name}-${theme}.png`);
      expect((await new AxeBuilder({ page }).include('#model').analyze()).violations).toEqual([]);

      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(api.requests).toHaveLength(3);
    });
  }
}

test('does not let a retired Settings save replace a newer same-workspace catalogue', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const api = await resources(page, sequence => sequence === 1 ? held : Promise.resolve());
  await page.goto('/settings');
  const models = page.locator('#model');
  await models.locator('summary').click();
  const checkbox = models.locator('fieldset[data-provider="openai"] label').filter({ hasText: 'visible-on' }).getByRole('checkbox');
  try {
    await checkbox.click();
    await expect.poll(() => api.requests.length).toBe(1);
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(page.locator('.settings-view')).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: false }).click();
    await expect(models).toBeVisible();
    await models.locator('summary').click();
    await models.getByRole('button', { name: 'Refresh catalogue', exact: true }).click();
    await expect(checkbox).not.toBeChecked();
    await checkbox.click();
    await expect.poll(() => api.requests.length).toBe(2);
    await expect(checkbox).toBeChecked();
    const settled = page.waitForResponse(response => response.url().includes('/api/models/enabled/batch'));
    release();
    await settled;
    await expect(checkbox).toBeChecked();
    await expect(models.getByRole('list', { name: 'Batch outcomes' })).toContainText('visible-on: changed');
  } finally { release(); }
});
