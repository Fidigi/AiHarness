import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const core = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));
const profiles = [
  { id: 'claude-haiku-5-5', api: 'anthropic-messages', name: 'Claude Haiku 5.5', contextWindow: 1000000, maxTokens: 128000, input: ['text', 'image'], cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 } },
  { id: 'glm-5.3', api: 'openai-completions', name: 'GLM-5.3', contextWindow: 1000000, maxTokens: 131072, input: ['text'], cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 } },
  { id: 'gpt-6-luna', api: 'openai-responses', name: 'GPT-6 Luna', contextWindow: 1050000, maxTokens: 128000, input: ['text', 'image'], cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 } },
];

describe('emitted CLI explicit mixed OpenCode Go registration', () => {
  it.each((['print', 'json', 'rpc'] as const).flatMap(mode => (['off', 'high'] as const).flatMap(thinking => profiles.map(profile => ({ mode, thinking, profile })))))('$profile.api/$mode/$thinking conserves actual-adapter API, clamps and durable provenance', async ({ mode, thinking, profile }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-opencode-go-cli-')), cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions'), key = 'disposable-cli-opencode-go-key', { id: model, api } = profile, a = api === 'anthropic-messages', r = api === 'openai-responses', selected = !a && !r && thinking === 'off' ? 'low' : thinking;
    const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, any> }> = [];
    let fixtureError: unknown;
    const wire = createServer(async (request, response) => {
      try {
        let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
        calls.push({ url: request.url, headers: request.headers, body: JSON.parse(text) }); response.writeHead(200, { 'content-type': 'text/event-stream' });
        const values = a ? [{ type: 'message_start', message: { id: 'answer', model, usage: { input_tokens: 5, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'native-opencode-go-cli-ok' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }]
          : r ? [{ type: 'response.output_text.delta', delta: 'native-opencode-go-cli-ok' }, { type: 'response.completed', response: { id: 'answer', model, usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } } } }]
            : [{ model, choices: [{ delta: { content: 'native-opencode-go-cli-ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } } }];
        response.end(values.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + (!a && !r ? 'data: [DONE]\n\n' : ''));
      } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid OpenCode Go CLI fixture'); }
    });
    await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
    try {
      await mkdir(cwd); await mkdir(path.join(agent, 'extensions'), { recursive: true }); await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ cacheWarming: 'off' }));
      await writeFile(path.join(agent, 'extensions/opencode-go.mjs'), `import { OpenCodeGoProvider } from ${JSON.stringify(core)}; export default api => api.registerProvider('opencode-go-native', { defaultConfig: { model:${JSON.stringify(model)},baseUrl:'http://127.0.0.1:${(wire.address() as { port: number }).port}/owned%2Fgo' }, create(config) { return new OpenCodeGoProvider(config); } });`);
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, '--approve', '--offline', '--session-dir', sessions, '--api-key', key, '--model', `opencode-go-native/${model}`, '--thinking', thinking, ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['hello'])], { cwd, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), TMPDIR: root, NO_COLOR: '1', AI_HARNESS_AGENT_DIR: agent }, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        child.stdout.setEncoding('utf8').on('data', text => { stdout += text; }); child.stderr.setEncoding('utf8').on('data', text => { stderr += text; }); child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
        child.stdin.end(mode === 'rpc' ? [{ type: 'get_available_models', id: 'go-models' }, { type: 'get_state', id: 'go-state' }, { type: 'get_available_thinking_levels', id: 'go-levels' }, { type: 'prompt', id: 'go-prompt', message: 'hello' }].map(command => JSON.stringify(command)).join('\n') + '\n' : '');
      });
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null }); expect(result.stdout).toContain('native-opencode-go-cli-ok'); expect(result.stdout + result.stderr).not.toContain(key);
      if (mode !== 'print') { const records = result.stdout.trim().split('\n').map(line => JSON.parse(line)); expect(records.find(record => record.type === 'message_end' && record.message?.role === 'assistant')?.message.api).toBe(api); if (mode === 'rpc') { expect(records.find(record => record.id === 'go-state')?.data.model).toMatchObject({ ...profile, reasoning: true }); expect(records.find(record => record.id === 'go-state')?.data.thinkingLevel).toBe(selected); expect(records.find(record => record.id === 'go-levels')?.data.levels).toEqual(a ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] : r ? ['off', 'low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'high', 'max']); expect(records.find(record => record.id === 'go-models')?.data.models.filter((entry: { provider: string }) => entry.provider === 'opencode-go-native')).toHaveLength(31); } }
      expect(fixtureError).toBeUndefined(); expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ url: '/owned%2Fgo/v1/' + (a ? 'messages' : r ? 'responses' : 'chat/completions'), body: { model, stream: true } }); expect(calls[0].headers['x-opencode-session']).toEqual(expect.any(String)); expect(calls[0].headers.session_id).toBeUndefined(); expect(calls[0].headers['session-id']).toBeUndefined();
      if (a) { expect(calls[0].headers['x-api-key']).toBe(key); expect(calls[0].body).toMatchObject({ max_tokens: 128000, thinking: thinking === 'off' ? { type: 'disabled' } : { type: 'adaptive', display: 'summarized' } }); expect(calls[0].body.output_config).toEqual(thinking === 'off' ? undefined : { effort: 'high' }); }
      else { expect(calls[0].headers.authorization).toBe(`Bearer ${key}`); if (r) { expect(calls[0].body.reasoning).toEqual(thinking === 'off' ? { effort: 'none' } : { effort: 'high', summary: 'auto' }); expect(calls[0].body.include).toEqual(thinking === 'off' ? undefined : ['reasoning.encrypted_content']); expect(calls[0].headers['x-client-request-id']).toBe(calls[0].headers['x-opencode-session']); } else { expect(calls[0].body.reasoning_effort).toBe(selected); expect(calls[0].body).not.toHaveProperty('thinking'); } expect(calls[0].body).not.toHaveProperty('max_tokens'); }
      const entries = (await Promise.all((await readdir(sessions)).filter(name => name.endsWith('.jsonl')).map(name => readFile(path.join(sessions, name), 'utf8')))).flatMap(text => text.trim().split('\n').map(line => JSON.parse(line)));
      expect(entries).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', provider: 'opencode-go-native', model, api, usage: expect.objectContaining({ inputTokens: 5, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12 }) })); expect(JSON.stringify(entries)).not.toContain(key);
    } finally { wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
