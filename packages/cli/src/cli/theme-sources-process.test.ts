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
type Source = 'global' | 'project' | 'global-settings' | 'project-settings' | 'global-package' | 'project-package' | 'explicit';
async function fixture(source: Source) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-theme-process-[literal]-'));
  const cwd = path.join(root, 'project'), agent = path.join(root, 'agent');
  const file = async (target: string, text: string) => { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, text); };
  await mkdir(cwd); await mkdir(agent);
  const directory = source === 'global' ? path.join(agent, 'themes')
    : source === 'project' ? path.join(cwd, '.ai-harness/themes')
    : source === 'global-settings' ? path.join(agent, 'configured/nested')
    : source === 'project-settings' ? path.join(cwd, '.ai-harness/configured/nested')
    : source.endsWith('package') ? path.join(cwd, `${source}/themes`) : path.join(root, '[explicit]');
  const target = path.join(directory, 'ocean.json');
  const theme = (name: string) => file(target, JSON.stringify({ name, appearance: 'dark', colors: { accent: '#123456' } }));
  const name = `winner-${source}`; await theme(name);
  await file(path.join(agent, 'settings.json'), JSON.stringify({ quietStartup: true, theme: 'ocean', ...(source === 'global-settings' ? { themes: ['configured/**/*.json', '!configured/**/skip.json'] } : {}) }));
  if (source === 'project-settings') await file(path.join(cwd, '.ai-harness/settings.json'), JSON.stringify({ themes: ['configured/**/*.json', '!configured/**/skip.json'] }));
  if (source.endsWith('settings')) await file(path.join(directory, 'skip.json'), '{PRIVATE-EXCLUDED-PALETTE');
  if (source.endsWith('package')) {
    const pkg = path.dirname(directory);
    await file(path.join(pkg, 'package.json'), JSON.stringify({ name: `@fixture/${source}`, version: '1.0.0', aiHarness: { themes: ['themes/ocean.json'] } }));
    const workspaces = new WorkspaceManager({ allowedRoots: [cwd], defaultCwd: cwd }); await workspaces.initialize();
    const trust = new ProjectTrustManager(path.join(agent, 'trust.json')); await trust.load(); await trust.trust(cwd);
    const plugins = new PluginService(workspaces, trust, path.join(agent, 'plugins.json'), agent); await plugins.load();
    const installed = await plugins.install({ cwd, scope: source === 'global-package' ? 'global' : 'project', source: pkg });
    expect(installed.packages[0]?.counts.themes).toBe(1);
  }
  const loaded = path.join(root, 'loaded');
  await file(path.join(agent, 'extensions/probe.mjs'), `import{appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(loaded)},'loaded\\n');export default()=>{};`);
  const env = { ...process.env, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent, AI_HARNESS_THEME: '', AI_HARNESS_EXTENSIONS: '', NO_COLOR: '1', TERM: 'xterm-256color' };
  const flags = source === 'explicit' ? ['--theme-source', directory] : [];
  return { root, cwd, agent, target, name, theme, file, env, flags, loaded };
}
function run(test: Awaited<ReturnType<typeof fixture>>, flags: string[], input = '') {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...flags], { cwd: test.cwd, env: test.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    child.stdin.end(input);
  });
}
async function inspectThemes(test: Awaited<ReturnType<typeof fixture>>, flags: string[], expected: string): Promise<string> {
  const terminal = spawnPty(process.execPath, [cli, '--no-session', '--model', 'mock/mock-model', '--tui-mode', 'regular', '--name', 'theme-inspect', ...flags], { cwd: test.cwd, env: test.env, cols: 180, rows: 35 });
  let output = ''; let exited: { exitCode: number; signal?: number } | undefined;
  terminal.onData(text => { output += text; }); terminal.onExit(value => { exited = value; });
  const visible = () => stripVTControlCharacters(output);
  try {
    await vi.waitFor(() => expect(visible()).toContain('theme-inspect: '), { timeout: 10_000 });
    output = ''; terminal.write('/theme\r');
    await vi.waitFor(() => expect(visible()).toContain(expected), { timeout: 10_000 });
    await vi.waitFor(() => expect(visible()).toContain('theme-inspect: '), { timeout: 10_000 });
    const result = visible(); terminal.write('/quit\r');
    await vi.waitFor(() => expect(exited).toMatchObject({ exitCode: 0 }), { timeout: 10_000 });
    return result;
  } finally { if (!exited) terminal.kill(); }
}
async function interactive(source: Source, mode: 'regular' | 'fullscreen', noThemes = false, trusted = true, reload = false) {
  const test = await fixture(source); let terminal: ReturnType<typeof spawnPty> | undefined; let exited: { exitCode: number; signal?: number } | undefined;
  try {
    const selected = (!noThemes || source === 'explicit') && (trusted || !source.startsWith('project'));
    terminal = spawnPty(process.execPath, [cli, trusted ? '--approve' : '--no-approve', '--no-session', '--model', 'mock/mock-model', '--tui-mode', mode, '--name', 'theme-probe', ...test.flags, ...(noThemes ? ['--no-themes'] : []), ...(!selected ? ['--theme', 'dark'] : [])], { cwd: test.cwd, env: test.env, cols: 180, rows: 35 });
    let output = ''; terminal.onData(text => { output += text; }); terminal.onExit(value => { exited = value; });
    const visible = () => stripVTControlCharacters(output);
    const prompt = () => vi.waitFor(() => expect(visible()).toContain('theme-probe: '), { timeout: 10_000 });
    await prompt();
    output = ''; terminal.write('/theme\r');
    const scope = source.startsWith('project') || source.endsWith('package') ? 'project' : source === 'explicit' ? 'temporary' : 'user';
    const origin = source.endsWith('settings') ? 'settings' : source.endsWith('package') ? 'package' : source === 'explicit' ? 'cli' : 'auto';
    await vi.waitFor(() => expect(visible()).toContain(selected ? `● ${test.name} (${scope}/${origin})` : '● dark'), { timeout: 10_000 }); await prompt();
    if (!selected) expect(visible()).not.toContain(test.name);
    expect(visible()).not.toContain('PRIVATE-EXCLUDED-PALETTE');
    expect(await readFile(test.loaded, 'utf8')).toBe('loaded\n');
    if (reload) {
      await rm(test.target);
      await test.file(path.join(path.dirname(test.target), 'fresh.json'), JSON.stringify({ name: 'reloaded-palette', appearance: 'light', colors: { accent: '#654321' } }));
      await test.file(path.join(test.agent, 'settings.json'), JSON.stringify({ quietStartup: true, theme: 'fresh', themes: ['configured/**/*.json'] }));
      output = ''; terminal.write('/reload\r');
      await vi.waitFor(() => expect(visible()).toContain('Reloaded '), { timeout: 10_000 }); await prompt();
      output = ''; terminal.write('/theme fresh\r');
      await vi.waitFor(() => expect(visible()).toContain('Thème actif : reloaded-palette.'), { timeout: 10_000 }); await prompt();
    }
    terminal.write('/quit\r'); await vi.waitFor(() => expect(exited).toMatchObject({ exitCode: 0 }), { timeout: 10_000 });
  } finally { if (terminal && !exited) terminal.kill(); await rm(test.root, { recursive: true, force: true }); }
}

describe('actual CLI theme sources', () => {
  for (const mode of ['regular', 'fullscreen'] as const) {
    for (const source of ['global', 'project', 'global-settings', 'project-settings', 'global-package', 'project-package', 'explicit'] as const) {
      it(`${mode}: selects ${source} and exposes provenance`, () => interactive(source, mode), 30_000);
    }
    it(`${mode}: reload replaces a settings-discovered palette`, () => interactive('global-settings', mode, false, true, true), 30_000);
    it(`${mode}: suppression retains explicit resources and extensions`, () => interactive('explicit', mode, true), 30_000);
    it(`${mode}: suppression excludes package palettes`, () => interactive('global-package', mode, true), 30_000);
    it(`${mode}: refused project settings never become palettes`, () => interactive('project-settings', mode, false, false), 30_000);
  }
  for (const mode of ['print', 'json', 'rpc'] as const) {
    it(`${mode}: accepts explicit sources and suppression without protocol contamination`, async () => {
      const test = await fixture('explicit');
      try {
        const result = await run(test, ['--approve', '--no-session', '--model', 'mock/mock-model', '--no-themes', ...test.flags, ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['Hello.'])], mode === 'rpc' ? JSON.stringify({ type: 'prompt', id: 'theme', message: 'Hello.' }) + '\n' : '');
        expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
        expect(result.stderr).not.toContain('ignor'); expect(result.stdout.trim()).not.toBe('');
        expect(result.stdout).not.toContain(test.name);
        if (mode !== 'print') for (const line of result.stdout.trim().split('\n')) expect(JSON.parse(line)).toHaveProperty('type');
      } finally { await rm(test.root, { recursive: true, force: true }); }
    }, 30_000);
  }
  it('does not let an explicit source or suppression bypass project refusal', async () => {
    const test = await fixture('project');
    try {
      const output = await inspectThemes(test, ['--no-approve', '--no-themes', '--theme-source', test.target, '--theme', 'dark'], '● dark');
      expect(output).not.toContain(test.name);
      expect(await readFile(test.loaded, 'utf8')).toBe('loaded\n');
    } finally { await rm(test.root, { recursive: true, force: true }); }
  });

  it('reports one actual active identity across same-name global/project palettes', async () => {
    const test = await fixture('global');
    try {
      await test.theme('same-name');
      await test.file(path.join(test.cwd, '.ai-harness/themes/ocean.json'), JSON.stringify({ name: 'same-name', appearance: 'light', colors: { accent: '#654321' } }));
      const output = await inspectThemes(test, ['--approve'], '● same-name (project/auto)');
      expect(output).toContain('○ same-name (user/auto)');
      expect(output.match(/● same-name/g)).toHaveLength(1);
    } finally { await rm(test.root, { recursive: true, force: true }); }
  });

  it('retains direct --theme file selection under suppression and reports the loaded palette', async () => {
    const test = await fixture('explicit');
    try {
      await inspectThemes(test, ['--approve', '--no-themes', '--theme', test.target], `● ${test.name} (temporary/cli)`);
    } finally { await rm(test.root, { recursive: true, force: true }); }
  });

  it.each([false, true])('applies environment selection below an explicit selection (%s)', async explicit => {
    const test = await fixture('global');
    try {
      test.env.AI_HARNESS_THEME = 'light';
      await inspectThemes(test, ['--approve', ...(explicit ? ['--theme', 'ocean'] : [])], explicit ? `● ${test.name} (user/auto)` : '● light (user/auto)');
    } finally { await rm(test.root, { recursive: true, force: true }); }
  });

  it('never publishes private palette keys or terminal controls in startup diagnostics', async () => {
    const test = await fixture('explicit');
    try {
      await test.file(test.target, JSON.stringify({ name: 'private', appearance: 'dark', colors: {
        [`PRIVATE-PALETTE-KEY${String.fromCharCode(27)}]52;c;unsafe${String.fromCharCode(7)}`]: '#123456',
      } }));
      const result = await run(test, ['--approve', '--no-session', '--model', 'mock/mock-model', '--theme', test.target, '--print', 'Hello.']);
      expect(result).toMatchObject({ code: 0, signal: null, stdout: '[Mock AI Response]\n' });
      expect(result.stderr).not.toContain('PRIVATE-PALETTE-KEY');
      expect(result.stderr).not.toContain(String.fromCharCode(27));
      expect(result.stderr).toContain('Unknown theme color token.');
    } finally { await rm(test.root, { recursive: true, force: true }); }
  });

  it('rejects malformed suppression before executable discovery', async () => {
    const test = await fixture('global');
    try {
      const result = await run(test, ['--no-themes=false']);
      expect(result).toMatchObject({ code: 2, signal: null, stdout: '' });
      expect(result.stderr).toContain('--no-themes does not accept a value.');
      await expect(readFile(test.loaded)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(test.root, { recursive: true, force: true }); }
  });
});
