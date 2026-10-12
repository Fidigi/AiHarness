import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../sessions/session-manager.js';
import { CredentialRedactor } from '../providers/credentials.js';
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

  it('does not expose master keys or authenticated proxy channels to child processes', async () => {
    const previousMasterKey = process.env.AI_HARNESS_MASTER_KEY;
    const previousProxy = process.env.HTTPS_PROXY;
    const previousSshAgent = process.env.SSH_AUTH_SOCK;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.AI_HARNESS_MASTER_KEY = 'process-master-secret';
    process.env.HTTPS_PROXY = 'http://user:proxy-secret@proxy.example';
    process.env.SSH_AUTH_SOCK = '/tmp/private-agent.sock';
    process.env.DATABASE_URL = 'postgres://user:database-secret@database.example/app';
    try {
      const { cwd, session, runtime } = await setup();
      const command = runtime.start({
        sessionId: session.id,
        cwd,
        command: nodeCommand("process.stdout.write(JSON.stringify({master:process.env.AI_HARNESS_MASTER_KEY,proxy:process.env.HTTPS_PROXY,ssh:process.env.SSH_AUTH_SOCK,database:process.env.DATABASE_URL}))"),
        excludedFromContext: true,
      });
      await expect(runtime.wait(command.id)).resolves.toMatchObject({ output: '{}' });
    } finally {
      if (previousMasterKey === undefined) delete process.env.AI_HARNESS_MASTER_KEY;
      else process.env.AI_HARNESS_MASTER_KEY = previousMasterKey;
      if (previousProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = previousProxy;
      if (previousSshAgent === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = previousSshAgent;
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });

  it('applies reloadable shell path and command-prefix settings', async () => {
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

  it('redacts fragmented process output before events, files, snapshots, and sessions', async () => {
    const secret = 'fragmented-runtime-secret';
    const redactor = new CredentialRedactor([secret]);
    const { cwd, sessions, session, runtime } = await setup({
      maxOutputBytes: 8,
      outputTruncation: 'tail',
      retainFullOutput: true,
      redactText: value => redactor.redact(value),
      redactJson: value => redactor.redactJson(value),
      createTextRedactor: () => redactor.createStream(),
    });
    const events: unknown[] = [];
    const command = runtime.start({
      sessionId: session.id,
      cwd,
      command: nodeCommand(`process.stdout.write('${secret.slice(0, 10)}');setTimeout(() => process.stdout.write('${secret.slice(10)}'), 10)`),
      excludedFromContext: false,
    }, event => events.push(event));
    const completed = await runtime.wait(command.id);

    expect(JSON.stringify({ completed, events, session: sessions.get(session.id) })).not.toContain(secret);
    expect(await readFile(completed!.fullOutputPath!, 'utf8')).toBe('[REDACTED]');
    await rm(path.dirname(completed!.fullOutputPath!), { recursive: true, force: true });
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
