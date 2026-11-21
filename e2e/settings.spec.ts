import AxeBuilder from '@axe-core/playwright';
import type { CustomModelDefinition, SkillCatalog, SkillRegistry } from '@ai-harness/core';
import { expect, test, type Page } from './fixtures/test-budget';
import { installMockApi, mockSession } from './fixtures/mock-api';
import { closeSettings, reloadSettingsDiscardingDrafts, selectCatalogueModel, selectCustomModel, selectGeneralSettings, selectInstalledSkill, selectModelSettings, selectPluginPackage, selectProviderConnection, selectProviderCredential, selectRegistryEntry, selectSettingsCategory, selectSettingsTool, selectSubagentProfile, showPluginPackages } from './fixtures/settings-navigation';
import { expectContrast, expectThemeRoles } from './fixtures/contrast';
import { selectMcpServer } from './fixtures/mcp-navigation';
import {
  MCP_FILE_PROBLEM_MESSAGES,
  MCP_FILE_PROBLEM_REASONS,
  mcpFileProblemInventory,
  mcpFreshProjectInventory,
  mcpFreshProjectPreviewFixture,
  mcpImportPreviewFixture,
  mcpStateInventory,
} from './fixtures/mcp';

function settingsSection(page: Page, heading: string) {
  return page.getByRole('heading', { name: heading, exact: true }).locator('..');
}

function registryFixtures(): SkillRegistry {
  return {
    source: 'https://registry.example.test/index.json', updatedAt: '2025-01-01T12:00:00.000Z',
    entries: ['fixture-registry-a', 'fixture-registry-b'].map(id => ({
      id, name: id, description: `Description ${id}`, version: '2.2.1',
      downloadUrl: `https://registry.example.test/${id}.md`, sha256: 'a'.repeat(64),
    })),
  };
}

function customModelFixtures(): CustomModelDefinition[] {
  return ['openai:first', 'openai:shared', 'azure:shared'].map(key => ({
    key, provider: key.split(':')[0]!, id: key.split(':')[1]!, name: key,
    capabilities: { reasoning: true, imageInput: false, toolCalls: true }, contextWindow: 64000, maxOutputTokens: 4096,
    createdAt: '2025-01-01T12:00:00.000Z', updatedAt: '2025-01-01T12:00:00.000Z',
  }));
}

test.describe('Settings and authentication', () => {
  test('présente les fournisseurs hydratés et le nombre de sessions', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ai-harness-transport', 'websocket'));
    await installMockApi(page, {
      sessions: [mockSession('first-session', 'Première'), mockSession('second-session', 'Deuxième')],
      providers: [{ type: 'mock', configured: true }, { type: 'openai', configured: true }],
    });
    await page.goto('/settings#providers');

    const provider = settingsSection(page, 'AI Provider');
    await expect(provider.getByLabel('Select the AI Provider', { exact: true })).toHaveValue('mock');
    await provider.getByLabel('Select the AI Provider', { exact: true }).selectOption('openai');
    await expect(provider.getByText('✅ OpenAI configured')).toBeVisible();
    await selectModelSettings(page, 'model');
    await expect(settingsSection(page, 'Model').locator('select')).toBeEnabled();
    await expect(settingsSection(page, 'Model').locator('option')).toContainText([
      'GPT-4o (Recommended)', 'GPT-4 Turbo', 'GPT-3.5 Turbo',
    ]);
    await selectGeneralSettings(page, 'about');
    await expect(settingsSection(page, 'Sessions')).toContainText('Total sessions: 2');
    await expect(page.locator('#transport')).toHaveCount(0);
    await expect(page.getByLabel('Select the real-time transport', { exact: true })).toHaveCount(0);
  });

  test('filtre le catalogue serveur, active les modèles par workspace et alimente le chat', async ({ page }) => {
    const api = await installMockApi(page, {
      providers: [
        { type: 'mock', configured: true },
        { type: 'openai', configured: true },
        { type: 'anthropic', configured: false },
      ],
      configurationScopes: { global: { provider: 'openai', model: 'gpt-4o', toolPreset: 'default' }, project: {} },
    });
    await page.goto('/settings#model');
    await selectModelSettings(page, 'providers');
    await settingsSection(page, 'AI Provider').getByLabel('Select the AI Provider', { exact: true }).selectOption('openai');
    await selectModelSettings(page, 'model');

    const section = settingsSection(page, 'Model');
    await section.getByText('Manage model catalogue').click();
    await selectCatalogueModel(page, 'OpenAI', 'gpt-4o');
    await expect(section.locator('[data-settings-selection="openai:gpt-4o"]')).toBeVisible();
    await expect(section.locator('fieldset[data-provider="openai"]')).toContainText('GPT-4o (Recommended)');
    await expect(section.locator('fieldset[data-provider="openai"]')).toContainText('images');
    await selectCatalogueModel(page, 'Anthropic', 'claude-3-haiku-20240307');
    await expect(section.locator('fieldset[data-provider="anthropic"]')).toBeVisible();
    await expect(section.locator('fieldset[data-provider="anthropic"]')).toContainText('unavailable');

    await section.getByLabel('Filter models or providers').fill('o3');
    await selectCatalogueModel(page, 'OpenAI', 'o3');
    await expect(section.locator('.model-catalog-row')).toHaveCount(1);
    await expect(section.locator('.model-catalog-row')).toContainText('reasoning');
    await section.getByLabel('Filter models or providers').fill('');

    const o3 = section.getByRole('checkbox', { name: 'Enable o3 for OpenAI' });
    await o3.click();
    await expect(o3).not.toBeChecked();
    await expect.poll(() => api.requests.filter(request => request.path === '/api/models/enabled/batch').at(-1)?.body)
      .toEqual({ projectId: 'workspace-e2e', changes: [{ key: 'openai:o3', enabled: false }] });

    const keys = ['mock:mock-model', 'openai:gpt-4o', 'openai:gpt-4-turbo', 'openai:gpt-3.5-turbo',
      'anthropic:claude-3-haiku-20240307'];
    const catalogueActions = section.getByRole('group', { name: 'Manage model catalogue', exact: true });
    await catalogueActions.getByRole('button', { name: 'Disable displayed', exact: true }).click();
    await expect.poll(() => api.requests.filter(request => request.path === '/api/models/enabled/batch').at(-1)?.body)
      .toEqual({ projectId: 'workspace-e2e', changes: keys.map(key => ({ key, enabled: false })) });
    await expect(section.locator('.model-catalog-row input:checked')).toHaveCount(0);
    await catalogueActions.getByRole('button', { name: 'Enable displayed', exact: true }).click();
    await expect.poll(() => api.requests.filter(request => request.path === '/api/models/enabled/batch').at(-1)?.body)
      .toEqual({ projectId: 'workspace-e2e', changes: [...keys.slice(0, 4), 'openai:o3', keys[4]].map(key => ({ key, enabled: true })) });
    await expect(section.locator('.model-catalog-row input:checked')).toHaveCount(6);

    const catalogueRequests = api.requests.filter(request => request.path === '/api/models').length;
    await section.getByRole('button', { name: 'Refresh catalogue' }).click();
    await expect.poll(() => api.requests.filter(request => request.path === '/api/models').length).toBe(catalogueRequests + 1);

    await o3.click();
    await expect(o3).not.toBeChecked();
    await closeSettings(page);
    await page.getByRole('button', { name: 'New chat' }).click();
    const suggestions = page.locator('#model-suggestions option');
    await expect.poll(() => suggestions.evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
      .toEqual(['gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo']);
    await expect(page.locator('#model-suggestions option[value="o3"]')).toHaveCount(0);
  });

  test('gère OAuth et un provider compatible sans réexposer ses secrets', async ({ page }) => {
    const api = await installMockApi(page, {
      providers: [{ type: 'mock', configured: true }, { type: 'openai', configured: false }],
      providerAuthStatuses: [
        {
          type: 'mock', name: 'Mock', configured: true, connected: true, method: 'none',
          reconnectSupported: false, disconnectSupported: false,
        },
        {
          type: 'openai', name: 'OpenAI', configured: false, connected: false, method: 'oauth',
          reconnectSupported: true, disconnectSupported: false,
        },
      ],
    });
    await page.goto('/settings#provider-lifecycle');
    const section = settingsSection(page, 'Provider connections and custom providers');
    const openai = section.locator('.settings-resource-card').filter({ hasText: 'OpenAI' });
    await selectProviderConnection(page, 'builtin', 'openai');
    await openai.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(section.getByText('E2E-CODE')).toBeVisible();
    await expect(section.getByRole('link', { name: 'Open the provider authorization page' }))
      .toHaveAttribute('href', 'https://oauth.example.test/activate');
    await section.getByRole('button', { name: 'Cancel' }).click();

    await section.getByText('Create or edit a compatible provider').click();
    const editor = section.locator('.custom-resource-editor');
    await editor.getByLabel('ID', { exact: true }).fill('acme');
    await editor.getByLabel('Name').fill('Acme Gateway');
    await editor.getByLabel('Base URL').fill('https://models.acme.test/v1');
    await editor.getByLabel('API dialect').selectOption('openai-completions');
    await editor.getByLabel('API key', { exact: true }).fill('e2e-provider-secret');
    await editor.getByLabel('Custom headers (encrypted JSON values)').fill('{"X-Tenant":"private-tenant"}');
    await editor.getByRole('button', { name: 'Save' }).click();

    const card = section.locator('.settings-resource-card').filter({ hasText: 'Acme Gateway' });
    await expect(card).toContainText('connected');
    await expect(section).not.toContainText('e2e-provider-secret');
    await expect(section).not.toContainText('private-tenant');
    await card.getByRole('button', { name: 'Import models' }).click();
    await expect.poll(() => api.requests.filter(request => request.path.endsWith('/import-models')).length).toBe(1);
  });

  test('administre modèles personnalisés, valeurs par défaut, outils et registre de skills', async ({ page }) => {
    const api = await installMockApi(page, {
      providers: [{ type: 'mock', configured: true }, { type: 'openai', configured: true }],
    });
    await page.goto('/settings#custom-models');

    const models = settingsSection(page, 'Custom models');
    await models.getByText('Create a custom model').click();
    await models.getByLabel('Provider').fill('openai');
    await models.getByLabel('ID', { exact: true }).fill('gpt-e2e');
    await models.getByLabel('Name').fill('GPT E2E');
    await models.getByText('reasoning', { exact: true }).locator('input').check();
    await models.getByLabel('Context window').fill('64000');
    await models.getByLabel('Maximum output tokens').fill('4096');
    await models.getByLabel('Input price / million tokens').fill('2.5');
    await models.getByLabel('Output price / million tokens').fill('10');
    await models.getByLabel('Advanced compatibility (JSON)').fill('{"supportsDeveloperRole":true}');
    await models.getByRole('button', { name: 'Save' }).click();
    await selectCustomModel(page, 'openai:gpt-e2e');
    await expect(models.locator('.custom-model-context-detail').getByText('GPT E2E')).toBeVisible();
    await expect.poll(() => api.requests.filter(request => request.path === '/api/provider-registry/models' && request.method === 'POST').at(-1)?.body)
      .toMatchObject({ provider: 'openai', id: 'gpt-e2e', contextWindow: 64000, maxOutputTokens: 4096 });

    await selectGeneralSettings(page, 'behavior');
    const defaults = settingsSection(page, 'Provider and model defaults');
    await defaults.getByLabel('Provider').fill('openai');
    await defaults.getByLabel('Model').fill('gpt-e2e');
    await defaults.getByLabel('Default tool preset').selectOption('read-only');
    await defaults.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => api.requests.filter(request => request.path === '/api/configuration/scope' && request.method === 'PATCH').at(-1)?.body)
      .toMatchObject({ scope: 'project', scopeId: 'workspace-e2e', values: { provider: 'openai', model: 'gpt-e2e', toolPreset: 'read-only' } });

    await selectSettingsCategory(page, 'tools');
    const tools = settingsSection(page, 'Tools and presets');
    await tools.getByLabel('Default tool preset').selectOption('read-only');
    await expect.poll(() => api.requests.filter(request => request.path === '/api/tools' && request.method === 'PATCH').at(-1)?.body)
      .toMatchObject({ projectId: 'workspace-e2e', toolPreset: 'read-only' });
    await selectSettingsTool(page, 'powershell');
    await expect(tools.locator('[data-settings-selection="powershell"]')).toBeVisible();
    await expect(tools.locator('[data-settings-selection="powershell"]').getByRole('checkbox')).toBeDisabled();

    await selectSettingsCategory(page, 'skills');
    const skills = settingsSection(page, 'Skills');
    await selectRegistryEntry(page, 'security-review');
    const registryDetail = skills.locator('.skill-registry-context-detail');
    await expect(registryDetail.getByText('security-review', { exact: true })).toBeVisible();
    await registryDetail.getByRole('button', { name: 'Install', exact: true }).click();
    await expect.poll(() => api.requests.filter(request => request.path === '/api/skills/registry/install').at(-1)?.body)
      .toMatchObject({ id: 'security-review', scope: 'project', cwd: '/workspace', projectId: 'workspace-e2e' });
  });

  for (const scenario of [
    { width: 1280, locale: 'en', theme: 'light' },
    { width: 1280, locale: 'fr', theme: 'dark' },
    { width: 390, locale: 'en', theme: 'light' },
    { width: 390, locale: 'fr', theme: 'dark' },
  ] as const) test(`Registry metadata browsing never installs or reads instructions: ${scenario.width}px ${scenario.locale}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: scenario.width, height: 844 });
    await page.addInitScript(({ locale, theme }) => {
      localStorage.setItem('ai-harness-locale', locale);
      localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme }));
    }, scenario);
    const registryFixture = registryFixtures();
    const api = await installMockApi(page, { skillRegistry: registryFixture });
    await page.goto('/settings#skills');
    const section = page.locator('#skills'), registry = section.locator('.skill-registry');
    await registry.locator('summary').focus(); await registry.locator('summary').click();
    const enabled = await section.locator('.skill-catalog-row input[type="checkbox"]').evaluateAll(inputs =>
      inputs.map(input => ({ name: input.getAttribute('aria-label'), checked: (input as HTMLInputElement).checked })));
    const scope = registry.getByRole('combobox');
    await expect(scope).toHaveValue('project');
    const navigation = registry.getByRole('navigation', { name: /^(Browse Agent Skills registry|Parcourir le registre Agent Skills)$/u });
    await expect(navigation).toBeVisible();
    const choice = navigation.getByRole('button').filter({ has: page.getByText('fixture-registry-b', { exact: true }).and(page.locator('code')) });
    await choice.focus(); await choice.press('Enter');
    const detail = registry.locator('.skill-registry-context-detail');
    await expect(detail.getByRole('article')).toHaveCount(1);
    await expect(detail.getByRole('article')).toHaveAttribute('data-settings-selection', 'fixture-registry-b');
    await expect(detail).toContainText('Description fixture-registry-b'); await expect(detail).toContainText('v2.2.1');
    await expect(scope).toHaveValue('project');
    const current = registry.locator('nav button').filter({ has: page.getByText('fixture-registry-b', { exact: true }).and(page.locator('code')) });
    await expect(current).toHaveAttribute('aria-current', 'true'); await expect(current).toHaveAttribute('aria-expanded', 'true');
    await expect(current).toHaveCSS('border-left-width', '3px');
    const back = registry.getByRole('button', { name: /^(Back to Agent Skills registry|Retour au registre Agent Skills)$/u });
    if (scenario.width < 960) {
      await expect(back).toBeFocused(); await back.press('Enter');
      for (const control of [choice, back]) {
        await expect(control).toBeFocused(); await expect(control).toHaveCSS('outline-style', 'solid');
        await expectContrast(control, 'outlineColor', 3);
        expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        const clearance = await control.evaluate(element => {
          const style = getComputedStyle(element), box = element.getBoundingClientRect();
          const extent = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
          return Math.min(...[element.closest('nav') ?? element.closest('.skill-registry-context-detail')!, element.closest('.settings-view')!]
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
    expect((await new AxeBuilder({ page }).include('.skill-registry').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
    expect(await page.locator('.settings-view').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const capture = testInfo.outputPath(`registry-context-${scenario.width}-${scenario.locale}.png`);
    await page.screenshot({ path: capture, animations: 'disabled', caret: 'hide' });
    await testInfo.attach('registry-context', { path: capture, contentType: 'image/png' });
    if (scenario.width < 960) {
      await selectInstalledSkill(page, 'release-notes');
      await back.focus(); await back.press('Enter');
      await expect(choice).toBeFocused();
      const returned = JSON.parse(await page.evaluate(() => localStorage.getItem('ai-harness-settings-navigation-v1')!));
      expect(returned.entries.find((entry: { cwd: string }) => entry.cwd === '/workspace').positions.skills)
        .toEqual({ group: 'registry', selection: 'fixture-registry-b' });
      await choice.press('Enter');
    }
    await selectGeneralSettings(page, 'appearance'); await selectSettingsCategory(page, 'skills');
    await expect(detail.getByRole('article')).toHaveAttribute('data-settings-selection', 'fixture-registry-b');
    const memory = JSON.parse(await page.evaluate(() => localStorage.getItem('ai-harness-settings-navigation-v1')!));
    expect(memory.entries.find((entry: { cwd: string }) => entry.cwd === '/workspace').positions.skills)
      .toEqual({ group: 'registry', selection: 'fixture-registry-b' });
    await page.reload();
    await expect(detail.getByRole('article')).toHaveAttribute('data-settings-selection', 'fixture-registry-b');
    await expect(section.getByRole('status').filter({ hasText: /selected skill is unavailable|La compétence sélectionnée/u })).toHaveCount(0);
    const search = registry.getByRole('searchbox');
    await search.fill('fixture-registry-a');
    await expect(registry.getByRole('status')).toContainText(/selected registry entry is unavailable|L’entrée sélectionnée du registre n’est pas disponible/u);
    await expect(detail.getByRole('article')).toHaveCount(0); await expect(search).toBeFocused(); await expect(search).toHaveValue('fixture-registry-a');
    await search.fill('');
    await expect(detail.getByRole('article')).toHaveAttribute('data-settings-selection', 'fixture-registry-b'); await expect(search).toBeFocused();
    const longId = 'fixture-registry-metadata-with-a-long-name-and-preserved-explicit-install-and-update-authority';
    const fresh = { ...registryFixture, entries: [registryFixture.entries[0]!,
      { ...registryFixture.entries[1]!, id: 'fixture-registry-replacement' },
      { ...registryFixture.entries[0]!, id: longId, name: longId }] };
    await page.route('**/api/skills/registry?*', route => {
      const query = new URL(route.request().url()).searchParams.get('query') ?? '';
      return route.fulfill({ json: { ...fresh, entries: fresh.entries.filter(entry => entry.name.includes(query)) } });
    });
    await page.reload();
    await expect(navigation).toBeVisible(); await expect(detail.getByRole('article')).toHaveCount(0);
    await expect(registry.getByRole('status')).toContainText(/selected registry entry is unavailable|L’entrée sélectionnée du registre n’est pas disponible/u);
    await navigation.getByRole('button').filter({ has: page.getByText('fixture-registry-replacement', { exact: true }).and(page.locator('code')) }).click();
    await expect(detail.getByRole('article')).toHaveAttribute('data-settings-selection', 'fixture-registry-replacement');
    if (scenario.width < 960) await back.click();
    await navigation.getByRole('button').filter({ has: page.getByText(longId, { exact: true }).and(page.locator('code')) }).click();
    await expect(detail.getByRole('article')).toHaveAttribute('data-settings-selection', longId);
    await expect(detail.getByRole('article').locator('strong')).toHaveText(longId);
    expect(await page.locator('.settings-view').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const longCapture = testInfo.outputPath(`registry-context-long-${scenario.width}-${scenario.locale}.png`);
    await page.screenshot({ path: longCapture, animations: 'disabled', caret: 'hide' });
    await testInfo.attach('registry-context-long', { path: longCapture, contentType: 'image/png' });
    expect(await section.locator('.skill-catalog-row input[type="checkbox"]').evaluateAll(inputs =>
      inputs.map(input => ({ name: input.getAttribute('aria-label'), checked: (input as HTMLInputElement).checked })))).toEqual(enabled);
    expect(api.requests.filter(request => request.path === '/api/skills/content')).toEqual([]);
    expect(api.requests.filter(request => request.method !== 'GET'
      && !['/api/workspaces/validate', '/api/mcp/oauth/status'].includes(request.path))).toEqual([]);
  });

  for (const width of [1280, 390]) test(`Registry detail preserves requested install scope and complete updates: ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const registryFixture = registryFixtures();
    registryFixture.entries = [...registryFixture.entries.map(entry => ({ ...entry,
      installed: { scope: 'project' as const, version: '1.0.0', updateAvailable: true } })),
      { ...registryFixtures().entries[0]!, id: 'fixture-registry-global', name: 'fixture-registry-global' }];
    const api = await installMockApi(page, { skillRegistry: registryFixture });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/skills/registry/install', async route => {
      if (route.request().method() === 'POST' && route.request().postDataJSON().scope === 'project') await held;
      await route.fallback();
    });
    await page.goto('/settings#skills');
    await selectRegistryEntry(page, 'fixture-registry-b');
    const registry = page.locator('.skill-registry'), detail = registry.locator('.skill-registry-context-detail');
    const navigation = registry.getByRole('navigation', { name: 'Browse Agent Skills registry', exact: true });
    try {
      const requested = page.waitForRequest(request => new URL(request.url()).pathname === '/api/skills/registry/install' && request.method() === 'POST');
      await detail.getByRole('button', { name: 'Update', exact: true }).click();
      expect((await requested).postDataJSON()).toEqual({ id: 'fixture-registry-b', scope: 'project', cwd: '/workspace', projectId: 'workspace-e2e' });
      for (const button of await registry.locator('nav button').all()) await expect(button).toBeDisabled();
      if (width < 960) {
        const back = registry.getByRole('button', { name: 'Back to Agent Skills registry', exact: true });
        await back.focus(); await back.press('Enter');
        await expect(navigation).toBeFocused(); await expect(navigation).toHaveCSS('outline-style', 'solid');
        await expectContrast(navigation, 'outlineColor', 3);
        const pendingCapture = testInfo.outputPath('registry-pending-back-390.png');
        await page.screenshot({ path: pendingCapture, animations: 'disabled', caret: 'hide' });
        await testInfo.attach('registry-pending-back', { path: pendingCapture, contentType: 'image/png' });
      }
    } finally { release(); }
    for (const button of await registry.locator('nav button').all()) await expect(button).toBeEnabled();
    if (width < 960) { await expect(navigation).toBeVisible(); await expect(detail.getByRole('article')).toHaveCount(0); }
    const updateAll = registry.getByRole('button', { name: 'Update all', exact: true });
    // Selected B is current; A still needs its update. This remains all:true, not selected-only.
    await expect(updateAll).toBeEnabled();
    const updated = page.waitForResponse(response => new URL(response.url()).pathname === '/api/skills/registry/update' && response.request().method() === 'POST');
    await updateAll.click();
    expect((await updated).request().postDataJSON()).toEqual({ all: true, scope: 'project', cwd: '/workspace', projectId: 'workspace-e2e' });
    await registry.getByRole('combobox').selectOption('global');
    await selectRegistryEntry(page, 'fixture-registry-global');
    const installed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/skills/registry/install' && response.request().method() === 'POST');
    await detail.getByRole('button', { name: 'Install', exact: true }).click();
    expect((await installed).request().postDataJSON()).toEqual({ id: 'fixture-registry-global', scope: 'global', cwd: '/workspace', projectId: 'workspace-e2e' });
    expect(api.requests.filter(request => request.path === '/api/skills/content')).toEqual([]);
    expect(api.requests.filter(request => request.path.startsWith('/api/skills/registry/') && request.method !== 'GET')
      .map(request => ({ path: request.path, body: request.body }))).toEqual([
      { path: '/api/skills/registry/install', body: { id: 'fixture-registry-b', scope: 'project', cwd: '/workspace', projectId: 'workspace-e2e' } },
      { path: '/api/skills/registry/update', body: { all: true, scope: 'project', cwd: '/workspace', projectId: 'workspace-e2e' } },
      { path: '/api/skills/registry/install', body: { id: 'fixture-registry-global', scope: 'global', cwd: '/workspace', projectId: 'workspace-e2e' } },
    ]);
  });

  for (const width of [1280, 390]) test(`Custom model browsing never retargets a shared editor: ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const api = await installMockApi(page, { customModels: customModelFixtures() });
    await page.goto('/settings#custom-models');
    await selectCustomModel(page, 'openai:first');
    const section = page.locator('#custom-models'), detail = section.locator('.custom-model-context-detail');
    await detail.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = section.locator('.custom-resource-editor');
    await editor.locator('summary').focus(); await editor.locator('summary').click();
    await expect(editor.getByLabel('Provider', { exact: true })).toHaveValue('openai');
    await expect(editor.getByLabel('ID', { exact: true })).toHaveValue('first');
    await editor.getByLabel('Name', { exact: true }).fill('SYNTHETIC_EDITOR_OWNER');
    await selectCustomModel(page, 'azure:shared');
    await expect(detail.getByRole('article')).toHaveAttribute('data-settings-selection', 'azure:shared');
    await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('SYNTHETIC_EDITOR_OWNER');
    expect(api.requests.filter(request => request.path.startsWith('/api/provider-registry/models') && request.method !== 'GET')).toEqual([]);
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => api.requests.filter(request => request.path.startsWith('/api/provider-registry/models') && request.method !== 'GET')
      .map(request => ({ method: request.method, path: request.path, body: request.body })))
      .toEqual([{ method: 'PUT', path: '/api/provider-registry/models/openai%3Afirst', body: {
        provider: 'openai', id: 'first', name: 'SYNTHETIC_EDITOR_OWNER',
        capabilities: { reasoning: true, imageInput: false, toolCalls: true }, contextWindow: 64000, maxOutputTokens: 4096,
        pricing: {}, compatibility: {},
      } }]);
    await expect(editor.getByLabel('ID', { exact: true })).toHaveValue('');
    await expect(detail.getByRole('article')).toHaveAttribute('data-settings-selection', 'azure:shared');
  });

  for (const scenario of [
    { width: 1280, locale: 'en', theme: 'light' },
    { width: 1280, locale: 'fr', theme: 'dark' },
    { width: 390, locale: 'en', theme: 'light' },
    { width: 390, locale: 'fr', theme: 'dark' },
  ] as const) test(`Custom model metadata never edits or selects the active model: ${scenario.width}px ${scenario.locale}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: scenario.width, height: 844 });
    await page.addInitScript(({ locale, theme }) => {
      localStorage.setItem('ai-harness-locale', locale);
      localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme }));
    }, scenario);
    const customModels = customModelFixtures();
    const api = await installMockApi(page, { customModels });
    await page.goto('/settings#custom-models');
    const section = page.locator('#custom-models');
    const activeModel = page.locator('#model > select');
    await expect(activeModel).not.toHaveValue('');
    const before = await activeModel.inputValue();
    const navigation = section.getByRole('navigation', { name: /^(Custom models|Modèles personnalisés)$/u });
    await expect(navigation).toBeVisible();
    const choice = navigation.getByRole('button').filter({ has: page.getByText('openai:shared', { exact: true }).and(page.locator('code')) });
    await choice.focus(); await choice.press('Enter');
    const detail = section.locator('.custom-model-context-detail');
    await expect(detail.getByRole('article')).toHaveCount(1);
    await expect(detail.getByRole('article')).toHaveAttribute('data-settings-selection', 'openai:shared');
    await expect(detail).toContainText('64000 context · 4096 max output');
    await expect(activeModel).toHaveValue(before);
    const current = section.locator('nav button').filter({ has: page.getByText('openai:shared', { exact: true }).and(page.locator('code')) });
    await expect(current).toHaveAttribute('aria-current', 'true'); await expect(current).toHaveAttribute('aria-expanded', 'true');
    await expect(current).toHaveCSS('border-left-width', '3px');
    const back = section.getByRole('button', { name: /^(Back to custom models|Retour aux modèles personnalisés)$/u });
    if (scenario.width < 960) {
      await expect(back).toBeFocused(); await back.press('Enter');
      for (const control of [choice, back]) {
        await expect(control).toBeFocused(); await expect(control).toHaveCSS('outline-style', 'solid');
        await expectContrast(control, 'outlineColor', 3);
        expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        const clearance = await control.evaluate(element => {
          const style = getComputedStyle(element), box = element.getBoundingClientRect();
          const extent = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
          return Math.min(...[element.closest('nav') ?? element.closest('.custom-model-context-detail')!, element.closest('.settings-view')!]
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
    expect((await new AxeBuilder({ page }).include('#custom-models').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
    expect(await page.locator('.settings-view').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const capture = testInfo.outputPath(`custom-model-context-${scenario.width}-${scenario.locale}.png`);
    await page.screenshot({ path: capture, animations: 'disabled', caret: 'hide' });
    await testInfo.attach('custom-model-context', { path: capture, contentType: 'image/png' });
    const editor = section.locator('.custom-resource-editor');
    await editor.locator('summary').focus(); await editor.locator('summary').click();
    const toggles = editor.getByRole('checkbox'); await expect(toggles).toHaveCount(3);
    const formCapture = testInfo.outputPath(`custom-model-form-${scenario.width}-${scenario.locale}.png`);
    await page.screenshot({ path: formCapture, animations: 'disabled', caret: 'hide' });
    await testInfo.attach('custom-model-form', { path: formCapture, contentType: 'image/png' });
    for (const toggle of await toggles.all()) {
      await toggle.scrollIntoViewIfNeeded();
      const layout = await toggle.evaluate(input => {
        const label = input.closest('label')!, box = input.getBoundingClientRect(), target = label.getBoundingClientRect();
        const text = [...label.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())!;
        const range = document.createRange(); range.selectNodeContents(text); const caption = range.getBoundingClientRect();
        return { gap: caption.left - box.right, centerDelta: Math.abs((caption.top + caption.bottom - box.top - box.bottom) / 2), targetHeight: target.height };
      });
      expect(layout.gap).toBeGreaterThanOrEqual(4); expect(layout.centerDelta).toBeLessThanOrEqual(2);
      expect(layout.targetHeight).toBeGreaterThanOrEqual(44);
      const checked = await toggle.isChecked(); await toggle.locator('..').click();
      await expect(toggle).toBeChecked({ checked: !checked }); await expect(toggle).toBeFocused();
      await toggle.press('Space'); await expect(toggle).toBeChecked({ checked });
      await expect(toggle).toHaveCSS('outline-style', 'solid'); await expectContrast(toggle, 'outlineColor', 3);
    }
    const draft = editor.getByLabel('ID', { exact: true });
    await draft.fill('SYNTHETIC_CUSTOM_MODEL_DRAFT');
    await selectGeneralSettings(page, 'appearance'); await selectModelSettings(page, 'custom-models');
    await expect(detail.getByRole('article')).toHaveAttribute('data-settings-selection', 'openai:shared');
    await expect(draft).toHaveValue('SYNTHETIC_CUSTOM_MODEL_DRAFT');
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(storage).not.toContain('SYNTHETIC_CUSTOM_MODEL_DRAFT');
    const memory = JSON.parse(await page.evaluate(() => localStorage.getItem('ai-harness-settings-navigation-v1')!));
    expect(memory.entries.find((entry: { cwd: string }) => entry.cwd === '/workspace').positions['custom-models'])
      .toEqual({ selection: 'openai:shared' });
    await reloadSettingsDiscardingDrafts(page);
    await expect(detail.getByRole('article')).toHaveAttribute('data-settings-selection', 'openai:shared');
    await expect(activeModel).toHaveValue(before);
    const longName = 'fixture_custom_model_metadata_with_an_explicit_long_name_and_unchanged_editor_and_enablement_authority';
    const fresh = [...customModels.filter(model => model.key !== 'openai:shared'),
      { ...customModels[0]!, key: 'openai:long-fixture', id: longName, name: longName }];
    await page.route('**/api/provider-registry/models', route => route.fulfill({ json: fresh }));
    await page.reload();
    await expect(navigation).toBeVisible(); await expect(detail.getByRole('article')).toHaveCount(0);
    await expect(section.getByRole('status')).toContainText(/selected custom model is unavailable|modèle personnalisé sélectionné n’est pas disponible/u);
    await navigation.getByRole('button').filter({ has: page.getByText('azure:shared', { exact: true }).and(page.locator('code')) }).click();
    await expect(detail.getByRole('article')).toHaveAttribute('data-settings-selection', 'azure:shared');
    if (scenario.width < 960) await back.click();
    await navigation.getByRole('button').filter({ has: page.getByText('openai:long-fixture', { exact: true }).and(page.locator('code')) }).click();
    await expect(detail.getByRole('article')).toHaveAttribute('data-settings-selection', 'openai:long-fixture');
    await expect(detail.getByRole('article').locator('strong')).toHaveText(longName);
    await expect(activeModel).toHaveValue(before);
    expect(await page.locator('.settings-view').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const longCapture = testInfo.outputPath(`custom-model-context-long-${scenario.width}-${scenario.locale}.png`);
    await page.screenshot({ path: longCapture, animations: 'disabled', caret: 'hide' });
    await testInfo.attach('custom-model-context-long', { path: longCapture, contentType: 'image/png' });
    expect(api.requests.filter(request => request.method !== 'GET'
      && !['/api/workspaces/validate', '/api/mcp/oauth/status'].includes(request.path))).toEqual([]);
  });

  for (const scenario of [
    { width: 1280, locale: 'en', theme: 'light' },
    { width: 1280, locale: 'fr', theme: 'dark' },
    { width: 390, locale: 'en', theme: 'light' },
    { width: 390, locale: 'fr', theme: 'dark' },
  ] as const) test(`Installed skill metadata selection never reads instructions: ${scenario.width}px ${scenario.locale}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: scenario.width, height: 844 });
    await page.addInitScript(({ locale, theme }) => {
      localStorage.setItem('ai-harness-locale', locale);
      localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme }));
    }, scenario);
    const api = await installMockApi(page);
    const loaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/skills');
    await page.goto('/settings#skills');
    const catalog = await (await loaded).json() as SkillCatalog;
    const section = page.locator('#skills');
    const navigation = section.getByRole('navigation', { name: /^(Skills|Compétences)$/u });
    await expect(navigation).toBeVisible();
    const choice = navigation.getByRole('button', { name: 'release-notes', exact: true });
    await choice.focus(); await choice.press('Enter');
    const detail = page.locator('.skill-context-detail');
    await expect(detail.getByRole('checkbox')).toHaveCount(1);
    await expect(detail.getByRole('checkbox')).toHaveAccessibleName(/release-notes/u);
    await expect(detail.getByRole('button', { name: /^(Read instructions for|Lire les instructions de) release-notes$/u })).toBeVisible();
    await expect(section.locator('#skill-content-detail')).toHaveCount(0);
    const current = section.getByRole('button', { name: 'release-notes', exact: true, includeHidden: true });
    await expect(current).toHaveAttribute('aria-current', 'true');
    await expect(current).toHaveAttribute('aria-expanded', 'true');
    await expect(current).toHaveCSS('border-left-width', '3px');
    if (scenario.width < 960) {
      const back = section.getByRole('button', { name: /^(Back to skills|Retour aux compétences)$/u });
      await expect(back).toBeFocused(); await back.press('Enter');
      for (const control of [choice, back]) {
        await expect(control).toBeFocused();
        await expect(control).toHaveCSS('outline-style', 'solid');
        await expectContrast(control, 'outlineColor', 3);
        expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        const clearance = await control.evaluate(element => {
          const style = getComputedStyle(element), bounds = element.getBoundingClientRect();
          const extent = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
          return Math.min(...[element.closest('nav') ?? element.closest('.skill-context-detail')!, element.closest('.settings-view')!]
            .flatMap(owner => {
              const clip = owner.getBoundingClientRect();
              return [bounds.left - clip.left, clip.right - bounds.right, bounds.top - clip.top, clip.bottom - bounds.bottom];
            })) - extent;
        });
        expect(clearance).toBeGreaterThanOrEqual(-0.1);
        if (control === choice) await choice.press('Enter');
      }
    } else {
      const list = (await navigation.boundingBox())!, content = (await detail.boundingBox())!;
      expect(list.x + list.width).toBeLessThanOrEqual(content.x);
    }
    await selectGeneralSettings(page, 'appearance');
    await selectSettingsCategory(page, 'skills');
    await expect(detail.getByRole('checkbox')).toHaveAccessibleName(/release-notes/u);
    await page.reload();
    await expect(detail.getByRole('checkbox')).toHaveAccessibleName(/release-notes/u);
    await expect(section.locator('#skill-content-detail')).toHaveCount(0);
    const stored = JSON.parse(await page.evaluate(() => localStorage.getItem('ai-harness-settings-navigation-v1')!));
    expect(stored.entries.find((entry: { cwd: string }) => entry.cwd === '/workspace').positions.skills)
      .toEqual({ group: JSON.stringify(['global', '']), selection: 'global:release-notes:e2e' });
    expect((await new AxeBuilder({ page }).include('#skills').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
    expect(await page.locator('.settings-view').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const capture = testInfo.outputPath(`skills-context-${scenario.width}-${scenario.locale}.png`);
    await page.screenshot({ path: capture, animations: 'disabled', caret: 'hide' });
    await testInfo.attach('skills-context', { path: capture, contentType: 'image/png' });
    const filter = section.getByRole('searchbox');
    await filter.fill('documentation');
    await expect(section.getByRole('status').filter({ hasText: /selected skill is unavailable|compétence sélectionnée/u })).toBeVisible();
    await expect(detail.getByRole('checkbox')).toHaveCount(0);
    await expect(filter).toBeFocused();
    await filter.fill('');
    await expect(detail.getByRole('checkbox')).toHaveAccessibleName(/release-notes/u);
    if (scenario.width > 959) {
      await page.setViewportSize({ width: 390, height: 844 }); await expect(filter).toBeFocused();
      await page.setViewportSize({ width: scenario.width, height: 844 }); await expect(filter).toBeFocused();
    }
    expect(api.requests.filter(request => request.path === '/api/skills/content')).toEqual([]);
    expect(api.requests.filter(request => request.method !== 'GET'
      && !['/api/workspaces/validate', '/api/mcp/oauth/status'].includes(request.path))).toEqual([]);
    let releaseWrite!: () => void;
    const heldWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
    await page.route('**/api/skills/enabled/batch', async route => { await heldWrite; await route.fallback(); });
    try {
      await detail.getByRole('checkbox').focus(); await page.keyboard.press('Space');
      await expect(current).toBeDisabled();
      if (scenario.width < 960) {
        const pendingBack = section.getByRole('button', { name: /^(Back to skills|Retour aux compétences)$/u });
        await pendingBack.focus(); await pendingBack.press('Enter');
        await expect(navigation).toBeFocused();
        await expect(navigation).toHaveCSS('outline-style', 'solid');
        const pendingCapture = testInfo.outputPath(`skills-pending-${scenario.width}-${scenario.locale}.png`);
        await page.screenshot({ path: pendingCapture, animations: 'disabled', caret: 'hide' });
        await testInfo.attach('skills-pending-focus', { path: pendingCapture, contentType: 'image/png' });
      }
    } finally { releaseWrite(); }
    await expect(current).toBeEnabled();
    await selectInstalledSkill(page, 'release-notes');
    await expect(detail.getByRole('checkbox')).not.toBeChecked();
    expect(api.requests.filter(request => request.path === '/api/skills/enabled/batch').map(request => request.body))
      .toEqual([{ cwd: '/workspace', projectId: 'workspace-e2e', changes: [{ key: 'global:release-notes:e2e', enabled: false }] }]);
    const release = catalog.skills.find(skill => skill.key === 'global:release-notes:e2e')!;
    const longName = 'fixture_review_workspace_metadata_with_an_explicit_long_skill_name_and_preserved_authorization';
    await page.route('**/api/skills?*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      ...catalog, skills: [
        ...catalog.skills.filter(skill => skill.key !== release.key),
        { ...release, key: 'project:release-notes:e2e', scope: 'project', source: '.agents/skills', filePath: '.agents/skills/release-notes/SKILL.md' },
        { ...release, key: 'package:long-skill:e2e', name: longName, scope: 'package', source: 'fixture:package-skills',
          filePath: `packages/fixture/skills/${longName}/SKILL.md` },
      ],
    }) }));
    await page.reload();
    await expect(navigation).toBeVisible();
    await expect(section.getByRole('status').filter({ hasText: /selected skill is unavailable|compétence sélectionnée/u })).toBeVisible();
    await expect(detail.getByRole('checkbox')).toHaveCount(0);
    await expect(navigation.locator('[aria-current="true"]')).toHaveCount(0);
    await navigation.locator('[data-scope="project"]').getByRole('button', { name: 'release-notes', exact: true }).click();
    await expect(detail.locator('fieldset:visible')).toHaveAttribute('data-scope', 'project');
    await selectInstalledSkill(page, longName);
    await expect(detail.getByRole('heading', { name: longName, exact: true })).toBeVisible();
    await expect(detail.getByRole('button', { name: new RegExp(longName, 'u') })).toBeVisible();
    expect(await page.locator('.settings-view').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const longCapture = testInfo.outputPath(`skills-long-name-${scenario.width}-${scenario.locale}.png`);
    await page.screenshot({ path: longCapture, animations: 'disabled', caret: 'hide' });
    await testInfo.attach('skills-long-name', { path: longCapture, contentType: 'image/png' });
    await expect(section.locator('#skill-content-detail')).toHaveCount(0);
    expect(api.requests.filter(request => request.path === '/api/skills/content')).toEqual([]);
    expect(api.requests.filter(request => request.method !== 'GET'
      && !['/api/workspaces/validate', '/api/mcp/oauth/status', '/api/skills/enabled/batch'].includes(request.path))).toEqual([]);
  });

  test('liste les skills par portée et persiste l’invocation autonome par workspace', async ({ page }) => {
    const api = await installMockApi(page);
    await page.goto('/settings#skills');
    const section = settingsSection(page, 'Skills');

    const navigation = section.getByRole('navigation', { name: 'Skills', exact: true });
    for (const [scope, name] of [['project', 'review-project'], ['global', 'release-notes'], ['path', 'documentation'], ['package', 'test-plan']]) {
      await expect(navigation.locator(`[data-scope="${scope}"]`).getByRole('button', { name, exact: true })).toBeVisible();
    }
    await selectInstalledSkill(page, 'release-notes');
    await expect(section.locator('fieldset[data-scope="global"]')).toContainText('~/.ai-harness/skills/release-notes/SKILL.md');

    await section.getByLabel('Filter skills or sources').fill('release');
    await expect(section.locator('.skill-catalog-row')).toHaveCount(1);
    await section.getByLabel('Filter skills or sources').fill('');

    const release = section.getByRole('checkbox', { name: 'Allow release-notes for autonomous model invocation' });
    await release.click();
    await expect(release).not.toBeChecked();
    await expect.poll(() => api.requests.filter(request => request.path === '/api/skills/enabled/batch').at(-1)?.body)
      .toEqual({ cwd: '/workspace', projectId: 'workspace-e2e', changes: [{ key: 'global:release-notes:e2e', enabled: false }] });

    await selectInstalledSkill(page, 'documentation');
    const documentation = section.getByRole('checkbox', { name: 'Allow documentation for autonomous model invocation' });
    await documentation.click();
    await expect(documentation).toBeChecked();
    await expect.poll(() => api.requests.filter(request => request.path === '/api/skills/enabled/batch').at(-1)?.body)
      .toEqual({ cwd: '/workspace', projectId: 'workspace-e2e', changes: [{ key: 'path:documentation:e2e', enabled: true }] });
    await page.reload();
    await expect(documentation).toBeChecked();
    await selectInstalledSkill(page, 'release-notes');
    await expect(section.getByRole('checkbox', { name: 'Allow release-notes for autonomous model invocation' })).not.toBeChecked();
  });

  test('verrouille les skills projet tant que le workspace n’est pas approuvé', async ({ page }) => {
    await installMockApi(page, { workspaceTrusted: false });
    await page.goto('/settings#skills');
    const section = settingsSection(page, 'Skills');
    await expect(section.getByText('Project skills are locked until this workspace is trusted.')).toBeVisible();
    await expect(section.getByRole('checkbox', { name: 'Allow review-project for autonomous model invocation' })).toBeDisabled();
    await expect(section.locator('fieldset[data-scope="project"]')).toContainText('untrusted');
    await selectInstalledSkill(page, 'release-notes');
    await expect(section.getByRole('checkbox', { name: 'Allow release-notes for autonomous model invocation' })).toBeEnabled();
  });

  test('présente un inventaire MCP expurgé et garde le fichier projet fermé avant confiance', async ({ page }) => {
    const api = await installMockApi(page, {
      workspaceTrusted: false,
      mcpConfig: {
        files: [
          { scope: 'global', path: '/agent/mcp.json', exists: true, contentRead: true, problems: [] },
          {
            scope: 'project', path: '/workspace/.ai-harness/mcp.json', exists: true, contentRead: false,
            problems: [{ reason: 'trust-required', message: 'Project trust required.' }],
          },
        ],
        project: {
          cwd: '/workspace', contentTrusted: false, requiresTrust: true, decision: null,
          inherited: false, trustError: false,
        },
        servers: [{
          name: 'documentation', scope: 'global', sourcePath: '/agent/mcp.json', valid: true,
          enabled: true, exposure: 'deferred', transport: 'http', url: 'https://docs.example.test/•••?•••',
          envNames: [], headerNames: ['Authorization'], commandFields: [],
          variableReferences: [{ field: 'headers.X-Token', names: ['DOCS_TOKEN'] }], masked: true,
          shadowedByProject: false, replacesGlobal: false, problems: [],
        }],
      },
    });
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');

    await expect(section.getByRole('heading', { name: 'MCP servers' })).toBeVisible();
    await expect(section).toContainText('documentation');
    await expect(section).toContainText('https://docs.example.test/•••?•••');
    await expect(section).toContainText('Header names: Authorization');
    await expect(section).toContainText('headers.X-Token reads host variables: DOCS_TOKEN');
    await expect(section).toContainText('Project server names and values are not read before trust.');
    await section.getByText('Configuration file diagnostics').click();
    await expect(section).toContainText('Project trust is required before reading this file.');
    await section.getByRole('button', { name: 'Refresh' }).click();
    await expect.poll(() => api.requests.filter(request => request.path === '/api/mcp').length).toBeGreaterThanOrEqual(2);
  });

  test('présente tous les états de ligne MCP sans les confondre avec une connexion', async ({ page }) => {
    await installMockApi(page, { mcpConfig: mcpStateInventory() });
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');

    await expect(section.getByRole('article', { name: 'remote-docs: Configured', exact: true })).toBeVisible();
    await selectMcpServer(page, 'global', 'local-tools');
    await expect(section.getByRole('article', { name: 'local-tools: Disabled', exact: true })).toBeVisible();
    await selectMcpServer(page, 'global', 'shared');
    await expect(section.getByRole('article', { name: 'shared: Replaced by project', exact: true })).toBeVisible();
    await selectMcpServer(page, 'global', 'bad\\u202ename');
    await expect(section.getByRole('article', { name: 'bad\\u202ename: Invalid', exact: true })).toBeVisible();
    await selectMcpServer(page, 'project', 'shared');
    const projectReplacement = section.getByRole('article', { name: 'shared: Configured', exact: true });
    await expect(projectReplacement).toContainText('Project configuration');
    await expect(projectReplacement).toContainText('replaces the global entry');
    await expect(section.getByText('Connected', { exact: true })).toHaveCount(0);
    await expect(section).toContainText('Command-backed fields: headers.X-Command');
    await expect(section).toContainText('env.CACHE_DIR reads host variables: CACHE_DIR');
    await section.getByRole('button', { name: 'Show details for Global configuration / bad\\u202ename', exact: true }).click();
    await expect(section.getByRole('region', { name: 'Server details: Global configuration / bad\\u202ename', exact: true }))
      .toContainText('The URL must be a bounded HTTP or HTTPS URL.');
    await section.getByText('Configuration file diagnostics').click();
    await expect(section).toContainText(MCP_FILE_PROBLEM_MESSAGES['invalid-shape']);
  });

  test('affiche l’état de connexion MCP persistant sans le confondre avec la configuration', async ({ page }) => {
    const inventory = mcpStateInventory();
    inventory.servers[0] = {
      ...inventory.servers[0]!,
      runtimeStatus: {
        state: 'connected',
        sessionId: 'session-runtime',
        updatedAt: '2026-10-08T12:00:00.000Z',
        toolCount: 2,
      },
    };
    await installMockApi(page, { mcpConfig: inventory });
    await page.goto('/settings#mcp');

    const card = page.locator('#mcp').getByRole('article', { name: 'remote-docs: Configured', exact: true });
    await expect(card).toContainText('Connected · 2 tools');
  });

  for (const scenario of [
    { name: 'desktop-dark', width: 1440, theme: 'dark' },
    { name: 'desktop-light', width: 1440, theme: 'light' },
    { name: 'mobile-dark', width: 390, theme: 'dark' },
    { name: 'mobile-light', width: 390, theme: 'light' },
  ] as const) {
  test(`${scenario.name} connecte, colle le callback, déconnecte et annule un flux OAuth MCP sans exposer les jetons`, async ({ page }) => {
    await page.setViewportSize({ width: scenario.width, height: 900 });
    await page.addInitScript(({ theme }) => {
      localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({
        version: 4, theme, sendMode: 'enter', contentWidth: 1000, fontSize: 16,
        reasoningOpen: false, sound: false, notifications: false, selectionActions: true,
        filesOpen: true, sidebarVisible: true, lastSettingsSection: 'mcp', keybindings: {},
      }));
    }, { theme: scenario.theme });
    const inventory = mcpStateInventory();
    inventory.servers[0] = {
      ...inventory.servers[0]!, usesOAuth: true, headerNames: ['X-Workspace', 'X-Command', 'X-Token'],
    };
    const api = await installMockApi(page, { mcpConfig: inventory });
    const oauthRequests: Array<{ method: string; path: string; body?: unknown }> = [];
    let signedIn = false;
    let phase: 'authorize' | 'connected' | 'cancelled' = 'authorize';
    const flowId = '00000000-0000-4000-8000-000000000123';
    const flow = () => ({
      flowId,
      scope: 'global',
      name: 'remote-docs',
      configKey: inventory.servers[0]!.configKey!,
      phase,
      authorizationUrl: phase === 'authorize'
        ? 'https://login.example.test/authorize?state=browser-state'
        : undefined,
      redirectUrl: 'http://127.0.0.1:32123/oauth/callback',
      expiresAt: '2026-01-01T00:05:00.000Z',
    });
    await page.route('**/api/mcp/oauth/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const body = request.postData() ? request.postDataJSON() : undefined;
      oauthRequests.push({ method: request.method(), path: url.pathname, ...(body === undefined ? {} : { body }) });
      if (url.pathname === '/api/mcp/oauth/status') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          statuses: [{
            scope: 'global', name: 'remote-docs', configKey: inventory.servers[0]!.configKey!,
            available: true, stateStored: signedIn, signedIn,
          }],
        }) });
        return;
      }
      if (url.pathname === '/api/mcp/oauth/start') {
        phase = 'authorize';
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(flow()) });
        return;
      }
      if (url.pathname.endsWith('/redirect')) {
        phase = 'connected';
        signedIn = true;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(flow()) });
        return;
      }
      if (url.pathname === `/api/mcp/oauth/flows/${flowId}` && request.method() === 'DELETE') {
        phase = 'cancelled';
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(flow()) });
        return;
      }
      if (url.pathname === `/api/mcp/oauth/flows/${flowId}`) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(flow()) });
        return;
      }
      if (url.pathname === '/api/mcp/oauth/logout') {
        signedIn = false;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          scope: 'global', name: 'remote-docs', configKey: inventory.servers[0]!.configKey!, removed: true,
        }) });
        return;
      }
      await route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' });
    });

    await page.goto('/settings#mcp');
    await selectMcpServer(page, 'global', 'remote-docs');
    const card = page.locator('#mcp').getByRole('article', { name: 'remote-docs: Configured', exact: true });
    await expect(card).toContainText('Not signed in');
    await card.getByRole('button', { name: 'Sign in', exact: true }).click();
    const authorization = card.getByRole('link', { name: 'Open the authorization page', exact: true });
    await expect(authorization).toHaveAttribute('href', 'https://login.example.test/authorize?state=browser-state');
    const callback = 'http://127.0.0.1:32123/oauth/callback?code=public-code&state=browser-state';
    const callbackField = card.getByLabel('Full redirected address');
    await callbackField.fill(callback);
    await selectMcpServer(page, 'global', 'local-tools');
    await selectMcpServer(page, 'global', 'remote-docs');
    await expect(callbackField).toHaveValue(callback);
    expect(oauthRequests.filter(request => request.path.endsWith('/redirect'))).toEqual([]);
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('public-code');
    await callbackField.fill('');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
    const accessibility = await new AxeBuilder({ page }).include('.mcp-oauth-panel')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(accessibility.violations).toEqual([]);
    await expect(card).toHaveScreenshot(`mcp-oauth-authorize-${scenario.name}.png`, {
      animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
    });
    await callbackField.fill(callback);
    await card.getByRole('button', { name: 'Use redirected address', exact: true }).click();
    await expect(card).toContainText('OAuth sign-in completed.');
    await expect(card).toContainText('Signed in');
    expect((await new AxeBuilder({ page }).include('.mcp-oauth-panel')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
    await expect(card).toHaveScreenshot(`mcp-oauth-connected-${scenario.name}.png`, {
      animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
    });
    await card.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(card).toContainText('Not signed in');

    await card.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(card.getByRole('button', { name: 'Cancel sign-in', exact: true })).toBeVisible();
    await card.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
    await expect(card).toContainText('OAuth sign-in was cancelled.');

    const posted = oauthRequests.filter(item => item.body !== undefined).map(item => item.body);
    expect(oauthRequests.find(item => item.path === '/api/mcp/oauth/start')?.body).toEqual({
      scope: 'global', name: 'remote-docs', configKey: inventory.servers[0]!.configKey!, cwd: '/workspace',
    });
    expect(posted.some(body => JSON.stringify(body).includes('docs.example.test'))).toBe(false);
    expect(JSON.stringify(posted)).not.toContain('access_token');
    expect(await page.locator('body').innerText()).not.toContain('route-access-secret');
    expect(api.requests.filter(item => item.path === '/api/mcp')).not.toHaveLength(0);
  });
  }

  test('teste une entrée MCP sans envoyer sa configuration et détaille capacités, cwd et outils', async ({ page }) => {
    const api = await installMockApi(page, { mcpConfig: mcpStateInventory() });
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');
    const card = section.getByRole('article', { name: 'remote-docs: Configured', exact: true });

    await card.getByRole('button', { name: 'Test remote-docs', exact: true }).click();
    const report = card.getByRole('region', { name: 'Last connection test for remote-docs' });
    await expect(report).toContainText('Connected');
    await expect(report).toContainText('Server: docs-fixture 1.2.3');
    await expect(report).toContainText('Working directory:');
    await expect(report).toContainText('/workspace');
    await expect(report).toContainText('2 tools · 3 resources · 1 templates · 2 prompts');
    await expect(report).toContainText('search_docs');
    await expect(report).toContainText('Search documentation');
    await expect(report).toContainText('read-only hint · deferred tools');
    await expect(report).toContainText('publish_note');
    await expect(report).toContainText('may write · deferred tools');

    const request = api.requests.find(item => item.path === '/api/mcp/test');
    expect(request?.body).toEqual({ scope: 'global', name: 'remote-docs', cwd: '/workspace' });
    expect(Object.keys(request?.body as object)).not.toContain('configuration');
  });

  test('reparcourt le texte MCP côté serveur et affiche seulement un aperçu expurgé', async ({ page }) => {
    const api = await installMockApi(page, {
      mcpConfig: mcpStateInventory(),
      mcpImportPreview: mcpImportPreviewFixture(),
    });
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');
    await section.getByText('Paste and preview a server').click();
    const paste = '{"mcpServers":{"docs-import":{"url":"https://docs.example.test/private?token=SOURCE-SECRET","headers":{"Authorization":"Bearer ${DOCS_TOKEN}"}}}}';
    await section.getByLabel('MCP server text').fill(paste);
    await section.getByLabel('Treat resolved values as AiHarness syntax').check();
    await section.getByRole('button', { name: 'Preview', exact: true }).click();

    await expect(section.getByRole('heading', { name: 'Redacted import preview' })).toBeVisible();
    const preview = section.getByRole('article', { name: 'docs-import' });
    await expect(preview).toContainText('https://docs.example.test/•••?•••');
    await expect(preview).toContainText('Header names: Authorization, X-Tenant');
    await expect(preview).toContainText('headers.X-Tenant');
    await expect(preview).toContainText('DOCS_TOKEN');
    await expect(preview).toContainText('explicit confirmation required');
    await expect(preview).toContainText('Confirmation is required before sending available host values remotely');
    await expect(preview).toContainText('Confirmation is required before storing literal secrets globally');
    await expect(preview).toContainText('Project configuration');
    await expect(preview).toContainText('cannot contain literal secrets');
    // The textarea intentionally retains the user's own paste; the rendered
    // server response must not echo any literal from it.
    await expect(preview).not.toContainText('SOURCE-SECRET');

    const request = api.requests.find(item => item.path === '/api/mcp/preview');
    expect(request?.body).toEqual({ text: paste, syntax: 'aiharness', cwd: '/workspace' });
    expect(Object.keys(request?.body as object)).not.toContain('configuration');
    expect(api.requests.filter(item => item.path === '/api/mcp/actions')).toHaveLength(0);

    await section.getByLabel('MCP server text').fill('https://other.example.test');
    await expect(section.getByRole('heading', { name: 'Redacted import preview' })).toHaveCount(0);
  });

  test('complète, confirme et persiste un import MCP depuis le texte original', async ({ page }) => {
    const api = await installMockApi(page, {
      mcpConfig: mcpStateInventory(),
      mcpImportPreview: mcpImportPreviewFixture(),
    });
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');
    await section.getByText('Paste and preview a server').click();
    const paste = '{"mcpServers":{"docs-import":{"url":"https://docs.example.test/private?token=SOURCE-SECRET","headers":{"Authorization":"Bearer ${DOCS_TOKEN}"}}}}';
    await section.getByLabel('MCP server text').fill(paste);
    await section.getByLabel('Treat resolved values as AiHarness syntax').check();
    await section.getByRole('button', { name: 'Preview', exact: true }).click();
    const configure = section.getByRole('button', { name: 'Configure global import' });
    await configure.click();

    const dialog = page.getByRole('dialog', { name: 'Configure MCP import' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Server name')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(configure).toBeFocused();
    await configure.click();
    await expect(dialog.getByLabel('Server name')).toBeFocused();
    const tenant = dialog.getByRole('group', { name: 'headers.X-Tenant' });
    await tenant.getByLabel('Use a host-variable reference').check();
    await tenant.getByLabel('Host variable name').fill('TENANT_TOKEN');
    await dialog.getByLabel('I confirm storing the remaining literal secret values in global configuration.').check();
    await dialog.getByLabel(/I confirm that these host variables may be sent/u).check();
    await dialog.getByRole('button', { name: 'Save atomically' }).click();

    await expect(section).toContainText('The MCP server was imported.');
    await expect(section.getByRole('article', { name: 'docs-import: Configured', exact: true })).toBeVisible();
    await expect(section.getByRole('region', { name: 'Server details: Global configuration / docs-import', exact: true })).toBeVisible();
    await expect(section).not.toContainText('SOURCE-SECRET');
    const request = api.requests.find(item => item.path === '/api/mcp/actions'
      && (item.body as { action?: string } | undefined)?.action === 'import');
    expect(request?.body).toEqual({
      action: 'import', scope: 'global', revision: expect.any(String), text: paste,
      syntax: 'aiharness', entryIndex: 0, name: 'docs-import',
      values: { 'headers.X-Tenant': { reference: 'TENANT_TOKEN' } },
      secretReferences: {},
      confirmations: {
        literalSecret: true,
        remoteHostVariables: ['DOCS_TOKEN', 'TENANT_TOKEN'],
      },
      cwd: '/workspace',
    });
    expect(Object.keys(request?.body as object)).not.toContain('configuration');
  });

  test('confirme confiance et première écriture MCP dans un dossier projet neuf', async ({ page }) => {
    const api = await installMockApi(page, {
      workspaceTrusted: true,
      workspaceOperationTrusted: false,
      mcpConfig: mcpFreshProjectInventory(),
      mcpImportPreview: mcpFreshProjectPreviewFixture(),
    });
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');
    await section.getByText('Paste and preview a server').click();
    const paste = 'npx -y fresh-mcp-tools';
    await section.getByLabel('MCP server text').fill(paste);
    await section.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(section).toContainText('Explicit confirmation is required to trust this fresh folder');
    await section.getByRole('button', { name: 'Configure project import' }).click();

    const dialog = page.getByRole('dialog', { name: 'Configure MCP import' });
    await expect(section.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    const trust = dialog.getByLabel(/I trust this fresh project folder/u);
    await expect(dialog.getByRole('button', { name: 'Save atomically' })).toBeDisabled();
    await trust.check();
    await expect(dialog.getByRole('button', { name: 'Save atomically' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Save atomically' }).click();

    await expect(dialog).toHaveCount(0);
    await expect(section.getByRole('article', { name: 'fresh-tools: Configured', exact: true })).toBeVisible();
    await expect(section.getByRole('region', { name: 'Server details: Project configuration / fresh-tools', exact: true })).toBeVisible();
    const request = api.requests.find(item => item.path === '/api/mcp/actions'
      && (item.body as { action?: string } | undefined)?.action === 'import');
    expect(request?.body).toMatchObject({
      action: 'import', scope: 'project', cwd: '/workspace', revision: null,
      trustProject: true, text: paste, entryIndex: 0,
    });
    expect(Object.keys(request?.body as object)).not.toContain('configuration');
    await expect.poll(() => api.requests.some(item => item.path === '/api/workspaces/validate')).toBe(true);
    expect(api.requests.some(item => item.path === '/api/workspaces/trust')).toBe(false);
  });

  test('recharge inventaire et confiance après un échec de transaction MCP projet', async ({ page }) => {
    const api = await installMockApi(page, {
      workspaceTrusted: true,
      workspaceOperationTrusted: false,
      mcpConfig: mcpFreshProjectInventory(),
      mcpImportPreview: mcpFreshProjectPreviewFixture(),
    });
    await page.route('**/api/mcp/actions', async route => {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Internal rollback detail must not render.',
          code: 'write-failed',
          uncertain: false,
          trustKept: true,
        }),
      });
    });
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');
    await section.getByText('Paste and preview a server').click();
    await section.getByLabel('MCP server text').fill('npx -y fresh-mcp-tools');
    await section.getByRole('button', { name: 'Preview', exact: true }).click();
    await section.getByRole('button', { name: 'Configure project import' }).click();
    const dialog = page.getByRole('dialog', { name: 'Configure MCP import' });
    await dialog.getByLabel(/I trust this fresh project folder/u).check();
    const readsBefore = api.requests.filter(request => request.path === '/api/mcp').length;
    await dialog.getByRole('button', { name: 'Save atomically' }).click();

    await expect(dialog).toHaveCount(0);
    await expect(section).toContainText('The MCP import failed. The canonical inventory was reloaded.');
    await expect(section).not.toContainText('Internal rollback detail must not render.');
    await expect(section.getByRole('article', { name: /fresh-tools: Configured/u })).toHaveCount(0);
    await expect.poll(() => api.requests.filter(request => request.path === '/api/mcp').length)
      .toBeGreaterThan(readsBefore);
    await expect.poll(() => api.requests.some(request => request.path === '/api/workspaces/validate'))
      .toBe(true);
  });

  test('remplace une entrée MCP depuis le texte original et restaure le focus après renommage', async ({ page }) => {
    const api = await installMockApi(page, {
      mcpConfig: mcpStateInventory(),
      mcpImportPreview: mcpImportPreviewFixture(),
    });
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');
    const edit = section.getByRole('button', { name: 'Edit remote-docs', exact: true });
    const prompt = page.getByRole('alertdialog', { name: 'Discard unsaved Settings edits?', exact: true });

    await edit.click();
    await expect(section.getByText('Replace remote-docs', { exact: true })).toBeVisible();
    await expect(section.getByLabel('Replacement MCP server text')).toBeFocused();
    await section.getByRole('button', { name: 'Cancel editing' }).click();
    await expect(edit).toBeFocused();

    const importPanel = section.locator('.mcp-import-panel');
    await importPanel.locator('summary').focus(); await importPanel.locator('summary').click();
    const importSource = section.getByLabel('MCP server text', { exact: true });
    await importSource.fill('SYNTHETIC_MCP_IMPORT_RETARGET_NOT_SAVED');
    await edit.click(); await expect(prompt).toBeVisible();
    await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(importSource).toHaveValue('SYNTHETIC_MCP_IMPORT_RETARGET_NOT_SAVED');
    await expect(section.getByLabel('Replacement MCP server text')).toHaveCount(0);
    await edit.click(); await expect(prompt).toBeVisible();
    await prompt.getByRole('button', { name: 'Discard edits', exact: true }).click();
    await expect(section.getByLabel('Replacement MCP server text')).toHaveValue('');
    await expect(section.getByLabel('Replacement MCP server text')).toBeFocused();
    await section.getByRole('button', { name: 'Cancel editing', exact: true }).click();
    await expect(prompt).toHaveCount(0); await expect(edit).toBeFocused();
    expect(api.requests.filter(item => item.method !== 'GET' && ['/api/mcp/preview', '/api/mcp/config'].includes(item.path))).toEqual([]);
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('SYNTHETIC_MCP_IMPORT_RETARGET_NOT_SAVED');

    await edit.click();
    const source = section.getByLabel('Replacement MCP server text');
    await source.fill('SYNTHETIC_MCP_CANCEL_SOURCE_NOT_SAVED');
    await section.getByRole('button', { name: 'Cancel editing', exact: true }).click();
    await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(source).toHaveValue('SYNTHETIC_MCP_CANCEL_SOURCE_NOT_SAVED');
    await section.getByRole('button', { name: 'Cancel editing', exact: true }).click();
    await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Discard edits', exact: true }).click();
    await expect(source).toHaveCount(0); await expect(edit).toBeFocused();
    expect(api.requests.filter(item => item.method !== 'GET' && ['/api/mcp/preview', '/api/mcp/config'].includes(item.path))).toEqual([]);
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('SYNTHETIC_MCP_CANCEL_SOURCE_NOT_SAVED');

    await edit.click();
    const paste = '{"mcpServers":{"docs-import":{"url":"https://docs.example.test/private?token=SOURCE-EDIT-SECRET","headers":{"Authorization":"Bearer ${DOCS_TOKEN}"}}}}';
    await section.getByLabel('Replacement MCP server text').fill(paste);
    await section.getByLabel('Treat resolved values as AiHarness syntax').check();
    await section.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(section.getByRole('heading', { name: 'Redacted replacement preview' })).toBeVisible();
    const configure = section.getByRole('button', { name: 'Configure replacement' });
    await configure.click();

    const dialog = page.getByRole('dialog', { name: 'Configure MCP replacement' });
    await expect(dialog.getByLabel('Server name')).toBeFocused();
    const name = dialog.getByLabel('Server name'), originalName = await name.inputValue();
    const tenant = dialog.getByRole('group', { name: 'headers.X-Tenant' }).getByLabel('Value');
    const literal = dialog.getByLabel('I confirm storing the remaining literal secret values in global configuration.');
    const remote = dialog.getByLabel(/I confirm that these host variables may be sent/u);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(prompt).toHaveCount(0); await expect(configure).toBeFocused();
    await configure.click(); await name.fill('Temporary completion name'); await name.fill(originalName);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(prompt).toHaveCount(0); await expect(configure).toBeFocused();
    await configure.click(); await tenant.fill('SYNTHETIC_MCP_COMPLETION_VALUE_ONLY');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await tenant.fill(''); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(prompt).toHaveCount(0); await expect(configure).toBeFocused();
    await configure.click();
    const reference = dialog.getByRole('group', { name: 'headers.X-Tenant' }).getByLabel('Use a host-variable reference');
    await reference.check(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await reference.uncheck(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(prompt).toHaveCount(0); await expect(configure).toBeFocused();
    await configure.click(); await name.fill('SYNTHETIC_MCP_COMPLETION_NAME'); await tenant.fill('SYNTHETIC_MCP_COMPLETION_VALUE');
    await literal.check(); await remote.check();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(name).toHaveValue('SYNTHETIC_MCP_COMPLETION_NAME'); await expect(tenant).toHaveValue('SYNTHETIC_MCP_COMPLETION_VALUE');
    await expect(literal).toBeChecked(); await expect(remote).toBeChecked();
    await name.press('Escape'); await expect(prompt).toBeVisible(); await page.keyboard.press('Escape');
    await expect(prompt).toHaveCount(0); await expect(dialog).toBeVisible(); await expect(name).toHaveValue('SYNTHETIC_MCP_COMPLETION_NAME');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Discard edits', exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(configure).toBeFocused();
    await expect(section.getByLabel('Replacement MCP server text')).toHaveValue(paste);
    expect(api.requests.filter(item => item.path === '/api/mcp/config' && item.method !== 'GET')).toEqual([]);
    await page.locator('.settings-dialog-header button').click(); await expect(prompt).toBeVisible();
    await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(section.getByLabel('Replacement MCP server text')).toHaveValue(paste);
    await configure.click(); await expect(name).toHaveValue(originalName); await expect(tenant).toHaveValue('');
    await expect(literal).not.toBeChecked(); await expect(remote).not.toBeChecked();
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('SYNTHETIC_MCP_COMPLETION_');
    await dialog.getByLabel('Server name').fill('remote-docs-v2');
    await dialog.getByRole('group', { name: 'headers.X-Tenant' }).getByLabel('Value').fill('tenant-value');
    await dialog.getByLabel('I confirm storing the remaining literal secret values in global configuration.').check();
    await dialog.getByLabel(/I confirm that these host variables may be sent/u).check();
    await dialog.getByRole('button', { name: 'Replace atomically' }).click();

    await expect(section).toContainText('MCP configuration updated.');
    await expect(section.getByRole('article', { name: 'remote-docs-v2: Configured', exact: true })).toBeVisible();
    await expect(section.getByRole('region', { name: 'Server details: Global configuration / remote-docs-v2', exact: true })).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ai-harness-mcp-selection-v1')!))).toEqual({
      version: 1, entries: [{ cwd: '/workspace', scope: 'global', name: 'remote-docs-v2' }],
    });
    await expect(section.getByRole('article', { name: /remote-docs:/u })).toHaveCount(0);
    await expect(section.getByRole('button', { name: 'Edit remote-docs-v2', exact: true })).toBeFocused();
    await expect(section).not.toContainText('SOURCE-EDIT-SECRET');

    const previewRequest = api.requests.find(item => item.path === '/api/mcp/preview'
      && Boolean((item.body as { replacement?: unknown } | undefined)?.replacement));
    expect(previewRequest?.body).toEqual({
      text: paste,
      syntax: 'aiharness',
      cwd: '/workspace',
      replacement: {
        scope: 'global', name: 'remote-docs', revision: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    const request = api.requests.find(item => item.path === '/api/mcp/actions'
      && (item.body as { action?: string } | undefined)?.action === 'replace');
    expect(request?.body).toEqual({
      action: 'replace', scope: 'global', revision: expect.stringMatching(/^[a-f0-9]{64}$/u),
      targetName: 'remote-docs', text: paste, syntax: 'aiharness', entryIndex: 0,
      name: 'remote-docs-v2', values: { 'headers.X-Tenant': 'tenant-value' },
      secretReferences: {},
      confirmations: { literalSecret: true, remoteHostVariables: ['DOCS_TOKEN'] },
      cwd: '/workspace',
    });
    expect(Object.keys(request?.body as object)).not.toContain('configuration');
  });

  test('invalide l’éditeur MCP et recharge après un résultat de remplacement incertain', async ({ page }) => {
    const api = await installMockApi(page, {
      mcpConfig: mcpStateInventory(),
      mcpImportPreview: mcpImportPreviewFixture(),
    });
    await page.route('**/api/mcp/actions', async route => {
      const body = route.request().postDataJSON() as { action?: string };
      if (body.action !== 'replace') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'uncertain', code: 'write-failed', uncertain: true }),
      });
    });
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');
    const edit = section.getByRole('button', { name: 'Edit remote-docs', exact: true });
    const readsBefore = api.requests.filter(request => request.path === '/api/mcp').length;

    await edit.click();
    await section.getByLabel('Replacement MCP server text').fill('npx replacement-server');
    await section.getByRole('button', { name: 'Preview', exact: true }).click();
    await section.getByRole('button', { name: 'Configure replacement' }).click();
    const dialog = page.getByRole('dialog', { name: 'Configure MCP replacement' });
    await expect(dialog.getByLabel('Server name')).toBeFocused();
    await dialog.getByRole('group', { name: 'headers.X-Tenant' }).getByLabel('Value').fill('tenant-value');
    await dialog.getByLabel('I confirm storing the remaining literal secret values in global configuration.').check();
    await dialog.getByLabel(/I confirm that these host variables may be sent/u).check();
    await dialog.getByRole('button', { name: 'Replace atomically' }).click();

    await expect(section).toContainText('The action result is uncertain and may have been committed. The inventory was reloaded.');
    await expect.poll(() => api.requests.filter(request => request.path === '/api/mcp').length)
      .toBeGreaterThan(readsBefore);
    await expect(section.getByText('Replace remote-docs', { exact: true })).toHaveCount(0);
    await expect(edit).toBeFocused();
    await expect(section.getByRole('article', { name: 'remote-docs: Configured', exact: true })).toBeVisible();
  });

  test('active et désactive les serveurs MCP par ligne ou groupe en une requête', async ({ page }) => {
    const api = await installMockApi(page, { mcpConfig: mcpStateInventory() });
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');
    const global = section.locator('fieldset[data-scope="global"]');

    await global.getByRole('button', { name: 'Disable all', exact: true }).click();
    await expect(section.getByRole('article', { name: 'remote-docs: Disabled', exact: true })).toBeVisible();
    await selectMcpServer(page, 'global', 'shared');
    await expect(section.getByRole('article', { name: 'shared: Replaced by project', exact: true })).toBeVisible();
    await expect(section).toContainText('MCP configuration updated.');
    const groupRequest = api.requests.find(request => request.path === '/api/mcp/actions');
    expect(groupRequest?.body).toMatchObject({
      action: 'set-enabled', scope: 'global', names: ['remote-docs', 'shared'], enabled: false,
    });

    await selectMcpServer(page, 'global', 'local-tools');
    await section.getByRole('button', { name: 'Enable local-tools', exact: true }).click();
    await expect(section.getByRole('article', { name: 'local-tools: Configured', exact: true })).toBeVisible();
    const mutationRequests = api.requests.filter(request => request.path === '/api/mcp/actions');
    expect(mutationRequests).toHaveLength(2);
    expect(mutationRequests[1]?.body).toMatchObject({
      action: 'set-enabled', scope: 'global', names: ['local-tools'], enabled: true,
    });
  });

  test('modifie l’exposition MCP atomiquement et restaure le focus du sélecteur', async ({ page }) => {
    const api = await installMockApi(page, { mcpConfig: mcpStateInventory() });
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');
    const card = section.getByRole('article', { name: 'remote-docs: Configured', exact: true });
    const exposure = card.getByRole('combobox', { name: 'Tool exposure for remote-docs' });

    await expect(exposure).toHaveValue('deferred');
    await exposure.selectOption('direct');
    await expect(exposure).toHaveValue('direct');
    await expect(exposure).toBeFocused();
    await expect(section).toContainText('MCP configuration updated.');

    const request = api.requests.find(item => item.path === '/api/mcp/actions'
      && (item.body as { action?: string } | undefined)?.action === 'set-exposure');
    expect(request?.body).toEqual({
      action: 'set-exposure', scope: 'global', name: 'remote-docs', exposure: 'direct',
      revision: expect.stringMatching(/^[a-f0-9]{64}$/u), cwd: '/workspace',
    });
    expect(Object.keys(request?.body as object)).not.toContain('configuration');
  });

  test('confirme une suppression MCP, restaure le focus et utilise un undo opaque', async ({ page }) => {
    const api = await installMockApi(page, { mcpConfig: mcpStateInventory() });
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');
    const remove = section.getByRole('button', { name: 'Remove remote-docs', exact: true });

    await remove.click();
    const dialog = page.getByRole('alertdialog', { name: 'Remove MCP server?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(remove).toBeFocused();

    await remove.click();
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(section.getByRole('article', { name: /remote-docs:/u })).toHaveCount(0);
    const undo = section.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeFocused();
    const removalRequest = api.requests.find(request => request.path === '/api/mcp/actions'
      && (request.body as { action?: string } | undefined)?.action === 'remove');
    expect(removalRequest?.body).toMatchObject({ action: 'remove', scope: 'global', name: 'remote-docs' });

    await undo.click();
    await expect(section.getByRole('article', { name: 'remote-docs: Configured', exact: true })).toBeVisible();
    const restoreRequest = api.requests.find(request => request.path === '/api/mcp/actions'
      && (request.body as { action?: string } | undefined)?.action === 'restore');
    expect(restoreRequest?.body).toMatchObject({ action: 'restore', undoToken: expect.any(String) });
    expect(Object.keys(restoreRequest?.body as object)).not.toContain('entry');
  });

  test('recharge l’inventaire après un échec MCP au résultat incertain', async ({ page }) => {
    const api = await installMockApi(page, { mcpConfig: mcpStateInventory() });
    await page.route('**/api/mcp/actions', async route => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'uncertain', code: 'write-failed', uncertain: true }),
      });
    });
    await page.goto('/settings#mcp');
    const section = page.locator('#mcp');
    const readsBefore = api.requests.filter(request => request.path === '/api/mcp').length;

    await section.getByRole('button', { name: 'Disable remote-docs', exact: true }).click();
    await expect(section).toContainText('The action result is uncertain and may have been committed. The inventory was reloaded.');
    await expect.poll(() => api.requests.filter(request => request.path === '/api/mcp').length)
      .toBeGreaterThan(readsBefore);
    await expect(section.getByRole('article', { name: 'remote-docs: Configured', exact: true })).toBeVisible();
  });

  for (const reason of MCP_FILE_PROBLEM_REASONS) {
    test(`localise le diagnostic MCP ${reason} sans afficher le message source`, async ({ page }) => {
      const trustProblem = reason === 'trust-required' || reason === 'trust-unavailable';
      await installMockApi(page, {
        workspaceTrusted: !trustProblem,
        mcpConfig: mcpFileProblemInventory(reason),
      });
      await page.goto('/settings#mcp');
      const section = page.locator('#mcp');

      await section.getByText('Configuration file diagnostics').click();
      await expect(section).toContainText(MCP_FILE_PROBLEM_MESSAGES[reason]);
      await expect(section).not.toContainText('SOURCE-DIAGNOSTIC-MUST-NOT-RENDER');
    });
  }

  test('gère les plugins npm/git/path, leur inventaire et les mises à jour explicites', async ({ page }) => {
    const api = await installMockApi(page);
    await page.goto('/settings#plugins');
    const section = page.locator('#plugins');

    await expect(section.locator('fieldset[data-scope="project"]')).toContainText('workspace-kit');
    await expect(section.locator('fieldset[data-scope="global"]')).toContainText('@aiharness/review-kit');
    await expect(section.locator('fieldset[data-scope="standalone"]')).toContainText('workspace-banner');
    await expect(section).toContainText('1 extension · 1 skill · 1 prompt · 1 theme');
    await selectPluginPackage(page, 'global', '@aiharness/review-kit');
    const globalCard = section.locator('.plugin-card').filter({ hasText: '@aiharness/review-kit' });
    await globalCard.getByText('Resources and diagnostics').click();
    await expect(globalCard).toContainText('extensions/review-tools.js');
    await expect(globalCard).toContainText('skills/release-review');

    await section.getByLabel('Package source').fill('npm:@example/unsaved-plugin');
    await selectSettingsCategory(page, 'subagents');
    await selectPluginPackage(page, 'project', 'workspace-kit');
    await selectPluginPackage(page, 'global', '@aiharness/review-kit');
    await expect(section.getByLabel('Package source')).toHaveValue('npm:@example/unsaved-plugin');
    await expect(globalCard.locator('.plugin-resources')).toHaveAttribute('open', '');
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('npm:@example/unsaved-plugin');
    expect(api.requests.filter(request => request.method !== 'GET' && request.path.startsWith('/api/plugins'))).toEqual([]);
    await section.getByLabel('Package source').fill('');

    const globalGroup = (await showPluginPackages(page)).getByRole('group', { name: 'Global', exact: true });
    const disableRequestPromise = page.waitForRequest(request => request.url().endsWith('/api/plugins/enabled'));
    await globalGroup.getByRole('button', { name: 'Disable all (1)' }).click();
    const disableRequest = await disableRequestPromise;
    expect(disableRequest.method()).toBe('PATCH');
    expect(disableRequest.postDataJSON().changes).toEqual([{
      key: 'global:global:11111111111111111111', scope: 'global', enabled: false,
    }]);
    await expect(globalCard.getByRole('checkbox')).not.toBeChecked();
    await expect(section.getByText('Executable extension changes are pending.', { exact: false })).toBeVisible();
    await globalGroup.getByRole('button', { name: 'Enable all (1)' }).click();
    await expect(globalCard.getByRole('checkbox')).toBeChecked();

    await section.getByLabel('Filter packages').fill('workspace');
    await expect(section.locator('.plugin-card')).toHaveCount(1);
    await section.getByLabel('Filter packages').fill('');

    await section.getByRole('button', { name: 'Check all' }).click();
    await expect(section.getByRole('button', { name: 'Update all (1)' })).toBeVisible();
    await expect(globalCard).toContainText('Version 1.5.0 is available.');
    await section.getByRole('button', { name: 'Update all (1)' }).click();
    await expect(globalCard).toContainText('Version 1.5.0');
    await expect.poll(() => api.requests.filter(request => request.path === '/api/plugins' && request.method === 'POST').at(-1)?.body)
      .toMatchObject({ action: 'update', cwd: '/workspace', projectId: 'workspace-e2e' });

    await section.getByRole('button', { name: 'Reload resources' }).click();
    await expect(section).toContainText('generation 5');
    await expect(section).toContainText('Restart the server for executable extensions.');

    await section.getByLabel('Package source').fill('npm:@example/new-plugin');
    await section.getByLabel('Install scope').selectOption('global');
    await section.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(section).toContainText('@example/new-plugin');
    await expect.poll(() => api.requests.filter(request => request.path === '/api/plugins' && request.method === 'POST').at(-1)?.body)
      .toMatchObject({ action: 'install', source: 'npm:@example/new-plugin', scope: 'global' });

    await selectPluginPackage(page, 'global', '@example/new-plugin');
    const installed = section.locator('.plugin-card').filter({ hasText: '@example/new-plugin' });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/plugins', async route => { await held; await route.fallback(); });
    try {
      await installed.getByRole('checkbox', { name: 'Enable or disable @example/new-plugin' }).uncheck();
      const choice = section.getByRole('navigation').getByRole('button', { name: '@example/new-plugin', exact: true });
      await expect(choice).toBeDisabled();
      await expect(choice).toHaveCSS('opacity', '0.5');
      await expect(choice).toHaveCSS('cursor', 'not-allowed');
      const viewport = page.viewportSize()!;
      await page.setViewportSize({ width: 390, height: 844 });
      const back = section.getByRole('button', { name: 'Back to plugins', exact: true });
      await back.focus();
      await back.press('Enter');
      await expect(section.getByRole('navigation')).toBeFocused();
      await expect(choice).toHaveAttribute('aria-current', 'true');
      await page.setViewportSize(viewport);
    } finally { release(); }
    await expect(installed.getByRole('checkbox')).toBeEnabled();
    await page.unroute('**/api/plugins');
    await expect(installed).toContainText('Disabled');
    page.once('dialog', dialog => dialog.accept());
    await installed.getByRole('button', { name: 'Remove' }).click();
    await expect(installed).toHaveCount(0);
    await expect(section.getByRole('article')).toHaveCount(0);
    await expect(section.getByRole('status')).toHaveText('The selected package is unavailable in this view.');
    await selectPluginPackage(page, 'global', '@aiharness/review-kit');
    await expect(globalCard).toBeVisible();
  });

  test('refuse indépendamment une activation groupée projet sans confiance', async ({ page }) => {
    await installMockApi(page, { workspaceTrusted: false });
    await page.goto('/settings#plugins');
    const section = page.locator('#plugins');
    const projectGroup = (await showPluginPackages(page)).getByRole('group', { name: 'Project', exact: true });
    const projectCard = section.locator('.plugin-card').filter({ hasText: 'workspace-kit' });

    await projectGroup.getByRole('button', { name: 'Disable all (1)' }).click();
    await expect(projectCard.getByRole('checkbox')).not.toBeChecked();
    await expect(section.getByText('Executable extension changes are pending.', { exact: false })).toBeVisible();
    const requestPromise = page.waitForRequest(request => request.url().endsWith('/api/plugins/enabled'));
    await projectGroup.getByRole('button', { name: 'Enable all (1)' }).click();
    const request = await requestPromise;
    expect(request.method()).toBe('PATCH');
    expect(request.postDataJSON().changes).toEqual([{
      key: 'project:workspace-e2e:22222222222222222222', scope: 'project', enabled: true,
    }]);
    await expect(section.getByRole('alert')).toContainText('Changed: 0 · unchanged: 0 · refused: 1.');
    await expect(section).toContainText('workspace-kit: Project trust is required.');
    await expect(projectCard.getByRole('checkbox')).not.toBeChecked();
  });

  test('verrouille les packages projet non approuvés sans bloquer l’administration globale', async ({ page }) => {
    await installMockApi(page, { workspaceTrusted: false });
    await page.goto('/settings#plugins');
    const section = page.locator('#plugins');
    await expect(section.getByText('Project packages and standalone extensions stay locked until this workspace is trusted.')).toBeVisible();
    await expect(section.getByLabel('Install scope').locator('option[value="project"]')).toHaveAttribute('disabled', '');
    const projectCard = section.locator('.plugin-card').filter({ hasText: 'workspace-kit' });
    await expect(projectCard).toContainText('Installed');
    await expect(projectCard).toContainText('No resolved resources');
    await expect(section.locator('fieldset[data-scope="standalone"]')).toContainText('global-status');
    await expect(section.locator('fieldset[data-scope="standalone"]')).not.toContainText('workspace-banner');
    await expect(section.locator('fieldset[data-scope="global"]')).toContainText('@aiharness/review-kit');
  });

  test('configure les profils de sous-agents avec portée, duplication et permissions', async ({ page }) => {
    const api = await installMockApi(page);
    await page.goto('/settings#subagents');
    const section = settingsSection(page, 'Sub-agents');

    await expect(section.getByLabel('Enable the integrated sub-agent engine')).toBeChecked();
    const scopeControl = section.getByLabel('Configuration scope');
    const concurrency = section.getByLabel('Maximum concurrent child agents');
    await expect(scopeControl).toHaveValue('project');
    await expect(section.locator('.subagent-profile-card')).toHaveCount(3);
    await scopeControl.selectOption('global');
    await concurrency.fill('3');
    await expect.poll(() => api.requests.filter(request => request.path === '/api/subagents/settings' && request.method === 'PATCH').at(-1)?.body)
      .toMatchObject({ cwd: '/workspace', scope: 'global', maxConcurrency: 3 });
    await scopeControl.selectOption('project');
    await concurrency.fill('2');
    await expect.poll(() => api.requests.filter(request => request.path === '/api/subagents/settings' && request.method === 'PATCH').at(-1)?.body)
      .toMatchObject({ cwd: '/workspace', projectId: 'workspace-e2e', scope: 'project', maxConcurrency: 2 });

    await section.getByLabel('Filter profiles').fill('Plan');
    await expect(section.locator('.subagent-profile-card')).toHaveCount(1);
    const planToggle = section.getByRole('checkbox', { name: 'Enable sub-agent profile Plan' });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/subagents/profiles/plan', async route => { await held; await route.fallback(); });
    try {
      await planToggle.click();
      const choice = section.getByRole('navigation').getByRole('button', { name: 'Plan (plan)', exact: true });
      await expect(choice).toBeDisabled();
      await expect(choice).toHaveCSS('opacity', '0.5');
      await expect(choice).toHaveCSS('cursor', 'not-allowed');
      const viewport = page.viewportSize()!;
      await page.setViewportSize({ width: 390, height: 844 });
      const back = section.getByRole('button', { name: 'Back to profiles', exact: true });
      await back.focus();
      await back.press('Enter');
      await expect(section.getByRole('navigation')).toBeFocused();
      await page.setViewportSize(viewport);
    } finally { release(); }
    await expect.poll(() => api.requests.filter(request => request.path === '/api/subagents/profiles/plan').at(-1)?.body)
      .toMatchObject({ profile: { enabled: false } });
    await expect(planToggle).not.toBeChecked();
    await page.unroute('**/api/subagents/profiles/plan');
    await section.getByLabel('Filter profiles').fill('');
    await expect(section.getByRole('article', { name: 'Plan', exact: true })).toBeVisible();
    await expect(section.getByRole('navigation').getByRole('button', { name: 'Plan (plan)', exact: true }))
      .toHaveAttribute('aria-current', 'true');

    await section.getByRole('button', { name: 'Create profile' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create profile' });
    await dialog.getByLabel('Profile ID').fill('security-review');
    await dialog.getByLabel('Name').fill('Security review');
    await selectSettingsCategory(page, 'general');
    await expect(dialog).toBeHidden();
    await selectSettingsCategory(page, 'subagents');
    await expect(dialog.getByLabel('Name')).toHaveValue('Security review');
    await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    expect(api.requests.filter(request => request.path === '/api/subagents/profiles' && request.method === 'POST')).toEqual([]);
    await dialog.getByLabel('Description').fill('Review trust boundaries');
    await dialog.getByLabel('Instructions').fill('Inspect the selected trust boundaries.');
    await dialog.getByLabel('Tools').fill('read, grep');
    await dialog.getByLabel('Skills').fill('review-project');
    await dialog.getByLabel('Maximum turns').fill('6');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await selectSubagentProfile(page, 'Security review');
    const custom = section.getByRole('article', { name: 'Security review', exact: true });
    await expect(custom).toBeVisible();
    await expect(custom).toContainText('read, grep');
    await custom.getByRole('button', { name: 'Duplicate' }).click();
    await selectSubagentProfile(page, 'Security review copy');
    await expect(section.getByRole('article', { name: 'Security review copy', exact: true })).toBeVisible();
  });

  test('enregistre une clé fournisseur côté serveur puis masque sa valeur', async ({ page }) => {
    const api = await installMockApi(page);
    await page.goto('/settings#providers');
    await selectProviderCredential(page, 'OpenAI');
    const openAiRow = page.locator('.api-key-row').filter({ has: page.getByText('OpenAI', { exact: true }) });
    const keyInput = openAiRow.locator('input');
    await keyInput.fill('sk-e2e-secret');
    await openAiRow.getByRole('button', { name: 'Save' }).click();
    await expect(openAiRow.getByRole('status')).toHaveText('OpenAI configured on the server.');
    await expect(keyInput).toHaveValue('••••••••');
    await expect.poll(() => api.requests.filter(request => request.method === 'POST' && request.path === '/api/config').map(request => request.body))
      .toEqual([{ type: 'openai', apiKey: 'sk-e2e-secret' }]);
  });

  test('signale un échec de configuration fournisseur', async ({ page }) => {
    await installMockApi(page, { configureProviderError: true });
    await page.goto('/settings#providers');
    await selectProviderCredential(page, 'Anthropic');
    const anthropicRow = page.locator('.api-key-row').filter({ has: page.getByText('Anthropic', { exact: true }) });
    await anthropicRow.locator('input').fill('invalid-key');
    await anthropicRow.getByRole('button', { name: 'Save' }).click();
    await expect(anthropicRow.getByRole('alert')).toHaveText('HTTP 500');
    await expect(anthropicRow.locator('input')).toHaveValue('invalid-key');
  });

  test('applique le Bearer token à l’agent sans le persister durablement', async ({ page }) => {
    const api = await installMockApi(page);
    await page.goto('/settings#authentication');
    const authentication = settingsSection(page, 'Server authentication');
    await authentication.getByPlaceholder('Bearer token').fill('  e2e-token  ');
    await authentication.getByRole('button', { name: 'Apply' }).click();
    await expect(authentication.getByText('Token applied to this tab.')).toBeVisible();
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('ai-harness-auth-token'))).toBe('e2e-token');
    expect(await page.evaluate(() => localStorage.getItem('ai-harness-auth-token'))).toBeNull();

    await closeSettings(page);
    await page.getByRole('button', { name: 'New chat' }).click();
    await page.getByPlaceholder(/Type your message/).fill('Authentifié');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => api.requests.find(request => request.method === 'POST' && request.path === '/api/agent/runs')?.headers.authorization)
      .toBe('Bearer e2e-token');
  });

  for (const scenario of [
    { name: 'desktop-en-light', width: 1280, locale: 'en', theme: 'light' },
    { name: 'desktop-fr-dark', width: 1280, locale: 'fr', theme: 'dark' },
    { name: 'mobile-en-dark', width: 390, locale: 'en', theme: 'dark' },
    { name: 'mobile-fr-light', width: 390, locale: 'fr', theme: 'light' },
  ]) test(`persiste thème, largeur, police et options dans des panneaux séparés : ${scenario.name}`, async ({ page }) => {
    await page.setViewportSize({ width: scenario.width, height: 844 });
    await page.addInitScript(({ locale, theme }) => {
      localStorage.setItem('ai-harness-locale', locale);
      if (!localStorage.getItem('ai-harness-preferences-v4')) {
        localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme }));
      }
    }, scenario);
    await installMockApi(page);
    await page.goto('/settings#appearance');
    const appearance = page.locator('#appearance');
    await expect(appearance).toBeVisible();
    await expect(appearance.locator('input[type=checkbox]')).toHaveCount(0);
    await expect(page.locator('#behavior')).toBeHidden();
    await expect(page.locator('#notifications')).toBeHidden();
    const navigation = page.getByRole('navigation', { name: /^(General settings|Paramètres généraux)$/u });
    const appearanceLink = navigation.getByRole('link').first();
    if (scenario.width < 960) {
      const back = page.getByRole('button', { name: /^(Back to General settings|Retour aux paramètres généraux)$/u });
      await back.focus(); await back.press('Enter');
      await expect(appearance).toBeHidden();
      await expect(appearanceLink).toBeFocused();
      await expect(appearanceLink).toHaveCSS('outline-style', 'solid');
      await expectContrast(appearanceLink, 'outlineColor', 3);
      await expect(page.locator('.settings-dialog')).toHaveScreenshot(`general-sections-${scenario.name}.png`, {
        animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
      });
      await page.keyboard.press('Enter');
      await expect(appearance).toBeVisible();
      await expect(back).toBeFocused();
    } else {
      await expect(navigation.getByRole('link')).toHaveText(scenario.locale === 'fr'
        ? ['Apparence', 'Comportement', 'Notifications', 'Accès', 'À propos']
        : ['Appearance', 'Behavior', 'Notifications', 'Access', 'About']);
      await expectThemeRoles(appearanceLink, '--surface-selected');
      await expectContrast(appearanceLink, 'borderLeftColor', 3);
      await appearanceLink.focus();
      await page.keyboard.press('Tab');
      const behaviorLink = navigation.getByRole('link').nth(1);
      await expect(behaviorLink).toBeFocused();
      await expect(behaviorLink).toHaveCSS('outline-style', 'solid');
      await expectContrast(behaviorLink, 'outlineColor', 3);
      await page.keyboard.press('Enter');
      await expect(page.locator('#behavior')).toBeVisible();
      await selectGeneralSettings(page, 'appearance');
    }
    await appearance.locator('input[type=range]').nth(0).fill('1200');
    await appearance.locator('input[type=range]').nth(1).fill('18');
    await test.info().attach(`general-appearance-${scenario.name}`, {
      body: await page.locator('.settings-dialog').screenshot({ path: test.info().outputPath(`general-appearance-${scenario.name}.png`),
        animations: 'disabled', caret: 'hide' }), contentType: 'image/png',
    });
    await selectGeneralSettings(page, 'behavior');
    const behavior = page.locator('#behavior');
    await expect(appearance).toBeHidden();
    await behavior.getByRole('checkbox').first().check();
    await selectGeneralSettings(page, 'notifications');
    const notifications = page.locator('#notifications');
    await expect(behavior).toBeHidden();
    await notifications.getByRole('checkbox').first().check();
    await page.goBack();
    await expect(behavior.getByRole('checkbox').first()).toBeChecked();
    await page.goForward();
    await expect(notifications.getByRole('checkbox').first()).toBeChecked();
    for (const panel of ['behavior', 'notifications'] as const) {
      await selectGeneralSettings(page, panel);
      const controls = await page.locator(`#${panel} :is(select, input[type=range])`).evaluateAll(elements => elements.map(element => {
        const bounds = element.getBoundingClientRect();
        const section = element.closest('.settings-section')!;
        const parent = section.getBoundingClientRect(), style = getComputedStyle(section);
        return { left: bounds.left - parent.left - parseFloat(style.paddingLeft), right: parent.right - parseFloat(style.paddingRight) - bounds.right };
      }));
      for (const control of controls) {
        expect(control.left).toBeGreaterThanOrEqual(-0.1);
        expect(control.right).toBeGreaterThanOrEqual(-0.1);
      }
      const alignment = await page.locator(`#${panel} label:has(input[type=checkbox])`).evaluateAll(labels => labels.map(label => {
        const input = label.querySelector('input')!.getBoundingClientRect();
        const text = [...label.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())!;
        const range = document.createRange(); range.selectNode(text);
        const caption = range.getBoundingClientRect();
        return { gap: caption.left - input.right, offset: Math.abs(input.top + input.height / 2 - caption.top - caption.height / 2), height: label.getBoundingClientRect().height };
      }));
      expect(alignment.length).toBeGreaterThan(0);
      for (const label of alignment) {
        expect(label.gap).toBeGreaterThanOrEqual(4);
        expect(label.offset).toBeLessThanOrEqual(3);
        expect(label.height).toBeGreaterThanOrEqual(scenario.width < 960 ? 44 : 24);
      }
      if (panel === 'behavior') {
        const defaults = page.locator('#defaults');
        const inset = await defaults.getByRole('combobox', { name: /^(Scope|Portée)$/u, exact: true })
          .evaluate(element => getComputedStyle(element).paddingInlineStart);
        const inputs = defaults.getByRole('textbox');
        await expect(inputs).toHaveCount(3);
        for (const input of await inputs.all()) {
          await expect(input).toHaveCSS('padding-inline-start', inset);
          await expect(input).toHaveCSS('padding-inline-end', inset);
        }
        await page.locator('.settings-view').evaluate(element => element.scrollTo(0, 0));
        await test.info().attach(`general-behavior-${scenario.name}`, {
          body: await page.locator('.settings-dialog').screenshot({ path: test.info().outputPath(`general-behavior-${scenario.name}.png`),
            animations: 'disabled', caret: 'hide' }), contentType: 'image/png',
        });
      }
    }
    expect((await new AxeBuilder({ page }).include('.settings-dialog').analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const control of await notifications.getByRole('checkbox').all()) {
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport({ ratio: 1 });
    }
    await page.locator('.settings-view').evaluate(element => element.scrollTo(0, 0));
    await expect(notifications.getByRole('heading')).toBeInViewport({ ratio: 1 });
    await expect(page.locator('.settings-dialog')).toHaveScreenshot(`general-notifications-${scenario.name}.png`, {
      animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
    });
    await selectGeneralSettings(page, 'appearance');
    await appearance.getByLabel(/^(Theme|Thème)/u).selectOption('pine');

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'pine');
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('ai-harness-preferences-v4') || '{}')))
      .toMatchObject({
        version: 4, theme: 'pine', sendMode: 'enter', contentWidth: 1200, fontSize: 18, reasoningOpen: true, sound: true,
        soundEvents: { completion: true, attention: true },
        notificationEvents: { completion: true, attention: true },
        pushEvents: { completion: true, attention: true },
      });
    await page.reload();
    const theme = page.locator('#appearance').getByLabel(/^(Theme|Thème)/u);
    await expect(theme).toHaveValue('pine');
    await expect(theme.locator('option')).toHaveText(scenario.locale === 'fr'
      ? ['Système', 'Clair', 'Sombre', 'Brume', 'Rose', 'Pin'] : ['System', 'Light', 'Dark', 'Mist', 'Rose', 'Pine']);
    await theme.selectOption('system');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('demande explicitement la permission Push et garde ses catégories séparées', async ({ page }) => {
    await page.addInitScript(() => {
      let subscription: any = null;
      Object.defineProperty(window, 'PushManager', { configurable: true, value: class PushManager {} });
      Object.defineProperty(window, 'Notification', {
        configurable: true,
        value: class Notification {
          static permission = 'default';
          static async requestPermission() {
            (window as any).__permissionRequests = ((window as any).__permissionRequests || 0) + 1;
            this.permission = 'granted';
            return 'granted';
          }
        },
      });
      const registration = {
        pushManager: {
          getSubscription: async () => subscription,
          subscribe: async (options: any) => {
            subscription = {
              endpoint: 'https://push.example.test/e2e', expirationTime: null, options,
              toJSON: () => ({ endpoint: 'https://push.example.test/e2e', keys: { p256dh: 'client', auth: 'auth' } }),
              unsubscribe: async () => { subscription = null; return true; },
            };
            return subscription;
          },
        },
      };
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
          controller: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          getRegistration: async () => registration,
          register: async () => registration,
        },
      });
    });
    const api = await installMockApi(page);
    await page.goto('/settings#appearance');
    await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
    await expect(page.locator('#appearance .preference-grid')).toBeVisible();
    await expect(page.locator('.push-notification-toggle')).toBeHidden();
    await selectGeneralSettings(page, 'notifications');
    expect(await page.evaluate(() => (window as any).__permissionRequests || 0)).toBe(0);
    const localEvents = page.locator('.notification-event-settings input[type=checkbox]');
    await expect(localEvents.nth(1)).toBeChecked();

    const push = page.locator('.push-notification-toggle');
    await expect(push).toBeEnabled();
    await push.click();
    await expect.poll(() => page.evaluate(() => (window as any).__permissionRequests || 0)).toBe(1);
    await expect.poll(() => api.requests.filter(request => request.path === '/api/push/subscribe' && request.method === 'POST').at(-1)?.body)
      .toMatchObject({ categories: ['completion', 'attention'] });

    const pushEvents = page.locator('.push-event-settings input[type=checkbox]');
    await pushEvents.nth(0).uncheck();
    await expect(localEvents.nth(0)).toBeChecked();
    await expect.poll(() => api.requests.filter(request => request.path === '/api/push/subscribe' && request.method === 'POST').at(-1)?.body)
      .toMatchObject({ categories: ['attention'] });
    await push.click();
    await expect.poll(() => api.requests.filter(request => request.path === '/api/push/subscribe' && request.method === 'DELETE').length).toBe(1);
  });

  test('affiche les versions, une release et ses notes sans mise à jour automatique', async ({ page }) => {
    const api = await installMockApi(page, {
      appUpdate: {
        webVersion: '0.1.0', agentVersion: '0.1.1', available: true,
        release: {
          version: '0.2.0', name: 'AiHarness 0.2.0',
          url: 'https://github.com/Fidigi/AiHarness/releases/tag/v0.2.0',
          notes: 'Safer agents and a faster interface.',
        },
      },
    });
    await page.goto('/settings#about');
    const about = settingsSection(page, 'About');
    await expect(about.locator('.version-status dt')).toHaveText(['Web version', 'Agent version']);
    await expect(about.locator('.version-status dd')).toHaveText(['0.1.0', '0.1.1']);
    const release = about.getByRole('link', { name: 'Version 0.2.0 is available' });
    await expect(release).toHaveAttribute('href', 'https://github.com/Fidigi/AiHarness/releases/tag/v0.2.0');
    await about.getByText('Release notes').click();
    await expect(about).toContainText('Safer agents and a faster interface.');
    expect(api.requests.filter(request => request.path === '/api/app-update')).toHaveLength(1);
    await about.getByRole('button', { name: 'Check again' }).click();
    await expect.poll(() => api.requests.filter(request => request.path === '/api/app-update').length).toBe(2);
    expect(api.requests.filter(request => request.path === '/api/app-update')[1]?.path).toBe('/api/app-update');
  });

  test('affiche une connexion dédiée puis restaure le deep link avec une session cookie', async ({ page }) => {
    const api = await installMockApi(page, {
      authRequired: true,
      authToken: 'correct-token',
      sessions: [mockSession('protected-session', 'Protected deep link')],
    });
    await page.goto('/chat/protected-session?cwd=%2Fworkspace');
    await expect(page.getByText('Sign in to access this AiHarness server.')).toBeVisible();
    await page.getByLabel('Access token').fill('incorrect');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('Invalid credentials');
    await page.getByLabel('Access token').fill('correct-token');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/chat\/protected-session\?cwd=%2Fworkspace/);
    await expect(page.getByText('Protected deep link', { exact: true }).first()).toBeVisible();
    expect(api.requests.filter(request => request.path === '/api/auth/login')).toHaveLength(2);
  });
});
