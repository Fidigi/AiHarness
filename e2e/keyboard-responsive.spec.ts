import { expect, test } from './fixtures/test-budget';
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

    const explorer = page.getByRole('region', { name: 'Workspace explorer' });
    await expect(explorer).toBeVisible();
    await page.keyboard.press('Control+Shift+F');
    await expect(explorer).toHaveCount(0);
    await page.keyboard.press('Control+Shift+F');
    await expect(explorer).toBeVisible();

    await page.keyboard.press('Control+L');
    const composer = page.getByPlaceholder(/Type your message/);
    await expect(composer).toBeFocused();
    await composer.evaluate(element => {
      const transfer = new DataTransfer();
      // Clipboard plaintext is authoritative; HTML supplies only inert link metadata.
      transfer.setData('text/plain', '## Safe title\n\n**Bold**');
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
    const api = await installMockApi(page, { sessions: [mockSession('responsive', 'Responsive session')] });
    await page.goto('/chat/responsive');
    await expect(page.getByPlaceholder(/Type your message/)).toBeVisible();
    const terminal = page.getByRole('button', { name: 'Open workspace terminal', exact: true });
    await expect(terminal).toBeInViewport({ ratio: 1 });
    const target = await terminal.boundingBox();
    expect(target!.width).toBeGreaterThanOrEqual(44); expect(target!.height).toBeGreaterThanOrEqual(44);
    await expect.poll(() => page.evaluate(() => {
      const launcher = document.querySelector<HTMLElement>('.terminal-launcher')!;
      const box = launcher.getBoundingClientRect();
      return [...document.querySelectorAll<HTMLElement>('.input-container input:not([type="file"]), .input-container textarea, .input-container select, .input-container button')]
        .filter(control => {
          if (control === launcher) return false;
          const other = control.getBoundingClientRect();
          return other.width > 0 && other.height > 0 && Math.min(box.right, other.right) > Math.max(box.left, other.left)
            && Math.min(box.bottom, other.bottom) > Math.max(box.top, other.top);
        }).map(control => control.getAttribute('aria-label') || control.getAttribute('placeholder') || control.textContent?.trim() || control.tagName);
    })).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);

    const explorer = page.getByRole('region', { name: 'Workspace explorer' });
    if (viewport.width <= 959) {
      await page.getByRole('button', { name: 'Workspace explorer' }).click();
      await expect(explorer).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      await explorer.getByRole('button', { name: 'File options', exact: true }).click();
      await explorer.getByRole('button', { name: 'Close' }).click();
    } else {
      await expect(explorer).toBeVisible();
      await expect(page.locator('.sidebar')).toBeVisible();
    }
    const composer = page.getByPlaceholder(/Type your message/);
    await composer.fill('Keep this draft');
    await composer.press('Tab');
    await expect(terminal).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Terminal', exact: true })).toBeVisible();
    await expect(composer).toHaveValue('Keep this draft');
    expect(api.requests.filter(request => request.method === 'POST' && request.path === '/api/agent/runs')).toHaveLength(0);
  });
}
