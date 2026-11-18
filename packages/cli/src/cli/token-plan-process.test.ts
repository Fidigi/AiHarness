import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
it.each([
  { provider: 'qwen-token-plan-individual', model: 'qwen3.8-flash', mode: 'print', effort: 'xhigh' },
  { provider: 'xiaomi-token-plan-cn', model: 'mimo-v2.5', mode: 'json', effort: 'high' },
  { provider: 'zai-coding-cn', model: 'glm-5.3', mode: 'rpc', effort: 'high' },
] as const)('$provider uses native $mode without registration and preserves its physical C policy', async ({ provider, model, mode, effort }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-plan-cli-'));
  const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
  const key = 'synthetic-native-plan-cli-key', prefix = provider.toUpperCase().replace(/-/g, '_');
  const calls: Array<{ url?: string; auth?: string; body: Record<string, any> }> = [];
  let fixtureError: unknown;
  const wire = createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
      calls.push({ url: request.url, auth: request.headers.authorization, body: JSON.parse(text) });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([{ choices: [{ delta: { content: 'native-plan-cli-ok', reasoning_content: 'plan thought' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid token-plan CLI fixture'); }
  });
  await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  try {
    await mkdir(cwd); await mkdir(agent); await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ cacheWarming: 'off' }));
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, '--approve', '--offline', '--no-extensions', '--session-dir', sessions,
        '--model', `${provider}/${model}`, '--thinking', 'high', ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['hello'])], {
        cwd, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), TMPDIR: root, NO_COLOR: '1', AI_HARNESS_AGENT_DIR: agent,
          [`${prefix}_API_KEY`]: key, [`${prefix}_BASE_URL`]: `http://127.0.0.1:${(wire.address() as { port: number }).port}/plan%2Fowned/v1` }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      child.stdout.setEncoding('utf8').on('data', text => { stdout += text; }); child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
      child.stdin.end(mode === 'rpc' ? [{ type: 'get_state', id: 'plan-state' }, { type: 'prompt', id: 'plan-prompt', message: 'hello' }].map(record => JSON.stringify(record)).join('\n') + '\n' : '');
    });
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(result.stdout).toContain('native-plan-cli-ok'); expect(result.stdout + result.stderr).not.toContain(key);
    if (mode !== 'print') {
      const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
      expect(records.find(record => record.type === 'message_end' && record.message?.role === 'assistant')?.message)
        .toMatchObject({ provider, model, api: 'openai-completions' });
    }
    expect(fixtureError).toBeUndefined(); expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: '/plan%2Fowned/v1/chat/completions', auth: `Bearer ${key}`, body: { model, stream: true, reasoning_effort: effort } });
    if (provider.startsWith('qwen-')) { expect(calls[0].body.enable_thinking).toBe(true); expect(calls[0].body).not.toHaveProperty('thinking'); expect(calls[0].body).not.toHaveProperty('store'); }
    else if (provider.startsWith('xiaomi-')) expect(calls[0].body).toMatchObject({ thinking: { type: 'enabled' }, store: false });
    else expect(calls[0].body).toMatchObject({ thinking: { type: 'enabled', clear_thinking: false }, tool_stream: true });
    expect(calls[0].body).not.toHaveProperty('max_tokens'); expect(calls[0].body).not.toHaveProperty('max_completion_tokens');
    const entries = (await Promise.all((await readdir(sessions)).filter(name => name.endsWith('.jsonl')).map(name => readFile(path.join(sessions, name), 'utf8'))))
      .flatMap(text => text.trim().split('\n').map(line => JSON.parse(line)));
    expect(entries).toContainEqual(expect.objectContaining({ role: 'assistant', provider, model, api: 'openai-completions', usage: expect.objectContaining({ inputTokens: 6, cacheReadTokens: 4, outputTokens: 2, totalTokens: 12 }) }));
    expect(JSON.stringify(entries)).not.toContain(key);
  } finally { wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}, 30_000);
