import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { spawn as spawnPty } from 'node-pty';
import { PluginService, ProjectTrustManager, WorkspaceManager } from '@ai-harness/core';
import { describe, expect, it, vi } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const core = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));
const mcp = fileURLToPath(new URL('../../../core/src/mcp/fixtures/test-server.mjs', import.meta.url));
const names = ['mcp', 'codemode', 'tool-search'];
type Record = { kind: string; name?: string; pid?: number; tools?: string[]; flag?: boolean };
async function fixture(baits = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-builtins-process-'));
  const cwd = path.join(root, 'project'); const agent = path.join(root, 'agent'); const trace = path.join(root, 'trace'); const probe = path.join(root, 'probe.mjs');
  const file = async (name: string, body: string) => { await mkdir(path.dirname(name), { recursive: true }); await writeFile(name, body); };
  const append = `import { appendFileSync } from 'node:fs'; const record = value => appendFileSync(${JSON.stringify(trace)}, JSON.stringify(value) + '\\n');`;
  await file(probe, `${append}
    record({kind:'import',name:'probe'});
    export default api => {
      record({kind:'factory',name:'probe'});
      api.registerOption('builtin-probe', { type:'boolean', description:'Probe ownership', default:false });
      api.registerTool({ name:'deferred_docs', description:'Search reference docs', exposure:'deferred', parameters:{type:'object'}, execute:()=>({content:'docs'}) });
      api.before('before:provider', data => { record({kind:'turn',flag:api.getOption('builtin-probe'),tools:(data.options.tools ?? []).map(tool=>tool.name).sort()}); });
    };`);
  const marker = path.join(root, 'mcp-marker.mjs');
  await file(marker, `${append} record({kind:'mcp',pid:process.pid});`);
  const global = { extensions: names.map(name => `-builtin:${name}`), codemode: { enabled: true } };
  await file(path.join(agent, 'settings.json'), JSON.stringify(global));
  await file(path.join(cwd, '.ai-harness/settings.json'), JSON.stringify({ extensions: names.map(name => `+builtin:${name}`) }));
  await file(path.join(agent, 'mcp.json'), JSON.stringify({ version: 1, mcpServers: { fixture: {
    command: process.execPath, args: ['--import', marker, mcp], toolExposure: { lookup: 'deferred' },
  } } }));
  const env = { ...process.env, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent, AI_HARNESS_EXTENSIONS: '', NO_COLOR: '1' };
  if (baits) {
    const bait = (name: string) => `${append} record({kind:'import',name:${JSON.stringify(name)}}); export default () => {};`;
    await file(path.join(agent, 'extensions/auto.mjs'), bait('global'));
    await file(path.join(cwd, '.ai-harness/extensions/auto.mjs'), bait('project'));
    await file(path.join(agent, 'configured.mjs'), bait('settings'));
    await file(path.join(root, 'environment.mjs'), bait('environment')); env.AI_HARNESS_EXTENSIONS = path.join(root, 'environment.mjs');
    await file(path.join(agent, 'settings.json'), JSON.stringify({ ...global, extensions: [...global.extensions, 'configured.mjs'] }));
    const pkg = path.join(cwd, 'package');
    await file(path.join(pkg, 'package.json'), JSON.stringify({ name: '@fixture/builtin-switches', version: '1.0.0', type: 'module' }));
    await file(path.join(pkg, 'extensions/index.js'), bait('package'));
    const workspaces = new WorkspaceManager({ allowedRoots: [cwd], defaultCwd: cwd }); await workspaces.initialize();
    const trust = new ProjectTrustManager(path.join(agent, 'trust.json')); await trust.load(); await trust.trust(cwd);
    const plugins = new PluginService(workspaces, trust, path.join(agent, 'plugins.json'), agent); await plugins.load();
    const installed = await plugins.install({ cwd, scope: 'global', source: pkg });
    expect(installed.packages[0]?.counts.extensions).toBe(1);
  }
  const records = async (): Promise<Record[]> => (await readFile(trace, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record);
  return { root, cwd, agent, probe, env, records, file };
}
function run(args: string[], cwd: string, env: NodeJS.ProcessEnv, input = '') {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }); let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.setEncoding('utf8').on('data', text => { stdout += text; }); child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); }); child.stdin.end(input);
  });
}
async function invoke(test: Awaited<ReturnType<typeof fixture>>, mode: 'print' | 'json' | 'rpc', trusted: boolean, flags: string[] = []) {
  const result = await run([cli, trusted ? '--approve' : '--no-approve', '--no-session', '--model', 'mock/mock-model', '-e', test.probe,
    ...flags, ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['Hello.'])], test.cwd, test.env,
  mode === 'rpc' ? JSON.stringify({ type: 'prompt', id: 'probe', message: 'Hello.' }) + '\n' : '');
  expect(result, result.stderr).toMatchObject({ code: 0, signal: null }); expect(result.stdout.trim()).not.toBe('');
  if (mode !== 'print') expect(result.stdout.trim().split('\n').map(line => JSON.parse(line) as { type: string }).every(record => typeof record.type === 'string')).toBe(true);
  return test.records();
}
function assertTools(records: Record[], enabled: readonly string[]) {
  expect(records.filter(record => record.kind === 'factory')).toEqual([{ kind: 'factory', name: 'probe' }]);
  const turns = records.filter(record => record.kind === 'turn'); expect(turns).toHaveLength(1);
  const tools = turns[0]!.tools!; expect(tools).toContain('read');
  for (const [name, tool] of [['mcp', 'mcp__fixture__mutate'], ['codemode', 'codemode'], ['tool-search', 'tool_search']]) expect(tools.includes(tool!)).toBe(enabled.includes(name!));
  expect(records.filter(record => record.kind === 'mcp')).toHaveLength(enabled.includes('mcp') ? 1 : 0);
}
async function assertClosed(records: Record[]) {
  for (const record of records.filter(record => record.kind === 'mcp')) await vi.waitFor(() => expect(() => process.kill(record.pid!, 0)).toThrow(), { timeout: 2000 });
}

describe('emitted built-in extension selection', () => {
  for (const mode of ['print', 'json', 'rpc'] as const) for (const trusted of [false, true]) for (const contributed of [false, true]) {
    it(`${mode}: ${trusted ? 'trusted' : 'refused'} project switches with ${contributed ? 'contributed' : 'ordinary'} startup`, async () => {
      const test = await fixture();
      try {
        const records = await invoke(test, mode, trusted, contributed ? ['--builtin-probe'] : []);
        assertTools(records, trusted ? names : []); expect(records.find(record => record.kind === 'turn')?.flag).toBe(contributed); expect(records.filter(record => record.kind === 'import')).toEqual([{ kind: 'import', name: 'probe' }]); await assertClosed(records);
      } finally { await rm(test.root, { recursive: true, force: true }); }
    }, 30_000);
  }
  for (const mode of ['print', 'json', 'rpc'] as const) for (const contributed of [false, true]) {
    it(`${mode}: no-extensions blocks global/project/settings/environment/package imports, retaining explicit ${contributed ? 'contributed' : 'ordinary'} code`, async () => {
      const test = await fixture(true);
      try {
        const records = await invoke(test, mode, true, ['--no-extensions', ...(contributed ? ['--builtin-probe'] : [])]);
        assertTools(records, []); expect(records.find(record => record.kind === 'turn')?.flag).toBe(contributed); expect(records.filter(record => record.kind === 'import')).toEqual([{ kind: 'import', name: 'probe' }]);
      } finally { await rm(test.root, { recursive: true, force: true }); }
    }, 30_000);
  }
  for (const mode of ['print', 'json', 'rpc'] as const) it(`${mode}: explicit built-in ID overrides disabled discovery but not other capabilities`, async () => {
    const test = await fixture();
    try { const records = await invoke(test, mode, false, ['-ne', '-e', 'builtin:mcp']); assertTools(records, ['mcp']); await assertClosed(records); }
    finally { await rm(test.root, { recursive: true, force: true }); }
  }, 30_000);
  it.each(names)('disables only %s while leaving independent capabilities eligible', async disabled => {
    const test = await fixture();
    try {
      await test.file(path.join(test.agent, 'settings.json'), JSON.stringify({ extensions: [`-builtin:${disabled}`], codemode: { enabled: true } }));
      const records = await invoke(test, 'print', false); assertTools(records, names.filter(name => name !== disabled)); await assertClosed(records);
    } finally { await rm(test.root, { recursive: true, force: true }); }
  }, 30_000);
  it('interactive reload retires live MCP bindings and reenables lazily while preserving explicit option values', async () => {
    const test = await fixture(); let terminal: ReturnType<typeof spawnPty> | undefined; let exited: { exitCode: number; signal?: number } | undefined;
    try {
      terminal = spawnPty(process.execPath, [cli, '--approve', '--no-session', '--model', 'mock/mock-model', '-e', test.probe, '--builtin-probe', '--tui-mode', 'regular', '--theme', 'dark', '--name', 'builtin-probe'], { cwd: test.cwd, env: test.env, cols: 100, rows: 30 });
      let output = ''; terminal.onData(text => { output += text; }); terminal.onExit(value => { exited = value; });
      await vi.waitFor(() => expect(output).toContain('builtin-probe: '), { timeout: 10_000 });
      const prompt = async (count: number) => {
        output = ''; terminal!.write('Hello.\r');
        await vi.waitFor(async () => expect((await test.records()).filter(record => record.kind === 'turn')).toHaveLength(count), { timeout: 10_000 });
        await vi.waitFor(() => expect(output).toContain('editor ready · Enter send'), { timeout: 10_000 });
        await vi.waitFor(() => expect(output).toContain('builtin-probe: '), { timeout: 10_000 });
      };
      const reload = async () => {
        output = ''; terminal!.write('/reload\r');
        await vi.waitFor(() => expect(output).toContain('Reloaded '), { timeout: 10_000 });
        await vi.waitFor(() => expect(output).toContain('builtin-probe: '), { timeout: 10_000 });
      };
      await prompt(1);
      await test.file(path.join(test.cwd, '.ai-harness/settings.json'), JSON.stringify({ extensions: names.map(name => `-builtin:${name}`) }));
      await prompt(2); // Disk changes do not silently replace the active policy.
      await reload(); await assertClosed(await test.records()); await prompt(3);
      await test.file(path.join(test.cwd, '.ai-harness/settings.json'), JSON.stringify({ extensions: names.map(name => `+builtin:${name}`) }));
      await reload(); expect((await test.records()).filter(record => record.kind === 'mcp')).toHaveLength(1);
      await prompt(4);
      const records = await test.records(); const turns = records.filter(record => record.kind === 'turn');
      expect(turns.map(record => record.flag)).toEqual([true, true, true, true]);
      expect(turns.map(record => ['codemode', 'tool_search', 'mcp__fixture__mutate'].every(tool => record.tools?.includes(tool)))).toEqual([true, true, false, true]);
      for (const tool of ['codemode', 'tool_search', 'mcp__fixture__mutate']) expect(turns[2]?.tools).not.toContain(tool);
      expect(records.filter(record => record.kind === 'mcp')).toHaveLength(2);
      terminal.write('/quit\r'); await vi.waitFor(() => expect(exited).toMatchObject({ exitCode: 0 }), { timeout: 10_000 }); await assertClosed(records);
    } finally { if (terminal && !exited) terminal.kill(); await rm(test.root, { recursive: true, force: true }); }
  }, 45_000);

  it('exports readonly policy and additive loader/host controls to an outside-checkout strict consumer', async () => {
    const test = await fixture();
    try {
      const consumer = path.join(test.root, 'consumer.mts');
      await test.file(consumer, `import assert from 'node:assert/strict';
        import { resolveBuiltinExtensionPolicy, BUILTIN_EXTENSION_NAMES, McpSessionHost, type BuiltinExtensionPolicy, type ExtensionModuleLoaderOptions } from ${JSON.stringify(core)};
        const policy: BuiltinExtensionPolicy = resolveBuiltinExtensionPolicy({ global: ['!builtin:*'], project: ['+builtin:mcp'], projectTrusted: true });
        assert.deepEqual(policy, {codemode:false,'tool-search':false,mcp:true}); assert(Object.isFrozen(policy));
        const loader: ExtensionModuleLoaderOptions = { includeEnvironmentPaths:false }; assert.equal(loader.includeEnvironmentPaths,false);
        function invalid() {
          // @ts-expect-error policies are readonly
          policy.mcp = false;
          // @ts-expect-error capability names are readonly
          BUILTIN_EXTENSION_NAMES.push('mcp');
          // @ts-expect-error trust cannot be a truthy string
          resolveBuiltinExtensionPolicy({projectTrusted:'true'});
        } void invalid;
        const host = new McpSessionHost({agentDir:${JSON.stringify(test.agent)}}); await host.setEnabled(false);
        assert.deepEqual((await host.prepareForPrompt({sessionId:'probe',cwd:${JSON.stringify(test.cwd)}})).tools,[]);
        await host.shutdown(); await assert.rejects(host.setEnabled(true), /closed/); console.log('public-builtins-ok');`);
      const tsc = fileURLToPath(new URL('../../../../node_modules/typescript/bin/tsc', import.meta.url));
      await promisify(execFile)(process.execPath, [tsc, '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--types', 'node', '--typeRoots', path.join(path.dirname(tsc), '../../@types'), consumer], { cwd: test.root, timeout: 20_000 });
      const result = await run([consumer], test.root, test.env); expect(result, result.stderr).toMatchObject({ code: 0, signal: null }); expect(result.stdout).toContain('public-builtins-ok');
      expect(await test.records()).toEqual([]);
    } finally { await rm(test.root, { recursive: true, force: true }); }
  }, 30_000);

  for (const mode of ['print', 'json', 'rpc'] as const) it(`${mode}: rejects an unknown explicit built-in before imports or MCP start`, async () => {
    const test = await fixture();
    try {
      const result = await run([cli, '--approve', '--no-session', '-e', test.probe, '-e', 'builtin:unknown-secret', ...(mode === 'print' ? ['--print'] : ['--mode', mode])], test.cwd, test.env);
      expect(result.code).not.toBe(0); expect(result.stderr).toContain('Unknown built-in extension.'); expect(result.stderr).not.toContain('unknown-secret'); expect(await test.records()).toEqual([]);
    } finally { await rm(test.root, { recursive: true, force: true }); }
  }, 30_000);
});
