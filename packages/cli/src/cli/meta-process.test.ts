import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const core = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));
const cases = (['print', 'json', 'rpc'] as const).flatMap(mode => (['off', 'high'] as const).map(thinking => [mode, thinking] as const));

describe('emitted CLI explicit native Meta SDK', () => {
  it.each(cases)('%s %s uses physical R policy and actual-adapter clamping through trusted registration', async (mode, thinking) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-meta-cli-'));
    const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
    const key = 'disposable-cli-meta-key', model = 'muse-spark-1.3', api = 'openai-responses', selected = thinking === 'off' ? 'minimal' : 'high';
    const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, unknown> }> = [];
    let fixtureError: unknown;
    const wire = createServer(async (request, response) => {
      try {
        expect(request.method).toBe('POST');
        let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
        calls.push({ url: request.url, headers: request.headers, body: JSON.parse(text) });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end([{ type: 'response.reasoning_summary_text.delta', delta: 'Native thought' }, { type: 'response.output_text.delta', delta: 'native-meta-cli-ok' },
          { type: 'response.completed', response: { id: 'native-meta-cli-response', model, usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } } } },
        ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
      } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid Meta CLI fixture'); }
    });
    wire.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'));
    await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
    try {
      await mkdir(cwd); await mkdir(path.join(agent, 'extensions'), { recursive: true });
      await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ cacheWarming: 'off' }));
      await writeFile(path.join(agent, 'extensions/meta.mjs'), `import { MetaProvider } from ${JSON.stringify(core)};
        export default api => api.registerProvider('meta-native', { defaultConfig: { transport:'sse',model:${JSON.stringify(model)},baseUrl:'http://127.0.0.1:${(wire.address() as { port: number }).port}/proxy%2Fowned/v1/responses' }, create(config) { return new MetaProvider(config); } });`);
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, '--approve', '--offline', '--session-dir', sessions, '--api-key', key,
          '--model', `meta-native/${model}`, '--thinking', thinking, ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['hello'])], {
          cwd, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), TMPDIR: root, NO_COLOR: '1', AI_HARNESS_AGENT_DIR: agent }, stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        child.stdout.setEncoding('utf8').on('data', text => { stdout += text; }); child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
        child.stdin.end(mode === 'rpc' ? [{ type: 'get_available_models', id: 'meta-models' }, { type: 'get_state', id: 'meta-state' },
          { type: 'prompt', id: 'meta-prompt', message: 'hello' }].map(command => JSON.stringify(command)).join('\n') + '\n' : '');
      });
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null }); expect(result.stdout).toContain('native-meta-cli-ok'); expect(result.stdout + result.stderr).not.toContain(key);
      if (mode !== 'print') {
        const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
        expect(records.find(record => record.type === 'message_end' && record.message?.role === 'assistant')?.message.api).toBe(api);
        if (mode === 'rpc') {
          const profile = { id: model, api, name: 'Muse Spark 1.3', reasoning: true, input: ['text', 'image'], contextWindow: 1048576, maxTokens: 131072,
            cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 } };
          expect(records.find(record => record.id === 'meta-state')?.data.model).toMatchObject(profile); expect(records.find(record => record.id === 'meta-state')?.data.thinkingLevel).toBe(selected);
          const models = records.find(record => record.id === 'meta-models')?.data.models;
          expect(models.filter((entry: { provider: string }) => entry.provider === 'meta-native')).toHaveLength(6);
          expect(models).toContainEqual(expect.objectContaining({ provider: 'meta-native', ...profile }));
        }
      }
      expect(fixtureError).toBeUndefined(); expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ url: '/proxy%2Fowned/v1/responses', body: { model, stream: true, store: false, reasoning: { effort: selected, summary: 'auto' }, include: ['reasoning.encrypted_content'] } }); expect(calls[0]?.headers.authorization).toBe(`Bearer ${key}`);
      expect(calls[0].body).not.toHaveProperty('prompt_cache_retention'); expect(calls[0].body).not.toHaveProperty('prompt_cache_options');
      for (const name of ['x-api-key', 'api-key', 'anthropic-version', 'cf-aig-authorization', 'nvcf-poll-seconds']) expect(calls[0]?.headers[name]).toBeUndefined();
      const entries = (await Promise.all((await readdir(sessions)).filter(name => name.endsWith('.jsonl')).map(name => readFile(path.join(sessions, name), 'utf8')))).flatMap(text => text.trim().split('\n').map(line => JSON.parse(line)));
      expect(entries).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', provider: 'meta-native', model, api,
        usage: expect.objectContaining({ inputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 1, outputTokens: 2, totalTokens: 12 }) }));
      expect(JSON.stringify(entries)).not.toContain(key);
    } finally { wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
