import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const core = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));

describe('emitted CLI explicit Cloudflare composition', () => {
  it.each((['print', 'json', 'rpc'] as const).flatMap(mode => [false, true].map(native => ({ mode, native }))))('$mode/native=$native preserves C provenance and explicit credential composition', async ({ mode, native }) => {
    const provider = native ? 'cloudflare-workers-ai' : 'cf-native';
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-cf-cli-'));
    const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
    const key = 'disposable-cli-cf-key', model = '@cf/deepseek-ai/deepseek-v4-flash-0731', api = 'openai-completions';
    const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, unknown> }> = [];
    let fixtureError: unknown;
    const wire = createServer(async (request, response) => {
      try {
        let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
        calls.push({ url: request.url, headers: request.headers, body: JSON.parse(text) });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end([{ model, choices: [{ index: 0, delta: { content: 'native-cf-cli-ok' } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } } },
        ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
      } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid Cloudflare CLI fixture'); }
    });
    await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
    try {
      await mkdir(cwd); await mkdir(path.join(agent, 'extensions'), { recursive: true });
      await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ cacheWarming: 'off' }));
      if (!native) await writeFile(path.join(agent, 'extensions/cloudflare.mjs'), `import { CloudflareWorkersAiMixedProvider } from ${JSON.stringify(core)};
        export default api => api.registerProvider('cf-native', { defaultConfig: { model:${JSON.stringify(model)},baseUrl:'http://127.0.0.1:${(wire.address() as { port: number }).port}/proxy/accounts/explicit/ai/run' }, create(config) { return new CloudflareWorkersAiMixedProvider(config); } });`);
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, '--approve', '--offline', '--session-dir', sessions, ...(native ? ['--no-extensions'] : ['--api-key', key]),
          '--model', `${provider}/${model}`, '--thinking', 'off', ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['hello'])], {
          cwd, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), TMPDIR: root, NO_COLOR: '1', AI_HARNESS_AGENT_DIR: agent,
            ...(native ? { CLOUDFLARE_WORKERS_AI_API_KEY: key, CLOUDFLARE_WORKERS_AI_BASE_URL: `http://127.0.0.1:${(wire.address() as { port: number }).port}/proxy/accounts/explicit/ai/run` } : {}) }, stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        child.stdout.setEncoding('utf8').on('data', text => { stdout += text; }); child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
        child.stdin.end(mode === 'rpc' ? [{ type: 'get_available_models', id: 'cf-models' }, { type: 'get_state', id: 'cf-state' },
          { type: 'prompt', id: 'cf-prompt', message: 'hello' }].map(command => JSON.stringify(command)).join('\n') + '\n' : '');
      });
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      expect(result.stdout).toContain('native-cf-cli-ok'); expect(result.stdout + result.stderr).not.toContain(key);
      if (mode !== 'print') {
        const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
        expect(records.find(record => record.type === 'message_end' && record.message?.role === 'assistant')?.message.api).toBe(api);
        if (mode === 'rpc') {
          const profile = { id: model, api, name: 'DeepSeek V4 Flash 0731', reasoning: true, input: ['text'], contextWindow: 1048576, maxTokens: 1048576,
            cost: { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 } };
          expect(records.find(record => record.id === 'cf-state')?.data.model).toMatchObject(profile);
          const models = records.find(record => record.id === 'cf-models')?.data.models;
          expect(models.filter((entry: { provider: string }) => entry.provider === provider)).toHaveLength(18);
          expect(models).toContainEqual(expect.objectContaining({ provider, ...profile }));
        }
      }
      expect(fixtureError).toBeUndefined(); expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ url: '/proxy/accounts/explicit/ai/v1/chat/completions', body: { model, stream: true } });
      expect(calls[0]?.headers.authorization).toBe(`Bearer ${key}`);
      for (const name of ['x-api-key', 'api-key', 'anthropic-version', 'cf-aig-authorization']) expect(calls[0]?.headers[name]).toBeUndefined();
      const entries = (await Promise.all((await readdir(sessions)).filter(name => name.endsWith('.jsonl')).map(name => readFile(path.join(sessions, name), 'utf8'))))
        .flatMap(text => text.trim().split('\n').map(line => JSON.parse(line)));
      expect(entries).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', provider, model, api,
        usage: expect.objectContaining({ inputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 1, outputTokens: 2, totalTokens: 12 }) }));
      expect(JSON.stringify(entries)).not.toContain(key);
    } finally { wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
