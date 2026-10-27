import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const adaptive = 'claude-sonnet-4-6'; const classic = 'claude-3-7-sonnet-latest';
type Body = { model: string; thinking?: { type: string; budget_tokens?: number }; output_config?: { effort: string }; max_tokens: number;
  messages: Array<{ role: string; content: unknown; output_config?: { effort: string } }> };
const managed = new Set(['claude-fable-5-1', 'claude-haiku-5-5', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
const numeric = new Set(['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-5', 'claude-opus-4-5-20251101', 'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929']);
async function fixture(model = adaptive) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-adaptive-process-'));
  const cwd = path.join(root, 'project'); const agent = path.join(root, 'agent'); const preload = path.join(root, 'network.mjs');
  await Promise.all([mkdir(cwd), mkdir(agent)]);
  await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ thinkingBudgets: { low: 4000, high: Number.MAX_SAFE_INTEGER } }));
  const bodies: Body[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: adaptive }, { id: classic }] })); return;
    }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()) as Body);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'adaptive-ok' } }) + '\n\n');
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
  const env = { ...process.env, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent, AI_HARNESS_EXTENSIONS: '', ANTHROPIC_API_KEY: 'disposable', NO_COLOR: '1' };
  const start = (mode: 'print' | 'json' | 'rpc', thinking: string) => spawn(process.execPath, ['--import', preload, cli,
    '--no-approve', '--no-session', '--model', `anthropic/${model}`, '--thinking', thinking,
    ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['Probe native effort.'])], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); };
  return { bodies, start, close };
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
