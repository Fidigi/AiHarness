import { expect, test } from '@playwright/test';

async function trustActiveWorkspace(page: import('@playwright/test').Page): Promise<void> {
  const trustWarning = page.getByRole('button', { name: /Project not trusted/i });
  if (await trustWarning.isVisible()) {
    await trustWarning.click();
    const dialog = page.getByRole('alertdialog', { name: 'Trust this project?' });
    await dialog.getByRole('button', { name: 'Trust project' }).click();
    await expect(dialog).toHaveCount(0);
  }
}

test.describe('Intégration navigateur avec le vrai serveur', () => {
  test('exécute le provider mock, persiste la session et la restaure après rechargement', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('.workspace-button small')).not.toBeEmpty();
    await trustActiveWorkspace(page);

    await page.getByRole('button', { name: 'New chat' }).click();
    await page.getByPlaceholder(/Type your message/).fill('real server persistence check');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.locator('.message.user').last()).toContainText('real server persistence check');
    await expect(page.locator('.message.assistant').last()).toContainText('[Mock AI Response]', { timeout: 15_000 });
    await expect(page).toHaveURL(/\/chat\/(?!draft%3A)[^?]+\?cwd=/);

    await page.reload();

    await expect(page.locator('.message.user').last()).toContainText('real server persistence check');
    await expect(page.locator('.message.assistant').last()).toContainText('[Mock AI Response]');
  });

  test('utilise un vrai PTY et refuse une traversée de fichiers', async ({ page }) => {
    await page.goto('/');
    await trustActiveWorkspace(page);
    const workspace = await page.request.get('/api/workspaces/default').then(response => response.json()) as { cwd: string };
    const traversal = await page.request.get(`/api/files?cwd=${encodeURIComponent(workspace.cwd)}&path=${encodeURIComponent('../../etc')}`);
    expect([400, 403]).toContain(traversal.status());

    const uploaded = await page.request.post('/api/files/upload', {
      data: {
        cwd: workspace.cwd,
        path: '.',
        collision: 'overwrite',
        files: [{ name: 'aih-live-upload.txt', content: Buffer.from('LIVE_FILE_OK\n').toString('base64') }],
      },
    });
    expect(uploaded.status()).toBe(201);
    await page.evaluate(() => window.dispatchEvent(new Event('aih-show-files')));
    await expect(page.getByRole('complementary', { name: 'Workspace explorer' })).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('aih-open-file', {
      detail: { path: 'aih-live-upload.txt', tab: 'source' },
    })));
    await expect(page.locator('.file-viewer')).toContainText('LIVE_FILE_OK');

    await page.getByRole('button', { name: 'Open workspace terminal' }).click();
    const terminal = page.getByRole('region', { name: 'Terminal' });
    await expect(terminal).toBeVisible();
    const input = terminal.locator('.xterm-helper-textarea');
    await input.focus();
    await input.type("printf 'LIVE_PTY_OK\\n'; rm -f -- aih-live-upload.txt", { delay: 5 });
    await input.press('Enter');
    await expect(terminal.locator('.xterm-rows')).toContainText('LIVE_PTY_OK', { timeout: 10_000 });

    page.once('dialog', dialog => void dialog.accept());
    await terminal.getByRole('button', { name: /Close Terminal/ }).click();
    await expect(terminal.locator('.terminal-status.running')).toHaveCount(0);
  });
});
