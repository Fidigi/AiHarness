import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { SessionEntry } from '@ai-harness/core';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const core = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));
const adaptive = 'claude-sonnet-4-6'; const classic = 'claude-3-7-sonnet-latest';
type Body = { model: string; thinking?: { type: string; budget_tokens?: number }; output_config?: { effort: string }; max_tokens: number;
  messages: Array<{ role: string; content: unknown; output_config?: { effort: string } }>;
  contents?: Array<{ role: string; parts: unknown[] }>; input?: Array<Record<string, unknown>>; stream?: boolean; include?: string[] };
const managed = new Set(['claude-fable-5-1', 'claude-haiku-5-5', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
const numeric = new Set(['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-5', 'claude-opus-4-5-20251101', 'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929']);
const continuationModel = 'claude-haiku-5-5';
const continuationKey = 'native-continuation-disposable-key';
function continuationContent(turn: number) {
  return [{ type: 'text', text: `native-${turn}-left` },
    { type: 'thinking', thinking: `visible-${turn}`, signature: 'opaque-[REDACTED]-tail' },
    { type: 'redacted_thinking', data: `opaque-redacted-${turn}` }, { type: 'text', text: `native-${turn}-right` },
    ...(turn === 1 ? [{ type: 'tool_use', id: 'native-call', name: 'continuation_echo', input: { value: 1 } }] : [])];
}
function continuationBlocks(turn: number) {
  return [{ type: 'text', text: `native-${turn}-left` },
    { type: 'reasoning', text: `visible-${turn}`, thinkingSignature: 'opaque-[REDACTED]-tail' },
    { type: 'reasoning', text: '[Reasoning redacted]', redacted: true, thinkingSignature: `opaque-redacted-${turn}` },
    { type: 'text', text: `native-${turn}-right` },
    ...(turn === 1 ? [{ type: 'tool_call', id: 'native-call', name: 'continuation_echo', input: { value: 1 } }] : [])];
}
const googleModel = 'gemini-3.8-flash', googleForeignModel = 'gemini-2.5-flash', googleKey = 'c2VjcmV0';
function googleContent(turn: number) {
  return [{ text: `native-${turn}-left` }, { text: `visible-${turn}`, thought: true, thoughtSignature: 'bGFzdA==' },
    { text: `native-${turn}-right`, thoughtSignature: 'cmlnaHQ=' }, { text: '', thought: true, thoughtSignature: 'aGlkZGVu' },
    { text: '', thoughtSignature: 'ZW1wdHk=' },
    ...(turn === 1 ? [{ functionCall: { id: 'native-call', name: 'continuation_echo', args: { value: 1 } }, thoughtSignature: 'dG9vbA==' }] : [])];
}
function googleBlocks(turn: number) {
  return [{ type: 'text', text: `native-${turn}-left`, textSignature: '[REDACTED]' },
    { type: 'reasoning', text: `visible-${turn}`, thinkingSignature: 'bGFzdA==' },
    { type: 'text', text: `native-${turn}-right`, textSignature: 'cmlnaHQ=' },
    { type: 'reasoning', text: '', thinkingSignature: 'aGlkZGVu' }, { type: 'text', text: '', textSignature: 'ZW1wdHk=' },
    ...(turn === 1 ? [{ type: 'tool_call', id: 'native-call', name: 'continuation_echo', input: { value: 1 }, thoughtSignature: 'dG9vbA==' }] : [])];
}
function googleForeignContent(turn: number, ids = true) {
  return [{ text: `native-${turn}-left` }, { text: `visible-${turn}` }, { text: `native-${turn}-right` },
    ...(turn === 1 ? [{ functionCall: { ...(ids ? { id: 'native-call' } : {}), name: 'continuation_echo', args: { value: 1 } } }] : [])];
}
function googlePath(provider: 'google' | 'vertex', model: string) {
  return `${provider === 'google' ? '/v1beta' : '/v1/projects/continuation-project/locations/us-central1/publishers/google'}/models/${model}:streamGenerateContent?alt=sse`;
}
const responsesModel = 'gpt-5', responsesForeignModel = 'gpt-4o';
function responsesItems(turn: number, redacted = true): Array<Record<string, unknown>> {
  return [{ type: 'reasoning', id: `rs_empty_${turn}`, summary: [], encrypted_content: `opaque-empty-${turn}` },
    { type: 'message', id: `msg_left_${turn}`, phase: 'commentary', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `native-${turn}-left`, annotations: [] }] },
    { type: 'reasoning', id: `rs_visible_${turn}`, summary: [{ type: 'summary_text', text: `visible-${turn}` }], encrypted_content: `opaque-${redacted ? '[REDACTED]' : continuationKey}-tail` },
    ...(turn === 1 ? [{ type: 'function_call', id: 'fc_native', call_id: 'native-call', name: 'continuation_echo', arguments: '{"value":1}', status: 'completed' }] : []),
    { type: 'message', id: `msg_right_${turn}`, phase: 'final_answer', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `native-${turn}-right`, annotations: [] }] }];
}
function responsesBlocks(turn: number) {
  return responsesItems(turn).map(item => item.type === 'reasoning'
    ? { type: 'reasoning', text: item.id === `rs_visible_${turn}` ? `visible-${turn}` : '', thinkingSignature: JSON.stringify(item) }
    : item.type === 'message' ? { type: 'text', text: item.id === `msg_left_${turn}` ? `native-${turn}-left` : `native-${turn}-right`, textSignature: JSON.stringify({ v: 1, id: item.id, phase: item.phase }) }
      : { type: 'tool_call', id: 'native-call|fc_native', name: 'continuation_echo', input: { value: 1 } });
}
function responsesReplay(turn: number) {
  return responsesItems(turn).map(item => item.type === 'function_call'
    ? { type: 'function_call', id: 'fc_native', call_id: 'native-call', name: 'continuation_echo', arguments: '{"value":1}' } : item);
}
const responsesAssistant = (body: Body) => body.input!.filter(item => item.role === 'assistant' || ['reasoning', 'function_call'].includes(String(item.type)));
const responsesPath = (provider: string) => provider === 'azure' ? '/openai/v1/responses?api-version=v1' : '/v1/responses';
async function fixture(model = adaptive, continuation = false, dialect: 'anthropic' | 'google' | 'vertex' | 'responses' | 'azure-responses' | 'minimax' | 'minimax-cn' = 'anthropic') {
  const responses = dialect === 'responses' || dialect === 'azure-responses';
  const minimax = dialect === 'minimax' || dialect === 'minimax-cn', anthropic = dialect === 'anthropic' || minimax;
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-adaptive-process-'));
  const cwd = path.join(root, 'project'); const agent = path.join(root, 'agent'); const preload = path.join(root, 'network.mjs');
  await Promise.all([mkdir(cwd), mkdir(agent)]);
  await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ thinkingBudgets: { low: 4000, high: Number.MAX_SAFE_INTEGER }, ...(responses ? { transport: 'sse', cacheWarming: 'off' } : {}) }));
  const sessions = path.join(root, 'sessions'), journal = path.join(sessions, 'native-continuation.jsonl'), effects = path.join(root, 'effects');
  if (continuation) {
    await mkdir(path.join(agent, 'extensions'));
    await writeFile(path.join(agent, 'extensions/continuation.mjs'), `import { appendFileSync } from 'node:fs';
      export default api => api.registerTool({ name: 'continuation_echo', description: 'Echo a value',
        parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
        execute: input => { appendFileSync(${JSON.stringify(effects)}, JSON.stringify(input) + '\\n'); return { content: 'native-tool-result' }; } });`);
  }
  if (responses) await writeFile(path.join(agent, 'extensions/responses.mjs'), `import { OpenAiMixedProvider } from ${JSON.stringify(core)};
    export default api => api.registerProvider('native-r', { defaultConfig: { apiKey: ${JSON.stringify(continuationKey)}, model: 'gpt-5' }, create: config => new OpenAiMixedProvider(config) });`);
  if (minimax) await writeFile(path.join(agent, 'extensions/minimax.mjs'), `import { MiniMaxProvider, MiniMaxCnProvider } from ${JSON.stringify(core)};
    export default api => api.registerProvider(${JSON.stringify(dialect)}, { defaultConfig: { apiKey: ${JSON.stringify(continuationKey)}, model: ${JSON.stringify(model)} },
      create: config => new ${dialect === 'minimax-cn' ? 'MiniMaxCnProvider' : 'MiniMaxProvider'}(config) });`);
  const bodies: Body[] = [], wires: Array<{ path: string; googleKey?: string; authorization?: string; apiKey?: string; version?: string }> = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(anthropic ? { data: [{ id: adaptive }, { id: classic }] }
        : { models: [googleModel, googleForeignModel].map(id => ({ name: `models/${id}` })) })); return;
    }
    wires.push({ path: request.url ?? '', googleKey: request.headers['x-goog-api-key'] as string | undefined, authorization: request.headers.authorization,
      ...(responses ? { apiKey: request.headers['api-key'] as string | undefined } : minimax ? {
        apiKey: request.headers['x-api-key'] as string | undefined, version: request.headers['anthropic-version'] as string | undefined } : {}) });
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()) as Body);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (responses) {
      const items = responsesItems(bodies.length, false), azure = request.url?.startsWith('/openai/');
      const events: Array<Record<string, unknown>> = [{ type: 'response.created', response: { id: `resp_${bodies.length}`, output: [] } }];
      for (const [index, item] of items.entries()) {
        const done = azure && item.type === 'reasoning' ? { ...item, encrypted_content: undefined } : item;
        events.push({ type: 'response.output_item.added', output_index: index, item: { ...done, ...(item.type === 'function_call' ? { arguments: '' } : {}) } });
        if (item.type === 'message') events.push({ type: 'response.output_text.delta', output_index: index, delta: item.id === `msg_left_${bodies.length}` ? `native-${bodies.length}-left` : `native-${bodies.length}-right` });
        if (item.id === `rs_visible_${bodies.length}`) for (const delta of ['visible-', String(bodies.length)]) events.push({ type: 'response.reasoning_summary_text.delta', output_index: index, delta });
        if (item.type === 'function_call') for (const delta of ['{"value":', '1}']) events.push({ type: 'response.function_call_arguments.delta', output_index: index, delta });
        events.push({ type: 'response.output_item.done', output_index: index, item: done });
      }
      events.push({ type: 'response.completed', response: { id: `resp_${bodies.length}`, model: 'untrusted-response-alias', status: 'completed', output: items,
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } });
      response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')); return;
    }
    if (!anthropic) {
      const parts = googleContent(bodies.length);
      response.end([
        { candidates: [{ content: { parts: [{ ...parts[0], thoughtSignature: googleKey }, { ...parts[1], thoughtSignature: 'Zmlyc3Q=' }] } }] },
        { candidates: [{ content: { parts: [{ text: '', thought: true, thoughtSignature: 'bGFzdA==' }, ...parts.slice(2)] } }] },
        { modelVersion: 'untrusted-response-alias', candidates: [{ finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
      return;
    }
    if (continuation) {
      const turn = bodies.length;
      response.end([{ type: 'message_start', message: { model: 'untrusted-response-alias' } },
        ...continuationContent(turn).flatMap((block, index) => [
          { type: 'content_block_start', index, content_block: block.type === 'thinking' ? { ...block, signature: 'opaque-' } : block },
          ...(block.type === 'thinking' ? [{ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: `${continuationKey}-tail` } }] : []),
          { type: 'content_block_stop', index },
        ]), { type: 'message_delta', delta: { stop_reason: turn === 1 ? 'tool_use' : 'end_turn' } }, { type: 'message_stop' },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
      return;
    }
    response.end([
      { type: 'message_start', message: {} },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'adaptive-ok' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // Redirect only transport origin. Do not replace the real provider,
  // metadata, CLI selection, request payload or HTTP execution.
  await writeFile(preload, `const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const allowed = ${JSON.stringify(minimax)}
        ? url.origin === ${JSON.stringify(dialect === 'minimax-cn' ? 'https://api.minimaxi.com' : 'https://api.minimax.io')} && url.pathname === '/anthropic/v1/messages'
        : ${JSON.stringify(responses)}
        ? (url.origin === 'https://api.openai.com' && url.pathname === '/v1/responses')
          || (url.origin === 'https://continuation.openai.azure.com' && url.pathname === '/openai/v1/responses')
        : ${JSON.stringify(dialect === 'anthropic')}
        ? url.origin === 'https://api.anthropic.com' && ['/v1/messages', '/v1/models'].includes(url.pathname)
        : ['https://generativelanguage.googleapis.com', 'https://us-central1-aiplatform.googleapis.com'].includes(url.origin)
          && (url.pathname.endsWith('/models') || /\\/models\\/gemini-(3\\.8|2\\.5)-flash:streamGenerateContent$/.test(url.pathname));
      if (!allowed) throw new Error('Non-fixture transport refused');
      const target = new URL(url.pathname + url.search, ${JSON.stringify(base)});
      return original(input instanceof Request ? new Request(target, input) : target, init);
    };`);
  const env = { ...process.env, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent, AI_HARNESS_EXTENSIONS: '', ...(minimax ? {} : { ANTHROPIC_API_KEY: continuation ? continuationKey : 'disposable' }), NO_COLOR: '1',
    ...(responses ? { OPENAI_API_KEY: continuationKey, AZURE_OPENAI_API_KEY: continuationKey, AZURE_OPENAI_BASE_URL: 'https://continuation.openai.azure.com/openai/v1',
      AZURE_OPENAI_MODEL: responsesModel, AZURE_OPENAI_DEPLOYMENT_NAME_MAP: 'gpt-5=owned-deployment,gpt-4o=foreign-deployment' } : anthropic ? {} : { GEMINI_API_KEY: googleKey, GOOGLE_API_KEY: googleKey, GOOGLE_VERTEX_ACCESS_TOKEN: googleKey,
      GOOGLE_CLOUD_PROJECT: 'continuation-project', GOOGLE_CLOUD_LOCATION: 'us-central1' }) };
  const start = (mode: 'print' | 'json' | 'rpc', thinking: string) => spawn(process.execPath, ['--import', preload, cli,
    '--no-approve', ...(continuation ? ['--session-dir', sessions, '--session-id', 'native-continuation'] : ['--no-session']),
    ...(responses ? ['--offline', '--api-key', continuationKey] : minimax ? ['--offline'] : []),
    '--model', `${dialect === 'responses' ? 'native-r' : dialect === 'azure-responses' ? 'azure' : dialect}/${model}`, '--thinking', thinking,
    ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['Probe native effort.'])], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); };
  return { bodies, wires, start, close, journal, effects };
}

describe('emitted built-in Anthropic reasoning selection', () => {
  for (const mode of ['print', 'json', 'rpc'] as const) for (const [model, level, effort, maximum] of [
    [adaptive, 'minimal', 'low', 128000], [adaptive, 'max', 'max', 128000],
    [adaptive, 'xhigh', 'max', 128000], [adaptive, 'off', undefined, 128000],
    ['claude-fable-5', 'xhigh', 'xhigh', 128000],
    ['claude-opus-4-6', 'xhigh', 'max', 128000],
    ['claude-opus-4-7', 'xhigh', 'xhigh', 128000],
    ['claude-opus-4-8', 'xhigh', 'xhigh', 128000],
    ['claude-sonnet-4-6', 'high', 'high', 128000],
    ['claude-sonnet-5', 'xhigh', 'xhigh', 128000],
    ['claude-fable-5', 'off', 'low', 128000],
    ['claude-fable-5-1', 'off', 'low', 128000],
    ['claude-haiku-5-5', 'off', 'low', 128000],
    ['claude-opus-5', 'xhigh', 'xhigh', 128000],
    ['claude-opus-5-5', 'max', 'max', 128000],
    ['claude-sonnet-5-5', 'low', 'low', 128000],
    ['claude-haiku-4-5', 'high', undefined, 64000],
    ['claude-haiku-4-5-20251001', 'high', undefined, 64000],
    ['claude-opus-4-5', 'high', undefined, 64000],
    ['claude-opus-4-5-20251101', 'high', undefined, 64000],
    ['claude-sonnet-4-5', 'high', undefined, 64000],
    ['claude-sonnet-4-5-20250929', 'high', undefined, 64000],
  ] as const) {
    it(`${mode}: ${model}/${level} reaches the actual built-in payload`, async () => {
      const test = await fixture(model); const child = test.start(mode, level);
      let stdout = ''; let stderr = '';
      child.stdout.setEncoding('utf8').on('data', text => { stdout += text; }); child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      try {
        const ended = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
        child.stdin.end(mode === 'rpc' ? JSON.stringify({ type: 'prompt', id: 'probe', message: 'Probe native effort.' }) + '\n' : '');
        expect(await ended, stderr).toEqual({ code: 0, signal: null }); expect(stdout).toContain('adaptive-ok');
        if (mode !== 'print') {
          const records = stdout.trim().split('\n').map(line => JSON.parse(line) as { type: string; message?: { role: string; providerThinkingLevel?: string } });
          expect(records.every(record => typeof record.type === 'string')).toBe(true);
          const assistant = records.find(record => record.type === 'message_end' && record.message?.role === 'assistant')?.message;
          expect(assistant?.providerThinkingLevel).toBe(managed.has(model) ? effort : undefined);
        }
        expect(test.bodies).toHaveLength(1);
        expect(test.bodies[0]?.thinking).toEqual(numeric.has(model)
          ? { type: 'enabled', budget_tokens: 62976, display: 'summarized' } : managed.has(model)
          ? { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } }
          : effort ? { type: 'adaptive', display: 'summarized' } : { type: 'disabled' });
        expect(test.bodies[0]?.output_config).toEqual(effort ? { effort: managed.has(model) ? 'high' : effort } : undefined);
        if (managed.has(model)) expect(test.bodies[0]?.messages.at(-1)).toEqual({ role: 'system', content: [], output_config: { effort } });
        expect(test.bodies[0]?.model).toBe(model); expect(test.bodies[0]?.max_tokens).toBe(maximum);
      } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await test.close(); }
    }, 30_000);
  }

  for (const provider of ['anthropic', 'minimax', 'minimax-cn'] as const) {
  const signedModel = provider === 'anthropic' ? continuationModel : 'MiniMax-M2.7';
  const foreignModel = provider === 'anthropic' ? adaptive : 'MiniMax-M3';
  const title = provider === 'anthropic' ? '' : `${provider}/`;
  const assertMiniMaxWires = (wires: Awaited<ReturnType<typeof fixture>>['wires'], count: number) => {
    if (provider !== 'anthropic') expect(wires).toEqual(Array(count).fill({ path: '/anthropic/v1/messages', googleKey: undefined,
      authorization: undefined, apiKey: continuationKey, version: '2023-06-01' }));
  };
  for (const mode of ['print', 'json'] as const) it(`${title}${mode}: retains native signed tool/final blocks across process restart`, async () => {
    const test = await fixture(signedModel, true, provider);
    try {
      for (const run of [1, 2]) {
        const child = test.start(mode, 'low'); let stdout = '', stderr = '';
        child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
        child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
        const ended = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
        const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        try {
          child.stdin.end(); expect(await ended, stderr).toEqual({ code: 0, signal: null });
          expect(stderr).toBe(''); expect(stdout + stderr).not.toContain(continuationKey);
          if (mode === 'print') expect(stdout).toBe(`native-${run + 1}-leftnative-${run + 1}-right\n`);
          else {
            const records = stdout.trim().split('\n').map(line => JSON.parse(line) as { type: string; message?: { role: string; content?: unknown } });
            const assistants = records.filter(record => record.type === 'message_end' && record.message?.role === 'assistant');
            // Live JSON uses compatibility text, not the persisted ordered replay blocks.
            expect(assistants.map(record => record.message?.content)).toEqual((run === 1 ? [1, 2] : [3]).map(turn => [
              { type: 'text', text: `native-${turn}-leftnative-${turn}-right` }, { type: 'thinking', thinking: `visible-${turn}` },
              ...(turn === 1 ? [{ type: 'toolCall', id: 'native-call', name: 'continuation_echo', arguments: { value: 1 } }] : []),
            ]));
            expect(stdout).not.toContain('opaque-');
            expect(records.filter(record => record.type === 'agent_settled')).toHaveLength(1);
          }
        } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
        const bytes = await readFile(test.journal, 'utf8'); expect(bytes).not.toContain(continuationKey);
        const entries = bytes.trim().split('\n').map(line => JSON.parse(line) as SessionEntry);
        const assistants = entries.filter(entry => entry.type === 'message' && entry.role === 'assistant');
        expect(assistants.map(entry => entry.type === 'message' ? entry.blocks : undefined)).toEqual(
          Array.from({ length: run + 1 }, (_, index) => continuationBlocks(index + 1)));
        for (const entry of assistants) expect(entry).toMatchObject({ provider, api: 'anthropic-messages', model: signedModel });
        expect((await stat(test.journal)).mode & 0o777).toBe(0o600);
      }
      expect(test.bodies).toHaveLength(3); assertMiniMaxWires(test.wires, 3);
      expect(test.bodies.map(body => body.model)).toEqual(Array(3).fill(signedModel));
      expect(test.bodies[1]?.messages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual([continuationContent(1)]);
      expect(test.bodies[2]?.messages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual([continuationContent(1), continuationContent(2)]);
      expect(JSON.stringify(test.bodies[1])).toContain('native-tool-result');
      expect(await readFile(test.effects, 'utf8')).toBe('{"value":1}\n');
    } finally { await test.close(); }
  }, 50_000);

  it(`${title}RPC projects signed continuation by physical model and edits only the selected entry`, async () => {
    const test = await fixture(signedModel, true, provider), child = test.start('rpc', 'low');
    const records: Array<Record<string, unknown>> = []; let buffer = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', text => {
      buffer += text;
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (line.trim()) records.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
    const ended = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    const command = async (record: Record<string, unknown>) => {
      child.stdin.write(JSON.stringify(record) + '\n');
      await vi.waitFor(() => expect(records, stderr).toContainEqual(expect.objectContaining({ type: 'response', id: record.id, success: true })), { timeout: 10_000 });
    };
    const prompt = async (count: number) => {
      await command({ type: 'prompt', id: `signed-${count}`, message: 'Continue native history.' });
      await vi.waitFor(() => expect(records.filter(record => record.type === 'agent_settled')).toHaveLength(count), { timeout: 10_000 });
    };
    const assistantWire = (index: number) => test.bodies[index]!.messages.filter(message => message.role === 'assistant').map(message => message.content);
    try {
      await prompt(1); await prompt(2);
      expect(assistantWire(1)).toEqual([continuationContent(1)]);
      expect(assistantWire(2)).toEqual([continuationContent(1), continuationContent(2)]);
      const before = await readFile(test.journal, 'utf8');
      const original = before.trim().split('\n').map(line => JSON.parse(line) as SessionEntry)
        .filter(entry => entry.type === 'message' && entry.role === 'assistant');
      await command({ type: 'set_model', id: 'foreign', provider, modelId: foreignModel });
      expect((await readFile(test.journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as SessionEntry)
        .filter(entry => entry.type === 'message' && entry.role === 'assistant')).toEqual(original);
      await prompt(3);
      expect(test.bodies[3]?.model).toBe(foreignModel);
      expect(assistantWire(3)).toEqual([1, 2, 3].map(turn => [
        { type: 'text', text: `native-${turn}-left` }, { type: 'text', text: `visible-${turn}` },
        { type: 'text', text: `native-${turn}-right` },
        ...(turn === 1 ? [{ type: 'tool_use', id: 'native-call', name: 'continuation_echo', input: { value: 1 } }] : []),
      ]));
      await command({ type: 'set_model', id: 'owner', provider, modelId: signedModel });
      await command({ type: 'context_edit', id: 'edit', targetEntryId: original[0]!.id, replacement: 'edited answer' });
      await prompt(4);
      const replay = assistantWire(4);
      expect(replay[0]).toEqual([{ type: 'tool_use', id: 'native-call', name: 'continuation_echo', input: { value: 1 } },
        { type: 'text', text: 'edited answer' }]);
      expect(replay.slice(1, 3)).toEqual([continuationContent(2), continuationContent(3)]);
      expect(JSON.stringify(replay[3])).not.toContain('opaque-'); expect(JSON.stringify(replay[3])).toContain('visible-4');
      child.stdin.end(); expect(await ended, stderr).toEqual({ code: 0, signal: null }); expect(buffer).toBe(''); expect(stderr).toBe('');
      const after = await readFile(test.journal, 'utf8'); expect(after).not.toContain(continuationKey);
      const retained = after.trim().split('\n').map(line => JSON.parse(line) as SessionEntry);
      expect(retained.filter(entry => entry.type === 'message' && entry.role === 'assistant').slice(0, 3)).toEqual(original);
      expect(retained.filter(entry => entry.type === 'context_edit')).toHaveLength(1);
      expect(test.bodies).toHaveLength(5); assertMiniMaxWires(test.wires, 5);
      expect(test.bodies.map(body => body.model)).toEqual([signedModel, signedModel, signedModel, foreignModel, signedModel]);
      expect(await readFile(test.effects, 'utf8')).toBe('{"value":1}\n');
      expect(JSON.stringify(records)).not.toContain(continuationKey);
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await test.close(); }
  }, 40_000);

  }

  it('RPC changes native effort and switches numeric/adaptive dialects between prompts', async () => {
    const test = await fixture(); const child = test.start('rpc', 'low');
    const records: Array<Record<string, unknown>> = []; let buffer = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', text => {
      buffer += text;
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (line.trim()) records.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
    const ended = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    const command = async (record: Record<string, unknown>) => {
      child.stdin.write(JSON.stringify(record) + '\n');
      await vi.waitFor(() => expect(records, stderr).toContainEqual(expect.objectContaining({ type: 'response', id: record.id, success: true })), { timeout: 10_000 });
    };
    const prompt = async (count: number) => {
      await command({ type: 'prompt', id: `prompt-${count}`, message: 'Probe native effort.' });
      await vi.waitFor(() => expect(records.filter(record => record.type === 'agent_end')).toHaveLength(count), { timeout: 10_000 });
    };
    try {
      await prompt(1);
      await command({ type: 'set_thinking_level', id: 'max', level: 'max' }); await prompt(2);
      await command({ type: 'set_model', id: 'classic', provider: 'anthropic', modelId: classic }); await prompt(3);
      await command({ type: 'set_model', id: 'adaptive', provider: 'anthropic', modelId: adaptive }); await prompt(4);
      await command({ type: 'set_thinking_level', id: 'off', level: 'off' }); await prompt(5);
      expect(test.bodies.map(body => [body.model, body.thinking, body.output_config, body.max_tokens])).toEqual([
        [adaptive, { type: 'adaptive', display: 'summarized' }, { effort: 'low' }, 128000],
        [adaptive, { type: 'adaptive', display: 'summarized' }, { effort: 'max' }, 128000],
        [classic, { type: 'enabled', budget_tokens: 32768 }, undefined, 33792],
        [adaptive, { type: 'adaptive', display: 'summarized' }, { effort: 'high' }, 128000],
        [adaptive, { type: 'disabled' }, undefined, 128000],
      ]);
      child.stdin.end(); expect(await ended, stderr).toEqual({ code: 0, signal: null }); expect(buffer).toBe('');
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await test.close(); }
  }, 40_000);
});

describe('emitted built-in Google/Vertex signed continuation', () => {
  const opaque = ['bGFzdA==', 'cmlnaHQ=', 'aGlkZGVu', 'ZW1wdHk=', 'dG9vbA=='];
  for (const provider of ['google', 'vertex'] as const) {
    const api = provider === 'google' ? 'google-generative-ai' : 'google-vertex';
    for (const mode of ['print', 'json'] as const) it(`${provider}/${mode}: retains signed tool/final history across explicit same-model restart`, async () => {
      const test = await fixture(googleModel, true, provider);
      try {
        for (const run of [1, 2]) {
          const child = test.start(mode, 'low'); let stdout = '', stderr = '';
          child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
          child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
          const ended = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
          const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
          try {
            child.stdin.end(); expect(await ended, stderr).toEqual({ code: 0, signal: null }); expect(stderr).toBe('');
            expect(stdout + stderr).not.toContain(googleKey);
            if (mode === 'print') expect(stdout).toBe(`native-${run + 1}-leftnative-${run + 1}-right\n`);
            else {
              const records = stdout.trim().split('\n').map(line => JSON.parse(line) as { type: string; message?: { role: string; content?: unknown } });
              expect(records.every(record => typeof record.type === 'string')).toBe(true);
              expect(records.filter(record => record.type === 'message_end' && record.message?.role === 'assistant').map(record => record.message?.content))
                .toEqual((run === 1 ? [1, 2] : [3]).map(turn => [
                  { type: 'text', text: `native-${turn}-leftnative-${turn}-right` }, { type: 'thinking', thinking: `visible-${turn}` },
                  ...(turn === 1 ? [{ type: 'toolCall', id: 'native-call', name: 'continuation_echo', arguments: { value: 1 } }] : []),
                ]));
              for (const value of opaque) expect(stdout).not.toContain(value);
              expect(records.filter(record => record.type === 'agent_settled')).toHaveLength(1);
            }
          } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
          const bytes = await readFile(test.journal, 'utf8'); expect(bytes).not.toContain(googleKey);
          const entries = bytes.trim().split('\n').map(line => JSON.parse(line) as SessionEntry);
          const assistants = entries.filter(entry => entry.type === 'message' && entry.role === 'assistant');
          expect(assistants.map(entry => entry.type === 'message' ? entry.blocks : undefined)).toEqual(
            Array.from({ length: run + 1 }, (_, index) => googleBlocks(index + 1)));
          for (const entry of assistants) expect(entry).toMatchObject({ provider, api, model: googleModel });
          expect((await stat(test.journal)).mode & 0o777).toBe(0o600);
        }
        expect(test.bodies).toHaveLength(3);
        expect(test.wires).toEqual(Array(3).fill({ path: googlePath(provider, googleModel),
          googleKey: provider === 'google' ? googleKey : undefined, authorization: provider === 'vertex' ? `Bearer ${googleKey}` : undefined }));
        for (const index of [1, 2]) {
          expect(test.bodies[index]!.contents!.filter(content => content.role === 'model').map(content => content.parts))
            .toEqual(Array.from({ length: index }, (_, turn) => googleContent(turn + 1)));
          expect(test.bodies[index]!.contents!.flatMap(content => content.parts).filter(part => part && typeof part === 'object' && 'functionResponse' in part))
            .toEqual([{ functionResponse: { id: 'native-call', name: 'continuation_echo', response: { output: 'native-tool-result' } } }]);
        }
        expect(await readFile(test.effects, 'utf8')).toBe('{"value":1}\n');
      } finally { await test.close(); }
    }, 50_000);

    it(`${provider}/RPC: projects physical model/API/provider switches and edits only the selected entry`, async () => {
      const test = await fixture(googleModel, true, provider), child = test.start('rpc', 'low');
      const other = provider === 'google' ? 'vertex' : 'google';
      const records: Array<Record<string, unknown>> = []; let buffer = '', stderr = '';
      child.stdout.setEncoding('utf8').on('data', text => {
        buffer += text;
        while (buffer.includes('\n')) {
          const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          if (line.trim()) records.push(JSON.parse(line) as Record<string, unknown>);
        }
      });
      child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
      const ended = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      const command = async (record: Record<string, unknown>) => {
        child.stdin.write(JSON.stringify(record) + '\n');
        await vi.waitFor(() => expect(records, stderr).toContainEqual(expect.objectContaining({ type: 'response', id: record.id, success: true })), { timeout: 10_000 });
      };
      const prompt = async (count: number) => {
        await command({ type: 'prompt', id: `google-${count}`, message: 'Continue native history.' });
        await vi.waitFor(() => expect(records.filter(record => record.type === 'agent_settled')).toHaveLength(count), { timeout: 10_000 });
      };
      const assistantWire = (index: number) => test.bodies[index]!.contents!.filter(content => content.role === 'model').map(content => content.parts);
      try {
        await prompt(1); await prompt(2);
        expect(assistantWire(1)).toEqual([googleContent(1)]);
        expect(assistantWire(2)).toEqual([googleContent(1), googleContent(2)]);
        const original = (await readFile(test.journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as SessionEntry)
          .filter(entry => entry.type === 'message' && entry.role === 'assistant');
        await command({ type: 'set_model', id: 'foreign-model', provider, modelId: googleForeignModel }); await prompt(3);
        expect(assistantWire(3)).toEqual([1, 2, 3].map(turn => googleForeignContent(turn, false)));
        await command({ type: 'set_model', id: 'foreign-provider', provider: other, modelId: googleModel }); await prompt(4);
        expect(assistantWire(4)).toEqual([1, 2, 3, 4].map(turn => googleForeignContent(turn)));
        expect((await readFile(test.journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as SessionEntry)
          .filter(entry => entry.type === 'message' && entry.role === 'assistant').slice(0, 3)).toEqual(original);
        await command({ type: 'set_model', id: 'owner', provider, modelId: googleModel });
        await command({ type: 'context_edit', id: 'edit', targetEntryId: original[0]!.id, replacement: 'edited answer' }); await prompt(5);
        expect(assistantWire(5)).toEqual([
          [{ functionCall: { id: 'native-call', name: 'continuation_echo', args: { value: 1 } }, thoughtSignature: 'dG9vbA==' }, { text: 'edited answer' }],
          googleContent(2), googleContent(3), googleForeignContent(4), googleForeignContent(5),
        ]);
        child.stdin.end(); expect(await ended, stderr).toEqual({ code: 0, signal: null }); expect(buffer).toBe(''); expect(stderr).toBe('');
        const bytes = await readFile(test.journal, 'utf8'); expect(bytes).not.toContain(googleKey);
        const entries = bytes.trim().split('\n').map(line => JSON.parse(line) as SessionEntry);
        const assistants = entries.filter(entry => entry.type === 'message' && entry.role === 'assistant');
        expect(assistants.slice(0, 3)).toEqual(original);
        expect(assistants.map(entry => entry.type === 'message' ? entry.blocks : undefined)).toEqual(Array.from({ length: 6 }, (_, index) => googleBlocks(index + 1)));
        for (const [index, entry] of assistants.entries()) expect(entry).toMatchObject({ provider: index === 4 ? other : provider,
          api: index === 4 ? other === 'google' ? 'google-generative-ai' : 'google-vertex' : api,
          model: index === 3 ? googleForeignModel : googleModel });
        expect(entries.filter(entry => entry.type === 'context_edit')).toHaveLength(1);
        expect((await stat(test.journal)).mode & 0o777).toBe(0o600);
        expect(test.bodies).toHaveLength(6);
        expect(test.wires).toEqual([provider, provider, provider, provider, other, provider].map((scope, index) => ({
          path: googlePath(scope as 'google' | 'vertex', index === 3 ? googleForeignModel : googleModel),
          googleKey: scope === 'google' ? googleKey : undefined, authorization: scope === 'vertex' ? `Bearer ${googleKey}` : undefined,
        })));
        expect(await readFile(test.effects, 'utf8')).toBe('{"value":1}\n'); expect(JSON.stringify(records)).not.toContain(googleKey);
        const live = JSON.stringify(records.filter(record => record.type === 'message_end'));
        for (const value of opaque) expect(live).not.toContain(value);
      } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await test.close(); }
    }, 40_000);
  }
});

describe('emitted original Responses encrypted continuation', () => {
  for (const provider of ['native-r', 'azure'] as const) {
    const api = provider === 'native-r' ? 'openai-responses' : 'azure-openai-responses';
    const dialect = provider === 'native-r' ? 'responses' : 'azure-responses';
    const wire = (scope: string) => ({ path: responsesPath(scope), googleKey: undefined,
      authorization: scope === 'native-r' ? `Bearer ${continuationKey}` : undefined, apiKey: scope === 'azure' ? continuationKey : undefined });
    for (const mode of ['print', 'json'] as const) it(`${provider}/${mode}: retains encrypted tool/final history across explicit same-model restart`, async () => {
      const test = await fixture(responsesModel, true, dialect);
      try {
        for (const run of [1, 2]) {
          const child = test.start(mode, 'low'); let stdout = '', stderr = '';
          child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
          child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
          const ended = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
          const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
          try {
            child.stdin.end(); expect(await ended, stderr).toEqual({ code: 0, signal: null }); expect(stderr).toBe('');
            expect(stdout + stderr).not.toContain(continuationKey);
            if (mode === 'print') expect(stdout).toBe(`native-${run + 1}-leftnative-${run + 1}-right\n`);
            else {
              const records = stdout.trim().split('\n').map(line => JSON.parse(line) as { type: string; message?: { role: string; content?: unknown } });
              expect(records.every(record => typeof record.type === 'string')).toBe(true);
              expect(records.filter(record => record.type === 'message_end' && record.message?.role === 'assistant').map(record => record.message?.content))
                .toEqual((run === 1 ? [1, 2] : [3]).map(turn => [
                  { type: 'text', text: `native-${turn}-leftnative-${turn}-right` }, { type: 'thinking', thinking: `visible-${turn}` },
                  ...(turn === 1 ? [{ type: 'toolCall', id: 'native-call|fc_native', name: 'continuation_echo', arguments: { value: 1 } }] : []),
                ]));
              for (const value of ['opaque-', 'msg_left_', 'msg_right_', 'rs_empty_', 'rs_visible_']) expect(stdout).not.toContain(value);
              expect(records.filter(record => record.type === 'agent_settled')).toHaveLength(1);
            }
          } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
          const bytes = await readFile(test.journal, 'utf8'); expect(bytes).not.toContain(continuationKey);
          const assistants = bytes.trim().split('\n').map(line => JSON.parse(line) as SessionEntry).filter(entry => entry.type === 'message' && entry.role === 'assistant');
          expect(assistants.map(entry => entry.type === 'message' ? entry.blocks : undefined)).toEqual(Array.from({ length: run + 1 }, (_, index) => responsesBlocks(index + 1)));
          for (const entry of assistants) expect(entry).toMatchObject({ provider, api, model: responsesModel });
          expect((await stat(test.journal)).mode & 0o777).toBe(0o600);
        }
        expect(test.bodies).toHaveLength(3); expect(test.wires).toEqual(Array(3).fill(wire(provider)));
        expect(test.bodies.every(body => body.stream === true)).toBe(true);
        expect(test.bodies[0]?.include).toContain('reasoning.encrypted_content');
        for (const index of [1, 2]) {
          expect(responsesAssistant(test.bodies[index]!)).toEqual(Array.from({ length: index }, (_, turn) => responsesReplay(turn + 1)).flat());
          expect(test.bodies[index]!.input!.filter(item => item.type === 'function_call_output'))
            .toEqual([{ type: 'function_call_output', call_id: 'native-call', output: 'native-tool-result' }]);
        }
        expect(test.bodies.map(body => body.model)).toEqual(Array(3).fill(provider === 'azure' ? 'owned-deployment' : responsesModel));
        expect(await readFile(test.effects, 'utf8')).toBe('{"value":1}\n');
      } finally { await test.close(); }
    }, 50_000);

    it(`${provider}/RPC: projects physical model/API/provider switches and edits only the selected entry`, async () => {
      const test = await fixture(responsesModel, true, dialect), child = test.start('rpc', 'low'), other = provider === 'native-r' ? 'azure' : 'native-r';
      const records: Array<Record<string, unknown>> = []; let buffer = '', stderr = '';
      child.stdout.setEncoding('utf8').on('data', text => {
        buffer += text;
        while (buffer.includes('\n')) {
          const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          if (line.trim()) records.push(JSON.parse(line) as Record<string, unknown>);
        }
      });
      child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
      const ended = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      const command = async (record: Record<string, unknown>) => {
        child.stdin.write(JSON.stringify(record) + '\n');
        await vi.waitFor(() => expect(records, stderr).toContainEqual(expect.objectContaining({ type: 'response', id: record.id, success: true })), { timeout: 10_000 });
      };
      const prompt = async (count: number) => {
        await command({ type: 'prompt', id: `responses-${count}`, message: 'Continue native history.' });
        await vi.waitFor(() => expect(records.filter(record => record.type === 'agent_settled')).toHaveLength(count), { timeout: 10_000 });
      };
      const foreign = (index: number, turns: number[]) => {
        const items = responsesAssistant(test.bodies[index]!);
        expect(items.filter(item => item.type === 'reasoning')).toEqual([]);
        expect(items.filter(item => item.role === 'assistant').map(item => item.content)).toEqual(turns.flatMap(turn =>
          [`native-${turn}-left`, `visible-${turn}`, `native-${turn}-right`].map(text => [{ type: 'output_text', text, annotations: [] }])));
        expect(items.filter(item => item.type === 'function_call')).toEqual([expect.objectContaining({ call_id: 'native-call', name: 'continuation_echo', arguments: '{"value":1}' })]);
        for (const value of ['opaque-', 'msg_left_', 'msg_right_', 'rs_empty_', 'rs_visible_', 'fc_native']) expect(JSON.stringify(items)).not.toContain(value);
      };
      try {
        await prompt(1); await prompt(2);
        expect(responsesAssistant(test.bodies[1]!)).toEqual(responsesReplay(1));
        expect(responsesAssistant(test.bodies[2]!)).toEqual([1, 2].flatMap(responsesReplay));
        const original = (await readFile(test.journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as SessionEntry)
          .filter(entry => entry.type === 'message' && entry.role === 'assistant');
        await command({ type: 'set_model', id: 'foreign-model', provider, modelId: responsesForeignModel }); await prompt(3); foreign(3, [1, 2, 3]);
        await command({ type: 'set_model', id: 'foreign-provider', provider: other, modelId: responsesModel }); await prompt(4); foreign(4, [1, 2, 3, 4]);
        expect((await readFile(test.journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as SessionEntry)
          .filter(entry => entry.type === 'message' && entry.role === 'assistant').slice(0, 3)).toEqual(original);
        await command({ type: 'set_model', id: 'owner', provider, modelId: responsesModel });
        await command({ type: 'context_edit', id: 'edit', targetEntryId: original[0]!.id, replacement: 'edited answer' }); await prompt(5);
        const replay = responsesAssistant(test.bodies[5]!);
        expect(replay.slice(0, 10)).toEqual([
          { type: 'function_call', id: 'fc_native', call_id: 'native-call', name: 'continuation_echo', arguments: '{"value":1}' },
          { type: 'message', role: 'assistant', id: 'msg_pi_1', status: 'completed', content: [{ type: 'output_text', text: 'edited answer', annotations: [] }] },
          ...[2, 3].flatMap(responsesReplay),
        ]);
        expect(replay.slice(10).filter(item => item.role === 'assistant').map(item => item.content)).toEqual([4, 5].flatMap(turn =>
          [`native-${turn}-left`, `visible-${turn}`, `native-${turn}-right`].map(text => [{ type: 'output_text', text, annotations: [] }])));
        expect(JSON.stringify(replay.slice(10))).not.toContain('opaque-');
        child.stdin.end(); expect(await ended, stderr).toEqual({ code: 0, signal: null }); expect(buffer).toBe(''); expect(stderr).toBe('');
        const bytes = await readFile(test.journal, 'utf8'); expect(bytes).not.toContain(continuationKey);
        const entries = bytes.trim().split('\n').map(line => JSON.parse(line) as SessionEntry), assistants = entries.filter(entry => entry.type === 'message' && entry.role === 'assistant');
        expect(assistants.slice(0, 3)).toEqual(original);
        expect(assistants.map(entry => entry.type === 'message' ? entry.blocks : undefined)).toEqual(Array.from({ length: 6 }, (_, index) => responsesBlocks(index + 1)));
        for (const [index, entry] of assistants.entries()) expect(entry).toMatchObject({ provider: index === 4 ? other : provider,
          api: index === 4 ? other === 'native-r' ? 'openai-responses' : 'azure-openai-responses' : api, model: index === 3 ? responsesForeignModel : responsesModel });
        expect(entries.filter(entry => entry.type === 'context_edit')).toHaveLength(1); expect((await stat(test.journal)).mode & 0o777).toBe(0o600);
        expect(test.bodies).toHaveLength(6); expect(test.wires).toEqual([provider, provider, provider, provider, other, provider].map(wire));
        expect(test.bodies.map((body, index) => body.model)).toEqual([provider, provider, provider, provider, other, provider].map((scope, index) =>
          scope === 'azure' ? index === 3 ? 'foreign-deployment' : 'owned-deployment' : index === 3 ? responsesForeignModel : responsesModel));
        for (const body of test.bodies.slice(1)) expect(body.input!.filter(item => item.type === 'function_call_output'))
          .toEqual([{ type: 'function_call_output', call_id: 'native-call', output: 'native-tool-result' }]);
        expect(await readFile(test.effects, 'utf8')).toBe('{"value":1}\n'); expect(JSON.stringify(records)).not.toContain(continuationKey);
        const live = JSON.stringify(records.filter(record => record.type === 'message_end'));
        for (const value of ['opaque-', 'msg_left_', 'msg_right_', 'rs_empty_', 'rs_visible_']) expect(live).not.toContain(value);
      } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await test.close(); }
    }, 40_000);
  }
});
