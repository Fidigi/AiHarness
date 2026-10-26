import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const core = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));

describe('emitted CLI custom Mistral dialect', () => {
  it.each([['print', 'mistral'], ['json', 'mistral'], ['rpc', 'mistral'], ['rpc', 'operator-mistral']] as const)('%s uses explicit %s registration, environment credential resolution and durable accounting', async (mode, alias) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-mistral-cli-'));
    const cwd = path.join(root, 'project'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
    const calls: Array<{ url?: string; authorization?: string; body: Record<string, unknown> }> = [];
    let fixtureError: unknown;
    const upstream = createServer(async (request, response) => {
      try {
        let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
        calls.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(text) });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end([
          { model: 'magistral-medium-latest', choices: [{ delta: { content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'native thought' }] }, { type: 'text', text: 'native-mistral-ok' }] } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, num_cached_tokens: 3 } },
        ].map(item => `data: ${JSON.stringify(item)}\n\n`).join('') + 'data: [DONE]\n\n');
      } catch (error) { fixtureError = error; response.writeHead(500); response.end('Invalid Mistral fixture'); }
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    try {
      await mkdir(cwd); await mkdir(path.join(agent, 'extensions'), { recursive: true });
      await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ cacheWarming: 'off' }));
      await writeFile(path.join(agent, 'extensions/mistral.mjs'), `import { MistralProvider } from ${JSON.stringify(core)};
        export default api => api.registerProvider('${alias}', { defaultConfig: { model: 'magistral-medium-latest' },
          create(config) { return new MistralProvider({ ...config, baseUrl: 'http://127.0.0.1:${(upstream.address() as { port: number }).port}' }); } });`);
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, '--approve', '--offline', '--session-dir', sessions,
          '--model', `${alias}/magistral-medium-latest`, '--thinking', 'high', ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['hello'])], {
          cwd, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), TMPDIR: root, NO_COLOR: '1', AI_HARNESS_AGENT_DIR: agent,
            [`${alias.toUpperCase().replaceAll('-', '_')}_API_KEY`]: 'disposable-cli-mistral-key' }, stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
        child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
        child.stdin.end(mode === 'rpc' ? [
          { type: 'get_available_models', id: 'mistral-models' }, { type: 'get_state', id: 'mistral-state' },
          { type: 'get_available_thinking_levels', id: 'mistral-levels' },
          { type: 'prompt', id: 'mistral-prompt', message: 'hello' },
        ].map(command => JSON.stringify(command)).join('\n') + '\n' : '');
      });
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      expect(result.stdout).toContain('native-mistral-ok'); expect(result.stdout + result.stderr).not.toContain('disposable-cli-mistral-key');
      if (mode !== 'print') {
        const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
        const assistant = records.find(record => record.type === 'message_end' && record.message?.role === 'assistant');
        expect(assistant?.message.api).toBe('mistral-conversations');
        if (mode === 'rpc') {
          expect(records.find(record => record.id === 'mistral-state')?.data).toMatchObject({ thinkingLevel: 'high',
            model: { provider: alias, api: 'mistral-conversations', contextWindow: 262144, maxTokens: 16384 } });
          expect(records.find(record => record.id === 'mistral-levels')?.data.levels).toEqual(['off', 'high']);
          const available = records.find(record => record.id === 'mistral-models')?.data.models;
          expect(available.filter((model: { provider: string }) => model.provider === alias)).toHaveLength(40);
          expect(available.filter((model: { provider: string }) => model.provider === alias)
            .every((model: { api: string }) => model.api === 'mistral-conversations')).toBe(true);
        }
      }
      expect(fixtureError).toBeUndefined();
      expect(calls).toEqual([expect.objectContaining({ url: '/v1/chat/completions', authorization: 'Bearer disposable-cli-mistral-key',
        body: expect.objectContaining({ model: 'magistral-medium-latest', stream: true, reasoning_effort: 'high' }) })]);
      const entries = (await Promise.all((await readdir(sessions)).filter(name => name.endsWith('.jsonl')).map(name => readFile(path.join(sessions, name), 'utf8'))))
        .flatMap(text => text.trim().split('\n').map(line => JSON.parse(line)));
      expect(entries).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', provider: alias, model: 'magistral-medium-latest', api: 'mistral-conversations',
        usage: expect.objectContaining({ inputTokens: 7, cacheReadTokens: 3, outputTokens: 2, totalTokens: 12 }) }));
      expect(JSON.stringify(entries)).toContain('native thought'); expect(JSON.stringify(entries)).not.toContain('disposable-cli-mistral-key');
    } finally {
      upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
