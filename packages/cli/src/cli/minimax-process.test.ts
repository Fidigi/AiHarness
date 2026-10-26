import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const core = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));

describe.each([
  { region: 'global', constructor: 'MiniMaxProvider', registration: 'minimax-native' },
  { region: 'CN', constructor: 'MiniMaxCnProvider', registration: 'minimax-cn-native' },
])('emitted CLI explicit MiniMax $region registration', ({ constructor, registration }) => {
  it.each((['print', 'json', 'rpc'] as const).flatMap(mode => (['off', 'high'] as const).map(thinking => ({ mode, thinking }))))('$mode/$thinking conserves physical numeric thinking, windows and A provenance', async ({ mode, thinking }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-minimax-cli-'));
    const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
    const key = 'disposable-cli-minimax-key', model = 'MiniMax-M2.7', api = 'anthropic-messages';
    const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, unknown> }> = [];
    let fixtureError: unknown;
    const wire = createServer(async (request, response) => {
      try {
        let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
        calls.push({ url: request.url, headers: request.headers, body: JSON.parse(text) });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end([{ type: 'message_start', message: { id: 'message-1', type: 'message', model, usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'native-minimax-cli-ok' } },
          { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' },
        ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
      } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid MiniMax CLI fixture'); }
    });
    await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
    try {
      await mkdir(cwd); await mkdir(path.join(agent, 'extensions'), { recursive: true });
      await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ cacheWarming: 'off' }));
      await writeFile(path.join(agent, 'extensions/minimax.mjs'), `import { ${constructor} } from ${JSON.stringify(core)};
        export default api => api.registerProvider(${JSON.stringify(registration)}, { defaultConfig: { model:${JSON.stringify(model)},baseUrl:'http://127.0.0.1:${(wire.address() as { port: number }).port}/owned%2Fminimax/anthropic' }, create(config) { return new ${constructor}(config); } });`);
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, '--approve', '--offline', '--session-dir', sessions, '--api-key', key,
          '--model', `${registration}/${model}`, '--thinking', thinking, ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['hello'])], {
          cwd, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), TMPDIR: root, NO_COLOR: '1', AI_HARNESS_AGENT_DIR: agent }, stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        child.stdout.setEncoding('utf8').on('data', text => { stdout += text; }); child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
        child.stdin.end(mode === 'rpc' ? [{ type: 'get_available_models', id: 'minimax-models' }, { type: 'get_state', id: 'minimax-state' },
          { type: 'get_available_thinking_levels', id: 'minimax-levels' }, { type: 'prompt', id: 'minimax-prompt', message: 'hello' }].map(command => JSON.stringify(command)).join('\n') + '\n' : '');
      });
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      expect(result.stdout).toContain('native-minimax-cli-ok'); expect(result.stdout + result.stderr).not.toContain(key);
      if (mode !== 'print') {
        const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
        expect(records.find(record => record.type === 'message_end' && record.message?.role === 'assistant')?.message.api).toBe(api);
        if (mode === 'rpc') {
          const profile = { id: model, api, name: model, reasoning: true, input: ['text'], contextWindow: 204800, maxTokens: 131072 };
          expect(records.find(record => record.id === 'minimax-state')?.data.model).toMatchObject(profile);
          expect(records.find(record => record.id === 'minimax-state')?.data.thinkingLevel).toBe(thinking);
          expect(records.find(record => record.id === 'minimax-levels')?.data.levels).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
          const models = records.find(record => record.id === 'minimax-models')?.data.models;
          expect(models.filter((entry: { provider: string }) => entry.provider === registration)).toHaveLength(3);
          expect(models).toContainEqual(expect.objectContaining({ provider: registration, ...profile }));
          expect(models).toContainEqual(expect.objectContaining({ provider: registration, id: 'MiniMax-M3', contextWindow: 1000000, maxTokens: 512000 }));
        }
      }
      expect(fixtureError).toBeUndefined(); expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ url: '/owned%2Fminimax/anthropic/v1/messages', body: { model, stream: true, max_tokens: 131072,
        thinking: thinking === 'off' ? { type: 'disabled' } : { type: 'enabled', budget_tokens: 16384, display: 'summarized' } } });
      expect(calls[0].headers['x-api-key']).toBe(key); expect(calls[0].headers['anthropic-version']).toBe('2023-06-01');
      expect(calls[0].headers['anthropic-beta']).toBe(thinking === 'off' ? undefined : 'interleaved-thinking-2025-05-14');
      for (const name of ['authorization', 'api-key', 'nvcf-poll-seconds', 'x-session-id']) expect(calls[0].headers[name]).toBeUndefined();
      for (const name of ['output_config', 'reasoning_effort', 'tool_stream', 'store']) expect(calls[0].body).not.toHaveProperty(name);
      expect(Array.isArray(calls[0].body.system)).toBe(true);
      for (const tool of calls[0].body.tools as Array<Record<string, unknown>>) { expect(tool.eager_input_streaming).toBe(true); expect(tool).not.toHaveProperty('strict'); }
      const entries = (await Promise.all((await readdir(sessions)).filter(name => name.endsWith('.jsonl')).map(name => readFile(path.join(sessions, name), 'utf8'))))
        .flatMap(text => text.trim().split('\n').map(line => JSON.parse(line)));
      expect(entries).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', provider: registration, model, api,
        usage: expect.objectContaining({ inputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 1, outputTokens: 2, totalTokens: 12 }) })); expect(JSON.stringify(entries)).not.toContain(key);
    } finally { wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
