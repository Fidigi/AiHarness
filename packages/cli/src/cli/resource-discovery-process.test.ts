import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { spawn as spawnPty } from 'node-pty';
import { PluginService, ProjectTrustManager, WorkspaceManager } from '@ai-harness/core';
import { describe, expect, it, vi } from 'vitest';

type Kind = 'skill' | 'prompt';
type Mode = 'print' | 'json' | 'rpc';
const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
async function fixture(kind: Kind, explicitProject = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-discovery-process-')), cwd = path.join(root, 'work[literal]'), agent = path.join(root, 'agent[literal]');
  await mkdir(cwd); await mkdir(agent);
  const skill = kind === 'skill', field = skill ? 'skills' : 'prompts', trace = path.join(root, 'reads'), capture = path.join(root, 'capture');
  const file = async (target: string, body: string) => { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, body); };
  const body = (name: string, text: string) => `---\nname: ${name}\ndescription: Discovery fixture\n---\n${text}`;
  const resource = async (base: string, name: string, text = 'AUTOMATIC BODY') => { const target = path.join(base, skill ? `${name}/SKILL.md` : `${name}.md`); await file(target, body(name, text)); return target; };
  const automatic = [await resource(path.join(agent, field), 'user-auto'), await resource(path.join(cwd, '.ai-harness', field), 'project-auto')];
  const globalConfigured = await resource(path.join(agent, 'configured'), 'global-configured'), projectConfigured = await resource(path.join(cwd, '.ai-harness/configured'), 'project-configured');
  automatic.push(globalConfigured, projectConfigured);
  const pattern = skill ? 'configured/**/SKILL.md' : 'configured/*.md';
  await file(path.join(agent, 'settings.json'), JSON.stringify({ quietStartup: true, [field]: [pattern] }));
  await file(path.join(cwd, '.ai-harness/settings.json'), JSON.stringify({ [field]: [pattern] }));
  const workspaces = new WorkspaceManager({ allowedRoots: [cwd], defaultCwd: cwd }); await workspaces.initialize();
  const trust = new ProjectTrustManager(path.join(agent, 'trust.json')); await trust.load(); await trust.trust(cwd);
  const plugins = new PluginService(workspaces, trust, path.join(agent, 'plugins.json'), agent); await plugins.load();
  for (const scope of ['global', 'project'] as const) {
    const directory = path.join(cwd, `package-${scope}`), packaged = await resource(path.join(directory, field), `${scope}-packaged`);
    await file(path.join(directory, 'package.json'), JSON.stringify({ name: '@fixture/discovery-' + scope, version: '1.0.0', aiHarness: { [field]: [path.relative(directory, packaged)] } }));
    expect((await plugins.install({ cwd, scope, source: directory })).packages[0]?.counts[field]).toBe(1);
  }
  const managed = await plugins.getEnabledResourceLocations(kind, { cwd, projectTrusted: true }); expect(managed).toHaveLength(2);
  automatic.push(...managed.map(value => skill ? path.join(value.path, 'SKILL.md') : value.path));
  const explicitBase = explicitProject ? path.join(cwd, '..private/manual') : path.join(root, 'manual');
  const picked = await resource(path.join(explicitBase, 'one'), 'picked', skill ? 'EXPLICIT SKILL' : 'EXPLICIT PROMPT $ARGUMENTS');
  const second = await resource(path.join(explicitBase, 'two'), 'second', 'SECOND EXPLICIT');
  const observer = path.join(root, 'observe.mjs'), extension = path.join(root, 'capture.mjs');
  await file(observer, `import fs from 'node:fs/promises';import{appendFileSync,readlinkSync}from'node:fs';import{syncBuiltinESMExports}from'node:module';const original=fs.open;fs.open=async(...args)=>{const handle=await original(...args);const read=handle.read.bind(handle);handle.read=(...values)=>{const name=readlinkSync('/proc/self/fd/'+handle.fd);if(name.startsWith(${JSON.stringify(root + path.sep)})&&name.endsWith('.md'))appendFileSync(${JSON.stringify(trace)},JSON.stringify(name)+'\\n');return read(...values);};return handle;};syncBuiltinESMExports();`);
  await file(extension, `import{appendFileSync}from'node:fs';export default api=>api.before('before:provider',data=>{appendFileSync(${JSON.stringify(capture)},JSON.stringify(data.messages)+'\\n');});`);
  const select = (value: string) => explicitProject ? path.relative(cwd, value) : value;
  const args = ['--import', observer, cli, '--offline', '--no-extensions', '-e', extension, '--no-context-files', '--no-session', '--model', 'mock/mock-model', skill ? '--skill' : '--prompt-template', select(path.dirname(picked)), skill ? '--skill' : '--prompt-template', '+' + select(second)];
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, TMPDIR: root, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent, NO_COLOR: '1', TERM: 'xterm-256color' };
  const readLines = async (filename: string): Promise<unknown[]> => (await readFile(filename, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const reads = async () => (await readLines(trace)) as string[];
  const users = async () => (await readLines(capture)).map(value => (value as Array<{ role: string; content: string }>).filter(message => message.role === 'user').at(-1)?.content);
  const prompt = skill ? '/skill:picked TASK' : '/picked TASK';
  const expanded = skill ? '<skill name="picked">\n\nEXPLICIT SKILL\n\n</skill>\n\nTASK' : 'EXPLICIT PROMPT TASK';
  return { root, cwd, agent, args, env, trace, capture, picked, second, automatic, file, body, field, pattern, reads, users, prompt, expanded };
}
async function run(test: Awaited<ReturnType<typeof fixture>>, mode: Mode, flags: string[], trusted = true, admitted = true) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [...test.args, trusted ? '--approve' : '--no-approve', ...flags, ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : [admitted ? test.prompt : 'Hello.'])], { cwd: test.cwd, env: test.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    child.stdin.end(mode === 'rpc' ? [JSON.stringify({ type: 'get_commands', id: 'resources' }), JSON.stringify({ type: 'prompt', id: 'turn', message: admitted ? test.prompt : 'Hello.' })].join('\n') + '\n' : '');
  });
}
function success(result: Awaited<ReturnType<typeof run>>, mode: Mode) {
  expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: '' });
  if (mode === 'print') expect(result.stdout).toBe('[Mock AI Response]\n');
  else { const records = result.stdout.trim().split('\n').map(line => JSON.parse(line)); expect(records.length).toBeGreaterThan(0); expect(records.every(record => typeof record.type === 'string')).toBe(true); expect(result.stdout).toContain('[Mock AI Response]'); }
}

describe('CLI discovery suppression retains explicit Markdown resources', () => {
  for (const mode of ['print', 'json', 'rpc'] as const) for (const kind of ['skill', 'prompt'] as const) for (const policy of ['default', 'long', 'short'] as const) {
    it(`${mode}/${kind}/${policy}: repeated explicit paths load with conserved mode-specific input while automatic candidates follow policy`, async () => {
      const test = await fixture(kind), flags = policy === 'default' ? [] : [kind === 'skill' ? policy === 'long' ? '--no-skills' : '-ns' : policy === 'long' ? '--no-prompt-templates' : '-np'];
      try {
        const result = await run(test, mode, flags); success(result, mode);
        expect((await test.reads()).sort()).toEqual([test.picked, test.second, ...(policy === 'default' ? test.automatic : [])].sort()); expect(await test.users()).toEqual([mode === 'rpc' ? test.expanded : test.prompt]);
        if (mode === 'rpc') {
          const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
          const commands = records.find(record => record.type === 'response' && record.id === 'resources')?.data?.commands as Array<{ name: string; source: string }>;
          expect(commands.filter(command => command.source === kind).map(command => command.name).sort()).toEqual((policy === 'default' ? ['picked', 'second', 'user-auto', 'project-auto', 'global-configured', 'project-configured', 'global-packaged', 'project-packaged'] : ['picked', 'second']).map(name => kind === 'skill' ? 'skill:' + name : name).sort());
        }
      } finally { await rm(test.root, { recursive: true, force: true }); }
    }, 30_000);
  }
  for (const mode of ['print', 'json', 'rpc'] as const) for (const kind of ['skill', 'prompt'] as const) for (const project of [false, true]) {
    it(`${mode}/${kind}/explicit-project=${project}: discovery suppression never overrides project refusal`, async () => {
      const test = await fixture(kind, project);
      try { const result = await run(test, mode, ['--no-skills', '--no-prompt-templates'], false, !project); success(result, mode); expect((await test.reads()).sort()).toEqual(project ? [] : [test.picked, test.second].sort()); expect(await test.users()).toEqual([project ? 'Hello.' : mode === 'rpc' ? test.expanded : test.prompt]); }
      finally { await rm(test.root, { recursive: true, force: true }); }
    }, 30_000);
  }
  for (const mode of ['regular', 'fullscreen'] as const) for (const kind of ['skill', 'prompt'] as const) {
    it(`${mode}/${kind}: genuine PTY reload keeps explicit resources, ignores new settings and invokes fresh bytes`, async () => {
      const test = await fixture(kind);
      const terminal = spawnPty(process.execPath, [...test.args, '--approve', '--no-skills', '--no-prompt-templates', '--tui-mode', mode, '--theme', 'dark', '--name', 'discovery-policy'], { cwd: test.cwd, env: test.env, cols: 180, rows: 35 });
      let output = '', exited: { exitCode: number; signal?: number } | undefined; terminal.onData(value => { output += value; }); terminal.onExit(value => { exited = value; }); const visible = () => stripVTControlCharacters(output);
      try {
        await vi.waitFor(() => expect(visible()).toContain('discovery-policy: '), { timeout: 10_000 }); expect((await test.reads()).sort()).toEqual([test.picked, test.second].sort());
        output = ''; terminal.write('/resources\r'); await vi.waitFor(() => { expect(visible()).toContain(`● ${kind}:picked [temporary/cli]`); expect(visible()).toContain(`● ${kind}:second [temporary/cli]`); expect(visible()).toContain('discovery-policy: '); }, { timeout: 10_000 }); expect(visible()).not.toContain('user-auto');
        await test.file(test.picked, test.body('picked', kind === 'skill' ? 'FRESH EXPLICIT SKILL' : 'FRESH EXPLICIT PROMPT $ARGUMENTS'));
        await test.file(path.join(test.agent, 'fresh', kind === 'skill' ? 'ignored/SKILL.md' : 'ignored.md'), test.body('ignored', 'IGNORED NEW SETTINGS'));
        await test.file(path.join(test.agent, 'settings.json'), JSON.stringify({ quietStartup: true, [test.field]: ['fresh/' + (kind === 'skill' ? '**/SKILL.md' : '*.md')] }));
        await rm(test.trace, { force: true }); output = ''; terminal.write('/reload\r'); await vi.waitFor(() => { expect(visible()).toContain('Reloaded '); expect(visible()).toContain('discovery-policy: '); }, { timeout: 10_000 }); expect((await test.reads()).sort()).toEqual([test.picked, test.second].sort());
        output = ''; terminal.write(test.prompt + '\r'); await vi.waitFor(() => { expect(visible()).toContain('[Mock AI Response]'); expect(visible()).toContain('discovery-policy: '); }, { timeout: 10_000 }); expect(await test.users()).toEqual([test.expanded.replace('EXPLICIT', 'FRESH EXPLICIT')]);
        expect((await test.reads()).sort()).toEqual([test.picked, test.second].sort()); terminal.write('/quit\r'); await vi.waitFor(() => expect(exited).toMatchObject({ exitCode: 0 }), { timeout: 10_000 });
      } finally { if (!exited) terminal.kill(); await rm(test.root, { recursive: true, force: true }); }
    }, 30_000);
  }
});
