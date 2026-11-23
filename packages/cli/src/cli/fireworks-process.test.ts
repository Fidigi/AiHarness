import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const core = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));

describe('emitted CLI explicit mixed Fireworks registration', () => {
  it.each((['print','json','rpc'] as const).flatMap(mode => (['off','high'] as const).flatMap(thinking => (['anthropic-messages','openai-completions'] as const).map(api => ({ mode, thinking, api })))))('$api/$mode/$thinking conserves native wire, actual-adapter clamps and durable physical provenance', async ({ mode, thinking, api }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-fireworks-cli-'));
    const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
    const key = 'disposable-cli-fireworks-key', a = api === 'anthropic-messages', model = 'accounts/fireworks/models/' + (a ? 'deepseek-v4p1-flash' : 'glm-5p3'), selected = !a && thinking === 'off' ? 'low' : thinking;
    const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, unknown> }> = [];
    let fixtureError: unknown;
    const wire = createServer(async (request, response) => {
      try {
        let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
        calls.push({ url: request.url, headers: request.headers, body: JSON.parse(text) });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const events = a ? [{ type: 'message_start', message: { id: 'answer', model, role: 'assistant', content: [], usage: { input_tokens: 5, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Native thought' } }, { type: 'content_block_stop', index: 0 }, { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'native-fireworks-cli-ok' } }, { type: 'content_block_stop', index: 1 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }]
          : [{ model, choices: [{ index: 0, delta: { reasoning_content: 'Native thought', content: 'native-fireworks-cli-ok' } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } } }];
        response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (a ? '' : 'data: [DONE]\n\n'));
      } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid Fireworks CLI fixture'); }
    });
    await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
    try {
      await mkdir(cwd); await mkdir(path.join(agent, 'extensions'), { recursive: true });
      await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ cacheWarming: 'off' }));
      await writeFile(path.join(agent, 'extensions/fireworks.mjs'), `import { FireworksProvider } from ${JSON.stringify(core)};
        export default api => api.registerProvider('fireworks-native', { defaultConfig: { model:${JSON.stringify(model)},baseUrl:'http://127.0.0.1:${(wire.address() as { port: number }).port}/owned%2Ffireworks/inference/v1' }, create(config) { return new FireworksProvider(config); } });`);
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, '--approve', '--offline', '--session-dir', sessions, '--api-key', key,
          '--model', `fireworks-native/${model}`, '--thinking', thinking, ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['hello'])], {
          cwd, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), TMPDIR: root, NO_COLOR: '1', AI_HARNESS_AGENT_DIR: agent }, stdio: ['pipe','pipe','pipe'],
        });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        child.stdout.setEncoding('utf8').on('data', text => { stdout += text; }); child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
        child.stdin.end(mode === 'rpc' ? [{ type: 'get_available_models', id: 'fireworks-models' },{ type: 'get_state', id: 'fireworks-state' },{ type: 'get_available_thinking_levels', id: 'fireworks-levels' },{ type: 'prompt', id: 'fireworks-prompt', message: 'hello' }].map(command => JSON.stringify(command)).join('\n') + '\n' : '');
      });
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null }); expect(result.stdout).toContain('native-fireworks-cli-ok'); expect(result.stdout + result.stderr).not.toContain(key);
      if (mode !== 'print') {
        const records = result.stdout.trim().split('\n').map(line => JSON.parse(line)); expect(records.find(record => record.type === 'message_end' && record.message?.role === 'assistant')?.message.api).toBe(api);
        if (mode === 'rpc') {
          const profile = { id: model, api, name: a ? 'DeepSeek V4.1 Flash' : 'GLM 5.3', reasoning: true, input: a ? ['text','image'] : ['text'], contextWindow: a ? 1000000 : 1048573, maxTokens: a ? 384000 : 262144, cost: a ? { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 } : { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 } };
          expect(records.find(record => record.id === 'fireworks-state')?.data.model).toMatchObject(profile); expect(records.find(record => record.id === 'fireworks-state')?.data.thinkingLevel).toBe(selected); expect(records.find(record => record.id === 'fireworks-levels')?.data.levels).toEqual(a ? ['off','low','high','max'] : ['low','high','max']);
          const models = records.find(record => record.id === 'fireworks-models')?.data.models; expect(models.filter((entry: { provider: string }) => entry.provider === 'fireworks-native')).toHaveLength(22); expect(models).toContainEqual(expect.objectContaining({ provider: 'fireworks-native', ...profile }));
        }
      }
      expect(fixtureError).toBeUndefined(); expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ url: '/owned%2Ffireworks/inference/v1/' + (a ? 'messages' : 'chat/completions'), body: { model, stream: true } });
      if (a) { expect(calls[0].body).toMatchObject({ max_tokens: 384000, thinking: thinking === 'off' ? { type: 'disabled' } : { type: 'adaptive', display: 'summarized' } }); if (thinking === 'high') expect(calls[0].body.output_config).toEqual({ effort: 'high' }); else expect(calls[0].body).not.toHaveProperty('output_config'); expect(calls[0].headers['x-api-key']).toBe(key); expect(calls[0].headers['anthropic-version']).toBe('2023-06-01'); expect(calls[0].headers.authorization).toBeUndefined(); expect(calls[0].headers.session_id).toBeUndefined(); expect(calls[0].headers['x-client-request-id']).toBeUndefined(); }
      else { expect(calls[0].body).toMatchObject({ reasoning_effort: selected, stream_options: { include_usage: true } }); expect(calls[0].body).not.toHaveProperty('max_tokens'); expect(calls[0].body).not.toHaveProperty('thinking'); expect(calls[0].headers.authorization).toBe(`Bearer ${key}`); expect(calls[0].headers['x-api-key']).toBeUndefined(); expect(calls[0].headers.session_id).toBe(calls[0].headers['x-session-affinity']); expect(calls[0].headers['x-client-request-id']).toBe(calls[0].headers['x-session-affinity']); }
      expect(calls[0].headers['x-session-affinity']).toEqual(expect.any(String)); for (const key of ['max_completion_tokens','chat_template_args','chat_template_kwargs','store','prompt_cache_key','prompt_cache_retention']) expect(calls[0].body).not.toHaveProperty(key);
      const entries = (await Promise.all((await readdir(sessions)).filter(name => name.endsWith('.jsonl')).map(name => readFile(path.join(sessions, name), 'utf8')))).flatMap(text => text.trim().split('\n').map(line => JSON.parse(line)));
      expect(entries).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', provider: 'fireworks-native', model, api, usage: expect.objectContaining({ inputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 1, outputTokens: 2, totalTokens: 12 }) })); expect(JSON.stringify(entries)).not.toContain(key);
    } finally { wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
