import { expect, test, type Page } from './fixtures/test-budget';
import { installMockApi, mockSession } from './fixtures/mock-api';
import { switchSettingsWorkspace } from './fixtures/mcp-navigation';
import { selectSettingsCategory } from './fixtures/settings-navigation';
import { mcpFreshProjectInventory, mcpFreshProjectPreviewFixture } from './fixtures/mcp';
import { selectionAnchorControl } from './fixtures/selection-anchor';

const url = '/chat/pane-lifetime?cwd=%2Fworkspace';
const pane = (page: Page) => page.getByRole('region', { name: 'Workspace explorer' });

async function product(page: Page) {
  await page.addInitScript(() => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({
    version: 4, theme: 'light', filesOpen: false, sidebarVisible: true, sound: false,
  })));
  return installMockApi(page, { sessions: [mockSession('pane-lifetime', 'Pane lifetime')],
    workspaceFiles: [{ path: 'src/app.ts', content: 'export const value = 1;', language: 'typescript' }] });
}

test('built Settings assets restore project-specific group, row and scope intent without submitting configuration', async ({ page }) => {
  const api = await installMockApi(page);
  await page.goto('/settings?cwd=%2Fworkspace#model');
  const catalog = page.locator('#model .model-catalog');
  await catalog.locator('summary').click();
  const row = catalog.locator('.model-catalog-row').first();
  const identity = await row.getAttribute('data-settings-selection');
  await row.getByRole('checkbox').focus();
  await selectSettingsCategory(page, 'tools');
  const scope = page.locator('#tools').getByRole('combobox', { name: 'Scope', exact: true });
  await scope.selectOption('global');
  await selectSettingsCategory(page, 'models');
  await row.getByRole('checkbox').focus();
  await switchSettingsWorkspace(page, '/workspace/other');
  await selectSettingsCategory(page, 'tools');
  await expect(scope).toHaveValue('project');
  await selectSettingsCategory(page, 'general');
  await page.locator('#shortcuts input').first().focus();
  await switchSettingsWorkspace(page, '/workspace');
  await expect(row).toBeInViewport();
  await selectSettingsCategory(page, 'tools');
  await expect(scope).toHaveValue('global');
  await selectSettingsCategory(page, 'models');
  await row.getByRole('checkbox').focus();
  await expect(row).toBeInViewport();
  await page.reload();
  await expect(row).toBeInViewport();
  expect(await row.getAttribute('data-settings-selection')).toBe(identity);
  expect(api.requests.filter(request => request.method !== 'GET'
    && !['/api/workspaces/validate', '/api/mcp/oauth/status'].includes(request.path))).toEqual([]);
  expect(await page.evaluate(() => performance.getEntriesByType('resource')
    .some(entry => /\/assets\/SettingsView-[^/]+\.js$/u.test(entry.name)))).toBe(true);
});

test('built Settings assets refresh mounted sections and return focus after canonical MCP trust grant', async ({ page }) => {
  const api = await installMockApi(page, { workspaceTrusted: true, workspaceOperationTrusted: false,
    mcpConfig: mcpFreshProjectInventory(), mcpImportPreview: mcpFreshProjectPreviewFixture() });
  await page.goto('/settings#mcp');
  await selectSettingsCategory(page, 'plugins');
  await expect(page.locator('#plugins .plugin-card').first()).toBeVisible();
  await selectSettingsCategory(page, 'subagents');
  await expect(page.locator('#subagents .subagent-profile-card').first()).toBeVisible();
  await selectSettingsCategory(page, 'mcp');
  const paths = ['/api/plugins', '/api/subagents/settings', '/api/tools', '/api/skills', '/api/models'];
  const count = (path: string) => api.requests.filter(request => request.method === 'GET' && request.path === path).length;
  const before = paths.map(count);
  const section = page.locator('#mcp');
  await section.getByText('Paste and preview a server').click();
  await section.getByLabel('MCP server text').fill('npx -y fresh-mcp-tools');
  await section.getByRole('button', { name: 'Preview', exact: true }).click();
  await section.getByRole('button', { name: 'Configure project import' }).click();
  const dialog = page.getByRole('dialog', { name: 'Configure MCP import' });
  await dialog.getByLabel(/I trust this fresh project folder/u).check();
  await dialog.getByRole('button', { name: 'Save atomically' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(section.getByRole('article', { name: 'fresh-tools: Configured', exact: true })).toBeVisible();
  for (let n = 0; n < paths.length; n++) await expect.poll(() => count(paths[n]!)).toBeGreaterThan(before[n]!);
  await expect(page.locator('#mcp:focus, #mcp :focus')).toHaveCount(1);
  await expect(page.locator('#mcp:focus, #mcp :focus')).toBeInViewport();
  await expect(page).toHaveURL(/\/settings#mcp$/u);
  expect(api.requests.filter(request => request.path === '/api/agent/runs' || request.path === '/api/mcp/test')).toEqual([]);
  expect(await page.evaluate(() => performance.getEntriesByType('resource')
    .some(entry => /\/assets\/workspace-refresh-[^/]+\.js$/u.test(entry.name)))).toBe(true);
});

for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`built ${viewport.name} selection actions stay anchored after native viewport scroll without stealing keyboard focus`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await selectionAnchorControl(page, true);
  });
}

test('a shortcut at the bootstrap DOM commit is registered before the passive task', async ({ page }) => {
  await product(page);
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      if (!document.querySelector('.app-loading')) return;
      observer.disconnect();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
      document.documentElement.dataset.bootstrapShortcut = 'dispatched';
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-bootstrap-shortcut', 'dispatched');
  await expect(pane(page).locator('.file-name')).toBeVisible();
});

test('picker return cannot overwrite a newer explicit focus at close commit', async ({ page }) => {
  await product(page);
  await page.goto(url);
  const opener = page.locator('.workspace-button');
  await opener.click();
  const picker = page.locator('.directory-picker');
  await expect(picker.getByLabel('Workspace path')).toBeFocused();
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      if (document.querySelector('.directory-picker')) return;
      observer.disconnect();
      document.querySelector<HTMLButtonElement>('[aria-label="New chat"]')!.focus();
      document.documentElement.dataset.newerFocus = 'committed';
    });
    observer.observe(document, { childList: true, subtree: true });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await expect(picker).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-newer-focus', 'committed');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('button', { name: 'New chat', exact: true })).toBeFocused();
  // Ordinary keyboard return still belongs to the original invoker.
  await opener.click();
  await expect(picker.getByLabel('Workspace path')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(opener).toBeFocused();
});

// Early keyboard intent must not get clobbered by a later unrelated preference write.
test('bootstrap file preference survives the next sidebar shortcut', async ({ page }) => {
  await product(page);
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      if (!document.querySelector('.app-loading')) return;
      observer.disconnect();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  await page.goto(url);
  await expect(pane(page).locator('.file-name')).toBeVisible();
  await page.keyboard.press('Control+Shift+S');
  await expect(page.locator('.app')).toHaveClass(/sidebar-hidden/);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ai-harness-preferences-v4')!).filesOpen)).toBe(true);
});

test('picker retirement does not cancel the nested folder modal initial focus', async ({ page }) => {
  await product(page); await page.goto(url);
  await page.getByRole('textbox', { name: 'Message composer', exact: true }).waitFor({ state: 'visible' });
  await page.locator('.workspace-button').click();
  const picker = page.locator('.directory-picker');
  await expect(picker.getByLabel('Workspace path')).toBeFocused();
  await picker.getByRole('button', { name: 'New folder', exact: true }).click();
  const folder = page.getByRole('dialog', { name: 'Create a folder' });
  await expect(folder.getByLabel('Folder name')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(folder).toHaveCount(0);
  await expect(picker).toBeVisible();
  expect(await picker.evaluate(element => element.contains(document.activeElement))).toBe(true);
});

// WEB-CHAT-10: real production App/controls, with only backend responses isolated.
async function escapeProduct(page: Page) {
  await page.addInitScript(() => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({
    version: 4, theme: 'light', locale: 'en', filesOpen: false, sidebarVisible: true, sound: false,
  })));
  const api = await installMockApi(page, { sessions: [mockSession('escape-stack', 'Escape stack')], holdAgentRun: true,
    indexedFiles: ['README.md'], paletteItems: [{ name: 'echo', description: 'Echo', source: 'builtin' }] });
  await page.goto('/chat/escape-stack?cwd=%2Fworkspace');
  await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).toBeVisible();
  return api;
}
const stops = (api: Awaited<ReturnType<typeof escapeProduct>>) => api.requests.filter(request => request.method === 'POST' && /\/api\/agent\/runs\/[^/]+\/stop$/.test(request.path));
async function composingEscape(page: Page, selector: string) {
  return page.locator(selector).evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

for (const coarse of [false, true]) {
  test.describe(coarse ? 'coarse Escape stack' : 'desktop Escape stack', () => {
    if (coarse) test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test('IME then nearest composer menu then agent Stop, without draft loss or repeat fan-out', async ({ page }) => {
      const api = await escapeProduct(page);
      const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
      await composer.fill('Keep busy'); await composer.press('Enter');
      await expect(page.locator('.stop-button')).toBeVisible();
      await composer.fill('/echo'); await expect(page.locator('.input-container .command-palette')).toBeVisible();
      expect(await composingEscape(page, '.input-container textarea')).toBe(false);
      await expect(page.locator('.input-container .command-palette')).toBeVisible(); expect(stops(api)).toHaveLength(0);
      await composer.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
      for (const extra of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
        await composer.evaluate((element, extra) => element.dispatchEvent(new KeyboardEvent('keydown',
          { key: 'Escape', bubbles: true, cancelable: true, ...extra })), extra);
        await expect(page.locator('.input-container .command-palette')).toBeVisible(); expect(stops(api)).toHaveLength(0);
      }
      await composer.press('Escape'); await expect(page.locator('.input-container .command-palette')).toHaveCount(0);
      await expect(composer).toHaveValue('/echo'); expect(stops(api)).toHaveLength(0);
      await composer.fill('@README'); await expect(page.locator('.file-palette')).toBeVisible();
      await composer.press('Escape'); await expect(page.locator('.file-palette')).toHaveCount(0);
      await expect(composer).toHaveValue('@README'); expect(stops(api)).toHaveLength(0);
      await composer.press('Escape'); await expect.poll(() => stops(api).length).toBe(1);
      await expect(page.locator('.stop-button')).toHaveCount(0);
      await composer.press('Escape'); expect(stops(api)).toHaveLength(1);
    });

    test('nested folder and picker consume separate Escapes and return focus without an unsolicited mobile editor', async ({ page }) => {
      await escapeProduct(page);
      if (coarse) await page.getByRole('button', { name: 'Toggle navigation' }).click();
      const opener = page.locator('.workspace-button'); await opener.click();
      const picker = page.locator('.directory-picker'); await expect(picker).toBeVisible();
      if (coarse) await expect(picker).toBeFocused(); else await expect(picker.getByLabel('Workspace path')).toBeFocused();
      expect(await composingEscape(page, '.directory-picker input')).toBe(false);
      await expect(picker).toBeVisible();
      await picker.locator('input').evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
      await picker.getByRole('button', { name: 'New folder', exact: true }).click();
      const folder = page.getByRole('dialog', { name: 'Create a folder' }); await expect(folder).toBeVisible();
      if (coarse) await expect(folder).toBeFocused(); else await expect(folder.getByLabel('Folder name')).toBeFocused();
      await page.keyboard.press('Escape'); await expect(folder).toHaveCount(0); await expect(picker).toBeVisible();
      await page.keyboard.press('Escape'); await expect(picker).toHaveCount(0); await expect(opener).toBeFocused();
    });

    test('dialog before Settings before chat, with IME protection and exact route return', async ({ page }) => {
      await escapeProduct(page);
      if (coarse) await page.getByRole('button', { name: 'Toggle navigation' }).click();
      await page.locator('.sidebar-footer').getByRole('button', { name: /Settings/ }).click();
      await expect(page).toHaveURL(/\/settings/); await expect(page.locator('.settings-view')).toBeVisible();
      const field = page.locator('.settings-view input').first();
      expect(await field.evaluate(element => {
        element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); element.dispatchEvent(event);
        return event.defaultPrevented;
      })).toBe(false);
      await expect(page).toHaveURL(/\/settings/);
      await field.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
      // Settings is modal: its inert sidebar cannot open the workspace picker.
      // The global palette remains an available nested modal; picker stacking is covered above.
      await expect(page.locator('.app')).toHaveAttribute('inert', '');
      await page.keyboard.press('Control+k'); await expect(page.locator('.global-command-palette')).toBeVisible();
      await expect(page.locator('.settings-dialog')).toHaveAttribute('inert', '');
      await page.keyboard.press('Escape'); await expect(page.locator('.global-command-palette')).toHaveCount(0); await expect(page).toHaveURL(/\/settings/);
      await expect(page.locator('.settings-dialog')).not.toHaveAttribute('inert');
      await page.keyboard.press('Escape'); await expect(page).toHaveURL(/\/chat\/escape-stack\?cwd=%2Fworkspace$/);
      await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).toBeVisible();
      expect(await page.evaluate(() => !(matchMedia('(pointer: coarse)').matches && document.activeElement?.matches('input, textarea')))).toBe(true);
    });

    test('the inline profile dialog owns Escape before Settings and restores its create button', async ({ page }) => {
      const api = await escapeProduct(page);
      if (coarse) await page.getByRole('button', { name: 'Toggle navigation' }).click();
      await page.locator('.sidebar-footer').getByRole('button', { name: /Settings/ }).click();
      await selectSettingsCategory(page, 'subagents');
      const create = page.getByRole('button', { name: 'Create profile', exact: true }); await create.click();
      const editor = page.getByRole('dialog', { name: 'Create profile', exact: true }); await expect(editor).toBeVisible();
      if (coarse) await expect(editor).toBeFocused(); else await expect(editor.locator('input').first()).toBeFocused();
      expect(await editor.locator('input').first().evaluate(element => {
        element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); element.dispatchEvent(event);
        return event.defaultPrevented;
      })).toBe(false);
      await expect(editor).toBeVisible();
      await editor.locator('input').first().evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
      await page.keyboard.press('Escape'); await expect(editor).toHaveCount(0); await expect(create).toBeFocused();
      await expect(page).toHaveURL(/\/settings/);
      expect(api.requests.filter(request => request.method === 'POST' && request.path === '/api/subagents/profiles')).toHaveLength(0);
      await page.keyboard.press('Escape'); await expect(page).toHaveURL(/\/chat\/escape-stack\?cwd=%2Fworkspace$/);
    });

    test('a global palette takes priority over an already open picker and returns ownership to it', async ({ page }) => {
      await escapeProduct(page);
      if (coarse) await page.getByRole('button', { name: 'Toggle navigation' }).click();
      await page.locator('.workspace-button').click(); await expect(page.locator('.directory-picker')).toBeVisible();
      await page.keyboard.press('Control+k'); await expect(page.locator('.global-command-palette')).toBeVisible();
      if (coarse) await expect(page.locator('.global-command-palette')).toBeFocused();
      await page.keyboard.press('Escape'); await expect(page.locator('.global-command-palette')).toHaveCount(0);
      await expect(page.locator('.directory-picker')).toBeVisible();
      await page.keyboard.press('Escape'); await expect(page.locator('.directory-picker')).toHaveCount(0);
    });
  });
}
