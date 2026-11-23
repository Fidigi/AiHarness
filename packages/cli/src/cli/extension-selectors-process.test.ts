import { execFile, spawn } from 'node:child_process';
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-selector-process-[literal]-'));
  const cwd = path.join(root, 'project'); const agent = path.join(root, 'agent'); const trace = path.join(root, 'trace');
  const file = async (name: string, text: string) => { await mkdir(path.dirname(name), { recursive: true }); await writeFile(name, text); };
  const factory = (name: string) => `import { appendFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(trace)}, ${JSON.stringify(`import:${name}\n`)});
    export default api => { api.registerOption(${JSON.stringify(`selected-${name}`)}, { type: 'boolean', description: 'Selected fixture' });
      api.before('before:provider', () => { appendFileSync(${JSON.stringify(trace)}, ${JSON.stringify(`turn:${name}\n`)}); }); };`;
  await file(path.join(agent, 'extensions/automatic.mjs'), 'throw new Error("excluded automatic module executed");');
  await file(path.join(agent, 'extensions/kept.mjs'), factory('automatic'));
  await file(path.join(agent, 'more/nested/global.mjs'), factory('global'));
  await file(path.join(agent, 'more/nested/restored.mjs'), factory('restored'));
  await file(path.join(agent, 'more/nested/entry[1].mjs'), factory('literal'));
  await file(path.join(agent, 'more/nested/blocked.mjs'), 'throw new Error("excluded glob module executed");');
  await file(path.join(agent, 'settings.json'), JSON.stringify({ extensions: [
    'more/**/*.mjs', '!extensions/automatic.mjs', '!more/**/blocked.mjs', '!more/**/restored.mjs',
    '!more/**/entry*.mjs', '+more/nested/entry[1].mjs',
  ] }));
  await file(path.join(cwd, '.ai-harness/settings.json'), JSON.stringify({ extensions: [
    `+${path.join(agent, 'more/nested/restored.mjs')}`, 'selected/**/*.mjs', '!selected/**/blocked.mjs',
  ] }));
  await file(path.join(cwd, '.ai-harness/selected/deep/project.mjs'), factory('project'));
  await file(path.join(cwd, '.ai-harness/selected/deep/blocked.mjs'), 'throw new Error("excluded project module executed");');
  return { root, cwd, agent, trace, file };
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

describe('emitted CLI extension settings selection', () => {
  for (const mode of ['print', 'json', 'rpc'] as const) for (const trusted of [true, false]) for (const contributed of [true, false]) {
    it(`${mode}: ${contributed ? 'contributed-option' : 'ordinary'} startup applies discovered-file selectors and ${trusted ? 'merges' : 'refuses'} project settings`, async () => {
      const test = await fixture();
      try {
        const flags = [cli, trusted ? '--approve' : '--no-approve', '--no-session', '--model', 'mock/mock-model',
          ...(contributed ? ['--selected-global', '--selected-literal', ...(trusted ? ['--selected-restored', '--selected-project'] : [])] : [])];
        const env = { ...process.env, HOME: path.join(test.root, 'home'), AI_HARNESS_AGENT_DIR: test.agent, AI_HARNESS_EXTENSIONS: '', NO_COLOR: '1' };
        const result = await run([...flags, ...(mode === 'print' ? ['--print'] : ['--mode', mode]),
          ...(mode === 'rpc' ? [] : ['Describe selector evidence.'])], test.cwd, env,
        mode === 'rpc' ? JSON.stringify({ type: 'prompt', id: 'probe', message: 'Describe selector evidence.' }) + '\n' : '');
        expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
        expect(result.stdout.trim()).not.toBe('');
        if (mode !== 'print') {
          const records = result.stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
          expect(records.every(record => typeof record.type === 'string')).toBe(true);
          if (mode === 'rpc') expect(records).toContainEqual(expect.objectContaining({ type: 'response', id: 'probe', success: true }));
        }
        const names = trusted ? ['automatic', 'global', 'literal', 'project', 'restored'] : ['automatic', 'global', 'literal'];
        const trace = (await readFile(test.trace, 'utf8')).trim().split('\n');
        expect(trace.filter(line => line.startsWith('import:')).sort()).toEqual(names.map(name => `import:${name}`).sort());
        expect(trace.filter(line => line.startsWith('turn:')).sort()).toEqual(names.map(name => `turn:${name}`).sort());
        expect(result.stderr).not.toContain('excluded');
      } finally { await rm(test.root, { recursive: true, force: true }); }
    }, 30_000);
  }

  it('interactive reload rereads selectors without losing independent agent-directory automatic entries', async () => {
    const test = await fixture();
    let terminal: ReturnType<typeof spawnPty> | undefined;
    let exited: { exitCode: number; signal?: number } | undefined;
    try {
      await test.file(path.join(test.agent, 'extensions/auto-kept.mjs'), `import { appendFileSync } from 'node:fs';
        appendFileSync(${JSON.stringify(test.trace)}, 'import:auto\\n');
        export default api => api.registerCommand('selector-evidence', { description: 'Probe', handler: () => 'AUTO-SELECTOR-READY' });`);
      terminal = spawnPty(process.execPath, [cli, '--approve', '--no-session', '--name', 'selector-probe', '--model', 'mock/mock-model', '--tui-mode', 'regular', '--selected-literal'], {
        cwd: test.cwd, cols: 100, rows: 30, name: 'xterm-256color',
        env: { ...process.env, HOME: path.join(test.root, 'home'), AI_HARNESS_AGENT_DIR: test.agent, AI_HARNESS_EXTENSIONS: '', NO_COLOR: '1' },
      });
      let output = '';
      terminal.onData(text => { output += text; });
      terminal.onExit(result => { exited = result; });
      await vi.waitFor(() => expect(output).toContain('selector-probe: '), { timeout: 10_000 });
      terminal.write('/selector-evidence\r');
      await vi.waitFor(() => expect(output).toContain('AUTO-SELECTOR-READY'), { timeout: 10_000 });
      const settings = JSON.parse(await readFile(path.join(test.agent, 'settings.json'), 'utf8')) as { extensions: string[] };
      settings.extensions.push('!more/**/global.mjs', 'after/**/*.mjs');
      await test.file(path.join(test.agent, 'settings.json'), JSON.stringify(settings));
      await test.file(path.join(test.agent, 'after/new.mjs'), `import { appendFileSync } from 'node:fs';
        appendFileSync(${JSON.stringify(test.trace)}, 'import:after\\n'); export default () => {};`);
      await writeFile(test.trace, '');
      output = ''; terminal.write('/reload\r');
      await vi.waitFor(() => expect(output).toContain('Reloaded '), { timeout: 10_000 });
      terminal.write('/selector-evidence\r');
      await vi.waitFor(() => expect(output).toContain('AUTO-SELECTOR-READY'), { timeout: 10_000 });
      expect((await readFile(test.trace, 'utf8')).trim().split('\n').sort()).toEqual([
        'import:after', 'import:auto', 'import:automatic', 'import:literal', 'import:project', 'import:restored',
      ]);
      terminal.write('/quit\r');
      await vi.waitFor(() => expect(exited).toMatchObject({ exitCode: 0 }), { timeout: 10_000 });
    } finally {
      if (terminal && !exited) terminal.kill();
      await rm(test.root, { recursive: true, force: true });
    }
  }, 45_000);

  it('admits the public readonly selector declaration and exercises emitted Core reload outside the checkout', async () => {
    const test = await fixture();
    try {
      const selected = path.join(test.agent, 'standalone/selected.mjs');
      await test.file(selected, 'export default api => api.registerCommand("public-selected", { description: "Public", handler: () => "public" });');
      const consumer = path.join(test.root, 'consumer.mts');
      await test.file(consumer, `
        import assert from 'node:assert/strict';
        import { ExtensionModuleLoader, ExtensionRegistry, type ExtensionModuleLoaderOptions, type ExtensionModuleSelector } from ${JSON.stringify(core)};
        let selectors: readonly ExtensionModuleSelector[] = [{ pattern: 'standalone/**/*.mjs', baseDir: ${JSON.stringify(test.agent)} }];
        const options: ExtensionModuleLoaderOptions = { cwd: ${JSON.stringify(test.cwd)}, includeGlobalLocation: false,
          includeProjectLocation: false, selectors: async () => selectors };
        // @ts-expect-error a selector is a list, never a shell command string
        const invalid: ExtensionModuleLoaderOptions = { selectors: 'echo forbidden' };
        void invalid;
        const registry = new ExtensionRegistry(); const loader = new ExtensionModuleLoader(registry, options);
        assert.equal((await loader.loadAll()).committed, true);
        assert.deepEqual(registry.getCommands().map(command => command.name), ['public-selected']);
        selectors = [...selectors, ${JSON.stringify(`-${selected}`)}];
        assert.equal((await loader.reload()).committed, true);
        assert.deepEqual(registry.getCommands(), []);
        console.log('public selector reload verified');
      `);
      await promisify(execFile)(process.execPath, [path.resolve('node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck',
        '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--typeRoots', path.resolve('node_modules/@types'), consumer], { timeout: 30_000 });
      const result = await run([consumer], test.root, { ...process.env, AI_HARNESS_EXTENSIONS: '' });
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stdout: 'public selector reload verified\n' });
    } finally { await rm(test.root, { recursive: true, force: true }); }
  }, 40_000);
});
