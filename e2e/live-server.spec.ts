import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { start, stop } from '../packages/server/dist/index.js';
import { expect, test, type Page } from './fixtures/test-budget';

async function trustActiveWorkspace(page: Page): Promise<void> {
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

    await page.getByRole('complementary', { name: 'Main navigation' }).getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByPlaceholder(/Type your message/).fill('real server persistence check');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.locator('.message.user').last()).toContainText('real server persistence check');
    await expect(page.locator('.message.assistant').last()).toContainText('[Mock AI Response]', { timeout: 15_000 });
    await expect(page).toHaveURL(/\/chat\/(?!draft%3A)[^?]+\?cwd=/);

    await page.reload();

    await expect(page.locator('.message.user').last()).toContainText('real server persistence check');
    await expect(page.locator('.message.assistant').last()).toContainText('[Mock AI Response]');
  });

  test('keeps an actually configured credential out of the built browser cache and reload', async ({ page }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-browser-credential-'));
    const cwd = path.join(root, 'work'); await mkdir(cwd);
    const names = ['AI_HARNESS_MASTER_KEY', 'AI_HARNESS_AUTH_TOKEN', 'AI_HARNESS_ADMIN_TOKEN'] as const;
    const previous = names.map(name => process.env[name]);
    process.env.AI_HARNESS_MASTER_KEY = 'disposable-browser-credential-master';
    process.env.AI_HARNESS_AUTH_TOKEN = ''; process.env.AI_HARNESS_ADMIN_TOKEN = '';
    const secret = 'disposable-browser-provider-secret-012345';
    try {
      const server = await start({ port: 0, host: '127.0.0.1', dataDir: path.join(root, 'data'),
        defaultCwd: cwd, allowedRoots: [cwd], webRoot: path.resolve('packages/web/dist'), enableMockProvider: true });
      const base = `http://127.0.0.1:${server.port}`;
      expect((await page.request.post(`${base}/api/config`, { data: { type: 'local', apiKey: secret,
        baseUrl: 'http://127.0.0.1:1/v1', model: 'privacy-model' } })).status()).toBe(200);
      expect((await page.request.post(`${base}/api/workspaces/trust`, { data: { cwd, confirm: true } })).status()).toBe(200);
      const workspace = await page.request.get(`${base}/api/workspaces/default`).then(response => response.json()) as { id: string };
      const created = await page.request.post(`${base}/api/sessions`, { data: { cwd, title: 'Credential cache boundary' } });
      expect(created.status()).toBe(201); const session = await created.json() as { id: string };
      expect((await page.request.post(`${base}/api/sessions/${session.id}/messages`, {
        data: { role: 'assistant', content: `Public cache prefix ${secret} public suffix` },
      })).status()).toBe(201);
      await page.goto(`${base}/chat/${session.id}?cwd=${encodeURIComponent(cwd)}`);
      await expect(page.locator('.message.assistant').last()).toContainText('Public cache prefix [REDACTED] public suffix');
      const cacheKey = `ai-harness-session-view-v2:${workspace.id}`;
      await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), cacheKey)).toContain('Public cache prefix');
      const cached = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
      expect(cached).not.toContain(secret); expect(cached).toContain('[REDACTED]');
      await page.reload();
      await expect(page.locator('.message.assistant').last()).toContainText('Public cache prefix [REDACTED] public suffix');
    } finally {
      await page.goto('about:blank').catch(() => undefined); await stop();
      for (const [index, name] of names.entries()) {
        if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index];
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test('utilise un vrai PTY et refuse une traversée de fichiers', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.workspace-button small')).not.toBeEmpty();
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
    const explorer = page.getByRole('complementary', { name: 'Workspace explorer' });
    await expect(explorer).toBeVisible();
    // The upload bypassed the explorer UI. Refresh its directory explicitly so
    // this case also works on a fresh server, without an earlier case warming it.
    await explorer.getByRole('button', { name: 'Refresh files', exact: true }).click();
    // Exercise the mounted file row, not a window event racing lazy hydration.
    await explorer.getByRole('button', { name: /^aih-live-upload\.txt(?:\s|$)/ }).click();
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
