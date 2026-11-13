import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { start, stop } from '../packages/server/dist/index.js';
import { expect, test } from './fixtures/test-budget';

test('Settings saves a native mixed dialect and sends its Google conversation without extension injection', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-native-settings-'));
  const cwd = path.join(root, 'work'), dataDir = path.join(root, 'data'), model = 'gemini-3.1-pro';
  const key = 'synthetic-native-settings-key';
  const names = ['AI_HARNESS_AUTH_TOKEN', 'AI_HARNESS_ADMIN_TOKEN', 'AI_HARNESS_AGENT_DIR', 'AI_HARNESS_MASTER_KEY'] as const;
  const previous = names.map(name => process.env[name]);
  process.env.AI_HARNESS_AUTH_TOKEN = 'native-user'; process.env.AI_HARNESS_ADMIN_TOKEN = 'native-admin';
  process.env.AI_HARNESS_AGENT_DIR = path.join(root, 'agent'); process.env.AI_HARNESS_MASTER_KEY = 'synthetic-native-settings-master';
  const calls: Array<{ url?: string; key: string | string[] | undefined; body: Record<string, unknown> }> = [];
  let fixtureError: unknown;
  const wire = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      calls.push({ url: request.url, key: request.headers['x-goog-api-key'], body: JSON.parse(Buffer.concat(chunks).toString()) });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Native mixed Settings reply.' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, totalTokenCount: 5 } })}\n\n`);
    } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid native Settings fixture'); }
  });
  await mkdir(cwd); await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  try {
    const server = await start({ port: 0, host: '127.0.0.1', dataDir, defaultCwd: cwd, allowedRoots: [cwd], webRoot: path.resolve('packages/web/dist'), enableMockProvider: true });
    const base = `http://127.0.0.1:${server.port}`;
    expect((await page.request.post(`${base}/api/auth/login`, { data: { token: 'native-admin' } })).status()).toBe(200);
    expect((await page.request.post(`${base}/api/workspaces/trust`, { data: { cwd, confirm: true } })).status()).toBe(200);
    await page.addInitScript(() => localStorage.setItem('ai-harness-locale', 'en'));
    await page.goto(`${base}/settings?cwd=${encodeURIComponent(cwd)}`);
    const section = page.locator('#provider-lifecycle');
    if (await section.locator('details.custom-resource-editor').getAttribute('open') === null)
      await section.getByText('Create or edit a compatible provider', { exact: true }).click();
    const form = section.locator('form');
    await form.getByLabel('ID', { exact: true }).fill('native-zen'); await form.getByLabel('Name', { exact: true }).fill('Native Zen');
    await form.getByLabel('Base URL', { exact: true }).fill(`http://127.0.0.1:${(wire.address() as { port: number }).port}/owned`);
    const dialect = form.getByRole('combobox', { name: 'API dialect', exact: true });
    for (const value of ['ant-ling', 'baseten', 'fireworks', 'huggingface', 'kimi-coding', 'meta', 'minimax', 'minimax-cn', 'opencode-go', 'opencode', 'together', 'xai', 'xiaomi', 'moonshot-cn'])
      await expect(dialect.locator(`option[value="${value}"]`)).toHaveCount(1);
    await dialect.selectOption('opencode'); await form.getByLabel('API key', { exact: true }).fill(key);
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    const card = section.locator('[data-settings-selection="native-zen"]');
    await expect(card).toContainText('opencode'); expect(calls).toEqual([]);
    await page.reload(); await expect(card).toContainText('opencode');
    if (await section.locator('details.custom-resource-editor').getAttribute('open') === null)
      await section.getByText('Create or edit a compatible provider', { exact: true }).click();
    const [connection] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/provider-registry/auth/native-zen/test')),
      card.getByRole('button', { name: 'Test connection', exact: true }).click()]);
    expect(connection.status()).toBe(409); expect(calls).toEqual([]);
    const [imported] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/provider-registry/custom/native-zen/import-models')),
      card.getByRole('button', { name: 'Import models', exact: true }).click()]);
    expect(imported.status()).toBe(200); expect(await imported.json()).toHaveLength(83); expect(calls).toEqual([]);
    expect((await page.request.patch(`${base}/api/configuration/scope`, { data: { scope: 'global', values: { provider: 'native-zen', model, thinking: 'high', toolPreset: 'chat-only' } } })).status()).toBe(200);
    await page.reload(); await page.getByRole('button', { name: 'New chat', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Message composer' });
    await composer.fill('Native mixed request'); await composer.press('Enter');
    await expect(page.locator('.message.assistant')).toContainText('Native mixed Settings reply.');
    expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ key, url: '/owned/v1/models/gemini-3.1-pro:streamGenerateContent?alt=sse',
      body: { generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true } } } });
    await page.reload(); await expect(page.locator('.message.assistant')).toContainText('Native mixed Settings reply.'); expect(calls).toHaveLength(1);
    expect(fixtureError).toBeUndefined();
    for (const file of ['providers.json', 'provider-secrets.enc']) expect(await readFile(path.join(dataDir, file), 'utf8')).not.toContain(key);
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(key);
  } finally {
    await page.goto('about:blank').catch(() => undefined); await stop(); wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve()));
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    await rm(root, { recursive: true, force: true });
  }
});
