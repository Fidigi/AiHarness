import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { MessageBlock, SessionEntry } from '@ai-harness/core';
import { bedrockFrame as frame, bedrockText } from '../../../../tests/fixtures/bedrock-event-stream.js';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const core = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));

describe('emitted CLI native Bedrock stream', () => {
  it.each([['json', 'sigv4'], ['rpc', 'sigv4'], ['json', 'bearer'], ['rpc', 'bearer']] as const)('%s/%s uses explicit SDK registration, binary wire output and durable native accounting', async (mode, auth) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-bedrock-cli-'));
    const cwd = path.join(root, 'project'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
    const calls: Array<{ url?: string; authorization?: string; authHeaders: string[]; body: Record<string, unknown> }> = [];
    let fixtureError: unknown;
    const upstream = createServer(async (request, response) => {
      try {
        let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
        calls.push({ url: request.url, authorization: request.headers.authorization, authHeaders: Object.keys(request.headers).filter(name => name.startsWith('x-amz-')), body: JSON.parse(text) });
        response.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
        if (calls.length === 1) response.end(Buffer.concat([
          frame('messageStart', { role: 'assistant' }),
          frame('contentBlockStart', { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'read-file', name: 'read' } } }),
          frame('contentBlockDelta', { contentBlockIndex: 0, delta: { toolUse: { input: '{"path":"fixture.txt"}' } } }),
          frame('contentBlockStop', { contentBlockIndex: 0 }), frame('messageStop', { stopReason: 'tool_use' }),
          frame('metadata', { usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } }),
        ]));
        else {
          expect(JSON.stringify(calls[1].body.messages)).toContain('tool-roundtrip-ok');
          response.end(bedrockText('native-bedrock-cli-ok', 'end_turn', { inputTokens: 7, outputTokens: 2, cacheReadInputTokens: 3, totalTokens: 12 }));
        }
      } catch (error) { fixtureError = error; response.writeHead(500); response.end('Invalid Bedrock fixture'); }
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    try {
      await mkdir(cwd); await writeFile(path.join(cwd, 'fixture.txt'), 'tool-roundtrip-ok');
      await mkdir(path.join(agent, 'extensions'), { recursive: true });
      await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ cacheWarming: 'off' }));
      await writeFile(path.join(agent, 'extensions/bedrock.mjs'), `import { BedrockProvider } from ${JSON.stringify(core)};
        export default api => api.registerProvider('operator-bedrock', { defaultConfig: { model: 'fixture:0' },
          create(config) { return new BedrockProvider({ ...config, accessKeyId: 'DISPOSABLECLI', secretAccessKey: 'disposableclisecret',
            baseUrl: 'http://127.0.0.1:${(upstream.address() as { port: number }).port}/proxy' }); } });`);
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, '--approve', '--offline', ...(auth === 'bearer' ? ['--api-key', 'disposable:cli:bearer'] : []), '--session-dir', sessions,
          '--model', 'operator-bedrock/fixture:0', '--tools', 'read', '--mode', mode, ...(mode === 'rpc' ? [] : ['hello'])], {
          cwd, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), TMPDIR: root, NO_COLOR: '1', AI_HARNESS_AGENT_DIR: agent }, stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        child.stdout.setEncoding('utf8').on('data', text => { stdout += text; }); child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
        child.stdin.end(mode === 'rpc' ? [{ type: 'get_state', id: 'state' }, { type: 'prompt', id: 'prompt', message: 'hello' }].map(command => JSON.stringify(command)).join('\n') + '\n' : '');
      });
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
      const assistant = records.find(record => record.type === 'message_end' && JSON.stringify(record.message?.content).includes('native-bedrock-cli-ok'));
      expect(assistant?.message).toMatchObject({ content: [{ type: 'text', text: 'native-bedrock-cli-ok' }], api: 'bedrock-converse-stream' });
      if (mode === 'rpc') expect(records.find(record => record.id === 'state')?.data.model.api).toBe('bedrock-converse-stream');
      expect(fixtureError).toBeUndefined(); expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ url: '/proxy/model/fixture%3A0/converse-stream', authorization: auth === 'sigv4' ? expect.stringContaining('Credential=DISPOSABLECLI/') : 'Bearer disposable:cli:bearer', body: { messages: expect.any(Array) } });
      if (auth === 'bearer') for (const call of calls) { expect(call.authorization).toBe('Bearer disposable:cli:bearer'); expect(call.authHeaders).toEqual([]); }
      const entries = (await Promise.all((await readdir(sessions)).filter(name => name.endsWith('.jsonl')).map(name => readFile(path.join(sessions, name), 'utf8'))))
        .flatMap(text => text.trim().split('\n').map(line => JSON.parse(line)));
      expect(entries).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', api: 'bedrock-converse-stream',
        usage: expect.objectContaining({ inputTokens: 7, cacheReadTokens: 3, outputTokens: 2, totalTokens: 12 }) }));
      expect(JSON.stringify(entries) + result.stdout + result.stderr).not.toContain('disposableclisecret');
      expect(JSON.stringify(entries) + result.stdout + result.stderr).not.toContain('disposable:cli:bearer');
    } finally {
      upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.each(['print', 'json', 'rpc'] as const)('%s retains exact Opus signed history through native built-in composition', async mode => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-bedrock-signed-cli-'));
    const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
    const journal = path.join(sessions, 'native-continuation.jsonl'), effects = path.join(root, 'effects'), preload = path.join(root, 'network.mjs');
    const model = 'anthropic.claude-opus-4-6-v1', foreignModel = 'anthropic.claude-sonnet-4-6', key = 'emitted-continuation-disposable-key';
    type NativeBlock = { text?: string; reasoningContent?: { reasoningText?: { text: string; signature: string }; redactedContent?: string };
      toolUse?: { toolUseId: string; name: string; input: { value: number } } };
    const content = (turn: number, foreign = false): NativeBlock[] => [
      { text: `native-${turn}-left` }, foreign ? { text: `visible-${turn}` }
        : { reasoningContent: { reasoningText: { text: `visible-${turn}`, signature: 'opaque-[REDACTED]-tail' } } },
      ...(foreign ? [] : [{ reasoningContent: { redactedContent: 'AP8BgAI=' } }]), { text: `native-${turn}-right` },
      ...(turn === 1 ? [{ toolUse: { toolUseId: 'native-call', name: 'continuation_echo', input: { value: 1 } } }] : []),
    ];
    const blocks = (turn: number): MessageBlock[] => mode === 'rpc' && turn === 4
      ? [{ type: 'reasoning', text: 'visible-4' }, { type: 'text', text: 'native-4-leftnative-4-right' }]
      : [{ type: 'text', text: `native-${turn}-left` }, { type: 'reasoning', text: `visible-${turn}`, thinkingSignature: 'opaque-[REDACTED]-tail' },
        { type: 'reasoning', text: '', redacted: true, thinkingSignature: 'AP8BgAI=' }, { type: 'text', text: `native-${turn}-right` },
        ...(turn === 1 ? [{ type: 'tool_call' as const, id: 'native-call', name: 'continuation_echo', input: { value: 1 } }] : [])];
    const calls: Array<{ url?: string; authorization?: string; body: { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> } }> = [];
    let fixtureError: unknown;
    const upstream = createServer(async (request, response) => {
      try {
        expect(request.method).toBe('POST');
        let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
        calls.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(text) });
        const frames = [frame('messageStart', { role: 'assistant' })], turn = calls.length;
        for (const [contentBlockIndex, block] of content(turn).entries()) {
          const delta = (value: unknown) => frames.push(frame('contentBlockDelta', { contentBlockIndex, delta: value }));
          if (block.text !== undefined) delta({ text: block.text });
          else if (block.toolUse) {
            frames.push(frame('contentBlockStart', { contentBlockIndex, start: { toolUse: { toolUseId: block.toolUse.toolUseId, name: block.toolUse.name } } }));
            delta({ toolUse: { input: '{"value":' } }); delta({ toolUse: { input: '1}' } });
          } else if (block.reasoningContent!.reasoningText) {
            delta({ reasoningContent: { text: block.reasoningContent!.reasoningText.text } });
            for (const signature of ['opaque-', `${key}-tail`]) delta({ reasoningContent: { signature } });
          } else for (const redactedContent of ['AP8=', 'AYAC']) delta({ reasoningContent: { redactedContent } });
          frames.push(frame('contentBlockStop', { contentBlockIndex }));
        }
        frames.push(frame('messageStop', { stopReason: turn === 1 ? 'tool_use' : 'end_turn' }),
          frame('metadata', { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }));
        response.writeHead(200, { 'Content-Type': 'application/vnd.amazon.eventstream' }); response.end(Buffer.concat(frames));
      } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid Bedrock fixture'); }
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const entries = async () => (await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as SessionEntry);
    const assistants = (index: number) => calls[index]!.body.messages.filter(message => message.role === 'assistant').map(message => message.content);
    try {
      await mkdir(cwd); await mkdir(path.join(agent, 'extensions'), { recursive: true });
      await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ cacheWarming: 'off' }));
      await writeFile(path.join(agent, 'extensions/continuation.mjs'), `import { appendFileSync } from 'node:fs';
        export default api => api.registerTool({ name: 'continuation_echo', description: 'Echo a value',
          parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
          execute: input => { appendFileSync(${JSON.stringify(effects)}, JSON.stringify(input) + '\\n'); return { content: 'native-tool-result' }; } });`);
      // Change only the external transport origin; use the actual built-in provider and emitted CLI.
      await writeFile(preload, `const original = globalThis.fetch;
        globalThis.fetch = async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input);
          if (url.origin !== 'https://bedrock-runtime.us-east-1.amazonaws.com'
            || !${JSON.stringify([model, foreignModel].map(value => `/model/${encodeURIComponent(value)}/converse-stream`))}.includes(url.pathname)) throw new Error('Non-fixture transport refused');
          const target = new URL(url.pathname + url.search, 'http://127.0.0.1:${(upstream.address() as { port: number }).port}');
          return original(input instanceof Request ? new Request(target, input) : target, init);
        };`);
      for (const run of mode === 'rpc' ? [1] : [1, 2]) {
        const child = spawn(process.execPath, ['--import', preload, cli, '--no-approve', '--offline', '--api-key', key,
          '--session-dir', sessions, '--session-id', 'native-continuation', '--model', `bedrock/${model}`, '--thinking', 'low', '--tools', 'continuation_echo',
          ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['Continue native history.'])], {
          cwd, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), TMPDIR: root, NO_COLOR: '1', AWS_REGION: 'us-east-1', AI_HARNESS_AGENT_DIR: agent },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const records: Array<Record<string, unknown>> = []; let stdout = '', stderr = '', buffer = '';
        child.stdout.setEncoding('utf8').on('data', text => {
          stdout += text; if (mode === 'print') return; buffer += text;
          while (buffer.includes('\n')) {
            const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
            if (line.trim()) records.push(JSON.parse(line));
          }
        });
        child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
        const ended = new Promise((resolve, reject) => {
          child.once('error', reject); child.once('close', (code, signal) => {
            if (signal) console.error('Emitted Bedrock child termination.', { mode, run, pid: child.pid, code, signal });
            resolve({ code, signal });
          });
        });
        const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        const command = async (record: Record<string, unknown>) => {
          child.stdin.write(JSON.stringify(record) + '\n');
          await vi.waitFor(() => expect(records, stderr).toContainEqual(expect.objectContaining({ type: 'response', id: record.id, success: true })), { timeout: 10_000 });
        };
        const prompt = async (count: number) => {
          await command({ type: 'prompt', id: `prompt-${count}`, message: 'Continue native history.' });
          await vi.waitFor(() => expect(records.filter(record => record.type === 'agent_settled')).toHaveLength(count), { timeout: 10_000 });
        };
        try {
          if (mode === 'rpc') {
            await prompt(1); await prompt(2);
            const original = (await entries()).filter(entry => entry.type === 'message' && entry.role === 'assistant');
            await command({ type: 'set_model', id: 'foreign', provider: 'bedrock', modelId: foreignModel }); await prompt(3);
            expect(assistants(3)).toEqual([1, 2, 3].map(turn => content(turn, true)));
            await command({ type: 'set_model', id: 'owner', provider: 'bedrock', modelId: model });
            await command({ type: 'context_edit', id: 'edit', targetEntryId: original[0]!.id, replacement: 'edited answer' }); await prompt(4);
            expect(assistants(4)).toEqual([
              [{ toolUse: { toolUseId: 'native-call', name: 'continuation_echo', input: { value: 1 } } }, { text: 'edited answer' }],
              content(2), content(3), [{ text: 'visible-4' }, { text: 'native-4-leftnative-4-right' }],
            ]);
            const retained = await entries();
            expect(retained.filter(entry => entry.type === 'message' && entry.role === 'assistant').slice(0, 3)).toEqual(original);
            expect(retained.filter(entry => entry.type === 'context_edit')).toHaveLength(1);
          }
          child.stdin.end(); expect(await ended, stderr).toEqual({ code: 0, signal: null }); expect(stderr).toBe(''); expect(buffer).toBe('');
          for (const value of [key, 'opaque-', 'AP8BgAI=']) expect(stdout + stderr).not.toContain(value);
          if (mode === 'print') expect(stdout).toBe(`native-${run + 1}-leftnative-${run + 1}-right\n`);
          else {
            expect(records.filter(record => record.type === 'agent_settled')).toHaveLength(mode === 'rpc' ? 4 : 1);
            const turns = mode === 'rpc' ? [1, 2, 3, 4, 5] : run === 1 ? [1, 2] : [3];
            expect(records.filter(record => record.type === 'message_end' && (record.message as { role?: string })?.role === 'assistant')
              .map(record => (record.message as { content: unknown }).content)).toEqual(turns.map(turn => [
                { type: 'text', text: `native-${turn}-leftnative-${turn}-right` }, { type: 'thinking', thinking: `visible-${turn}` },
                ...(turn === 1 ? [{ type: 'toolCall', id: 'native-call', name: 'continuation_echo', arguments: { value: 1 } }] : []),
              ]));
          }
          const saved = (await entries()).filter(entry => entry.type === 'message' && entry.role === 'assistant');
          expect(saved.map(entry => entry.type === 'message' ? entry.blocks : undefined)).toEqual(
            Array.from({ length: mode === 'rpc' ? 5 : run + 1 }, (_, index) => blocks(index + 1)));
          saved.forEach((entry, index) => expect(entry).toMatchObject({ provider: 'bedrock', api: 'bedrock-converse-stream', model: mode === 'rpc' && index === 3 ? foreignModel : model }));
          expect((await stat(journal)).mode & 0o777).toBe(0o600); expect(await readFile(journal, 'utf8')).not.toContain(key);
        } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
      }
      expect(fixtureError).toBeUndefined(); expect(calls).toHaveLength(mode === 'rpc' ? 5 : 3);
      calls.forEach((call, index) => {
        expect(call.url).toBe(`/model/${encodeURIComponent(mode === 'rpc' && index === 3 ? foreignModel : model)}/converse-stream`);
        expect(call.authorization).toBe(`Bearer ${key}`);
      });
      expect(assistants(0)).toEqual([]); expect(assistants(1)).toEqual([content(1)]); expect(assistants(2)).toEqual([content(1), content(2)]);
      for (const call of calls.slice(1)) expect(call.body.messages.flatMap(message => message.content).filter(block => 'toolResult' in block))
        .toEqual([{ toolResult: { toolUseId: 'native-call', content: [{ text: 'native-tool-result' }], status: 'success' } }]);
      expect(await readFile(effects, 'utf8')).toBe('{"value":1}\n');
    } finally {
      upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
