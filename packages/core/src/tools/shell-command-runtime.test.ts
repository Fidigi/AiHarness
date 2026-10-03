import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../sessions/session-manager.js';
import { parseShellCommandInput } from './shell-input.js';
import { ShellCommandRuntime } from './shell-command-runtime.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aih-shared-shell-'));
  temporaryDirectories.push(directory);
  return directory;
}

function nodeCommand(script: string): string {
  const executable = process.execPath.replace(/"/g, '\\"');
  return `"${executable}" -e ${JSON.stringify(script)}`;
}

async function setup(options: ConstructorParameters<typeof ShellCommandRuntime>[1] = {}) {
  const cwd = await temporaryDirectory();
  const sessions = new SessionManager();
  const session = await sessions.create({ cwd });
  const runtime = new ShellCommandRuntime(sessions, options);
  return { cwd, sessions, session, runtime };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('shared shell command input', () => {
  it('parses the same context policy for CLI and Web inputs', () => {
    expect(parseShellCommandInput('echo model')).toBeUndefined();
    expect(parseShellCommandInput(' !  printf public ')).toEqual({
      command: 'printf public', excludedFromContext: false,
    });
    expect(parseShellCommandInput('!!printf secret')).toEqual({
      command: 'printf secret', excludedFromContext: true,
    });
    expect(parseShellCommandInput('!!  ')).toEqual({ command: '', excludedFromContext: true });
  });
});

describe('ShellCommandRuntime', () => {
  it('streams, persists, and includes only opted-in commands in effective context', async () => {
    const { cwd, sessions, session, runtime } = await setup();
    const chunks: string[] = [];
    const included = runtime.start({
      sessionId: session.id,
      cwd,
      command: nodeCommand("process.stdout.write('public')"),
      excludedFromContext: false,
    }, event => {
      if (event.type === 'output') chunks.push(String(event.data.chunk));
    });
    const completed = await runtime.wait(included.id);

    expect(completed).toMatchObject({ status: 'completed', exitCode: 0, output: 'public', truncated: false });
    expect(chunks.join('')).toBe('public');
    expect(sessions.get(session.id)?.commands?.[0]).toMatchObject({
      id: `command-${included.id}`, excludedFromContext: false, status: 'completed',
    });
    expect(sessions.getEffectiveContext(session.id).some(entry => (
      entry.type === 'message' && entry.content.includes('public')
    ))).toBe(true);

    const excluded = runtime.start({
      sessionId: session.id,
      cwd,
      command: nodeCommand("process.stdout.write('secret-output')"),
      excludedFromContext: true,
    });
    await runtime.wait(excluded.id);
    expect(sessions.get(session.id)?.commands?.at(-1)).toMatchObject({ excludedFromContext: true });
    expect(sessions.getEffectiveContext(session.id).some(entry => (
      entry.type === 'message' && entry.content.includes('secret-output')
    ))).toBe(false);
  });

  it('applies reloadable Pi shell path and command-prefix settings', async () => {
    let prefix = 'export AIH_SETTINGS_PREFIX=first';
    const { cwd, session, runtime } = await setup({
      shellPath: '/bin/bash',
      commandPrefix: () => prefix,
    });
    const first = runtime.start({
      sessionId: session.id,
      cwd,
      command: 'printf %s "$AIH_SETTINGS_PREFIX"',
      excludedFromContext: true,
    });
    await expect(runtime.wait(first.id)).resolves.toMatchObject({ status: 'completed', output: 'first' });

    prefix = 'export AIH_SETTINGS_PREFIX=second';
    const second = runtime.start({
      sessionId: session.id,
      cwd,
      command: 'printf %s "$AIH_SETTINGS_PREFIX"',
      excludedFromContext: true,
    });
    await expect(runtime.wait(second.id)).resolves.toMatchObject({ status: 'completed', output: 'second' });
  });

  it('isolates stream listeners and awaits cancelled process persistence during shutdown', async () => {
    const { cwd, sessions, session, runtime } = await setup({ commandTimeoutMs: 5_000 });
    let outputStarted!: () => void;
    const startedOutput = new Promise<void>(resolve => { outputStarted = resolve; });
    const command = runtime.start({
      sessionId: session.id,
      cwd,
      command: nodeCommand("process.stdout.write('partial'); setInterval(() => {}, 1000)"),
      excludedFromContext: true,
    }, event => {
      if (event.type === 'output') {
        outputStarted();
        throw new Error('A presentation listener must not break command persistence.');
      }
    });
    await startedOutput;
    expect(runtime.cancel(command.id)).toMatchObject({ status: 'cancelled', exitCode: 130 });
    await runtime.shutdown();
    const completed = runtime.get(command.id);

    expect(completed).toMatchObject({ status: 'cancelled', exitCode: 130, output: 'partial' });
    expect(runtime.replay(command.id, 0).at(-1)?.type).toBe('cancelled');
    expect(sessions.get(session.id)?.commands?.[0]).toMatchObject({
      status: 'cancelled', exitCode: 130, output: 'partial',
    });
  });

  it('retains owner-only complete output only when the bounded transcript truncates', async () => {
    const { cwd, sessions, session, runtime } = await setup({
      maxOutputBytes: 32,
      outputTruncation: 'tail',
      retainFullOutput: true,
      fullOutputRetentionMs: 60_000,
    });
    const command = runtime.start({
      sessionId: session.id,
      cwd,
      command: nodeCommand("process.stdout.write('x'.repeat(128))"),
      excludedFromContext: false,
    });
    const completed = await runtime.wait(command.id);

    expect(completed).toMatchObject({ status: 'completed', truncated: true, output: 'x'.repeat(32) });
    expect(completed?.fullOutputPath).toEqual(expect.any(String));
    const fullOutputPath = completed!.fullOutputPath!;
    expect(await readFile(fullOutputPath, 'utf8')).toBe('x'.repeat(128));
    expect((await stat(fullOutputPath)).mode & 0o777).toBe(0o600);
    expect(sessions.get(session.id)?.commands?.[0]).toMatchObject({
      truncated: true, downloadPath: fullOutputPath,
    });
    await rm(path.dirname(fullOutputPath), { recursive: true, force: true });
  });
});
