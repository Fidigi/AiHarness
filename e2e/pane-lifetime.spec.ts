import { expect, test, type Page } from '@playwright/test';
import { installMockApi, mockSession } from './fixtures/mock-api';

const url = '/chat/pane-lifetime?cwd=%2Fworkspace';
const pane = (page: Page) => page.getByRole('complementary', { name: 'Workspace explorer' });

async function product(page: Page) {
  await page.addInitScript(() => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({
    version: 4, theme: 'light', filesOpen: false, sidebarVisible: true, sound: false,
  })));
  return installMockApi(page, { sessions: [mockSession('pane-lifetime', 'Pane lifetime')],
    workspaceFiles: [{ path: 'src/app.ts', content: 'export const value = 1;', language: 'typescript' }] });
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
