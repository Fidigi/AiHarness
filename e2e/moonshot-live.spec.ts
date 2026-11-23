import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { start, stop } from '../packages/server/dist/index.js';
import { expect, reserveReadBudget, test } from './fixtures/test-budget';
import { closeSettings, selectCustomModel, selectProviderConnection } from './fixtures/settings-navigation';

test('explicit Moonshot is saved in Settings, imports four native chats and reloads private native history', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-ms-web-')), cwd = path.join(root, 'work'), dataDir = path.join(root, 'data');
  const model = 'kimi-k3', key = 'disposable-ms-web-key';
  const names = ['AI_HARNESS_AUTH_TOKEN', 'AI_HARNESS_ADMIN_TOKEN', 'AI_HARNESS_AGENT_DIR', 'AI_HARNESS_MASTER_KEY'] as const;
  const previous = names.map(name => process.env[name]);
  process.env.AI_HARNESS_AUTH_TOKEN = 'ms-user'; process.env.AI_HARNESS_ADMIN_TOKEN = 'ms-admin';
  process.env.AI_HARNESS_AGENT_DIR = path.join(root, 'agent'); process.env.AI_HARNESS_MASTER_KEY = 'disposable-ms-web-master';
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  let fixtureError: unknown;
  const wire = createServer(async (request, response) => {
    try {
      expect(request.method).toBe('POST');
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push({ url: request.url, headers: request.headers, body });
      response.setHeader('content-type', 'text/event-stream');
      response.end([{ model: body.model, choices: [{ index: 0, delta: { content: 'Native Moonshot wire received.' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } } },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid Moonshot browser fixture'); }
  });
  await mkdir(cwd); await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  try {
    const server = await start({ port: 0, host: '127.0.0.1', dataDir, defaultCwd: cwd, allowedRoots: [cwd], webRoot: path.resolve('packages/web/dist'), enableMockProvider: true });
    const base = `http://127.0.0.1:${server.port}`;
    expect((await page.request.post(`${base}/api/auth/login`, { data: { token: 'ms-admin' } })).status()).toBe(200);
    expect((await page.request.post(`${base}/api/workspaces/trust`, { data: { cwd, confirm: true } })).status()).toBe(200);
    await page.addInitScript(() => localStorage.setItem('ai-harness-locale', 'en'));
    await page.goto(`${base}/settings?cwd=${encodeURIComponent(cwd)}#provider-lifecycle`);
    const section = page.locator('#provider-lifecycle');
    if (await section.locator('details.custom-resource-editor').getAttribute('open') === null)
      await section.getByText('Create or edit a compatible provider', { exact: true }).click();
    const form = section.locator('form');
    await form.getByLabel('ID', { exact: true }).fill('ms-native'); await form.getByLabel('Name', { exact: true }).fill('Native Moonshot');
    await form.getByLabel('Base URL', { exact: true }).fill(`http://127.0.0.1:${(wire.address() as { port: number }).port}/proxy%2Fowned/v1/chat/completions/`);
    await form.getByRole('combobox', { name: 'API dialect', exact: true }).selectOption('moonshot');
    await form.getByLabel('API key', { exact: true }).fill(key); await form.getByRole('button', { name: 'Save', exact: true }).click();
    const card = section.locator('[data-settings-selection="ms-native"]');
    await expect(card).toContainText('moonshot'); expect(calls).toEqual([]);
    await page.reload(); await expect(card).toContainText('moonshot');
    if (await section.locator('details.custom-resource-editor').getAttribute('open') === null)
      await section.getByText('Create or edit a compatible provider', { exact: true }).click();
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(form.getByRole('combobox', { name: 'API dialect', exact: true })).toHaveValue('moonshot');
    await expect(form.getByLabel('API key', { exact: true })).toHaveValue('');
    const [connection] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/provider-registry/auth/ms-native/test')),
      card.getByRole('button', { name: 'Test connection', exact: true }).click()]);
    expect(connection.status()).toBe(409); expect(calls).toEqual([]);
    const [imported] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/provider-registry/custom/ms-native/import-models')),
      card.getByRole('button', { name: 'Import models', exact: true }).click()]);
    expect(imported.status()).toBe(200); expect(await imported.json()).toHaveLength(4); expect(calls).toEqual([]);
    await page.goto(`${base}/settings?cwd=${encodeURIComponent(cwd)}#custom-models`); await page.reload();
    await selectCustomModel(page, 'ms-native:kimi-k3');
    const modelSection = page.locator('#custom-models'), modelCard = modelSection.locator('[data-settings-selection="ms-native:kimi-k3"]');
    await expect(modelCard).toContainText('Kimi K3'); await expect(modelCard).toContainText('1048576 context · 1048576 max output');
    await modelCard.getByRole('button', { name: 'Edit', exact: true }).click();
    if (await modelSection.locator('details.custom-resource-editor').getAttribute('open') === null) await modelSection.locator('summary').click();
    const modelForm = modelSection.locator('form'); await expect(modelForm.getByLabel('Name', { exact: true })).toHaveValue('Kimi K3');
    for (const capability of ['reasoning', 'images', 'tools']) await expect(modelForm.getByLabel(capability, { exact: true })).toBeChecked();
    await expect(modelForm.getByLabel('Context window', { exact: true })).toHaveValue('1048576'); await expect(modelForm.getByLabel('Maximum output tokens', { exact: true })).toHaveValue('1048576');
    for (const [label, value] of [['Input', '3'], ['Output', '15'], ['Cache read', '0.3'], ['Cache write', '0']] as const) await expect(modelForm.getByLabel(`${label} price / million tokens`, { exact: true })).toHaveValue(value);
    expect(calls).toEqual([]);
    expect((await page.request.patch(`${base}/api/configuration/scope`, { data: { scope: 'global', values: { provider: 'ms-native', model, thinking: 'off', toolPreset: 'chat-only' } } })).status()).toBe(200);
    await page.reload(); await closeSettings(page); await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message composer' }).fill('Exercise native Moonshot'); await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toContainText('Native Moonshot wire received.');
    expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ url: '/proxy%2Fowned/v1/chat/completions', body: { model, stream: true, reasoning_effort: 'low', max_tokens: 1048576 } });
    expect(calls[0]?.body.thinking).toBeUndefined(); expect(calls[0]?.body.tool_stream).toBeUndefined(); expect(calls[0]?.body.max_completion_tokens).toBeUndefined(); expect(calls[0]?.body.store).toBeUndefined();
    const messages = calls[0]?.body.messages as Array<{ role: string }>; expect(messages.some(message => message.role === 'developer')).toBe(false); expect(messages.some(message => message.role === 'system')).toBe(true); expect(calls[0]?.headers.authorization).toBe(`Bearer ${key}`);
    for (const name of ['x-api-key', 'api-key', 'anthropic-version', 'cf-aig-authorization']) expect(calls[0]?.headers[name]).toBeUndefined();
    await page.reload(); await expect(page.locator('.message.assistant')).toHaveCount(1);
    await expect(page.locator('.message.assistant')).toContainText('Native Moonshot wire received.'); expect(calls).toHaveLength(1);
    expect(fixtureError).toBeUndefined();
    for (const file of ['providers.json', 'provider-secrets.enc']) expect(await readFile(path.join(dataDir, file), 'utf8')).not.toContain(key);
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(key);
  } finally {
    await page.goto('about:blank').catch(() => undefined); await stop(); wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve()));
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    await rm(root, { recursive: true, force: true });
  }
});

test('CN Moonshot Settings retains the explicit URL through import, key replacement and page reload', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-cn-settings-')), cwd = path.join(root, 'work'), dataDir = path.join(root, 'data');
  const id = 'regional-settings', baseUrl = 'https://api.moonshot.cn/v1', keys = ['disposable-cn-settings-first', 'disposable-cn-settings-rotated'];
  const names = ['AI_HARNESS_AUTH_TOKEN', 'AI_HARNESS_ADMIN_TOKEN', 'AI_HARNESS_AGENT_DIR', 'AI_HARNESS_MASTER_KEY'] as const;
  const previous = names.map(name => process.env[name]), actualFetch = globalThis.fetch, outbound: string[] = [];
  process.env.AI_HARNESS_AUTH_TOKEN = 'cn-settings-user'; process.env.AI_HARNESS_ADMIN_TOKEN = 'cn-settings-admin';
  process.env.AI_HARNESS_AGENT_DIR = path.join(root, 'agent'); process.env.AI_HARNESS_MASTER_KEY = 'disposable-cn-settings-master';
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('http://127.0.0.1:')) return actualFetch(input, init);
    outbound.push(url); throw new Error('Unexpected outbound request in CN Settings control');
  };
  try {
    await mkdir(cwd);
    const server = await start({ port: 0, host: '127.0.0.1', dataDir, defaultCwd: cwd, allowedRoots: [cwd], webRoot: path.resolve('packages/web/dist'), enableMockProvider: true });
    const base = `http://127.0.0.1:${server.port}`;
    expect((await page.request.post(`${base}/api/auth/login`, { data: { token: 'cn-settings-admin' } })).status()).toBe(200);
    expect((await page.request.post(`${base}/api/workspaces/trust`, { data: { cwd, confirm: true } })).status()).toBe(200);
    await reserveReadBudget(page.request, base);
    await page.addInitScript(() => localStorage.setItem('ai-harness-locale', 'en'));
    await page.goto(`${base}/settings?cwd=${encodeURIComponent(cwd)}#provider-lifecycle`);
    const section = page.locator('#provider-lifecycle'), form = section.locator('form');
    if (await section.locator('details.custom-resource-editor').getAttribute('open') === null)
      await section.getByText('Create or edit a compatible provider', { exact: true }).click();
    await form.getByLabel('ID', { exact: true }).fill(id); await form.getByLabel('Name', { exact: true }).fill('Explicit CN Settings');
    await form.getByLabel('Base URL', { exact: true }).fill(baseUrl);
    await form.getByRole('combobox', { name: 'API dialect', exact: true }).selectOption('moonshot');
    await form.getByLabel('API key', { exact: true }).fill(keys[0]!);
    const [saved] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/provider-registry/custom') && response.request().method() === 'POST'),
      form.getByRole('button', { name: 'Save', exact: true }).click()]);
    expect(saved.status()).toBe(201); expect(await saved.text()).not.toContain(keys[0]);
    const card = section.locator(`[data-settings-selection="${id}"]`);
    for (let phase = 0; phase < 2; phase++) {
      await page.reload(); await selectProviderConnection(page, 'custom', id); await expect(card).toContainText('moonshot');
      if (await section.locator('details.custom-resource-editor').getAttribute('open') === null)
        await section.getByText('Create or edit a compatible provider', { exact: true }).click();
      await card.getByRole('button', { name: 'Edit', exact: true }).click();
      await expect(form.getByLabel('Base URL', { exact: true })).toHaveValue(baseUrl);
      await expect(form.getByRole('combobox', { name: 'API dialect', exact: true })).toHaveValue('moonshot');
      await expect(form.getByLabel('API key', { exact: true })).toHaveValue('');
      if (phase === 0) {
        const [connection] = await Promise.all([page.waitForResponse(response => response.url().endsWith(`/api/provider-registry/auth/${id}/test`)),
          card.getByRole('button', { name: 'Test connection', exact: true }).click()]);
        expect(connection.status()).toBe(409);
        const [imported] = await Promise.all([page.waitForResponse(response => response.url().endsWith(`/api/provider-registry/custom/${id}/import-models`)),
          card.getByRole('button', { name: 'Import models', exact: true }).click()]);
        expect(imported.status()).toBe(200);
        expect((await imported.json()).map((entry: { id: string }) => entry.id).sort())
          .toEqual(['kimi-k2.6', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k3']);
        await card.getByRole('button', { name: 'Edit', exact: true }).click();
        await form.getByLabel('API key', { exact: true }).fill(keys[1]!);
        const [rotated] = await Promise.all([page.waitForResponse(response => response.url().endsWith(`/api/provider-registry/custom/${id}`) && response.request().method() === 'PUT'),
          form.getByRole('button', { name: 'Save', exact: true }).click()]);
        expect(rotated.status()).toBe(200); expect(rotated.request().postDataJSON()).toMatchObject({ baseUrl, dialect: 'moonshot', apiKey: keys[1] });
        expect(await rotated.text()).not.toContain(keys[1]);
      }
    }
    await page.goto(`${base}/settings?cwd=${encodeURIComponent(cwd)}#custom-models`);
    await selectCustomModel(page, `${id}:kimi-k3`);
    await expect(page.locator('#custom-models').locator(`[data-settings-selection="${id}:kimi-k3"]`)).toContainText('Kimi K3');
    for (const file of ['providers.json', 'provider-secrets.enc']) for (const key of keys)
      expect(await readFile(path.join(dataDir, file), 'utf8')).not.toContain(key);
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    for (const key of keys) expect(storage).not.toContain(key);
    expect([[], ['https://api.github.com/repos/Fidigi/AiHarness/releases/latest']]).toContainEqual(outbound);
  } finally {
    await page.goto('about:blank').catch(() => undefined); await stop(); globalThis.fetch = actualFetch;
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    await rm(root, { recursive: true, force: true });
  }
});

test('CN Moonshot keyboard conversations stream all four physical models through the explicit regional host', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-cn-conversation-')), cwd = path.join(root, 'work'), dataDir = path.join(root, 'data');
  const id = 'regional-conversation', key = 'disposable-cn-conversation-key', baseUrl = 'https://api.moonshot.cn/v1';
  const models = ['kimi-k2.6', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k3'] as const;
  const names = ['AI_HARNESS_AUTH_TOKEN', 'AI_HARNESS_ADMIN_TOKEN', 'AI_HARNESS_AGENT_DIR', 'AI_HARNESS_MASTER_KEY'] as const;
  const previous = names.map(name => process.env[name]), actualFetch = globalThis.fetch, intended: string[] = [], blocked: string[] = [];
  process.env.AI_HARNESS_AUTH_TOKEN = 'cn-conversation-user'; process.env.AI_HARNESS_ADMIN_TOKEN = 'cn-conversation-admin';
  process.env.AI_HARNESS_AGENT_DIR = path.join(root, 'agent'); process.env.AI_HARNESS_MASTER_KEY = 'disposable-cn-conversation-master';
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  let fixtureError: unknown;
  const wire = createServer(async (request, response) => {
    try {
      expect(request.method).toBe('POST');
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push({ url: request.url, headers: request.headers, body });
      response.setHeader('content-type', 'text/event-stream');
      response.end([{ model: body.model, choices: [{ index: 0, delta: { content: `CN conversation ${body.model} received.` } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } } },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid CN conversation fixture'); }
  });
  await mkdir(cwd); await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  const wireUrl = `http://127.0.0.1:${(wire.address() as { port: number }).port}/native-cn/chat/completions`;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${baseUrl}/chat/completions`) { intended.push(url); return actualFetch(wireUrl, init); }
    if (url.startsWith('http://127.0.0.1:')) return actualFetch(input, init);
    blocked.push(url); throw new Error('External request blocked by CN conversation fixture');
  };
  try {
    const server = await start({ port: 0, host: '127.0.0.1', dataDir, defaultCwd: cwd, allowedRoots: [cwd], webRoot: path.resolve('packages/web/dist'), enableMockProvider: true });
    const base = `http://127.0.0.1:${server.port}`;
    expect((await page.request.post(`${base}/api/auth/login`, { data: { token: 'cn-conversation-admin' } })).status()).toBe(200);
    expect((await page.request.post(`${base}/api/workspaces/trust`, { data: { cwd, confirm: true } })).status()).toBe(200);
    expect((await page.request.post(`${base}/api/provider-registry/custom`, { data: { id, name: 'Regional conversation', baseUrl, dialect: 'moonshot', apiKey: key } })).status()).toBe(201);
    const imported = await page.request.post(`${base}/api/provider-registry/custom/${id}/import-models`);
    expect(imported.status()).toBe(200); expect((await imported.json()).map((entry: { id: string }) => entry.id).sort()).toEqual([...models]);
    expect((await page.request.put(`${base}/api/provider-registry/custom/${id}`, { data: { apiKey: key } })).status()).toBe(200);
    await reserveReadBudget(page.request, base);
    await page.addInitScript(() => localStorage.setItem('ai-harness-locale', 'en'));
    for (const [index, model] of models.entries()) {
      expect((await page.request.patch(`${base}/api/configuration/scope`, { data: { scope: 'global', values: { provider: id, model, thinking: 'off', toolPreset: 'chat-only' } } })).status()).toBe(200);
      await page.goto(`${base}/settings?cwd=${encodeURIComponent(cwd)}`);
      await closeSettings(page);
      await page.getByRole('button', { name: 'New chat', exact: true }).click();
      expect(await page.evaluate(() => navigator.onLine)).toBe(true);
      await page.getByRole('textbox', { name: 'Message composer' }).fill(`Exercise CN ${model}`);
      await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
      await page.getByRole('textbox', { name: 'Message composer' }).press('Enter');
      await expect(page.locator('.message.assistant')).toHaveCount(1);
      await expect(page.locator('.message.assistant')).toContainText(`CN conversation ${model} received.`);
      await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
      expect(calls).toHaveLength(index + 1); expect(intended).toHaveLength(index + 1);
      expect(calls[index]).toMatchObject({ url: '/native-cn/chat/completions', body: { model, stream: true } });
      expect(calls[index]?.headers.authorization).toBe(`Bearer ${key}`);
      expect(Number.isSafeInteger(calls[index]?.body.max_tokens)).toBe(true); expect(calls[index]?.body.max_tokens).toBeGreaterThan(0);
      for (const name of ['x-api-key', 'api-key', 'anthropic-version', 'cf-aig-authorization']) expect(calls[index]?.headers[name]).toBeUndefined();
      await page.reload(); await expect(page.locator('.message.assistant')).toHaveCount(1);
      await expect(page.locator('.message.assistant')).toContainText(`CN conversation ${model} received.`);
      expect(calls).toHaveLength(index + 1); expect(intended).toHaveLength(index + 1);
    }
    expect(calls.map(call => call.body.model)).toEqual([...models]);
    expect(intended).toEqual(models.map(() => `${baseUrl}/chat/completions`));
    expect([[], ['https://api.github.com/repos/Fidigi/AiHarness/releases/latest']]).toContainEqual(blocked); expect(fixtureError).toBeUndefined();
    for (const file of ['providers.json', 'provider-secrets.enc']) expect(await readFile(path.join(dataDir, file), 'utf8')).not.toContain(key);
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(key);
  } finally {
    try {
      await test.info().attach('cn-native-loopback-ledger', { body: JSON.stringify({ intended, blocked, calls,
        fixtureError: fixtureError instanceof Error ? fixtureError.message : fixtureError }), contentType: 'application/json' });
    } finally {
      await page.goto('about:blank').catch(() => undefined); await stop(); wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve()));
      globalThis.fetch = actualFetch;
      names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
      await rm(root, { recursive: true, force: true });
    }
  }
});
