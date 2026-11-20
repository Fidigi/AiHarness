import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures/test-budget';
import { expectContrast } from './fixtures/contrast';
import { installMockApi } from './fixtures/mock-api';
import { selectCustomModel, selectGeneralSettings, selectPluginPackage, selectProviderConnection, selectProviderCredential, selectSettingsCategory, selectSubagentProfile } from './fixtures/settings-navigation';

for (const scenario of [
  { locale: 'en', width: 1280 },
  { locale: 'fr', width: 1280 },
  { locale: 'en', width: 390 },
  { locale: 'fr', width: 390 },
] as const) test(`Settings close protects credential and scoped-default drafts: ${scenario.width}px ${scenario.locale}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: scenario.width, height: 844 });
  await page.addInitScript(locale => {
    localStorage.setItem('ai-harness-locale', locale);
    localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme: locale === 'fr' ? 'dark' : 'light' }));
  }, scenario.locale);
  const api = await installMockApi(page, { configurationScopes: { global: {}, project: { model: 'saved-model' } } });
  const confirmation = scenario.locale === 'fr'
    ? 'Abandonner les modifications non enregistrées des paramètres ?'
    : 'Discard unsaved Settings edits?';
  const nativePrompts: string[] = [];
  page.on('dialog', async dialog => { nativePrompts.push(dialog.message()); await dialog.dismiss(); });
  const prompt = page.getByRole('alertdialog', { name: confirmation, exact: true });
  const keep = prompt.getByRole('button', { name: scenario.locale === 'fr' ? 'Continuer la modification' : 'Keep editing', exact: true });
  const discard = prompt.getByRole('button', { name: scenario.locale === 'fr' ? 'Abandonner les modifications' : 'Discard edits', exact: true });
  const save = scenario.locale === 'fr' ? 'Enregistrer' : 'Save';
  const secret = 'SYNTHETIC_SETTINGS_CLOSE_SECRET';
  await page.goto('/settings#providers');
  await selectProviderCredential(page, 'OpenAI');
  const credential = page.locator('#providers .credential-context-detail input[type="password"]:visible');
  await credential.fill(secret);
  await selectGeneralSettings(page, 'behavior');
  const defaults = page.locator('#defaults');
  const model = defaults.getByLabel(scenario.locale === 'fr' ? 'Modèle' : 'Model', { exact: true });
  await expect(model).toHaveValue('saved-model'); await model.fill('draft-model');
  const close = page.locator('.settings-dialog-header button');
  await close.focus(); await close.press('Enter');
  await expect(prompt).toBeVisible(); await expect(keep).toBeFocused();
  for (const button of [keep, discard]) {
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const clearance = await button.evaluate(element => {
      const box = element.getBoundingClientRect(), clip = element.closest('section')!.getBoundingClientRect(), style = getComputedStyle(element);
      const extent = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
      return Math.min(box.left - clip.left, clip.right - box.right, box.top - clip.top, clip.bottom - box.bottom,
        box.left, innerWidth - box.right, box.top, innerHeight - box.bottom) - extent;
    });
    expect(clearance).toBeGreaterThanOrEqual(-0.1);
  }
  await page.keyboard.press('Shift+Tab'); await expect(discard).toBeFocused();
  await expect(discard).toHaveCSS('outline-style', 'solid'); await expectContrast(discard, 'outlineColor', 3);
  await page.keyboard.press('Tab'); await expect(keep).toBeFocused();
  await expect(keep).toHaveCSS('outline-style', 'solid'); await expectContrast(keep, 'outlineColor', 3);
  expect((await new AxeBuilder({ page }).include('.settings-discard-dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
  const capture = testInfo.outputPath(`settings-discard-${scenario.width}-${scenario.locale}.png`);
  await page.screenshot({ path: capture, animations: 'disabled', caret: 'hide' });
  await testInfo.attach('settings-discard', { path: capture, contentType: 'image/png' });
  await expect(prompt).toHaveScreenshot(`settings-discard-${scenario.width}-${scenario.locale}.png`);
  await keep.click(); await expect(prompt).toHaveCount(0);
  await expect(page.locator('.settings-dialog')).toBeVisible(); await expect(model).toHaveValue('draft-model');
  expect(api.requests.filter(request => request.method !== 'GET'
    && !['/api/workspaces/validate', '/api/mcp/oauth/status'].includes(request.path))).toEqual([]);
  await defaults.getByRole('button', { name: save, exact: true }).click();
  await expect(defaults.getByRole('button', { name: save, exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(prompt).toBeVisible(); // Saving one owner cannot clear the other.
  await page.keyboard.press('Escape'); await expect(prompt).toHaveCount(0);
  await expect(page.locator('.settings-dialog')).toBeVisible();
  await selectProviderCredential(page, 'OpenAI'); await expect(credential).toHaveValue(secret);
  await page.locator('#providers .credential-context-detail').getByRole('button', { name: save, exact: true }).click();
  await expect(credential).toHaveValue('••••••••');
  await close.click(); await expect(page.locator('.settings-dialog')).toHaveCount(0);
  await expect(prompt).toHaveCount(0);
  expect(api.requests.filter(request => request.path === '/api/configuration/scope' && request.method === 'PATCH').map(request => request.body))
    .toEqual([{ scope: 'project', scopeId: 'workspace-e2e', values: { model: 'draft-model' } }]);
  expect(api.requests.filter(request => request.path === '/api/config' && request.method === 'POST').map(request => request.body))
    .toEqual([{ type: 'openai', apiKey: secret }]);
  await page.goto('/settings#providers'); await selectProviderCredential(page, 'OpenAI');
  await credential.fill('SYNTHETIC_DISCARDED_SETTINGS_SECRET');
  await close.click(); await expect(prompt).toBeVisible(); await discard.click();
  await expect(page.locator('.settings-dialog')).toHaveCount(0); await expect(prompt).toHaveCount(0);
  expect(api.requests.filter(request => request.path === '/api/config' && request.method === 'POST')).toHaveLength(1);
  await page.goto('/settings#providers'); await selectProviderCredential(page, 'OpenAI');
  await expect(credential).not.toHaveValue('SYNTHETIC_DISCARDED_SETTINGS_SECRET');
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(stored).not.toContain(secret); expect(stored).not.toContain('SYNTHETIC_DISCARDED_SETTINGS_SECRET');
  expect(nativePrompts).toEqual([]);
});

test('Pending palette Escape does not ask to discard Settings drafts', async ({ page }) => {
  const api = await installMockApi(page);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { entered = resolve; });
  await page.route('**/src/components/CommandPalette.tsx*', async route => { entered(); await held; await route.continue(); });
  try {
    await page.goto('/settings#providers'); await selectProviderCredential(page, 'OpenAI');
    const credential = page.locator('#providers .credential-context-detail input[type="password"]:visible');
    await credential.fill('SYNTHETIC_PENDING_PALETTE_SECRET');
    await page.keyboard.press('Control+k'); await requested;
    await page.keyboard.press('Escape');
    await expect(page.locator('.settings-dialog')).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(credential).toHaveValue('SYNTHETIC_PENDING_PALETTE_SECRET');
    const response = page.waitForResponse(response => response.url().includes('/src/components/CommandPalette.tsx'));
    release(); await response;
    await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
    await expect(page.locator('.global-command-palette')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog', { name: 'Discard unsaved Settings edits?', exact: true })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(credential).toHaveValue('SYNTHETIC_PENDING_PALETTE_SECRET');
    expect(api.requests.filter(request => request.method !== 'GET'
      && !['/api/workspaces/validate', '/api/mcp/oauth/status'].includes(request.path))).toEqual([]);
  } finally { release(); }
});

test('External trust withdrawal retires dirty forms even while discard confirmation is open', async ({ page }) => {
  const api = await installMockApi(page, { workspaceTrusted: true, workspaceOperationTrusted: true,
    configurationScopes: { global: {}, project: { model: 'saved-project-model' } } });
  const nativePrompts: string[] = [];
  page.on('dialog', async dialog => { nativePrompts.push(dialog.message()); await dialog.dismiss(); });
  await page.goto('/settings#providers'); await selectProviderCredential(page, 'OpenAI');
  const credential = page.locator('#providers .credential-context-detail input[type="password"]:visible');
  const initial = await credential.inputValue();
  await credential.fill('SYNTHETIC_RETIRED_SETTINGS_SECRET');
  await selectGeneralSettings(page, 'behavior');
  const model = page.locator('#defaults').getByLabel('Model', { exact: true });
  await expect(model).toHaveValue('saved-project-model'); await model.fill('retired-project-draft');
  await page.locator('.settings-dialog-header button').click();
  await expect(page.getByRole('alertdialog', { name: 'Discard unsaved Settings edits?', exact: true })).toBeVisible();
  await page.evaluate(async path => {
    const { useSessionStore } = await import(path);
    const workspace = useSessionStore.getState().workspace;
    useSessionStore.setState({ workspace: { ...workspace, trusted: false, operationTrusted: false } });
  }, '/src/store/session-store.ts');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(model).toHaveValue('saved-project-model');
  await selectProviderCredential(page, 'OpenAI'); await expect(credential).toHaveValue(initial);
  await page.locator('.settings-dialog-header button').click();
  await expect(page.locator('.settings-dialog')).toHaveCount(0);
  expect(nativePrompts).toEqual([]);
  expect(api.requests.filter(request => request.method !== 'GET'
    && !['/api/workspaces/validate', '/api/mcp/oauth/status'].includes(request.path))).toEqual([]);
});

test('Access drafts stop guarding after explicit Apply; browser preferences remain immediate', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ai-harness-locale', 'fr'));
  const api = await installMockApi(page);
  await page.goto('/settings#authentication');
  const access = page.locator('#authentication'), token = access.locator('input[type="password"]');
  await token.fill('SYNTHETIC_ACCESS_EDIT_NOT_APPLIED');
  await selectGeneralSettings(page, 'appearance');
  await page.locator('#appearance').getByRole('combobox').selectOption('dark');
  await page.locator('.settings-dialog-header button').click();
  const prompt = page.getByRole('alertdialog', { name: 'Abandonner les modifications non enregistrées des paramètres ?', exact: true });
  await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Continuer la modification', exact: true }).click();
  await selectGeneralSettings(page, 'authentication'); await expect(token).toHaveValue('SYNTHETIC_ACCESS_EDIT_NOT_APPLIED');
  expect(await page.evaluate(() => localStorage.getItem('ai-harness-auth-token'))).toBeNull();
  await access.getByRole('button', { name: 'Appliquer', exact: true }).click();
  await page.locator('.settings-dialog-header button').click();
  await expect(page.locator('.settings-dialog')).toHaveCount(0); await expect(prompt).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ai-harness-preferences-v4')!).theme)).toBe('dark');
  expect(api.requests.filter(request => request.method !== 'GET'
    && !['/api/workspaces/validate', '/api/mcp/oauth/status'].includes(request.path))).toEqual([]);
});

test('Pending and failed credential writes never report the draft clean', async ({ page }) => {
  const api = await installMockApi(page);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { entered = resolve; });
  const writes: unknown[] = [];
  await page.route('**/api/config', async route => {
    writes.push(route.request().postDataJSON());
    entered(); await held; await route.fulfill({ status: 500, json: { error: 'Synthetic credential write failure' } });
  });
  try {
    await page.goto('/settings#providers'); await selectProviderCredential(page, 'OpenAI');
    const detail = page.locator('#providers .credential-context-detail'), credential = detail.locator('input[type="password"]:visible');
    await credential.fill('SYNTHETIC_FAILED_CREDENTIAL_EDIT');
    await detail.getByRole('button', { name: 'Save', exact: true }).click(); await requested;
    const close = page.locator('.settings-dialog-header button'); await close.click();
    const prompt = page.getByRole('alertdialog', { name: 'Discard unsaved Settings edits?', exact: true });
    await expect(prompt).toBeVisible(); await expect(prompt).toContainText('Saves already started may still finish.');
    await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
    const response = page.waitForResponse(response => response.url().endsWith('/api/config') && response.request().method() === 'POST');
    release(); expect((await response).status()).toBe(500);
    await expect(detail.getByRole('alert')).toHaveText('HTTP 500');
    await expect(detail).not.toContainText('Synthetic credential write failure');
    await expect(credential).toHaveValue('SYNTHETIC_FAILED_CREDENTIAL_EDIT');
    await close.click(); await expect(prompt).toBeVisible();
    await prompt.getByRole('button', { name: 'Discard edits', exact: true }).click();
    await expect(page.locator('.settings-dialog')).toHaveCount(0);
    expect(writes).toEqual([{ type: 'openai', apiKey: 'SYNTHETIC_FAILED_CREDENTIAL_EDIT' }]);
    expect(api.requests.filter(request => request.path === '/api/config' && request.method === 'POST')).toEqual([]);
  } finally { release(); }
});

test('Cleared and incomplete credential values remain drafts without changing save authority', async ({ page }) => {
  const api = await installMockApi(page);
  await page.goto('/settings#providers'); await selectProviderCredential(page, 'OpenAI');
  const detail = page.locator('#providers .credential-context-detail'), credential = detail.locator('input[type="password"]:visible');
  await credential.fill('SYNTHETIC_SAVED_KEY_BASELINE'); await detail.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(credential).toHaveValue('••••••••'); await credential.fill('');
  const close = page.locator('.settings-dialog-header button'); await close.click();
  const prompt = page.getByRole('alertdialog', { name: 'Discard unsaved Settings edits?', exact: true });
  await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(credential).toHaveValue(''); await credential.fill('••••••••');
  await close.click(); await expect(page.locator('.settings-dialog')).toHaveCount(0); await expect(prompt).toHaveCount(0);
  await page.goto('/settings#providers'); await selectProviderCredential(page, 'OpenAI');
  await credential.fill('SYNTHETIC•INCOMPLETE_KEY'); await detail.getByRole('button', { name: 'Save', exact: true }).click();
  await close.click(); await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Discard edits', exact: true }).click();
  await expect(page.locator('.settings-dialog')).toHaveCount(0);
  expect(api.requests.filter(request => request.path === '/api/config' && request.method === 'POST').map(request => request.body))
    .toEqual([{ type: 'openai', apiKey: 'SYNTHETIC_SAVED_KEY_BASELINE' }]);
});

test('Clearing an applied Access token is an unsaved edit until explicit Apply', async ({ page }) => {
  const api = await installMockApi(page);
  await page.goto('/settings#authentication');
  const access = page.locator('#authentication'), token = access.locator('input[type="password"]');
  await token.fill('SYNTHETIC_APPLIED_ACCESS_BASELINE'); await access.getByRole('button', { name: 'Apply', exact: true }).click();
  await token.fill(''); await page.locator('.settings-dialog-header button').click();
  const prompt = page.getByRole('alertdialog', { name: 'Discard unsaved Settings edits?', exact: true });
  await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(token).toHaveValue(''); await access.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.locator('.settings-dialog-header button').click();
  await expect(page.locator('.settings-dialog')).toHaveCount(0); await expect(prompt).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('ai-harness-auth-token'))).toBeNull();
  expect(api.requests.filter(request => request.method !== 'GET'
    && !['/api/workspaces/validate', '/api/mcp/oauth/status'].includes(request.path))).toEqual([]);
});

test('Provider editor drafts guard dismissal without retargeting the original save', async ({ page }) => {
  const provider = { id: 'fixture-a', name: 'Fixture A', baseUrl: 'https://provider.example.test/v1', dialect: 'openai-completions',
    headerNames: [], configured: true, modelCount: 1, createdAt: '', updatedAt: '', revision: 'a'.repeat(64) };
  const api = await installMockApi(page, { customProviders: [provider, { ...provider, id: 'fixture-b', name: 'Fixture B' }] });
  const section = page.locator('#provider-lifecycle'), form = section.locator('.custom-resource-editor form');
  const close = page.locator('.settings-dialog-header button');
  const prompt = page.getByRole('alertdialog', { name: 'Discard unsaved Settings edits?', exact: true });
  await page.goto('/settings#provider-lifecycle'); await selectProviderConnection(page, 'custom', 'fixture-a');
  await section.locator('.provider-context-detail').getByRole('button', { name: 'Edit', exact: true }).click();
  await form.getByLabel('Name', { exact: true }).fill('Temporary reverted name');
  await form.getByLabel('Name', { exact: true }).fill(provider.name);
  await close.click(); await expect(page.locator('.settings-dialog')).toHaveCount(0); await expect(prompt).toHaveCount(0);
  await page.goto('/settings#provider-lifecycle'); await selectProviderConnection(page, 'custom', 'fixture-a');
  await section.locator('.provider-context-detail').getByRole('button', { name: 'Edit', exact: true }).click();
  await form.getByLabel('Name', { exact: true }).fill('Edited fixture A');
  await form.getByLabel('API key', { exact: true }).fill('SYNTHETIC_PROVIDER_EDITOR_DRAFT');
  await selectProviderConnection(page, 'custom', 'fixture-b'); await close.click();
  await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(form.getByLabel('ID', { exact: true })).toHaveValue('fixture-a');
  await expect(form.getByLabel('API key', { exact: true })).toHaveValue('SYNTHETIC_PROVIDER_EDITOR_DRAFT');
  expect(api.requests.filter(request => request.path.startsWith('/api/provider-registry/custom') && request.method !== 'GET')).toEqual([]);
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form.getByLabel('ID', { exact: true })).toHaveValue('');
  expect(api.requests.filter(request => request.path.startsWith('/api/provider-registry/custom') && request.method !== 'GET')
    .map(({ method, path, body }) => ({ method, path, body }))).toEqual([{ method: 'PUT', path: '/api/provider-registry/custom/fixture-a', body: {
      id: 'fixture-a', name: 'Edited fixture A', baseUrl: provider.baseUrl, dialect: provider.dialect, apiKey: 'SYNTHETIC_PROVIDER_EDITOR_DRAFT',
    } }]);
  await close.click(); await expect(page.locator('.settings-dialog')).toHaveCount(0); await expect(prompt).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('SYNTHETIC_PROVIDER_EDITOR_DRAFT');
});

test('Custom model editor drafts guard mobile dismissal without saving the browsed definition', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await installMockApi(page, { customModels: ['openai:first', 'azure:second'].map(key => ({
    key, provider: key.split(':')[0]!, id: key.split(':')[1]!, name: key,
    capabilities: { reasoning: true, imageInput: false, toolCalls: true }, contextWindow: 64000, maxOutputTokens: 4096,
    createdAt: '2025-01-01T12:00:00.000Z', updatedAt: '2025-01-01T12:00:00.000Z',
  })) });
  const section = page.locator('#custom-models'), editor = section.locator('.custom-resource-editor');
  const close = page.locator('.settings-dialog-header button');
  const prompt = page.getByRole('alertdialog', { name: 'Discard unsaved Settings edits?', exact: true });
  await page.goto('/settings#custom-models'); await selectCustomModel(page, 'openai:first');
  await section.locator('.custom-model-context-detail').getByRole('button', { name: 'Edit', exact: true }).click();
  await editor.locator('summary').focus(); await editor.locator('summary').click();
  await editor.getByRole('checkbox', { name: 'reasoning', exact: true }).uncheck();
  await editor.getByRole('checkbox', { name: 'reasoning', exact: true }).check();
  await close.click(); await expect(page.locator('.settings-dialog')).toHaveCount(0); await expect(prompt).toHaveCount(0);
  await page.goto('/settings#custom-models'); await selectCustomModel(page, 'openai:first');
  await section.locator('.custom-model-context-detail').getByRole('button', { name: 'Edit', exact: true }).click();
  await editor.locator('summary').focus(); await editor.locator('summary').click();
  await editor.getByLabel('Name', { exact: true }).fill('Edited original model');
  await selectCustomModel(page, 'azure:second'); await close.click();
  await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(editor.getByLabel('ID', { exact: true })).toHaveValue('first');
  await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Edited original model');
  expect(api.requests.filter(request => request.path.startsWith('/api/provider-registry/models') && request.method !== 'GET')).toEqual([]);
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor.getByLabel('ID', { exact: true })).toHaveValue('');
  expect(api.requests.filter(request => request.path.startsWith('/api/provider-registry/models') && request.method !== 'GET')
    .map(({ method, path, body }) => ({ method, path, body }))).toEqual([{ method: 'PUT', path: '/api/provider-registry/models/openai%3Afirst', body: {
      provider: 'openai', id: 'first', name: 'Edited original model', capabilities: { reasoning: true, imageInput: false, toolCalls: true },
      contextWindow: 64000, maxOutputTokens: 4096, pricing: {}, compatibility: {},
    } }]);
  await close.click(); await expect(page.locator('.settings-dialog')).toHaveCount(0); await expect(prompt).toHaveCount(0);
});

test('Plugin install drafts guard mobile dismissal and clear only after canonical installation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await installMockApi(page, { workspaceTrusted: true, workspaceOperationTrusted: true });
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { entered = resolve; });
  await page.route('**/api/plugins', async route => {
    if (route.request().method() === 'POST' && route.request().postDataJSON().action === 'install') { entered(); await held; }
    await route.fallback();
  });
  try {
    await page.goto('/settings#plugins');
    const section = page.locator('#plugins'), source = section.getByLabel('Package source', { exact: true });
    await source.fill('npm:@example/guarded-install');
    await section.getByLabel('Install scope', { exact: true }).selectOption('project');
    await selectPluginPackage(page, 'global', '@aiharness/review-kit');
    const close = page.locator('.settings-dialog-header button'); await close.click();
    const prompt = page.getByRole('alertdialog', { name: 'Discard unsaved Settings edits?', exact: true });
    await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(source).toHaveValue('npm:@example/guarded-install');
    expect(api.requests.filter(request => request.path.startsWith('/api/plugins') && request.method !== 'GET')).toEqual([]);
    await section.getByRole('button', { name: 'Install', exact: true }).click(); await requested;
    await close.click(); await expect(prompt).toBeVisible(); await expect(prompt).toContainText('Saves already started may still finish.');
    await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
    release(); await expect(source).toHaveValue('');
    expect(api.requests.filter(request => request.path.startsWith('/api/plugins') && request.method !== 'GET').map(request => request.body))
      .toEqual([{ action: 'install', source: 'npm:@example/guarded-install', scope: 'project', cwd: '/workspace', projectId: 'workspace-e2e' }]);
    await close.click(); await expect(page.locator('.settings-dialog')).toHaveCount(0); await expect(prompt).toHaveCount(0);
  } finally { release(); }
});

test('MCP import source drafts guard outer dismissal without preview or consent', async ({ page }) => {
  const api = await installMockApi(page);
  await page.goto('/settings#mcp');
  const panel = page.locator('.mcp-import-panel');
  await panel.locator('summary').focus(); await panel.locator('summary').click();
  const source = panel.locator('textarea');
  const value = '{"mcpServers":{"fixture":{"command":"node","args":["noop"],"env":{"KEY":"SYNTHETIC_MCP_SOURCE_DRAFT"}}}}';
  await source.fill(value); await page.locator('.settings-dialog-header button').click();
  const prompt = page.getByRole('alertdialog', { name: 'Discard unsaved Settings edits?', exact: true });
  await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(source).toHaveValue(value);
  expect(api.requests.filter(request => request.method !== 'GET'
    && !['/api/workspaces/validate', '/api/mcp/oauth/status'].includes(request.path))).toEqual([]);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('SYNTHETIC_MCP_SOURCE_DRAFT');
  await panel.getByRole('button', { name: 'Clear paste', exact: true }).click();
  await page.locator('.settings-dialog-header button').click();
  await expect(page.locator('.settings-dialog')).toHaveCount(0); await expect(prompt).toHaveCount(0);
});

test('Child profile editor drafts survive declined outer dismissal without changing requested scope', async ({ page }) => {
  const api = await installMockApi(page);
  await page.goto('/settings#subagents'); await selectSubagentProfile(page, 'Explore');
  const section = page.locator('#subagents');
  await section.getByRole('article', { name: 'Explore', exact: true }).getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = section.locator('.subagent-profile-editor');
  await editor.getByLabel('Name', { exact: true }).fill('Temporary profile name');
  await editor.getByLabel('Name', { exact: true }).fill('Explore');
  await page.locator('.settings-dialog-header button').click();
  await expect(page.locator('.settings-dialog')).toHaveCount(0); await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await page.goto('/settings#subagents'); await selectSubagentProfile(page, 'Explore');
  await section.getByRole('article', { name: 'Explore', exact: true }).getByRole('button', { name: 'Edit', exact: true }).click();
  await editor.getByLabel('Name', { exact: true }).fill('Edited profile draft');
  await selectGeneralSettings(page, 'appearance'); await page.locator('.settings-dialog-header button').click();
  const prompt = page.getByRole('alertdialog', { name: 'Discard unsaved Settings edits?', exact: true });
  await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await selectSettingsCategory(page, 'subagents'); await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Edited profile draft');
  expect(api.requests.filter(request => request.path.startsWith('/api/subagents') && request.method !== 'GET')).toEqual([]);
  await editor.getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor).toHaveCount(0);
  expect(api.requests.filter(request => request.path === '/api/subagents/profiles/explore' && request.method === 'PATCH').map(request => request.body))
    .toEqual([{ profile: { name: 'Edited profile draft', description: 'Explore child-agent profile', instructions: 'Explore the delegated task.',
      kind: 'explore', enabled: true, tools: ['ls', 'read', 'grep', 'find'], skills: [], extensions: [], model: null, thinking: null,
      maxTurns: 8, inheritContext: true, background: true }, cwd: '/workspace', projectId: 'workspace-e2e', scope: 'project' }]);
  await page.locator('.settings-dialog-header button').click();
  await expect(page.locator('.settings-dialog')).toHaveCount(0); await expect(prompt).toHaveCount(0);
});

test('Collapsed provider rename drafts still guard dismissal without renaming', async ({ page }) => {
  const provider = { id: 'rename-fixture', name: 'Rename fixture', baseUrl: 'https://provider.example.test/v1', dialect: 'openai-completions',
    headerNames: [], configured: true, modelCount: 1, createdAt: '', updatedAt: '', revision: 'a'.repeat(64) };
  const api = await installMockApi(page, { customProviders: [provider] });
  await page.route('**/api/provider-registry/custom', route => route.fulfill({ json: [provider], headers: {
    'X-AiHarness-Provider-Rename': JSON.stringify({ supported: true, mode: 'exclusive-host-single-writer', reason: 'restricted-single-writer' }),
  } }));
  await page.goto('/settings#provider-lifecycle'); await selectProviderConnection(page, 'custom', provider.id);
  const rename = page.locator('.provider-context-detail .provider-rename-panel');
  await rename.getByRole('button', { name: 'Rename provider', exact: true }).click();
  await rename.getByLabel('New provider ID', { exact: true }).fill('unsubmitted-rename');
  await rename.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('.settings-dialog-header button').click();
  const prompt = page.getByRole('alertdialog', { name: 'Discard unsaved Settings edits?', exact: true });
  await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await rename.getByRole('button', { name: 'Rename provider', exact: true }).click();
  await expect(rename.getByLabel('New provider ID', { exact: true })).toHaveValue('unsubmitted-rename');
  await rename.getByLabel('New provider ID', { exact: true }).fill(provider.id);
  await page.locator('.settings-dialog-header button').click();
  await expect(page.locator('.settings-dialog')).toHaveCount(0); await expect(prompt).toHaveCount(0);
  expect(api.requests.filter(request => request.path.startsWith('/api/provider-registry') && request.method !== 'GET')).toEqual([]);
});

test('OAuth callback drafts guard outer dismissal without acknowledgement', async ({ page }) => {
  const provider = { id: 'oauth-fixture', name: 'OAuth fixture', baseUrl: 'https://provider.example.test/v1', dialect: 'openrouter',
    headerNames: [], configured: false, modelCount: 0, createdAt: '', updatedAt: '', revision: 'a'.repeat(64) };
  const api = await installMockApi(page, { customProviders: [provider] });
  const flow = { id: 'fixture-draft-flow', provider: provider.id, state: 'pending', userCode: '', verificationUri: 'https://oauth.example.test/authorize',
    authorizationUrl: 'https://oauth.example.test/authorize', expiresAt: '2030-01-01T00:00:00.000Z' };
  const started: unknown[] = [], acknowledgements: unknown[] = [];
  await page.route('**/api/provider-registry/auth/oauth-fixture/oauth', async route => {
    started.push(route.request().postDataJSON()); await route.fulfill({ status: 201, json: flow });
  });
  await page.route('**/api/provider-registry/auth/oauth/fixture-draft-flow', route => route.fulfill({ json: route.request().method() === 'GET' ? flow : { state: 'cancelled' } }));
  await page.route('**/api/provider-registry/auth/oauth/fixture-draft-flow/redirect', async route => {
    acknowledgements.push(route.request().postDataJSON()); await route.fulfill({ status: 400, json: { error: 'Unexpected acknowledgement' } });
  });
  await page.goto('/settings#provider-lifecycle'); await selectProviderConnection(page, 'custom', provider.id);
  await page.locator('.provider-context-detail').getByRole('button', { name: 'Browser sign-in (PKCE)', exact: true }).click();
  const callback = page.locator('.provider-oauth-paste input');
  const value = 'http://127.0.0.1:123/oauth/callback?code=SYNTHETIC_UNSUBMITTED_OAUTH_DRAFT&state=fixture';
  await callback.fill(value); await page.locator('.settings-dialog-header button').click();
  const prompt = page.getByRole('alertdialog', { name: 'Discard unsaved Settings edits?', exact: true });
  await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(callback).toHaveValue(value); expect(started).toEqual([{ method: 'browser' }]); expect(acknowledgements).toEqual([]);
  expect(api.requests.filter(request => request.path.includes('/redirect'))).toEqual([]);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('SYNTHETIC_UNSUBMITTED_OAUTH_DRAFT');
  await callback.fill(''); await page.locator('.settings-dialog-header button').click();
  await expect(page.locator('.settings-dialog')).toHaveCount(0); await expect(prompt).toHaveCount(0); expect(acknowledgements).toEqual([]);
});
