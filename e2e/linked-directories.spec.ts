import { mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// Real product server only. No mock API, intercepted responses or replacement fixture UI.
// Stable names are private to this isolated Docker container; mkdir refuses pre-existing paths.
const source = path.join(process.cwd(), 'e2e', '.linked-product-workspace');
const target = '/tmp/aih-linked-product-target\u200b';
let createdSource = false; let createdTarget = false;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  await mkdir(source); createdSource = true;
  await mkdir(target); createdTarget = true;
  await writeFile(path.join(target, 'allowed.txt'), 'CONFIRMED_DIRECTORY_BODY');
  await symlink('/etc', path.join(target, 'escaping-nested-link'));
  await symlink(target, path.join(source, 'external'));
});
test.afterAll(async () => {
  if (createdSource) await rm(source, { recursive: true, force: true });
  if (createdTarget) await rm(target, { recursive: true, force: true });
});

for (const scenario of [
  { name: 'desktop-light', width: 1440, theme: 'light' },
  { name: 'desktop-dark', width: 1440, theme: 'dark' },
  { name: 'mobile-light', width: 390, theme: 'light' },
  { name: 'mobile-dark', width: 390, theme: 'dark' },
] as const) {
  test(`${scenario.name} real metadata, exact consent, scoped files, reload, revocation and focus`, async ({ page }) => {
    await page.setViewportSize({ width: scenario.width, height: 1200 });
    await page.addInitScript(theme => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme })), scenario.theme);
    const endpoint = '/api/workspaces/linked-directories';
    const initial = await page.request.get(endpoint, { params: { cwd: source } });
    // This fails (rather than silently skips) if the coordinator has not composed the real service.
    expect(initial.status(), 'real linked-directory service must be composed before browser proof').toBe(200);
    const inventory = await initial.json();
    const selection = { cwd: source, directory: '.', id: inventory.entries[0].id, revision: inventory.revision };
    const before = await page.request.get(`${endpoint}/content`, { params: { ...selection, path: 'allowed.txt' } });
    expect(before.status()).toBe(409); expect(await before.text()).not.toContain('CONFIRMED_DIRECTORY_BODY');
    await page.request.post('/api/workspaces/trust', { data: { cwd: source, confirm: true } }).then(response => expect(response.ok()).toBe(true));
    await page.goto(`/?cwd=${encodeURIComponent(source)}`);
    await expect(page.locator('.workspace-button')).toHaveAttribute('title', source);
    await page.evaluate(() => window.dispatchEvent(new Event('aih-show-files')));
    const panel = page.getByRole('complementary', { name: 'Workspace explorer' });
    await expect(panel).toBeVisible();
    await expect(panel.locator('.file-link-reason')).toContainText('Review directory consent');
    const invoker = panel.getByRole('button', { name: 'Linked directories', exact: true });
    await invoker.click();
    const dialog = page.getByRole('dialog', { name: 'Linked directories', exact: true });
    await expect(dialog).toContainText('does not grant project trust');
    await expect(dialog).toContainText('provider maintenance scanners');
    await expect(dialog).toContainText('hidden or directional characters');
    await expect(dialog.locator('dd code').first()).toHaveText('"/tmp/aih-linked-product-target\\u200b"');
    await expect(dialog.locator('dd code').last()).toHaveText('"/tmp/aih-linked-product-target\\u200b"');
    await expect(dialog).not.toContainText('CONFIRMED_DIRECTORY_BODY');
    await dialog.getByRole('button', { name: 'Review directory consent' }).click();
    await expect(dialog.getByRole('button', { name: 'Allow directory', exact: true })).toBeDisabled();
    await dialog.getByLabel('I allow file browsing through this exact directory link.').check();
    await expect(dialog).toHaveScreenshot(`linked-consent-${scenario.name}.png`, { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02 });
    const firstControl = dialog.getByRole('button', { name: 'Close', exact: true });
    const lastControl = dialog.getByRole('button', { name: 'Allow directory', exact: true });
    await lastControl.focus(); await page.keyboard.press('Tab'); await expect(firstControl).toBeFocused();
    await page.keyboard.press('Shift+Tab'); await expect(lastControl).toBeFocused();
    const accessibility = await new AxeBuilder({ page }).include('.linked-directory-dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(accessibility.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
    await dialog.getByRole('button', { name: 'Allow directory', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Browse allowed directory' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Browse allowed directory' }).click();
    await expect(dialog).toContainText('Linked or nonregular entry: access refused.');
    await expect(dialog.getByRole('button', { name: /escaping-nested-link/ })).toBeDisabled();
    await dialog.getByRole('button', { name: /allowed.txt/ }).click();
    await expect(dialog.getByRole('region', { name: 'File content' })).toContainText('CONFIRMED_DIRECTORY_BODY');
    await expect(dialog).toHaveScreenshot(`linked-browse-${scenario.name}.png`, { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02 });
    const browseAccessibility = await new AxeBuilder({ page }).include('.linked-directory-dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(browseAccessibility.violations).toEqual([]);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const roots = await page.request.get('/api/workspaces/roots').then(response => response.json());
    expect(roots.roots).not.toContain(target);
    const escape = await page.request.post('/api/workspaces/validate', { data: { cwd: target } });
    expect(escape.status()).toBe(403);
    await page.reload();
    await page.evaluate(() => window.dispatchEvent(new Event('aih-show-files')));
    await panel.getByRole('button', { name: 'Linked directories', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Revoke consent' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Revoke consent' }).click();
    await expect(dialog.getByRole('button', { name: 'Review directory consent' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0); await expect(invoker).toBeFocused();
    await page.context().setOffline(true);
    await invoker.click();
    await expect(dialog.getByRole('alert')).toContainText('The server could not be reached.');
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
    await page.context().setOffline(false);
    await dialog.getByRole('button', { name: 'Retry', exact: true }).last().click();
    await expect(dialog.getByRole('button', { name: 'Review directory consent' })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(invoker).toBeFocused();
  });
}

test('real link swap refuses a stale confirmation without reading target body', async ({ page }) => {
  const endpoint = '/api/workspaces/linked-directories';
  const inventory = await page.request.get(endpoint, { params: { cwd: source } }).then(response => response.json());
  const selection = { cwd: source, directory: '.', id: inventory.entries[0].id, revision: inventory.revision };
  await rm(path.join(source, 'external')); await symlink(target, path.join(source, 'external'));
  const refused = await page.request.post(`${endpoint}/consent`, { data: { ...selection, allowed: true, confirm: true } });
  expect(refused.status()).toBe(409); expect(await refused.text()).not.toContain('CONFIRMED_DIRECTORY_BODY');
});

test('real source trust is independent of consent; direct files, Git, tools and execution stay forbidden', async ({ page }) => {
  const endpoint = '/api/workspaces/linked-directories';
  const refusedTrust = await page.request.delete('/api/workspaces/trust', { data: { cwd: source, confirm: true } });
  expect(refusedTrust.ok()).toBe(true);
  const initial = await page.request.get(endpoint, { params: { cwd: source } }).then(response => response.json());
  expect(JSON.stringify(initial)).not.toContain('allowed.txt');
  expect(JSON.stringify(initial)).not.toContain('CONFIRMED_DIRECTORY_BODY');
  await page.goto(`/?cwd=${encodeURIComponent(source)}`);
  await expect(page.locator('.workspace-button')).toHaveAttribute('title', source);
  await page.evaluate(() => window.dispatchEvent(new Event('aih-show-files')));
  const panel = page.getByRole('complementary', { name: 'Workspace explorer' });
  await panel.getByRole('button', { name: 'Linked directories', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Linked directories', exact: true });
  await dialog.getByRole('button', { name: 'Review directory consent' }).click();
  await dialog.getByLabel('I allow file browsing through this exact directory link.').check();
  await dialog.getByRole('button', { name: 'Allow directory', exact: true }).click();
  await dialog.getByRole('button', { name: 'Browse allowed directory' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Trust the source workspace separately');
  await expect(dialog.getByRole('button', { name: 'Revoke consent' })).toBeVisible();
  await expect(dialog).not.toContainText('CONFIRMED_DIRECTORY_BODY');
  await expect(dialog).toBeFocused();
  expect((await page.request.get('/api/workspaces/trust', { params: { cwd: source } }).then(response => response.json())).operationTrusted).toBe(false);
  expect((await page.request.post('/api/workspaces/trust', { data: { cwd: source, confirm: true } })).ok()).toBe(true);
  await dialog.getByRole('button', { name: 'Browse allowed directory' }).click();
  await dialog.getByRole('button', { name: /allowed.txt/ }).click();
  await expect(dialog.getByRole('region', { name: 'File content' })).toContainText('CONFIRMED_DIRECTORY_BODY');
  for (const [url, params] of [
    ['/api/files/content', { cwd: source, path: 'external/allowed.txt' }],
    ['/api/files/content', { cwd: target, path: 'allowed.txt' }],
    ['/api/files/git/status', { cwd: target }],
    ['/api/workspaces/trust', { cwd: target }],
  ] as const) {
    const refused = await page.request.get(url, { params });
    expect(refused.status(), url).toBe(403); expect(await refused.text()).not.toContain('CONFIRMED_DIRECTORY_BODY');
  }
  expect((await page.request.post('/api/terminals', { data: { cwd: target } })).status()).toBe(403);
  expect((await page.request.post('/api/agent/runs', { data: { cwd: target, input: 'read allowed.txt', provider: 'mock', toolPreset: 'full' } })).status()).toBe(403);
  expect((await page.request.post('/api/workspaces/trust', { data: { cwd: target, confirm: true } })).status()).toBe(403);
  await page.keyboard.press('Escape');
  const latest = await page.request.get(endpoint, { params: { cwd: source } }).then(response => response.json());
  expect(latest.entries[0].allowed).toBe(true);
  expect((await page.request.post(`${endpoint}/consent`, { data: { cwd: source, directory: '.', id: latest.entries[0].id, revision: latest.revision, allowed: false, confirm: true } })).ok()).toBe(true);
});

test('real external consent revocation retires stale file content and revision-bound descendants', async ({ page }) => {
  const endpoint = '/api/workspaces/linked-directories';
  const initial = await page.request.get(endpoint, { params: { cwd: source } }).then(response => response.json());
  const grant = await page.request.post(`${endpoint}/consent`, { data: { cwd: source, directory: '.', id: initial.entries[0].id, revision: initial.revision, allowed: true, confirm: true } }).then(response => response.json());
  const selection = { cwd: source, directory: '.', id: grant.entries[0].id, revision: grant.revision };
  await page.goto(`/?cwd=${encodeURIComponent(source)}`);
  await expect(page.locator('.workspace-button')).toHaveAttribute('title', source);
  await page.evaluate(() => window.dispatchEvent(new Event('aih-show-files')));
  const panel = page.getByRole('complementary', { name: 'Workspace explorer' });
  const invoker = panel.getByRole('button', { name: 'Linked directories', exact: true });
  await invoker.click();
  const dialog = page.getByRole('dialog', { name: 'Linked directories', exact: true });
  await dialog.getByRole('button', { name: 'Browse allowed directory' }).click();
  await dialog.getByRole('button', { name: /allowed.txt/ }).click();
  await expect(dialog).toContainText('CONFIRMED_DIRECTORY_BODY');
  // External ordinary-file changes are permitted only on the next explicit open.
  await writeFile(path.join(target, 'allowed.txt'), 'EXTERNALLY_UPDATED_BODY');
  await expect(dialog).not.toContainText('EXTERNALLY_UPDATED_BODY');
  await dialog.getByRole('button', { name: /allowed.txt/ }).click();
  await expect(dialog).toContainText('EXTERNALLY_UPDATED_BODY');
  const revoked = await page.request.post(`${endpoint}/consent`, { data: { ...selection, allowed: false, confirm: true } });
  expect(revoked.ok()).toBe(true);
  const stale = await page.request.get(`${endpoint}/content`, { params: { ...selection, path: 'allowed.txt' } });
  expect(stale.status()).toBe(409); expect(await stale.text()).not.toContain('EXTERNALLY_UPDATED_BODY');
  await dialog.getByRole('button', { name: /allowed.txt/ }).click();
  await expect(dialog.getByRole('alert')).toContainText('The link, target or consent changed');
  await expect(dialog.getByRole('button', { name: 'Review directory consent' })).toBeVisible();
  await expect(dialog.getByRole('region', { name: 'File content' })).toHaveCount(0);
  await expect(dialog).not.toContainText('EXTERNALLY_UPDATED_BODY');
  await expect(dialog).toBeFocused();
  await page.keyboard.press('Escape'); await expect(invoker).toBeFocused();
  await invoker.click(); await expect(dialog.getByRole('button', { name: 'Review directory consent' })).toBeVisible();
  await page.keyboard.press('Escape');
  await writeFile(path.join(target, 'allowed.txt'), 'CONFIRMED_DIRECTORY_BODY');
});

test('real target replacement invalidates the open browser selector and requires new explicit consent', async ({ page }) => {
  const endpoint = '/api/workspaces/linked-directories';
  const initial = await page.request.get(endpoint, { params: { cwd: source } }).then(response => response.json());
  const grant = await page.request.post(`${endpoint}/consent`, { data: { cwd: source, directory: '.', id: initial.entries[0].id, revision: initial.revision, allowed: true, confirm: true } }).then(response => response.json());
  const selection = { cwd: source, directory: '.', id: grant.entries[0].id, revision: grant.revision };
  await page.goto(`/?cwd=${encodeURIComponent(source)}`);
  await expect(page.locator('.workspace-button')).toHaveAttribute('title', source);
  await page.evaluate(() => window.dispatchEvent(new Event('aih-show-files')));
  await page.getByRole('complementary', { name: 'Workspace explorer' }).getByRole('button', { name: 'Linked directories', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Linked directories', exact: true });
  await expect(dialog.getByRole('button', { name: 'Browse allowed directory' })).toBeVisible();
  const previous = `${target}-previous`;
  await rename(target, previous);
  try {
    await mkdir(target); await writeFile(path.join(target, 'allowed.txt'), 'REPLACEMENT_REQUIRES_FRESH_CONSENT');
    const stale = await page.request.get(`${endpoint}/content`, { params: { ...selection, path: 'allowed.txt' } });
    expect(stale.status()).toBe(409); expect(await stale.text()).not.toContain('REPLACEMENT_REQUIRES_FRESH_CONSENT');
    await dialog.getByRole('button', { name: 'Browse allowed directory' }).click();
    await expect(dialog.getByRole('alert')).toContainText('The link, target or consent changed');
    await expect(dialog).not.toContainText('REPLACEMENT_REQUIRES_FRESH_CONSENT');
    await expect(dialog.getByRole('button', { name: 'Review directory consent' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Review directory consent' }).click();
    await expect(dialog.getByRole('button', { name: 'Allow directory', exact: true })).toBeDisabled();
    await dialog.getByLabel('I allow file browsing through this exact directory link.').check();
    await dialog.getByRole('button', { name: 'Allow directory', exact: true }).click();
    await dialog.getByRole('button', { name: 'Browse allowed directory' }).click();
    await dialog.getByRole('button', { name: /allowed.txt/ }).click();
    await expect(dialog).toContainText('REPLACEMENT_REQUIRES_FRESH_CONSENT');
    await page.keyboard.press('Escape');
  } finally {
    await rm(target, { recursive: true, force: true }); await rename(previous, target);
  }
});

test('closing a real in-flight file open aborts its retired modal without late content or focus', async ({ page }) => {
  test.setTimeout(95_000);
  // The preceding real product journeys share the normal 300/minute loopback limiter.
  // Respect its window rather than exempting routes or raising the production limit.
  await page.waitForTimeout(61_000);
  const endpoint = '/api/workspaces/linked-directories';
  const initial = await page.request.get(endpoint, { params: { cwd: source } }).then(response => response.json());
  expect((await page.request.post(`${endpoint}/consent`, { data: { cwd: source, directory: '.', id: initial.entries[0].id, revision: initial.revision, allowed: true, confirm: true } })).ok()).toBe(true);
  await page.goto(`/?cwd=${encodeURIComponent(source)}`);
  await expect(page.locator('.workspace-button')).toHaveAttribute('title', source);
  await page.evaluate(() => window.dispatchEvent(new Event('aih-show-files')));
  const invoker = page.getByRole('complementary', { name: 'Workspace explorer' }).getByRole('button', { name: 'Linked directories', exact: true });
  await invoker.click();
  const dialog = page.getByRole('dialog', { name: 'Linked directories', exact: true });
  await dialog.getByRole('button', { name: 'Browse allowed directory' }).click();
  // Delay the genuine network, not the API response/body or product source.
  const network = await page.context().newCDPSession(page);
  await network.send('Network.enable');
  await network.send('Network.emulateNetworkConditions', { offline: false, latency: 1500, downloadThroughput: -1, uploadThroughput: -1 });
  const opening = page.waitForRequest(request => request.url().includes(`${endpoint}/content?`));
  const aborted = page.waitForEvent('requestfailed', { predicate: request => request.url().includes(`${endpoint}/content?`) });
  await dialog.getByRole('button', { name: /allowed.txt/ }).click(); await opening;
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0); await expect(invoker).toBeFocused();
  await aborted;
  await network.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await network.detach();
  await page.waitForTimeout(1600);
  await expect(dialog).toHaveCount(0); await expect(invoker).toBeFocused();
  await expect(page.getByRole('region', { name: 'File content' })).toHaveCount(0);
  await invoker.click();
  await expect(dialog.getByRole('button', { name: 'Browse allowed directory' })).toBeVisible();
  await expect(dialog.getByRole('region', { name: 'File content' })).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(invoker).toBeFocused();
  const latest = await page.request.get(endpoint, { params: { cwd: source } }).then(response => response.json());
  expect((await page.request.post(`${endpoint}/consent`, { data: { cwd: source, directory: '.', id: latest.entries[0].id, revision: latest.revision, allowed: false, confirm: true } })).ok()).toBe(true);
});

// Append-only ordinary-policy regression: in-root links are not outside-root grants.
test('real in-root file links retain ordinary file opening without consent requests', async ({ page }) => {
  await writeFile(path.join(source, 'ordinary-target.txt'), 'ORDINARY_IN_ROOT_LINK_BODY');
  await symlink('ordinary-target.txt', path.join(source, 'ordinary-link.txt'));
  await page.request.post('/api/workspaces/trust', { data: { cwd: source, confirm: true } })
    .then(response => expect(response.ok()).toBe(true));
  const created = await page.request.post('/api/sessions', { data: { cwd: source, name: 'In-root link policy' } });
  expect(created.ok()).toBe(true);
  const session = await created.json();
  expect(typeof session.id).toBe('string');
  const ordinary = await page.request.get('/api/files/content', { params: { cwd: source, path: 'ordinary-link.txt' } });
  expect(ordinary.ok()).toBe(true);
  expect(await ordinary.text()).toContain('ORDINARY_IN_ROOT_LINK_BODY');
  const consentRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/workspaces/linked-directories')) consentRequests.push(request.url()); });
  await page.goto(`/chat/${encodeURIComponent(session.id)}?cwd=${encodeURIComponent(source)}`);
  await expect(page.locator('.workspace-button')).toHaveAttribute('title', source);
  await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('aih-show-files')));
  const panel = page.getByRole('complementary', { name: 'Workspace explorer' });
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: '📄 ordinary-link.txt', exact: true }).click();
  await expect(panel.locator('.file-viewer')).toContainText('ORDINARY_IN_ROOT_LINK_BODY');
  await expect(page.locator('.linked-directory-dialog')).toHaveCount(0);
  expect(consentRequests).toEqual([]);
});
