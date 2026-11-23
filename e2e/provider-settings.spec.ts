import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from './fixtures/test-budget';
import { expectContrast } from './fixtures/contrast';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { installMockApi } from './fixtures/mock-api';
import { reloadSettingsDiscardingDrafts, selectGeneralSettings, selectModelSettings, selectProviderConnection } from './fixtures/settings-navigation';

async function fixture(page: Page) {
  await page.route('**/provider-settings-fixture', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html lang="en"><head><title>Provider lifecycle fixture</title></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true; await import("/src/components/provider-settings.fixture.tsx");</script></body></html>' }));
  await page.goto('/provider-settings-fixture');
  await expect(page.getByRole('button', { name: 'Start explicit operation' })).toBeVisible();
}

test('OAuth paste is passive, does not autofocus or steal a stacked dialog, and clears operation-local callback state', async ({ page }) => {
  let requests = 0;
  page.on('request', request => { if (request.url().includes('/api/')) requests += 1; });
  await fixture(page);
  const existing = page.getByRole('textbox', { name: 'Existing dialog input' });
  await existing.focus();
  await expect(existing).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Paste the full OAuth callback address' })).toHaveCount(0);
  expect(requests).toBe(0);
  const start = page.getByRole('button', { name: 'Start explicit operation' });
  await start.click();
  await expect(start).toBeFocused();
  const paste = page.getByRole('textbox', { name: 'Paste the full OAuth callback address' });
  await expect(paste).toBeVisible();
  await expect(paste).not.toBeFocused();
  await paste.fill('http://127.0.0.1:123/oauth/callback?code=disposable&state=disposable');
  await page.getByRole('button', { name: 'Replace operation' }).click();
  await expect(paste).toHaveValue('');
  await paste.fill('http://127.0.0.1:123/oauth/callback?code=disposable&state=disposable');
  await paste.press('Enter');
  await expect(page.getByLabel('Pastes')).toHaveText('1');
  await expect(paste).toHaveValue('');
  await page.getByRole('button', { name: 'Français' }).click();
  await expect(page.getByRole('textbox', { name: 'Coller l’adresse complète de retour OAuth' })).toBeVisible();
  await page.getByRole('button', { name: 'Annuler la connexion' }).click();
  await expect(page.getByLabel('Cancels')).toHaveText('1');
  await expect(paste).toHaveCount(0);
  expect(requests).toBe(0);
  expect(await page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage))).not.toContain('disposable');
});

test('explicit rename sends only IDs, reconciles uncertain failure, and renders bilingual responsive feedback', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const bodies: unknown[] = [];
  await page.route('**/api/provider-registry/custom/acme/rename', async route => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'PROVIDER_RENAME_UNCERTAIN', uncertain: true, error: 'server-private-token' }) });
  });
  await fixture(page);
  await page.getByRole('button', { name: 'Français' }).click();
  await page.getByRole('button', { name: 'Renommer le fournisseur' }).click();
  await page.getByRole('textbox', { name: 'Nouvel identifiant du fournisseur' }).fill('renamed');
  await page.getByRole('button', { name: 'Confirmer le renommage' }).click();
  await expect(page.locator('.provider-rename-panel [role="status"]')).toContainText('Le résultat est incertain');
  await expect(page.getByLabel('Canonical reloads')).toHaveText('1');
  await expect(page.getByRole('button', { name: 'Renommer le fournisseur' })).toBeDisabled();
  await page.getByRole('button', { name: 'Actualiser', exact: true }).click();
  await expect(page.getByLabel('Canonical reloads')).toHaveText('2');
  await expect(page.getByRole('button', { name: 'Renommer le fournisseur' })).toBeEnabled();
  expect(bodies).toEqual([{ id: 'renamed', revision: 'a'.repeat(64) }]);
  await expect(page.getByText('server-private-token')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('real Vite → Express custom endpoint discovery, exact provider/model selection and default-host rename refusal', async ({ page }) => {
  const paths: string[] = [];
  const endpoint = createServer((request, response) => {
    paths.push(request.url || '');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'disposable-model', object: 'model' }] }));
  });
  await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/gateway/v1`;
  const id = 'ui-disposable';
  try {
    const created = await page.request.post('/api/provider-registry/custom', { data: { id, name: 'Disposable endpoint', baseUrl, dialect: 'openai-completions' } });
    expect(created.status()).toBe(201);
    const descriptor = await created.json();
    expect(descriptor.revision).toMatch(/^[a-f0-9]{64}$/);
    const passive = await page.request.get('/api/provider-registry/custom');
    expect(JSON.parse(passive.headers()['x-aiharness-provider-rename']!)).toEqual({ supported: false, mode: 'disabled', reason: 'exclusive-host-required' });
    const refused = await page.request.post(`/api/provider-registry/custom/${id}/rename`, { data: { id: 'not-renamed', revision: descriptor.revision } });
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'PROVIDER_ADMISSION_UNAVAILABLE' });
    const builtin = await page.request.post('/api/provider-registry/custom', { data: { id: 'mock', name: 'Cannot replace builtin', baseUrl, dialect: 'openai-completions' } });
    expect(builtin.status()).toBe(400);
    await page.goto('/settings#provider-lifecycle');
    const lifecycle = page.locator('#provider-lifecycle');
    await lifecycle.getByText('Create or edit a compatible provider', { exact: true }).click();
    await selectProviderConnection(page, 'custom', id);
    const card = lifecycle.locator('article').filter({ has: page.getByText(id, { exact: true }) });
    await expect(card).toContainText('Rename is off: an explicitly composed exclusive host is required');
    await expect(card.getByRole('button', { name: 'Rename provider', exact: true })).toBeDisabled();
    await card.getByRole('button', { name: 'Import models', exact: true }).click();
    await expect.poll(() => paths.includes('/gateway/v1/models')).toBe(true);
    await selectModelSettings(page, 'providers');
    await page.getByLabel('Select the AI Provider').selectOption(id);
    await expect(page.getByLabel('Select the AI Provider').locator('option:checked')).toHaveText('Disposable endpoint (ui-disposable)');
    await selectModelSettings(page, 'model');
    await page.getByLabel('Select the model', { exact: true }).selectOption('disposable-model');
    await expect(page.getByLabel('Select the model', { exact: true })).toHaveValue('disposable-model');
    await page.reload();
    await selectModelSettings(page, 'provider-lifecycle');
    await expect(lifecycle).toContainText('Disposable endpoint');
    const actual = await page.request.get('/api/provider-registry/custom');
    expect((await actual.json()).some((provider: { id: string }) => provider.id === id)).toBe(true);
  } finally {
    await page.request.delete(`/api/provider-registry/custom/${id}`);
    endpoint.closeAllConnections();
    await new Promise<void>(resolve => endpoint.close(() => resolve()));
  }
});

const custom = { id: 'acme', name: 'Acme endpoint', baseUrl: 'https://provider.invalid/gateway/v1', dialect: 'openai-completions',
  headerNames: [], configured: true, modelCount: 1, createdAt: '', updatedAt: '', revision: 'a'.repeat(64) };
test('connection metadata never retargets an open provider editor', async ({ page }) => {
  const api = await installMockApi(page, { customProviders: [custom, { ...custom, id: 'other', name: 'Other endpoint' }] });
  await page.goto('/settings#provider-lifecycle');
  await selectProviderConnection(page, 'custom', 'acme');
  const section = page.locator('#provider-lifecycle'), detail = section.locator('.provider-context-detail');
  await detail.getByRole('button', { name: 'Edit', exact: true }).click();
  const form = section.locator('.custom-resource-editor form');
  await form.getByLabel('Name', { exact: true }).fill('Edited source only');
  await form.getByLabel('API key', { exact: true }).fill('EDIT_SOURCE_SECRET_NOT_FOR_OTHER');
  await selectProviderConnection(page, 'custom', 'other');
  await expect(form.getByLabel('ID', { exact: true })).toBeDisabled();
  await expect(form.getByLabel('ID', { exact: true })).toHaveValue('acme');
  await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Edited source only');
  await expect(form.getByLabel('API key', { exact: true })).toHaveValue('EDIT_SOURCE_SECRET_NOT_FOR_OTHER');
  expect(api.requests.filter(request => request.path.startsWith('/api/provider-registry/custom') && request.method !== 'GET')).toEqual([]);
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => api.requests.filter(request => request.path.startsWith('/api/provider-registry/custom') && request.method !== 'GET')
    .map(({ method, path, body }) => ({ method, path, body }))).toEqual([{ method: 'PUT', path: '/api/provider-registry/custom/acme',
    body: expect.objectContaining({ id: 'acme', name: 'Edited source only', apiKey: 'EDIT_SOURCE_SECRET_NOT_FOR_OTHER' }) }]);
  await expect(detail.getByRole('article')).toHaveAttribute('data-settings-selection', 'acme');
  await expect(detail.getByRole('article')).toContainText('Edited source only');
  await selectProviderConnection(page, 'custom', 'other');
  await expect(detail.getByRole('article')).toContainText('Other endpoint');
  await expect(detail.getByRole('article')).not.toContainText('Edited source only');
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('EDIT_SOURCE_SECRET');
});

for (const scenario of [
  { width: 1280, locale: 'en', theme: 'light' },
  { width: 1280, locale: 'fr', theme: 'dark' },
  { width: 390, locale: 'en', theme: 'light' },
  { width: 390, locale: 'fr', theme: 'dark' },
]) test(`Provider connection metadata never signs in or switches provider: ${scenario.width}px ${scenario.locale}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: scenario.width, height: 844 });
  await page.addInitScript(({ locale, theme }) => {
    localStorage.setItem('ai-harness-locale', locale);
    localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme }));
  }, scenario);
  const mutations: Array<{ path: string; method: string; body: unknown }> = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/provider-registry/') && request.method() !== 'GET') mutations.push({ path, method: request.method(), body: request.postDataJSON() });
  });
  const api = await installMockApi(page, { providers: [{ type: 'mock', configured: true }, { type: 'anthropic', configured: false }],
    customProviders: [{ ...custom, dialect: 'anthropic' }, { ...custom, id: 'other', name: 'Other endpoint', dialect: 'openai-completions' }] });
  await page.goto('/settings#providers');
  const before = await page.locator('#providers > select').inputValue();
  await selectModelSettings(page, 'provider-lifecycle');
  const section = page.locator('#provider-lifecycle');
  const navigation = section.getByRole('navigation', { name: /^(Provider connections|Connexions fournisseurs)$/u });
  await expect(navigation).toBeVisible();
  const choice = navigation.getByRole('button', { name: 'Acme endpoint (acme)', exact: true });
  await choice.focus(); await choice.press('Enter');
  const detail = section.locator('.provider-context-detail');
  await expect(detail.getByRole('article')).toHaveCount(1);
  await expect(detail.getByRole('article')).toHaveAttribute('data-settings-selection', 'acme');
  await expect(detail.getByRole('button', { name: /^(Browser sign-in|Connexion par navigateur) \(PKCE\)$/u })).toBeVisible();
  const current = section.getByRole('button', { name: 'Acme endpoint (acme)', exact: true, includeHidden: true });
  await expect(current).toHaveAttribute('aria-current', 'true');
  await expect(current).toHaveAttribute('aria-expanded', 'true');
  await expect(current).toHaveCSS('border-left-width', '3px');
  const back = section.getByRole('button', { name: /^(Back to provider connections|Retour aux connexions fournisseurs)$/u });
  if (scenario.width < 960) {
    await expect(back).toBeFocused(); await back.press('Enter');
    for (const control of [choice, back]) {
      await expect(control).toBeFocused(); await expect(control).toHaveCSS('outline-style', 'solid');
      await expectContrast(control, 'outlineColor', 3);
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      const clearance = await control.evaluate(element => {
        const style = getComputedStyle(element), bounds = element.getBoundingClientRect();
        const extent = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
        return Math.min(...[element.closest('nav') ?? element.closest('.provider-context-detail')!, element.closest('.settings-view')!]
          .flatMap(owner => {
            const clip = owner.getBoundingClientRect();
            return [bounds.left - clip.left, clip.right - bounds.right, bounds.top - clip.top, clip.bottom - bounds.bottom];
          })) - extent;
      });
      expect(clearance).toBeGreaterThanOrEqual(-0.1);
      if (control === choice) await choice.press('Enter');
    }
  } else {
    await expect(choice).toBeFocused();
    const list = (await navigation.boundingBox())!, content = (await detail.boundingBox())!;
    expect(list.x + list.width).toBeLessThanOrEqual(content.x);
  }
  expect((await new AxeBuilder({ page }).include('#provider-lifecycle').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
  expect(await page.locator('.settings-view').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const capture = testInfo.outputPath(`provider-context-${scenario.width}-${scenario.locale}.png`);
  await page.screenshot({ path: capture, animations: 'disabled', caret: 'hide' });
  await testInfo.attach('provider-context', { path: capture, contentType: 'image/png' });
  const editor = section.locator('.custom-resource-editor');
  await editor.locator('summary').focus();
  if (await editor.getAttribute('open') === null) await editor.locator('summary').click();
  await editor.getByLabel('ID', { exact: true }).fill('draft-provider-not-saved');
  const secret = editor.locator('input[type="password"]');
  await secret.fill('CONNECTION_NAV_SECRET_MUST_NOT_PERSIST');
  if (scenario.width < 960) { await back.focus(); await back.press('Enter'); await expect(choice).toBeFocused(); }
  await navigation.getByRole('button', { name: 'Other endpoint (other)', exact: true }).click();
  await expect(detail.getByRole('article')).toHaveAttribute('data-settings-selection', 'other');
  if (scenario.width < 960) await back.click();
  await choice.click();
  await selectGeneralSettings(page, 'appearance');
  await selectModelSettings(page, 'provider-lifecycle');
  await expect(secret).toHaveValue('CONNECTION_NAV_SECRET_MUST_NOT_PERSIST');
  await expect(editor.getByLabel('ID', { exact: true })).toHaveValue('draft-provider-not-saved');
  await selectModelSettings(page, 'providers');
  await expect(page.locator('#providers > select')).toHaveValue(before);
  await selectModelSettings(page, 'provider-lifecycle');
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(stored).not.toContain('CONNECTION_NAV_SECRET'); expect(stored).not.toContain('draft-provider-not-saved');
  const memory = JSON.parse(await page.evaluate(() => localStorage.getItem('ai-harness-settings-navigation-v1')!));
  expect(memory.entries.find((entry: { cwd: string }) => entry.cwd === '/workspace').positions['provider-lifecycle'])
    .toEqual({ group: 'custom', selection: 'acme' });
  await reloadSettingsDiscardingDrafts(page);
  await expect(detail.getByRole('article')).toHaveAttribute('data-settings-selection', 'acme');
  await expect(secret).toHaveValue('');
  await expect(section.locator('.provider-oauth-paste')).toHaveCount(0);
  expect(api.requests.filter(request => request.method !== 'GET'
    && !['/api/workspaces/validate', '/api/mcp/oauth/status'].includes(request.path))).toEqual([]);
  expect(mutations).toEqual([]);
  // A different descriptor namespace must not borrow the same public ID.
  await page.evaluate(() => {
    const key = 'ai-harness-settings-navigation-v1', memory = JSON.parse(localStorage.getItem(key)!);
    memory.entries.find((entry: { cwd: string }) => entry.cwd === '/workspace').positions['provider-lifecycle'] = { group: 'builtin', selection: 'acme' };
    localStorage.setItem(key, JSON.stringify(memory));
  });
  await page.reload();
  await expect(navigation).toBeVisible();
  await expect(detail.getByRole('article')).toHaveCount(0);
  await expect(section.getByRole('status').filter({ hasText: /selected provider is unavailable|fournisseur sélectionné/u })).toBeVisible();
  const unavailableCapture = testInfo.outputPath(`provider-context-unavailable-${scenario.width}-${scenario.locale}.png`);
  await page.screenshot({ path: unavailableCapture, animations: 'disabled', caret: 'hide' });
  await testInfo.attach('provider-context-unavailable', { path: unavailableCapture, contentType: 'image/png' });
  await selectProviderConnection(page, 'custom', 'acme');
  const flow = { id: 'fixture-acme-flow', provider: 'acme', state: 'pending', userCode: '',
    verificationUri: 'https://oauth.example.test/authorize', authorizationUrl: 'https://oauth.example.test/authorize', expiresAt: '2030-01-01T00:00:00.000Z' };
  await page.route('**/api/provider-registry/auth/acme/oauth', route => route.fulfill({ status: 201, json: flow }));
  await page.route('**/api/provider-registry/auth/oauth/fixture-acme-flow', route => route.request().method() === 'GET'
    ? route.fulfill({ json: flow }) : route.fallback());
  await detail.getByRole('button', { name: /^(Browser sign-in|Connexion par navigateur) \(PKCE\)$/u }).click();
  const callback = section.locator('.provider-oauth-paste input');
  await expect(callback).toBeVisible();
  const value = 'http://127.0.0.1:123/oauth/callback?code=CONNECTION_NAV_CALLBACK_NOT_SUBMITTED&state=disposable';
  await callback.fill(value);
  await selectProviderConnection(page, 'custom', 'other');
  await expect(callback).toBeHidden();
  await expect(callback).toHaveCount(1);
  await selectProviderConnection(page, 'custom', 'acme');
  await expect(callback).toHaveValue(value);
  await selectGeneralSettings(page, 'appearance');
  await selectModelSettings(page, 'provider-lifecycle');
  await expect(callback).toHaveValue(value);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('CONNECTION_NAV_CALLBACK');
  expect(mutations.map(({ path, method }) => ({ path, method }))).toEqual([{ path: '/api/provider-registry/auth/acme/oauth', method: 'POST' }]);
  expect(mutations[0]!.body).toEqual({ method: 'browser' });
  await section.locator('.provider-oauth-paste').getByRole('button', { name: /^(Cancel sign-in|Annuler la connexion)$/u }).click();
  await expect(section.locator('.provider-oauth-paste')).toHaveCount(0);
  await expect.poll(() => mutations.map(({ path, method }) => ({ path, method }))).toEqual([
    { path: '/api/provider-registry/auth/acme/oauth', method: 'POST' },
    { path: '/api/provider-registry/auth/oauth/fixture-acme-flow', method: 'DELETE' },
  ]);
  const longName = 'fixture_provider_connection_metadata_with_an_explicit_long_name_and_preserved_authorization';
  await page.route('**/api/provider-registry/custom', route => route.fulfill({ json: [{ ...custom, name: longName, revision: 'b'.repeat(64) }] }));
  await page.reload();
  await expect(detail.getByRole('article').getByText(longName, { exact: true })).toBeVisible();
  expect(await page.locator('.settings-view').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const longCapture = testInfo.outputPath(`provider-context-long-${scenario.width}-${scenario.locale}.png`);
  await page.screenshot({ path: longCapture, animations: 'disabled', caret: 'hide' });
  await testInfo.attach('provider-context-long', { path: longCapture, contentType: 'image/png' });
});

async function actualSettings(page: Page, supported = true) {
  const api = await installMockApi(page, { providers: [{ type: 'mock', configured: true }, { type: 'anthropic', configured: true }] });
  await page.route('**/api/provider-registry/custom', route => route.fulfill({ contentType: 'application/json',
    headers: { 'X-AiHarness-Provider-Rename': JSON.stringify({ supported, mode: supported ? 'exclusive-host-single-writer' : 'disabled',
      reason: supported ? 'restricted-single-writer' : 'exclusive-host-required' }) }, body: JSON.stringify([custom]) }));
  await page.goto('/settings#provider-lifecycle');
  await page.locator('#provider-lifecycle').getByText('Create or edit a compatible provider', { exact: true }).click();
  await selectProviderConnection(page, 'custom', 'acme');
  return api;
}

test('actual Settings reconcile uncertain failure without applying a late rename to a newly selected provider', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const requestEntered = new Promise<void>(resolve => { entered = resolve; });
  let body: unknown;
  await actualSettings(page);
  await page.route('**/api/provider-registry/custom/acme/rename', async route => {
    body = route.request().postDataJSON(); entered(); await held;
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ uncertain: true, error: 'private-value' }) });
  });
  await page.getByRole('button', { name: 'Rename provider', exact: true }).click();
  await page.getByLabel('New provider ID').fill('renamed');
  await page.getByRole('button', { name: 'Confirm rename', exact: true }).click();
  await requestEntered;
  await selectModelSettings(page, 'providers');
  await page.getByLabel('Select the AI Provider').selectOption('anthropic');
  const discard = page.getByRole('alertdialog', { name: 'Discard unsaved Settings edits?', exact: true });
  await expect(discard).toBeVisible(); await discard.getByRole('button', { name: 'Discard edits', exact: true }).click();
  const canonicalRead = page.waitForResponse(response => new URL(response.url()).pathname === '/api/providers');
  release();
  await canonicalRead;
  await expect(page.getByLabel('Select the AI Provider')).toHaveValue('anthropic');
  await expect(page.getByText('private-value')).toHaveCount(0);
  expect(body).toEqual({ id: 'renamed', revision: custom.revision });
});

for (const width of [1280, 390]) test(`actual Settings successful restricted rename uses canonical IDs/models, not old source caches: ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  let id = 'acme', release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const api = await installMockApi(page);
  const canonicalModel = () => ({ key: `${id}:canonical-model`, provider: id, id: 'canonical-model', name: 'Canonical model',
    enabled: true, available: true, source: 'custom', capabilities: { reasoning: false, imageInput: false, toolCalls: true } });
  await page.route('**/api/providers', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify([
    { type: 'mock', configured: true }, { type: id, configured: true },
  ]) }));
  await page.route('**/api/models?*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
    updatedAt: '', enabledScope: 'global', enabledSource: 'test host', providers: [{ provider: id, configured: true, models: [canonicalModel()] }],
  }) }));
  await page.route('**/api/provider-registry/custom', route => route.fulfill({ contentType: 'application/json',
    headers: { 'X-AiHarness-Provider-Rename': JSON.stringify({ supported: true, mode: 'exclusive-host-single-writer', reason: 'restricted-single-writer' }) },
    body: JSON.stringify([{ ...custom, id, revision: (id === 'acme' ? 'a' : 'b').repeat(64) }]) }));
  await page.route('**/api/provider-registry/custom/acme/rename', async route => {
    expect(route.request().postDataJSON()).toEqual({ id: 'renamed', revision: custom.revision });
    entered(); await held;
    id = 'renamed';
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...custom, id, revision: 'b'.repeat(64) }) });
  });
  await page.goto('/settings#provider-lifecycle');
  await selectModelSettings(page, 'providers');
  await page.getByLabel('Select the AI Provider').selectOption('acme');
  await selectModelSettings(page, 'provider-lifecycle');
  await page.locator('#provider-lifecycle').getByText('Create or edit a compatible provider', { exact: true }).click();
  await selectProviderConnection(page, 'custom', 'acme');
  try {
    await page.getByRole('button', { name: 'Rename provider', exact: true }).click();
    await page.getByLabel('New provider ID').fill('renamed');
    await page.getByRole('button', { name: 'Confirm rename', exact: true }).click();
    await reached;
    // A newer detail/overview choice is not an active-provider change or a rename retarget.
    if (width < 960) await page.getByRole('button', { name: 'Back to provider connections', exact: true }).click();
    else await selectProviderConnection(page, 'builtin', 'mock');
    release();
    if (width < 960) await expect(page.locator('#provider-lifecycle').getByRole('status')
      .filter({ hasText: 'The selected provider is unavailable in this view.' })).toBeVisible();
    await selectModelSettings(page, 'providers');
    await expect(page.getByLabel('Select the AI Provider')).toHaveValue('renamed');
    await expect(page.getByLabel('Select the AI Provider').locator('option[value="acme"]')).toHaveCount(0);
    await selectModelSettings(page, 'model');
    await expect(page.getByLabel('Select the model', { exact: true })).toHaveValue('canonical-model');
    await expect(page.getByLabel('Select the model', { exact: true }).locator('option:checked')).toHaveText('Canonical model');
    expect(api.requests.some(request => request.path === '/api/configuration/effective')).toBe(true);
    await selectModelSettings(page, 'provider-lifecycle');
    const connection = page.locator('.provider-context-detail').getByRole('article');
    if (width < 960) {
      await expect(connection).toHaveCount(0);
      await expect(page.locator('#provider-lifecycle').getByRole('navigation')).toBeVisible();
    } else await expect(connection).toHaveAttribute('data-settings-selection', 'mock');
  } finally { release(); }
});

for (const scenario of [
  { name: 'desktop-dark', width: 1440, theme: 'dark' },
  { name: 'desktop-light', width: 1440, theme: 'light' },
  { name: 'mobile-dark', width: 390, theme: 'dark' },
  { name: 'mobile-light', width: 390, theme: 'light' },
] as const) {
  test(`actual provider controls ${scenario.name}: explicit exclusive-host target and disabled shared-host reason`, async ({ page }) => {
    await page.setViewportSize({ width: scenario.width, height: 900 });
    await page.addInitScript(({ theme }) => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({
      version: 4, theme, sendMode: 'enter', contentWidth: 1000, fontSize: 16, sidebarVisible: true,
    })), { theme: scenario.theme });
    await actualSettings(page);
    const card = page.locator('#provider-lifecycle article').filter({ has: page.getByText('acme', { exact: true }) });
    await card.getByRole('button', { name: 'Rename provider', exact: true }).click();
    await expect(card).toContainText('Exact custom provider target: Acme endpoint acme');
    await expect(card).toContainText('SINGLE-WRITER');
    await expect(card).toHaveScreenshot(`provider-rename-${scenario.name}.png`, { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
    await card.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.route('**/api/provider-registry/custom', route => route.fulfill({ contentType: 'application/json',
      headers: { 'X-AiHarness-Provider-Rename': JSON.stringify({ supported: false, mode: 'disabled', reason: 'exclusive-host-required' }) }, body: JSON.stringify([custom]) }));
    await page.reload();
    // Restoration can already expose the selected provider's ancestor editor.
    const editor = page.locator('#provider-lifecycle .custom-resource-editor');
    if (await editor.getAttribute('open') === null) await editor.locator('summary').click();
    await expect(editor).toHaveAttribute('open', '');
    await expect(card.getByRole('button', { name: 'Rename provider', exact: true })).toBeDisabled();
    await expect(card).toContainText('Default and shared hosts do not support rename');
  });
}

for (const condition of ['legacy-descriptor', 'missing-capability', 'invalid-capability'] as const) {
  test(`actual Settings ${condition} remains passive and fails rename closed`, async ({ page }) => {
    await installMockApi(page);
    let mutations = 0;
    page.on('request', request => { if (request.url().includes('/rename')) mutations += 1; });
    const legacy: Partial<typeof custom> = { ...custom };
    delete legacy.revision;
    const headers: Record<string, string> = condition === 'missing-capability' ? {} : { 'X-AiHarness-Provider-Rename': condition === 'invalid-capability'
      ? JSON.stringify({ supported: true, mode: 'disabled', reason: 'restricted-single-writer' })
      : JSON.stringify({ supported: true, mode: 'exclusive-host-single-writer', reason: 'restricted-single-writer' }) };
    await page.route('**/api/provider-registry/custom', route => route.fulfill({ contentType: 'application/json', headers,
      body: JSON.stringify([condition === 'legacy-descriptor' ? legacy : custom]) }));
    await page.goto('/settings#provider-lifecycle');
    await page.locator('#provider-lifecycle').getByText('Create or edit a compatible provider', { exact: true }).click();
    await selectProviderConnection(page, 'custom', 'acme');
    const card = page.locator('#provider-lifecycle article').filter({ has: page.getByText('acme', { exact: true }) });
    await expect(card).toContainText('Acme endpoint');
    if (condition === 'legacy-descriptor') await expect(card.getByRole('button', { name: 'Rename provider', exact: true })).toHaveCount(0);
    else {
      await expect(card.getByRole('button', { name: 'Rename provider', exact: true })).toBeDisabled();
      await expect(card).toContainText('Rename is off: the server did not provide an active exclusive-host capability.');
    }
    expect(mutations).toBe(0);
  });
}

test('actual Settings keeps the renamed source selected when the public old ID is already reused at canonical readback', async ({ page }) => {
  await installMockApi(page);
  let renamed = false;
  const definitions = () => renamed ? [{ ...custom, id: 'renamed', revision: 'b'.repeat(64) },
    { ...custom, name: 'New acme owner', baseUrl: 'https://provider.invalid/other/v1', revision: 'c'.repeat(64) }] : [custom];
  await page.route('**/api/providers', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify([
    { type: 'mock', configured: true }, ...definitions().map(item => ({ type: item.id, configured: true })),
  ]) }));
  await page.route('**/api/models?*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
    updatedAt: '', enabledScope: 'global', enabledSource: 'disposable host', providers: definitions().map(item => ({ provider: item.id, configured: true,
      models: [{ key: `${item.id}:${item.id === 'acme' && renamed ? 'replacement-model' : 'canonical-model'}`, provider: item.id,
        id: item.id === 'acme' && renamed ? 'replacement-model' : 'canonical-model', name: 'Canonical model', enabled: true, available: true, source: 'custom',
        capabilities: { reasoning: false, imageInput: false, toolCalls: true } }],
    })),
  }) }));
  await page.route('**/api/provider-registry/custom', route => route.fulfill({ contentType: 'application/json',
    headers: { 'X-AiHarness-Provider-Rename': JSON.stringify({ supported: true, mode: 'exclusive-host-single-writer', reason: 'restricted-single-writer' }) },
    body: JSON.stringify(definitions()) }));
  await page.route('**/api/provider-registry/custom/acme/rename', async route => {
    expect(route.request().postDataJSON()).toEqual({ id: 'renamed', revision: custom.revision });
    renamed = true;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(definitions()[0]) });
  });
  await page.goto('/settings#provider-lifecycle');
  await selectModelSettings(page, 'providers');
  await page.getByLabel('Select the AI Provider').selectOption('acme');
  await selectModelSettings(page, 'provider-lifecycle');
  await page.locator('#provider-lifecycle').getByText('Create or edit a compatible provider', { exact: true }).click();
  await selectProviderConnection(page, 'custom', 'acme');
  await page.getByRole('button', { name: 'Rename provider', exact: true }).click();
  await page.getByLabel('New provider ID').fill('renamed');
  await page.getByRole('button', { name: 'Confirm rename', exact: true }).click();
  await selectModelSettings(page, 'providers');
  await expect(page.getByLabel('Select the AI Provider')).toHaveValue('renamed');
  await expect(page.getByLabel('Select the AI Provider').locator('option[value="acme"]')).toHaveText('New acme owner (acme)');
  await selectModelSettings(page, 'model');
  await expect(page.getByLabel('Select the model', { exact: true })).toHaveValue('canonical-model');
  await selectModelSettings(page, 'provider-lifecycle');
  await expect(page.locator('.provider-context-detail').getByRole('article')).toHaveAttribute('data-settings-selection', 'renamed');
  await expect(page.locator('#provider-lifecycle article[data-settings-selection="acme"]')).toHaveCount(1);
  await expect(page.locator('#provider-lifecycle article[data-settings-selection="acme"]')).toBeHidden();
});

test('actual exclusive host enables Settings rename and conserves canonical saved references without workspace access', async ({ page }) => {
  const { mkdir, mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const host = await import('../packages/server/dist/index.js');
  const root = await mkdtemp(path.join(tmpdir(), 'aih-finalize-provider-current-ui-exclusive-'));
  const cwd = path.join(root, 'workspace'); const dataDir = path.join(root, 'data');
  await mkdir(cwd); await mkdir(dataDir);
  const keys = ['AI_HARNESS_AUTH_TOKEN', 'AI_HARNESS_ADMIN_TOKEN', 'AI_HARNESS_MASTER_KEY'] as const;
  const saved = new Map(keys.map(key => [key, process.env[key]] as const));
  const token = 'disposable-exclusive-ui-admin';
  process.env.AI_HARNESS_AUTH_TOKEN = token; process.env.AI_HARNESS_ADMIN_TOKEN = token;
  process.env.AI_HARNESS_MASTER_KEY = 'disposable-exclusive-ui-master';
  const endpoint = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'exclusive-model' }] })); });
  await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/gateway/v1`;
  const headers = { Authorization: `Bearer ${token}` };
  let base = '';
  try {
    const config = { host: '127.0.0.1', port: 0, defaultCwd: cwd, allowedRoots: [cwd], dataDir, providerRenameExclusiveHost: true, webRoot: path.resolve('packages/web/dist') };
    host.createApp(config);
    const { port } = await host.start(config); base = `http://127.0.0.1:${port}`;
    expect((await page.request.post(base + '/api/provider-registry/custom', { headers, data: { id: 'ui-exclusive', name: 'Exclusive endpoint', baseUrl, dialect: 'openai-completions' } })).status()).toBe(201);
    expect((await page.request.post(base + '/api/provider-registry/custom/ui-exclusive/import-models', { headers, data: {} })).status()).toBe(200);
    expect((await page.request.patch(base + '/api/configuration/scope', { headers, data: { scope: 'global', values: {
      provider: 'ui-exclusive', model: 'ui-exclusive:exclusive-model', enabledModels: ['ui-exclusive:exclusive-model'],
    } } })).status()).toBe(200);
    const capability = await page.request.get(base + '/api/provider-registry/custom', { headers });
    expect(JSON.parse(capability.headers()['x-aiharness-provider-rename']!)).toEqual({ supported: true, mode: 'exclusive-host-single-writer', reason: 'restricted-single-writer' });
    expect((await page.request.get(base + '/api/workspaces/default', { headers })).status()).toBe(409);
    // Authenticate this actual browser context at the same origin as the built Web/server.
    expect((await page.request.post(base + '/api/auth/login', { data: { token } })).status()).toBe(200);
    await page.goto(base + '/settings#provider-lifecycle');
    await selectModelSettings(page, 'providers');
    await page.getByLabel('Select the AI Provider').selectOption('ui-exclusive');
    await selectModelSettings(page, 'provider-lifecycle');
    await page.locator('#provider-lifecycle').getByText('Create or edit a compatible provider', { exact: true }).click();
    await selectProviderConnection(page, 'custom', 'ui-exclusive');
    const card = page.locator('#provider-lifecycle article').filter({ has: page.getByText('ui-exclusive', { exact: true }) });
    await expect(card.getByRole('button', { name: 'Rename provider', exact: true })).toBeEnabled();
    await card.getByRole('button', { name: 'Rename provider', exact: true }).click();
    await card.getByLabel('New provider ID').fill('exclusive-renamed');
    const mutation = page.waitForResponse(response => new URL(response.url()).pathname === '/api/provider-registry/custom/ui-exclusive/rename');
    await card.getByRole('button', { name: 'Confirm rename', exact: true }).click();
    expect((await mutation).status()).toBe(200);
    await selectModelSettings(page, 'providers');
    await expect(page.getByLabel('Select the AI Provider')).toHaveValue('exclusive-renamed');
    await expect(page.getByLabel('Select the AI Provider').locator('option[value="ui-exclusive"]')).toHaveCount(0);
    await selectModelSettings(page, 'model');
    await expect(page.getByLabel('Select the model', { exact: true })).toHaveValue('exclusive-model');
    const scope = await page.request.get(base + '/api/configuration/scope?scope=global', { headers });
    expect((await scope.json()).values).toMatchObject({ provider: 'exclusive-renamed', model: 'exclusive-renamed:exclusive-model', enabledModels: ['exclusive-renamed:exclusive-model'] });
  } finally {
    await host.stop();
    endpoint.closeAllConnections(); await new Promise<void>(resolve => endpoint.close(() => resolve()));
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});

// Regression for 9345b43's inserted Defaults paint declaration: it must
// not consume the preceding custom-form selector list or its sizing rule.
for (const theme of ['dark', 'light'] as const) {
  test(`custom provider form retains independent sizing and never inherits Defaults paint (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(({ theme }) => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({
      version: 4, theme, sendMode: 'enter', contentWidth: 1000, fontSize: 16, sidebarVisible: true,
    })), { theme });
    await actualSettings(page);
    // Keep this selector-boundary probe independent of the product theme's accent.
    await page.addStyleTag({ content: '.settings-dialog { --accent: #a12645; }' });
    const controls = page.locator('#provider-lifecycle .custom-resource-editor form').locator('input, select, textarea');
    expect(await controls.count()).toBe(6);
    for (const control of await controls.all()) {
      const style = await control.evaluate(element => ({ minHeight: getComputedStyle(element).minHeight, background: getComputedStyle(element).backgroundColor }));
      expect(style.minHeight).toBe('35.2px');
      expect(style.background).not.toBe('rgb(161, 38, 69)');
    }
    // The accepted Defaults owner enables Save only after an explicit dirty intent.
    await selectGeneralSettings(page, 'behavior');
    await page.locator('#defaults input').first().fill('paint-regression');
    const defaultsButton = page.locator('#defaults button:not(:disabled)').first();
    await expect(defaultsButton).toBeVisible();
    expect(await defaultsButton.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(161, 38, 69)');
  });
}

for (const composition of ['native', 'legacy-229'] as const) {
  test(`OAuth callback Enter preserves ${composition} composition without acknowledgement`, async ({ page }) => {
    await fixture(page);
    await page.getByRole('button', { name: 'Start explicit operation' }).click();
    const paste = page.getByRole('textbox', { name: 'Paste the full OAuth callback address' });
    const callback = 'http://127.0.0.1:123/oauth/callback?code=disposable&state=disposable';
    await paste.fill(callback);
    const nativeEditing = await paste.evaluate((element, mode) => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true,
        isComposing: mode === 'native', keyCode: mode === 'legacy-229' ? 229 : 13 });
      element.dispatchEvent(event);
      return !event.defaultPrevented;
    }, composition);
    expect(nativeEditing).toBe(true);
    await expect(page.getByLabel('Pastes')).toHaveText('0');
    await expect(paste).toHaveValue(callback);
    await expect(paste).toBeFocused();
    await paste.press('Enter');
    await expect(page.getByLabel('Pastes')).toHaveText('1');
    await expect(paste).toHaveValue('');
  });
}
