import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures/test-budget.js';
import { installMockApi } from './fixtures/mock-api.js';
import { switchSettingsWorkspace } from './fixtures/mcp-navigation.js';
import { reloadSettingsDiscardingDrafts, selectCatalogueModel, selectGeneralSettings, selectModelSettings, selectProviderCredential, selectRegistryEntry, selectSettingsCategory } from './fixtures/settings-navigation';
import { expectContrast, expectThemeRoles } from './fixtures/contrast';
import { mcpFreshProjectInventory, mcpFreshProjectPreviewFixture } from './fixtures/mcp.js';

const key = 'ai-harness-settings-navigation-v1';
for (const scenario of [
  { width: 1280, locale: 'en', theme: 'light' },
  { width: 1280, locale: 'fr', theme: 'dark' },
  { width: 390, locale: 'en', theme: 'light' },
  { width: 390, locale: 'fr', theme: 'dark' },
]) test(`Built-in credential selection preserves drafts without changing provider: ${scenario.width}px ${scenario.locale}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: scenario.width, height: 844 });
  await page.addInitScript(({ locale, theme }) => {
    localStorage.setItem('ai-harness-locale', locale);
    localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme }));
  }, scenario);
  const api = await installMockApi(page, { providers: [
    { type: 'mock', configured: true }, { type: 'openai', configured: false }, { type: 'anthropic', configured: false },
  ] });
  await page.goto('/settings#providers');
  const section = page.locator('#providers');
  const navigation = section.getByRole('navigation', { name: /^(Provider credentials|Identifiants fournisseurs)$/u });
  const active = section.locator(':scope > select');
  const before = await active.inputValue();
  const anthropic = navigation.getByRole('button', { name: 'Anthropic', exact: true });
  await expect(navigation).toBeVisible();
  await anthropic.focus(); await anthropic.press('Enter');
  const detail = section.locator('.credential-context-detail');
  const secret = detail.locator('input:visible');
  await expect(secret).toHaveCount(1);
  await expect(secret).toHaveAccessibleName(/Anthropic/u);
  const current = section.getByRole('button', { name: 'Anthropic', exact: true, includeHidden: true });
  await expect(current).toHaveAttribute('aria-current', 'true');
  await expect(current).toHaveAttribute('aria-expanded', 'true');
  await expect(current).toHaveCSS('border-left-width', '3px');
  const back = section.getByRole('button', { name: /^(Back to provider credentials|Retour aux identifiants fournisseurs)$/u });
  if (scenario.width < 960) {
    await expect(back).toBeFocused(); await back.press('Enter');
    for (const control of [anthropic, back]) {
      await expect(control).toBeFocused();
      await expect(control).toHaveCSS('outline-style', 'solid');
      await expectContrast(control, 'outlineColor', 3);
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      const clearance = await control.evaluate(element => {
        const style = getComputedStyle(element), bounds = element.getBoundingClientRect();
        const extent = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
        return Math.min(...[element.closest('nav') ?? element.closest('.credential-context-detail')!, element.closest('.settings-view')!]
          .flatMap(owner => {
            const clip = owner.getBoundingClientRect();
            return [bounds.left - clip.left, clip.right - bounds.right, bounds.top - clip.top, clip.bottom - bounds.bottom];
          })) - extent;
      });
      expect(clearance).toBeGreaterThanOrEqual(-0.1);
      if (control === anthropic) await anthropic.press('Enter');
    }
  } else {
    await expect(anthropic).toBeFocused();
    const list = (await navigation.boundingBox())!, content = (await detail.boundingBox())!;
    expect(list.x + list.width).toBeLessThanOrEqual(content.x);
  }
  const draft = 'CREDENTIAL_NAV_SECRET_MUST_NOT_PERSIST';
  await secret.fill(draft);
  if (scenario.width < 960) { await back.focus(); await back.press('Enter'); await expect(anthropic).toBeFocused(); }
  await navigation.getByRole('button', { name: 'OpenAI', exact: true }).click();
  await secret.fill('OTHER_CREDENTIAL_NAV_SECRET');
  if (scenario.width < 960) await back.click();
  await anthropic.click();
  await expect(secret).toHaveValue(draft);
  await selectGeneralSettings(page, 'appearance');
  await selectModelSettings(page, 'providers');
  await expect(secret).toHaveValue(draft);
  await expect(active).toHaveValue(before);
  expect((await new AxeBuilder({ page }).include('#providers').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
  await expectContrast(secret, 'color', 4.5);
  expect(await page.locator('.settings-view').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const capture = testInfo.outputPath(`provider-credentials-${scenario.width}-${scenario.locale}.png`);
  await page.screenshot({ path: capture, animations: 'disabled', caret: 'hide' });
  await testInfo.attach('provider-credentials', { path: capture, contentType: 'image/png' });
  await expect(section).toHaveScreenshot(`provider-credentials-${scenario.width}-${scenario.locale}.png`);
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(stored).not.toContain(draft); expect(stored).not.toContain('OTHER_CREDENTIAL_NAV_SECRET');
  const memory = JSON.parse(await page.evaluate(key => localStorage.getItem(key)!, key));
  expect(memory.entries.find((entry: { cwd: string }) => entry.cwd === '/workspace').positions.providers)
    .toEqual({ group: 'builtin', selection: 'anthropic' });
  await reloadSettingsDiscardingDrafts(page);
  await expect(secret).toHaveAccessibleName(/Anthropic/u);
  await expect(secret).toHaveValue('');
  await expect(active).toHaveValue(before);
  if (scenario.width > 959) {
    await active.focus();
    await page.setViewportSize({ width: 390, height: 844 }); await expect(active).toBeFocused();
    await expect(back).toBeVisible();
    await page.setViewportSize({ width: scenario.width, height: 844 }); await expect(active).toBeFocused();
    await expect(back).toBeHidden();
  }
  await page.evaluate(key => {
    const current = JSON.parse(localStorage.getItem(key)!);
    current.entries.find((entry: { cwd: string }) => entry.cwd === '/workspace').positions.providers = { group: 'builtin', selection: 'retired-provider' };
    localStorage.setItem(key, JSON.stringify(current));
  }, key);
  await page.reload();
  await expect(navigation).toBeVisible();
  await expect(navigation.locator('[aria-current="true"]')).toHaveCount(0);
  await expect(secret).toHaveCount(0);
  await expect(section.getByRole('status').filter({ hasText: /selected provider credentials are unavailable|fournisseur sélectionné/u })).toBeVisible();
  await expect(active).toHaveValue(before);
  const unavailableCapture = testInfo.outputPath(`provider-credentials-unavailable-${scenario.width}-${scenario.locale}.png`);
  await page.screenshot({ path: unavailableCapture, animations: 'disabled', caret: 'hide' });
  await testInfo.attach('provider-credentials-unavailable', { path: unavailableCapture, contentType: 'image/png' });
  await anthropic.click(); await expect(secret).toHaveValue('');
  expect(api.requests.filter(request => request.method !== 'GET'
    && !['/api/workspaces/validate', '/api/mcp/oauth/status'].includes(request.path))).toEqual([]);
});

for (const scenario of [
  { width: 1280, locale: 'en', theme: 'light' },
  { width: 1280, locale: 'fr', theme: 'dark' },
  { width: 390, locale: 'en', theme: 'light' },
  { width: 390, locale: 'fr', theme: 'dark' },
]) test(`Models contextual sections preserve drafts and explicit navigation: ${scenario.width}px ${scenario.locale}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: scenario.width, height: 844 });
  await page.addInitScript(({ locale, theme }) => {
    localStorage.setItem('ai-harness-locale', locale);
    localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme }));
  }, scenario);
  const api = await installMockApi(page);
  await page.goto('/settings#providers');
  const sections = ['providers', 'provider-lifecycle', 'model', 'custom-models'] as const;
  const navigation = page.getByRole('navigation', { name: /^(Model settings|Paramètres des modèles)$/u, includeHidden: true });
  await expect(navigation.getByRole('link', { includeHidden: true })).toHaveCount(4);
  const secret = page.locator('#providers .api-key-row input').first();
  const providerEditor = page.locator('#provider-lifecycle .custom-resource-editor');
  const catalog = page.locator('#model .model-catalog');
  const modelEditor = page.locator('#custom-models .custom-resource-editor');
  const drafts = [secret, providerEditor.getByLabel('ID', { exact: true }), catalog.getByRole('searchbox'), modelEditor.getByLabel('ID', { exact: true })];
  const values = ['MODEL_NAV_SECRET_MUST_NOT_PERSIST', 'draft-provider-not-saved', 'mock', 'draft-model-not-saved'];
  const editorInsets: Array<{ start: string; end: string }> = [];
  for (let index = 0; index < sections.length; index++) {
    const section = sections[index]!;
    await selectModelSettings(page, section);
    await expect(page).toHaveURL(new RegExp(`#${section}$`, 'u'));
    await expect(page.locator(`#${section}`)).toBeVisible();
    for (const other of sections.filter(candidate => candidate !== section)) await expect(page.locator(`#${other}`)).toBeHidden();
    await expect(navigation.locator(`a[href$="#${section}"]`)).toHaveAttribute('aria-current', 'page');
    if (section === 'providers') await selectProviderCredential(page, 'OpenAI');
    if (index > 0) await [providerEditor, catalog, modelEditor][index - 1]!.locator(':scope > summary').click();
    await drafts[index]!.fill(values[index]!);
    if (section === 'provider-lifecycle' || section === 'custom-models') {
      const fields = page.locator(`#${section} .custom-resource-editor form`).locator('input:not([type="checkbox"]), textarea');
      await expect(fields).toHaveCount(section === 'provider-lifecycle' ? 5 : 10);
      editorInsets.push(...await fields.evaluateAll(elements => elements.map(element => {
        const style = getComputedStyle(element);
        return { start: style.paddingInlineStart, end: style.paddingInlineEnd };
      })));
    }
    const capture = testInfo.outputPath(`model-panel-${section}-${scenario.width}-${scenario.locale}.png`);
    await page.screenshot({ path: capture, animations: 'disabled', caret: 'hide' });
    await testInfo.attach(`model-panel-${section}-${scenario.width}-${scenario.locale}`, {
      path: capture, contentType: 'image/png',
    });
  }
  const inset = await providerEditor.locator('form select').evaluate(element => getComputedStyle(element).paddingInlineStart);
  expect(editorInsets).toEqual(Array.from({ length: 15 }, () => ({ start: inset, end: inset })));
  await selectGeneralSettings(page, 'appearance');
  for (let index = 0; index < sections.length; index++) {
    await selectModelSettings(page, sections[index]!);
    await expect(drafts[index]!).toHaveValue(values[index]!);
  }
  if (scenario.width < 960) {
    const back = page.getByRole('button', { name: /^(Back to Model settings|Retour aux paramètres des modèles)$/u });
    await back.focus();
    await page.keyboard.press('Enter');
    const current = navigation.locator('[aria-current="page"]');
    await expect(current).toBeFocused();
    await expect(page.locator('#custom-models')).toBeHidden();
    for (const link of await navigation.getByRole('link').all()) {
      await link.focus();
      await expect(link).toBeInViewport({ ratio: 1 });
      await expect(link).toHaveCSS('outline-style', 'solid');
      await expectContrast(link, 'outlineColor', 3);
      expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      const clearance = await link.evaluate(element => {
        const style = getComputedStyle(element);
        const extent = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
        const bounds = element.getBoundingClientRect();
        const clip = element.closest('nav')!.getBoundingClientRect();
        return [bounds.left - clip.left, clip.right - bounds.right, bounds.top - clip.top, clip.bottom - bounds.bottom]
          .map(distance => distance - extent);
      });
      for (const distance of clearance) expect(distance).toBeGreaterThanOrEqual(-0.1);
    }
    await current.focus();
    await page.keyboard.press('Enter');
    await expect(back).toBeFocused();
    await expect(back).toHaveCSS('outline-style', 'solid');
    await expectContrast(back, 'outlineColor', 3);
    const backClearance = await back.evaluate(element => {
      const style = getComputedStyle(element);
      const extent = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
      const bounds = element.getBoundingClientRect();
      const clip = element.closest('.settings-detail')!.getBoundingClientRect();
      return Math.min(bounds.left - clip.left, clip.right - bounds.right, bounds.top - clip.top, clip.bottom - bounds.bottom) - extent;
    });
    expect(backClearance).toBeGreaterThanOrEqual(-0.1);
    const capture = testInfo.outputPath(`model-panel-back-${scenario.width}-${scenario.locale}.png`);
    await page.screenshot({ path: capture, animations: 'disabled', caret: 'hide' });
    await testInfo.attach('model-panel-back-focus', { path: capture, contentType: 'image/png' });
    await expect(modelEditor.getByLabel('ID', { exact: true })).toHaveValue(values[3]!);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  for (const value of [values[0], values[1], values[3]]) expect(stored).not.toContain(value);
  expect(api.requests.filter(request => request.method !== 'GET'
    && !['/api/workspaces/validate', '/api/mcp/oauth/status'].includes(request.path))).toEqual([]);
  await selectModelSettings(page, 'model');
  await selectModelSettings(page, 'custom-models');
  await page.goBack();
  await expect(page.locator('#model')).toBeVisible();
  await page.goForward();
  await expect(page.locator('#custom-models')).toBeVisible();
  await reloadSettingsDiscardingDrafts(page);
  await expect(page.locator('#custom-models')).toBeVisible();
  await expect(page.locator('#providers')).toBeHidden();
});
test('Settings restores separate section, group, row and scope intent through real project switches and reload', async ({ page }) => {
  const api = await installMockApi(page);
  await page.goto('/settings?cwd=%2Fworkspace#model');
  const catalog = page.locator('#model .model-catalog');
  await catalog.locator('summary').click();
  const row = catalog.locator('.model-catalog-row').first();
  const identity = await row.getAttribute('data-settings-selection');
  await row.getByRole('checkbox').focus();
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)!).entries[0].positions.model.selection, key)).toBe(identity);
  await page.goto('/settings');
  await expect(row).toBeInViewport();
  await expect(catalog).toHaveAttribute('open', '');
  const scope = page.locator('#tools').getByRole('combobox', { name: 'Scope', exact: true });
  await selectSettingsCategory(page, 'tools');
  await scope.selectOption('global');
  await selectSettingsCategory(page, 'models');
  await row.getByRole('checkbox').focus();
  await switchSettingsWorkspace(page, '/workspace/other');
  await selectSettingsCategory(page, 'tools');
  await expect(scope).toHaveValue('project');
  await selectGeneralSettings(page, 'behavior');
  await page.locator('#shortcuts input').first().focus();
  await switchSettingsWorkspace(page, '/workspace');
  await expect(row).toBeInViewport();
  await selectSettingsCategory(page, 'tools');
  await expect(scope).toHaveValue('global');
  await selectSettingsCategory(page, 'models');
  await expect(row).toBeInViewport();
  await row.getByRole('checkbox').focus();
  await page.reload();
  await expect(row).toBeInViewport();
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key);
  expect(saved.entries.find((entry: { cwd: string }) => entry.cwd === '/workspace')).toMatchObject({
    section: 'model', positions: { model: { selection: identity } }, scopes: { tools: 'global' },
  });
  expect(saved.entries.find((entry: { cwd: string }) => entry.cwd === '/workspace/other').section).toBe('shortcuts');
  expect(api.requests.filter(request => request.method !== 'GET' && !['/api/workspaces/validate', '/api/mcp/oauth/status'].includes(request.path))).toEqual([]);
  // An explicit section address is an intent even without control focus.
  await page.goto('/settings#shortcuts');
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)!).entries
    .find((entry: { cwd: string }) => entry.cwd === '/workspace')?.section, key)).toBe('shortcuts');
  await page.goto('/settings');
  await expect(page.locator('#shortcuts')).toBeInViewport();
});

test('Settings focus conserves another tab’s fresh other-section position without live navigation or configuration writes', async ({ page }) => {
  const api = await installMockApi(page);
  await page.goto('/settings?cwd=%2Fworkspace#model');
  const catalog = page.locator('#model .model-catalog');
  await catalog.locator('summary').click();
  const model = catalog.locator('.model-catalog-row').first().getByRole('checkbox');
  await model.focus();
  await selectSettingsCategory(page, 'tools');
  await page.locator('#tools').getByRole('combobox', { name: 'Scope', exact: true }).focus();
  await page.goto('/settings');
  await expect(page.locator('#tools')).toBeVisible();
  const peer = await page.context().newPage();
  try {
    const peerApi = await installMockApi(peer);
    await peer.goto('/settings?cwd=%2Fworkspace#subagents');
    const profile = peer.locator('#subagents .subagent-profile-card').first();
    const edit = profile.getByRole('button').first();
    await expect(edit).toBeEnabled();
    const identity = await profile.getAttribute('data-settings-selection');
    await edit.focus();
    const position = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)!).entries
      .find((entry: { cwd: string }) => entry.cwd === '/workspace')?.positions.subagents, key);
    await expect.poll(async () => (await position())?.selection).toBe(identity);
    await expect(peer.locator('#subagents select[data-settings-focus="scope"]')).toHaveValue('project');
    await expect.poll(position).toEqual({ group: 'project', selection: identity });
    const remembered = await position();
    await expect(page).toHaveURL(/\/settings$/u);
    await page.bringToFront();
    // A parent rerender must not turn another tab's saved section into live navigation.
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Command palette', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#tools')).toBeVisible();
    await expect(page.locator('#subagents')).toBeHidden();
    await selectSettingsCategory(page, 'models');
    await expect(catalog.locator('.model-catalog-row').first()).toBeInViewport();
    await model.focus();
    await expect.poll(position).toEqual(remembered);
    for (const client of [api, peerApi]) expect(client.requests.filter(request => request.method !== 'GET'
      && !['/api/workspaces/validate', '/api/mcp/oauth/status'].includes(request.path))).toEqual([]);
  } finally { await peer.close(); }
});

test('No-project Settings retains global sections and falls back only unavailable project scope; forms never enter navigation storage', async ({ page }) => {
  const api = await installMockApi(page);
  await page.route('**/api/workspaces/default', route => route.fulfill({ status: 404, json: { error: 'No workspace' } }));
  await page.addInitScript(key => localStorage.setItem(key, JSON.stringify({ version: 1, entries: [
    { cwd: null, section: 'tools', positions: {}, scopes: { tools: 'project', defaults: 'project', subagents: 'project', registry: 'project' } },
  ] })), key);
  await page.goto('/settings');
  for (const section of ['tools', 'defaults', 'subagents'] as const) {
    if (section === 'defaults') await selectGeneralSettings(page, 'behavior');
    else await selectSettingsCategory(page, section);
    const scope = page.locator(`#${section} select`).first();
    await expect(scope).toHaveValue('global');
    await expect(scope.locator('option[value="project"]')).toHaveJSProperty('disabled', true);
  }
  await selectRegistryEntry(page, 'security-review');
  const registry = page.locator('.skill-registry');
  await expect(registry.getByRole('combobox')).toHaveValue('global');
  await expect(registry.getByRole('combobox').locator('option[value="project"]')).toHaveJSProperty('disabled', true);
  await expect(registry.locator('.skill-registry-context-detail').getByRole('article')).toHaveAttribute('data-settings-selection', 'security-review');
  expect(api.requests.filter(request => request.path.startsWith('/api/skills/registry/') && request.method !== 'GET')).toEqual([]);
  expect(api.requests.filter(request => request.path === '/api/skills/content')).toEqual([]);
  await selectProviderCredential(page, 'Anthropic');
  const credential = page.locator('#providers .credential-context-detail input:visible');
  await credential.fill('NO_PROJECT_CREDENTIAL_DRAFT');
  await selectGeneralSettings(page, 'authentication');
  await page.locator('#authentication input').fill('NAVIGATION_SECRET_MUST_NOT_PERSIST');
  await selectGeneralSettings(page, 'behavior');
  await page.locator('#defaults').getByLabel('Model', { exact: true }).fill('DRAFT_MODEL_NOT_SAVED');
  await selectGeneralSettings(page, 'authentication');
  await expect(page.locator('#authentication input')).toHaveValue('NAVIGATION_SECRET_MUST_NOT_PERSIST');
  await selectGeneralSettings(page, 'behavior');
  await expect(page.locator('#defaults').getByLabel('Model', { exact: true })).toHaveValue('DRAFT_MODEL_NOT_SAVED');
  await selectProviderCredential(page, 'Anthropic');
  await expect(credential).toHaveValue('NO_PROJECT_CREDENTIAL_DRAFT');
  expect(api.requests.filter(request => request.method !== 'GET'
    && ['/api/config', '/api/configuration/scope'].includes(request.path))).toEqual([]);
  await selectSettingsCategory(page, 'mcp');
  await page.locator('#mcp').getByRole('button', { name: 'Refresh', exact: true }).focus();
  const saved = await page.evaluate(key => localStorage.getItem(key), key);
  expect(saved).not.toContain('NAVIGATION_SECRET');
  expect(saved).not.toContain('DRAFT_MODEL_NOT_SAVED');
  expect(saved).not.toContain('NO_PROJECT_CREDENTIAL_DRAFT');
  expect(JSON.parse(saved!).entries[0].section).toBe('mcp');
});

test('Trust granted through the real MCP import UI rereads all mounted resource sections without leaving Settings', async ({ page }) => {
  const api = await installMockApi(page, { workspaceTrusted: true, workspaceOperationTrusted: false,
    mcpConfig: mcpFreshProjectInventory(), mcpImportPreview: mcpFreshProjectPreviewFixture() });
  await page.goto('/settings#mcp');
  await selectSettingsCategory(page, 'general');
  await selectSettingsCategory(page, 'mcp');
  await expect(page.locator('#plugins .plugin-card').first()).toBeAttached();
  await expect(page.locator('#subagents .subagent-profile-card').first()).toBeAttached();
  const count = (path: string) => api.requests.filter(request => request.method === 'GET' && request.path === path).length;
  const paths = ['/api/plugins', '/api/subagents/settings', '/api/tools', '/api/skills', '/api/models'];
  const before = paths.map(count);
  const section = page.locator('#mcp');
  await section.getByText('Paste and preview a server').click();
  await section.getByLabel('MCP server text').fill('npx -y fresh-mcp-tools');
  await section.getByRole('button', { name: 'Preview', exact: true }).click();
  await section.getByRole('button', { name: 'Configure project import' }).click();
  const dialog = page.getByRole('dialog', { name: 'Configure MCP import' });
  await dialog.getByLabel(/I trust this fresh project folder/u).check();
  await page.goBack();
  await expect(dialog).toBeHidden();
  await page.goForward();
  await expect(dialog.getByLabel(/I trust this fresh project folder/u)).toBeChecked();
  await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await dialog.getByRole('button', { name: 'Save atomically' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(section.getByRole('article', { name: 'fresh-tools: Configured', exact: true })).toBeVisible();
  for (let n = 0; n < paths.length; n++) await expect.poll(() => count(paths[n]!)).toBeGreaterThan(before[n]!);
  await expect(page).toHaveURL(/\/settings#mcp$/u);
  expect(api.requests.filter(request => request.path === '/api/agent/runs' || request.path === '/api/mcp/test')).toEqual([]);
});

for (const scenario of [
  { name: 'desktop-light', width: 1280, height: 900, theme: 'light' },
  { name: 'desktop-dark', width: 1280, height: 900, theme: 'dark' },
  { name: 'mobile-light', width: 390, height: 844, theme: 'light' },
  { name: 'mobile-dark', width: 390, height: 844, theme: 'dark' },
]) test(`Restored model navigation remains keyboard accessible and responsive: ${scenario.name}`, async ({ page }) => {
  await page.setViewportSize({ width: scenario.width, height: scenario.height });
  const api = await installMockApi(page);
  await page.addInitScript(theme => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme, lastSettingsSection: 'model' })), scenario.theme);
  await page.goto('/settings#model');
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('.app')).toHaveJSProperty('inert', true);
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  if (scenario.width <= 959) {
    expect(bounds!.x).toBe(0); expect(bounds!.y).toBe(0);
    expect(bounds!.width).toBe(scenario.width); expect(bounds!.height).toBe(scenario.height);
    const picker = dialog.getByRole('combobox', { name: 'Settings categories', exact: true });
    await expect(picker).toHaveValue('models');
    await expectThemeRoles(picker, '--surface-input');
    await expectContrast(picker);
    await expectContrast(picker, 'borderTopColor', 3);
  } else {
    expect(bounds!.x).toBeGreaterThanOrEqual(16); expect(bounds!.y).toBeGreaterThanOrEqual(16);
    const categories = dialog.getByRole('navigation', { name: 'Settings categories', exact: true });
    await expect(categories.getByRole('link')).toHaveText(['General', 'Models', 'Skills', 'Tools', 'Plugins', 'Child agents', 'MCP']);
    await expect(categories.getByRole('link', { name: 'Models', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.locator('.settings-dialog-header button').focus();
    for (const link of await categories.getByRole('link').all()) {
      await page.keyboard.press('Tab');
      await expect(link).toBeFocused();
      await expect(link).toHaveCSS('outline-style', 'solid');
      await expectContrast(link, 'outlineColor', 3);
      const clearance = await link.evaluate(element => {
        const style = getComputedStyle(element);
        const extent = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
        const bounds = element.getBoundingClientRect();
        const clip = element.closest('nav')!.getBoundingClientRect();
        return [bounds.left - clip.left, clip.right - bounds.right, bounds.top - clip.top, clip.bottom - bounds.bottom]
          .map(distance => distance - extent);
      });
      for (const distance of clearance) expect(distance).toBeGreaterThanOrEqual(0);
    }
    await expect(categories).toHaveScreenshot(`settings-categories-keyboard-${scenario.name}.png`);
  }
  await expect(page.locator('#appearance')).toBeHidden();
  const catalog = page.locator('#model .model-catalog');
  await catalog.locator('summary').click();
  await selectCatalogueModel(page, 'Mock (Testing)', 'mock-model');
  const row = catalog.locator('.model-catalog-row').first();
  await row.getByRole('checkbox').focus();
  await page.goto('/settings');
  await expect(row).toBeInViewport();
  // Sibling model forms are hidden; Tab wraps inside the dialog instead of entering them.
  await expect(page.locator('#custom-models')).toBeHidden();
  await row.getByRole('checkbox').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('.settings-dialog-header button')).toBeFocused();
  await row.getByRole('checkbox').focus();
  expect((await new AxeBuilder({ page }).include('#model').analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const draft = page.locator('#providers input[type="password"]').first();
  await selectProviderCredential(page, 'OpenAI');
  await draft.fill('SYNTHETIC_CATEGORY_DRAFT');
  await selectModelSettings(page, 'model');
  if (scenario.width > 959) {
    const general = page.locator('.settings-categories').getByRole('link', { name: 'General', exact: true });
    await general.focus(); await general.press('Enter');
  } else await selectSettingsCategory(page, 'general');
  await expect(page.locator('#appearance')).toBeVisible();
  await expect(page.locator('#model')).toBeHidden();
  await page.goBack();
  await expect(page).toHaveURL(/#model$/u);
  await expect(page.locator('#model')).toBeVisible();
  await expect(draft).toHaveValue('SYNTHETIC_CATEGORY_DRAFT');
  await page.goForward();
  await expect(page.locator('#appearance')).toBeVisible();
  await expect(page.locator('#model')).toBeHidden();
  await selectSettingsCategory(page, 'models');
  await selectModelSettings(page, 'providers');
  await expect(draft).toBeVisible();
  await expect(draft).toHaveValue('SYNTHETIC_CATEGORY_DRAFT');
  await selectModelSettings(page, 'model');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('SYNTHETIC_CATEGORY_DRAFT');
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain('SYNTHETIC_CATEGORY_DRAFT');
  expect(api.requests.filter(request => request.method === 'POST' && request.path === '/api/config')).toEqual([]);
  await row.getByRole('checkbox').focus();
  await expect(page.locator('#model')).toHaveScreenshot(`restored-model-${scenario.name}.png`);
});

test('Focus return waits for the same fresh row after an asynchronous section reload', async ({ page }) => {
  await installMockApi(page); await page.goto('/');
  const result = await page.evaluate(async modulePath => {
    const { bindSettingsNavigation } = await import(modulePath);
    const root = document.createElement('div');
    const markup = '<fieldset data-settings-group="one"><label data-settings-selection="row"><input aria-label="Owned control"></label></fieldset>';
    root.innerHTML = `<section id="model" class="settings-section">${markup}</section>`;
    root.style.cssText = 'position:fixed;top:0;left:0;z-index:10000;background:white'; document.body.append(root);
    const dispose = bindSettingsNavigation(root, { section: 'model', positions: {}, scopes: {} }, { save: () => {} });
    root.querySelector('input')!.focus();
    root.innerHTML = '<section id="model" class="settings-section"></section>';
    await Promise.resolve(); const fallbackReturned = document.activeElement === root.firstElementChild;
    root.firstElementChild!.innerHTML = markup;
    await Promise.resolve(); const lateReturned = document.activeElement === root.querySelector('input');
    dispose(); root.remove(); return { fallbackReturned, lateReturned };
  }, '/src/components/settings-navigation.ts');
  expect(result).toEqual({ fallbackReturned: true, lateReturned: true });
});

test('Deferred row return yields to newer pointer/focus, modal ownership and retired owners', async ({ page }) => {
  await installMockApi(page); await page.goto('/');
  const result = await page.evaluate(async modulePath => {
    const { bindSettingsNavigation } = await import(modulePath);
    const results: Record<string, boolean> = {};
    for (const kind of ['pointer', 'focus', 'modal', 'dispose', 'wheel', 'wheel-live']) {
      const root = document.createElement('div');
      const markup = '<fieldset data-settings-group="one"><label data-settings-selection="row"><input aria-label="Owned control"></label></fieldset>';
      root.innerHTML = `<section id="model" class="settings-section">${markup}</section>`;
      root.style.cssText = 'position:fixed;top:0;left:0;z-index:10000;background:white'; document.body.append(root);
      const dispose = bindSettingsNavigation(root, { section: 'model', positions: {}, scopes: {} }, { save: () => {} });
      root.querySelector('input')!.focus();
      if (kind === 'wheel-live') root.querySelector('input')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      root.innerHTML = '<section id="model" class="settings-section"></section>';
      await Promise.resolve();
      const newer = document.createElement('button'); document.body.append(newer);
      if (kind === 'pointer') newer.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      if (kind === 'wheel') newer.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      if (kind === 'focus') { newer.focus(); newer.remove(); }
      if (kind === 'modal') newer.setAttribute('aria-modal', 'true');
      if (kind === 'dispose') dispose();
      root.firstElementChild!.innerHTML = markup;
      await Promise.resolve(); results[kind] = document.activeElement !== root.querySelector('input');
      dispose(); root.remove(); newer.remove();
    }
    return results;
  }, '/src/components/settings-navigation.ts');
  expect(result).toEqual({ pointer: true, focus: true, modal: true, dispose: true, wheel: true, 'wheel-live': true });
});

test.describe('Coarse Settings focus return', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test('returns to the owned row region without automatically focusing an editable replacement', async ({ page }) => {
    await installMockApi(page); await page.goto('/');
    const result = await page.evaluate(async modulePath => {
      const { bindSettingsNavigation } = await import(modulePath);
      const root = document.createElement('div');
      const markup = '<section id="model" class="settings-section"><label data-settings-selection="row"><input aria-label="Owned editable"></label></section>';
      root.innerHTML = markup;
      root.style.cssText = 'position:fixed;top:0;left:0;z-index:10000;background:white'; document.body.append(root);
      const dispose = bindSettingsNavigation(root, { section: 'model', positions: {}, scopes: {} }, { save: () => {} });
      root.querySelector('input')!.focus(); root.innerHTML = markup;
      await Promise.resolve();
      const result = { coarse: matchMedia('(pointer: coarse)').matches, region: document.activeElement === root.querySelector('label'),
        editable: document.activeElement === root.querySelector('input') };
      dispose(); root.remove(); return result;
    }, '/src/components/settings-navigation.ts');
    expect(result).toEqual({ coarse: true, region: true, editable: false });
  });
});

test('DOM navigation resolves only exact fresh unique identities and returns focus without stealing newer intent', async ({ page }) => {
  await installMockApi(page); await page.goto('/');
  const result = await page.evaluate(async modulePath => {
    const { bindSettingsNavigation, settingsPositionTarget } = await import(modulePath);
    const host = document.createElement('div');
    host.setAttribute('role', 'dialog'); // The Settings owner itself must not suppress row return.
    host.innerHTML = '<section id="model" class="settings-section"><fieldset data-settings-group="one"><label data-settings-selection="row"><input aria-label="Owned control"></label></fieldset><fieldset data-settings-group="two"><label data-settings-selection="row"><input aria-label="Other control"></label></fieldset></section>';
    host.style.cssText = 'position:fixed;top:0;left:0;z-index:10000;background:white'; document.body.append(host);
    const target = settingsPositionTarget(host, 'model', { group: 'one', selection: 'row' });
    const exact = target === host.querySelector('[data-settings-selection]');
    const missingGroup = settingsPositionTarget(host, 'model', { group: 'missing', selection: 'row' }) === host.firstElementChild;
    const ambiguous = settingsPositionTarget(host, 'model', { selection: 'row' }) === host.firstElementChild;
    const nested = document.createElement('fieldset'); nested.setAttribute('data-settings-group', 'nested');
    nested.innerHTML = '<label data-settings-selection="nested-row">Nested</label><label data-settings-selection="row">Other owner</label>';
    host.querySelector('fieldset')!.append(nested);
    const nestedNotBorrowed = settingsPositionTarget(host, 'model', { group: 'one', selection: 'nested-row' }) === host.querySelector('fieldset');
    const nestedDuplicateExcluded = settingsPositionTarget(host, 'model', { group: 'one', selection: 'row' }) === target;
    const dispose = bindSettingsNavigation(host, { section: 'model', positions: {}, scopes: {} }, { save: () => {} });
    const original = host.querySelector('input')!; original.focus();
    const replacement = original.cloneNode(true) as HTMLInputElement; original.replaceWith(replacement);
    await Promise.resolve(); const returned = document.activeElement === replacement;
    const newer = document.createElement('button'); document.body.append(newer);
    const next = replacement.cloneNode(true) as HTMLInputElement; replacement.replaceWith(next); newer.focus();
    await Promise.resolve(); const conserved = document.activeElement === newer;
    next.focus(); dispose(); const retired = next.cloneNode(true) as HTMLInputElement; next.replaceWith(retired);
    await Promise.resolve(); const noLateReturn = document.activeElement !== retired;
    host.innerHTML = '<section id="tools" class="settings-section"><label>Scope<select><option value="global">Global</option></select></label></section>';
    const disposeLabel = bindSettingsNavigation(host, { section: 'tools', positions: {}, scopes: {} }, { save: () => {} });
    host.querySelector('select')!.focus();
    host.innerHTML = '<section id="tools" class="settings-section"><label>Scope<select><option value="project">Project</option></select></label></section>';
    await Promise.resolve();
    const implicitLabelReturned = document.activeElement === host.querySelector('select');
    const freshValueConserved = host.querySelector('select')!.value === 'project';
    const live = host.querySelector('select')!;
    live.disabled = true; await Promise.resolve();
    live.disabled = false; await Promise.resolve();
    const enabledReturn = document.activeElement === live;
    live.disabled = true; await Promise.resolve(); newer.focus();
    live.disabled = false; await Promise.resolve();
    const busyNewerConserved = document.activeElement === newer;
    disposeLabel();
    host.innerHTML = '<section id="model" class="settings-section"><button>Open</button></section>';
    const saves: string[] = [];
    const disposeModal = bindSettingsNavigation(host, { section: 'model', positions: {}, scopes: {} }, { save: (section: string) => saves.push(section) });
    const opener = host.querySelector('button')!; opener.focus();
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
    dialog.innerHTML = '<input aria-label="Modal owned input">'; host.firstElementChild!.append(dialog);
    dialog.querySelector('input')!.focus(); dialog.remove(); await Promise.resolve();
    const modalNotRecorded = saves.length === 1;
    const modalNotStolen = document.activeElement === document.body;
    if (modalNotStolen) opener.focus(); // Existing dialog return owner, not navigation.
    const modalOwnerReturned = document.activeElement === opener;
    host.firstElementChild!.append(dialog); dialog.querySelector('input')!.focus(); dialog.remove();
    await Promise.resolve(); const modalGapDelegated = document.activeElement === document.body;
    host.innerHTML = '<section id="model" class="settings-section"><button>Fresh</button></section>';
    await Promise.resolve();
    const retiredInvokerHandedOff = document.activeElement === host.firstElementChild;
    host.querySelector('button')!.focus(); host.firstElementChild!.append(dialog); dialog.querySelector('input')!.focus();
    host.innerHTML = '<section id="model" class="settings-section"><button>Newer</button></section>';
    newer.focus(); await Promise.resolve();
    const retiredDialogNewerConserved = document.activeElement === newer;
    disposeModal(); newer.remove();
    // A modal shell may commit before its own initial-focus task. Hash entry is
    // metadata intent, never permission to focus the background in that gap.
    host.innerHTML = '<section id="mcp" class="settings-section"><button>Background</button><div role="dialog" aria-modal="true"><input aria-label="Pending modal input"></div></section>';
    const entrySaves: string[] = [];
    const disposeEntry = bindSettingsNavigation(host, { section: 'model', positions: {}, scopes: {} },
      { hash: '#mcp', save: (section: string) => entrySaves.push(section) });
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    const passiveModalEntry = document.activeElement === document.body;
    const hashEntryRecorded = entrySaves.length === 1 && entrySaves[0] === 'mcp';
    disposeEntry();
    // A host's passive initialization must finish before its initial scroll.
    // Layout listeners still own metadata, newer intent and context cleanup.
    host.style.cssText = 'position:fixed;top:0;left:0;z-index:10000;width:240px;height:120px;overflow-y:auto;background:white';
    const entryMarkup = '<div style="height:800px"></div><section id="model" class="settings-section"><button>Fresh entry</button></section>';
    const frames = () => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    host.innerHTML = entryMarkup; host.scrollTop = 0;
    let releaseEntry!: () => void;
    const entryReady = new Promise<void>(resolve => { releaseEntry = resolve; });
    const readySaves: string[] = [];
    const disposeReady = bindSettingsNavigation(host, { section: 'model', positions: {}, scopes: {} },
      { hash: '#model', entryReady, save: (section: string) => readySaves.push(section) });
    host.append(document.createElement('span')); // Exercise the pre-ready observer path too.
    await frames();
    const entryWaitedForPassiveReady = host.scrollTop === 0;
    const entryHashRecordedBeforeReady = readySaves.length === 1 && readySaves[0] === 'model';
    releaseEntry(); await frames();
    const entryRestoredAfterReady = host.scrollTop > 0;
    disposeReady();
    host.innerHTML = entryMarkup; host.scrollTop = 0;
    let releaseDisposed!: () => void;
    const disposedReady = new Promise<void>(resolve => { releaseDisposed = resolve; });
    const disposeBeforeReady = bindSettingsNavigation(host, { section: 'model', positions: {}, scopes: {} },
      { entryReady: disposedReady, save: () => {} });
    disposeBeforeReady(); releaseDisposed(); await frames();
    const disposedEntryRemainedIdle = host.scrollTop === 0;
    host.innerHTML = entryMarkup; host.scrollTop = 0;
    let releaseIntent!: () => void;
    const intentReady = new Promise<void>(resolve => { releaseIntent = resolve; });
    const disposeIntent = bindSettingsNavigation(host, { section: 'model', positions: {}, scopes: {} },
      { entryReady: intentReady, save: () => {} });
    host.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 20 }));
    releaseIntent(); await frames();
    const newerEntryIntentConserved = host.scrollTop === 0;
    disposeIntent();
    // Forward the genuine native method on this disposable fixture node only.
    // Unrelated lazy content must not force geometry reads of a live control.
    host.innerHTML = '<section id="model" class="settings-section"><button aria-label="Live control">Live</button><div data-unrelated></div></section>';
    const passiveControl = host.querySelector('button')!, nativeRects = passiveControl.getClientRects;
    let unrelatedLiveControlLayoutReads = 0;
    passiveControl.getClientRects = () => { unrelatedLiveControlLayoutReads++; return nativeRects.call(passiveControl); };
    const disposePassive = bindSettingsNavigation(host, { section: 'model', positions: {}, scopes: {} }, { save: () => {} });
    let unrelatedLiveControlFocusConserved = false;
    try {
      await frames(); passiveControl.focus(); await frames(); unrelatedLiveControlLayoutReads = 0;
      host.querySelector('[data-unrelated]')!.append(document.createElement('span')); await frames();
      unrelatedLiveControlFocusConserved = document.activeElement === passiveControl;
    } finally { disposePassive(); Reflect.deleteProperty(passiveControl, 'getClientRects'); }
    host.remove();
    return { exact, missingGroup, ambiguous, nestedNotBorrowed, nestedDuplicateExcluded, returned, conserved, noLateReturn,
      implicitLabelReturned, freshValueConserved, enabledReturn, busyNewerConserved, modalNotRecorded, modalNotStolen,
      modalOwnerReturned, modalGapDelegated, retiredInvokerHandedOff, retiredDialogNewerConserved, passiveModalEntry, hashEntryRecorded,
      entryWaitedForPassiveReady, entryHashRecordedBeforeReady, entryRestoredAfterReady, disposedEntryRemainedIdle, newerEntryIntentConserved,
      unrelatedLiveControlLayoutReads, unrelatedLiveControlFocusConserved };
  }, '/src/components/settings-navigation.ts');
  expect(result).toEqual({ exact: true, missingGroup: true, ambiguous: true, nestedNotBorrowed: true, nestedDuplicateExcluded: true,
    returned: true, conserved: true, noLateReturn: true, implicitLabelReturned: true, freshValueConserved: true,
    enabledReturn: true, busyNewerConserved: true, modalNotRecorded: true, modalNotStolen: true, modalOwnerReturned: true,
    modalGapDelegated: true, retiredInvokerHandedOff: true, retiredDialogNewerConserved: true, passiveModalEntry: true, hashEntryRecorded: true,
    entryWaitedForPassiveReady: true, entryHashRecordedBeforeReady: true, entryRestoredAfterReady: true,
    disposedEntryRemainedIdle: true, newerEntryIntentConserved: true,
    unrelatedLiveControlLayoutReads: 0, unrelatedLiveControlFocusConserved: true });
});
