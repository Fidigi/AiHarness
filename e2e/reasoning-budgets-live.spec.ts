import { createServer } from 'node:http';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AnthropicProvider, GeminiProvider, VertexGeminiProvider, OpenAiMixedProvider, AzureProvider, BedrockProvider, MiniMaxProvider, MiniMaxCnProvider, SessionManager, JsonlSessionStore, resolveAgentCompactionContextWindow, prepareCompactionContext, getCompactionModelMessages, type AiProvider, SESSION_EXPORT_CONTINUATION_WARNING } from '../packages/core/dist/index.js';
import { bedrockFrame as frame } from '../tests/fixtures/bedrock-event-stream.js';
import { start, stop } from '../packages/server/dist/index.js';
import { createRuntimeServices } from '../packages/server/dist/runtime/services.js';
import { expect, test } from './fixtures/test-budget';
import { closeSettings } from './fixtures/settings-navigation';

for (const dialect of ['anthropic', 'google', 'vertex', 'responses', 'azure-responses', 'bedrock', 'minimax', 'minimax-cn'] as const)
for (const selectedModel of dialect === 'minimax' || dialect === 'minimax-cn' ? [undefined, 'MiniMax-M2.7-highspeed', 'MiniMax-M3'] : [undefined])
test(`native signed ${dialect}${selectedModel ? `/${selectedModel}` : ''} blocks survive server restart, replay and guarded export`, async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-signed-web-'));
  const responses = dialect === 'responses' || dialect === 'azure-responses', bedrock = dialect === 'bedrock';
  const minimax = dialect === 'minimax' || dialect === 'minimax-cn', anthropic = dialect === 'anthropic' || minimax;
  const cwd = path.join(root, 'work'), dataDir = path.join(root, 'data'), model = minimax ? selectedModel ?? 'MiniMax-M2.7' : anthropic ? 'claude-sonnet-4-6' : bedrock ? 'anthropic.claude-opus-4-6-v1' : responses ? 'gpt-5' : 'gemini-3.8-flash';
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
  const cancelMarker = 'PUBLIC_SERVER_WITHDRAWAL_ACK', resetMarker = 'PUBLIC_SERVER_TRANSPORT_RESET_BOUNDARY';
  const failedText = 'PUBLIC_SERVER_FAILED_PREFIX ' + 'x'.repeat(256), failedReasoning = 'PUBLIC_SERVER_FAILED_REASONING ' + 'y'.repeat(256);
  let nativeFailure: 'error' | 'withdraw' | 'eof' | 'reset' | undefined, heldClosed: Promise<void> | undefined, peerClosed = false, resetPeer: (() => void) | undefined;
  let publishTool = false, effects = 0, overflowRemaining = 0;
  let overflowSession: string | undefined, overflowCut: ReturnType<SessionManager['requestCompaction']> | undefined, recoverySummary: string | undefined;
  const overflowPrivate = 'PRIVATE_SERVER_OVERFLOW_DIAGNOSTIC';
  const effectFile = path.join(root, 'native-effects.jsonl'), effectTool = 'server_native_effect', toolCallId = 'server-native-tool';
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
      if (overflowRemaining > 0 && !JSON.stringify(bodies.at(-1)).includes('Summarize this conversation while preserving decisions and unresolved tasks.')) {
        overflowRemaining--; if (overflowCut === undefined) overflowCut = runtime.sessionManager.requestCompaction(overflowSession!, 'overflow');
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'context_length_exceeded', message: `${overflowPrivate} disposable-private-wire` } })); return;
      }
      if (nativeFailure) {
        const failure = nativeFailure; nativeFailure = undefined;
        const events = [
          { type: 'message_start', message: { model: 'untrusted-alias', usage: { input_tokens: 5, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: failedReasoning, signature: 'WITHHELD_SIGNATURE_disposable-private-wire' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'WITHHELD_REDACTED_DATA' } },
          { type: 'content_block_stop', index: 1 },
          { type: 'content_block_start', index: 2, content_block: { type: 'text', text: failure === 'withdraw' ? cancelMarker + '!'.repeat(1024)
            : failure === 'reset' ? resetMarker + ' ' + failedText : failedText } },
          { type: 'content_block_stop', index: 2 },
          { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'unpublished-server-call', name: effectTool, input: { value: 42 } } },
          { type: 'content_block_stop', index: 3 },
        ];
        response.setHeader('Content-Type', 'text/event-stream');
        if (failure === 'withdraw' || failure === 'reset') {
          heldClosed = new Promise<void>(resolve => response.once('close', () => { peerClosed = true; resolve(); }));
          if (failure === 'reset') { const socket = response.socket; expect(socket).not.toBeNull(); resetPeer = () => socket!.resetAndDestroy(); }
          response.write(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
        } else response.end((failure === 'error' ? [...events, { type: 'error', error: { type: 'api_error', message: 'PRIVATE_SERVER_PROVIDER_ERROR' } }] : events)
          .map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
        return;
      }
    }
    const manualSummary = minimax && JSON.stringify(bodies.at(-1)).includes('PUBLIC_SERVER_MANUAL_SUMMARY_INSTRUCTION');
    const summary = manualSummary || JSON.stringify(bodies.at(-1)).includes('Summarize this conversation while preserving decisions and unresolved tasks.');
    const answer = manualSummary ? 'PUBLIC_NATIVE_MANUAL_SUMMARY' : summary ? recoverySummary ?? 'PUBLIC_NATIVE_AUTO_SUMMARY' : bodies.length === 1 ? 'First native answer.' : 'Continued native answer.';
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
    const tool = minimax && publishTool; publishTool = false;
    response.end([
      { type: 'message_start', message: { model: 'untrusted-alias', usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'Visible native reasoning', signature: 'opaque-start-' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'tail' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'opaque-redacted' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: answer } },
      { type: 'content_block_stop', index: 2 },
      ...(tool ? [{ type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: toolCallId, name: effectTool, input: { value: 42 } } },
        { type: 'content_block_stop', index: 3 }] : []),
      { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' },
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
        if (minimax) await services.extensionRegistry.load('server-native-effect', api => api.registerTool({ name: effectTool, description: 'Record one native effect',
          parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
          execute: async (input, context) => {
            // Record every invocation before validating it, including a wrongly admitted pending call.
            effects++; await appendFile(effectFile, JSON.stringify({ sessionId: context.currentSessionId, input }) + '\n', { mode: 0o600 });
            expect(input).toEqual({ value: 42 }); expect(context.currentSessionId).toBeTruthy(); expect(context.toolCallId).toBe(toolCallId);
            return { content: 'PUBLIC_SERVER_TOOL_RESULT' };
          } }));
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
    const settingsUrl = `${base}/settings?cwd=${encodeURIComponent(cwd)}#providers`;
    await page.goto(settingsUrl);
    await page.getByRole('combobox', { name: 'Select the AI Provider', exact: true }).selectOption('native-signed');
    await closeSettings(page);
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    const send = async (text: string, expectedPhase: 'completed' | 'failed' | 'stopped' = 'completed', reset = false) => {
      await page.getByRole('textbox', { name: 'Message composer' }).fill(text);
      const accepted = page.waitForResponse(response => response.url().endsWith('/api/agent/runs') && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const result = await (await accepted).json();
      if (expectedPhase === 'stopped') {
        await expect(page.locator('body')).toContainText(cancelMarker);
        const acknowledged = page.waitForResponse(response => response.url().endsWith(`/api/agent/runs/${result.run.id}/stop`) && response.request().method() === 'POST');
        await page.getByRole('button', { name: 'Stop model', exact: true }).click();
        const response = await acknowledged; expect(response.status()).toBe(202);
        expect(await response.json()).toMatchObject({ id: result.run.id });
      }
      if (reset) {
        await expect(page.locator('body')).toContainText(resetMarker); expect(resetPeer).toBeDefined(); resetPeer!(); resetPeer = undefined;
      }
      let lastRun: { phase?: string } | undefined;
      await expect.poll(async () => {
        lastRun = await page.request.get(`${base}/api/agent/runs/${result.run.id}`).then(response => response.json()); return lastRun?.phase;
      }).toBe(expectedPhase).catch(error => {
        console.error('Native signed run failed.', JSON.stringify({ dialect, lastRun, bodies, wires })); throw error;
      });
      return { ...result, settled: lastRun };
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
    await closeSettings(page);
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
    await closeSettings(page);
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
    if (minimax) {
      expect((await page.request.patch(`${base}/api/configuration/scope`, { data: { scope: 'global', values: { enabledTools: [effectTool] } } })).status()).toBe(200);
      const configured = page.waitForResponse(response => response.url().endsWith(`/api/sessions/${id}`) && response.request().method() === 'PATCH');
      await page.getByRole('combobox', { name: 'Tool preset', exact: true }).selectOption('configured'); expect((await configured).status()).toBe(200);
      await expect(page.getByRole('combobox', { name: 'Tool preset', exact: true })).toHaveValue('configured');
      const assistants = (entries: Awaited<ReturnType<typeof manager.getRawEntries>>) => entries.filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant');
      const validTurns = [...retainedTurns, 5, 6];
      nativeFailure = 'error'; const failedRun = await send('Publish only the failed public prefix', 'failed');
      for (const value of ['WITHHELD_SIGNATURE', 'WITHHELD_REDACTED_DATA', 'PRIVATE_SERVER_PROVIDER_ERROR', 'disposable-private-wire']) {
        expect(JSON.stringify(failedRun.settled)).not.toContain(value); await expect(page.locator('body')).not.toContainText(value);
      }
      expect(nativeFailure).toBeUndefined(); expect(bodies).toHaveLength(7);
      expect(native(bodies[6])).toEqual(expectedNative(validTurns));
      const afterFailure = await runtime.sessionManager.getRawEntries(id), failed = assistants(afterFailure).at(-1)!;
      expect(assistants(afterFailure)).toHaveLength(assistants(finalEntries).length + 1);
      // Failed public diagnostics retain the host route, not a private replay-owner grant.
      expect(failed).toMatchObject({ provider: 'native-signed', model, metadata: { outputError: 'Invalid MiniMax chat response.' } });
      expect(failed.api).toBeUndefined(); expect(failed.usage).toBeUndefined(); expect(failed.toolCalls ?? []).toEqual([]);
      expect(failed.content.length).toBeGreaterThan(30); expect(failedText.startsWith(failed.content)).toBe(true);
      const reasoning = failed.blocks?.find(block => block.type === 'reasoning');
      expect(reasoning?.text.length).toBeGreaterThan(30); expect(failedReasoning.startsWith(reasoning!.text)).toBe(true);
      expect(failed.blocks).toEqual([{ type: 'reasoning', text: reasoning!.text }, { type: 'text', text: failed.content }]);
      for (const entry of finalEntries.filter(entry => entry.type !== 'metadata')) expect(afterFailure.find(value => value.id === entry.id)).toEqual(entry);
      const restart = async (sessionId = id) => {
        const canonical = getCompactionModelMessages(runtime.sessionManager, sessionId);
        await page.goto('about:blank'); await stop(); await start({ ...options, port: server.port }); await login(); await page.goto(settingsUrl);
        expect(getCompactionModelMessages(runtime.sessionManager, sessionId)).toEqual(canonical);
        await page.getByRole('combobox', { name: 'Select the AI Provider', exact: true }).selectOption('native-signed');
        await closeSettings(page);
        await page.locator(`a.session-main[href*="${sessionId}"]`).click();
      };
      await restart(); expect(bodies).toHaveLength(7);
      await send('Recover after failed native publication'); expect(bodies).toHaveLength(8);
      expect(native(bodies[7])).toEqual(expectedNative(validTurns)); expect(JSON.stringify(bodies[7])).not.toContain('PUBLIC_SERVER_FAILED_');
      const beforeWithdrawal = await runtime.sessionManager.getRawEntries(id);
      nativeFailure = 'withdraw'; const withdrawnRun = await send('Withdraw held private native output', 'stopped');
      for (const value of ['WITHHELD_SIGNATURE', 'WITHHELD_REDACTED_DATA', 'disposable-private-wire']) {
        expect(JSON.stringify(withdrawnRun.settled)).not.toContain(value); await expect(page.locator('body')).not.toContainText(value);
      }
      expect(nativeFailure).toBeUndefined(); expect(bodies).toHaveLength(9); expect(heldClosed).toBeDefined();
      await expect.poll(() => peerClosed).toBe(true); await heldClosed;
      expect(native(bodies[8])).toEqual(expectedNative([...validTurns, 8]));
      const afterWithdrawal = await runtime.sessionManager.getRawEntries(id);
      expect(assistants(afterWithdrawal)).toEqual(assistants(beforeWithdrawal));
      for (const entry of beforeWithdrawal.filter(entry => entry.type !== 'metadata')) expect(afterWithdrawal.find(value => value.id === entry.id)).toEqual(entry);
      const fresh = new SessionManager({ store: new JsonlSessionStore(path.join(dataDir, 'sessions')) });
      expect(await fresh.loadFromStore(id)).toBeTruthy(); expect(assistants(await fresh.getRawEntries(id))).toEqual(assistants(afterWithdrawal));
      await restart(); expect(bodies).toHaveLength(9);
      await send('Recover after settled native withdrawal'); expect(bodies).toHaveLength(10);
      expect(native(bodies[9])).toEqual(expectedNative([...validTurns, 8]));
      const final = await runtime.sessionManager.getRawEntries(id);
      expect(assistants(final).slice(0, -1)).toEqual(assistants(afterWithdrawal));
      expect(final.filter(entry => entry.type === 'compaction')).toEqual(compactions);
      expect(wires).toEqual(Array(10).fill({ path: '/v1/messages', authorization: undefined }));
      for (const value of ['WITHHELD_SIGNATURE', 'WITHHELD_REDACTED_DATA', 'PRIVATE_SERVER_PROVIDER_ERROR', cancelMarker, 'disposable-private-wire']) {
        expect(await readFile(file, 'utf8')).not.toContain(value); expect(JSON.stringify(bodies.slice(7))).not.toContain(value);
        await expect(page.locator('body')).not.toContainText(value);
      }
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      const successfulTurns = [...validTurns, 8, 10];
      for (const failure of ['eof', 'reset'] as const) {
        const turn = bodies.length, beforeInterrupted = await runtime.sessionManager.getRawEntries(id);
        nativeFailure = failure; peerClosed = false; heldClosed = undefined;
        const interrupted = await send(`Fail native output by ${failure}`, 'failed', failure === 'reset');
        expect(nativeFailure).toBeUndefined(); expect(bodies).toHaveLength(turn + 1);
        expect(native(bodies[turn])).toEqual(expectedNative(successfulTurns));
        if (failure === 'reset') { expect(heldClosed).toBeDefined(); await expect.poll(() => peerClosed).toBe(true); await heldClosed; }
        const afterInterrupted = await runtime.sessionManager.getRawEntries(id), prefix = assistants(afterInterrupted).at(-1)!;
        expect(assistants(afterInterrupted).slice(0, -1)).toEqual(assistants(beforeInterrupted));
        expect(prefix).toMatchObject({ provider: 'native-signed', model,
          metadata: { outputError: 'MiniMax chat request failed.' } });
        expect(prefix.api).toBeUndefined(); expect(prefix.usage).toBeUndefined(); expect(prefix.toolCalls ?? []).toEqual([]);
        expect(prefix.content.length).toBeGreaterThan(30); expect((failure === 'reset' ? resetMarker + ' ' + failedText : failedText).startsWith(prefix.content)).toBe(true);
        const thought = prefix.blocks?.find(block => block.type === 'reasoning');
        expect(thought?.text.length).toBeGreaterThan(30); expect(failedReasoning.startsWith(thought!.text)).toBe(true);
        expect(prefix.blocks).toEqual([{ type: 'reasoning', text: thought!.text }, { type: 'text', text: prefix.content }]);
        for (const entry of beforeInterrupted.filter(entry => entry.type !== 'metadata')) expect(afterInterrupted.find(value => value.id === entry.id)).toEqual(entry);
        const disk = new SessionManager({ store: new JsonlSessionStore(path.join(dataDir, 'sessions')) });
        expect(await disk.loadFromStore(id)).toBeTruthy();
        expect((await disk.getRawEntries(id)).filter(entry => entry.type !== 'metadata')).toEqual(afterInterrupted.filter(entry => entry.type !== 'metadata'));
        expect(getCompactionModelMessages(disk, id)).toEqual(getCompactionModelMessages(runtime.sessionManager, id));
        for (const value of ['WITHHELD_SIGNATURE', 'WITHHELD_REDACTED_DATA', 'PRIVATE_SERVER_PROVIDER_ERROR', 'disposable-private-wire']) {
          expect(JSON.stringify(interrupted.settled)).not.toContain(value); expect(await readFile(file, 'utf8')).not.toContain(value);
          await expect(page.locator('body')).not.toContainText(value);
        }
        await restart(); expect(bodies).toHaveLength(turn + 1);
        await send(`Recover native output after ${failure}`); expect(bodies).toHaveLength(turn + 2);
        expect(native(bodies[turn + 1])).toEqual(expectedNative(successfulTurns));
        expect(JSON.stringify(bodies[turn + 1])).not.toContain('PUBLIC_SERVER_FAILED_'); expect(JSON.stringify(bodies[turn + 1])).not.toContain(resetMarker);
        const recovered = await runtime.sessionManager.getRawEntries(id);
        expect(assistants(recovered).slice(0, -1)).toEqual(assistants(afterInterrupted)); expect(recovered.filter(entry => entry.type === 'compaction')).toEqual(compactions);
        for (const entry of afterInterrupted.filter(entry => entry.type !== 'metadata')) expect(recovered.find(value => value.id === entry.id)).toEqual(entry);
        expect((await stat(file)).mode & 0o777).toBe(0o600); successfulTurns.push(turn + 2);
      }
      expect(bodies).toHaveLength(14); expect(wires).toEqual(Array(14).fill({ path: '/v1/messages', authorization: undefined }));
      const beforeManual = await runtime.sessionManager.getRawEntries(id), beforeManualContext = getCompactionModelMessages(runtime.sessionManager, id);
      const successfulMessages = beforeManualContext.filter(message => message.role === 'assistant' && message.api === 'anthropic-messages');
      expect(successfulMessages).toHaveLength(successfulTurns.length);
      const turnById = new Map(successfulMessages.map((message, index) => [message.id, successfulTurns[index]]));
      const manualPrepared = prepareCompactionContext(runtime.sessionManager, id); expect(manualPrepared).toBeTruthy();
      const keptTurns = manualPrepared!.keptMessages.flatMap(message => { const turn = turnById.get(message.id); return turn === undefined ? [] : [turn]; });
      expect(keptTurns.at(-1)).toBe(14);
      const compactResponse = await page.request.post(`${base}/api/agent/sessions/${id}/compact`, {
        data: { provider: 'native-signed', model, instruction: 'PUBLIC_SERVER_MANUAL_SUMMARY_INSTRUCTION' },
      });
      expect(compactResponse.status()).toBe(200); const compactResult = await compactResponse.json();
      expect(compactResult.summary).toBe('PUBLIC_NATIVE_MANUAL_SUMMARY'); expect(bodies).toHaveLength(15);
      expect(bodies[14]).toMatchObject({ model, max_tokens: 4096, thinking: { type: 'disabled' } }); expect(bodies[14].tools ?? []).toEqual([]);
      expect(JSON.stringify(bodies[14])).toContain('Continued native answer.'); expect(JSON.stringify(bodies[14])).toContain('PUBLIC_SERVER_MANUAL_SUMMARY_INSTRUCTION');
      expect(JSON.stringify(bodies[14])).not.toContain('Visible native reasoning');
      for (const value of [...opaque, 'WITHHELD_SIGNATURE', 'WITHHELD_REDACTED_DATA', 'PRIVATE_SERVER_PROVIDER_ERROR', 'disposable-private-wire']) {
        expect(JSON.stringify(bodies[14])).not.toContain(value); expect(JSON.stringify({ summary: compactResult.summary, metadata: compactResult.session.metadata })).not.toContain(value);
      }
      // Authenticated session snapshots retain native blocks; summary projection and default export do not.
      expect(JSON.stringify(compactResult)).not.toContain('disposable-private-wire');
      expect(compactResult.session.messages.map((message: { blocks?: unknown }) => message.blocks))
        .toEqual(runtime.sessionManager.get(id)!.messages.map(message => message.blocks));
      const afterManual = await runtime.sessionManager.getRawEntries(id), manualCompactions = afterManual.filter(entry => entry.type === 'compaction');
      expect(manualCompactions).toHaveLength(2); expect(manualCompactions.slice(0, -1)).toEqual(compactions);
      expect(manualCompactions.at(-1)).toMatchObject({ summary: 'PUBLIC_NATIVE_MANUAL_SUMMARY', provider: dialect, model,
        firstKeptEntryId: manualPrepared!.firstKeptEntryId, usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } });
      for (const value of [...opaque, 'Visible native reasoning', 'disposable-private-wire']) expect(JSON.stringify(manualCompactions.at(-1))).not.toContain(value);
      expect(assistants(afterManual)).toEqual(assistants(beforeManual));
      for (const entry of beforeManual.filter(entry => entry.type !== 'metadata')) expect(afterManual.find(value => value.id === entry.id)).toEqual(entry);
      const manualDisk = new SessionManager({ store: new JsonlSessionStore(path.join(dataDir, 'sessions')) });
      expect(await manualDisk.loadFromStore(id)).toBeTruthy(); expect(getCompactionModelMessages(manualDisk, id)).toEqual(getCompactionModelMessages(runtime.sessionManager, id));
      await restart(); expect(bodies).toHaveLength(15); await send('Replay the manually compacted native context'); expect(bodies).toHaveLength(16);
      expect(native(bodies[15])).toEqual(expectedNative(keptTurns)); expect(JSON.stringify(bodies[15])).toContain('PUBLIC_NATIVE_MANUAL_SUMMARY');
      expect(JSON.stringify(bodies[15])).not.toContain('PUBLIC_SERVER_FAILED_'); expect(JSON.stringify(bodies[15])).not.toContain(resetMarker);
      const sourceBeforeFork = await runtime.sessionManager.getRawEntries(id), sourceContext = getCompactionModelMessages(runtime.sessionManager, id), sourceBytes = await readFile(file, 'utf8');
      const sourceMessages = runtime.sessionManager.get(id)!.messages;
      // Forks copy the current model projection and rich structural ancestors, not discarded messages.
      const copiedIds = new Set([...sourceMessages.map(message => message.id), ...sourceBeforeFork.filter(entry => entry.type !== 'metadata' && entry.type !== 'message').map(entry => entry.id)]);
      const sourceParents = new Map(sourceBeforeFork.filter(entry => entry.type !== 'metadata').map(entry => [entry.id, entry.type === 'message' ? entry.parentMessageId : entry.parentEntryId]));
      const copiedParent = (parent: string | undefined) => { while (parent && !copiedIds.has(parent)) parent = sourceParents.get(parent); return parent; };
      const copiedCompactions = manualCompactions.map(entry => ({ ...entry, parentEntryId: copiedParent(entry.parentEntryId),
        firstKeptEntryId: copiedIds.has(entry.firstKeptEntryId) ? entry.firstKeptEntryId : sourceMessages[0].id }));
      const forkResponse = await page.request.post(`${base}/api/sessions/${id}/fork`, { data: { title: 'Private native fork' } });
      expect(forkResponse.status()).toBe(201); const fork = await forkResponse.json();
      expect(fork.id).not.toBe(id); expect(fork).toMatchObject({ parentId: id, branchId: runtime.sessionManager.get(id)!.branchId ?? id });
      expect(bodies).toHaveLength(16); expect(await readFile(file, 'utf8')).toBe(sourceBytes);
      for (const value of [...opaque, 'disposable-private-wire']) expect(JSON.stringify(fork.metadata)).not.toContain(value);
      expect(JSON.stringify(fork)).not.toContain('disposable-private-wire');
      expect(fork.messages.map((message: { blocks?: unknown }) => message.blocks)).toEqual(runtime.sessionManager.get(id)!.messages.map(message => message.blocks));
      const forkFile = path.join(dataDir, 'sessions', fork.id + '.jsonl'), forkDisk = new SessionManager({ store: new JsonlSessionStore(path.join(dataDir, 'sessions')) });
      expect(await forkDisk.loadFromStore(fork.id)).toBeTruthy();
      expect(getCompactionModelMessages(forkDisk, fork.id)).toEqual(sourceContext.map(message => ({ ...message, parentMessageId: copiedParent(message.parentMessageId) })));
      const forkEntries = await forkDisk.getRawEntries(fork.id); expect(assistants(forkEntries).map(entry => entry.blocks)).toEqual(sourceMessages.filter(message => message.role === 'assistant').map(message => message.blocks));
      expect(forkEntries.filter(entry => entry.type === 'compaction')).toEqual(copiedCompactions);
      for (const value of opaque) expect(await readFile(forkFile, 'utf8')).toContain(value);
      await page.goto(settingsUrl); await page.getByRole('combobox', { name: 'Select the AI Provider', exact: true }).selectOption('native-signed');
      await closeSettings(page);
      await page.locator(`a.session-main[href*="${fork.id}"]`).click(); const forkRun = await send('Continue the private native fork');
      expect(forkRun.session.id).toBe(fork.id); expect(bodies).toHaveLength(17); expect(native(bodies[16])).toEqual(expectedNative([...keptTurns, 16]));
      const beforeForkRestart = await runtime.sessionManager.getRawEntries(fork.id);
      for (const entry of forkEntries.filter(entry => entry.type !== 'metadata')) expect(beforeForkRestart.find(value => value.id === entry.id)).toEqual(entry);
      expect(beforeForkRestart.filter(entry => entry.type === 'compaction')).toEqual(copiedCompactions);
      await restart(fork.id); expect(bodies).toHaveLength(17); const forkRestart = await send('Reload and continue the private native fork');
      expect(forkRestart.session.id).toBe(fork.id); expect(bodies).toHaveLength(18); expect(native(bodies[17])).toEqual(expectedNative([...keptTurns, 16, 17]));
      expect(JSON.stringify(bodies[17])).toContain('PUBLIC_NATIVE_MANUAL_SUMMARY'); expect(await readFile(file, 'utf8')).toBe(sourceBytes);
      const forkAfterRestart = await runtime.sessionManager.getRawEntries(fork.id);
      for (const entry of beforeForkRestart.filter(entry => entry.type !== 'metadata')) expect(forkAfterRestart.find(value => value.id === entry.id)).toEqual(entry);
      expect(forkAfterRestart.filter(entry => entry.type === 'compaction')).toEqual(copiedCompactions);
      for (const value of [...opaque, 'disposable-private-wire']) await expect(page.locator('body')).not.toContainText(value);
      for (const journal of [file, forkFile]) { expect((await stat(journal)).mode & 0o777).toBe(0o600); expect(await readFile(journal, 'utf8')).not.toContain('disposable-private-wire'); }
      expect(wires).toEqual(Array(18).fill({ path: '/v1/messages', authorization: undefined }));
      expect(effects).toBe(0); await expect(readFile(effectFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      for (const turn of [7, 9, 11, 13]) expect(bodies[turn - 1].tools).toEqual([{ name: effectTool, description: 'Record one native effect',
        input_schema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] }, eager_input_streaming: true,
        cache_control: { type: 'ephemeral' } }]);
      publishTool = true; const toolRun = await send('Execute one native effect'); expect(toolRun.session.id).toBe(fork.id);
      expect(publishTool).toBe(false); expect(effects).toBe(1); expect(bodies).toHaveLength(20);
      expect(native(bodies[18])).toEqual(expectedNative([...keptTurns, 16, 17, 18]));
      const toolContent = [...expectedNative([19])[0] as unknown[], { type: 'tool_use', id: toolCallId, name: effectTool, input: { value: 42 } }];
      const result = { type: 'tool_result', tool_use_id: toolCallId, content: 'PUBLIC_SERVER_TOOL_RESULT', is_error: false };
      // Each independently lowered request puts its cache breakpoint on the last message only.
      expect(bodies[18].messages!.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: 'Execute one native effect', cache_control: { type: 'ephemeral' } }] });
      expect(bodies[19].messages).toEqual([...bodies[18].messages!.slice(0, -1), { role: 'user', content: 'Execute one native effect' },
        { role: 'assistant', content: toolContent }, { role: 'user', content: [{ ...result, cache_control: { type: 'ephemeral' } }] }]);
      const effectBytes = await readFile(effectFile, 'utf8'); expect(JSON.parse(effectBytes)).toEqual({ sessionId: fork.id, input: { value: 42 } });
      const afterTool = await runtime.sessionManager.getRawEntries(fork.id), toolAssistant = assistants(afterTool).at(-2)!;
      expect(toolAssistant).toMatchObject({ provider: dialect, api: 'anthropic-messages', model, toolCalls: [{ id: toolCallId, name: effectTool, input: { value: 42 } }] });
      expect(toolAssistant.blocks).toEqual([...assistants(forkAfterRestart).at(-1)!.blocks!, { type: 'tool_call', id: toolCallId, name: effectTool, input: { value: 42 } }]);
      expect(assistants(afterTool).at(-1)!.blocks).toEqual(assistants(forkAfterRestart).at(-1)!.blocks);
      expect(afterTool.filter(entry => entry.type === 'message').filter(entry => entry.role === 'tool')).toHaveLength(1);
      for (const entry of forkAfterRestart.filter(entry => entry.type !== 'metadata')) expect(afterTool.find(value => value.id === entry.id)).toEqual(entry);
      const toolDisk = new SessionManager({ store: new JsonlSessionStore(path.join(dataDir, 'sessions')) }); expect(await toolDisk.loadFromStore(fork.id)).toBeTruthy();
      expect(getCompactionModelMessages(toolDisk, fork.id)).toEqual(getCompactionModelMessages(runtime.sessionManager, fork.id));
      await restart(fork.id); expect(bodies).toHaveLength(20); await send('Replay native tool and final blocks after restart'); expect(bodies).toHaveLength(21);
      expect(bodies[20].messages).toEqual([...bodies[19].messages!.slice(0, -1), { role: 'user', content: [result] },
        { role: 'assistant', content: expectedNative([20])[0] },
        { role: 'user', content: [{ type: 'text', text: 'Replay native tool and final blocks after restart', cache_control: { type: 'ephemeral' } }] }]);
      expect(effects).toBe(1); expect(await readFile(effectFile, 'utf8')).toBe(effectBytes); expect((await stat(effectFile)).mode & 0o777).toBe(0o600);
      expect(await readFile(file, 'utf8')).toBe(sourceBytes);
      const afterToolRestart = await runtime.sessionManager.getRawEntries(fork.id);
      for (const entry of afterTool.filter(entry => entry.type !== 'metadata')) expect(afterToolRestart.find(value => value.id === entry.id)).toEqual(entry);
      expect(afterToolRestart.filter(entry => entry.type === 'compaction')).toEqual(copiedCompactions);
      for (const value of [...opaque, 'WITHHELD_SIGNATURE', 'WITHHELD_REDACTED_DATA', 'unpublished-server-call', 'disposable-private-wire']) await expect(page.locator('body')).not.toContainText(value);
      expect(await readFile(forkFile, 'utf8')).not.toContain('disposable-private-wire'); expect((await stat(forkFile)).mode & 0o777).toBe(0o600);
      expect(wires).toEqual(Array(21).fill({ path: '/v1/messages', authorization: undefined }));
      let currentTurns = [...keptTurns, 16, 17, 18, 19, 20, 21];
      const replay = (turns: number[]) => turns.map(turn => turn === 19 ? toolContent : expectedNative([turn])[0]);
      const recoveryNotes = (entries: typeof afterTool) => entries.filter(entry => entry.type === 'custom').filter(entry => entry.customType === 'run.context_recovery').map(entry => entry.data);
      for (const failures of [1, 2]) {
        const target = runtime.sessionManager.get(fork.id)!.messages.find(message => message.role === 'user')!, filler = `PUBLIC_SERVER_OVERFLOW_FILLER_${failures}`;
        expect(await runtime.sessionManager.appendContextEdit(fork.id, { targetEntryId: target.id, replacement: filler + 'x'.repeat(6000) })).toBeTruthy();
        expect(runtime.sessionManager.estimateContextTokens(fork.id)).toBeGreaterThan(512); expect(runtime.sessionManager.estimateContextTokens(fork.id)).toBeLessThan(10_000);
        const preparedRecovery = runtime.sessionManager.requestCompaction(fork.id, 'overflow'); expect(preparedRecovery).toBeTruthy();
        expect(JSON.stringify(preparedRecovery!.toCompact)).toContain(filler); expect(JSON.stringify(preparedRecovery!.keptEntries)).not.toContain(filler);
        const beforeRecovery = await runtime.sessionManager.getRawEntries(fork.id), previousNotes = recoveryNotes(beforeRecovery), previousCompactions = beforeRecovery.filter(entry => entry.type === 'compaction');
        const nativeMessages = getCompactionModelMessages(runtime.sessionManager, fork.id).filter(message => message.role === 'assistant' && message.api === 'anthropic-messages');
        expect(nativeMessages).toHaveLength(currentTurns.length); const turnsById = new Map(nativeMessages.map((message, index) => [message.id, currentTurns[index]]));
        const turn = bodies.length; overflowRemaining = failures; overflowSession = fork.id; overflowCut = undefined;
        recoverySummary = `PUBLIC_SERVER_OVERFLOW_SUMMARY_${failures}`;
        const recoveredRun = await send(`Exercise native HTTP overflow ${failures}`, failures === 1 ? 'completed' : 'failed');
        expect(recoveredRun.session.id).toBe(fork.id); expect(overflowRemaining).toBe(0); expect(bodies).toHaveLength(turn + 3); expect(overflowCut).toBeTruthy();
        const cut = (overflowCut as ReturnType<SessionManager['requestCompaction']> | undefined)!, retained = cut.keptEntries.filter(entry => entry.type === 'message').flatMap(entry => { const value = turnsById.get(entry.id); return value === undefined ? [] : [value]; });
        expect(retained.at(-1)).toBe(currentTurns.at(-1)); expect(native(bodies[turn])).toEqual(replay(currentTurns)); expect(native(bodies[turn + 2])).toEqual(replay(retained));
        expect(bodies[turn + 1]).toMatchObject({ model, max_tokens: 4096, thinking: { type: 'disabled' } }); expect(bodies[turn + 1].tools ?? []).toEqual([]);
        const summaryInput = JSON.stringify(bodies[turn + 1]); expect(summaryInput).toContain(filler);
        for (const value of [...opaque, 'Visible native reasoning', 'thinkingSignature', 'PRIVATE_SERVER_PROVIDER_ERROR', overflowPrivate, 'disposable-private-wire']) {
          expect(summaryInput).not.toContain(value); expect(JSON.stringify(recoveredRun.settled)).not.toContain(value);
        }
        expect(JSON.stringify(bodies[turn + 2])).toContain(recoverySummary); expect(JSON.stringify(bodies[turn + 2])).not.toContain(filler);
        const afterRecovery = await runtime.sessionManager.getRawEntries(fork.id), notes = recoveryNotes(afterRecovery).slice(previousNotes.length), compactionsAfterRecovery = afterRecovery.filter(entry => entry.type === 'compaction');
        expect(notes).toHaveLength(failures === 1 ? 2 : 3); expect(notes[0]).toEqual({ reason: 'overflow', exhausted: false });
        const { before: recoveryBefore, after: recoveryAfter, ...state } = notes[1] as { before: number; after: number; reason: string; applied: boolean; useful: boolean };
        expect(state).toEqual({ reason: 'overflow', applied: true, useful: true }); expect(recoveryAfter).toBeLessThan(recoveryBefore);
        if (failures === 2) { expect(notes[2]).toEqual({ reason: 'overflow', exhausted: true }); expect(recoveredRun.settled).toMatchObject({ error: 'The provider context window was exceeded.' }); }
        expect(compactionsAfterRecovery).toHaveLength(previousCompactions.length + 1); expect(compactionsAfterRecovery.slice(0, -1)).toEqual(previousCompactions);
        expect(compactionsAfterRecovery.at(-1)).toMatchObject({ summary: recoverySummary, firstKeptEntryId: cut.keptEntries.find(entry => entry.type === 'message')!.id,
          provider: dialect, model, usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } });
        for (const value of [...opaque, 'Visible native reasoning', overflowPrivate, 'disposable-private-wire']) expect(JSON.stringify(compactionsAfterRecovery.at(-1))).not.toContain(value);
        if (failures === 2) expect(assistants(afterRecovery)).toEqual(assistants(beforeRecovery));
        else { expect(assistants(afterRecovery).slice(0, -1)).toEqual(assistants(beforeRecovery)); expect(assistants(afterRecovery).at(-1)!.blocks).toEqual(assistants(beforeRecovery).at(-1)!.blocks); }
        for (const entry of beforeRecovery.filter(entry => entry.type !== 'metadata')) expect(afterRecovery.find(value => value.id === entry.id)).toEqual(entry);
        const recoveredDisk = new SessionManager({ store: new JsonlSessionStore(path.join(dataDir, 'sessions')) }); expect(await recoveredDisk.loadFromStore(fork.id)).toBeTruthy();
        expect(getCompactionModelMessages(recoveredDisk, fork.id)).toEqual(getCompactionModelMessages(runtime.sessionManager, fork.id));
        currentTurns = [...retained, ...(failures === 1 ? [turn + 3] : [])];
        await restart(fork.id); expect(bodies).toHaveLength(turn + 3); await send(`Reload native HTTP overflow ${failures}`); expect(bodies).toHaveLength(turn + 4);
        expect(native(bodies[turn + 3])).toEqual(replay(currentTurns)); expect(JSON.stringify(bodies[turn + 3])).toContain(recoverySummary);
        expect(JSON.stringify(bodies[turn + 3])).not.toContain(filler); currentTurns.push(turn + 4);
        const finalRecovery = await runtime.sessionManager.getRawEntries(fork.id);
        for (const entry of afterRecovery.filter(entry => entry.type !== 'metadata')) expect(finalRecovery.find(value => value.id === entry.id)).toEqual(entry);
        expect(finalRecovery.filter(entry => entry.type === 'compaction')).toEqual(compactionsAfterRecovery); expect(recoveryNotes(finalRecovery)).toEqual(recoveryNotes(afterRecovery));
        expect(effects).toBe(1); expect(await readFile(effectFile, 'utf8')).toBe(effectBytes); expect(await readFile(file, 'utf8')).toBe(sourceBytes);
        expect((await stat(forkFile)).mode & 0o777).toBe(0o600); expect(await readFile(forkFile, 'utf8')).not.toContain(overflowPrivate);
        expect(await readFile(forkFile, 'utf8')).not.toContain('disposable-private-wire');
        for (const value of [...opaque, overflowPrivate, 'disposable-private-wire']) await expect(page.locator('body')).not.toContainText(value);
      }
      overflowSession = undefined; recoverySummary = undefined;
      expect(bodies).toHaveLength(29); expect(wires).toEqual(Array(29).fill({ path: '/v1/messages', authorization: undefined }));
    }
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
    await closeSettings(page);
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
