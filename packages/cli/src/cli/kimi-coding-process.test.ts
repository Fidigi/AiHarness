import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EncryptedCredentialStore, ProviderCredentialService } from '@ai-harness/core';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const core = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));

describe('emitted CLI Kimi Coding composition', () => {
  it.each((['print', 'json', 'rpc'] as const).flatMap(mode => [false, true].flatMap(native => (native ? ['high'] as const : ['off', 'high'] as const).map(thinking => ({ mode, thinking, native })))) )('$mode/$thinking/native=$native conserves physical adaptive thinking, windows and A provenance', async ({ mode, thinking, native }) => {
    const provider = native ? 'kimi-coding' : 'kimi-coding-native';
    const oauth = native && mode === 'json';
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-kimi-coding-cli-'));
    const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
    const key = 'disposable-cli-kimi-coding-key', model = 'k3', api = 'anthropic-messages';
    const selected = thinking === 'off' ? 'low' : thinking;
    const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, unknown> }> = [];
    let fixtureError: unknown;
    const wire = createServer(async (request, response) => {
      try {
        let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
        calls.push({ url: request.url, headers: request.headers, body: JSON.parse(text) });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end([{ type: 'message_start', message: { id: 'message-1', type: 'message', model, usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'native-kimi-coding-cli-ok' } },
          { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' },
        ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
      } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid Kimi Coding CLI fixture'); }
    });
    await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
    try {
      await mkdir(cwd); await mkdir(path.join(agent, 'extensions'), { recursive: true });
      await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ cacheWarming: 'off' }));
      const masterKey = 'synthetic-kimi-cli-only-disposable-master-key';
      if (oauth) {
        const credentials = new ProviderCredentialService({ store: new EncryptedCredentialStore(path.join(agent, 'credentials.enc'), masterKey) });
        await credentials.load();
        await credentials.setOAuth('kimi-coding', { accessToken: key, expiresAt: Date.now() + 120000 });
      }
      if (!native) await writeFile(path.join(agent, 'extensions/kimi-coding.mjs'), `import { KimiCodingProvider } from ${JSON.stringify(core)};
        export default api => api.registerProvider('kimi-coding-native', { defaultConfig: { model:${JSON.stringify(model)},baseUrl:'http://127.0.0.1:${(wire.address() as { port: number }).port}/owned%2Fkimi-coding/anthropic' }, create(config) { return new KimiCodingProvider(config); } });`);
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, '--approve', '--offline', '--session-dir', sessions, ...(native ? ['--no-extensions'] : ['--api-key', key]),
          '--model', `${provider}/${model}`, '--thinking', thinking, ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['hello'])], {
          cwd, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), TMPDIR: root, NO_COLOR: '1', AI_HARNESS_AGENT_DIR: agent,
            ...(native ? { KIMI_CODING_BASE_URL: `http://127.0.0.1:${(wire.address() as { port: number }).port}/owned%2Fkimi-coding/anthropic`,
              ...(oauth ? { AI_HARNESS_MASTER_KEY: masterKey } : { KIMI_CODING_API_KEY: key }) } : {}) }, stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        child.stdout.setEncoding('utf8').on('data', text => { stdout += text; }); child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
        child.stdin.end(mode === 'rpc' ? [{ type: 'get_available_models', id: 'kimi-coding-models' }, { type: 'get_state', id: 'kimi-coding-state' },
          { type: 'get_available_thinking_levels', id: 'kimi-coding-levels' }, { type: 'prompt', id: 'kimi-coding-prompt', message: 'hello' }].map(command => JSON.stringify(command)).join('\n') + '\n' : '');
      });
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      expect(result.stdout).toContain('native-kimi-coding-cli-ok'); expect(result.stdout + result.stderr).not.toContain(key);
      if (mode !== 'print') {
        const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
        expect(records.find(record => record.type === 'message_end' && record.message?.role === 'assistant')?.message.api).toBe(api);
        if (mode === 'rpc') {
          const profile = { id: model, api, name: 'Kimi K3', reasoning: true, input: ['text', 'image'], contextWindow: 1048576, maxTokens: 131072 };
          expect(records.find(record => record.id === 'kimi-coding-state')?.data.model).toMatchObject(profile);
          expect(records.find(record => record.id === 'kimi-coding-state')?.data.thinkingLevel).toBe(selected);
          expect(records.find(record => record.id === 'kimi-coding-levels')?.data.levels).toEqual(['low', 'high', 'max']);
          const models = records.find(record => record.id === 'kimi-coding-models')?.data.models;
          expect(models.filter((entry: { provider: string }) => entry.provider === provider)).toHaveLength(4);
          expect(models).toContainEqual(expect.objectContaining({ provider, ...profile }));
          expect(models).toContainEqual(expect.objectContaining({ provider, id: 'k3-256k', contextWindow: 262144, maxTokens: 131072 }));
        }
      }
      expect(fixtureError).toBeUndefined(); expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ url: '/owned%2Fkimi-coding/anthropic/v1/messages', body: { model, stream: true, max_tokens: 131072,
        thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: selected } } });
      expect(calls[0].headers['x-api-key']).toBe(oauth ? undefined : key);
      expect(calls[0].headers.authorization).toBe(oauth ? `Bearer ${key}` : undefined);
      expect(calls[0].headers['anthropic-version']).toBe('2023-06-01');
      expect(calls[0].headers['anthropic-beta']).toBeUndefined();
      for (const name of ['api-key', 'nvcf-poll-seconds', 'x-session-id']) expect(calls[0].headers[name]).toBeUndefined();
      for (const name of ['reasoning_effort', 'tool_stream', 'store', 'budget_tokens', 'max_completion_tokens']) expect(calls[0].body).not.toHaveProperty(name);
      expect(Array.isArray(calls[0].body.system)).toBe(true);
      for (const tool of calls[0].body.tools as Array<Record<string, unknown>>) { expect(tool.eager_input_streaming).toBe(true); expect(tool).not.toHaveProperty('strict'); }
      const entries = (await Promise.all((await readdir(sessions)).filter(name => name.endsWith('.jsonl')).map(name => readFile(path.join(sessions, name), 'utf8'))))
        .flatMap(text => text.trim().split('\n').map(line => JSON.parse(line)));
      expect(entries).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', provider, model, api,
        usage: expect.objectContaining({ inputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 1, outputTokens: 2, totalTokens: 12 }) })); expect(JSON.stringify(entries)).not.toContain(key);
    } finally { wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
