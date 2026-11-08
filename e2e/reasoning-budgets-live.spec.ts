import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AnthropicProvider, GeminiProvider, VertexGeminiProvider, OpenAiMixedProvider, AzureProvider, BedrockProvider, MiniMaxProvider, MiniMaxCnProvider, SessionManager, JsonlSessionStore, resolveAgentCompactionContextWindow, prepareCompactionContext, getCompactionModelMessages, type AiProvider, SESSION_EXPORT_CONTINUATION_WARNING } from '../packages/core/dist/index.js';
import { bedrockFrame as frame } from '../tests/fixtures/bedrock-event-stream.js';
import { start, stop } from '../packages/server/dist/index.js';
import { createRuntimeServices } from '../packages/server/dist/runtime/services.js';
import { expect, test } from './fixtures/test-budget';

for (const dialect of ['anthropic', 'google', 'vertex', 'responses', 'azure-responses', 'bedrock', 'minimax', 'minimax-cn'] as const) test(`native signed ${dialect} blocks survive server restart, replay and guarded export`, async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-signed-web-'));
  const responses = dialect === 'responses' || dialect === 'azure-responses', bedrock = dialect === 'bedrock';
  const minimax = dialect === 'minimax' || dialect === 'minimax-cn', anthropic = dialect === 'anthropic' || minimax;
  const cwd = path.join(root, 'work'), dataDir = path.join(root, 'data'), model = minimax ? 'MiniMax-M2.7' : anthropic ? 'claude-sonnet-4-6' : bedrock ? 'anthropic.claude-opus-4-6-v1' : responses ? 'gpt-5' : 'gemini-3.8-flash';
  const opaque = bedrock ? ['opaque-[REDACTED]-tail', 'AP8BgAI='] : anthropic ? ['opaque-start-tail', 'opaque-redacted'] : responses ? ['opaque-reasoning', 'msg_opaque'] : ['b3BhcXVlLXJlYXNvbmluZw==', 'b3BhcXVlLXRleHQ='];
  const bedrockContent = (answer: string) => [{ reasoningContent: { reasoningText: { text: 'Visible native reasoning', signature: opaque[0] } } },
    { reasoningContent: { redactedContent: opaque[1] } }, { text: answer }];
  const names = ['AI_HARNESS_AUTH_TOKEN', 'AI_HARNESS_ADMIN_TOKEN', 'AI_HARNESS_AGENT_DIR'] as const;
  const previous = names.map(name => process.env[name]);
  process.env.AI_HARNESS_AUTH_TOKEN = 'mod-user'; process.env.AI_HARNESS_ADMIN_TOKEN = 'mod-admin';
  process.env.AI_HARNESS_AGENT_DIR = path.join(root, 'agent');
  let runtime!: Awaited<ReturnType<typeof createRuntimeServices>>, owner!: AiProvider;
  let policy: { window: number; settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number } } | undefined;
  const bodies: Array<{ messages?: Array<{ role: string; content: unknown }>; contents?: Array<{ role: string; parts: unknown }>; input?: Array<Record<string, unknown>>; [key: string]: unknown }> = [];
  const wires: Array<{ path?: string; authorization?: string }> = [];
  const wire = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(anthropic ? { data: [{ id: model }] } : { models: [{ name: `models/${model}` }] })); return;
    }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString())); wires.push({ path: request.url, authorization: request.headers.authorization });
    if (minimax) {
      expect(request.headers['x-api-key']).toBe('disposable-private-wire'); expect(request.headers['anthropic-version']).toBe('2023-06-01');
      expect(request.headers.authorization).toBeUndefined(); expect(bodies.at(-1)!.model).toBe(model);
    }
    const summary = JSON.stringify(bodies.at(-1)).includes('Summarize this conversation while preserving decisions and unresolved tasks.');
    const answer = summary ? 'PUBLIC_NATIVE_AUTO_SUMMARY' : bodies.length === 1 ? 'First native answer.' : 'Continued native answer.';
    const suffix = bodies.length === 1 ? '' : `_${bodies.length}`;
    if (bedrock) {
      response.setHeader('Content-Type', summary ? 'application/json' : 'application/vnd.amazon.eventstream');
      if (summary) response.end(JSON.stringify({ output: { message: { role: 'assistant', content: [
        { reasoningContent: { reasoningText: { text: 'Visible native reasoning', signature: 'opaque-disposable-private-wire-tail' } } }, ...bedrockContent(answer).slice(1),
      ] } }, stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }));
      else response.end(Buffer.concat([
        frame('messageStart', { role: 'assistant' }),
        frame('contentBlockDelta', { contentBlockIndex: 0, delta: { reasoningContent: { text: 'Visible native reasoning' } } }),
        frame('contentBlockDelta', { contentBlockIndex: 0, delta: { reasoningContent: { signature: 'opaque-' } } }),
        frame('contentBlockDelta', { contentBlockIndex: 0, delta: { reasoningContent: { signature: 'disposable-private-wire-tail' } } }),
        frame('contentBlockStop', { contentBlockIndex: 0 }),
        ...['AP8=', 'AYAC'].map(redactedContent => frame('contentBlockDelta', { contentBlockIndex: 1, delta: { reasoningContent: { redactedContent } } })),
        frame('contentBlockStop', { contentBlockIndex: 1 }),
        frame('contentBlockDelta', { contentBlockIndex: 2, delta: { text: answer } }), frame('contentBlockStop', { contentBlockIndex: 2 }),
        frame('messageStop', { stopReason: 'end_turn' }), frame('metadata', { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }),
      ]));
      return;
    }
    response.setHeader('Content-Type', summary && !responses ? 'application/json' : 'text/event-stream');
    if (responses) {
      response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: `resp_web${suffix}`, model: 'untrusted-alias', status: 'completed', output: [
        { type: 'reasoning', id: `rs_web${suffix}`, summary: [{ type: 'summary_text', text: 'Visible native reasoning' }], encrypted_content: opaque[0] },
        { type: 'message', id: opaque[1] + suffix, role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: answer, annotations: [] }] },
      ], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } })}\n\n`); return;
    }
    if (!anthropic) {
      const payload = { modelVersion: 'untrusted-alias', candidates: [{ content: { role: 'model', parts: [
        { text: 'Visible native reasoning', thought: true, thoughtSignature: opaque[0] }, { text: answer, thoughtSignature: opaque[1] },
      ] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } };
      response.end(summary ? JSON.stringify(payload) : `data: ${JSON.stringify(payload)}\n\n`);
      return;
    }
    if (summary) {
      response.end(JSON.stringify({ model: 'untrusted-alias', content: [
        { type: 'thinking', thinking: 'Visible native reasoning', signature: opaque[0] },
        { type: 'redacted_thinking', data: opaque[1] }, { type: 'text', text: answer },
      ], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 } })); return;
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
        owner = minimax ? new (dialect === 'minimax-cn' ? MiniMaxCnProvider : MiniMaxProvider)({ ...config, type: dialect })
          : anthropic ? new AnthropicProvider({ ...config, type: 'native-signed' })
          : bedrock ? new BedrockProvider({ ...config, type: 'bedrock' }) : dialect === 'google' ? new GeminiProvider({ ...config, type: 'google' }) : dialect === 'vertex' ? new VertexGeminiProvider({ ...config, type: 'vertex' })
            : dialect === 'responses' ? new OpenAiMixedProvider({ ...config, type: 'openai', transport: 'sse' }) : new AzureProvider({ ...config, type: 'azure' });
        proxy.setCustomProvider('native-signed', owner); runtime = services;
        if (policy) { services.sessionManager.setCompactionSettings(policy.settings); services.sessionManager.setCompactionContextWindow(policy.window); }
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
      let lastRun: { phase?: string } | undefined;
      await expect.poll(async () => {
        lastRun = await page.request.get(`${base}/api/agent/runs/${result.run.id}`).then(response => response.json()); return lastRun?.phase;
      }).toBe('completed').catch(error => {
        console.error('Native signed run failed.', JSON.stringify({ dialect, lastRun, bodies, wires })); throw error;
      });
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
    expect(completeText).not.toContain('disposable-private-wire');
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
    if (anthropic) expect(bodies[1].messages!.filter(message => message.role === 'assistant')).toEqual([{ role: 'assistant', content: [
      { type: 'thinking', thinking: 'Visible native reasoning', signature: 'opaque-start-tail' },
      { type: 'redacted_thinking', data: 'opaque-redacted' }, { type: 'text', text: 'First native answer.' },
    ] }]);
    else if (bedrock) expect(bodies[1].messages!.filter(message => message.role === 'assistant'))
      .toEqual([{ role: 'assistant', content: bedrockContent('First native answer.') }]);
    else if (responses) expect(bodies[1].input!.filter(item => item.type === 'reasoning' || item.role === 'assistant')).toEqual([
      { type: 'reasoning', id: 'rs_web', summary: [{ type: 'summary_text', text: 'Visible native reasoning' }], encrypted_content: opaque[0] },
      { type: 'message', id: opaque[1], role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'First native answer.', annotations: [] }] },
    ]);
    else expect(bodies[1].contents!.filter(message => message.role === 'model')).toEqual([{ role: 'model', parts: [
      { text: 'Visible native reasoning', thought: true, thoughtSignature: opaque[0] }, { text: 'First native answer.', thoughtSignature: opaque[1] },
    ] }]);
    await expect(page.locator('body')).not.toContainText('opaque-');
    for (const value of opaque) await expect(page.locator('body')).not.toContainText(value);
    const manager = runtime.sessionManager, id = first.session.id, window = resolveAgentCompactionContextWindow('native-signed', model, owner);
    expect(window).toBeGreaterThan(10_000);
    policy = { window: window!, settings: { enabled: true, reserveTokens: window! - 10_000, keepRecentTokens: 512 } };
    manager.setCompactionSettings(policy.settings); manager.setCompactionContextWindow(window);
    await manager.update(id, { autoCompaction: true });
    const events: string[] = [];
    manager.on('compaction:start', event => { expect(event.automatic).toBe(true); events.push('start'); });
    manager.on('compaction:end', event => { expect(event.automatic).toBe(true); events.push('end'); });
    await send('Below native automatic threshold'); expect(bodies).toHaveLength(3); expect(events).toEqual([]);
    expect(manager.estimateContextTokens(id)).toBeLessThan(10_000);
    const sourceMessages = getCompactionModelMessages(manager, id), assistants = sourceMessages.filter(message => message.role === 'assistant');
    expect(assistants).toHaveLength(3);
    if (bedrock || minimax) expect(assistants.map(message => ({ provider: message.provider, api: message.api, model: message.model })))
      .toEqual(Array(3).fill({ provider: dialect, api: minimax ? 'anthropic-messages' : 'bedrock-converse-stream', model }));
    const target = sourceMessages.filter(message => message.role === 'user')[1];
    expect(await manager.appendContextEdit(id, { targetEntryId: target.id, replacement: 'PUBLIC_SERVER_AUTO_FILLER ' + 'x'.repeat(60_000) })).toBeTruthy();
    expect(manager.estimateContextTokens(id)).toBeGreaterThan(10_000);
    const prepared = prepareCompactionContext(manager, id, 'threshold'); expect(prepared).toBeTruthy();
    expect(JSON.stringify(prepared!.toCompact)).toContain('Visible native reasoning');
    const retainedTurns = prepared!.keptMessages.filter(message => message.role === 'assistant').map(message => assistants.findIndex(value => value.id === message.id) + 1);
    expect(retainedTurns).not.toContain(1); expect(retainedTurns.at(-1)).toBe(3);
    const native = (body: typeof bodies[number]) => responses ? body.input!.filter(item => item.type === 'reasoning' || item.role === 'assistant')
      : anthropic || bedrock ? body.messages!.filter(item => item.role === 'assistant').map(item => item.content) : body.contents!.filter(item => item.role === 'model').map(item => item.parts);
    const expectedNative = (turns: number[]) => responses ? turns.flatMap(turn => [
      { type: 'reasoning', id: `rs_web_${turn}`, summary: [{ type: 'summary_text', text: 'Visible native reasoning' }], encrypted_content: opaque[0] },
      { type: 'message', id: `${opaque[1]}_${turn}`, role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'Continued native answer.', annotations: [] }] },
    ]) : turns.map(() => bedrock ? bedrockContent('Continued native answer.') : anthropic ? [
      { type: 'thinking', thinking: 'Visible native reasoning', signature: opaque[0] }, { type: 'redacted_thinking', data: opaque[1] }, { type: 'text', text: 'Continued native answer.' },
    ] : [{ text: 'Visible native reasoning', thought: true, thoughtSignature: opaque[0] }, { text: 'Continued native answer.', thoughtSignature: opaque[1] }]);
    expect(native(bodies[2])).toEqual([...native(bodies[1]), ...expectedNative([2])]);
    const rawBefore = await manager.getRawEntries(id);
    await send('Trigger native automatic summary'); expect(bodies).toHaveLength(5); expect(events).toEqual(['start', 'end']);
    const summaryBody = bodies[3], summaryWire = JSON.stringify(summaryBody);
    expect(summaryWire).toContain('First native answer.'); expect(summaryWire).toContain('PUBLIC_SERVER_AUTO_FILLER');
    for (const value of [...opaque, 'Visible native reasoning', 'thinkingSignature', 'textSignature']) expect(summaryWire).not.toContain(value);
    expect(summaryBody.tools ?? []).toEqual([]); if (bedrock) expect(summaryBody.toolConfig).toBeUndefined();
    expect(responses ? summaryBody.max_output_tokens : anthropic ? summaryBody.max_tokens : bedrock ? (summaryBody.inferenceConfig as { maxTokens: number }).maxTokens : (summaryBody.generationConfig as { maxOutputTokens: number }).maxOutputTokens).toBe(4096);
    expect(native(bodies[4])).toEqual(expectedNative(retainedTurns));
    expect(JSON.stringify(bodies[4])).toContain('PUBLIC_NATIVE_AUTO_SUMMARY'); expect(JSON.stringify(bodies[4])).not.toContain('PUBLIC_SERVER_AUTO_FILLER');
    const rawAfter = await manager.getRawEntries(id), compactions = rawAfter.filter(entry => entry.type === 'compaction'); expect(compactions).toHaveLength(1);
    const compacted = compactions[0]; expect(compacted.summary).toBe('PUBLIC_NATIVE_AUTO_SUMMARY'); expect(compacted.firstKeptEntryId).toBe(prepared!.firstKeptEntryId);
    expect(compacted.provider).toBe(assistants[0].provider); expect(compacted.model).toBe(model);
    expect(compacted.usage).toMatchObject({ inputTokens: 5, outputTokens: 2, totalTokens: 7 });
    for (const value of [...opaque, 'Visible native reasoning']) expect(JSON.stringify(compacted)).not.toContain(value);
    for (const entry of rawBefore.filter(entry => entry.type !== 'metadata')) expect(rawAfter.find(value => value.id === entry.id)).toEqual(entry);
    const canonical = getCompactionModelMessages(manager, id), reloaded = new SessionManager({ store: new JsonlSessionStore(path.join(dataDir, 'sessions')) });
    expect(await reloaded.loadFromStore(id)).toBeTruthy(); expect(getCompactionModelMessages(reloaded, id)).toEqual(canonical);
    expect((await stat(file)).mode & 0o777).toBe(0o600); expect(await readFile(file, 'utf8')).not.toContain('disposable-private-wire');
    await page.goto('about:blank'); await stop(); await start({ ...options, port: server.port }); await login(); await page.goto(settingsUrl);
    expect(bodies).toHaveLength(5); expect(getCompactionModelMessages(runtime.sessionManager, id)).toEqual(canonical);
    await page.getByRole('combobox', { name: 'Select the AI Provider', exact: true }).selectOption('native-signed');
    await page.locator(`a.session-main[href*="${id}"]`).click(); await send('Replay compacted native context after restart');
    expect(bodies).toHaveLength(6); expect(native(bodies[5])).toEqual(expectedNative([...retainedTurns, 5]));
    if (bedrock) expect(wires).toEqual(Array.from({ length: 6 }, (_, index) => ({
      path: `/model/${encodeURIComponent(model)}/${index === 3 ? 'converse' : 'converse-stream'}`, authorization: 'Bearer disposable-private-wire',
    })));
    if (minimax) expect(wires).toEqual(Array(6).fill({ path: '/v1/messages', authorization: undefined }));
    expect(JSON.stringify(bodies[5])).toContain('PUBLIC_NATIVE_AUTO_SUMMARY'); expect(JSON.stringify(bodies[5])).not.toContain('PUBLIC_SERVER_AUTO_FILLER');
    const finalEntries = await runtime.sessionManager.getRawEntries(id);
    expect(finalEntries.filter(entry => entry.type === 'compaction')).toEqual(compactions);
    for (const entry of rawAfter.filter(entry => entry.type !== 'metadata')) expect(finalEntries.find(value => value.id === entry.id)).toEqual(entry);
    await expect(page.locator('.message.assistant').last()).toContainText('Continued native answer.');
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
