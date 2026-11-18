import { expect, test, type Page, type Route } from './fixtures/test-budget';
import AxeBuilder from '@axe-core/playwright';
import { installMockApi, mockSession } from './fixtures/mock-api';

const js = /\/assets\/WorkspacePanel-[^/]+\.js$/;
const css = /\/assets\/workspace-panel-[^/]+\.css$/;
const url = '/chat/workspace-assets?cwd=%2Fworkspace';
const pane = (page: Page) => page.getByRole('complementary', { name: 'Workspace explorer' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message composer', exact: true });
const toggle = (page: Page) => page.keyboard.press('Control+Shift+F');

async function product(page: Page, filesOpen = false) {
  await page.addInitScript(({ filesOpen }) => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({
    version: 4, theme: 'light', sidebarVisible: true, filesOpen, sound: false,
  })), { filesOpen });
  return installMockApi(page, {
    sessions: [mockSession('workspace-assets', 'Workspace assets', [
      { role: 'assistant', content: '[Open implementation](file:src/app.ts#L2)' },
    ]), mockSession('other', 'Other session')], holdAgentRun: true,
    workspaceBrowse: {
      '/workspace': { cwd: '/workspace',
        entries: [{ name: 'project', path: '/workspace/project', isDirectory: true, isSymbolicLink: false }] },
      '/workspace/project': { cwd: '/workspace/project', parent: '/workspace',
        entries: [{ name: 'project-marker', path: '/workspace/project/project-marker', isDirectory: true, isSymbolicLink: false }] },
    },
    workspaceFiles: [{ path: 'src/app.ts', content: 'const first = 1;\nexport const second = 2;',
      language: 'typescript', gitStatus: 'modified', diff: '@@ -1 +1 @@\n-old\n+new' }],
  });
}

async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test('closed production pane fetches no JS/CSS; open fetches both and close/reopen uses styled real pane', async ({ page }) => {
  await product(page);
  const assets: string[] = [];
  page.on('request', req => { if (js.test(req.url()) || css.test(req.url())) assets.push(req.url()); });
  await page.goto(url);
  await expect(composer(page)).toBeVisible();
  expect(assets).toEqual([]);
  await toggle(page);
  await expect(pane(page).locator('.file-name')).toBeVisible();
  await expect(pane(page)).toHaveCSS('display', 'flex');
  expect(assets.filter(asset => js.test(asset))).toHaveLength(1);
  expect(assets.filter(asset => css.test(asset))).toHaveLength(1);
  await pane(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(pane(page)).toHaveCount(0);
  await toggle(page);
  await expect(pane(page).locator('.file-name')).toBeVisible();
  await expect(pane(page)).toHaveCSS('display', 'flex');
  expect(assets).toHaveLength(2);
});

test('desktop saved default-open preference still mounts the real styled pane', async ({ page }) => {
  await product(page, true);
  await page.goto(url);
  await expect(pane(page).locator('.file-name')).toBeVisible();
  await expect(pane(page)).toHaveCSS('display', 'flex');
});

for (const [kind, asset] of [['JS', js], ['CSS', css]] as const) {
  test(`delayed production ${kind} keeps composer/Stop/palette and Cancel reachable`, async ({ page }) => {
    let held: Route | undefined;
    await page.route(asset, route => { held = route; });
    await product(page);
    await page.goto(url);
    await expect(composer(page)).toBeVisible();
    await toggle(page);
    await expect(pane(page).getByRole('status')).toHaveText('Loading the file pane…');
    await expect(pane(page).getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
    expect((await new AxeBuilder({ page }).include('.workspace-panel-loading').analyze()).violations).toEqual([]);
    await composer(page).fill('Continue while files load');
    await composer(page).press('Enter');
    await expect(page.locator('.stop-button')).toBeEnabled();
    await page.locator('.stop-button').click();
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect.poll(() => Boolean(held)).toBe(true);
    await pane(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(pane(page)).toHaveCount(0);
    await composer(page).focus();
    const loaded = page.waitForResponse(response => asset.test(response.url()));
    await held!.continue(); await loaded; await settle(page);
    await expect(pane(page)).toHaveCount(0);
    await expect(composer(page)).toBeFocused();
  });
  test(`failed production ${kind} exposes a visible local error and working close`, async ({ page }) => {
    await page.route(asset, route => route.abort('failed'));
    await product(page);
    await page.goto(url);
    await expect(composer(page)).toBeVisible();
    await toggle(page);
    await expect(pane(page).getByRole('alert')).toHaveText('The file pane could not load. Reload the page to try again.');
    await expect(composer(page)).toBeVisible();
    await pane(page).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(pane(page)).toHaveCount(0);
    // Reopen may not claim success after an ESM network rejection.
    await toggle(page);
    await expect(pane(page).getByRole('alert')).toBeVisible();
    await expect(pane(page).locator('.file-tree')).toHaveCount(0);
    expect((await new AxeBuilder({ page }).include('.workspace-panel-loading').analyze()).violations).toEqual([]);
    const retry = pane(page).getByRole('button', { name: 'Reload and retry', exact: true });
    await expect(retry).toBeEnabled();
    await expect(pane(page).getByText('Copy unsent text before reloading the page: it may be lost.', { exact: true })).toBeVisible();
    await page.unroute(asset);
    await Promise.all([page.waitForNavigation(), retry.press('Enter')]);
    // Reload clears the real ESM failure cache, not an invented retry.
    await toggle(page);
    await expect(pane(page).locator('.file-name')).toBeVisible();
    await expect(pane(page)).toHaveCSS('display', 'flex');
  });
}

test('file-link intent waits for delayed pane then the real viewer opens the requested line', async ({ page }) => {
  let held: Route | undefined;
  await page.route(js, route => { held = route; });
  await product(page);
  await page.goto(url);
  await page.getByRole('link', { name: 'Open implementation' }).click();
  await expect(pane(page).getByRole('status')).toBeVisible();
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('aih-open-file', { detail: { path: 'src/app.ts', line: 1 } }));
    window.dispatchEvent(new CustomEvent('aih-open-file', { detail: { path: 'src/app.ts', line: 2 } }));
    window.dispatchEvent(new CustomEvent('aih-open-file', { detail: 'x'.repeat(4097) }));
  });
  await held!.continue();
  await expect(pane(page).locator('.file-viewer > header')).toContainText('app.ts');
  await expect(pane(page).locator('#source-line-2')).toHaveClass(/target-line/);
});

for (const end of ['settings', 'session', 'workspace'] as const) {
  test(`late production load after ${end} cannot mount the previous pane or replay its file intent`, async ({ page }) => {
    let held: Route | undefined;
    await page.route(js, route => { held = route; });
    const api = await product(page);
    await page.goto(url);
    await page.getByRole('link', { name: 'Open implementation' }).click();
    await expect(pane(page).getByRole('status')).toBeVisible();
    await expect.poll(() => Boolean(held)).toBe(true);
    if (end === 'workspace') {
      await page.locator('.workspace-button').click();
      const picker = page.locator('.directory-picker');
      await picker.getByRole('button', { name: 'project', exact: true }).click();
      await expect(picker.getByRole('button', { name: 'project-marker', exact: true })).toBeVisible();
      await picker.getByRole('button', { name: 'Use this workspace' }).click();
      await expect(page).toHaveURL(/cwd=%2Fworkspace%2Fproject/);
    } else {
      const target = end === 'settings' ? '/settings' : '/chat/other?cwd=%2Fworkspace';
      await page.evaluate(target => { history.pushState(null, '', target); window.dispatchEvent(new PopStateEvent('popstate')); }, target);
      await expect(page).toHaveURL(end === 'settings' ? /\/settings$/ : /\/chat\/other/);
    }
    // Fresh workspaces have no active conversation/composer yet.
    const focusTarget = end === 'workspace' ? page.getByRole('button', { name: 'New chat', exact: true }) : composer(page);
    if (end !== 'settings') await focusTarget.focus();
    const loaded = page.waitForResponse(response => js.test(response.url()));
    await held!.continue(); await loaded; await settle(page);
    await expect(page.locator('.file-viewer')).toHaveCount(0);
    expect(api.requests.some(req => req.path === '/api/files/content')).toBe(false);
    if (end === 'settings') await expect(pane(page)).toHaveCount(0);
    else {
      // filesOpen remains true: only the newly keyed, current surface may mount.
      await expect(pane(page).locator('.file-name')).toBeVisible();
      await expect(focusTarget).toBeFocused();
    }
  });
}

// Coordinator regression: DOM is present before the child passive listener mounts.
test('commit-phase open-file intent survives actual pane mount', async ({ page }) => {
  await product(page);
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      if (!document.querySelector('.workspace-panel .file-toolbar')) return;
      observer.disconnect();
      window.dispatchEvent(new CustomEvent('aih-open-file', { detail: { path: 'src/app.ts', line: 2 } }));
      document.documentElement.dataset.commitFileDispatched = 'yes';
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  await page.goto(url);
  await expect(composer(page)).toBeVisible();
  await toggle(page);
  await expect(page.locator('html')).toHaveAttribute('data-commit-file-dispatched', 'yes');
  await expect(pane(page).locator('.file-viewer > header')).toContainText('app.ts');
  await expect(pane(page).locator('#source-line-2')).toHaveClass(/target-line/);
});

// The palette is also reachable while the optional workspace asset is pending.
// Exercise its own real production chunk here, using the same owning preview.
const paletteJs = /\/assets\/CommandPalette-[^/]+\.js$/;
const palette = (page: Page) => page.getByRole('dialog', { name: 'Command palette', exact: true });

test('palette optional asset: closed shell fetches none; first open and cached reopen preserve focus and commands', async ({ page }) => {
  await product(page);
  const assets: string[] = [];
  page.on('request', request => { if (paletteJs.test(request.url())) assets.push(request.url()); });
  await page.goto(url);
  await expect(composer(page)).toBeVisible();
  expect(assets).toEqual([]);
  await composer(page).focus();
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await expect(palette(page).getByRole('textbox')).toBeFocused();
  expect(assets).toHaveLength(1);
  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveCount(0);
  await expect(composer(page)).toBeFocused();
  await page.keyboard.press('Control+k');
  await expect(palette(page).getByRole('textbox')).toBeFocused();
  expect(assets).toHaveLength(1);
  await palette(page).getByRole('option').filter({ hasText: 'Appearance' }).click();
  await expect(page).toHaveURL(/\/settings#appearance$/);
  await expect(palette(page)).toHaveCount(0);
});

for (const close of ['Escape', 'Control+k'] as const) {
  test(`palette optional asset: delayed import cancels with ${close} without suspending composer or stopping its run`, async ({ page }) => {
    let held: Route | undefined;
    await page.route(paletteJs, route => { held = route; });
    await product(page);
    await page.goto(url);
    await composer(page).fill('Keep this run active while the palette loads');
    await composer(page).press('Enter');
    await expect(page.locator('.stop-button')).toBeEnabled();
    await composer(page).focus();
    await page.keyboard.press('Control+k');
    await expect.poll(() => Boolean(held)).toBe(true);
    await expect(composer(page)).toBeVisible();
    await expect(page.locator('.stop-button')).toBeEnabled();
    await composer(page).fill('Unsent draft survives optional loading');
    await page.keyboard.press(close);
    await expect(page.locator('.stop-button')).toBeEnabled();
    await expect(composer(page)).toHaveValue('Unsent draft survives optional loading');
    const loaded = page.waitForResponse(response => paletteJs.test(response.url()));
    await held!.continue(); await loaded; await settle(page);
    await expect(palette(page)).toHaveCount(0);
    await expect(composer(page)).toBeFocused();
    await page.locator('.stop-button').click();
    await page.keyboard.press('Control+k');
    await expect(palette(page).getByRole('textbox')).toBeFocused();
  });
}

for (const locale of ['en', 'fr'] as const) {
  test(`palette optional asset: rejected import (${locale}) reports locally, stays rejected until reload and leaves chat usable`, async ({ page }) => {
    await page.addInitScript(locale => localStorage.setItem('ai-harness-locale', locale), locale);
    await page.route(paletteJs, route => route.abort('failed'));
    await product(page);
    const assets: string[] = [];
    const errors: string[] = [];
    page.on('request', request => { if (paletteJs.test(request.url())) assets.push(request.url()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    const input = page.locator('.input-container textarea');
    await expect(input).toBeVisible();
    await input.fill('Preserve my draft');
    await input.focus();
    await page.keyboard.press('Control+k');
    const message = locale === 'fr'
      ? 'La palette de commandes n’a pas pu être chargée. Rechargez la page pour réessayer.'
      : 'The command palette could not load. Reload the page to try again.';
    const notice = page.getByRole('alert').filter({ hasText: message });
    await expect(notice).toBeVisible();
    await expect(input).toHaveValue('Preserve my draft');
    await expect(input).toBeFocused();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(assets).toHaveLength(1);
    await notice.getByRole('button', { name: locale === 'fr' ? 'Fermer' : 'Close', exact: true }).click();
    await page.keyboard.press('Control+k');
    await expect(notice).toBeVisible();
    expect(assets).toHaveLength(1);
    expect(errors).toEqual([]);
    await page.unroute(paletteJs);
    // A real document reload resets ESM failure; no retry of the failed promise.
    await page.reload();
    await expect(input).toBeVisible();
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: locale === 'fr' ? 'Palette de commandes' : 'Command palette', exact: true })).toBeVisible();
    expect(assets).toHaveLength(2);
  });
}

test('palette optional asset: navigation retires a pending import without reopening or stealing focus', async ({ page }) => {
  let held: Route | undefined;
  await page.route(paletteJs, route => { held = route; });
  await product(page);
  await page.goto(url);
  await expect(composer(page)).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.evaluate(() => {
    history.pushState(null, '', '/chat/other?cwd=%2Fworkspace');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page).toHaveURL(/\/chat\/other/);
  await composer(page).fill('New conversation draft');
  await composer(page).focus();
  const loaded = page.waitForResponse(response => paletteJs.test(response.url()));
  await held!.continue(); await loaded; await settle(page);
  await expect(palette(page)).toHaveCount(0);
  await expect(composer(page)).toHaveValue('New conversation draft');
  await expect(composer(page)).toBeFocused();
});
