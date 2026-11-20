import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures/test-budget';
import { expectContrast } from './fixtures/contrast';
import { installMockApi, mockSession } from './fixtures/mock-api';
import { selectCustomModel, selectGeneralSettings, selectModelSettings, selectPluginPackage, selectProviderConnection, selectProviderCredential, selectSettingsCategory, selectSettingsTool, selectSubagentProfile } from './fixtures/settings-navigation';

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
  await selectGeneralSettings(page, 'behavior');
  const scope = defaults.getByRole('combobox', { name: scenario.locale === 'fr' ? 'Portée' : 'Scope', exact: true });
  await expect(scope).toHaveValue('project'); await expect(model).toHaveValue('draft-model');
  await model.fill('discarded-scope-model');
  await scope.selectOption('project'); await expect(prompt).toHaveCount(0); await expect(model).toHaveValue('discarded-scope-model');
  await scope.focus(); await scope.selectOption('global'); await expect(prompt).toBeVisible();
  await keep.click(); await expect(prompt).toHaveCount(0);
  await expect(scope).toHaveValue('project'); await expect(model).toHaveValue('discarded-scope-model');
  await scope.selectOption('global'); await expect(prompt).toBeVisible(); await discard.click();
  await expect(scope).toHaveValue('global'); await expect(model).toHaveValue('');
  await expect(scope).toBeEnabled(); await scope.selectOption('project'); await expect(prompt).toHaveCount(0);
  await expect(model).toHaveValue('draft-model');
  await close.click(); await expect(prompt).toBeVisible(); await keep.click();
  await selectProviderCredential(page, 'OpenAI'); await expect(credential).toHaveValue('SYNTHETIC_DISCARDED_SETTINGS_SECRET');
  expect(api.requests.filter(request => request.path === '/api/configuration/scope' && request.method === 'PATCH')).toHaveLength(1);
  await close.click(); await expect(prompt).toBeVisible(); await discard.click();
  await expect(page.locator('.settings-dialog')).toHaveCount(0); await expect(prompt).toHaveCount(0);
  expect(api.requests.filter(request => request.path === '/api/config' && request.method === 'POST')).toHaveLength(1);
  await page.goto('/settings#providers'); await selectProviderCredential(page, 'OpenAI');
  await expect(credential).not.toHaveValue('SYNTHETIC_DISCARDED_SETTINGS_SECRET');
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(stored).not.toContain(secret); expect(stored).not.toContain('SYNTHETIC_DISCARDED_SETTINGS_SECRET');
  expect(stored).not.toContain('discarded-scope-model');
  expect(nativePrompts).toEqual([]);
});

test('New-session shortcut keeps Settings drafts until admitted without creating a peer session', async ({ page }) => {
  const api = await installMockApi(page);
  const localDrafts = () => page.evaluate(async path => {
    const { useSessionStore } = await import(path);
    return useSessionStore.getState().sessions.filter((session: { draft?: boolean }) => session.draft).map((session: { id: string }) => session.id);
  }, '/src/store/session-store.ts');
  const prompt = page.getByRole('alertdialog', { name: 'Discard unsaved Settings edits?', exact: true });
  await page.goto('/settings#providers'); await selectProviderCredential(page, 'OpenAI');
  const credential = page.locator('#providers .credential-context-detail input[type="password"]:visible');
  await credential.fill('SYNTHETIC_SHORTCUT_SETTINGS_DRAFT');
  expect(await localDrafts()).toEqual([]);
  await page.keyboard.press('Control+Shift+O');
  await expect(prompt).toBeVisible(); await expect(credential).toHaveValue('SYNTHETIC_SHORTCUT_SETTINGS_DRAFT');
  expect(await localDrafts()).toEqual([]);
  await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(prompt).toHaveCount(0); await expect(credential).toHaveValue('SYNTHETIC_SHORTCUT_SETTINGS_DRAFT');
  await page.keyboard.press('Control+Shift+O'); await expect(prompt).toBeVisible();
  const retired = await page.evaluate(async path => {
    const { useSessionStore } = await import(path), workspace = useSessionStore.getState().workspace;
    const discard = [...document.querySelectorAll<HTMLButtonElement>('.settings-discard-dialog button')].find(button => button.textContent === 'Discard edits');
    if (!workspace || !discard) throw new Error('Expected the original Settings discard command.');
    useSessionStore.setState({ workspace: { ...workspace, id: 'retired-shortcut-workspace', cwd: '/retired-shortcut-workspace' } });
    const connected = discard.isConnected; discard.click(); return { workspace, connected };
  }, '/src/store/session-store.ts');
  expect(retired.connected).toBe(true); expect(await localDrafts()).toEqual([]);
  await expect(prompt).toHaveCount(0); await expect(page.locator('.settings-dialog')).toBeVisible();
  await page.evaluate(async ({ path, workspace }) => {
    const { useSessionStore } = await import(path); useSessionStore.setState({ workspace });
  }, { path: '/src/store/session-store.ts', workspace: retired.workspace });
  await selectProviderCredential(page, 'OpenAI'); await credential.fill('SYNTHETIC_SHORTCUT_SETTINGS_DRAFT');
  await page.keyboard.press('Control+K'); const palette = page.getByRole('dialog', { name: 'Command palette', exact: true });
  await expect(palette).toBeVisible(); await page.keyboard.press('Control+Shift+O');
  await expect(palette).toHaveCount(0); await expect(prompt).toBeVisible(); expect(await localDrafts()).toEqual([]);
  await prompt.getByRole('button', { name: 'Discard edits', exact: true }).click();
  await expect(page.locator('.settings-dialog')).toHaveCount(0);
  expect(await localDrafts()).toHaveLength(1); await expect(page).toHaveURL(/\/chat\/draft%3A/);
  await page.goto('/settings#providers'); await selectProviderCredential(page, 'OpenAI');
  await page.keyboard.press('Control+Shift+O'); await expect(page.locator('.settings-dialog')).toHaveCount(0);
  expect(await localDrafts()).toHaveLength(2); await expect(prompt).toHaveCount(0);
  await page.keyboard.press('Control+Shift+O'); expect(await localDrafts()).toHaveLength(3);
  await expect(page).toHaveURL(/\/chat\/draft%3A/);
  expect(api.requests.filter(request => request.method !== 'GET'
    && !['/api/workspaces/validate', '/api/mcp/oauth/status'].includes(request.path))).toEqual([]);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('SYNTHETIC_SHORTCUT_');
});

test('Settings document departure protects dirty owners without saving or persisting drafts', async ({ page }) => {
  const api = await installMockApi(page);
  const dialogs: string[] = [];
  let admit = false;
  page.on('dialog', async dialog => { dialogs.push(dialog.type()); if (admit) await dialog.accept(); else await dialog.dismiss(); });
  const reload = async () => {
    const decision = page.waitForEvent('dialog');
    await page.evaluate(() => location.reload()); await decision;
  };
  await page.goto('/settings#providers'); await selectProviderCredential(page, 'OpenAI');
  const credential = page.locator('#providers .credential-context-detail input[type="password"]:visible');
  const credentialBaseline = await credential.inputValue();
  await credential.fill('SYNTHETIC_DOCUMENT_DRAFT_SECRET');
  await selectModelSettings(page, 'custom-models');
  const editor = page.locator('#custom-models .custom-resource-editor'); await editor.locator('summary').click();
  const model = editor.getByLabel('Name', { exact: true });
  await expect(model).toHaveValue(''); await model.fill('SYNTHETIC_DOCUMENT_DRAFT_MODEL');
  await reload();
  await expect(model).toHaveValue('SYNTHETIC_DOCUMENT_DRAFT_MODEL'); expect(dialogs).toEqual(['beforeunload']);
  const closing = page.waitForEvent('dialog'); await page.close({ runBeforeUnload: true }); await closing;
  expect(page.isClosed()).toBe(false); expect(dialogs).toEqual(['beforeunload', 'beforeunload']);
  await selectProviderCredential(page, 'OpenAI'); await expect(credential).toHaveValue('SYNTHETIC_DOCUMENT_DRAFT_SECRET');
  await credential.fill(credentialBaseline); await selectModelSettings(page, 'custom-models');
  await reload();
  await expect(model).toHaveValue('SYNTHETIC_DOCUMENT_DRAFT_MODEL'); expect(dialogs).toEqual(['beforeunload', 'beforeunload', 'beforeunload']);
  await model.fill(''); await page.reload();
  await expect(model).toHaveValue(''); expect(dialogs).toHaveLength(3);
  await selectProviderCredential(page, 'OpenAI'); await credential.fill('SYNTHETIC_DOCUMENT_ADMITTED_DISCARD');
  admit = true; await page.reload();
  await expect(credential).toHaveValue(''); expect(dialogs).toEqual(['beforeunload', 'beforeunload', 'beforeunload', 'beforeunload']);
  await page.locator('.settings-dialog-header button').click(); await expect(page.locator('.settings-dialog')).toHaveCount(0);
  await page.reload(); expect(dialogs).toHaveLength(4);
  expect(api.requests.filter(request => request.method !== 'GET'
    && !['/api/workspaces/validate', '/api/mcp/oauth/status'].includes(request.path))).toEqual([]);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('SYNTHETIC_DOCUMENT_');
});

test('Pending palette Escape does not ask to discard Settings drafts', async ({ page }) => {
  const target = mockSession('palette-draft-target', 'Saved palette target');
  const api = await installMockApi(page, { sessions: [target] });
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

    const palette = page.getByRole('dialog', { name: 'Command palette', exact: true });
    const search = palette.getByRole('textbox', { name: /Search commands/ });
    const prompt = page.getByRole('alertdialog', { name: 'Discard unsaved Settings edits?', exact: true });
    await credential.focus(); await page.keyboard.press('Control+k');
    await search.fill('New session');
    await page.keyboard.press('Enter'); await expect(prompt).toBeVisible();
    await expect(palette).toHaveCount(0); await expect(credential).toHaveValue('SYNTHETIC_PENDING_PALETTE_SECRET');
    await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(credential).toBeFocused(); await expect(page).toHaveURL(/\/settings#providers$/);
    expect(await page.evaluate(async path => (await import(path)).useSessionStore.getState().sessions.map((session: { id: string }) => session.id), '/src/store/session-store.ts')).toEqual([target.id]);

    await page.keyboard.press('Control+k'); await search.fill('Keyboard shortcuts'); await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/settings#shortcuts$/); await expect(prompt).toHaveCount(0);
    await selectProviderCredential(page, 'OpenAI');
    await expect(credential).toHaveValue('SYNTHETIC_PENDING_PALETTE_SECRET');
    await page.keyboard.press('Control+k');
    await search.fill('Saved palette target');
    await page.keyboard.press('Enter'); await expect(prompt).toBeVisible();
    api.sessions.splice(0);
    await page.evaluate(async path => { await (await import(path)).useSessionStore.getState().hydrateSessions(); }, '/src/store/session-store.ts');
    await prompt.getByRole('button', { name: 'Discard edits', exact: true }).click();
    await expect(prompt).toHaveCount(0); await expect(page).toHaveURL(/\/settings#providers$/);
    await expect(credential).toHaveValue('SYNTHETIC_PENDING_PALETTE_SECRET');
    api.sessions.push(target);
    await page.evaluate(async path => { await (await import(path)).useSessionStore.getState().hydrateSessions(); }, '/src/store/session-store.ts');
    await page.keyboard.press('Control+k');
    await search.fill('Saved palette target');
    await page.keyboard.press('Enter'); await expect(prompt).toBeVisible();
    await prompt.getByRole('button', { name: 'Discard edits', exact: true }).click();
    await expect(page).toHaveURL(/\/chat\/palette-draft-target\?cwd=/);
    await expect(page.locator('.settings-dialog')).toHaveCount(0);
    await page.goto('/settings#providers'); await selectProviderCredential(page, 'OpenAI');
    await expect(credential).toHaveValue('');
    await page.keyboard.press('Control+k'); await search.fill('Saved palette target'); await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/chat\/palette-draft-target\?cwd=/);
    await expect(prompt).toHaveCount(0); await expect(page.locator('.settings-dialog')).toHaveCount(0);
    await page.goto('/settings#providers'); await selectProviderCredential(page, 'OpenAI');
    await credential.fill('SYNTHETIC_PENDING_PALETTE_SECRET');
    await page.keyboard.press('Control+k'); await search.fill('New session'); await page.keyboard.press('Enter');
    await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Discard edits', exact: true }).click();
    await expect(page.locator('.settings-dialog')).toHaveCount(0);
    expect(await page.evaluate(async path => (await import(path)).useSessionStore.getState().sessions.map((session: { id: string }) => session.id), '/src/store/session-store.ts')).toHaveLength(2);
    await expect(page).toHaveURL(/\/chat\/(?!palette-draft-target)[^?]+\?cwd=/);
    expect(api.requests.filter(request => request.method !== 'GET'
      && !['/api/workspaces/validate', '/api/mcp/oauth/status'].includes(request.path))).toEqual([]);
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('SYNTHETIC_PENDING_PALETTE_SECRET');
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
  await page.reload(); await expect(credential).toHaveValue(initial);
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
  await page.unroute('**/api/config');
  const scenarios = [
    { saved: 'SYNTHETIC_EARLY_KEY_CLEARED', later: '' },
    { saved: 'SYNTHETIC_EARLY_KEY_CHANGED', later: 'SYNTHETIC_LATER_KEY_NOT_SAVED' },
  ];
  for (const scenario of scenarios) {
    let releaseSave!: () => void, enteredSave!: () => void;
    const heldSave = new Promise<void>(resolve => { releaseSave = resolve; });
    const pendingSave = new Promise<void>(resolve => { enteredSave = resolve; });
    await page.route('**/api/config', async route => {
      if (route.request().method() === 'POST') { enteredSave(); await heldSave; }
      await route.fallback();
    });
    try {
      await page.goto('/settings#providers'); await selectProviderCredential(page, 'OpenAI');
      const detail = page.locator('#providers .credential-context-detail'), credential = detail.locator('input[type="password"]:visible');
      await credential.fill(scenario.saved); await detail.getByRole('button', { name: 'Save', exact: true }).click(); await pendingSave;
      await credential.fill(scenario.later);
      const response = page.waitForResponse(response => response.url().endsWith('/api/config') && response.request().method() === 'POST');
      releaseSave(); expect((await response).status()).toBe(200);
      const close = page.locator('.settings-dialog-header button'); await close.click();
      const prompt = page.getByRole('alertdialog', { name: 'Discard unsaved Settings edits?', exact: true });
      await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
      await expect(credential).toHaveValue(scenario.later); await expect(detail.getByRole('status')).toHaveCount(0);
      await close.click(); await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Discard edits', exact: true }).click();
      await expect(page.locator('.settings-dialog')).toHaveCount(0);
    } finally { releaseSave(); await page.unroute('**/api/config'); }
  }
  expect(api.requests.filter(request => request.path === '/api/config' && request.method === 'POST').map(request => request.body))
    .toEqual(scenarios.map(scenario => ({ type: 'openai', apiKey: scenario.saved })));
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('SYNTHETIC_');
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
  await selectProviderConnection(page, 'custom', 'fixture-b');
  await section.locator('.provider-context-detail').getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(form.getByLabel('ID', { exact: true })).toHaveValue('fixture-a');
  await expect(form.getByLabel('API key', { exact: true })).toHaveValue('SYNTHETIC_PROVIDER_EDITOR_DRAFT');
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(form.getByLabel('ID', { exact: true })).toHaveValue('fixture-a');
  await expect(form.getByLabel('API key', { exact: true })).toHaveValue('SYNTHETIC_PROVIDER_EDITOR_DRAFT');
  await close.click();
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
  const laterCases = [
    { name: 'SYNTHETIC_PROVIDER_EARLY_NAME', key: 'SYNTHETIC_PROVIDER_ADMITTED_KEY', headers: { 'X-Fixture': 'SYNTHETIC_PROVIDER_ADMITTED_HEADER' }, field: 'name', later: 'SYNTHETIC_PROVIDER_LATER_NAME' },
    { name: 'SYNTHETIC_PROVIDER_EARLY_SECRET', key: 'SYNTHETIC_PROVIDER_SECOND_KEY', headers: undefined, field: 'key', later: 'SYNTHETIC_PROVIDER_LATER_KEY_NOT_SAVED' },
  ];
  for (const scenario of laterCases) {
    let releaseSave!: () => void, enteredSave!: () => void;
    const heldSave = new Promise<void>(resolve => { releaseSave = resolve; });
    const pendingSave = new Promise<void>(resolve => { enteredSave = resolve; });
    await page.route('**/api/provider-registry/custom/fixture-a', async route => {
      if (route.request().method() === 'PUT') { enteredSave(); await heldSave; }
      await route.fallback();
    });
    try {
      await page.goto('/settings#provider-lifecycle'); await selectProviderConnection(page, 'custom', 'fixture-a');
      await section.locator('.provider-context-detail').getByRole('button', { name: 'Edit', exact: true }).click();
      await form.getByLabel('Name', { exact: true }).fill(scenario.name);
      await form.getByLabel('API key', { exact: true }).fill(scenario.key);
      const headers = form.getByLabel('Custom headers (encrypted JSON values)', { exact: true });
      await headers.fill(scenario.headers ? JSON.stringify(scenario.headers) : '');
      await selectProviderConnection(page, 'custom', 'fixture-b');
      await form.getByRole('button', { name: 'Save', exact: true }).click(); await pendingSave;
      await form.getByLabel(scenario.field === 'name' ? 'Name' : 'API key', { exact: true }).fill(scenario.later);
      await form.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(prompt).toBeVisible();
      releaseSave(); await expect(form.locator('button:not([type])')).toBeEnabled();
      await expect(form.getByLabel('Name', { exact: true })).toHaveValue(scenario.field === 'name' ? scenario.later : scenario.name);
      await expect(form.getByLabel('API key', { exact: true })).toHaveValue(scenario.field === 'key' ? scenario.later : '');
      await expect(headers).toHaveValue(''); await expect(prompt).toBeVisible();
      await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
      if (scenario.field === 'name') await form.getByLabel('Name', { exact: true }).fill(scenario.name);
      await form.getByRole('button', { name: 'Cancel', exact: true }).click();
      if (scenario.field === 'key') {
        await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Discard edits', exact: true }).click();
      }
      await expect(form.getByLabel('ID', { exact: true })).toHaveValue(''); await expect(prompt).toHaveCount(0);
      await close.click(); await expect(page.locator('.settings-dialog')).toHaveCount(0);
    } finally { releaseSave(); }
  }
  let releaseLease!: () => void, enteredLease!: () => void;
  const heldLease = new Promise<void>(resolve => { releaseLease = resolve; });
  const pendingLease = new Promise<void>(resolve => { enteredLease = resolve; });
  await page.route('**/api/provider-registry/custom/fixture-a', async route => {
    if (route.request().method() === 'PUT') { enteredLease(); await heldLease; }
    await route.fallback();
  });
  try {
    await page.goto('/settings#provider-lifecycle'); await selectProviderConnection(page, 'custom', 'fixture-a');
    const edit = section.locator('.provider-context-detail').getByRole('button', { name: 'Edit', exact: true });
    await edit.click(); await form.getByLabel('Name', { exact: true }).fill('SYNTHETIC_PROVIDER_REOPEN_SAVE');
    await form.getByRole('button', { name: 'Save', exact: true }).click(); await pendingLease;
    await form.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(prompt).toBeVisible();
    await prompt.getByRole('button', { name: 'Discard edits', exact: true }).click(); await expect(prompt).toHaveCount(0);
    await edit.click(); await expect(form.getByLabel('Name', { exact: true })).toHaveValue('SYNTHETIC_PROVIDER_EARLY_SECRET');
    releaseLease(); await expect(form.locator('button:not([type])')).toBeEnabled();
    await expect(form.getByLabel('ID', { exact: true })).toHaveValue('');
    await close.click(); await expect(page.locator('.settings-dialog')).toHaveCount(0); await expect(prompt).toHaveCount(0);
  } finally { releaseLease(); }
  expect(api.requests.filter(request => request.path.startsWith('/api/provider-registry/custom') && request.method !== 'GET')
    .map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: 'PUT', path: '/api/provider-registry/custom/fixture-a', body: { id: 'fixture-a', name: 'Edited fixture A', baseUrl: provider.baseUrl,
        dialect: provider.dialect, apiKey: 'SYNTHETIC_PROVIDER_EDITOR_DRAFT' } },
      ...laterCases.map(scenario => ({ method: 'PUT', path: '/api/provider-registry/custom/fixture-a', body: { id: 'fixture-a', name: scenario.name,
        baseUrl: provider.baseUrl, dialect: provider.dialect, apiKey: scenario.key, ...(scenario.headers ? { headers: scenario.headers } : {}) } })),
      { method: 'PUT', path: '/api/provider-registry/custom/fixture-a', body: { id: 'fixture-a', name: 'SYNTHETIC_PROVIDER_REOPEN_SAVE', baseUrl: provider.baseUrl, dialect: provider.dialect } },
    ]);
  await page.goto('/settings#provider-lifecycle'); await selectGeneralSettings(page, 'behavior');
  const peer = page.locator('#defaults').getByLabel('Model', { exact: true });
  await peer.fill('provider-cancel-peer-default');
  await selectProviderConnection(page, 'custom', 'fixture-a');
  await section.locator('.provider-context-detail').getByRole('button', { name: 'Edit', exact: true }).click();
  await form.getByLabel('Name', { exact: true }).fill('SYNTHETIC_PROVIDER_RETARGET_NOT_SAVED');
  await selectProviderConnection(page, 'custom', 'fixture-b');
  await section.locator('.provider-context-detail').getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Discard edits', exact: true }).click();
  await expect(form.getByLabel('ID', { exact: true })).toHaveValue('fixture-b');
  await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Fixture B');
  await expect(form.getByLabel('API key', { exact: true })).toHaveValue('');
  await form.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(prompt).toHaveCount(0);
  await expect(form.getByLabel('ID', { exact: true })).toHaveValue('');
  await selectProviderConnection(page, 'custom', 'fixture-a');
  await section.locator('.provider-context-detail').getByRole('button', { name: 'Edit', exact: true }).click();
  await form.getByLabel('API key', { exact: true }).fill('SYNTHETIC_PROVIDER_CANCEL_NOT_SAVED');
  await form.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Discard edits', exact: true }).click();
  await expect(form.getByLabel('ID', { exact: true })).toHaveValue('');
  await expect(section.locator('.custom-resource-editor > summary')).toBeFocused();
  await close.click(); await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await selectGeneralSettings(page, 'behavior'); await expect(peer).toHaveValue('provider-cancel-peer-default');
  await selectProviderConnection(page, 'custom', 'fixture-a');
  await section.locator('.provider-context-detail').getByRole('button', { name: 'Edit', exact: true }).click();
  await form.getByLabel('API key', { exact: true }).fill('SYNTHETIC_PROVIDER_ACTIVE_NOT_SAVED');
  await selectProviderCredential(page, 'OpenAI');
  const activeProvider = page.locator('#providers').getByLabel('Select the AI Provider', { exact: true });
  const previousProvider = await activeProvider.inputValue(), nextProvider = previousProvider === 'anthropic' ? 'openai' : 'anthropic';
  await activeProvider.focus(); await activeProvider.selectOption(previousProvider); await expect(prompt).toHaveCount(0);
  await activeProvider.selectOption(nextProvider); await expect(prompt).toBeVisible();
  await expect(activeProvider).toHaveValue(previousProvider);
  await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(activeProvider).toHaveValue(previousProvider); await expect(activeProvider).toBeFocused();
  await selectProviderConnection(page, 'custom', 'fixture-a');
  await expect(form.getByLabel('API key', { exact: true })).toHaveValue('SYNTHETIC_PROVIDER_ACTIVE_NOT_SAVED');
  await selectProviderCredential(page, 'OpenAI'); await activeProvider.focus(); await activeProvider.selectOption(nextProvider);
  await expect(prompt).toBeVisible();
  const available = await page.evaluate(async next => {
    const store = (await import('/src/store/session-store.ts')).useSessionStore;
    const providers = store.getState().providers, available = providers.available;
    store.setState({ providers: { ...providers, available: Object.fromEntries(Object.entries(available).filter(([id]) => id !== next)) } });
    [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(button => button.textContent === 'Discard edits')!.click();
    return available;
  }, nextProvider);
  await expect(prompt).toHaveCount(0); await expect(activeProvider).toHaveValue(previousProvider);
  await selectProviderConnection(page, 'custom', 'fixture-a');
  await expect(form.getByLabel('API key', { exact: true })).toHaveValue('SYNTHETIC_PROVIDER_ACTIVE_NOT_SAVED');
  await page.evaluate(async available => {
    const store = (await import('/src/store/session-store.ts')).useSessionStore;
    store.setState({ providers: { ...store.getState().providers, available } });
  }, available);
  await selectProviderCredential(page, 'OpenAI'); await activeProvider.focus(); await activeProvider.selectOption(nextProvider);
  await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Discard edits', exact: true }).click();
  await expect(activeProvider).toHaveValue(nextProvider);
  await selectProviderConnection(page, 'custom', 'fixture-a');
  await expect(form.getByLabel('API key', { exact: true })).toHaveValue('');
  await selectProviderCredential(page, 'OpenAI'); await activeProvider.focus(); await activeProvider.selectOption(previousProvider);
  await expect(prompt).toHaveCount(0); await expect(activeProvider).toHaveValue(previousProvider);
  const externalProvider = previousProvider === 'google' ? 'mock' : 'google';
  await page.evaluate(async ({ externalProvider, nextProvider }) => {
    const store = (await import('/src/store/session-store.ts')).useSessionStore;
    const control = document.querySelector<HTMLSelectElement>('#providers > select')!;
    store.getState().setProvider(externalProvider);
    control.value = nextProvider; control.dispatchEvent(new Event('change', { bubbles: true }));
  }, { externalProvider, nextProvider });
  await expect(activeProvider).toHaveValue(externalProvider); await expect(prompt).toHaveCount(0);
  await selectGeneralSettings(page, 'behavior'); await expect(peer).toHaveValue('provider-cancel-peer-default');
  await close.click(); await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Discard edits', exact: true }).click();
  await expect(page.locator('.settings-dialog')).toHaveCount(0); await expect(prompt).toHaveCount(0);
  expect(api.requests.filter(request => request.path.startsWith('/api/provider-registry/custom') && request.method !== 'GET')).toHaveLength(4);
  expect(api.requests.filter(request => request.path === '/api/configuration/scope' && request.method === 'PATCH')).toEqual([]);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('SYNTHETIC_PROVIDER_');
});

test('Provider creation drafts survive the admitted reply without repeating Create', async ({ page }) => {
  const api = await installMockApi(page), baseUrl = 'https://provider.example.test/v1';
  const section = page.locator('#provider-lifecycle'), form = section.locator('.custom-resource-editor form');
  const close = page.locator('.settings-dialog-header button');
  const prompt = page.getByRole('alertdialog', { name: 'Discard unsaved Settings edits?', exact: true });
  let releaseCreate!: () => void, enteredCreate!: () => void;
  const heldCreate = new Promise<void>(resolve => { releaseCreate = resolve; });
  const pendingCreate = new Promise<void>(resolve => { enteredCreate = resolve; });
  await page.route('**/api/provider-registry/custom', async route => {
    if (route.request().method() === 'POST') { enteredCreate(); await heldCreate; }
    await route.fallback();
  });
  try {
    await page.goto('/settings#provider-lifecycle');
    await section.locator('.custom-resource-editor summary').click();
    await form.getByLabel('ID', { exact: true }).fill('fixture-created');
    await form.getByLabel('Name', { exact: true }).fill('SYNTHETIC_PROVIDER_CREATE_EARLY');
    await form.getByLabel('Base URL', { exact: true }).fill(baseUrl);
    await form.getByLabel('API key', { exact: true }).fill('SYNTHETIC_PROVIDER_CREATE_ADMITTED_KEY');
    const headers = form.getByRole('textbox', { name: 'Custom headers (encrypted JSON values)', exact: true });
    await headers.fill(JSON.stringify({ 'X-Fixture': 'SYNTHETIC_PROVIDER_CREATE_ADMITTED_HEADER' }));
    await form.getByRole('button', { name: 'Save', exact: true }).click(); await pendingCreate;
    await form.getByLabel('Name', { exact: true }).fill('SYNTHETIC_PROVIDER_CREATE_LATER');
    await close.click(); await expect(prompt).toBeVisible();
    releaseCreate(); await expect(form.locator('button:not([type])')).toBeEnabled();
    await expect(form.getByLabel('ID', { exact: true })).toHaveValue('fixture-created');
    await expect(form.getByLabel('ID', { exact: true })).toBeDisabled();
    await expect(form.getByLabel('Name', { exact: true })).toHaveValue('SYNTHETIC_PROVIDER_CREATE_LATER');
    await expect(form.getByLabel('API key', { exact: true })).toHaveValue(''); await expect(headers).toHaveValue('');
    await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
    expect(api.requests.filter(request => request.path === '/api/provider-registry/custom' && request.method === 'POST')
      .map(({ body }) => body)).toEqual([{ id: 'fixture-created', name: 'SYNTHETIC_PROVIDER_CREATE_EARLY', baseUrl,
        dialect: 'openai-completions', apiKey: 'SYNTHETIC_PROVIDER_CREATE_ADMITTED_KEY', headers: { 'X-Fixture': 'SYNTHETIC_PROVIDER_CREATE_ADMITTED_HEADER' } }]);
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form.getByLabel('ID', { exact: true })).toHaveValue('');
    expect(api.requests.filter(request => request.path === '/api/provider-registry/custom/fixture-created' && request.method !== 'GET')
      .map(({ method, body }) => ({ method, body }))).toEqual([{ method: 'PUT', body: { id: 'fixture-created', name: 'SYNTHETIC_PROVIDER_CREATE_LATER', baseUrl, dialect: 'openai-completions' } }]);
    await page.unroute('**/api/provider-registry/custom');
    for (const secret of ['api-key', 'headers'] as const) {
      let release!: () => void, entered!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const pending = new Promise<void>(resolve => { entered = resolve; });
      await page.route('**/api/provider-registry/custom', async route => {
        if (route.request().method() === 'POST' && route.request().postDataJSON().id === `fixture-old-${secret}`) { entered(); await held; }
        await route.fallback();
      });
      const admittedKey = `SYNTHETIC_PROVIDER_CREATE_OLD_KEY_${secret}`, laterKey = `SYNTHETIC_PROVIDER_CREATE_NEW_KEY_${secret}`;
      const admittedHeaders = { 'X-Fixture': `SYNTHETIC_PROVIDER_CREATE_OLD_HEADER_${secret}` };
      const laterHeaders = { 'X-New-Fixture': `SYNTHETIC_PROVIDER_CREATE_NEW_HEADER_${secret}` };
      try {
        if (!await section.locator('.custom-resource-editor').evaluate(element => (element as HTMLDetailsElement).open)) {
          await section.locator('.custom-resource-editor summary').click();
        }
        await form.getByLabel('ID', { exact: true }).fill(`fixture-old-${secret}`);
        await form.getByLabel('Name', { exact: true }).fill('SYNTHETIC_PROVIDER_CREATE_OLD_ID');
        await form.getByLabel('Base URL', { exact: true }).fill(baseUrl);
        await form.getByLabel('API key', { exact: true }).fill(admittedKey); await headers.fill(JSON.stringify(admittedHeaders));
        await form.getByRole('button', { name: 'Save', exact: true }).click(); await pending;
        await form.getByLabel('ID', { exact: true }).fill(`fixture-new-${secret}`);
        await form.getByLabel('Name', { exact: true }).fill('SYNTHETIC_PROVIDER_CREATE_NEW_ID');
        if (secret === 'api-key') await form.getByLabel('API key', { exact: true }).fill(laterKey);
        else await headers.fill(JSON.stringify(laterHeaders));
        release(); await expect(form.locator('button:not([type])')).toBeEnabled();
        await expect(form.getByLabel('ID', { exact: true })).toHaveValue(`fixture-new-${secret}`);
        await expect(form.getByLabel('ID', { exact: true })).toBeEditable();
        await expect(form.getByLabel('Name', { exact: true })).toHaveValue('SYNTHETIC_PROVIDER_CREATE_NEW_ID');
        await expect(form.getByLabel('API key', { exact: true })).toHaveValue(secret === 'api-key' ? laterKey : '');
        await expect(headers).toHaveValue(secret === 'headers' ? JSON.stringify(laterHeaders) : '{}');
        expect(api.requests.filter(request => request.path === '/api/provider-registry/custom' && request.method === 'POST'
          && (request.body as { id?: string }).id === `fixture-new-${secret}`)).toEqual([]);
        await close.click(); await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
        await form.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(form.getByLabel('ID', { exact: true })).toHaveValue('');
        expect(api.requests.filter(request => request.path === '/api/provider-registry/custom' && request.method === 'POST'
          && [`fixture-old-${secret}`, `fixture-new-${secret}`].includes((request.body as { id: string }).id)).map(request => request.body))
          .toEqual([
            { id: `fixture-old-${secret}`, name: 'SYNTHETIC_PROVIDER_CREATE_OLD_ID', baseUrl, dialect: 'openai-completions', apiKey: admittedKey, headers: admittedHeaders },
            { id: `fixture-new-${secret}`, name: 'SYNTHETIC_PROVIDER_CREATE_NEW_ID', baseUrl, dialect: 'openai-completions',
              ...(secret === 'api-key' ? { apiKey: laterKey } : {}), headers: secret === 'headers' ? laterHeaders : {} },
          ]);
      } finally { release(); await page.unroute('**/api/provider-registry/custom'); }
    }
    await close.click(); await expect(page.locator('.settings-dialog')).toHaveCount(0); await expect(prompt).toHaveCount(0);
    expect(api.requests.filter(request => request.path.startsWith('/api/provider-registry/custom') && request.method !== 'GET')).toHaveLength(6);
    expect(api.requests.filter(request => request.path === '/api/configuration/scope' && request.method === 'PATCH')).toEqual([]);
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('SYNTHETIC_PROVIDER_CREATE_');
  } finally { releaseCreate(); }
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
  await selectCustomModel(page, 'azure:second');
  await section.locator('.custom-model-context-detail').getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(editor.getByLabel('ID', { exact: true })).toHaveValue('first');
  await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Edited original model');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(editor.getByLabel('ID', { exact: true })).toHaveValue('first');
  await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Edited original model');
  await close.click();
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
  let releaseModel!: () => void, enteredModel!: () => void;
  const heldModel = new Promise<void>(resolve => { releaseModel = resolve; });
  const pendingModel = new Promise<void>(resolve => { enteredModel = resolve; });
  await page.route('**/api/provider-registry/models/openai%3Afirst', async route => {
    if (route.request().method() === 'PUT') { enteredModel(); await heldModel; }
    await route.fallback();
  });
  try {
    await page.goto('/settings#custom-models'); await selectCustomModel(page, 'openai:first');
    await section.locator('.custom-model-context-detail').getByRole('button', { name: 'Edit', exact: true }).click();
    if (await editor.getAttribute('open') === null) await editor.locator('summary').click();
    await editor.getByLabel('Name', { exact: true }).fill('SYNTHETIC_MODEL_EARLY_SAVE');
    await selectCustomModel(page, 'azure:second');
    await editor.getByRole('button', { name: 'Save', exact: true }).click(); await pendingModel;
    await editor.getByLabel('Name', { exact: true }).fill('SYNTHETIC_MODEL_AFTER_SAVE');
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(prompt).toBeVisible();
    const readback = page.waitForResponse(response => response.url().endsWith('/api/provider-registry/models') && response.request().method() === 'GET');
    releaseModel(); await readback;
    await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('SYNTHETIC_MODEL_AFTER_SAVE');
    await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await editor.getByLabel('Name', { exact: true }).fill('SYNTHETIC_MODEL_EARLY_SAVE');
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(prompt).toHaveCount(0);
    await expect(editor.getByLabel('ID', { exact: true })).toHaveValue('');
    expect(api.requests.filter(request => request.path.startsWith('/api/provider-registry/models') && request.method !== 'GET')
      .map(({ method, path, body }) => ({ method, path, body }))).toEqual(['Edited original model', 'SYNTHETIC_MODEL_EARLY_SAVE'].map(name => ({
      method: 'PUT', path: '/api/provider-registry/models/openai%3Afirst', body: { provider: 'openai', id: 'first', name,
        capabilities: { reasoning: true, imageInput: false, toolCalls: true }, contextWindow: 64000, maxOutputTokens: 4096, pricing: {}, compatibility: {} },
    })));
    await close.click(); await expect(page.locator('.settings-dialog')).toHaveCount(0); await expect(prompt).toHaveCount(0);
  } finally { releaseModel(); }

  let releaseLease!: () => void, enteredLease!: () => void;
  const heldLease = new Promise<void>(resolve => { releaseLease = resolve; });
  const pendingLease = new Promise<void>(resolve => { enteredLease = resolve; });
  await page.route('**/api/provider-registry/models/openai%3Afirst', async route => {
    if (route.request().method() === 'PUT') { enteredLease(); await heldLease; }
    await route.fallback();
  });
  try {
    await page.goto('/settings#custom-models'); await selectCustomModel(page, 'openai:first');
    const edit = section.locator('.custom-model-context-detail').getByRole('button', { name: 'Edit', exact: true });
    await edit.click(); if (await editor.getAttribute('open') === null) await editor.locator('summary').click();
    await editor.getByLabel('Name', { exact: true }).fill('SYNTHETIC_MODEL_REOPEN_SAVE');
    await editor.getByRole('button', { name: 'Save', exact: true }).click(); await pendingLease;
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(prompt).toBeVisible();
    await prompt.getByRole('button', { name: 'Discard edits', exact: true }).click(); await expect(prompt).toHaveCount(0);
    await edit.click(); await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('SYNTHETIC_MODEL_EARLY_SAVE');
    const readback = page.waitForResponse(response => response.url().endsWith('/api/provider-registry/models') && response.request().method() === 'GET');
    releaseLease(); await readback;
    await expect(editor.getByLabel('ID', { exact: true })).toHaveValue('');
    await close.click(); await expect(page.locator('.settings-dialog')).toHaveCount(0); await expect(prompt).toHaveCount(0);
    expect(api.requests.filter(request => request.path.startsWith('/api/provider-registry/models') && request.method !== 'GET')
      .map(({ method, path, body }) => ({ method, path, body }))).toEqual(['Edited original model', 'SYNTHETIC_MODEL_EARLY_SAVE', 'SYNTHETIC_MODEL_REOPEN_SAVE'].map(name => ({
      method: 'PUT', path: '/api/provider-registry/models/openai%3Afirst', body: { provider: 'openai', id: 'first', name,
        capabilities: { reasoning: true, imageInput: false, toolCalls: true }, contextWindow: 64000, maxOutputTokens: 4096, pricing: {}, compatibility: {} },
    })));
  } finally { releaseLease(); }
  await page.goto('/settings#custom-models'); await selectGeneralSettings(page, 'behavior');
  const peer = page.locator('#defaults').getByLabel('Model', { exact: true });
  await peer.fill('model-cancel-peer-default');
  await selectCustomModel(page, 'openai:first');
  await section.locator('.custom-model-context-detail').getByRole('button', { name: 'Edit', exact: true }).click();
  if (await editor.getAttribute('open') === null) await editor.locator('summary').click();
  await editor.getByLabel('Name', { exact: true }).fill('SYNTHETIC_MODEL_RETARGET_NOT_SAVED');
  await selectCustomModel(page, 'azure:second');
  await section.locator('.custom-model-context-detail').getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Discard edits', exact: true }).click();
  await expect(editor.getByLabel('ID', { exact: true })).toHaveValue('second');
  await expect(editor.getByLabel('Provider', { exact: true })).toHaveValue('azure');
  await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('azure:second');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(prompt).toHaveCount(0);
  await expect(editor.getByLabel('ID', { exact: true })).toHaveValue('');
  await selectCustomModel(page, 'openai:first');
  await section.locator('.custom-model-context-detail').getByRole('button', { name: 'Edit', exact: true }).click();
  if (await editor.getAttribute('open') === null) await editor.locator('summary').click();
  await editor.getByLabel('Name', { exact: true }).fill('Discard this model draft');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Discard edits', exact: true }).click();
  await expect(editor.getByLabel('ID', { exact: true })).toHaveValue(''); await expect(editor.locator('summary')).toBeFocused();
  await close.click(); await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await selectGeneralSettings(page, 'behavior'); await expect(peer).toHaveValue('model-cancel-peer-default');
  await close.click(); await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Discard edits', exact: true }).click();
  await expect(page.locator('.settings-dialog')).toHaveCount(0); await expect(prompt).toHaveCount(0);
  expect(api.requests.filter(request => request.path.startsWith('/api/provider-registry/models') && request.method !== 'GET')).toHaveLength(3);
  expect(api.requests.filter(request => request.path === '/api/configuration/scope' && request.method === 'PATCH')).toEqual([]);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('SYNTHETIC_MODEL_');
});

test('Custom model creation drafts bind to the provider-qualified reply without repeating Create', async ({ page }) => {
  const api = await installMockApi(page, { customModels: [{ key: 'azure:created-fixture', provider: 'azure', id: 'created-fixture', name: 'Other-provider fixture',
    capabilities: { reasoning: false, imageInput: false, toolCalls: true }, createdAt: '', updatedAt: '' }] });
  const section = page.locator('#custom-models'), editor = section.locator('.custom-resource-editor');
  const close = page.locator('.settings-dialog-header button');
  const prompt = page.getByRole('alertdialog', { name: 'Discard unsaved Settings edits?', exact: true });
  const writes: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  for (const id of ['created-fixture', 'created-reversion']) {
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), pending = new Promise<void>(resolve => { entered = resolve; });
    await page.route('**/api/provider-registry/models', async route => {
      if (route.request().method() === 'POST') { entered(); await held; }
      await route.fallback();
    });
    try {
      await page.goto('/settings#custom-models'); await editor.locator('summary').click();
      await editor.getByLabel('Provider', { exact: true }).fill('openai'); await editor.getByLabel('ID', { exact: true }).fill(id);
      await editor.getByLabel('Name', { exact: true }).fill('SYNTHETIC_MODEL_CREATE_EARLY');
      await editor.getByRole('checkbox', { name: 'reasoning', exact: true }).check();
      await editor.getByLabel('Context window', { exact: true }).fill('64000');
      await editor.getByLabel('Maximum output tokens', { exact: true }).fill('4096');
      await editor.getByRole('textbox', { name: 'Advanced compatibility (JSON)', exact: true }).fill(JSON.stringify({ fixtureMode: 'SYNTHETIC_MODEL_CREATE_MODE' }));
      await editor.getByRole('button', { name: 'Save', exact: true }).click(); await pending;
      await editor.getByLabel('Name', { exact: true }).fill('SYNTHETIC_MODEL_CREATE_LATER');
      await selectCustomModel(page, 'azure:created-fixture');
      await close.click(); await expect(prompt).toBeVisible();
      const readback = page.waitForResponse(response => response.url().endsWith('/api/provider-registry/models') && response.request().method() === 'GET');
      release(); await readback;
      await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('SYNTHETIC_MODEL_CREATE_LATER');
      await expect(editor.getByLabel('Provider', { exact: true })).toHaveValue('openai');
      await expect(editor.getByLabel('ID', { exact: true })).toHaveValue(id);
      await expect(editor.locator('summary')).toHaveText('Edit custom model'); await expect(prompt).toBeVisible();
      await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
      const body = { provider: 'openai', id, name: 'SYNTHETIC_MODEL_CREATE_EARLY', capabilities: { reasoning: true, imageInput: false, toolCalls: true },
        contextWindow: 64000, maxOutputTokens: 4096, pricing: {}, compatibility: { fixtureMode: 'SYNTHETIC_MODEL_CREATE_MODE' } };
      writes.push({ method: 'POST', path: '/api/provider-registry/models', body });
      if (id === 'created-fixture') {
        const secondReadback = page.waitForResponse(response => response.url().endsWith('/api/provider-registry/models') && response.request().method() === 'GET');
        await editor.getByRole('button', { name: 'Save', exact: true }).click(); await secondReadback;
        await expect(editor.getByLabel('ID', { exact: true })).toHaveValue('');
        writes.push({ method: 'PUT', path: '/api/provider-registry/models/openai%3Acreated-fixture', body: { ...body, name: 'SYNTHETIC_MODEL_CREATE_LATER' } });
      } else await editor.getByLabel('Name', { exact: true }).fill('SYNTHETIC_MODEL_CREATE_EARLY');
      expect(api.requests.filter(request => request.path.startsWith('/api/provider-registry/models') && request.method !== 'GET')
        .map(({ method, path, body }) => ({ method, path, body }))).toEqual(writes);
      await expect(section.locator('.custom-model-context-detail')).toContainText('Other-provider fixture');
      await close.click(); await expect(page.locator('.settings-dialog')).toHaveCount(0); await expect(prompt).toHaveCount(0);
      expect(api.requests.filter(request => request.path === '/api/configuration/scope' && request.method === 'PATCH')).toEqual([]);
      expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('SYNTHETIC_MODEL_CREATE_');
    } finally { release(); }
  }
  await page.unroute('**/api/provider-registry/models');
  for (const changed of ['provider', 'id'] as const) {
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), pending = new Promise<void>(resolve => { entered = resolve; });
    const id = `created-${changed}-change`, nextProvider = changed === 'provider' ? 'azure' : 'openai';
    const nextId = changed === 'id' ? 'created-new-id' : id;
    await page.route('**/api/provider-registry/models', async route => {
      if (route.request().method() === 'POST' && route.request().postDataJSON().id === id
        && route.request().postDataJSON().provider === 'openai') { entered(); await held; }
      await route.fallback();
    });
    try {
      await page.goto('/settings#custom-models'); await editor.locator('summary').click();
      await editor.getByLabel('Provider', { exact: true }).fill('openai'); await editor.getByLabel('ID', { exact: true }).fill(id);
      await editor.getByLabel('Name', { exact: true }).fill('SYNTHETIC_MODEL_CREATE_OLD_TUPLE');
      await editor.getByRole('button', { name: 'Save', exact: true }).click(); await pending;
      await editor.getByLabel('Provider', { exact: true }).fill(nextProvider); await editor.getByLabel('ID', { exact: true }).fill(nextId);
      await editor.getByLabel('Name', { exact: true }).fill('SYNTHETIC_MODEL_CREATE_NEW_TUPLE');
      const readback = page.waitForResponse(response => response.url().endsWith('/api/provider-registry/models') && response.request().method() === 'GET');
      release(); await readback;
      await expect(editor.getByLabel('Provider', { exact: true })).toHaveValue(nextProvider);
      await expect(editor.getByLabel('ID', { exact: true })).toHaveValue(nextId);
      await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('SYNTHETIC_MODEL_CREATE_NEW_TUPLE');
      await expect(editor.locator('summary')).toHaveText('Create a custom model');
      expect(api.requests.filter(request => request.path.startsWith('/api/provider-registry/models') && request.method !== 'GET')).toHaveLength(writes.length + 1);
      await close.click(); await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
      const nextReadback = page.waitForResponse(response => response.url().endsWith('/api/provider-registry/models') && response.request().method() === 'GET');
      await editor.getByRole('button', { name: 'Save', exact: true }).click(); await nextReadback;
      await expect(editor.getByLabel('ID', { exact: true })).toHaveValue('');
      const body = { provider: 'openai', id, name: 'SYNTHETIC_MODEL_CREATE_OLD_TUPLE',
        capabilities: { reasoning: false, imageInput: false, toolCalls: true }, pricing: {}, compatibility: {} };
      writes.push({ method: 'POST', path: '/api/provider-registry/models', body },
        { method: 'POST', path: '/api/provider-registry/models', body: { ...body, provider: nextProvider, id: nextId, name: 'SYNTHETIC_MODEL_CREATE_NEW_TUPLE' } });
      expect(api.requests.filter(request => request.path.startsWith('/api/provider-registry/models') && request.method !== 'GET')
        .map(({ method, path, body }) => ({ method, path, body }))).toEqual(writes);
      await selectCustomModel(page, 'azure:created-fixture'); await expect(section.locator('.custom-model-context-detail')).toContainText('Other-provider fixture');
      await close.click(); await expect(page.locator('.settings-dialog')).toHaveCount(0); await expect(prompt).toHaveCount(0);
      expect(api.requests.filter(request => request.path === '/api/configuration/scope' && request.method === 'PATCH')).toEqual([]);
      expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('SYNTHETIC_MODEL_CREATE_');
    } finally { release(); }
  }
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
    await source.fill('npm:@example/reverted-in-flight'); await source.fill('  npm:@example/guarded-install  ');
    await close.click(); await expect(prompt).toBeVisible(); await expect(prompt).toContainText('Saves already started may still finish.');
    await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await source.fill('  npm:@example/guarded-install  ');
    release(); await expect(source).toHaveValue('');
    expect(api.requests.filter(request => request.path.startsWith('/api/plugins') && request.method !== 'GET').map(request => request.body))
      .toEqual([{ action: 'install', source: 'npm:@example/guarded-install', scope: 'project', cwd: '/workspace', projectId: 'workspace-e2e' }]);
    await close.click(); await expect(page.locator('.settings-dialog')).toHaveCount(0); await expect(prompt).toHaveCount(0);
  } finally { release(); }

  let releaseLater!: () => void, enteredLater!: () => void;
  const heldLater = new Promise<void>(resolve => { releaseLater = resolve; });
  const pendingLater = new Promise<void>(resolve => { enteredLater = resolve; });
  await page.route('**/api/plugins', async route => {
    if (route.request().method() === 'POST' && route.request().postDataJSON().action === 'install') { enteredLater(); await heldLater; }
    await route.fallback();
  });
  try {
    await page.goto('/settings#plugins');
    const section = page.locator('#plugins'), source = section.getByLabel('Package source', { exact: true });
    await source.fill('npm:@example/guarded-second-install');
    await section.getByLabel('Install scope', { exact: true }).selectOption('project');
    await section.getByRole('button', { name: 'Install', exact: true }).click(); await pendingLater;
    await source.fill('npm:@example/newer-draft-not-installed');
    releaseLater(); await expect(section.getByRole('button', { name: 'Install', exact: true })).toBeEnabled();
    const close = page.locator('.settings-dialog-header button'); await close.click();
    const prompt = page.getByRole('alertdialog', { name: 'Discard unsaved Settings edits?', exact: true });
    await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(source).toHaveValue('npm:@example/newer-draft-not-installed');
    expect(api.requests.filter(request => request.path.startsWith('/api/plugins') && request.method !== 'GET').map(request => request.body))
      .toEqual(['npm:@example/guarded-install', 'npm:@example/guarded-second-install'].map(value => ({ action: 'install', source: value,
        scope: 'project', cwd: '/workspace', projectId: 'workspace-e2e' })));
    await close.click(); await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Discard edits', exact: true }).click();
    await expect(page.locator('.settings-dialog')).toHaveCount(0);
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('newer-draft-not-installed');
  } finally { releaseLater(); }
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
  const prompt = page.getByRole('alertdialog', { name: 'Discard unsaved Settings edits?', exact: true });
  await selectSubagentProfile(page, 'Plan');
  await section.getByRole('article', { name: 'Plan', exact: true }).getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(editor.getByLabel('Profile ID', { exact: true })).toHaveValue('explore');
  await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Edited profile draft');
  await selectGeneralSettings(page, 'appearance'); await page.locator('.settings-dialog-header button').click();
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
  await page.goto('/settings#subagents'); await selectSubagentProfile(page, 'Edited profile draft');
  await section.getByRole('article', { name: 'Edited profile draft', exact: true }).getByRole('button', { name: 'Edit', exact: true }).click();
  await editor.getByLabel('Name', { exact: true }).fill('Profile draft to discard');
  await selectSubagentProfile(page, 'Plan');
  await section.getByRole('article', { name: 'Plan', exact: true }).getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Discard edits', exact: true }).click();
  await expect(editor.getByLabel('Profile ID', { exact: true })).toHaveValue('plan');
  await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Plan');
  await expect(editor.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue('Plan the delegated task.');
  await expect(section.locator('.subagent-scope-control select')).toHaveValue('project');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(editor).toHaveCount(0); await expect(prompt).toHaveCount(0);
  await page.locator('.settings-dialog-header button').click(); await expect(page.locator('.settings-dialog')).toHaveCount(0);
  expect(api.requests.filter(request => request.path.startsWith('/api/subagents') && request.method !== 'GET')).toHaveLength(1);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('Profile draft to discard');
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
  await page.locator('.provider-context-detail').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#provider-lifecycle form').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(prompt).toHaveCount(0);
  await selectProviderCredential(page, 'OpenAI');
  const active = page.getByLabel('Select the AI Provider', { exact: true }), previous = await active.inputValue();
  const next = previous === 'anthropic' ? 'openai' : 'anthropic';
  await active.focus(); await active.selectOption(next); await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click(); await expect(active).toHaveValue(previous);
  await selectProviderConnection(page, 'custom', provider.id);
  await expect(rename.getByLabel('New provider ID', { exact: true })).toHaveValue('unsubmitted-rename');
  await rename.getByLabel('New provider ID', { exact: true }).fill(provider.id);
  await page.locator('.settings-dialog-header button').click();
  await expect(page.locator('.settings-dialog')).toHaveCount(0); await expect(prompt).toHaveCount(0);
  await page.goto('/settings#provider-lifecycle'); await selectProviderConnection(page, 'custom', provider.id);
  await rename.getByRole('button', { name: 'Rename provider', exact: true }).click();
  await rename.getByLabel('New provider ID', { exact: true }).fill('another-unsubmitted-rename');
  await page.locator('.provider-context-detail').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#provider-lifecycle form').getByLabel('Name', { exact: true }).fill('SYNTHETIC_SCOPED_PROVIDER_NAME');
  await selectProviderCredential(page, 'OpenAI'); await active.focus(); await active.selectOption(next);
  await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Discard edits', exact: true }).click();
  await expect(active).toHaveValue(next); await expect(prompt).toHaveCount(0);
  await selectProviderConnection(page, 'custom', provider.id);
  await expect(page.locator('#provider-lifecycle form').getByLabel('ID', { exact: true })).toHaveValue('');
  await rename.getByRole('button', { name: 'Rename provider', exact: true }).click();
  await expect(rename.getByLabel('New provider ID', { exact: true })).toHaveValue(provider.id);
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
  await selectProviderCredential(page, 'OpenAI');
  const active = page.getByLabel('Select the AI Provider', { exact: true }), previous = await active.inputValue();
  await active.focus(); await active.selectOption(previous === 'anthropic' ? 'openai' : 'anthropic');
  await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(active).toHaveValue(previous);
  await selectProviderConnection(page, 'custom', provider.id);
  await expect(callback).toHaveValue(value); expect(started).toHaveLength(1); expect(acknowledgements).toEqual([]);
  await callback.fill(''); await page.locator('.settings-dialog-header button').click();
  await expect(page.locator('.settings-dialog')).toHaveCount(0); await expect(prompt).toHaveCount(0); expect(acknowledgements).toEqual([]);
});

for (const width of [1280, 390]) test(`Code mode budget Escape retains draft without a confirmation-triggered save: ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const api = await installMockApi(page, { toolSettings: {
    scope: 'project', source: 'workspace-e2e', preset: 'default', powershellAvailable: false, powershellEnabled: false,
    codemode: { enabled: false, mode: 'on', inlineBudget: 3000, selfTest: { state: 'passed', engine: 'QuickJS' } },
    tools: [
      { name: 'read', description: 'Read a fixture file', extensionId: 'builtin:workspace-tools', enabled: true, available: true },
      { name: 'codemode', description: 'Fixture code metadata', extensionId: 'builtin:codemode', enabled: true, available: true },
    ],
  } });
  await page.goto('/settings#tools'); await selectSettingsTool(page, 'codemode');
  const budget = page.locator('#tools').getByLabel('Inline declaration budget (estimated tokens)', { exact: true });
  const prompt = page.getByRole('alertdialog', { name: 'Discard unsaved Settings edits?', exact: true });
  const writes = () => api.requests.filter(request => request.path === '/api/tools' && request.method === 'PATCH').map(request => request.body);
  await budget.fill('500'); await budget.press('Escape');
  await expect(prompt).toBeVisible(); expect(writes()).toEqual([]);
  await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(budget).toHaveValue('500'); await expect(budget).toBeFocused(); expect(writes()).toEqual([]);
  await budget.press('Tab');
  const saved = { enabledTools: ['read', 'codemode'], toolPreset: 'default', powershellEnabled: false,
    cwd: '/workspace', projectId: 'workspace-e2e', codemodeEnabled: false, codemodeMode: 'on', codemodeInlineBudget: 500 };
  await expect.poll(writes).toEqual([saved]);
  // Clearing is dirty even though normal blur rejects it and restores the canonical number.
  await budget.fill(''); await budget.press('Escape');
  await expect(prompt).toBeVisible(); expect(writes()).toEqual([saved]);
  await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click(); await expect(budget).toHaveValue('');
  await budget.press('Tab'); await expect(budget).toHaveValue('500');
  await page.locator('.settings-dialog-header button').click();
  await expect(page.locator('.settings-dialog')).toHaveCount(0); await expect(prompt).toHaveCount(0);
  await page.goto('/settings#tools'); await selectSettingsTool(page, 'codemode');
  await expect(budget).toHaveValue('500'); await budget.fill('700'); await budget.press('Escape');
  await expect(prompt).toBeVisible(); expect(writes()).toEqual([saved]);
  await prompt.getByRole('button', { name: 'Discard edits', exact: true }).click();
  await expect(page.locator('.settings-dialog')).toHaveCount(0); expect(writes()).toEqual([saved]);
});

for (const width of [1280, 390]) test(`Child profile local retirement confirms only its edits: ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const api = await installMockApi(page, { workspaceTrusted: true, workspaceOperationTrusted: true });
  const nativePrompts: string[] = [];
  page.on('dialog', async dialog => { nativePrompts.push(dialog.message()); await dialog.dismiss(); });
  await page.goto('/settings#providers'); await selectProviderCredential(page, 'OpenAI');
  const credential = page.locator('#providers .credential-context-detail input[type="password"]:visible');
  const initial = await credential.inputValue(); await credential.fill('SYNTHETIC_PROFILE_OTHER_CREDENTIAL');
  await selectSettingsCategory(page, 'subagents');
  const section = page.locator('#subagents'), editor = section.locator('.subagent-profile-editor');
  const scope = section.locator('.subagent-scope-control select');
  const prompt = page.getByRole('alertdialog', { name: 'Discard unsaved Settings edits?', exact: true });
  const keep = prompt.getByRole('button', { name: 'Keep editing', exact: true });
  const discard = prompt.getByRole('button', { name: 'Discard edits', exact: true });
  const openEditor = async () => {
    await selectSubagentProfile(page, 'Explore');
    await section.getByRole('article', { name: 'Explore', exact: true }).getByRole('button', { name: 'Edit', exact: true }).click();
  };
  await openEditor(); await editor.getByRole('textbox', { name: 'Instructions', exact: true }).fill('SYNTHETIC_PROFILE_LOCAL_UNSAVED');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(prompt).toBeVisible(); await keep.click();
  await expect(editor.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue('SYNTHETIC_PROFILE_LOCAL_UNSAVED');
  await editor.getByLabel('Name', { exact: true }).press('Escape');
  await expect(prompt).toBeVisible(); await keep.click(); await expect(editor.getByLabel('Name', { exact: true })).toBeFocused();
  await scope.selectOption('global'); await expect(prompt).toBeVisible(); await expect(scope).toHaveValue('project'); await keep.click();
  await expect(scope).toHaveValue('project'); await expect(editor.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue('SYNTHETIC_PROFILE_LOCAL_UNSAVED');
  expect(api.requests.filter(request => request.path.startsWith('/api/subagents') && request.method !== 'GET')).toEqual([]);
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(prompt).toBeVisible(); await discard.click();
  await expect(editor).toHaveCount(0);
  await expect(section.getByRole('article', { name: 'Explore', exact: true }).getByRole('button', { name: 'Edit', exact: true })).toBeFocused();
  await page.locator('.settings-dialog-header button').click(); await expect(prompt).toBeVisible(); await keep.click();
  await selectProviderCredential(page, 'OpenAI'); await expect(credential).toHaveValue('SYNTHETIC_PROFILE_OTHER_CREDENTIAL');
  await selectSettingsCategory(page, 'subagents'); await openEditor();
  await editor.getByRole('textbox', { name: 'Instructions', exact: true }).fill('SYNTHETIC_PROFILE_CREATE_RETARGET');
  const create = section.getByRole('button', { name: 'Create profile', exact: true });
  await create.click(); await expect(prompt).toBeVisible(); await keep.click();
  await expect(editor.getByLabel('Profile ID', { exact: true })).toHaveValue('explore');
  await expect(editor.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue('SYNTHETIC_PROFILE_CREATE_RETARGET');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(prompt).toBeVisible(); await discard.click();
  await expect(editor).toHaveCount(0);
  await expect(section.getByRole('article', { name: 'Explore', exact: true }).getByRole('button', { name: 'Edit', exact: true })).toBeFocused();
  await openEditor(); await editor.getByRole('textbox', { name: 'Instructions', exact: true }).fill('SYNTHETIC_PROFILE_CREATE_RETARGET');
  await create.click(); await expect(prompt).toBeVisible(); await discard.click();
  await expect(editor.getByLabel('Profile ID', { exact: true })).toHaveValue(''); await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('');
  await expect(editor.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue(''); await expect(scope).toHaveValue('project');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(editor).toHaveCount(0); await expect(prompt).toHaveCount(0);
  await page.locator('.settings-dialog-header button').click(); await expect(prompt).toBeVisible(); await keep.click();
  await selectProviderCredential(page, 'OpenAI'); await expect(credential).toHaveValue('SYNTHETIC_PROFILE_OTHER_CREDENTIAL');
  expect(api.requests.filter(request => request.path.startsWith('/api/subagents') && request.method !== 'GET')).toEqual([]);
  await selectSettingsCategory(page, 'subagents'); await openEditor();
  await editor.getByRole('textbox', { name: 'Instructions', exact: true }).fill('SYNTHETIC_PROFILE_LOCAL_SCOPE_DRAFT');
  await scope.selectOption('global'); await expect(prompt).toBeVisible(); await discard.click();
  await expect(scope).toHaveValue('global'); await expect(editor).toHaveCount(0);
  await page.locator('.settings-dialog-header button').click(); await expect(prompt).toBeVisible(); await keep.click();

  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const pending = new Promise<void>(resolve => { entered = resolve; });
  const saves: unknown[] = [];
  await page.route('**/api/subagents/profiles/explore', async route => {
    if (route.request().method() === 'PATCH') { saves.push(route.request().postDataJSON()); entered(); await held; }
    await route.fallback();
  });
  try {
    await openEditor(); await editor.getByRole('textbox', { name: 'Instructions', exact: true }).fill('SYNTHETIC_PROFILE_LOCAL_SAVED');
    await editor.getByRole('button', { name: 'Save', exact: true }).click(); await pending;
    await editor.getByRole('textbox', { name: 'Instructions', exact: true }).fill('SYNTHETIC_PROFILE_REVERTED_IN_FLIGHT');
    await editor.getByRole('textbox', { name: 'Instructions', exact: true }).fill('SYNTHETIC_PROFILE_LOCAL_SAVED');
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(prompt).toBeVisible();
    release(); await expect(editor).toHaveCount(0); await expect(prompt).toHaveCount(0);
    await expect(section.getByRole('article', { name: 'Explore', exact: true }).getByRole('button', { name: 'Edit', exact: true })).toBeFocused();
    expect(saves).toEqual([{ profile: { name: 'Explore', description: 'Explore child-agent profile', instructions: 'SYNTHETIC_PROFILE_LOCAL_SAVED',
      kind: 'explore', enabled: true, tools: ['ls', 'read', 'grep', 'find'], skills: [], extensions: [], model: null, thinking: null,
      maxTurns: 8, inheritContext: true, background: true }, cwd: '/workspace', scope: 'global' }]);
  } finally { release(); }

  let releaseNewer!: () => void, enteredNewer!: () => void;
  const heldNewer = new Promise<void>(resolve => { releaseNewer = resolve; });
  const pendingNewer = new Promise<void>(resolve => { enteredNewer = resolve; });
  const newerSaves: unknown[] = [];
  await page.route('**/api/subagents/profiles/explore', async route => {
    if (route.request().method() === 'PATCH') { newerSaves.push(route.request().postDataJSON()); enteredNewer(); await heldNewer; }
    await route.fallback();
  });
  try {
    await openEditor(); await editor.getByRole('textbox', { name: 'Instructions', exact: true }).fill('SYNTHETIC_PROFILE_EARLY_SAVE');
    await editor.getByRole('button', { name: 'Save', exact: true }).click(); await pendingNewer;
    await editor.getByRole('textbox', { name: 'Instructions', exact: true }).fill('SYNTHETIC_PROFILE_AFTER_SAVE');
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(prompt).toBeVisible();
    releaseNewer(); await expect(editor.locator('button[type="submit"]')).toBeEnabled();
    await expect(prompt).toBeVisible(); await expect(editor.locator('textarea')).toHaveValue('SYNTHETIC_PROFILE_AFTER_SAVE');
    await keep.click(); await editor.getByRole('textbox', { name: 'Instructions', exact: true }).fill('SYNTHETIC_PROFILE_EARLY_SAVE');
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(editor).toHaveCount(0); await expect(prompt).toHaveCount(0);
    expect(newerSaves).toEqual([{ profile: { name: 'Explore', description: 'Explore child-agent profile', instructions: 'SYNTHETIC_PROFILE_EARLY_SAVE',
      kind: 'explore', enabled: true, tools: ['ls', 'read', 'grep', 'find'], skills: [], extensions: [], model: null, thinking: null,
      maxTurns: 8, inheritContext: true, background: true }, cwd: '/workspace', scope: 'global' }]);
    expect(saves).toHaveLength(2);
  } finally { releaseNewer(); }

  let releaseCreate!: () => void, enteredCreate!: () => void;
  const heldCreate = new Promise<void>(resolve => { releaseCreate = resolve; });
  const pendingCreate = new Promise<void>(resolve => { enteredCreate = resolve; });
  const creations: unknown[] = [];
  await page.route('**/api/subagents/profiles', async route => {
    if (route.request().method() === 'POST') { creations.push(route.request().postDataJSON()); enteredCreate(); await heldCreate; }
    await route.fallback();
  });
  try {
    await create.click();
    await editor.getByLabel('Profile ID', { exact: true }).fill('explicit-later-profile');
    await editor.getByLabel('Name', { exact: true }).fill('Explicit profile');
    await editor.getByLabel('Description', { exact: true }).fill('Synthetic profile creation');
    await editor.getByLabel('Tools', { exact: true }).fill(' read, grep, read ');
    await editor.getByRole('textbox', { name: 'Instructions', exact: true }).fill('SYNTHETIC_PROFILE_CREATE_ADMITTED');
    await editor.getByRole('button', { name: 'Save', exact: true }).click(); await pendingCreate;
    await editor.getByRole('textbox', { name: 'Instructions', exact: true }).fill('SYNTHETIC_PROFILE_CREATE_LATER');
    releaseCreate(); await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await expect(editor.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue('SYNTHETIC_PROFILE_CREATE_LATER');
    await expect(editor.getByLabel('Profile ID', { exact: true })).toBeDisabled();
    await expect(editor.getByLabel('Tools', { exact: true })).toHaveValue('read, grep');
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(prompt).toBeVisible(); await keep.click();
    await expect(editor.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue('SYNTHETIC_PROFILE_CREATE_LATER');
    await editor.getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor).toHaveCount(0);
    expect(creations).toEqual([{ profile: { id: 'explicit-later-profile', name: 'Explicit profile', description: 'Synthetic profile creation',
      instructions: 'SYNTHETIC_PROFILE_CREATE_ADMITTED', kind: 'custom', enabled: true, tools: ['read', 'grep'], skills: [], extensions: [],
      maxTurns: 8, inheritContext: true, background: true }, cwd: '/workspace', scope: 'global' }]);
    expect(api.requests.filter(request => request.path === '/api/subagents/profiles/explicit-later-profile' && request.method === 'PATCH')
      .map(request => request.body)).toEqual([{ profile: { name: 'Explicit profile', description: 'Synthetic profile creation',
        instructions: 'SYNTHETIC_PROFILE_CREATE_LATER', kind: 'custom', enabled: true, tools: ['read', 'grep'], skills: [], extensions: [], model: null,
        thinking: null, maxTurns: 8, inheritContext: true, background: true }, cwd: '/workspace', scope: 'global' }]);
  } finally { releaseCreate(); }

  await page.unroute('**/api/subagents/profiles');
  let releaseIdentifier!: () => void, enteredIdentifier!: () => void;
  const heldIdentifier = new Promise<void>(resolve => { releaseIdentifier = resolve; });
  const pendingIdentifier = new Promise<void>(resolve => { enteredIdentifier = resolve; });
  const identifierPosts: unknown[] = [];
  await page.route('**/api/subagents/profiles', async route => {
    if (route.request().method() === 'POST') {
      identifierPosts.push(route.request().postDataJSON());
      if (identifierPosts.length === 1) { enteredIdentifier(); await heldIdentifier; }
    }
    await route.fallback();
  });
  try {
    await create.click();
    await editor.getByLabel('Profile ID', { exact: true }).fill('first-explicit-profile');
    await editor.getByLabel('Name', { exact: true }).fill('First explicit profile');
    await editor.getByLabel('Description', { exact: true }).fill('Synthetic identifier change');
    await editor.getByRole('textbox', { name: 'Instructions', exact: true }).fill('SYNTHETIC_PROFILE_IDENTIFIER_ADMITTED');
    await editor.getByRole('button', { name: 'Save', exact: true }).click(); await pendingIdentifier;
    await editor.getByLabel('Profile ID', { exact: true }).fill('second-explicit-profile');
    await editor.getByLabel('Name', { exact: true }).fill('Second explicit profile');
    await editor.getByRole('textbox', { name: 'Instructions', exact: true }).fill('SYNTHETIC_PROFILE_IDENTIFIER_LATER');
    releaseIdentifier(); await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await expect(editor.getByLabel('Profile ID', { exact: true })).toBeEditable();
    await expect(editor.getByLabel('Profile ID', { exact: true })).toHaveValue('second-explicit-profile');
    await expect(editor.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue('SYNTHETIC_PROFILE_IDENTIFIER_LATER');
    expect(identifierPosts).toHaveLength(1);
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(prompt).toBeVisible(); await keep.click();
    await editor.getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor).toHaveCount(0);
    expect(identifierPosts).toEqual([
      { profile: { id: 'first-explicit-profile', name: 'First explicit profile', description: 'Synthetic identifier change',
        instructions: 'SYNTHETIC_PROFILE_IDENTIFIER_ADMITTED', kind: 'custom', enabled: true, tools: [], skills: [], extensions: [],
        maxTurns: 8, inheritContext: true, background: true }, cwd: '/workspace', scope: 'global' },
      { profile: { id: 'second-explicit-profile', name: 'Second explicit profile', description: 'Synthetic identifier change',
        instructions: 'SYNTHETIC_PROFILE_IDENTIFIER_LATER', kind: 'custom', enabled: true, tools: [], skills: [], extensions: [],
        maxTurns: 8, inheritContext: true, background: true }, cwd: '/workspace', scope: 'global' },
    ]);
  } finally { releaseIdentifier(); }
  await openEditor(); await editor.getByRole('textbox', { name: 'Instructions', exact: true }).fill('SYNTHETIC_PROFILE_LOCAL_WITHDRAWN');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(prompt).toBeVisible();
  await page.evaluate(async path => {
    const { useSessionStore } = await import(path);
    const workspace = useSessionStore.getState().workspace;
    useSessionStore.setState({ workspace: { ...workspace, trusted: false, operationTrusted: false } });
  }, '/src/store/session-store.ts');
  await expect(prompt).toHaveCount(0); await expect(editor).toHaveCount(0);
  await selectProviderCredential(page, 'OpenAI'); await expect(credential).toHaveValue(initial);
  await page.locator('.settings-dialog-header button').click(); await expect(page.locator('.settings-dialog')).toHaveCount(0);
  expect(api.requests.filter(request => request.path.startsWith('/api/subagents') && request.method !== 'GET')).toHaveLength(6);
  expect(api.requests.filter(request => request.path === '/api/config' && request.method !== 'GET')).toEqual([]);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('SYNTHETIC_PROFILE_');
  expect(nativePrompts).toEqual([]);
});
