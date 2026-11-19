import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { start, stop } from '../packages/server/dist/index.js';
import { expect, test } from './fixtures/test-budget';
import { closeSettings } from './fixtures/settings-navigation';

test('explicit mixed OpenRouter is saved in Settings, routes native A/C and reloads private persisted history', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-router-web-')), cwd = path.join(root, 'work'), dataDir = path.join(root, 'data');
  const models = ['anthropic/claude-sonnet-4.6', 'google/gemini-3-pro-image'];
  const key = 'disposable-router-web-key';
  const names = ['AI_HARNESS_AUTH_TOKEN', 'AI_HARNESS_ADMIN_TOKEN', 'AI_HARNESS_AGENT_DIR', 'AI_HARNESS_MASTER_KEY'] as const;
  const previous = names.map(name => process.env[name]);
  process.env.AI_HARNESS_AUTH_TOKEN = 'router-user'; process.env.AI_HARNESS_ADMIN_TOKEN = 'router-admin';
  process.env.AI_HARNESS_AGENT_DIR = path.join(root, 'agent'); process.env.AI_HARNESS_MASTER_KEY = 'disposable-router-web-master';
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  let fixtureError: unknown;
  const wire = createServer(async (request, response) => {
    try {
      expect(request.method).toBe('POST');
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push({ url: request.url, headers: request.headers, body });
      response.setHeader('content-type', 'text/event-stream');
      const events = request.url?.endsWith('/messages') ? [
        { type: 'message_start', message: { model: body.model, usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Native router wire received.' } },
        { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' },
      ] : [{ model: body.model, choices: [{ index: 0, delta: { content: 'Native router wire received.' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } } }];
      response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (request.url?.endsWith('/messages') ? '' : 'data: [DONE]\n\n'));
    } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid OpenRouter browser fixture'); }
  });
  await mkdir(cwd); await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  try {
    const server = await start({ port: 0, host: '127.0.0.1', dataDir, defaultCwd: cwd, allowedRoots: [cwd], webRoot: path.resolve('packages/web/dist'), enableMockProvider: true });
    const base = `http://127.0.0.1:${server.port}`;
    expect((await page.request.post(`${base}/api/auth/login`, { data: { token: 'router-admin' } })).status()).toBe(200);
    expect((await page.request.post(`${base}/api/workspaces/trust`, { data: { cwd, confirm: true } })).status()).toBe(200);
    await page.addInitScript(() => localStorage.setItem('ai-harness-locale', 'en'));
    await page.goto(`${base}/settings?cwd=${encodeURIComponent(cwd)}#provider-lifecycle`);
    const section = page.locator('#provider-lifecycle');
    if (await section.locator('details.custom-resource-editor').getAttribute('open') === null)
      await section.getByText('Create or edit a compatible provider', { exact: true }).click();
    const form = section.locator('form');
    await form.getByLabel('ID', { exact: true }).fill('router-native'); await form.getByLabel('Name', { exact: true }).fill('Native router');
    await form.getByLabel('Base URL', { exact: true }).fill(`http://127.0.0.1:${(wire.address() as { port: number }).port}/proxy/api/v1`);
    await form.getByRole('combobox', { name: 'API dialect', exact: true }).selectOption('openrouter');
    await form.getByLabel('API key', { exact: true }).fill(key); await form.getByRole('button', { name: 'Save', exact: true }).click();
    const card = section.locator('[data-settings-selection="router-native"]');
    await expect(card).toContainText('openrouter'); expect(calls).toEqual([]);
    await page.reload(); await expect(card).toContainText('openrouter');
    if (await section.locator('details.custom-resource-editor').getAttribute('open') === null)
      await section.getByText('Create or edit a compatible provider', { exact: true }).click();
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(form.getByRole('combobox', { name: 'API dialect', exact: true })).toHaveValue('openrouter');
    await expect(form.getByLabel('API key', { exact: true })).toHaveValue('');
    expect((await page.request.post(`${base}/api/provider-registry/auth/router-native/test`, { data: {} })).status()).toBe(409); expect(calls).toEqual([]);
    const [imported] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/provider-registry/custom/router-native/import-models')),
      card.getByRole('button', { name: 'Import models', exact: true }).click()]);
    expect(imported.status()).toBe(200); expect(await imported.json()).toHaveLength(393); expect(calls).toEqual([]);
    await page.goto(`${base}/settings?cwd=${encodeURIComponent(cwd)}#custom-models`); await page.reload();
    const modelSection = page.locator('#custom-models'), modelCard = modelSection.locator('[data-settings-selection="router-native:anthropic/claude-sonnet-4.6"]');
    await expect(modelCard).toContainText('Anthropic: Claude Sonnet 4.6'); await expect(modelCard).toContainText('1000000 context · 128000 max output');
    await modelCard.getByRole('button', { name: 'Edit', exact: true }).click();
    if (await modelSection.locator('details.custom-resource-editor').getAttribute('open') === null) await modelSection.locator('summary').click();
    const modelForm = modelSection.locator('form'); await expect(modelForm.getByLabel('Name', { exact: true })).toHaveValue('Anthropic: Claude Sonnet 4.6');
    for (const capability of ['reasoning', 'images', 'tools']) await expect(modelForm.getByLabel(capability, { exact: true })).toBeChecked();
    await expect(modelForm.getByLabel('Context window', { exact: true })).toHaveValue('1000000'); await expect(modelForm.getByLabel('Maximum output tokens', { exact: true })).toHaveValue('128000');
    for (const [label, value] of [['Input', '3'], ['Output', '15'], ['Cache read', '0.3'], ['Cache write', '3.75']] as const) await expect(modelForm.getByLabel(`${label} price / million tokens`, { exact: true })).toHaveValue(value);
    expect(calls).toEqual([]);
    for (const [index, model] of models.entries()) {
      expect((await page.request.post(`${base}/api/provider-registry/models`, { data: { provider: 'router-native', id: model,
        capabilities: { reasoning: true, imageInput: true, toolCalls: true }, contextWindow: 128000, maxOutputTokens: 2048 } })).status()).toBe(201);
      expect((await page.request.patch(`${base}/api/configuration/scope`, { data: { scope: 'global', values: { provider: 'router-native', model, thinking: 'off', toolPreset: 'chat-only' } } })).status()).toBe(200);
      await page.reload(); if (!index) await closeSettings(page);
      await page.getByRole('button', { name: 'New chat', exact: true }).click();
      await page.getByRole('textbox', { name: 'Message composer' }).fill('Exercise native OpenRouter'); await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.locator('.message.assistant')).toContainText('Native router wire received.');
      expect(calls).toHaveLength(index + 1); expect(calls[index]).toMatchObject({ url: `/proxy/api/v1/${index ? 'chat/completions' : 'messages'}`, body: { model, stream: true } });
      if (!index) { expect(calls[index]?.headers['x-api-key']).toBe(key); expect(calls[index]?.headers.authorization).toBeUndefined(); }
      else { expect(calls[index]?.headers.authorization).toBe(`Bearer ${key}`); expect(calls[index]?.headers['x-api-key']).toBeUndefined(); }
      await page.reload(); await expect(page.locator('.message.assistant')).toHaveCount(1);
      await expect(page.locator('.message.assistant')).toContainText('Native router wire received.'); expect(calls).toHaveLength(index + 1);
    }
    expect(fixtureError).toBeUndefined();
    for (const file of ['providers.json', 'provider-secrets.enc']) expect(await readFile(path.join(dataDir, file), 'utf8')).not.toContain(key);
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(key);
  } finally {
    await page.goto('about:blank').catch(() => undefined); await stop(); wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve()));
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    await rm(root, { recursive: true, force: true });
  }
});
