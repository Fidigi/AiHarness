import AxeBuilder from '@axe-core/playwright';
import type { ToolSettings } from '@ai-harness/core';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { start, stop } from '../packages/server/dist/index.js';
import { expect, test } from './fixtures/test-budget';
import { selectCatalogueModel, selectInstalledSkill, selectModelSettings, selectPluginPackage, selectSettingsCategory, selectSettingsTool, showPluginPackages } from './fixtures/settings-navigation';

// Emitted static Web and real authenticated HTTP/storage. The single dropped
// response occurs AFTER route.fetch publishes to Express; no API data is mocked.
for (const scenario of [
  { locale: 'en', theme: 'light', width: 1280 },
  { locale: 'en', theme: 'dark', width: 390 },
  { locale: 'fr', theme: 'light', width: 390 },
  { locale: 'fr', theme: 'dark', width: 1280 },
] as const) test(`native Settings administration ${scenario.locale}/${scenario.theme}/${scenario.width}`, async ({ page }) => {
  const { locale, theme, width } = scenario;
  const text = locale === 'fr' ? {
    scope: 'Portée', model: 'Modèle', save: 'Enregistrer', refresh: 'Recharger les paramètres sauvegardés',
    uncertain: 'Le résultat de l’enregistrement est incertain', unconfirmed: 'L’enregistrement n’a pas pu être confirmé',
    disable: 'Désactiver les éléments affichés',
  } : {
    scope: 'Scope', model: 'Model', save: 'Save', refresh: 'Reload saved settings',
    uncertain: 'The save result is uncertain', unconfirmed: 'The save could not be confirmed', disable: 'Disable displayed',
  };
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-settings-admin-'));
  const cwd = path.join(root, 'work'), dataDir = path.join(root, 'data');
  const names = ['AI_HARNESS_AUTH_TOKEN', 'AI_HARNESS_ADMIN_TOKEN', 'AI_HARNESS_AGENT_DIR'] as const;
  const previous = names.map(name => process.env[name]);
  process.env.AI_HARNESS_AUTH_TOKEN = 'web03-disposable-user'; process.env.AI_HARNESS_ADMIN_TOKEN = 'web03-disposable-admin';
  process.env.AI_HARNESS_AGENT_DIR = path.join(root, 'agent');
  await mkdir(cwd);
  try {
    const server = await start({ port: 0, host: '127.0.0.1', dataDir, defaultCwd: cwd, allowedRoots: [cwd],
      webRoot: path.resolve('packages/web/dist'), enableMockProvider: true });
    const base = `http://127.0.0.1:${server.port}`;
    const patch = (scope: string, values: unknown, scopeId?: string) => page.request.patch(`${base}/api/configuration/scope`, { data: { scope, scopeId, values } });
    const denied = await page.request.patch(`${base}/api/configuration/scope`, {
      headers: { Authorization: 'Bearer web03-disposable-user' }, data: { scope: 'global', values: { model: 'denied' } },
    });
    expect(denied.status()).toBe(403);
    expect((await page.request.post(`${base}/api/auth/login`, { data: { token: 'web03-disposable-admin' } })).status()).toBe(200);
    expect((await page.request.post(`${base}/api/workspaces/trust`, { data: { cwd, confirm: true } })).status()).toBe(200);
    const workspace = await page.request.get(`${base}/api/workspaces/default`).then(response => response.json());
    expect((await patch('global', { provider: 'mock', model: 'global-original', thinking: 'low', toolPreset: 'chat-only' })).status()).toBe(200);
    expect((await patch('project', { model: 'project-original' }, workspace.id)).status()).toBe(200);
    for (const id of ['visible-a', 'visible-b', 'hidden']) expect((await page.request.post(`${base}/api/provider-registry/models`, {
      data: { provider: 'mock', id, name: id, capabilities: { reasoning: false, imageInput: false, toolCalls: true } },
    })).status()).toBe(201);
    for (const name of ['visible-one', 'visible-two', 'hidden-package']) {
      const source = path.join(cwd, 'packages', name);
      await mkdir(path.join(source, 'skills', name), { recursive: true });
      await writeFile(path.join(source, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
      await writeFile(path.join(source, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Local package skill\n---\nLiteral instructions.\n`);
      const installed = await page.request.post(`${base}/api/plugins`, { data: { action: 'install', source,
        scope: 'global', cwd, projectId: workspace.id } });
      expect(installed.status(), await installed.text()).toBe(200);
    }
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(({ locale, theme }) => {
      localStorage.setItem('ai-harness-locale', locale);
      localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme }));
    }, { locale, theme });
    await page.goto(`${base}/settings?cwd=${encodeURIComponent(cwd)}#defaults`);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const defaults = page.locator('#defaults');
    const scope = defaults.getByRole('combobox', { name: text.scope, exact: true });
    const model = defaults.getByLabel(text.model, { exact: true });
    const save = defaults.getByRole('button', { name: text.save, exact: true });
    await expect(scope).toHaveValue('project'); await expect(model).toHaveValue('project-original');
    // A second writer changes an untouched field after the form was read.
    expect((await patch('project', { thinking: 'high' }, workspace.id)).status()).toBe(200);
    await model.fill('project-saved'); await save.click();
    await expect(save).toBeDisabled(); await expect(model).toHaveValue('project-saved');
    await expect(defaults.locator('.defaults-provenance')).toContainText('project-saved');
    expect(JSON.parse(await readFile(path.join(dataDir, 'config.json'), 'utf8')).projects[workspace.id])
      .toMatchObject({ model: 'project-saved', thinking: 'high' });
    // Null is removal, not a flattened inherited value.
    await model.fill(''); await save.click(); await expect(save).toBeDisabled();
    await expect(model).toHaveValue(''); await expect(defaults.locator('.defaults-provenance')).toContainText('global-original');
    await scope.selectOption('global'); await expect(model).toHaveValue('global-original');
    await page.route('**/api/configuration/scope', async route => {
      expect(route.request().method()).toBe('PATCH');
      expect((await route.fetch()).status()).toBe(200);
      await route.abort('failed');
    }, { times: 1 });
    await model.fill('durable-despite-disconnect'); await save.click();
    await expect(defaults.getByRole('alert')).toContainText(text.unconfirmed);
    await expect(model).toHaveValue('durable-despite-disconnect'); await expect(save).toBeDisabled();
    await page.reload(); await expect(model).toHaveValue('durable-despite-disconnect');
    // A real malformed store refuses writes AND readback; no stale success.
    const file = path.join(dataDir, 'config.json'), before = await readFile(file, 'utf8');
    await writeFile(file, '{private-settings-marker');
    await model.fill('must-not-replace-unreadable'); await save.click();
    await expect(defaults.getByRole('alert')).toContainText(text.uncertain);
    await expect(model).toBeDisabled(); await expect(save).toBeDisabled();
    expect(await readFile(file, 'utf8')).toBe('{private-settings-marker');
    await expect(defaults).not.toContainText('private-settings-marker');
    expect((await new AxeBuilder({ page }).include('#defaults').analyze()).violations).toEqual([]);
    const dismiss = page.locator('.status-center').getByRole('button', { name: locale === 'fr' ? 'Fermer' : 'Close', exact: true });
    for (let remaining = await dismiss.count(); remaining > 0; remaining -= 1) await dismiss.first().click();
    await expect(defaults).toHaveScreenshot(`settings-readback-${locale}-${theme}-${width}.png`);
    await writeFile(file, before);
    await defaults.getByRole('button', { name: text.refresh, exact: true }).click();
    await expect(model).toBeEnabled(); await expect(model).toHaveValue('durable-despite-disconnect');
    await expect(defaults.getByRole('alert')).toHaveCount(0);
    // Exact-filter model batch: real catalogue/config publication, not fixtures.
    await selectModelSettings(page, 'model');
    const models = page.locator('#model'), disclosure = models.locator('.model-catalog');
    const mockProvider = locale === 'fr' ? 'Mock (tests)' : 'Mock (Testing)';
    if (await disclosure.getAttribute('open') === null) await disclosure.locator('summary').click();
    await models.getByRole('searchbox').fill('visible-');
    await selectCatalogueModel(page, mockProvider, 'visible-a');
    const group = models.locator('fieldset[data-provider="mock"]');
    const response = page.waitForResponse(response => response.url().endsWith('/api/models/enabled/batch'));
    await group.getByRole('button', { name: text.disable, exact: true }).click();
    const batch = await response; expect(batch.status()).toBe(200);
    expect((await batch.json()).outcomes).toEqual([
      { key: 'mock:visible-a', enabled: false, status: 'changed' },
      { key: 'mock:visible-b', enabled: false, status: 'changed' },
    ]);
    await expect(group.getByRole('checkbox').first()).not.toBeChecked();
    await models.getByRole('searchbox').fill('');
    await selectCatalogueModel(page, mockProvider, 'hidden');
    await expect(group.locator('[data-settings-selection="mock:hidden"]').getByRole('checkbox')).toBeChecked();
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    expect(persisted.global).toMatchObject({ model: 'durable-despite-disconnect', thinking: 'low', toolPreset: 'chat-only' });
    expect(persisted.projects[workspace.id].thinking).toBe('high');
    expect(persisted.projects[workspace.id].enabledModels).toContain('mock:hidden');
    expect(persisted.projects[workspace.id].enabledModels).not.toContain('mock:visible-a');
    await page.reload();
    // Own intent before reading/toggling a disclosure that deferred entry alignment can open.
    await disclosure.locator('summary').focus();
    if (await disclosure.getAttribute('open') === null) await disclosure.locator('summary').click();
    await selectCatalogueModel(page, mockProvider, 'visible-a');
    await expect(models.locator('[data-settings-selection="mock:visible-a"]').getByRole('checkbox')).not.toBeChecked();
    // A selected tool is presentation, not a reduced allowlist or a different write scope.
    const toolsUrl = `${base}/api/tools?${new URLSearchParams({ cwd, projectId: workspace.id })}`;
    const beforeTools = await page.request.get(toolsUrl).then(response => response.json()) as ToolSettings;
    expect(beforeTools.scope).toBe('global'); // Effective provenance differs from the Project write target.
    const selectedTool = beforeTools.tools.find(tool => tool.enabled && tool.available && tool.name !== 'codemode')!;
    expect(selectedTool).toBeDefined();
    const expectedTools = beforeTools.tools.filter(tool => tool.enabled && tool.name !== selectedTool.name).map(tool => tool.name);
    expect(expectedTools.length).toBeGreaterThan(0);
    await selectSettingsTool(page, selectedTool.name);
    await expect(page.locator('#tools').getByRole('combobox', { name: text.scope, exact: true })).toHaveValue('project');
    const toolCheckbox = page.locator('.tool-context-detail').getByRole('checkbox');
    const toolSave = page.waitForResponse(response => response.url().endsWith('/api/tools') && response.request().method() === 'PATCH');
    await toolCheckbox.focus(); await toolCheckbox.press('Space');
    const savedTools = await toolSave;
    expect(savedTools.status()).toBe(200);
    expect(savedTools.request().postDataJSON()).toMatchObject({ cwd, projectId: workspace.id, enabledTools: expectedTools, toolPreset: 'chat-only' });
    await expect(toolCheckbox).not.toBeChecked();
    const toolReadback = await page.request.get(toolsUrl).then(response => response.json()) as ToolSettings;
    expect(toolReadback.tools.filter(tool => tool.enabled).map(tool => tool.name)).toEqual(expectedTools);
    const toolConfig = JSON.parse(await readFile(file, 'utf8'));
    expect(toolConfig.projects[workspace.id].enabledTools).toEqual(expectedTools);
    expect(toolConfig.global).toEqual(persisted.global);
    await page.reload();
    await expect(toolCheckbox).not.toBeChecked();
    await expect(toolCheckbox).toHaveAccessibleName(new RegExp(selectedTool.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    // The package group must obey its filter too, rather than disabling hidden
    // packages in the same scope. Real local packages need no registry/network.
    await selectSettingsCategory(page, 'plugins');
    const plugins = page.locator('#plugins');
    await plugins.getByRole('searchbox').fill('visible-one');
    const globalPackages = plugins.locator('fieldset[data-scope="global"]');
    const globalActions = (await showPluginPackages(page)).getByRole('group', { name: locale === 'fr' ? 'Globale' : 'Global', exact: true });
    const pluginBatch = page.waitForResponse(response => response.url().endsWith('/api/plugins/enabled'));
    await globalActions.getByRole('button', { name: locale === 'fr' ? 'Tout désactiver (1)' : 'Disable all (1)', exact: true }).click();
    expect((await pluginBatch).request().postDataJSON().changes).toMatchObject([{ scope: 'global', enabled: false }]);
    await selectPluginPackage(page, 'global', 'visible-one');
    await expect(globalPackages.getByRole('checkbox')).not.toBeChecked();
    await plugins.getByRole('searchbox').fill('');
    await selectPluginPackage(page, 'global', 'hidden-package');
    await expect(globalPackages.locator('.plugin-card').filter({ hasText: 'hidden-package' }).getByRole('checkbox')).toBeChecked();
    await selectPluginPackage(page, 'global', 'visible-two');
    await expect(globalPackages.locator('.plugin-card').filter({ hasText: 'visible-two' }).getByRole('checkbox')).toBeChecked();
    await selectPluginPackage(page, 'global', 'visible-one');
    await page.route('**/api/plugins', async route => {
      expect((await route.fetch()).status()).toBe(200); await route.abort('failed');
    }, { times: 1 });
    await globalPackages.locator('.plugin-card').filter({ hasText: 'visible-one' }).getByRole('checkbox').check();
    await expect(plugins.getByRole('alert')).toContainText(text.unconfirmed);
    await expect(globalPackages.locator('.plugin-card').filter({ hasText: 'visible-one' }).getByRole('checkbox')).toBeChecked();
    await selectInstalledSkill(page, 'visible-one');
    await expect(page.locator('#skills').getByRole('button', { name: locale === 'fr'
      ? 'Lire les instructions de visible-one' : 'Read instructions for visible-one', exact: true })).toBeVisible();
    await selectSettingsCategory(page, 'plugins');
    await page.reload();
    await expect(globalPackages.locator('.plugin-card').filter({ hasText: 'visible-one' }).getByRole('checkbox')).toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await page.goto('about:blank').catch(() => undefined); await stop();
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    await rm(root, { recursive: true, force: true });
  }
});
