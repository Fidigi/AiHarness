import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const core = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));

describe('emitted CLI explicit OpenRouter composition', () => {
  it.each((['print', 'json', 'rpc'] as const).flatMap(mode => (mode === 'rpc' ? [false, true] : [false]).flatMap(native => [
    { mode, model: 'anthropic/claude-sonnet-4.6', api: 'anthropic-messages', native },
    { mode, model: 'google/gemini-3-pro-image', api: 'openai-completions', native },
  ])))('$mode/native=$native preserves $api and explicit credential composition', async ({ mode, model, api, native }) => {
    const provider = native ? 'openrouter' : 'router-native';
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-router-cli-'));
    const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
    const key = 'disposable-cli-router-key';
    const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, unknown> }> = [];
    let fixtureError: unknown;
    const wire = createServer(async (request, response) => {
      try {
        let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
        calls.push({ url: request.url, headers: request.headers, body: JSON.parse(text) });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const events = api === 'anthropic-messages' ? [
          { type: 'message_start', message: { model, usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 1, cache_creation: { ephemeral_1h_input_tokens: 1 } } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'native-router-cli-ok' } },
          { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' },
        ] : [{ model, choices: [{ index: 0, delta: { content: 'native-router-cli-ok' } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } } }];
        response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (api === 'openai-completions' ? 'data: [DONE]\n\n' : ''));
      } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid OpenRouter CLI fixture'); }
    });
    await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
    try {
      await mkdir(cwd); await mkdir(path.join(agent, 'extensions'), { recursive: true });
      await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ cacheWarming: 'off' }));
      if (!native) await writeFile(path.join(agent, 'extensions/router.mjs'), `import { OpenRouterProvider } from ${JSON.stringify(core)};
        export default api => api.registerProvider('router-native', { defaultConfig: { model:'openai/gpt-4o',baseUrl:'http://127.0.0.1:${(wire.address() as { port: number }).port}/proxy/api' }, create(config) { return new OpenRouterProvider(config); } });`);
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, '--approve', '--offline', '--session-dir', sessions, ...(native ? ['--no-extensions'] : ['--api-key', key]),
          '--model', `${provider}/${model}`, '--thinking', 'off', ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['hello'])], {
          cwd, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), TMPDIR: root, NO_COLOR: '1', AI_HARNESS_AGENT_DIR: agent,
            ...(native ? { OPENROUTER_API_KEY: key, OPENROUTER_BASE_URL: `http://127.0.0.1:${(wire.address() as { port: number }).port}/proxy/api` } : {}) }, stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        child.stdout.setEncoding('utf8').on('data', text => { stdout += text; }); child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
        child.stdin.end(mode === 'rpc' ? [{ type: 'get_available_models', id: 'router-models' }, { type: 'get_state', id: 'router-state' },
          { type: 'prompt', id: 'router-prompt', message: 'hello' }].map(command => JSON.stringify(command)).join('\n') + '\n' : '');
      });
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      expect(result.stdout).toContain('native-router-cli-ok'); expect(result.stdout + result.stderr).not.toContain(key);
      if (mode !== 'print') {
        const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
        expect(records.find(record => record.type === 'message_end' && record.message?.role === 'assistant')?.message.api).toBe(api);
        if (mode === 'rpc') {
          const profile = api === 'anthropic-messages'
            ? { id: model, api, name: 'Anthropic: Claude Sonnet 4.6', reasoning: true, input: ['text', 'image'], contextWindow: 1000000, maxTokens: 128000,
              cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }
            : { id: model, api, name: 'Google: Nano Banana Pro (Gemini 3 Pro Image)', reasoning: true, input: ['text', 'image'], contextWindow: 65536, maxTokens: 32768,
              cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0.375 } };
          expect(records.find(record => record.id === 'router-state')?.data.model).toMatchObject(profile);
          const models = records.find(record => record.id === 'router-models')?.data.models;
          expect(models.filter((entry: { provider: string }) => entry.provider === provider)).toHaveLength(393);
          expect(models).toContainEqual(expect.objectContaining({ provider, ...profile }));
        }
      }
      expect(fixtureError).toBeUndefined(); expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ url: `/proxy/api/v1/${api === 'anthropic-messages' ? 'messages' : 'chat/completions'}`, body: { model, stream: true } });
      if (api === 'anthropic-messages') { expect(calls[0]?.headers['x-api-key']).toBe(key); expect(calls[0]?.headers.authorization).toBeUndefined(); }
      else { expect(calls[0]?.headers.authorization).toBe(`Bearer ${key}`); expect(calls[0]?.headers['x-api-key']).toBeUndefined(); }
      const entries = (await Promise.all((await readdir(sessions)).filter(name => name.endsWith('.jsonl')).map(name => readFile(path.join(sessions, name), 'utf8'))))
        .flatMap(text => text.trim().split('\n').map(line => JSON.parse(line)));
      expect(entries).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', provider, model, api,
        usage: expect.objectContaining({ inputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 1, outputTokens: 2, totalTokens: 12 }) }));
      expect(JSON.stringify(entries)).not.toContain(key);
    } finally { wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
