import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const core = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));

describe('emitted native virtual selection', () => {
  it.each(['print', 'json', 'rpc'] as const)('%s dispatches physically and persists branch state, not fake virtual billing', async mode => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-virtual-model-'));
    const cwd = path.join(root, 'project'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
    const trace = path.join(root, 'trace.jsonl');
    try {
      await mkdir(cwd); await mkdir(path.join(agent, 'extensions'), { recursive: true });
      await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ cacheWarming: 'off' }));
      await writeFile(path.join(agent, 'extensions/router.mjs'), `import { MockProvider } from ${JSON.stringify(core)};
        import { appendFileSync } from 'node:fs';
        export default api => {
          api.registerProvider('physical', { defaultConfig: { model: 'physical-model' }, create(config) {
            const provider = new MockProvider(config);
            provider.streamChat = async (messages, chunk, complete, error, options) => {
              appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ kind: 'dispatch', model: options.model, thinking: options.thinking }) + '\\n');
              await chunk('physical-ok'); complete({ content: 'physical-ok', model: 'physical-model', usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } });
            }; return provider;
          } });
          api.registerVirtualModel({ provider: 'router', id: 'auto', thinkingLevels: ['low', 'high'], route(request) {
            appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ kind: 'route', reason: request.reason, thinking: request.thinkingLevel }) + '\\n');
            return { provider: 'physical', id: 'physical-model', thinkingLevel: 'high', state: { phase: 'build' } };
          } });
        };`);
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, '--approve', '--session-dir', sessions, '--model', 'router/auto', '--thinking', 'high',
          ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['route this'])], {
          cwd, env: { ...process.env, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent, AI_HARNESS_EXTENSIONS: '', NO_COLOR: '1' },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
        child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
        child.stdin.end(mode === 'rpc' ? JSON.stringify({ type: 'prompt', id: 'route', message: 'route this' }) + '\n' : '');
      });
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      expect(result.stdout).toContain('physical-ok');
      const records = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(records).toEqual([{ kind: 'route', reason: 'user', thinking: 'high' }, { kind: 'dispatch', model: 'physical-model', thinking: 'off' }]);
      const journals = await readdir(sessions);
      const entries = (await Promise.all(journals.filter(name => name.endsWith('.jsonl')).map(name => readFile(path.join(sessions, name), 'utf8'))))
        .flatMap(text => text.trim().split('\n').map(line => JSON.parse(line)));
      expect(entries).toContainEqual(expect.objectContaining({ type: 'custom', customType: 'provider.router_state', data: expect.objectContaining({ state: { phase: 'build' } }) }));
      expect(entries).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', provider: 'physical', model: 'physical-model' }));
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
