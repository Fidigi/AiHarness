import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const adaptive = 'claude-sonnet-4-6'; const classic = 'claude-3-7-sonnet-latest';
type Body = { model: string; thinking?: { type: string; budget_tokens?: number }; output_config?: { effort: string }; max_tokens: number };
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

describe('emitted built-in Anthropic adaptive selection', () => {
  for (const mode of ['print', 'json', 'rpc'] as const) for (const [model, level, effort, maximum] of [
    [adaptive, 'minimal', 'low', 2048], [adaptive, 'max', 'max', 33792],
    [adaptive, 'xhigh', 'max', 33792], [adaptive, 'off', undefined, 1024],
    ['claude-fable-5', 'xhigh', 'xhigh', 17408],
    ['claude-opus-4-6', 'xhigh', 'max', 33792],
    ['claude-opus-4-7', 'xhigh', 'xhigh', 17408],
    ['claude-opus-4-8', 'xhigh', 'xhigh', 17408],
    ['claude-sonnet-4-6', 'high', 'high', 9216],
    ['claude-sonnet-5', 'xhigh', 'xhigh', 17408],
    ['claude-fable-5', 'off', 'low', 2048],
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
        if (mode !== 'print') expect(stdout.trim().split('\n').map(line => JSON.parse(line) as { type: string }).every(record => typeof record.type === 'string')).toBe(true);
        expect(test.bodies).toHaveLength(1);
        expect(test.bodies[0]?.thinking).toEqual(effort ? { type: 'adaptive', display: 'summarized' } : { type: 'disabled' });
        expect(test.bodies[0]?.output_config).toEqual(effort ? { effort } : undefined);
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
        [adaptive, { type: 'adaptive', display: 'summarized' }, { effort: 'low' }, 2048],
        [adaptive, { type: 'adaptive', display: 'summarized' }, { effort: 'max' }, 33792],
        [classic, { type: 'enabled', budget_tokens: 32768 }, undefined, 33792],
        [adaptive, { type: 'adaptive', display: 'summarized' }, { effort: 'high' }, 9216],
        [adaptive, { type: 'disabled' }, undefined, 1024],
      ]);
      child.stdin.end(); expect(await ended, stderr).toEqual({ code: 0, signal: null }); expect(buffer).toBe('');
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await test.close(); }
  }, 40_000);
});
