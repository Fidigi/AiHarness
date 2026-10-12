import { expect, test, type Page, type Route } from './fixtures/test-budget';
import AxeBuilder from '@axe-core/playwright';
import { installMockApi, mockSession } from './fixtures/mock-api';
// Real emitted Web and compiled launcher. API control is ONLY for asset lifetime;
// the unchanged linked-directories.spec.ts proves actual RuntimeServices journeys.
const js = /\/assets\/LinkedDirectoryModal-[^/]+\.js$/;
const css = /\/assets\/LinkedDirectoryModal-[^/]+\.css$/;
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message composer', exact: true });
const boundary = (page: Page) => page.locator('.linked-directory-boundary');
const dialog = (page: Page) => page.locator('.linked-directory-dialog');
test.afterEach(async ({ page }) => {
  await test.info().attach('production-page', { body: await page.screenshot(), contentType: 'image/png' });
  await test.info().attach('visible-product-text', { body: await page.locator('body').innerText(), contentType: 'text/plain' });
});
async function product(page: Page, owner: 'sidebar' | 'panel') {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/workspaces/linked-directories')) requests.push(request.method() + ' ' + request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({
    version: 4, theme: 'light', sidebarVisible: true, filesOpen: true, sound: false,
  })));
  await installMockApi(page, { sessions: [mockSession('assets', 'Asset session'), mockSession('other', 'Other session')], holdAgentRun: true,
    workspaceBrowse: { '/workspace': { cwd: '/workspace', entries: [{ name: 'project', path: '/workspace/project', isDirectory: true, isSymbolicLink: false }] },
      '/workspace/project': { cwd: '/workspace/project', parent: '/workspace', entries: [] } },
  });
  await page.route('**/api/workspaces/linked-directories?*', route => {
    const url = new URL(route.request().url());
    return route.fulfill({ json: { cwd: url.searchParams.get('cwd'), directory: url.searchParams.get('directory'),
      revision: 'b'.repeat(64), entries: [], truncated: false, restriction: 'scoped-files-only' } });
  });
  await page.goto('/chat/assets?cwd=%2Fworkspace');
  await expect(composer(page)).toBeVisible();
  const invoker = page.locator(owner === 'sidebar' ? '.workspace-linked-directories' : '.panel-linked-directories');
  await expect(invoker).toBeVisible();
  return { invoker, requests, errors };
}
async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
for (const owner of ['sidebar', 'panel'] as const) {
  for (const [kind, asset] of [['JS', js], ['CSS', css]] as const) {
    test(owner + ' delayed real ' + kind + ': local Close, no API, live Stop, no trap, ready handoff', async ({ page }) => {
      let held: Route | undefined;
      await page.route(asset, route => { held = route; });
      const { invoker, requests, errors } = await product(page, owner);
      await invoker.click();
      await expect.poll(() => Boolean(held)).toBe(true);
      await expect(boundary(page).getByRole('status')).toBeVisible();
      await expect(boundary(page).getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
      expect(requests).toEqual([]);
      await expect(dialog(page)).toHaveCount(0);
      await composer(page).fill('Stop must remain alive'); await composer(page).press('Enter');
      await expect(page.locator('.stop-button')).toBeEnabled(); await page.locator('.stop-button').click();
      await composer(page).focus(); await expect(composer(page)).toBeFocused();
      await boundary(page).getByRole('button', { name: 'Close', exact: true }).focus();
      await page.keyboard.press('Tab');
      await expect(boundary(page).getByRole('button', { name: 'Close', exact: true })).not.toBeFocused();
      const axe = await new AxeBuilder({ page }).include('.linked-directory-boundary').withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(axe.violations).toEqual([]);
      await invoker.focus();
      const focus: string[] = [];
      await page.exposeFunction('boundaryFocus', (value: string) => focus.push(value));
      await page.evaluate(() => document.addEventListener('focusin', event => {
        const element = event.target as HTMLElement;
        void (window as unknown as { boundaryFocus: (value: string) => Promise<void> }).boundaryFocus(element.className + ':' + element.getAttribute('aria-label'));
      }));
      await held!.continue();
      await expect(dialog(page)).toBeVisible();
      await expect(dialog(page).getByRole('button', { name: 'Close', exact: true })).toBeFocused();
      await expect(boundary(page)).toHaveCount(0);
      expect(focus.some(value => value.includes('Message composer'))).toBe(false);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain('GET ');
      await page.keyboard.press('Escape'); await expect(invoker).toBeFocused();
      expect(errors).toEqual([]);
    });
    test(owner + ' failed real ' + kind + ': local error, cached reopen, explicit reload warning and recovery', async ({ page }) => {
      await page.route(asset, route => route.abort('failed'));
      const { invoker, requests, errors } = await product(page, owner);
      await invoker.click();
      await expect(boundary(page).getByRole('alert')).toContainText('Reload the page to retry');
      await expect(boundary(page)).toContainText('unsent text may be lost');
      await expect(composer(page)).toBeVisible();
      expect(requests).toEqual([]); expect(errors).toEqual([]);
      await boundary(page).getByRole('button', { name: 'Close', exact: true }).click();
      await expect(boundary(page)).toHaveCount(0);
      await page.unroute(asset);
      await invoker.click();
      await expect(boundary(page).getByRole('alert')).toBeVisible();
      await expect(dialog(page)).toHaveCount(0); expect(requests).toEqual([]);
      await boundary(page).getByRole('button', { name: 'Reload page to retry', exact: true }).click();
      await expect(composer(page)).toBeVisible();
      await expect(boundary(page)).toHaveCount(0);
      await invoker.click(); await expect(dialog(page)).toBeVisible();
      await expect(dialog(page).getByRole('button', { name: 'Close', exact: true })).toBeFocused();
      expect(requests).toHaveLength(1);
      await page.keyboard.press('Escape');
    });
  }
  for (const end of ['close', 'session', 'settings', 'workspace', 'pane-close'] as const) {
    test(owner + ' late real JS after ' + end + ' cannot reopen or request stale metadata', async ({ page }) => {
      let held: Route | undefined;
      await page.route(js, route => { held = route; });
      const { invoker, requests } = await product(page, owner);
      await invoker.click(); await expect.poll(() => Boolean(held)).toBe(true);
      await expect(boundary(page)).toBeVisible();
      if (end === 'close') await boundary(page).getByRole('button', { name: 'Close', exact: true }).click();
      else if (end === 'pane-close') {
        if (owner === 'panel') await page.getByRole('button', { name: 'Collapse workspace explorer' }).click();
        else await page.keyboard.press('Control+Shift+S');
      } else if (end === 'workspace') {
        await page.locator('.workspace-button').click();
        const picker = page.locator('.directory-picker');
        await picker.getByRole('button', { name: '📁 project', exact: true }).click();
        await picker.getByRole('button', { name: 'Use this workspace' }).click();
        await expect(page).toHaveURL(/cwd=%2Fworkspace%2Fproject/);
      } else {
        const target = end === 'settings' ? '/settings' : '/chat/other?cwd=%2Fworkspace';
        await page.evaluate(target => { history.pushState(null, '', target); window.dispatchEvent(new PopStateEvent('popstate')); }, target);
        await expect(page).toHaveURL(end === 'settings' ? /settings/ : /chat\/other/);
      }
      await expect(boundary(page)).toHaveCount(0);
      const loaded = page.waitForResponse(response => js.test(response.url()));
      await held!.continue(); await loaded; await settle(page);
      await expect(boundary(page)).toHaveCount(0); await expect(dialog(page)).toHaveCount(0);
      expect(requests).toEqual([]);
      if (end === 'close') { await invoker.click(); await expect(dialog(page)).toBeVisible(); expect(requests).toHaveLength(1); }
    });
  }
}

for (const owner of ['sidebar', 'panel'] as const) {
  test(owner + ' close/reopen while the real JS is pending keeps only the latest lifetime', async ({ page }) => {
    let held: Route | undefined; let downloads = 0;
    await page.route(js, route => { held = route; downloads++; });
    const { invoker, requests } = await product(page, owner);
    await invoker.click(); await expect(boundary(page)).toBeVisible();
    await expect.poll(() => Boolean(held)).toBe(true);
    await boundary(page).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(invoker).toBeFocused(); await expect(boundary(page)).toHaveCount(0);
    await invoker.click(); await expect(boundary(page).getByRole('status')).toBeVisible();
    await page.keyboard.press('Escape'); await expect(invoker).toBeFocused();
    await expect(boundary(page)).toHaveCount(0);
    await invoker.click(); await expect(boundary(page).getByRole('status')).toBeVisible();
    expect(requests).toEqual([]); expect(downloads).toBe(1);
    await held!.continue(); await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByRole('button', { name: 'Close', exact: true })).toBeFocused();
    expect(requests).toHaveLength(1); expect(downloads).toBe(1);
    await page.keyboard.press('Escape'); await expect(invoker).toBeFocused();
  });
}
test('folder replacement during the real import requests only the latest explicit folder', async ({ page }) => {
  let held: Route | undefined;
  await page.route(js, route => { held = route; });
  const { requests } = await product(page, 'panel');
  await page.route('**/api/files?*', route => route.fulfill({ json: { cwd: '/workspace', path: '.', entries: [
    { name: 'first link', path: 'first/external', isDirectory: false, isSymbolicLink: true, hidden: false },
    { name: 'second link', path: 'second/external', isDirectory: false, isSymbolicLink: true, hidden: false },
  ] } }));
  const panel = page.locator('.workspace-panel');
  await panel.getByRole('button', { name: 'Refresh files' }).click();
  await panel.getByRole('button', { name: /first link/ }).click();
  await expect.poll(() => Boolean(held)).toBe(true); await expect(boundary(page)).toBeVisible();
  await panel.getByRole('button', { name: /second link/ }).click();
  expect(requests).toEqual([]);
  await held!.continue(); await expect(dialog(page)).toBeVisible();
  expect(requests).toHaveLength(1); expect(requests[0]).toContain('directory=second');
  await expect(dialog(page).getByRole('textbox')).toHaveValue('second');
});

test('latest Sidebar/pane activation during import owns one modal and one focus trap', async ({ page }) => {
  let held: Route | undefined;
  await page.route(js, route => { held = route; });
  const { invoker, requests } = await product(page, 'sidebar');
  await invoker.click(); await expect(boundary(page)).toHaveCount(1);
  await expect.poll(() => Boolean(held)).toBe(true);
  const latest = page.locator('.panel-linked-directories');
  await latest.click(); await expect(boundary(page)).toHaveCount(1);
  expect(requests).toEqual([]);
  await held!.continue(); await expect(dialog(page)).toHaveCount(1);
  await expect(dialog(page).getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  expect(requests).toHaveLength(1);
  await page.keyboard.press('Escape'); await expect(latest).toBeFocused();
  await expect(dialog(page)).toHaveCount(0);
});

// Appended regressions: original 22 production boundary cases are unchanged.
for (const owner of ['sidebar', 'panel'] as const) {
  test(owner + ' pending linked focus: composing Escape is inert', async ({ page }) => {
    let held: Route | undefined;
    await page.route(js, route => { held = route; });
    const { invoker, requests } = await product(page, owner);
    await invoker.click();
    await expect.poll(() => Boolean(held)).toBe(true);
    await expect(boundary(page)).toBeVisible();
    await composer(page).focus();
    await composer(page).evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true, isComposing: true,
    })));
    await expect(boundary(page)).toBeVisible();
    await expect(composer(page)).toBeFocused();
    expect(requests).toEqual([]);
    await held!.abort();
  });
  test(owner + ' pending linked focus: ordinary Escape preserves newer composer focus', async ({ page }) => {
    let held: Route | undefined;
    await page.route(js, route => { held = route; });
    const { invoker, requests } = await product(page, owner);
    await invoker.click();
    await expect.poll(() => Boolean(held)).toBe(true);
    await expect(boundary(page)).toBeVisible();
    await composer(page).fill('A newer unsent focus owner');
    await composer(page).press('Escape');
    await expect(boundary(page)).toHaveCount(0);
    await expect(composer(page)).toBeFocused();
    await expect(composer(page)).toHaveValue('A newer unsent focus owner');
    expect(requests).toEqual([]);
    await held!.abort();
  });
  test(owner + ' pending linked focus: late readiness cannot steal newer composer focus or open metadata', async ({ page }) => {
    let held: Route | undefined;
    await page.route(js, route => { held = route; });
    const { invoker, requests } = await product(page, owner);
    await invoker.click();
    await expect.poll(() => Boolean(held)).toBe(true);
    await expect(boundary(page)).toBeVisible();
    await composer(page).fill('Keep this new edit and focus');
    const loaded = page.waitForResponse(response => js.test(response.url()));
    await held!.continue();
    await loaded;
    await expect(boundary(page)).toHaveCount(0);
    await expect(dialog(page)).toHaveCount(0);
    await expect(composer(page)).toBeFocused();
    await expect(composer(page)).toHaveValue('Keep this new edit and focus');
    expect(requests).toEqual([]);
  });
}

for (const owner of ['sidebar', 'panel'] as const) {
  test(owner + ' pending linked focus: consent completion preserves newer Close focus', async ({ page }) => {
    let held: Route | undefined;
    const { invoker } = await product(page, owner);
    const inventory = {
      cwd: '/workspace', directory: '.', revision: 'b'.repeat(64), truncated: false,
      restriction: 'scoped-files-only', entries: [{ id: 'a'.repeat(64), name: 'external',
        rawTarget: '/outside', canonicalTarget: '/outside', hiddenCharacters: false,
        reason: 'directory', allowed: false }],
    };
    await page.route('**/api/workspaces/linked-directories?*', route => route.fulfill({ json: inventory }));
    await page.route('**/api/workspaces/linked-directories/consent', route => { held = route; });
    await invoker.click();
    await expect(dialog(page)).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Review directory consent', exact: true }).click();
    await dialog(page).getByRole('checkbox').check();
    await dialog(page).getByRole('button', { name: 'Allow directory', exact: true }).click();
    await expect.poll(() => Boolean(held)).toBe(true);
    const close = dialog(page).getByRole('button', { name: 'Close', exact: true });
    await close.focus();
    await expect(close).toBeFocused();
    await held!.fulfill({ json: { ...inventory, revision: 'c'.repeat(64),
      entries: inventory.entries.map(entry => ({ ...entry, allowed: true })) } });
    await expect(dialog(page).getByRole('button', { name: 'Revoke consent', exact: true })).toBeEnabled();
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(invoker).toBeFocused();
  });
}

// Ready-modal IME regressions append; no existing case/body/assertion is changed.
for (const owner of ['sidebar', 'panel'] as const) {
  test(owner + ' ready linked IME: composing and legacy Escape preserve the source edit', async ({ page }) => {
    const { invoker, requests } = await product(page, owner);
    await composer(page).fill('Preserve the unsent composer draft');
    await invoker.click();
    await expect(dialog(page)).toBeVisible();
    const source = dialog(page).getByRole('textbox', { name: 'Relative source folder', exact: true });
    await source.fill('中文目录');
    await source.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true, isComposing: true,
    })));
    await expect(dialog(page)).toBeVisible();
    await expect(source).toBeFocused();
    await expect(source).toHaveValue('中文目录');
    await source.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true, keyCode: 229,
    })));
    await expect(dialog(page)).toBeVisible();
    await expect(source).toBeFocused();
    await expect(source).toHaveValue('中文目录');
    await expect(composer(page)).toHaveValue('Preserve the unsent composer draft');
    expect(requests).toHaveLength(1);
    await source.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(invoker).toBeFocused();
    await expect(composer(page)).toHaveValue('Preserve the unsent composer draft');
  });
}

// Append-only proof: ordinary-read refusal cannot acquire a newer focus lifetime.
test('late refused ordinary link read cannot replace newer composer intent', async ({ page }) => {
  let held: Route | undefined;
  const { requests } = await product(page, 'panel');
  await page.route('**/api/files?*', route => route.fulfill({ json: { cwd: '/workspace', path: '.', entries: [
    { name: 'late link', path: 'late/external', isDirectory: false, isSymbolicLink: true, hidden: false },
  ] } }));
  await page.route('**/api/files/content?*', route => { held = route; });
  const panel = page.locator('.workspace-panel');
  await panel.getByRole('button', { name: 'Refresh files' }).click();
  await panel.getByRole('button', { name: /late link/ }).click();
  await expect.poll(() => Boolean(held)).toBe(true);
  const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
  await composer.fill('保留 ordinary unsent draft');
  await composer.focus();
  await held!.fulfill({ status: 404, json: { error: 'refused-linked-read' } });
  // This visible owning result proves the delayed body was consumed, not merely replied.
  await expect(panel.locator('.panel-error')).toContainText('refused-linked-read');
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('保留 ordinary unsent draft');
  await expect(boundary(page)).toHaveCount(0);
  await expect(dialog(page)).toHaveCount(0);
  expect(requests).toEqual([]);
});
