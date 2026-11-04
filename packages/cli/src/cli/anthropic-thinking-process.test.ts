import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { SessionEntry } from '@ai-harness/core';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const adaptive = 'claude-sonnet-4-6'; const classic = 'claude-3-7-sonnet-latest';
type Body = { model: string; thinking?: { type: string; budget_tokens?: number }; output_config?: { effort: string }; max_tokens: number;
  messages: Array<{ role: string; content: unknown; output_config?: { effort: string } }> };
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
async function fixture(model = adaptive, continuation = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-adaptive-process-'));
  const cwd = path.join(root, 'project'); const agent = path.join(root, 'agent'); const preload = path.join(root, 'network.mjs');
  await Promise.all([mkdir(cwd), mkdir(agent)]);
  await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ thinkingBudgets: { low: 4000, high: Number.MAX_SAFE_INTEGER } }));
  const sessions = path.join(root, 'sessions'), journal = path.join(sessions, 'native-continuation.jsonl'), effects = path.join(root, 'effects');
  if (continuation) {
    await mkdir(path.join(agent, 'extensions'));
    await writeFile(path.join(agent, 'extensions/continuation.mjs'), `import { appendFileSync } from 'node:fs';
      export default api => api.registerTool({ name: 'continuation_echo', description: 'Echo a value',
        parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
        execute: input => { appendFileSync(${JSON.stringify(effects)}, JSON.stringify(input) + '\\n'); return { content: 'native-tool-result' }; } });`);
  }
  const bodies: Body[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: adaptive }, { id: classic }] })); return;
    }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()) as Body);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
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
  // Redirect only transport origin. Do not replace the real built-in provider,
  // metadata, CLI selection, request payload or HTTP execution.
  await writeFile(preload, `const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin !== 'https://api.anthropic.com' || !['/v1/messages', '/v1/models'].includes(url.pathname)) throw new Error('Non-fixture transport refused');
      const target = new URL(url.pathname + url.search, ${JSON.stringify(base)});
      return original(input instanceof Request ? new Request(target, input) : target, init);
    };`);
  const env = { ...process.env, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent, AI_HARNESS_EXTENSIONS: '', ANTHROPIC_API_KEY: continuation ? continuationKey : 'disposable', NO_COLOR: '1' };
  const start = (mode: 'print' | 'json' | 'rpc', thinking: string) => spawn(process.execPath, ['--import', preload, cli,
    '--no-approve', ...(continuation ? ['--session-dir', sessions, '--session-id', 'native-continuation'] : ['--no-session']),
    '--model', `anthropic/${model}`, '--thinking', thinking,
    ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['Probe native effort.'])], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); };
  return { bodies, start, close, journal, effects };
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

  for (const mode of ['print', 'json'] as const) it(`${mode}: retains native signed tool/final blocks across process restart`, async () => {
    const test = await fixture(continuationModel, true);
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
        for (const entry of assistants) expect(entry).toMatchObject({ provider: 'anthropic', api: 'anthropic-messages', model: continuationModel });
        expect((await stat(test.journal)).mode & 0o777).toBe(0o600);
      }
      expect(test.bodies).toHaveLength(3);
      expect(test.bodies[1]?.messages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual([continuationContent(1)]);
      expect(test.bodies[2]?.messages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual([continuationContent(1), continuationContent(2)]);
      expect(JSON.stringify(test.bodies[1])).toContain('native-tool-result');
      expect(await readFile(test.effects, 'utf8')).toBe('{"value":1}\n');
    } finally { await test.close(); }
  }, 50_000);

  it('RPC projects signed continuation by physical model and edits only the selected entry', async () => {
    const test = await fixture(continuationModel, true), child = test.start('rpc', 'low');
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
      await command({ type: 'set_model', id: 'foreign', provider: 'anthropic', modelId: adaptive });
      expect((await readFile(test.journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as SessionEntry)
        .filter(entry => entry.type === 'message' && entry.role === 'assistant')).toEqual(original);
      await prompt(3);
      expect(test.bodies[3]?.model).toBe(adaptive);
      expect(assistantWire(3)).toEqual([1, 2, 3].map(turn => [
        { type: 'text', text: `native-${turn}-left` }, { type: 'text', text: `visible-${turn}` },
        { type: 'text', text: `native-${turn}-right` },
        ...(turn === 1 ? [{ type: 'tool_use', id: 'native-call', name: 'continuation_echo', input: { value: 1 } }] : []),
      ]));
      await command({ type: 'set_model', id: 'owner', provider: 'anthropic', modelId: continuationModel });
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
      expect(test.bodies).toHaveLength(5); expect(await readFile(test.effects, 'utf8')).toBe('{"value":1}\n');
      expect(JSON.stringify(records)).not.toContain(continuationKey);
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await test.close(); }
  }, 40_000);

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
