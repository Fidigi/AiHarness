import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Route } from './fixtures/test-budget';
import { installMockApi, mockSession } from './fixtures/mock-api';
import { closeSettings, selectGeneralSettings, selectModelSettings } from './fixtures/settings-navigation';

const asset = /\/assets\/settings-locale-[^/]+\.js$/;
const chat = '/chat/locale-first?cwd=%2Fworkspace';
const boundary = (page: Page) => page.locator('.settings-locale-boundary');
const composer = (page: Page) => page.locator('.input-container textarea');

async function product(page: Page, locale: 'en' | 'fr' = 'en') {
  await page.addInitScript(locale => {
    localStorage.setItem('ai-harness-locale', locale);
    localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({
      version: 4, theme: 'light', sidebarVisible: true, filesOpen: false, sound: false,
    }));
  }, locale);
  return installMockApi(page, {
    sessions: [mockSession('locale-first', 'Locale first'), mockSession('locale-second', 'Locale second')],
    holdAgentRun: true,
    workspaceBrowse: {
      '/workspace': { cwd: '/workspace', entries: [{ name: 'project', path: '/workspace/project', isDirectory: true, isSymbolicLink: false }] },
      '/workspace/project': { cwd: '/workspace/project', parent: '/workspace', entries: [{ name: 'marker', path: '/workspace/project/marker', isDirectory: true, isSymbolicLink: false }] },
    },
  });
}
async function open(page: Page) { await page.keyboard.press('Control+,'); }
async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

for (const phase of ['auth', 'chrome', 'settings'] as const) {
  test(phase === 'chrome' ? 'Pending Sidebar leaves chat Stop and Settings drafts usable'
    : `Settings entry failure evidence stays value-free while ${phase} is pending`, async ({ page }, testInfo) => {
    const api = await product(page);
    const held: Route[] = [];
    const target = phase === 'auth' ? '**/api/auth/status' : phase === 'chrome' ? '**/assets/Sidebar-*.js' : '**/assets/SettingsView-*.js';
    await page.route(target, route => { held.push(route); });
    const synthetic = 'SYNTHETIC_ENTRY_EVIDENCE_NOT_FOR_DIAGNOSTICS';
    try {
      await page.goto(phase === 'chrome' ? chat : `/settings?fixture=${synthetic}`);
      await expect.poll(() => held.length).toBeGreaterThan(0);
      if (phase === 'chrome') {
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 844 });
          await expect(composer(page)).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
          const capture = testInfo.outputPath(`sidebar-pending-${width}.png`);
          await page.screenshot({ path: capture, animations: 'disabled', caret: 'hide' });
          await testInfo.attach(`sidebar-pending-${width}`, { path: capture, contentType: 'image/png' });
          if (width === 390) {
            const menu = page.locator('.mobile-menu'), loading = page.locator('p.sidebar[role="status"]');
            await expect(loading).not.toBeInViewport();
            await menu.click(); await expect(menu).toHaveAttribute('aria-expanded', 'true');
            await expect(loading).toBeInViewport({ ratio: 1 });
            await page.keyboard.press('Escape'); await expect(menu).toHaveAttribute('aria-expanded', 'false');
            await expect(loading).not.toBeInViewport();
          }
        }
        await composer(page).fill('Continue while Sidebar loads'); await composer(page).press('Enter');
        await expect(page.locator('.stop-button')).toBeEnabled();
        await open(page); await selectGeneralSettings(page, 'authentication');
        const token = page.locator('#authentication input[type="password"]');
        await token.fill(synthetic);
        await selectGeneralSettings(page, 'appearance'); await selectGeneralSettings(page, 'authentication');
        await expect(token).toHaveValue(synthetic); await token.focus();
        const address = page.url();
        await expect(page.locator('aside.sidebar')).toHaveCount(0);
        await Promise.all(held.splice(0).map(route => route.fallback()));
        await expect(page.locator('aside.sidebar')).toHaveCount(1);
        await expect.poll(() => page.locator('aside.sidebar').evaluate(element => Boolean(element.closest('[inert]')))).toBe(true);
        await expect(token).toHaveValue(synthetic); await expect(token).toBeFocused(); await expect(page).toHaveURL(address);
        expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(synthetic);
        await closeSettings(page, { discardDrafts: true });
        await expect(page.locator('.stop-button')).toBeEnabled(); await page.locator('.stop-button').click();
        expect(api.requests.filter(request => request.path === '/api/config' || request.path === '/api/configuration/scope')
          .filter(request => request.method !== 'GET')).toEqual([]);
        expect(testInfo.attachments.filter(item => item.name === 'settings-entry-state')).toHaveLength(0);
        return;
      }
      await page.evaluate(value => {
        const input = document.createElement('input'); input.type = 'password'; input.value = value; document.body.append(input);
      }, synthetic);
      let failure: unknown;
      try { await selectGeneralSettings(page, 'appearance'); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).toContain('.settings-dialog');
      const attachment = testInfo.attachments.find(item => item.name === 'settings-entry-state');
      expect(attachment?.path).toBeTruthy();
      const body = readFileSync(attachment!.path!);
      expect(body.toString()).not.toContain(synthetic);
      const state = JSON.parse(body.toString());
      expect(state).toMatchObject({ dialogElements: 0, localeBoundaryElements: 0,
        rootLoadingElements: phase === 'settings' ? 0 : 1,
        routeLoadingElements: phase === 'settings' ? 1 : 0,
        chromeElements: phase === 'settings' ? 1 : 0 });
      if (phase === 'auth') expect(state.authResources).toBe(0);
      else expect(state.authResources).toBeGreaterThan(0);
      expect(Object.keys(state).sort()).toEqual(['authResources', 'chromeElements', 'dialogElements', 'localeBoundaryElements',
        'readyState', 'rootLoadingElements', 'routeLoadingElements', 'settingsModules', 'sidebarModules'].sort());
      if (phase === 'auth') {
        const evaluate = page.evaluate;
        page.evaluate = () => new Promise<never>(() => {});
        try {
          let blocked: unknown;
          try { await selectGeneralSettings(page, 'appearance'); } catch (error) { blocked = error; }
          expect(blocked).toBeInstanceOf(Error); expect((blocked as Error).message).toContain('.settings-dialog');
          expect(testInfo.attachments.filter(item => item.name === 'settings-entry-state')).toHaveLength(1);
        } finally { page.evaluate = evaluate; }
      }
    } finally { await Promise.all(held.map(route => route.fallback().catch(() => undefined))); }
    if (phase === 'auth') {
      await page.close();
      let failure: unknown;
      try { await selectGeneralSettings(page, 'appearance'); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message.replace(/\u001b\[[\d;]*m/g, '')).toContain('expect(locator).toBeVisible');
      expect(testInfo.attachments.filter(item => item.name === 'settings-entry-state')).toHaveLength(1);
    }
  });
}

test('closed Settings fetches no feature copy; opening and reopening register real dictionaries once', async ({ page }) => {
  await product(page);
  const requests: string[] = [];
  page.on('request', request => { if (asset.test(request.url())) requests.push(request.url()); });
  await page.goto(chat);
  await expect(composer(page)).toBeVisible();
  expect(requests).toEqual([]);
  await open(page);
  await selectModelSettings(page, 'provider-lifecycle');
  await expect(page.getByRole('heading', { name: 'Provider connections and custom providers', exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
  await closeSettings(page);
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(composer(page)).toBeVisible();
  await open(page);
  await selectGeneralSettings(page, 'authentication');
  await expect(page.getByRole('heading', { name: 'Server authentication', exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
  await closeSettings(page);
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('fr');
  await open(page);
  await expect(page.getByRole('heading', { name: 'Authentification du serveur', exact: true })).toBeVisible();
  await selectModelSettings(page, 'provider-lifecycle');
  await expect(page.getByRole('heading', { name: 'Connexions fournisseur et fournisseurs personnalisés', exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
});

for (const locale of ['en', 'fr'] as const) {
  test(`delayed actual Settings copy (${locale}) has translated loading/close and palette; completion renders no transient English`, async ({ page }) => {
    let held: Route | undefined;
    await page.route(asset, route => { held = route; });
    const api = await product(page, locale);
    await page.goto('/settings#authentication');
    await expect(boundary(page).getByRole('status')).toHaveText(locale === 'fr'
      ? 'Chargement des traductions des réglages…' : 'Loading Settings translations…');
    await expect(boundary(page).getByRole('link', { name: locale === 'fr' ? 'Fermer' : 'Close', exact: true })).toBeEnabled();
    expect(api.requests.some(request => request.path === '/api/provider-registry/auth')).toBe(false);
    expect((await new AxeBuilder({ page }).include('.settings-locale-boundary').analyze()).violations).toEqual([]);
    const selector = page.locator('.language-selector select');
    await expect(selector).toHaveAccessibleName(locale === 'fr' ? 'Langue' : 'Language');
    await selector.selectOption(locale === 'fr' ? 'en' : 'fr');
    await expect(boundary(page).getByRole('status')).toHaveText(locale === 'fr'
      ? 'Loading Settings translations…' : 'Chargement des traductions des réglages…');
    await selector.selectOption(locale);
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: locale === 'fr' ? 'Palette de commandes' : 'Command palette', exact: true })).toBeVisible();
    await expect.poll(() => Boolean(held)).toBe(true);
    await held!.continue();
    await expect(page.locator('#authentication')).toBeAttached();
    await settle(page);
    // Completing copy must not take keyboard ownership from the newer palette.
    const palette = page.getByRole('dialog', { name: locale === 'fr' ? 'Palette de commandes' : 'Command palette', exact: true });
    await expect(palette.locator('input')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
    await expect(page.getByRole('heading', { name: locale === 'fr' ? 'Authentification du serveur' : 'Server authentication', exact: true })).toBeVisible();
    if (locale === 'fr') await expect(page.getByRole('heading', { name: 'Server authentication', exact: true })).toHaveCount(0);
    await expect(boundary(page)).toHaveCount(0);
  });

  test(`failed actual Settings copy (${locale}) is visible, closable and does not mount business controls on reopen`, async ({ page }) => {
    await page.route(asset, route => route.abort('failed'));
    await product(page, locale);
    await page.goto('/settings');
    await expect(boundary(page).getByRole('alert')).toHaveText(locale === 'fr'
      ? 'Les traductions des réglages n’ont pas pu être chargées. Rechargez la page pour réessayer.'
      : 'Settings translations could not load. Reload the page to try again.');
    await boundary(page).getByRole('link', { name: locale === 'fr' ? 'Fermer' : 'Close', exact: true }).click();
    await expect(composer(page)).toBeVisible();
    await open(page);
    await expect(boundary(page).getByRole('alert')).toBeVisible();
    await expect(page.locator('#provider-lifecycle')).toHaveCount(0);
    expect((await new AxeBuilder({ page }).include('.settings-locale-boundary').analyze()).violations).toEqual([]);
    await page.unroute(asset);
    const retry = boundary(page).getByRole('button', { name: locale === 'fr' ? 'Recharger et réessayer' : 'Reload and retry', exact: true });
    await retry.focus(); await expect(retry).toBeFocused();
    await retry.press('Enter');
    await selectGeneralSettings(page, 'authentication');
    await expect(page.getByRole('heading', { name: locale === 'fr' ? 'Authentification du serveur' : 'Server authentication', exact: true })).toBeVisible();
    await expect(boundary(page)).toHaveCount(0);
  });
}

for (const navigation of ['close', 'session', 'workspace'] as const) {
  test(`late locale resolution after ${navigation} cannot mount/navigate/focus stale Settings; actual run Stop stays available in chat`, async ({ page }) => {
    let held: Route | undefined;
    await page.route(asset, route => { held = route; });
    await product(page);
    await page.goto(chat);
    await composer(page).fill('Continue running while Settings copy loads');
    await composer(page).press('Enter');
    await expect(page.locator('.stop-button')).toBeEnabled();
    await open(page);
    await expect(boundary(page).getByRole('status')).toBeVisible();
    await expect.poll(() => Boolean(held)).toBe(true);
    if (navigation === 'close') await boundary(page).getByRole('link', { name: 'Close', exact: true }).click();
    else if (navigation === 'session') {
      await page.getByText('Locale second', { exact: true }).click();
      await expect(page).toHaveURL(/\/chat\/locale-second/);
    } else {
      // Actual workspace selection in the existing sidebar, not a test renderer.
      await page.locator('.workspace-button').click();
      const picker = page.locator('.directory-picker');
      await picker.getByRole('button', { name: 'project', exact: true }).click();
      await expect(picker.getByRole('button', { name: 'marker', exact: true })).toBeVisible();
      await picker.getByRole('button', { name: 'Use this workspace', exact: true }).click();
      await expect(page).toHaveURL(/cwd=%2Fworkspace%2Fproject/);
      await page.getByRole('button', { name: 'New chat', exact: true }).click();
    }
    await expect(boundary(page)).toHaveCount(0);
    await expect(composer(page)).toBeVisible();
    await composer(page).focus();
    const currentUrl = page.url();
    const loaded = page.waitForResponse(response => asset.test(response.url()));
    await held!.continue(); await loaded; await settle(page);
    await expect(page).toHaveURL(currentUrl);
    await expect(page.locator('.settings-view')).toHaveCount(0);
    await expect(composer(page)).toBeFocused();
    if (navigation === 'close') {
      await expect(page.locator('.stop-button')).toBeEnabled();
      await page.locator('.stop-button').click();
    }
  });
}
