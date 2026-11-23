import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { spawn as spawnPty } from 'node-pty';
import { describe, expect, it, vi } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const core = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-budget-process-'));
  const cwd = path.join(root, 'project'); const agent = path.join(root, 'agent'); const trace = path.join(root, 'trace');
  const file = async (name: string, text: string) => { await mkdir(path.dirname(name), { recursive: true }); await writeFile(name, text); };
  await file(path.join(agent, 'extensions/probe.mjs'), `import { appendFileSync } from 'node:fs';
    export default api => api.before('before:provider', data => {
      appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ budgets: data.options.thinkingBudgets }) + '\\n');
    });`);
  await file(path.join(agent, 'settings.json'), JSON.stringify({ thinkingBudgets: { low: 2000, medium: 4000 } }));
  await file(path.join(cwd, '.ai-harness/settings.json'), JSON.stringify({ thinkingBudgets: { low: 3000, high: 10000 } }));
  const env = { ...process.env, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent, AI_HARNESS_EXTENSIONS: '', NO_COLOR: '1' };
  const records = async () => (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { budgets?: Record<string, number> });
  return { root, cwd, agent, trace, file, env, records };
}
function run(args: string[], cwd: string, env: NodeJS.ProcessEnv, input = '') {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 20_000);
    child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stdout, stderr }); });
    child.stdin.end(input);
  });
}

describe('emitted CLI thinking-budget composition', () => {
  for (const mode of ['print', 'json', 'rpc'] as const) for (const trusted of [true, false]) {
    it(`${mode}: exposes only ${trusted ? 'merged trusted project' : 'independent global'} budgets to provider hooks`, async () => {
      const test = await fixture();
      try {
        const args = [cli, trusted ? '--approve' : '--no-approve', '--no-session', '--model', 'mock/mock-model',
          ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['Probe budgets.'])];
        const result = await run(args, test.cwd, test.env, mode === 'rpc' ? JSON.stringify({ type: 'prompt', id: 'probe', message: 'Probe budgets.' }) + '\n' : '');
        expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
        expect(result.stdout.trim()).not.toBe('');
        if (mode !== 'print') {
          const records = result.stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
          expect(records.every(record => typeof record.type === 'string')).toBe(true);
          if (mode === 'rpc') expect(records).toContainEqual(expect.objectContaining({ type: 'response', id: 'probe', success: true }));
        }
        expect(await test.records()).toEqual([{ budgets: trusted ? { low: 3000, medium: 4000, high: 10000 } : { low: 2000, medium: 4000 } }]);
      } finally { await rm(test.root, { recursive: true, force: true }); }
    }, 30_000);
  }

  for (const mode of ['print', 'json', 'rpc'] as const) it(`${mode}: delivers configured budgets to an actual emitted numeric adapter HTTP request`, async () => {
    const test = await fixture(); const bodies: unknown[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()) as unknown);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'numeric-ok' } }) + '\n\n');
    });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      await test.file(path.join(test.agent, 'extensions/numeric.mjs'), `import { AnthropicProvider } from ${JSON.stringify(core)};
        export default api => api.registerProvider('budget-probe', { defaultConfig: { model: 'claude-3-7-sonnet-latest' },
          create(config) { return new AnthropicProvider({ ...config, type: 'anthropic', apiKey: 'disposable', baseUrl: ${JSON.stringify(baseUrl)} }); } });`);
      const result = await run([cli, '--approve', '--no-session', '--model', 'budget-probe/claude-3-7-sonnet-latest', '--thinking', 'low',
        ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['Probe budgets.'])], test.cwd, test.env,
      mode === 'rpc' ? JSON.stringify({ type: 'prompt', id: 'numeric', message: 'Probe budgets.' }) + '\n' : '');
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      expect(result.stdout).toContain('numeric-ok');
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 3000 } });
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(test.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('interactive PTY reload refreshes the budget snapshot for the next provider turn', async () => {
    const test = await fixture(); let terminal: ReturnType<typeof spawnPty> | undefined;
    let exited: { exitCode: number; signal?: number } | undefined;
    try {
      terminal = spawnPty(process.execPath, [cli, '--approve', '--no-session', '--name', 'budget-probe', '--model', 'mock/mock-model', '--tui-mode', 'regular'], {
        cwd: test.cwd, cols: 100, rows: 30, name: 'xterm-256color', env: test.env,
      });
      let output = ''; terminal.onData(text => { output += text; }); terminal.onExit(result => { exited = result; });
      await vi.waitFor(() => expect(output).toContain('budget-probe: '), { timeout: 10_000 });
      const prompt = async () => {
        output = ''; terminal!.write('Probe budgets.\r');
        await vi.waitFor(() => expect(output).toContain('editor ready · Enter send'), { timeout: 10_000 });
        await vi.waitFor(() => expect(output).toContain('budget-probe: '), { timeout: 10_000 });
      };
      await prompt();
      await test.file(path.join(test.cwd, '.ai-harness/settings.json'), JSON.stringify({ thinkingBudgets: { low: 6000, high: 12000 } }));
      await prompt(); // Disk edits alone do not replace the active settings generation.
      output = ''; terminal.write('/reload\r');
      await vi.waitFor(() => expect(output).toContain('Reloaded '), { timeout: 10_000 });
      await vi.waitFor(() => expect(output).toContain('budget-probe: '), { timeout: 10_000 });
      await prompt();
      expect(await test.records()).toEqual([
        { budgets: { low: 3000, medium: 4000, high: 10000 } },
        { budgets: { low: 3000, medium: 4000, high: 10000 } },
        { budgets: { low: 6000, medium: 4000, high: 12000 } },
      ]);
      terminal.write('/quit\r');
      await vi.waitFor(() => expect(exited).toMatchObject({ exitCode: 0 }), { timeout: 10_000 });
    } finally { if (terminal && !exited) terminal.kill(); await rm(test.root, { recursive: true, force: true }); }
  }, 45_000);

  it('admits public readonly budgets and executes emitted Core outside the checkout', async () => {
    const test = await fixture();
    try {
      const consumer = path.join(test.root, 'consumer.mts');
      await test.file(consumer, `import assert from 'node:assert/strict';
        import { MockProvider, ExtensionRegistry, streamProviderTurn, type ThinkingBudgets, type ChatOptions,
          type AgentSettings, type StreamProviderTurnOptions } from ${JSON.stringify(core)};
        const budgets: ThinkingBudgets = Object.freeze({ low: 2000 });
        const options: ChatOptions = { thinking: 'low', thinkingBudgets: budgets };
        const settings: AgentSettings = { thinkingBudgets: { low: 1000 } };
        settings.thinkingBudgets!.low = 2000; assert.deepEqual(settings.thinkingBudgets, budgets);
        const invalidMutation = (value: ThinkingBudgets) => {
          // @ts-expect-error provider budget declarations are readonly; existing settings remain mutable
          value.low = 1234;
        }; void invalidMutation;
        // @ts-expect-error only four numeric budget levels are public
        const invalid: ThinkingBudgets = { max: 2000 }; void invalid;
        // @ts-expect-error numeric budgets cannot be strings
        const invalidValue: ThinkingBudgets = { low: '2000' }; void invalidValue;
        const provider = new MockProvider({ type: 'mock' }); const registry = new ExtensionRegistry();
        await registry.load('probe', api => api.before('before:provider', data => {
          assert.deepEqual(data.options.thinkingBudgets, budgets); assert.notEqual(data.options.thinkingBudgets, budgets);
          assert.equal(Reflect.set(data.options.thinkingBudgets!, 'low', 2100), true);
        }));
        provider.streamChat = async (...args: Parameters<MockProvider['streamChat']>) => {
          assert.deepEqual(args[4]?.thinkingBudgets, { low: 2100 }); args[2]?.({ content: 'ok' });
        };
        const turn: StreamProviderTurnOptions = { ...options, provider, providerName: 'mock', messages: [], tools: [], extensionRegistry: registry };
        assert.equal((await streamProviderTurn(turn)).content, 'ok'); assert.equal(budgets.low, 2000);
        console.log('public thinking budgets verified');`);
      await promisify(execFile)(process.execPath, [path.resolve('node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck',
        '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--typeRoots', path.resolve('node_modules/@types'), consumer], { timeout: 30_000 });
      const result = await run([consumer], test.root, test.env);
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stdout: 'public thinking budgets verified\n' });
    } finally { await rm(test.root, { recursive: true, force: true }); }
  }, 40_000);
});
