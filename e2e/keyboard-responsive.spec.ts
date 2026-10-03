import { expect, test } from '@playwright/test';
import { installMockApi, mockSession } from './fixtures/mock-api';

test.describe('Palette globale et raccourcis', () => {
  test('ouvre la palette au clavier et pilote les panneaux sans intercepter le texte', async ({ page }) => {
    await installMockApi(page, { sessions: [mockSession('keyboard', 'Keyboard session')] });
    await page.goto('/chat/keyboard');
    await expect(page.getByPlaceholder(/Type your message/)).toBeVisible();

    await page.keyboard.press('Control+K');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await expect(palette.getByRole('option')).not.toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);

    await expect(page.getByRole('complementary', { name: 'Workspace explorer' })).toBeVisible();
    await page.keyboard.press('Control+Shift+F');
    await expect(page.getByRole('complementary', { name: 'Workspace explorer' })).toHaveCount(0);
    await page.keyboard.press('Control+Shift+F');
    await expect(page.getByRole('complementary', { name: 'Workspace explorer' })).toBeVisible();

    await page.keyboard.press('Control+L');
    const composer = page.getByPlaceholder(/Type your message/);
    await expect(composer).toBeFocused();
    await composer.evaluate(element => {
      const transfer = new DataTransfer();
      transfer.setData('text/html', '<h2>Safe title</h2><p><strong>Bold</strong> <script>bad()</script></p>');
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    });
    await expect(composer).toHaveValue('## Safe title\n\n**Bold**');
  });

  test('persiste un raccourci reconfiguré et signale les conflits', async ({ page }) => {
    await installMockApi(page);
    await page.goto('/settings#shortcuts');
    const field = page.getByLabel('Shortcut for Open command palette');
    await field.focus();
    await page.keyboard.press('Control+Shift+P');
    await expect(field).toHaveValue('Ctrl+Shift+P');
    await page.reload();
    await expect(page.getByLabel('Shortcut for Open command palette')).toHaveValue('Ctrl+Shift+P');
    await page.keyboard.press('Control+Shift+P');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  });
});

for (const viewport of [
  { name: 'mobile', width: 360, height: 740 },
  { name: 'tablet', width: 768, height: 900 },
  { name: 'desktop', width: 1024, height: 768 },
]) {
  test(`layout ${viewport.name} sans débordement`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await installMockApi(page, { sessions: [mockSession('responsive', 'Responsive session')] });
    await page.goto('/chat/responsive');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);

    if (viewport.width <= 959) {
      await page.getByRole('button', { name: 'Workspace explorer' }).click();
      await expect(page.getByRole('complementary', { name: 'Workspace explorer' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      await page.getByRole('complementary', { name: 'Workspace explorer' }).getByRole('button', { name: 'Close' }).click();
    } else {
      await expect(page.getByRole('complementary', { name: 'Workspace explorer' })).toBeVisible();
      await expect(page.locator('.sidebar')).toBeVisible();
    }
  });
}
