import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const core = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));

it.each(['print', 'json', 'rpc'] as const)('%s resumes a saved missing router on its witnessed physical model', async mode => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-router-resume-'));
  const cwd = path.join(root, 'project'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
  try {
    await mkdir(cwd); await mkdir(path.join(agent, 'extensions'), { recursive: true });
    await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ cacheWarming: 'off' }));
    const physical = `import { MockProvider } from ${JSON.stringify(core)};
      export default api => {
        api.registerProvider('physical', { defaultConfig: { model: 'native' }, create(config) {
          const provider = new MockProvider(config);
          provider.streamChat = async (messages, chunk, complete, error, options) => {
            if (options.model !== 'native') throw new Error('Wrong physical model');
            await chunk('resumed physically'); complete({ content: 'resumed physically', model: 'native' });
          }; return provider;
        } });
      };`;
    const extension = path.join(agent, 'extensions/physical.mjs');
    await writeFile(extension, physical);
    const router = path.join(agent, 'extensions/router.mjs');
    await writeFile(router, `export default api => api.registerVirtualModel({ provider: 'router', id: 'auto',
      route: () => ({ provider: 'physical', id: 'native', state: { phase: 'saved' } }) });`);
    const run = (args: string[], input = '') => new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, '--offline', '--approve', '--session-dir', sessions, ...args], {
        cwd, env: { ...process.env, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent, AI_HARNESS_EXTENSIONS: '', NO_COLOR: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
      child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
      child.stdin.end(input);
    });
    const first = await run(['--print', '--model', 'router/auto', 'start']);
    expect(first, first.stderr).toMatchObject({ code: 0, signal: null });
    const file = (await readdir(sessions)).find(name => name.endsWith('.jsonl'))!;
    await rm(router);
    await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ cacheWarming: 'off', defaultProvider: 'router', defaultModel: 'auto' }));
    const second = await run(['--session', path.join(sessions, file),
      ...(mode === 'print' ? ['--print', 'continue'] : mode === 'json' ? ['--mode', 'json', 'continue'] : ['--mode', 'rpc'])],
      mode === 'rpc' ? JSON.stringify({ type: 'prompt', id: 'continue', message: 'continue' }) + '\n' : '');
    expect(second, second.stderr).toMatchObject({ code: 0, signal: null });
    expect(second.stdout).toContain('resumed physically');
    expect(second.stderr).toContain('Saved virtual router unavailable');
    const entries = (await readFile(path.join(sessions, file), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const replies = entries.filter(entry => entry.type === 'message' && entry.role === 'assistant');
    expect(replies).toHaveLength(2);
    expect(replies.at(-1)).toMatchObject({ provider: 'physical', model: 'native' });
    expect(entries.filter(entry => entry.customType === 'provider.router_state')).toHaveLength(1);
    const third = await run(['--session', path.join(sessions, file), '--print', 'continue again']);
    expect(third, third.stderr).toMatchObject({ code: 0, signal: null });
    expect(third.stdout).toContain('resumed physically');
    expect(third.stderr).not.toContain('Saved virtual router unavailable');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
