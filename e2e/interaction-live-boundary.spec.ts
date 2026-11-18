import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './fixtures/test-budget';

test('real extension runtime validates declarative responses and resumes or cancels through the lazy form', async ({ page }) => {
  await page.goto('/');
  const workspace = await page.request.get('/api/workspaces/default').then(response => response.json()) as { cwd: string; id: string };
  const extension = path.join(workspace.cwd, '.ai-harness/extensions/dialog-clean-final.mjs');
  await mkdir(path.dirname(extension), { recursive: true });
  await writeFile(extension, `export default api => {
  let release;
  api.registerUI({ name: 'dialog-proof-ready', render: () => release ? 'LIVE_HOOK_READY' : '' });
  api.before('before:provider', data => data.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Local offline interaction proof'))
    ? new Promise(resolve => { release = resolve; }) : undefined);
  api.registerCommand('dialog-proof', { description: 'Local declarative proof', handler: async (_input, context) => {
    const answer = await context.requestInteraction({kind:'custom',title:'Live declarative approval',message:'<script>unsafe()</script>', fields:[
      {name:'mode',label:'Mode',type:'select',required:true,options:[{value:'safe',label:'Safe'}]},
      {name:'notes',label:'Notes',type:'textarea'}, {name:'remember',label:'Remember',type:'checkbox'}]});
    const done = release; release = undefined; done?.();
    return answer.cancelled?'LIVE_DIALOG_CANCELLED':'LIVE_DIALOG_ACCEPTED:'+JSON.stringify(answer.value);
  } });
};`);
  try {
    await page.goto('/');
    const warning = page.getByRole('button', { name: /Project not trusted/i });
    await expect(page.locator('.workspace-button small')).not.toBeEmpty();
    if (await warning.isVisible()) {
      await warning.click();
      await page.getByRole('alertdialog', { name: 'Trust this project?' }).getByRole('button', { name: 'Trust project' }).click();
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
    }
    const reload = await page.request.post('/api/agent/reload', { data: { cwd: workspace.cwd, projectId: workspace.id } });
    expect(reload.ok()).toBe(true);
    const loaded = await reload.json() as { errors: unknown[]; loadedExtensions: string[] };
    expect(loaded.errors).toEqual([]);
    expect(loaded.loadedExtensions).not.toHaveLength(0);
    for (const cancel of [false, true]) {
      const start = await page.request.post('/api/agent/runs', { data: {
        cwd: workspace.cwd, provider: 'mock', input: 'Local offline interaction proof', toolPreset: 'full',
      } });
      expect(start.ok()).toBe(true);
      const started = await start.json() as { session: { id: string }; run: { id: string } };
      await page.goto(`/chat/${started.session.id}?cwd=${encodeURIComponent(workspace.cwd)}`);
      await expect.poll(async () => page.request.get(`/api/agent/sessions/${started.session.id}/extensions`).then(response => response.json()).then(widgets => widgets.some((widget: { content: string }) => widget.content === 'LIVE_HOOK_READY'))).toBe(true);
      const commandReply = page.request.post(`/api/agent/sessions/${started.session.id}/commands/dialog-proof`, { data: { args: '' } });
      const dialog = page.getByRole('dialog', { name: 'Live declarative approval' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('<script>unsafe()</script>');
      await expect(dialog.locator('script')).toHaveCount(0);
      const state = await page.request.get(`/api/agent/sessions/${started.session.id}/state`).then(response => response.json()) as { run: { extensionRequest: { id: string } } };
      const invalid = await page.request.post(`/api/agent/sessions/${started.session.id}/interactions/${state.run.extensionRequest.id}`, {
        data: { cancelled: false, value: { mode: 'unsafe', notes: '', remember: false } },
      });
      expect(invalid.status()).toBe(400);
      expect(await invalid.json()).toMatchObject({ code: 'INVALID_EXTENSION_INTERACTION_RESPONSE' });
      await expect(dialog).toBeVisible();
      if (cancel) await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      else {
        await dialog.getByLabel('Mode').selectOption('safe');
        await dialog.getByLabel('Notes').fill('Exact live notes');
        await dialog.getByLabel('Remember').check();
        await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
      }
      await expect(dialog).toHaveCount(0);
      const reply = await commandReply;
      expect(reply.ok()).toBe(true);
      const output = await reply.json() as { output: string };
      expect(output.output).toContain(cancel ? 'LIVE_DIALOG_CANCELLED' : 'LIVE_DIALOG_ACCEPTED');
      if (!cancel) expect(output.output).toContain('Exact live notes');
      await expect(page.locator('.message.assistant').last()).toContainText('[Mock AI Response]', { timeout: 15_000 });
    }
  } finally {
    await rm(extension, { force: true });
  }
});
