import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { spawn as spawnPty } from 'node-pty';
import { describe, expect, it, vi } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const packageMetadata: unknown = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
if (!packageMetadata || typeof packageMetadata !== 'object' || !('version' in packageMetadata)
  || typeof packageMetadata.version !== 'string') throw new Error('Invalid CLI package fixture.');
const version = packageMetadata.version;
type Quiet = boolean | 'header';
async function fixture(quiet: Quiet, projectQuiet?: Quiet) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-startup-display-'));
  const cwd = path.join(root, 'project');
  const agent = path.join(root, 'agent');
  const trace = path.join(root, 'trace');
  const settings = path.join(agent, 'settings.json');
  await mkdir(path.join(agent, 'extensions'), { recursive: true });
  await mkdir(path.join(cwd, '.ai-harness'), { recursive: true });
  await writeFile(settings, JSON.stringify({ quietStartup: quiet }));
  if (projectQuiet !== undefined) await writeFile(path.join(cwd, '.ai-harness/settings.json'), JSON.stringify({ quietStartup: projectQuiet }));
  await writeFile(path.join(agent, 'extensions/probe.mjs'), `import{appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(trace + '.loaded')},'loaded\\n');export default api=>{api.registerOption('startup-probe',{type:'boolean',description:'Probe'});api.before('before:provider',()=>appendFileSync(${JSON.stringify(trace)},JSON.stringify({flag:api.getOption('startup-probe')})+'\\n'));api.on('agent:end',()=>{if(process.stdout.isTTY)process.stdout.write('\\nSTARTUP-DISPLAY-END\\n');});};`);
  const env = { ...process.env, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent, AI_HARNESS_EXTENSIONS: '', NO_COLOR: '1', TERM: 'xterm-256color' };
  const records = async (): Promise<Array<{ flag: boolean }>> => (await readFile(trace, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const loaded = () => readFile(trace + '.loaded', 'utf8').catch(() => '');
  return { root, cwd, settings, env, records, loaded };
}
function run(test: Awaited<ReturnType<typeof fixture>>, flags: string[], input = '') {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...flags], { cwd: test.cwd, env: test.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    child.stdin.end(input);
  });
}
async function interactive(mode: 'regular' | 'fullscreen', quiet: Quiet, verbose: boolean, projectQuiet?: Quiet, trusted = true, initialPrompt = false) {
  const test = await fixture(quiet, projectQuiet);
  let terminal: ReturnType<typeof spawnPty> | undefined;
  let exited: { exitCode: number; signal?: number } | undefined;
  try {
    terminal = spawnPty(process.execPath, [cli, trusted ? '--approve' : '--no-approve', '--no-session', '--model', 'mock/mock-model', '--tui-mode', mode, '--theme', 'dark', '--name', 'display-probe', '--startup-probe', ...(verbose ? ['--verbose'] : []), ...(initialPrompt ? ['Hello.'] : [])], { cwd: test.cwd, env: test.env, cols: 180, rows: 35 });
    let output = '';
    terminal.onData(text => { output += text; });
    terminal.onExit(value => { exited = value; });
    const visible = () => stripVTControlCharacters(output);
    const prompt = (phase: string) => vi.waitFor(() => expect(visible(), phase).toContain('display-probe: '), { timeout: 10_000 });
    if (!initialPrompt) {
      await prompt('initial');
      const effectiveQuiet = trusted && projectQuiet !== undefined ? projectQuiet : quiet;
      const header = verbose || effectiveQuiet !== true;
      const details = verbose || effectiveQuiet === false;
      expect(visible().includes('/help')).toBe(header);
      expect(visible().includes('resources 0 skills')).toBe(details);
      if (mode === 'regular' && !header) expect(visible()).not.toContain('AiHarness CLI v');
      else expect(visible()).toContain(`AiHarness CLI v${version}`);
      expect(await test.records()).toEqual([]);
      expect(await test.loaded()).toBe('loaded\n');
      output = '';
      terminal.write('\r');
      await prompt('empty input');
      if (!details) expect(visible()).not.toContain('resources 0 skills');
      output = '';
      terminal.write('Hello.\r');
    }
    await vi.waitFor(async () => expect(await test.records()).toEqual([{ flag: true }]), { timeout: 10_000 });
    // A fullscreen frame can show ready before provider work starts. Require the
    // actual agent:end witness, then a later live frame before submitting commands.
    await vi.waitFor(() => expect(visible()).toContain('STARTUP-DISPLAY-END'), { timeout: 10_000 });
    await vi.waitFor(() => expect(visible().split('STARTUP-DISPLAY-END').at(-1)).toContain('editor ready · Enter send'), { timeout: 10_000 });
    await prompt('after agent end');
    if (initialPrompt) {
      expect(visible()).not.toContain('/help');
      expect(await test.loaded()).toBe('loaded\n');
      if (mode === 'regular') expect(visible()).not.toContain('AiHarness CLI v');
      else expect(visible()).toContain(`AiHarness CLI v${version}`);
    }
    expect(visible()).toContain('resources 0 skills');
    // The actual registry also owns builtin:workspace-tools.
    expect(visible()).toContain('resources 0 skills · 0 prompts · 2 extensions · 0 instructions · 0 diagnostics');
    expect(visible()).toContain('full history (all branches)');
    if (quiet === 'header' && !verbose && projectQuiet === undefined) {
      await writeFile(test.settings, JSON.stringify({ quietStartup: true }));
      output = '';
      terminal.write('/reload\r');
      await vi.waitFor(() => expect(visible()).toContain('Reloaded '), { timeout: 10_000 });
      await vi.waitFor(() => expect(visible()).toContain('editor ready · Enter send'), { timeout: 10_000 });
      await prompt('after reload');
      expect(visible()).toContain('resources 0 skills');
      if (mode === 'regular') expect(visible()).not.toContain('AiHarness CLI v');
    }
    terminal.write('/quit\r');
    await vi.waitFor(() => expect(exited).toMatchObject({ exitCode: 0 }), { timeout: 10_000 });
  } finally {
    if (terminal && !exited) terminal.kill();
    await rm(test.root, { recursive: true, force: true });
  }
}

describe('actual CLI startup display', () => {
  for (const mode of ['regular', 'fullscreen'] as const) {
    it(`${mode}: an initial positional prompt restores live status without a welcome`, () => interactive(mode, true, false, undefined, true, true), 30_000);
    for (const quiet of [false, 'header', true] as const) {
      for (const verbose of [false, true]) {
        it(`${mode}: quiet ${String(quiet)}, verbose ${verbose}, live status after input`, () => interactive(mode, quiet, verbose), 30_000);
      }
    }
    for (const trusted of [false, true]) {
      it(`${mode}: project display precedence only when trusted (${trusted})`, () => interactive(mode, true, false, false, trusted), 30_000);
    }
  }
  for (const mode of ['print', 'json', 'rpc'] as const) {
    for (const quiet of [true, 'header'] as const) {
      it(`${mode}: verbose never contaminates headless stdout (${quiet})`, async () => {
        const test = await fixture(quiet);
        try {
          const result = await run(test, ['--approve', '--no-session', '--model', 'mock/mock-model', '--verbose', '--startup-probe', ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['Hello.'])], mode === 'rpc' ? JSON.stringify({ type: 'prompt', id: 'display', message: 'Hello.' }) + '\n' : '');
          expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
          expect(result.stdout.trim()).not.toBe('');
          expect(result.stdout).not.toContain('AiHarness CLI');
          expect(result.stdout).not.toContain('resources 0 skills');
          if (mode !== 'print') for (const line of result.stdout.trim().split('\n')) expect(JSON.parse(line)).toHaveProperty('type');
          expect(await test.records()).toEqual([{ flag: true }]);
        } finally { await rm(test.root, { recursive: true, force: true }); }
      }, 30_000);
    }
  }
  it('rejects a valued verbose flag before executable discovery and retains quiet-mode warnings', async () => {
    const test = await fixture(true);
    try {
      const invalid = await run(test, ['--verbose=false']);
      expect(invalid).toMatchObject({ code: 2, signal: null, stdout: '' });
      expect(invalid.stderr).toContain('--verbose does not accept a value.');
      expect(await test.records()).toEqual([]);
      expect(await test.loaded()).toBe('');
      await writeFile(test.settings, JSON.stringify({ quietStartup: true, theme: 123 }));
      const warning = await run(test, ['--no-approve', '--no-session', '--model', 'mock/mock-model', '--print', 'Hello.']);
      expect(warning, warning.stderr).toMatchObject({ code: 0, signal: null });
      expect(warning.stderr).toContain('Warning: Settings ignored');
      expect(warning.stderr).toContain('theme');
      expect(warning.stdout).not.toContain('Warning:');
    } finally { await rm(test.root, { recursive: true, force: true }); }
  }, 30_000);
});
