import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AnthropicProvider, GeminiProvider, VertexGeminiProvider, OpenAiMixedProvider, AzureProvider, SESSION_EXPORT_CONTINUATION_WARNING } from '../packages/core/dist/index.js';
import { start, stop } from '../packages/server/dist/index.js';
import { createRuntimeServices } from '../packages/server/dist/runtime/services.js';
import { expect, test } from './fixtures/test-budget';

for (const dialect of ['anthropic', 'google', 'vertex', 'responses', 'azure-responses'] as const) test(`native signed ${dialect} blocks survive server restart, replay and guarded export`, async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-signed-web-'));
  const responses = dialect === 'responses' || dialect === 'azure-responses';
  const cwd = path.join(root, 'work'), dataDir = path.join(root, 'data'), model = dialect === 'anthropic' ? 'claude-sonnet-4-6' : responses ? 'gpt-5' : 'gemini-3.8-flash';
  const opaque = dialect === 'anthropic' ? ['opaque-start-tail', 'opaque-redacted'] : responses ? ['opaque-reasoning', 'msg_opaque'] : ['b3BhcXVlLXJlYXNvbmluZw==', 'b3BhcXVlLXRleHQ='];
  const names = ['AI_HARNESS_AUTH_TOKEN', 'AI_HARNESS_ADMIN_TOKEN', 'AI_HARNESS_AGENT_DIR'] as const;
  const previous = names.map(name => process.env[name]);
  process.env.AI_HARNESS_AUTH_TOKEN = 'mod-user'; process.env.AI_HARNESS_ADMIN_TOKEN = 'mod-admin';
  process.env.AI_HARNESS_AGENT_DIR = path.join(root, 'agent');
  const bodies: Array<{ messages?: Array<{ role: string; content: unknown }>; contents?: Array<{ role: string; parts: unknown }>; input?: Array<Record<string, unknown>> }> = [];
  const wire = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(dialect === 'anthropic' ? { data: [{ id: model }] } : { models: [{ name: `models/${model}` }] })); return;
    }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    const answer = bodies.length === 1 ? 'First native answer.' : 'Continued native answer.';
    response.setHeader('Content-Type', 'text/event-stream');
    if (responses) {
      response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_web', model: 'untrusted-alias', status: 'completed', output: [
        { type: 'reasoning', id: 'rs_web', summary: [{ type: 'summary_text', text: 'Visible native reasoning' }], encrypted_content: opaque[0] },
        { type: 'message', id: opaque[1], role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: answer, annotations: [] }] },
      ], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } })}\n\n`); return;
    }
    if (dialect !== 'anthropic') {
      response.end(`data: ${JSON.stringify({ modelVersion: 'untrusted-alias', candidates: [{ content: { role: 'model', parts: [
        { text: 'Visible native reasoning', thought: true, thoughtSignature: opaque[0] }, { text: answer, thoughtSignature: opaque[1] },
      ] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } })}\n\n`);
      return;
    }
    response.end([
      { type: 'message_start', message: { model: 'untrusted-alias', usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'Visible native reasoning', signature: 'opaque-start-' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'tail' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'opaque-redacted' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: answer } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  await mkdir(cwd); await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  try {
    const upstream = `http://127.0.0.1:${(wire.address() as { port: number }).port}`;
    const options: NonNullable<Parameters<typeof start>[0]> = { port: 0, host: '127.0.0.1', dataDir, defaultCwd: cwd,
      allowedRoots: [cwd], webRoot: path.resolve('packages/web/dist'), enableMockProvider: true,
      runtimeServicesFactory: async (proxy, settings) => {
        const services = await createRuntimeServices(proxy, settings);
        const config = { apiKey: 'disposable-private-wire', baseUrl: upstream, model };
        proxy.setCustomProvider('native-signed', dialect === 'anthropic' ? new AnthropicProvider({ ...config, type: 'native-signed' })
          : dialect === 'google' ? new GeminiProvider({ ...config, type: 'google' }) : dialect === 'vertex' ? new VertexGeminiProvider({ ...config, type: 'vertex' })
            : dialect === 'responses' ? new OpenAiMixedProvider({ ...config, type: 'openai', transport: 'sse' }) : new AzureProvider({ ...config, type: 'azure' }));
        return services;
      } };
    const server = await start(options), base = `http://127.0.0.1:${server.port}`;
    const login = async () => expect((await page.request.post(`${base}/api/auth/login`, { data: { token: 'mod-admin' } })).status()).toBe(200);
    await login();
    expect((await page.request.post(`${base}/api/workspaces/trust`, { data: { cwd, confirm: true } })).status()).toBe(200);
    expect((await page.request.patch(`${base}/api/configuration/scope`, { data: { scope: 'global',
      values: { provider: 'native-signed', model, thinking: 'low', toolPreset: 'chat-only' } } })).status()).toBe(200);
    await page.addInitScript(() => localStorage.setItem('ai-harness-locale', 'en'));
    const settingsUrl = `${base}/settings?cwd=${encodeURIComponent(cwd)}`;
    await page.goto(settingsUrl);
    await page.getByRole('combobox', { name: 'Select the AI Provider', exact: true }).selectOption('native-signed');
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    const send = async (text: string) => {
      await page.getByRole('textbox', { name: 'Message composer' }).fill(text);
      const accepted = page.waitForResponse(response => response.url().endsWith('/api/agent/runs') && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const result = await (await accepted).json();
      await expect.poll(async () => (await page.request.get(`${base}/api/agent/runs/${result.run.id}`).then(response => response.json())).phase).toBe('completed');
      return result;
    };
    const first = await send('Start native reasoning');
    await expect(page.locator('.message.assistant')).toContainText('First native answer.');
    const file = path.join(dataDir, 'sessions', first.session.id + '.jsonl'), before = await readFile(file, 'utf8');
    for (const value of opaque) expect(before).toContain(value);
    expect(before).not.toContain('disposable-private-wire');
    const exported = await page.request.get(`${base}/api/sessions/${first.session.id}/export?format=json`);
    expect(exported.status()).toBe(200); expect(exported.headers()['x-aiharness-export-warning']).toBe(SESSION_EXPORT_CONTINUATION_WARNING);
    const expurgated = await exported.text(); expect(expurgated).not.toContain('opaque-'); expect(expurgated).toContain('First native answer.');
    for (const value of opaque) expect(expurgated).not.toContain(value);
    const complete = await page.request.get(`${base}/api/sessions/${first.session.id}/export?format=json&includeOpaqueContinuations=true`);
    expect(complete.status()).toBe(200);
    const completeText = await complete.text(); for (const value of opaque) expect(completeText).toContain(value);
    expect(await readFile(file, 'utf8')).toBe(before);
    const url = page.url(); await page.goto('about:blank'); await stop();
    await start({ ...options, port: server.port }); await login(); await page.goto(url);
    await expect(page.locator('.message.assistant')).toHaveCount(1); expect(bodies).toHaveLength(1);
    // Scoped defaults initialize new drafts, not the active provider for a saved chat.
    // Explicitly select the same physical provider before asking for native replay.
    await page.goto(settingsUrl);
    await page.getByRole('combobox', { name: 'Select the AI Provider', exact: true }).selectOption('native-signed');
    await page.locator(`a.session-main[href*="${first.session.id}"]`).click();
    const second = await send('Continue from the saved native response');
    expect(second.session.id).toBe(first.session.id);
    await expect(page.locator('.message.assistant').last()).toContainText('Continued native answer.');
    expect(bodies).toHaveLength(2);
    if (dialect === 'anthropic') expect(bodies[1].messages!.filter(message => message.role === 'assistant')).toEqual([{ role: 'assistant', content: [
      { type: 'thinking', thinking: 'Visible native reasoning', signature: 'opaque-start-tail' },
      { type: 'redacted_thinking', data: 'opaque-redacted' }, { type: 'text', text: 'First native answer.' },
    ] }]);
    else if (responses) expect(bodies[1].input!.filter(item => item.type === 'reasoning' || item.role === 'assistant')).toEqual([
      { type: 'reasoning', id: 'rs_web', summary: [{ type: 'summary_text', text: 'Visible native reasoning' }], encrypted_content: opaque[0] },
      { type: 'message', id: opaque[1], role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'First native answer.', annotations: [] }] },
    ]);
    else expect(bodies[1].contents!.filter(message => message.role === 'model')).toEqual([{ role: 'model', parts: [
      { text: 'Visible native reasoning', thought: true, thoughtSignature: opaque[0] }, { text: 'First native answer.', thoughtSignature: opaque[1] },
    ] }]);
    await expect(page.locator('body')).not.toContainText('opaque-');
    for (const value of opaque) await expect(page.locator('body')).not.toContainText(value);
  } finally {
    await page.goto('about:blank').catch(() => undefined); await stop();
    wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve()));
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    await rm(root, { recursive: true, force: true });
  }
});

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
