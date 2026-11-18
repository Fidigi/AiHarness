import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const core = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));

describe('emitted CLI explicit Cerebras registration', () => {
  it.each((['extension', 'builtin'] as const).flatMap(composition => (['print', 'json', 'rpc'] as const).flatMap(mode => (['off', 'high'] as const).map(thinking => ({ composition, mode, thinking,
    name: `${composition === 'builtin' ? 'native builtin ' : ''}${mode}/${thinking} conserves native C wire, owned windows and durable provenance`,
  })))))('$name', async ({ mode, thinking, composition }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-cerebras-cli-'));
    const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
    const key = 'disposable-cli-cerebras-key', model = 'qwen-3.8-27b', api = 'openai-completions';
    const providerName = composition === 'builtin' ? 'cerebras' : 'cerebras-native';
    const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, unknown> }> = [];
    let fixtureError: unknown;
    const wire = createServer(async (request, response) => {
      try {
        let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
        calls.push({ url: request.url, headers: request.headers, body: JSON.parse(text) });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end([{ model, choices: [{ index: 0, delta: { reasoning_content: 'Native thought', content: 'native-cerebras-cli-ok' } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } } },
        ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
      } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid Cerebras CLI fixture'); }
    });
    await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
    try {
      await mkdir(cwd); await mkdir(path.join(agent, 'extensions'), { recursive: true });
      await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ cacheWarming: 'off',
        ...(composition === 'builtin' ? { defaultProvider: providerName, defaultModel: model } : {}),
      }));
      if (composition === 'extension') {
        await writeFile(path.join(agent, 'extensions/cerebras.mjs'), `import { CerebrasProvider } from ${JSON.stringify(core)};
          export default api => api.registerProvider('cerebras-native', { defaultConfig: { model:${JSON.stringify(model)},baseUrl:'http://127.0.0.1:${(wire.address() as { port: number }).port}/owned%2Fcerebras/v1' }, create(config) { return new CerebrasProvider(config); } });`);
      } else expect(await readdir(path.join(agent, 'extensions'))).toEqual([]);
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, '--approve', '--offline', '--session-dir', sessions,
          ...(composition === 'extension' ? ['--api-key', key, '--model', `${providerName}/${model}`] : []),
          '--thinking', thinking, ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['hello'])], {
          cwd, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), TMPDIR: root, NO_COLOR: '1', AI_HARNESS_AGENT_DIR: agent,
            ...(composition === 'builtin' ? { CEREBRAS_API_KEY: key, CEREBRAS_MODEL: 'gpt-oss-120b',
              CEREBRAS_BASE_URL: `http://127.0.0.1:${(wire.address() as { port: number }).port}/owned%2Fcerebras/v1` } : {}),
          }, stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        child.stdout.setEncoding('utf8').on('data', text => { stdout += text; }); child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
        child.stdin.end(mode === 'rpc' ? [{ type: 'get_available_models', id: 'cerebras-models' }, { type: 'get_state', id: 'cerebras-state' },
          { type: 'get_available_thinking_levels', id: 'cerebras-levels' },
          { type: 'prompt', id: 'cerebras-prompt', message: 'hello' }].map(command => JSON.stringify(command)).join('\n') + '\n' : '');
      });
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      expect(result.stdout).toContain('native-cerebras-cli-ok'); expect(result.stdout + result.stderr).not.toContain(key);
      if (mode !== 'print') {
        const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
        expect(records.find(record => record.type === 'message_end' && record.message?.role === 'assistant')?.message.api).toBe(api);
        if (mode === 'rpc') {
          const profile = { id: model, api, name: 'Qwen3.8 27B', reasoning: true, input: ['text', 'image'], contextWindow: 131072, maxTokens: 40960,
            cost: { input: 0.99, output: 1.49, cacheRead: 0.99, cacheWrite: 0 } };
          expect(records.find(record => record.id === 'cerebras-state')?.data.model).toMatchObject(profile);
          expect(records.find(record => record.id === 'cerebras-state')?.data.thinkingLevel).toBe(thinking);
          expect(records.find(record => record.id === 'cerebras-levels')?.data.levels).toEqual(['off', 'low', 'medium', 'high']);
          const models = records.find(record => record.id === 'cerebras-models')?.data.models;
          expect(models.filter((entry: { provider: string }) => entry.provider === providerName)).toHaveLength(2);
          expect(models).toContainEqual(expect.objectContaining({ provider: providerName, ...profile }));
        }
      }
      expect(fixtureError).toBeUndefined(); expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ url: '/owned%2Fcerebras/v1/chat/completions', body: { model, stream: true, max_completion_tokens: 40960, reasoning_effort: thinking === 'off' ? 'none' : 'high', stream_options: { include_usage: true } } });
      expect(calls[0].body).not.toHaveProperty('max_tokens');
      expect(calls[0]?.headers.authorization).toBe(`Bearer ${key}`);
      for (const name of ['x-api-key', 'api-key', 'anthropic-version']) expect(calls[0]?.headers[name]).toBeUndefined();
      const entries = (await Promise.all((await readdir(sessions)).filter(name => name.endsWith('.jsonl')).map(name => readFile(path.join(sessions, name), 'utf8'))))
        .flatMap(text => text.trim().split('\n').map(line => JSON.parse(line)));
      expect(entries).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', provider: providerName, model, api,
        usage: expect.objectContaining({ inputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 1, outputTokens: 2, totalTokens: 12 }) }));
      expect(JSON.stringify(entries)).not.toContain(key);
    } finally { wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
