import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { spawn as spawnPty } from 'node-pty';
import { PluginService, ProjectTrustManager, WorkspaceManager } from '@ai-harness/core';
import { describe, expect, it, vi } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
type Source = 'user-auto' | 'project-auto' | 'user-settings' | 'project-settings' | 'explicit' | 'global-package' | 'project-package';
async function fixture(kind: 'skill' | 'prompt', source: Source) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-scoped-process-'));
  const cwd = path.join(root, 'work[literal]'), agent = path.join(root, 'agent[literal]'), trace = path.join(root, 'reads');
  const skill = kind === 'skill'; const field = skill ? 'skills' : 'prompts';
  const relative = skill ? 'review/SKILL.md' : 'review.md';
  const file = async (target: string, text: string) => { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, text); };
  await mkdir(cwd); await mkdir(agent);
  let target = path.join(source === 'user-auto' ? path.join(agent, field)
    : source === 'project-auto' ? path.join(cwd, '.ai-harness', field)
    : source === 'user-settings' ? path.join(agent, 'configured')
    : source === 'project-settings' ? path.join(cwd, '.ai-harness/configured')
    : source.endsWith('package') ? path.join(cwd, source + '[literal]', field) : path.join(cwd, 'ad-hoc'), relative);
  const body = (value: string) => `---\nname: review\ndescription: Scoped resource\n---\n${value}`;
  await file(target, body('EXACT'));
  await file(target.replaceAll('[literal]', 'l'), body('BAIT'));
  const pattern = skill ? '**/SKILL.md' : '*.md';
  await file(path.join(agent, 'settings.json'), JSON.stringify({ quietStartup: true, ...(source === 'user-settings' ? { [field]: ['configured/' + pattern] } : {}) }));
  if (source === 'project-settings') await file(path.join(cwd, '.ai-harness/settings.json'), JSON.stringify({ [field]: ['configured/' + pattern] }));
  if (source.endsWith('package')) {
    const directory = path.join(cwd, source + '[literal]');
    await file(path.join(directory, 'package.json'), JSON.stringify({ name: '@fixture/' + source, version: '1.0.0', aiHarness: { [field]: [field + '/' + relative] } }));
    const workspaces = new WorkspaceManager({ allowedRoots: [cwd], defaultCwd: cwd }); await workspaces.initialize();
    const trust = new ProjectTrustManager(path.join(agent, 'trust.json')); await trust.load(); await trust.trust(cwd);
    const plugins = new PluginService(workspaces, trust, path.join(agent, 'plugins.json'), agent); await plugins.load();
    expect((await plugins.install({ cwd, scope: source === 'global-package' ? 'global' : 'project', source: directory })).packages[0]?.counts[field]).toBe(1);
    const locations = await plugins.getEnabledResourceLocations(kind, { cwd, projectTrusted: true });
    expect(locations).toHaveLength(1); target = skill ? path.join(locations[0].path, 'SKILL.md') : locations[0].path;
  }
  const observer = path.join(root, 'observe.mjs');
  await file(observer, `import fs from 'node:fs/promises';import{appendFileSync,readlinkSync}from'node:fs';import{syncBuiltinESMExports}from'node:module';const original=fs.open;fs.open=async(...args)=>{const handle=await original(...args);const read=handle.read.bind(handle);handle.read=(...values)=>{const name=readlinkSync('/proc/self/fd/'+handle.fd);if(name.startsWith(${JSON.stringify(root + path.sep)})&&name.endsWith('.md'))appendFileSync(${JSON.stringify(trace)},JSON.stringify(name)+'\\n');return read(...values);};return handle;};syncBuiltinESMExports();`);
  const args = ['--import', observer, cli, '--approve', '--no-extensions', '--no-session', '--model', 'mock/mock-model', ...(source === 'explicit' ? [skill ? '--skill' : '--prompt-template', 'ad-hoc/' + pattern] : [])];
  const env = { ...process.env, HOME: path.join(root, 'home[literal]'), AI_HARNESS_AGENT_DIR: agent, AI_HARNESS_EXTENSIONS: '', AI_HARNESS_THEME: '', NO_COLOR: '1', TERM: 'xterm-256color' };
  const reads = async (): Promise<string[]> => (await readFile(trace, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { root, cwd, agent, target, trace, args, env, reads, file, body, field, pattern, relative };
}
function run(test: Awaited<ReturnType<typeof fixture>>, mode: 'print' | 'json' | 'rpc', refused = false) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [...test.args.map(value => refused && value === '--approve' ? '--no-approve' : value), ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['Hello.'])], { cwd: test.cwd, env: test.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    child.stdin.end(mode === 'rpc' ? JSON.stringify({ type: 'prompt', id: 'scoped', message: 'Hello.' }) + '\n' : '');
  });
}

describe('actual scoped Markdown resource sources', () => {
  for (const kind of ['skill', 'prompt'] as const) for (const source of ['user-auto', 'project-auto', 'user-settings', 'project-settings', 'explicit', 'global-package', 'project-package'] as const) {
    for (const mode of ['print', 'json', 'rpc'] as const) {
      it(`${mode}/${kind}/${source}: reads the literal admitted resource, never the sibling bait`, async () => {
        const test = await fixture(kind, source);
        try {
          const result = await run(test, mode);
          expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: '' });
          expect(await test.reads()).toEqual([test.target]);
          if (mode === 'print') expect(result.stdout).toBe('[Mock AI Response]\n');
          else { expect(result.stdout.trim()).not.toBe(''); for (const line of result.stdout.trim().split('\n')) expect(JSON.parse(line)).toHaveProperty('type'); }
        } finally { await rm(test.root, { recursive: true, force: true }); }
      }, 30_000);
    }
  }
  for (const kind of ['skill', 'prompt'] as const) for (const source of ['project-auto', 'project-settings'] as const) {
    it(`${kind}/${source}: refusing the literal project still prevents body reads`, async () => {
      const test = await fixture(kind, source);
      try {
        const result = await run(test, 'print', true);
        expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: '', stdout: '[Mock AI Response]\n' });
        expect(await test.reads()).toEqual([]);
      } finally { await rm(test.root, { recursive: true, force: true }); }
    }, 30_000);
  }
  for (const mode of ['regular', 'fullscreen'] as const) for (const kind of ['skill', 'prompt'] as const) {
    it(`${mode}/${kind}: reload refreshes scoped settings and actual inventory`, async () => {
      const test = await fixture(kind, 'user-settings');
      const terminal = spawnPty(process.execPath, [...test.args, '--tui-mode', mode, '--theme', 'dark', '--name', 'scoped-resource'], { cwd: test.cwd, env: test.env, cols: 180, rows: 35 });
      let output = ''; let exited: { exitCode: number; signal?: number } | undefined;
      terminal.onData(text => { output += text; }); terminal.onExit(value => { exited = value; });
      const visible = () => stripVTControlCharacters(output);
      try {
        await vi.waitFor(() => expect(visible()).toContain('scoped-resource: '), { timeout: 10_000 });
        expect(await test.reads()).toEqual([test.target]);
        output = ''; terminal.write('/resources\r');
        await vi.waitFor(() => expect(visible()).toContain(`● ${kind}:review [user/settings]`), { timeout: 10_000 });
        await vi.waitFor(() => expect(visible()).toContain('scoped-resource: '), { timeout: 10_000 });
        const fresh = path.join(test.agent, 'fresh[literal]', test.relative);
        await test.file(fresh, test.body('FRESH'));
        // Only the declaring directory is automatically literal. An exact +
        // request keeps this additional bracket-named directory literal too.
        await test.file(path.join(test.agent, 'settings.json'), JSON.stringify({ quietStartup: true, [test.field]: ['+' + path.join(test.agent, 'fresh[literal]')] }));
        await rm(test.trace, { force: true }); output = ''; terminal.write('/reload\r');
        await vi.waitFor(() => expect(visible()).toContain('Reloaded '), { timeout: 10_000 });
        await vi.waitFor(() => expect(visible()).toContain('scoped-resource: '), { timeout: 10_000 });
        expect(await test.reads()).toEqual([fresh]);
        output = ''; terminal.write('/resources\r');
        await vi.waitFor(() => expect(visible()).toContain(`● ${kind}:review [user/settings]`), { timeout: 10_000 });
        await vi.waitFor(() => expect(visible()).toContain('scoped-resource: '), { timeout: 10_000 });
        terminal.write('/quit\r'); await vi.waitFor(() => expect(exited).toMatchObject({ exitCode: 0 }), { timeout: 10_000 });
      } finally { if (!exited) terminal.kill(); await rm(test.root, { recursive: true, force: true }); }
    }, 30_000);
  }
});
