import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './fixtures/test-budget';

test('native loaded output hooks and bounded custom continuation survive browser reload without executable UI', async ({ page }) => {
  await page.goto('/');
  const workspace = await page.request.get('/api/workspaces/default').then(response => response.json()) as { cwd: string; id: string };
  const extension = path.join(workspace.cwd, '.ai-harness/extensions/execution-live.mjs');
  await mkdir(path.dirname(extension), { recursive: true });
  await writeFile(extension, `export default api => {
    const sessions = new Set();
    api.before('before:provider', data => {
      if (data.messages.some(message => message.role === 'user' && message.content === 'Native extension continuation proof')) sessions.add(data.options.sessionId);
    });
    api.before('before:message', data => sessions.has(data.sessionId)
      ? {content:'NATIVE-EXTENSION-ANSWER <script>window.extensionExecuted=true</script>'} : undefined);
    api.before('before:agent:settle', data => {
      const session = data.context.sessionManager.get(data.sessionId);
      if (data.round === 0 && session.messages.some(message => message.role === 'user' && message.content === 'Native extension continuation proof')) {
        return {continuation:{type:'review:browser',content:'Native extension continuation proof follow-up'}};
      }
    });
  };`);
  try {
    await expect(page.locator('.workspace-button small')).not.toBeEmpty();
    const warning = page.getByRole('button', { name: /Project not trusted/i });
    if (await warning.isVisible()) {
      await warning.click();
      await page.getByRole('alertdialog', { name: 'Trust this project?' }).getByRole('button', { name: 'Trust project' }).click();
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
    }
    const reload = await page.request.post('/api/agent/reload', { data: { cwd: workspace.cwd, projectId: workspace.id } });
    expect(reload.ok()).toBe(true);
    expect((await reload.json()).errors).toEqual([]);
    const start = await page.request.post('/api/agent/runs', { data: {
      cwd: workspace.cwd, provider: 'mock', input: 'Native extension continuation proof', autoCompaction: false,
    } });
    expect(start.status()).toBe(202);
    const { session } = await start.json() as { session: { id: string } };
    await page.goto(`/chat/${session.id}?cwd=${encodeURIComponent(workspace.cwd)}`);
    await expect.poll(async () => page.request.get(`/api/agent/sessions/${session.id}/state`).then(response => response.json()).then(state => state.run.phase)).toBe('completed');
    const state = await page.request.get(`/api/agent/sessions/${session.id}/state`).then(response => response.json());
    expect(state.session.messages.filter((message: { role: string }) => message.role === 'user')).toHaveLength(1);
    expect(state.session.messages.filter((message: { role: string }) => message.role === 'assistant')).toHaveLength(2);
    await expect(page.locator('.message.assistant').last()).toContainText('NATIVE-EXTENSION-ANSWER');
    await page.reload();
    await expect(page.locator('.message.assistant').last()).toContainText('NATIVE-EXTENSION-ANSWER');
    await expect(page.locator('.message.assistant script')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { extensionExecuted?: boolean }).extensionExecuted)).toBeUndefined();
  } finally {
    await rm(extension, { force: true });
  }
});
