import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// The normal application suite has its own servers; these cases require the isolated static host.
test.skip(process.env.DEMO_E2E !== '1', 'Run with demo/playwright.config.ts (static host only).');

async function ready(page: Page) {
  await page.goto('./');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Review the garden board');
  await expect(page.getByText('Offline ready · reload supported', { exact: true })).toBeVisible();
}
async function tab(page: Page, name: string) {
  const link = page.getByRole('navigation', { name: 'Workspace views' }).getByRole('link', { name, exact: true });
  await link.click();
  await expect(link).toHaveAttribute('aria-current', 'page');
}
async function accessible(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(result.violations).toEqual([]);
}

test('nested-base smoke: static assets only, models/tools/sessions, file preview, Git edit and terminal refusal', async ({ page, request, baseURL }) => {
  const failures: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('request', event => requests.push(event.url()));
  await ready(page);
  await tab(page, 'Models');
  await expect(page.getByRole('heading', { name: 'Demo models' })).toBeVisible();
  await page.locator('.card').filter({ hasText: 'Documentation helper' }).getByRole('button').click();
  await expect(page.getByLabel('Session model')).toHaveValue('mock/writer');
  await page.getByRole('button', { name: 'Review workspace', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Fixture replay complete.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Documentation walkthrough' })).toBeVisible();
  await tab(page, 'Tools');
  await page.getByRole('checkbox', { name: /^read / }).uncheck();
  await tab(page, 'Chat');
  await page.getByLabel('Session model').selectOption('mock/reviewer');
  await page.getByRole('button', { name: 'Review workspace', exact: true }).click();
  await expect(page.getByText('The read tool is disabled; no file result was added.')).toBeVisible();
  await page.getByRole('button', { name: 'Preview welcome edit' }).click();
  await tab(page, 'Git (1)');
  await expect(page.getByRole('region', { name: 'Synthetic Git diff' })).toContainText('+Welcome to your community garden!');
  await tab(page, 'Files');
  await page.getByRole('button', { name: 'README.md · modified' }).click();
  await expect(page.getByRole('region', { name: 'File preview' })).toContainText('Welcome to your community garden!');
  await page.getByRole('button', { name: 'assets/garden.svg' }).click();
  await expect(page.getByAltText('Synthetic garden sprout')).toBeVisible();
  expect(await page.getByAltText('Synthetic garden sprout').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(240);
  await tab(page, 'Terminal');
  for (const command of ['git status', 'npm test', 'cat /etc/passwd', 'touch demo-pwned; env']) {
    await page.getByLabel('Synthetic command', { exact: true }).fill(command);
    await page.getByRole('button', { name: 'Replay command' }).click();
  }
  await expect(page.getByLabel('Terminal output')).toContainText('modified: README.md');
  await expect(page.getByLabel('Terminal output')).toContainText('1 synthetic test passed');
  await expect(page.getByLabel('Terminal output')).toContainText('Not executed.');
  await tab(page, 'Git (1)');
  await page.getByRole('button', { name: 'Revert preview' }).click();
  await expect(page.getByRole('region', { name: 'Synthetic Git diff' })).toContainText('Working tree clean');
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page.getByRole('heading', { name: 'Start exploring' })).toBeVisible();
  await page.getByLabel('Try a demo prompt').fill('<script>window.demoInjected=true</script>');
  await page.getByRole('button', { name: 'Replay fixture', exact: true }).click();
  await expect(page.locator('.user-text').last()).toHaveText('<script>window.demoInjected=true</script>');
  expect(await page.evaluate(() => 'demoInjected' in window)).toBe(false);
  expect(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }))).toEqual({ local: [], session: [] });
  const base = new URL(baseURL!).pathname;
  const origin = new URL(baseURL!).origin;
  expect(requests.every(url => url.startsWith(origin + base))).toBe(true);
  expect(requests.some(url => /\/api\//.test(url))).toBe(false);
  for (const route of ['/api/models', '/api/files/content?path=/etc/passwd', '/assets/not-found.js', base + 'chat/workspace-review']) {
    expect((await request.get(origin + route)).status()).toBe(404);
  }
  expect((await request.post(baseURL!, { data: 'not-a-backend' })).status()).toBe(405);
  expect(failures).toEqual([]);
});

test('offline reload preserves public shell, lazy Markdown and all exploratory views without a backend', async ({ page, context }) => {
  await ready(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'A small, accessible start' })).toBeVisible();
  await expect(page.getByText('Offline ready · reload supported', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Preview welcome edit' }).click();
  await tab(page, 'Git (1)');
  await expect(page.getByRole('region', { name: 'Synthetic Git diff' })).toContainText('+Welcome');
  await tab(page, 'Files');
  await page.getByRole('button', { name: 'README.md · modified' }).click();
  await expect(page.getByRole('region', { name: 'File preview' }).getByRole('heading', { name: 'Garden board' })).toBeVisible();
  await page.getByRole('button', { name: 'assets/garden.svg' }).click();
  await expect(page.getByAltText('Synthetic garden sprout')).toBeVisible();
  expect(await page.getByAltText('Synthetic garden sprout').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(240);
  await tab(page, 'Models');
  await expect(page.getByRole('heading', { name: 'Workspace reviewer', exact: true })).toBeVisible();
  await tab(page, 'Tools');
  await expect(page.getByRole('checkbox')).toHaveCount(3);
  await tab(page, 'Terminal');
  await page.getByLabel('Synthetic command', { exact: true }).fill('npm test');
  await page.getByRole('button', { name: 'Replay command' }).click();
  await expect(page.getByLabel('Terminal output')).toContainText('1 synthetic test passed');
  await tab(page, 'Chat');
  await page.getByRole('button', { name: 'Review workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Workspace walkthrough' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Workspace walkthrough' })).toHaveCount(0);
  await tab(page, 'Git');
  await expect(page.getByRole('region', { name: 'Synthetic Git diff' })).toContainText('Working tree clean');
});

test('stop, reset modal keyboard/focus and deep-link restoration are local and safe', async ({ page }) => {
  await ready(page);
  await page.getByLabel('Try a demo prompt').fill('Discard me');
  await page.getByLabel('Try a demo prompt').press('Control+Enter');
  await page.getByRole('button', { name: 'Stop replay' }).click();
  await expect(page.getByLabel('Try a demo prompt')).toHaveValue('Discard me');
  await expect(page.locator('.message.user').filter({ hasText: 'Discard me' })).toHaveCount(0);
  await page.waitForTimeout(700); // beyond the replay timer: Stop must actually cancel it.
  await expect(page.locator('.message.user').filter({ hasText: 'Discard me' })).toHaveCount(0);
  const reset = page.getByRole('button', { name: 'Reset demo', exact: true });
  await reset.click();
  const dialog = page.getByRole('dialog', { name: 'Reset this demo?' });
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Reset temporary state' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(reset).toBeFocused();
  await reset.click();
  await dialog.getByRole('button', { name: 'Reset temporary state' }).click();
  await expect(page.getByLabel('Try a demo prompt')).toHaveValue('');
  await page.getByRole('navigation', { name: 'Sessions', exact: true }).getByRole('link', { name: /Improve the welcome copy/ }).click();
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Improve the welcome copy');
});

test('pending replay targets its original session, retains newer drafts and reset cancels all effects', async ({ page }) => {
  await ready(page);
  await page.getByLabel('Try a demo prompt').fill('Original session replay');
  await page.getByRole('button', { name: 'Replay fixture', exact: true }).click();
  await page.getByRole('navigation', { name: 'Sessions', exact: true }).getByRole('link', { name: /Improve the welcome copy/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Improve the welcome copy');
  await page.getByLabel('Try a demo prompt').fill('New session draft');
  await expect(page.getByRole('status').filter({ hasText: 'Fixture replay complete.' })).toBeVisible();
  await expect(page.getByLabel('Try a demo prompt')).toHaveValue('New session draft');
  await expect(page.locator('.message.user').filter({ hasText: 'Original session replay' })).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Sessions', exact: true }).getByRole('link', { name: /Review the garden board/ }).click();
  await expect(page.locator('.message.user').filter({ hasText: 'Original session replay' })).toHaveCount(1);
  await tab(page, 'Tools');
  await page.getByRole('checkbox', { name: /^edit / }).uncheck();
  await tab(page, 'Chat');
  await page.getByRole('button', { name: 'Preview welcome edit' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Enable the synthetic edit tool' })).toBeVisible();
  await tab(page, 'Git');
  await expect(page.getByRole('region', { name: 'Synthetic Git diff' })).toContainText('Working tree clean');
  await tab(page, 'Chat');
  await page.getByLabel('Try a demo prompt').fill('Reset pending replay');
  await page.getByRole('button', { name: 'Replay fixture', exact: true }).click();
  await page.getByRole('button', { name: 'Reset demo', exact: true }).click();
  await page.getByRole('button', { name: 'Reset temporary state' }).click();
  await page.waitForTimeout(700);
  await expect(page.locator('.message.user').filter({ hasText: /Original session replay|Reset pending replay/ })).toHaveCount(0);
  await expect(page.getByLabel('Try a demo prompt')).toHaveValue('');
  await expect(page.getByLabel('Session model')).toHaveValue('mock/reviewer');
  await tab(page, 'Tools');
  for (const box of await page.getByRole('checkbox').all()) await expect(box).toBeChecked();
  await tab(page, 'Terminal');
  await expect(page.getByLabel('Terminal output')).toHaveText('Synthetic terminal · no host shell. Type help for commands.');
});

for (const scenario of [
  { name: 'desktop-light', width: 1440, height: 1000, dark: false },
  { name: 'desktop-dark', width: 1440, height: 1000, dark: true },
  { name: 'mobile-light', width: 390, height: 844, dark: false },
  { name: 'mobile-dark', width: 390, height: 844, dark: true },
] as const) {
  test(`${scenario.name} responsive Chat/Files/Git/Terminal/Models/Tools visual, axe and overflow matrix`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await ready(page);
    if (scenario.dark) await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect(page.getByRole('heading', { name: 'A small, accessible start' })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    for (const name of ['Chat', 'Files', 'Git', 'Terminal', 'Models', 'Tools']) {
      await tab(page, name);
      if (name === 'Git') {
        await page.getByRole('button', { name: 'Preview welcome edit' }).click();
        await expect(page.getByRole('region', { name: 'Synthetic Git diff' })).toContainText('+Welcome');
      }
      await accessible(page, scenario.width);
      await expect(page).toHaveScreenshot(`demo-${name.toLowerCase()}-${scenario.name}.png`, { fullPage: true, animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02 });
      await page.screenshot({ path: testInfo.outputPath(`demo-${name.toLowerCase()}-${scenario.name}.png`), fullPage: true, animations: 'disabled', caret: 'hide' });
    }
    await page.getByRole('button', { name: 'Reset demo', exact: true }).click();
    await accessible(page, scenario.width);
    await expect(page.getByRole('dialog')).toHaveScreenshot(`demo-reset-${scenario.name}.png`, { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02 });
    await page.getByRole('dialog').screenshot({ path: testInfo.outputPath(`demo-reset-${scenario.name}.png`), animations: 'disabled', caret: 'hide' });
  });
}
