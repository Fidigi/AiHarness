import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadAgentSettings } from '../config/agent-settings.js';
import {
  createPluginCommandRunner,
  pluginCommandEnvironment,
  pluginCommandFailure,
  pluginNpmInvocation,
  resolvePluginNpmCommand,
} from './package-command.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-npm-command-'));
  roots.push(root);
  return root;
}

describe('configured npm executable and literal argv', () => {
  it('keeps shell metacharacters, quotes, dollar expressions and spaces literal; anchors only the executable', () => {
    const args = ['install', '--ignore-scripts'];
    const prefix = ['a b', '$(touch marker)', '; touch marker', 'x|y', '"quoted"'];
    expect(pluginNpmInvocation({ npmCommand: ['./bin/npm wrapper', ...prefix], npmCommandBaseDirectory: '/settings' }, args))
      .toEqual({ executable: '/settings/bin/npm wrapper', args: [...prefix, ...args] });
    expect(pluginNpmInvocation({}, args)).toEqual({ executable: 'npm', args });
    expect(pluginNpmInvocation({ npmCommand: ['npm', '--registry=https://example.test'] }, args))
      .toEqual({ executable: 'npm', args: ['--registry=https://example.test', ...args] });
  });

  it.each([
    // eslint-disable-next-line no-sparse-arrays -- Deliberately hostile caller data.
    null, 'npm --flag', {}, [], [''], [' '], [42], ['-npm'], Array(1), ['npm', , 'arg'],
    ['npm', 'x\n'], ['npm\0'], ['npm', '\u007f'], ['npm', '\u0085'], ['npm', '\u202e'],
    ['npm', 'x'.repeat(4097)], ['npm', 'é'.repeat(2049)],
    Array.from({ length: 65 }, () => 'npm'),
    ['npm', ...Array.from({ length: 9 }, () => 'x'.repeat(4096))],
  ].map(command => ({ command })))('refuses malformed, control or oversized operator data without echoing it: %#', ({ command }) => {
    expect(() => pluginNpmInvocation({ npmCommand: command as string[] }, []))
      .toThrow('Invalid npmCommand: expected bounded executable and literal argv.');
  });

  it('bounds explicit executable paths and accepts the item/count boundary', () => {
    expect(() => pluginNpmInvocation({ npmCommand: ['./npm'] }, [])).toThrow(/Invalid npmCommand/);
    expect(() => pluginNpmInvocation({ npmCommand: ['./npm'], npmCommandBaseDirectory: 'relative' }, []))
      .toThrow(/Invalid npmCommand/);
    expect(() => pluginNpmInvocation({ npmCommand: ['./npm'], npmCommandBaseDirectory: `/${'x'.repeat(4096)}` }, []))
      .toThrow(/Invalid npmCommand/);
    expect(pluginNpmInvocation({ npmCommand: ['npm', ...Array.from({ length: 63 }, () => 'x')] }, []).args).toHaveLength(63);
    expect(pluginNpmInvocation({ npmCommand: ['npm', 'é'.repeat(2048)] }, []).args[0]).toHaveLength(2048);
    expect(pluginNpmInvocation({ npmCommand: ['npm', ...Array.from({ length: 7 }, () => 'x'.repeat(4096)), 'x'.repeat(4093)] }, []).args)
      .toHaveLength(8);
  });

  it('uses trusted project-over-global array precedence and the declaring settings directory', async () => {
    const root = await temp();
    const cwd = path.join(root, 'workspace');
    const agentDir = path.join(root, 'agent');
    await mkdir(path.join(cwd, '.ai-harness'), { recursive: true });
    await mkdir(agentDir);
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ npmCommand: ['./global-npm', 'global'] }));
    await writeFile(path.join(cwd, '.ai-harness', 'settings.json'), JSON.stringify({ npmCommand: ['./project-npm', 'project'] }));
    const global = await loadAgentSettings({ cwd, agentDir, projectTrusted: false });
    expect(resolvePluginNpmCommand(global)).toEqual({ npmCommand: ['./global-npm', 'global'], npmCommandBaseDirectory: agentDir });
    const project = await loadAgentSettings({ cwd, agentDir, projectTrusted: true });
    const projectOptions = resolvePluginNpmCommand(project);
    expect(projectOptions).toEqual({ npmCommand: ['./project-npm', 'project'], npmCommandBaseDirectory: path.join(cwd, '.ai-harness'), npmCommandSourceWorkspace: cwd });
    expect(Object.isFrozen(projectOptions)).toBe(true);
    expect(Object.isFrozen(projectOptions.npmCommand)).toBe(true);
    project.projectSettings.npmCommand![0] = 'changed-after-selection';
    expect(projectOptions.npmCommand).toEqual(['./project-npm', 'project']);
    expect(pluginNpmInvocation(projectOptions, ['view']).executable)
      .toBe(path.join(cwd, '.ai-harness', 'project-npm'));
  });

  it('preserves rejected settings as a lazy value-free refusal and respects scope replacement', async () => {
    const root = await temp();
    const cwd = path.join(root, 'workspace');
    const agentDir = path.join(root, 'agent');
    const projectPath = path.join(cwd, '.ai-harness', 'settings.json');
    await mkdir(path.dirname(projectPath), { recursive: true });
    await mkdir(agentDir);
    const globalPath = path.join(agentDir, 'settings.json');
    for (const content of [
      JSON.stringify({ npmCommand: null }), '{private invalid JSON',
      JSON.stringify({ npmCommand: ['-private-executable'] }),
    ]) {
      await writeFile(globalPath, content);
      await writeFile(projectPath, JSON.stringify({ npmCommand: ['./project-npm'] }));
      const replaced = await loadAgentSettings({ cwd, agentDir, projectTrusted: true });
      expect(pluginNpmInvocation(resolvePluginNpmCommand(replaced), []).executable).toBe(path.join(path.dirname(projectPath), 'project-npm'));
    }
    await writeFile(globalPath, JSON.stringify({ npmCommand: ['private-global-npm'] }));
    for (const content of [
      JSON.stringify({ npmCommand: null }), JSON.stringify({ npmCommand: [] }), '[]',
      JSON.stringify({ futureExecutablePolicy: 'private value', npmCommand: ['private-project-npm'] }),
      JSON.stringify({ defaultModel: 42 }),
    ]) {
      await writeFile(projectPath, content);
      const resolved = await loadAgentSettings({ cwd, agentDir, projectTrusted: true });
      const options = resolvePluginNpmCommand(resolved); // Does not throw on a passive read.
      expect(options).toEqual({ npmCommandBlocked: true });
      expect(() => pluginNpmInvocation(options, [])).toThrow('Invalid npmCommand: expected bounded executable and literal argv.');
      const untrusted = await loadAgentSettings({ cwd, agentDir, projectTrusted: false });
      expect(pluginNpmInvocation(resolvePluginNpmCommand(untrusted), []).executable).toBe('private-global-npm');
    }
  });

  it('refuses truncated diagnostic evidence even when a trusted project replacement looks clean', async () => {
    const root = await temp();
    const cwd = path.join(root, 'workspace');
    const agentDir = path.join(root, 'agent');
    await mkdir(path.join(cwd, '.ai-harness'), { recursive: true });
    await mkdir(agentDir);
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({
      modelThinkingLevels: Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`model-${index}`, false])),
    }));
    await writeFile(path.join(cwd, '.ai-harness', 'settings.json'), JSON.stringify({ npmCommand: ['private-project-npm'] }));
    const resolved = await loadAgentSettings({ cwd, agentDir, projectTrusted: true });
    expect(resolved.diagnostics).toHaveLength(128);
    expect(resolved.projectSettings.npmCommand).toEqual(['private-project-npm']);
    expect(() => pluginNpmInvocation(resolvePluginNpmCommand(resolved), [])).toThrow(/Invalid npmCommand/);
  });

  it('does not depend on source diagnostic text, paths or setting classification', async () => {
    const root = await temp();
    const resolved = await loadAgentSettings({ cwd: root, agentDir: path.join(root, 'agent'), projectTrusted: true });
    for (const setting of [undefined, '', 'npmCommand', 'npmCommand.executable', 'futurePolicy']) {
      resolved.diagnostics = [{ scope: 'project', path: 'private path', setting, message: 'private future diagnostic text' }];
      expect(resolvePluginNpmCommand(resolved)).toEqual({ npmCommandBlocked: true });
      expect(() => pluginNpmInvocation(resolvePluginNpmCommand(resolved), [])).toThrow(/Invalid npmCommand/);
    }
  });

  it('removes credentials and ambient Node/npm/Git execution configuration', () => {
    for (const name of ['OPENAI_API_KEY', 'HTTP_PROXY', 'NODE_OPTIONS', 'NODE_PATH', 'NPM_CONFIG_IGNORE_SCRIPTS', 'npm_config_script_shell', 'GIT_CONFIG_COUNT', 'BASH_ENV']) {
      vi.stubEnv(name, 'disposable-sensitive-value');
    }
    const env = pluginCommandEnvironment();
    expect(Object.values(env)).not.toContain('disposable-sensitive-value');
    expect(env).toMatchObject({ npm_config_ignore_scripts: 'true', GIT_TERMINAL_PROMPT: '0', PATH: process.env.PATH });
    expect(pluginCommandFailure({ code: 'SECRET\nInjected', stderr: 'secret' }, 'npm').message).toBe('npm a échoué (FAILED).');
  });
});

describe('real disposable bounded process runner', () => {
  it('redacts executable, argv, stderr and stdout on failure', async () => {
    const root = await temp();
    const script = path.join(root, 'private executable.mjs');
    await writeFile(script, 'console.log("private stdout"); console.error("private stderr"); process.exit(7);');
    await expect(createPluginCommandRunner().run(process.execPath, [script, 'private argv'], { timeoutMs: 1000 }))
      .rejects.toMatchObject({ message: 'npm a échoué (7).', code: 'PLUGIN_COMMAND_FAILED' });
    await expect(createPluginCommandRunner().run(path.join(root, 'private missing executable'), [], { timeoutMs: 1000 }))
      .rejects.toMatchObject({ message: 'npm a échoué (ENOENT).' });
  });

  it('terminates a SIGTERM-resistant process at its deadline and aborts promptly', async () => {
    const root = await temp();
    const script = path.join(root, 'wait.mjs');
    await writeFile(script, 'process.on("SIGTERM", () => {}); setInterval(() => {}, 10);');
    const started = Date.now();
    await expect(createPluginCommandRunner().run(process.execPath, [script], { timeoutMs: 100 }))
      .rejects.toMatchObject({ code: 'PLUGIN_COMMAND_FAILED' });
    expect(Date.now() - started).toBeLessThan(3000);
    const controller = new AbortController();
    const pending = createPluginCommandRunner().run(process.execPath, [script], { timeoutMs: 5000, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ message: 'npm a échoué (ABORT_ERR).' });
  });

  it('does not expose synchronous spawn errors or accept an unbounded deadline', async () => {
    const runner = createPluginCommandRunner();
    await expect(runner.run('private\0executable', [], { timeoutMs: 1000 }))
      .rejects.toMatchObject({ message: 'npm a échoué (ERR_INVALID_ARG_VALUE).' });
    for (const timeoutMs of [0, -1, Infinity, 120001]) {
      await expect(runner.run(process.execPath, [], { timeoutMs })).rejects.toMatchObject({ code: 'PLUGIN_COMMAND_FAILED' });
    }
  });

  it('kills POSIX wrapper descendants and ignores inherited stdin', async () => {
    const root = await temp();
    const runner = createPluginCommandRunner();
    const eof = path.join(root, 'eof.mjs');
    await writeFile(eof, 'process.stdin.resume(); process.stdin.on("end", () => console.log("eof"));');
    expect(await runner.run(process.execPath, [eof], { timeoutMs: 1000 })).toMatchObject({ stdout: 'eof\n' });
    if (process.platform === 'win32') return;
    const marker = path.join(root, 'descendant-must-not-survive');
    const script = path.join(root, 'tree.mjs');
    await writeFile(script, `import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', 'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "survived"), 700)', process.argv[2]], { stdio: 'inherit' });
process.on('SIGTERM', () => {}); setInterval(() => {}, 10);`);
    await expect(runner.run(process.execPath, [script, marker], { timeoutMs: 200 }))
      .rejects.toMatchObject({ message: 'npm a échoué (ETIMEDOUT).' });
    await new Promise(resolve => setTimeout(resolve, 800));
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses output over one MiB without returning any output', async () => {
    const root = await temp();
    const script = path.join(root, 'overflow.mjs');
    await writeFile(script, 'process.stdout.write("private-output".repeat(100000));');
    await expect(createPluginCommandRunner().run(process.execPath, [script], { timeoutMs: 1000 }))
      .rejects.toMatchObject({ message: 'npm a échoué (ERR_CHILD_PROCESS_STDIO_MAXBUFFER).' });
  });
});
