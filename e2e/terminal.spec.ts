import { expect, test } from '@playwright/test';
import { installMockApi } from './fixtures/mock-api';

test.describe('Terminal PTY du workspace', () => {
  test('crée plusieurs onglets, envoie la saisie et restaure le terminal après rechargement', async ({ page }) => {
    const api = await installMockApi(page);
    await page.goto('/');

    await page.getByRole('button', { name: 'Open workspace terminal' }).click();
    await expect(page.getByRole('region', { name: 'Terminal' })).toBeVisible();
    await expect(page.locator('.terminal-panel header nav > div')).toHaveCount(1);

    const input = page.locator('.terminal-panel .xterm-helper-textarea');
    await input.focus();
    await input.type('echo hello-terminal');
    await input.press('Enter');
    await expect(page.locator('.terminal-panel .xterm-rows')).toContainText('hello-terminal');

    await page.getByRole('button', { name: 'New terminal' }).click();
    await expect(page.locator('.terminal-panel header nav > div')).toHaveCount(2);
    await page.reload();
    await expect(page.getByRole('region', { name: 'Terminal' })).toBeVisible();
    await expect(page.locator('.terminal-panel header nav > div')).toHaveCount(2);

    page.once('dialog', dialog => void dialog.accept());
    await page.getByRole('button', { name: /Close Terminal 2/ }).click();
    await expect(page.locator('.terminal-panel header nav > div')).toHaveCount(1);
    expect(api.requests.some(request => request.path.endsWith('/input'))).toBe(true);
    expect(api.requests.some(request => request.method === 'DELETE' && request.path.startsWith('/api/terminals/'))).toBe(true);
  });

  test('ne monte jamais les onglets PTY d’un autre workspace', async ({ page }) => {
    const api = await installMockApi(page, {
      workspaceBrowse: {
        '/workspace': { cwd: '/workspace', entries: [{ name: 'project', path: '/workspace/project', isDirectory: true, isSymbolicLink: false }] },
        '/workspace/project': { cwd: '/workspace/project', parent: '/workspace', entries: [{ name: 'project-marker', path: '/workspace/project/project-marker', isDirectory: true, isSymbolicLink: false }] },
      },
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Open workspace terminal' }).click();
    await expect(page.getByRole('region', { name: 'Terminal' })).toBeVisible();
    await expect.poll(() => api.requests.filter(
      request => request.method === 'POST' && request.path === '/api/terminals',
    ).length).toBe(1);

    const switchWorkspace = async (cwd: string) => {
      await page.locator('.workspace-button').click();
      const picker = page.locator('.directory-picker');
      if (cwd.endsWith('/project')) {
        await expect(picker.getByRole('button', { name: '📁 project' })).toBeVisible();
        await picker.getByRole('button', { name: '📁 project' }).click();
        await expect(picker.getByRole('button', { name: '📁 project-marker' })).toBeVisible();
      } else {
        await expect(picker.getByRole('button', { name: '📁 project-marker' })).toBeVisible();
        await picker.getByRole('button', { name: 'Parent directory' }).click();
        await expect(picker.getByRole('button', { name: '📁 project' })).toBeVisible();
      }
      await expect(picker.getByLabel('Workspace path')).toHaveValue(cwd);
      await picker.getByRole('button', { name: 'Use this workspace' }).click();
    };
    await switchWorkspace('/workspace/project');
    await expect(page.getByRole('region', { name: 'Terminal' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open workspace terminal' })).toBeVisible();
    expect(api.requests.filter(request => request.method === 'POST' && request.path === '/api/terminals')).toHaveLength(1);

    await page.getByRole('button', { name: 'Open workspace terminal' }).click();
    await expect(page.getByRole('region', { name: 'Terminal' })).toBeVisible();
    await expect.poll(() => api.requests.filter(request => request.method === 'POST' && request.path === '/api/terminals').length).toBe(2);
    expect(api.requests.filter(request => request.method === 'POST' && request.path === '/api/terminals').at(-1)?.body)
      .toMatchObject({ cwd: '/workspace/project' });

    await switchWorkspace('/workspace');
    await expect(page.getByRole('region', { name: 'Terminal' })).toBeVisible();
    await expect(page.locator('.terminal-panel header nav > div')).toHaveCount(1);
  });
});
