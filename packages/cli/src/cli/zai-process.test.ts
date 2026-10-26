import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const core = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));

describe('emitted CLI explicit Z.ai registration', () => {
  it.each((['print', 'json', 'rpc'] as const).flatMap(mode => (['off', 'high'] as const).map(thinking => ({ mode, thinking }))))('$mode/$thinking conserves physical effort, windows and C provenance', async ({ mode, thinking }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-zai-cli-'));
    const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
    const key = 'disposable-cli-zai-key', model = 'glm-5.3-flash', api = 'openai-completions', effective = thinking === 'off' ? 'low' : 'high';
    const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, unknown> }> = [];
    let fixtureError: unknown;
    const wire = createServer(async (request, response) => {
      try {
        let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
        calls.push({ url: request.url, headers: request.headers, body: JSON.parse(text) });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end([{ model, choices: [{ index: 0, delta: { reasoning_content: 'Native thought', content: 'native-zai-cli-ok' } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } },
        ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
      } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid Z.ai CLI fixture'); }
    });
    await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
    try {
      await mkdir(cwd); await mkdir(path.join(agent, 'extensions'), { recursive: true });
      await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ cacheWarming: 'off' }));
      await writeFile(path.join(agent, 'extensions/zai.mjs'), `import { ZaiProvider } from ${JSON.stringify(core)};
        export default api => api.registerProvider('zai-native', { defaultConfig: { model:${JSON.stringify(model)},baseUrl:'http://127.0.0.1:${(wire.address() as { port: number }).port}/owned%2Fzai/api/coding/paas/v4' }, create(config) { return new ZaiProvider(config); } });`);
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, '--approve', '--offline', '--session-dir', sessions, '--api-key', key,
          '--model', `zai-native/${model}`, '--thinking', thinking, ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['hello'])], {
          cwd, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), TMPDIR: root, NO_COLOR: '1', AI_HARNESS_AGENT_DIR: agent }, stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        child.stdout.setEncoding('utf8').on('data', text => { stdout += text; }); child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
        child.stdin.end(mode === 'rpc' ? [{ type: 'get_available_models', id: 'zai-models' }, { type: 'get_state', id: 'zai-state' },
          { type: 'get_available_thinking_levels', id: 'zai-levels' }, { type: 'prompt', id: 'zai-prompt', message: 'hello' }].map(command => JSON.stringify(command)).join('\n') + '\n' : '');
      });
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      expect(result.stdout).toContain('native-zai-cli-ok'); expect(result.stdout + result.stderr).not.toContain(key);
      if (mode !== 'print') {
        const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
        expect(records.find(record => record.type === 'message_end' && record.message?.role === 'assistant')?.message.api).toBe(api);
        if (mode === 'rpc') {
          const profile = { id: model, api, name: 'GLM-5.3-Flash', reasoning: true, input: ['text', 'image'], contextWindow: 1000000, maxTokens: 131072,
            cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 } };
          expect(records.find(record => record.id === 'zai-state')?.data.model).toMatchObject(profile);
          expect(records.find(record => record.id === 'zai-state')?.data.thinkingLevel).toBe(effective);
          expect(records.find(record => record.id === 'zai-levels')?.data.levels).toEqual(['low', 'high', 'max']);
          const models = records.find(record => record.id === 'zai-models')?.data.models;
          expect(models.filter((entry: { provider: string }) => entry.provider === 'zai-native')).toHaveLength(7);
          expect(models).toContainEqual(expect.objectContaining({ provider: 'zai-native', ...profile }));
          const unpriced = models.find((entry: { provider: string; id: string }) => entry.provider === 'zai-native' && entry.id === 'glm-5.3-highspeed');
          expect(unpriced).toMatchObject({ name: 'GLM-5.3 Highspeed', contextWindow: 1000000, maxTokens: 131072, input: ['text'] }); expect(unpriced).not.toHaveProperty('cost');
        }
      }
      expect(fixtureError).toBeUndefined(); expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ url: '/owned%2Fzai/api/coding/paas/v4/chat/completions', body: { model, stream: true, max_tokens: 131072, reasoning_effort: effective, thinking: { type: 'enabled', clear_thinking: false }, tool_stream: true, stream_options: { include_usage: true } } });
      expect(calls[0].body).not.toHaveProperty('max_completion_tokens'); expect(calls[0].body).not.toHaveProperty('store');
      expect(calls[0].body.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'system' })]));
      expect(calls[0]?.headers.authorization).toBe(`Bearer ${key}`);
      for (const name of ['x-api-key', 'api-key', 'anthropic-version']) expect(calls[0]?.headers[name]).toBeUndefined();
      const entries = (await Promise.all((await readdir(sessions)).filter(name => name.endsWith('.jsonl')).map(name => readFile(path.join(sessions, name), 'utf8'))))
        .flatMap(text => text.trim().split('\n').map(line => JSON.parse(line)));
      expect(entries).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', provider: 'zai-native', model, api,
        usage: expect.objectContaining({ inputTokens: 6, cacheReadTokens: 4, outputTokens: 2, totalTokens: 12 }) })); expect(JSON.stringify(entries)).not.toContain(key);
    } finally { wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
