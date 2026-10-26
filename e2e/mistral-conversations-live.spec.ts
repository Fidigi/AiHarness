import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { start, stop } from '../packages/server/dist/index.js';
import { expect, test } from './fixtures/test-budget';

test('native Mistral custom dialect is configured in Settings and reaches actual HTTP streaming after reload', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-mistral-web-'));
  const cwd = path.join(root, 'work'), dataDir = path.join(root, 'data'), model = 'magistral-medium-latest';
  const names = ['AI_HARNESS_AUTH_TOKEN', 'AI_HARNESS_ADMIN_TOKEN', 'AI_HARNESS_AGENT_DIR', 'AI_HARNESS_MASTER_KEY'] as const;
  const previous = names.map(name => process.env[name]);
  process.env.AI_HARNESS_AUTH_TOKEN = 'mistral-user'; process.env.AI_HARNESS_ADMIN_TOKEN = 'mistral-admin';
  process.env.AI_HARNESS_AGENT_DIR = path.join(root, 'agent'); process.env.AI_HARNESS_MASTER_KEY = 'disposable-mistral-web-master';
  const calls: Array<{ url?: string; authorization?: string; body: Record<string, unknown> }> = [];
  const wire = createServer(async (request, response) => {
    if (request.method === 'GET') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: model }] })); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    calls.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.setHeader('content-type', 'text/event-stream');
    response.end([
      { model, choices: [{ delta: { content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'Mistral native reasoning.' }] }, { type: 'text', text: 'Mistral native wire received.' }] } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, num_cached_tokens: 1 } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
  });
  await mkdir(cwd); await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  try {
    const upstream = `http://127.0.0.1:${(wire.address() as { port: number }).port}`;
    const server = await start({ port: 0, host: '127.0.0.1', dataDir, defaultCwd: cwd, allowedRoots: [cwd],
      webRoot: path.resolve('packages/web/dist'), enableMockProvider: true });
    const base = `http://127.0.0.1:${server.port}`;
    expect((await page.request.post(`${base}/api/auth/login`, { data: { token: 'mistral-admin' } })).status()).toBe(200);
    expect((await page.request.post(`${base}/api/workspaces/trust`, { data: { cwd, confirm: true } })).status()).toBe(200);
    await page.addInitScript(() => localStorage.setItem('ai-harness-locale', 'en'));
    await page.goto(`${base}/settings?cwd=${encodeURIComponent(cwd)}`);
    const section = page.locator('#provider-lifecycle');
    if (await section.locator('details.custom-resource-editor').getAttribute('open') === null)
      await section.getByText('Create or edit a compatible provider', { exact: true }).click();
    const form = section.locator('form');
    await form.getByLabel('ID', { exact: true }).fill('mistral');
    await form.getByLabel('Name', { exact: true }).fill('Native Mistral');
    await form.getByLabel('Base URL', { exact: true }).fill(upstream);
    await form.getByRole('combobox', { name: 'API dialect', exact: true }).selectOption('mistral-conversations');
    await form.getByLabel('API key', { exact: true }).fill('disposable-mistral-web-key');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(section.locator('[data-settings-selection="mistral"]')).toContainText('mistral-conversations');
    expect(calls).toEqual([]);
    await page.reload();
    const card = section.locator('[data-settings-selection="mistral"]');
    await expect(card).toContainText('mistral-conversations');
    if (await section.locator('details.custom-resource-editor').getAttribute('open') === null)
      await section.getByText('Create or edit a compatible provider', { exact: true }).click();
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(form.getByRole('combobox', { name: 'API dialect', exact: true })).toHaveValue('mistral-conversations');
    await expect(form.getByLabel('API key', { exact: true })).toHaveValue('');
    expect((await page.request.patch(`${base}/api/configuration/scope`, { data: { scope: 'global',
      values: { provider: 'mistral', model, thinking: 'high', toolPreset: 'chat-only' } } })).status()).toBe(200);
    await page.reload();
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message composer' }).fill('Exercise native Mistral');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toContainText('Mistral native wire received.');
    expect(calls).toEqual([expect.objectContaining({ url: '/v1/chat/completions', authorization: 'Bearer disposable-mistral-web-key',
      body: expect.objectContaining({ model, stream: true, reasoning_effort: 'high' }) })]);
    await page.reload(); await expect(page.locator('.message.assistant')).toHaveCount(1);
    await expect(page.locator('.message.assistant')).toContainText('Mistral native wire received.'); expect(calls).toHaveLength(1);
    for (const file of ['providers.json', 'provider-secrets.enc']) expect(await readFile(path.join(dataDir, file), 'utf8')).not.toContain('disposable-mistral-web-key');
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('disposable-mistral-web-key');
  } finally {
    await page.goto('about:blank').catch(() => undefined); await stop();
    wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve()));
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    await rm(root, { recursive: true, force: true });
  }
});
