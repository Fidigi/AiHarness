import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from './fixtures/test-budget';
import type { ModelCatalog, ResourceEnableChange } from '@ai-harness/core';
import { installMockApi } from './fixtures/mock-api';
import { expectContrast } from './fixtures/contrast';
import { closeSettings, selectCatalogueModel, selectGeneralSettings, selectModelSettings, selectSettingsCategory } from './fixtures/settings-navigation';

async function resources(page: Page, delayModelResponse?: (sequence: number) => Promise<void>) {
  let models: ModelCatalog = { updatedAt: '2025-01-01T12:00:00.000Z', enabledScope: 'global', enabledSource: 'global', providers:
    ['openai', 'azure'].map(provider => ({ provider, configured: true, models: ['visible-on', 'visible-off', 'hidden'].map(id => ({
      key: `${provider}:${id}`, provider, id, name: id, available: true, enabled: id !== 'visible-off', source: 'published',
      capabilities: { reasoning: false, imageInput: false, toolCalls: true },
    })) })) };
  const requests: { resource: string; body: { changes: ResourceEnableChange[]; projectId?: string } }[] = [];
  await installMockApi(page, { modelCatalog: models, providers: [{ type: 'openai', configured: true }, { type: 'azure', configured: true }] });
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
  return { requests, catalog: () => models };
}

for (const scenario of [
  { width: 1280, locale: 'en', theme: 'light' }, { width: 1280, locale: 'fr', theme: 'dark' },
  { width: 390, locale: 'en', theme: 'light' }, { width: 390, locale: 'fr', theme: 'dark' },
]) {
  test(`Catalogue metadata browsing never selects or enables a model: ${scenario.width}px ${scenario.locale}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: scenario.width, height: 844 });
    await page.addInitScript(({ locale, theme }) => {
      localStorage.setItem('ai-harness-locale', locale);
      localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme }));
    }, scenario);
    const mutations: string[] = [];
    page.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (request.method() !== 'GET' && !['/api/workspaces/validate', '/api/mcp/oauth/status'].includes(pathname)) mutations.push(pathname);
    });
    const api = await resources(page);
    await page.goto('/settings#model');
    const section = page.locator('#model'), catalog = section.locator('.model-catalog');
    await catalog.locator('summary').click();
    await expect(catalog.locator('.model-catalog-row input')).toHaveCount(6);
    const selected = section.locator(':scope > select');
    await expect(selected).toBeEnabled(); await expect(selected).not.toHaveValue('');
    const before = await selected.inputValue();
    const navigation = catalog.getByRole('navigation', { name: /^(Manage model catalogue|Gérer le catalogue de modèles)$/u });
    await expect(navigation).toBeVisible();
    const choice = navigation.getByRole('group', { name: 'OpenAI', exact: true }).getByRole('button')
      .filter({ has: page.getByText('visible-off', { exact: true }).and(page.locator('code')) });
    await choice.focus(); await choice.press('Enter');
    const detail = catalog.locator('.model-catalog-detail');
    await expect(detail.getByRole('checkbox')).toHaveCount(1);
    await expect(detail.getByRole('checkbox')).not.toBeChecked();
    await expect(detail.locator('[data-settings-selection="openai:visible-off"]')).toBeVisible();
    await expect(selected).toHaveValue(before);
    const current = catalog.locator('nav').getByRole('group', { name: 'OpenAI', exact: true, includeHidden: true })
      .getByRole('button', { includeHidden: true }).filter({ has: page.getByText('visible-off', { exact: true }).and(page.locator('code')) });
    await expect(current).toHaveAttribute('aria-current', 'true'); await expect(current).toHaveAttribute('aria-expanded', 'true');
    await expect(current).toHaveCSS('border-left-width', '3px');
    const back = catalog.getByRole('button', { name: /^(Back to model catalogue|Retour au catalogue de modèles)$/u });
    if (scenario.width < 960) {
      await expect(back).toBeFocused(); await back.press('Enter');
      for (const control of [choice, back]) {
        await expect(control).toBeFocused(); await expect(control).toHaveCSS('outline-style', 'solid');
        await expectContrast(control, 'outlineColor', 3);
        expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        const clearance = await control.evaluate(element => {
          const style = getComputedStyle(element), box = element.getBoundingClientRect();
          const extent = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
          return Math.min(...[element.closest('nav') ?? element.closest('.model-catalog-detail')!, element.closest('.settings-view')!]
            .flatMap(owner => { const clip = owner.getBoundingClientRect(); return [box.left - clip.left, clip.right - box.right, box.top - clip.top, clip.bottom - box.bottom]; })) - extent;
        });
        expect(clearance).toBeGreaterThanOrEqual(-0.1);
        if (control === choice) await choice.press('Enter');
      }
    } else {
      await expect(choice).toBeFocused();
      const list = (await navigation.boundingBox())!, content = (await detail.boundingBox())!;
      expect(list.x + list.width).toBeLessThanOrEqual(content.x);
    }
    expect((await new AxeBuilder({ page }).include('#model').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
    expect(await page.locator('.settings-view').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const capture = testInfo.outputPath(`model-context-${scenario.width}-${scenario.locale}.png`);
    await page.screenshot({ path: capture, animations: 'disabled', caret: 'hide' });
    await testInfo.attach('model-context', { path: capture, contentType: 'image/png' });
    await selectGeneralSettings(page, 'appearance');
    await selectModelSettings(page, 'model');
    await expect(detail.locator('[data-settings-selection="openai:visible-off"]')).toBeVisible();
    const memory = JSON.parse(await page.evaluate(() => localStorage.getItem('ai-harness-settings-navigation-v1')!));
    expect(memory.entries.find((entry: { cwd: string }) => entry.cwd === '/workspace').positions.model)
      .toEqual({ group: 'openai', selection: 'openai:visible-off' });
    if (scenario.width < 960) {
      await expect(back).toBeVisible(); await back.click(); await expect(choice).toBeFocused(); await choice.press('Enter');
    }
    await page.reload();
    await expect(detail.locator('[data-settings-selection="openai:visible-off"]')).toBeVisible();
    await expect(selected).toHaveValue(before);
    const filter = catalog.getByRole('searchbox');
    await filter.fill('hidden');
    await expect(catalog.getByRole('status').filter({ hasText: /selected model is unavailable|modèle sélectionné/u })).toBeVisible();
    await expect(detail.getByRole('checkbox')).toHaveCount(0); await expect(filter).toBeFocused();
    await expect(filter).toHaveValue('hidden');
    await filter.fill('');
    await expect(detail.getByRole('checkbox')).not.toBeChecked(); await expect(filter).toBeFocused();
    expect(api.requests).toEqual([]); expect(mutations).toEqual([]);
    const longName = 'fixture_model_catalogue_metadata_with_an_explicit_long_name_and_preserved_enablement_authority';
    const inventory = api.catalog();
    const fresh: ModelCatalog = { ...inventory, providers: inventory.providers.map(group => group.provider === 'openai'
      ? { ...group, models: [...group.models.filter(model => model.key !== 'openai:visible-off'),
        { ...group.models[0]!, key: 'openai:long-fixture', id: longName, name: longName, enabled: false }] } : group) };
    await page.route('**/api/models?*', route => route.fulfill({ json: fresh }));
    await page.reload();
    await expect(navigation).toBeVisible(); await expect(detail.getByRole('checkbox')).toHaveCount(0);
    await expect(catalog.getByRole('status').filter({ hasText: /selected model is unavailable|modèle sélectionné/u })).toBeVisible();
    await selectCatalogueModel(page, 'Azure OpenAI', 'visible-off');
    await expect(detail.locator('[data-settings-selection="azure:visible-off"]')).toBeVisible();
    await selectCatalogueModel(page, 'OpenAI', longName);
    const longDetail = detail.locator('[data-settings-selection="openai:long-fixture"]');
    await expect(longDetail).toBeVisible();
    await expect(longDetail.locator('.model-catalog-identity strong')).toHaveText(longName);
    await expect(detail.getByRole('checkbox')).not.toBeChecked(); await expect(selected).toHaveValue(before);
    expect(await page.locator('.settings-view').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const longCapture = testInfo.outputPath(`model-context-long-${scenario.width}-${scenario.locale}.png`);
    await page.screenshot({ path: longCapture, animations: 'disabled', caret: 'hide' });
    await testInfo.attach('model-context-long', { path: longCapture, contentType: 'image/png' });
    expect(api.requests).toEqual([]); expect(mutations).toEqual([]);
  });
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
      await page.goto('/settings#model');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const model = page.locator('#model');
      await model.locator('summary').click();
      await model.getByRole('searchbox').fill('visible');
      const openai = model.locator('fieldset[data-provider="openai"]');
      await selectCatalogueModel(page, 'OpenAI', 'visible-on');
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
      await selectCatalogueModel(page, 'OpenAI', 'hidden');
      await expect(openai.locator('label').filter({ hasText: 'hidden' }).getByRole('checkbox')).toBeChecked();
      await selectCatalogueModel(page, 'Azure OpenAI', 'visible-on');
      await expect(model.locator('fieldset[data-provider="azure"]').locator('label').filter({ hasText: 'visible-on' }).getByRole('checkbox')).toBeChecked();
      // Individual toggles still save one selector via the same real batch contract.
      await selectCatalogueModel(page, 'OpenAI', 'visible-on');
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

for (const width of [1280, 390]) test(`does not let a retired Settings save replace a newer same-workspace catalogue: ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 844 });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const api = await resources(page, sequence => sequence === 1 ? held : Promise.resolve());
  await page.goto('/settings#model');
  const models = page.locator('#model');
  await models.locator('summary').click();
  await selectCatalogueModel(page, 'OpenAI', 'visible-on');
  const checkbox = models.locator('fieldset[data-provider="openai"] label').filter({ hasText: 'visible-on' }).getByRole('checkbox', { includeHidden: true });
  try {
    await checkbox.click();
    await expect.poll(() => api.requests.length).toBe(1);
    if (width < 960) {
      const back = models.getByRole('button', { name: 'Back to model catalogue', exact: true });
      await back.focus(); await back.press('Enter');
      const navigation = models.getByRole('navigation', { name: 'Manage model catalogue', exact: true });
      await expect(navigation).toBeFocused(); await expect(navigation).toHaveCSS('outline-style', 'solid');
      await expectContrast(navigation, 'outlineColor', 3);
      const pendingCapture = testInfo.outputPath('model-pending-back-390.png');
      await page.screenshot({ path: pendingCapture, animations: 'disabled', caret: 'hide' });
      await testInfo.attach('model-pending-back', { path: pendingCapture, contentType: 'image/png' });
    }
    // Category changes retain pending work; closing still retires the view below.
    await selectSettingsCategory(page, 'general');
    await selectSettingsCategory(page, 'models');
    await expect(checkbox).toBeDisabled();
    expect(api.requests).toHaveLength(1);
    await closeSettings(page);
    if (width < 960) await page.getByRole('button', { name: 'Toggle navigation', exact: true }).click();
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(page.locator('.settings-view')).toHaveCount(0);
    const settings = page.getByRole('button', { name: 'Settings', exact: false });
    if (width < 960 && !await settings.isVisible()) await page.getByRole('button', { name: 'Toggle navigation', exact: true }).click();
    await settings.click();
    await expect(models).toBeVisible();
    // A remembered fresh row may already have opened its disclosure.
    const disclosure = models.locator('.model-catalog');
    if (await disclosure.getAttribute('open') === null) await disclosure.locator('summary').click();
    await expect(disclosure).toHaveAttribute('open', '');
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
