import { expect, test } from './desktop';
import { installMockApi, mockSession } from '../../e2e/fixtures/mock-api';

test('environment: native 200% zoom and real Orca synthesis', async ({ desktop }) => {
  const { page } = desktop;
  await page.route('**/at-control', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html lang="en"><title>Desktop AT control</title><h1>Desktop AT control</h1><button>Synthetic accessibility check</button><label>Disposable draft<input></label></html>' }));
  await page.goto('/at-control');
  await desktop.clickContent(page.getByRole('button', { name: 'Synthetic accessibility check' }));
  let mark = desktop.mark();
  await desktop.key('Tab');
  await expect(page.getByLabel('Disposable draft')).toBeFocused();
  await desktop.spoken(mark, 'Disposable draft entry');
  mark = desktop.mark();
  await desktop.key('shift+Tab');
  await desktop.spoken(mark, 'Synthetic accessibility check push button');
  await desktop.zoom200();
});

test('Settings: native-zoom category/context navigation, Keep/Discard and focus return', async ({ desktop }) => {
  const { page } = desktop;
  const api = await installMockApi(page, {
    sessions: [mockSession('desktop-at', 'Desktop accessibility session')],
    configurationScopes: { global: {}, project: { model: 'saved-model' } },
  });
  await page.addInitScript(() => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({
    version: 4, theme: 'light', lastSettingsSection: 'appearance',
  })));
  await page.goto('/chat/desktop-at');
  const composer = page.getByPlaceholder(/Type your message/);
  await desktop.clickContent(composer);
  const invoker = await composer.elementHandle();
  await desktop.key('ctrl+comma');
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  const close = dialog.getByRole('button', { name: 'Close', exact: true });
  // Calibrate the native content owner after lazy entry. Orca's documented
  // Where Am I command reports the focused control, not the dialog title.
  await expect(page.getByRole('combobox', { name: 'Theme', exact: true })).toBeVisible();
  await desktop.clickContent(dialog.getByRole('heading', { name: 'Settings', exact: true }));
  await desktop.key('Tab');
  await expect(close).toBeFocused();
  await desktop.queryButton('Close');
  await desktop.zoom200();
  let mark = desktop.mark();
  await desktop.key('Tab');
  const categories = page.getByRole('combobox', { name: 'Settings categories', exact: true });
  await expect(categories).toBeFocused();
  await desktop.spoken(mark, 'Settings categories');
  await desktop.key('Home', 'Down');
  await expect(categories).toHaveValue('models');
  await desktop.key('Tab');
  await expect(page.getByRole('button', { name: 'Back to Model settings', exact: true })).toBeFocused();
  await desktop.key('Return');
  const models = page.getByRole('navigation', { name: 'Model settings', exact: true });
  await expect(models.getByRole('link', { name: 'AI Provider', exact: true })).toBeFocused();
  for (const name of ['Provider connections and custom providers', 'Model', 'Custom models']) {
    mark = desktop.mark();
    await desktop.key('Tab');
    await expect(models.getByRole('link', { name, exact: true })).toBeFocused();
    await desktop.spoken(mark, name);
  }
  await desktop.key('Return');
  const modelBack = page.getByRole('button', { name: 'Back to Model settings', exact: true });
  await expect(modelBack).toBeFocused();
  await expect(page.locator('#custom-models')).toBeVisible();
  await desktop.capture('models-context-200');

  await desktop.key('shift+Tab');
  await expect(categories).toBeFocused();
  await desktop.key('Home');
  await expect(categories).toHaveValue('general');
  await desktop.key('Tab', 'Return');
  const general = page.getByRole('navigation', { name: 'General settings', exact: true });
  await expect(general.getByRole('link', { name: 'Appearance', exact: true })).toBeFocused();
  mark = desktop.mark();
  await desktop.key('Tab');
  await expect(general.getByRole('link', { name: 'Behavior', exact: true })).toBeFocused();
  await desktop.spoken(mark, 'Behavior');
  await desktop.key('Return');
  const model = page.locator('#defaults').getByLabel('Model', { exact: true });
  await expect(model).toHaveValue('saved-model');
  // Assisted positioning in the long form; the actual click lets Orca enter
  // focus mode instead of interpreting typing as browse-mode navigation.
  await model.scrollIntoViewIfNeeded();
  await desktop.clickContent(model);
  await expect(model).toBeFocused();
  await desktop.key('ctrl+a');
  await desktop.type('DESKTOP_AT_UNSAVED_MODEL');
  await expect(model).toHaveValue('DESKTOP_AT_UNSAVED_MODEL');
  mark = desktop.mark();
  await desktop.key('Escape');
  const prompt = page.getByRole('alertdialog', { name: 'Discard unsaved Settings edits?', exact: true });
  const keep = prompt.getByRole('button', { name: 'Keep editing', exact: true });
  const discard = prompt.getByRole('button', { name: 'Discard edits', exact: true });
  await expect(keep).toBeFocused();
  await desktop.spoken(mark, 'Discard unsaved Settings edits?');
  await desktop.queryButton('Keep editing');
  await desktop.key('Tab');
  await expect(discard).toBeFocused();
  for (const button of [keep, discard]) {
    expect(await button.evaluate(element => {
      const r = element.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
    })).toBe(true);
  }
  await desktop.capture('discard-confirmation-200');
  await desktop.key('shift+Tab', 'Return');
  await expect(prompt).toHaveCount(0);
  await expect(model).toBeFocused();
  await expect(model).toHaveValue('DESKTOP_AT_UNSAVED_MODEL');
  await desktop.key('Escape');
  await expect(keep).toBeFocused();
  await desktop.key('Tab');
  await expect(discard).toBeFocused();
  await desktop.queryButton('Discard edits');
  await desktop.key('Return');
  await expect(dialog).toHaveCount(0);
  // Route navigation unmounts the old composer; its replacement is not the
  // invoker. App's existing focus contract returns to the retained main region.
  expect(await invoker!.evaluate(element => element.isConnected)).toBe(false);
  // Keep the focus failure as a failed case while still checking the independent
  // no-write/storage/readback assertions below. Never turn it into a skip/pass.
  await expect.soft(page.locator('main.main-content')).toBeFocused();
  await desktop.info.attach('post-discard-focus', { contentType: 'application/json', body: JSON.stringify(await page.evaluate(() => ({
    tag: document.activeElement?.tagName, role: document.activeElement?.getAttribute('role'),
    mainFocused: document.activeElement === document.querySelector('main.main-content'),
    pathname: location.pathname,
  }))) });
  expect(api.requests.filter(request => request.method !== 'GET'
    && !['/api/workspaces/validate', '/api/mcp/oauth/status'].includes(request.path))).toEqual([]);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('DESKTOP_AT_UNSAVED_MODEL');
  await desktop.key('ctrl+comma');
  await expect(model).toHaveValue('saved-model');
});
