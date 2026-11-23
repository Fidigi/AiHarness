import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { start, stop } from '../packages/server/dist/index.js';
import { expect, test } from './fixtures/test-budget';
import { closeSettings, selectCustomModel } from './fixtures/settings-navigation';

test('explicit DeepSeek is saved in Settings, imports two native chats and reloads private native history', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-ds-web-')), cwd = path.join(root, 'work'), dataDir = path.join(root, 'data');
  const model = 'deepseek-flash', key = 'disposable-ds-web-key';
  const names = ['AI_HARNESS_AUTH_TOKEN', 'AI_HARNESS_ADMIN_TOKEN', 'AI_HARNESS_AGENT_DIR', 'AI_HARNESS_MASTER_KEY'] as const;
  const previous = names.map(name => process.env[name]);
  process.env.AI_HARNESS_AUTH_TOKEN = 'ds-user'; process.env.AI_HARNESS_ADMIN_TOKEN = 'ds-admin';
  process.env.AI_HARNESS_AGENT_DIR = path.join(root, 'agent'); process.env.AI_HARNESS_MASTER_KEY = 'disposable-ds-web-master';
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  let fixtureError: unknown;
  const wire = createServer(async (request, response) => {
    try {
      expect(request.method).toBe('POST');
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push({ url: request.url, headers: request.headers, body });
      response.setHeader('content-type', 'text/event-stream');
      response.end([{ model: body.model, choices: [{ index: 0, delta: { content: 'Native DeepSeek wire received.' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } } },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid DeepSeek browser fixture'); }
  });
  await mkdir(cwd); await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  try {
    const server = await start({ port: 0, host: '127.0.0.1', dataDir, defaultCwd: cwd, allowedRoots: [cwd], webRoot: path.resolve('packages/web/dist'), enableMockProvider: true });
    const base = `http://127.0.0.1:${server.port}`;
    expect((await page.request.post(`${base}/api/auth/login`, { data: { token: 'ds-admin' } })).status()).toBe(200);
    expect((await page.request.post(`${base}/api/workspaces/trust`, { data: { cwd, confirm: true } })).status()).toBe(200);
    await page.addInitScript(() => localStorage.setItem('ai-harness-locale', 'en'));
    await page.goto(`${base}/settings?cwd=${encodeURIComponent(cwd)}#provider-lifecycle`);
    const section = page.locator('#provider-lifecycle');
    if (await section.locator('details.custom-resource-editor').getAttribute('open') === null)
      await section.getByText('Create or edit a compatible provider', { exact: true }).click();
    const form = section.locator('form');
    await form.getByLabel('ID', { exact: true }).fill('ds-native'); await form.getByLabel('Name', { exact: true }).fill('Native DeepSeek');
    await form.getByLabel('Base URL', { exact: true }).fill(`http://127.0.0.1:${(wire.address() as { port: number }).port}/proxy%2Fowned/v1/chat/completions/`);
    await form.getByRole('combobox', { name: 'API dialect', exact: true }).selectOption('deepseek');
    await form.getByLabel('API key', { exact: true }).fill(key); await form.getByRole('button', { name: 'Save', exact: true }).click();
    const card = section.locator('[data-settings-selection="ds-native"]');
    await expect(card).toContainText('deepseek'); expect(calls).toEqual([]);
    await page.reload(); await expect(card).toContainText('deepseek');
    if (await section.locator('details.custom-resource-editor').getAttribute('open') === null)
      await section.getByText('Create or edit a compatible provider', { exact: true }).click();
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(form.getByRole('combobox', { name: 'API dialect', exact: true })).toHaveValue('deepseek');
    await expect(form.getByLabel('API key', { exact: true })).toHaveValue('');
    const [connection] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/provider-registry/auth/ds-native/test')),
      card.getByRole('button', { name: 'Test connection', exact: true }).click()]);
    expect(connection.status()).toBe(409); expect(calls).toEqual([]);
    const [imported] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/provider-registry/custom/ds-native/import-models')),
      card.getByRole('button', { name: 'Import models', exact: true }).click()]);
    expect(imported.status()).toBe(200); expect(await imported.json()).toHaveLength(2); expect(calls).toEqual([]);
    await page.goto(`${base}/settings?cwd=${encodeURIComponent(cwd)}#custom-models`); await page.reload();
    await selectCustomModel(page, 'ds-native:deepseek-flash');
    const modelSection = page.locator('#custom-models'), modelCard = modelSection.locator('[data-settings-selection="ds-native:deepseek-flash"]');
    await expect(modelCard).toContainText('DeepSeek V4.1 Flash'); await expect(modelCard).toContainText('1000000 context · 384000 max output');
    await modelCard.getByRole('button', { name: 'Edit', exact: true }).click();
    if (await modelSection.locator('details.custom-resource-editor').getAttribute('open') === null) await modelSection.locator('summary').click();
    const modelForm = modelSection.locator('form'); await expect(modelForm.getByLabel('Name', { exact: true })).toHaveValue('DeepSeek V4.1 Flash');
    for (const capability of ['reasoning', 'images', 'tools']) await expect(modelForm.getByLabel(capability, { exact: true })).toBeChecked();
    await expect(modelForm.getByLabel('Context window', { exact: true })).toHaveValue('1000000'); await expect(modelForm.getByLabel('Maximum output tokens', { exact: true })).toHaveValue('384000');
    for (const [label, value] of [['Input', '0.3'], ['Output', '1.2'], ['Cache read', '0.006'], ['Cache write', '0']] as const) await expect(modelForm.getByLabel(`${label} price / million tokens`, { exact: true })).toHaveValue(value);
    expect(calls).toEqual([]);
    expect((await page.request.patch(`${base}/api/configuration/scope`, { data: { scope: 'global', values: { provider: 'ds-native', model, thinking: 'off', toolPreset: 'chat-only' } } })).status()).toBe(200);
    await page.reload(); await closeSettings(page); await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message composer' }).fill('Exercise native DeepSeek'); await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toContainText('Native DeepSeek wire received.');
    expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ url: '/proxy%2Fowned/v1/chat/completions', body: { model, stream: true, thinking: { type: 'disabled' }, max_tokens: 384000 } });
    expect(calls[0]?.body.max_completion_tokens).toBeUndefined(); expect(calls[0]?.body.reasoning_effort).toBeUndefined(); expect(calls[0]?.body.store).toBeUndefined(); expect(calls[0]?.headers.authorization).toBe(`Bearer ${key}`);
    for (const name of ['x-api-key', 'api-key', 'anthropic-version', 'cf-aig-authorization']) expect(calls[0]?.headers[name]).toBeUndefined();
    await page.reload(); await expect(page.locator('.message.assistant')).toHaveCount(1);
    await expect(page.locator('.message.assistant')).toContainText('Native DeepSeek wire received.'); expect(calls).toHaveLength(1);
    expect(fixtureError).toBeUndefined();
    for (const file of ['providers.json', 'provider-secrets.enc']) expect(await readFile(path.join(dataDir, file), 'utf8')).not.toContain(key);
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(key);
  } finally {
    await page.goto('about:blank').catch(() => undefined); await stop(); wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve()));
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    await rm(root, { recursive: true, force: true });
  }
});
