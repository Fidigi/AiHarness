import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AnthropicProvider } from '../packages/core/dist/index.js';
import { start, stop } from '../packages/server/dist/index.js';
import { createRuntimeServices } from '../packages/server/dist/runtime/services.js';
import { expect, test } from './fixtures/test-budget';

// Real emitted static Web -> authenticated API -> Core -> native Anthropic HTTP
// adapter; only the external service is a disposable loopback wire fixture.
for (const [locale, theme] of [['en', 'light'], ['fr', 'dark']] as const) test(`${locale}/${theme}: scoped reasoning budgets survive Settings reload and reach parent/child native numeric requests`, async ({ page }) => {
  const labels = locale === 'fr' ? { scope: 'Portée', budgets: 'Budgets de réflexion (JSON)', save: 'Enregistrer',
    invalid: 'doivent être un JSON valide', newChat: 'Nouvelle conversation', composer: 'Zone de rédaction', send: 'Envoyer' }
    : { scope: 'Scope', budgets: 'Reasoning budgets (JSON)', save: 'Save', invalid: 'must be valid JSON',
      newChat: 'New chat', composer: 'Message composer', send: 'Send' };
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-reasoning-web-'));
  const cwd = path.join(root, 'work'), model = 'claude-3-7-sonnet-latest';
  const names = ['AI_HARNESS_AUTH_TOKEN', 'AI_HARNESS_ADMIN_TOKEN', 'AI_HARNESS_AGENT_DIR'] as const;
  const previous = names.map(name => process.env[name]);
  process.env.AI_HARNESS_AUTH_TOKEN = 'mod-user'; process.env.AI_HARNESS_ADMIN_TOKEN = 'mod-admin';
  process.env.AI_HARNESS_AGENT_DIR = path.join(root, 'agent');
  const bodies: Array<{ thinking: unknown; max_tokens: number; stream: boolean }> = [];
  const wire = createServer(async (request, response) => {
    if (request.method === 'GET') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: model }] })); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.setHeader('Content-Type', 'text/event-stream');
    response.end([
      { type: 'message_start', message: { id: 'wire-budget', model, usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Native reasoning wire received.' } },
      { type: 'message_delta', usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  await mkdir(cwd); await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  try {
    const upstream = `http://127.0.0.1:${(wire.address() as { port: number }).port}`;
    const server = await start({ port: 0, host: '127.0.0.1', dataDir: path.join(root, 'data'), defaultCwd: cwd,
      allowedRoots: [cwd], webRoot: path.resolve('packages/web/dist'), enableMockProvider: true,
      runtimeServicesFactory: async (proxy, options) => {
        const services = await createRuntimeServices(proxy, options);
        proxy.setCustomProvider('reasoning-proof', new AnthropicProvider({ type: 'anthropic', apiKey: 'disposable-wire-key', baseUrl: upstream, model }));
        return services;
      } });
    const base = `http://127.0.0.1:${server.port}`;
    const denied = await page.request.patch(`${base}/api/configuration/scope`, { headers: { Authorization: 'Bearer mod-user' },
      data: { scope: 'global', values: { thinkingBudgets: { low: 2000 } } } });
    expect(denied.status()).toBe(403);
    expect((await page.request.post(`${base}/api/auth/login`, { data: { token: 'mod-admin' } })).status()).toBe(200);
    expect((await page.request.post(`${base}/api/workspaces/trust`, { data: { cwd, confirm: true } })).status()).toBe(200);
    expect((await page.request.patch(`${base}/api/configuration/scope`, { data: { scope: 'global',
      values: { provider: 'reasoning-proof', model, thinking: 'low', toolPreset: 'chat-only' } } })).status()).toBe(200);
    await page.addInitScript(preferences => {
      localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme: preferences.theme }));
      localStorage.setItem('ai-harness-locale', preferences.locale);
    }, { locale, theme });
    await page.goto(`${base}/settings?cwd=${encodeURIComponent(cwd)}`);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const defaults = page.locator('#defaults');
    await defaults.getByRole('combobox', { name: labels.scope, exact: true }).selectOption('global');
    const budgets = defaults.getByLabel(labels.budgets, { exact: true });
    await expect(budgets).toBeEnabled(); await budgets.fill('{broken');
    await defaults.getByRole('button', { name: labels.save, exact: true }).click();
    await expect(page.locator('.status-center')).toContainText(labels.invalid);
    expect((await page.request.get(`${base}/api/configuration/scope?scope=global`).then(response => response.json())).values.thinkingBudgets).toBeUndefined();
    await budgets.fill('{"low":2000}'); await defaults.getByRole('button', { name: labels.save, exact: true }).click();
    await expect(defaults.getByRole('button', { name: labels.save, exact: true })).toBeDisabled();
    expect((await page.request.get(`${base}/api/configuration/scope?scope=global`).then(response => response.json())).values.thinkingBudgets).toEqual({ low: 2000 });
    await page.reload(); await expect(defaults.getByLabel(labels.budgets, { exact: true })).toHaveValue('{"low":2000}');
    expect(bodies).toEqual([]);
    await page.getByRole('button', { name: labels.newChat, exact: true }).click();
    await page.getByRole('textbox', { name: labels.composer }).fill('Exercise the numeric budget');
    const accepted = page.waitForResponse(response => response.url().endsWith('/api/agent/runs') && response.request().method() === 'POST');
    await page.getByRole('button', { name: labels.send, exact: true }).click();
    const parent = await (await accepted).json();
    await expect(page.locator('.message.assistant')).toContainText('Native reasoning wire received.');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 2000 }, max_tokens: 3024, stream: true });
    const delegated = await page.request.post(`${base}/api/subagents/runs`, { data: {
      parentSessionId: parent.session.id, profileId: 'general', provider: 'reasoning-proof',
      task: 'Inherit the numeric budget', thinkingBudgets: { low: 999999 },
    } });
    expect(delegated.status()).toBe(202);
    const child = await delegated.json();
    await expect.poll(async () => (await page.request.get(`${base}/api/subagents/runs/${child.id}`).then(response => response.json())).status).toBe('completed');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 2000 }, max_tokens: 3024, stream: true });
    await page.reload(); await expect(page.locator('.message.assistant')).toHaveCount(1);
    await expect(page.locator('.message.assistant')).toContainText('Native reasoning wire received.');
    expect(bodies).toHaveLength(2);
  } finally {
    await page.goto('about:blank').catch(() => undefined); await stop();
    wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve()));
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    await rm(root, { recursive: true, force: true });
  }
});
