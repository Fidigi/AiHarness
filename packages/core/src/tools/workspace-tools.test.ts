import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtensionRegistry, type ExtensionRuntimeContext } from '../extensions/extension-registry.js';
import { SessionManager } from '../sessions/session-manager.js';
import { WorkspaceManager } from '../security/workspace-manager.js';
import { registerWorkspaceTools } from './workspace-tools.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function setup(options: Parameters<typeof registerWorkspaceTools>[2] = {}): Promise<{
  root: string;
  registry: ExtensionRegistry;
  sessions: SessionManager;
  context: ExtensionRuntimeContext;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-tools-'));
  temporaryDirectories.push(root);
  const workspaceManager = new WorkspaceManager({ allowedRoots: [root], defaultCwd: root });
  await workspaceManager.initialize();
  const sessions = new SessionManager();
  const registry = new ExtensionRegistry();
  registry.attachSessionManager(sessions);
  await registerWorkspaceTools(registry, workspaceManager, options);
  return {
    root,
    registry,
    sessions,
    context: {
      sessionManager: sessions,
      cwd: root,
      projectTrusted: false,
      notify: vi.fn(),
    },
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('shared workspace tools', () => {
  it('registers the same canonical tool names for CLI and Web', async () => {
    const { registry } = await setup();
    const names = registry.getTools().map(tool => tool.name).sort();
    const expected = [
      'bash', 'edit', 'find', 'grep', 'ls', 'read', 'write',
      ...(process.platform === 'win32' ? ['powershell'] : []),
    ].sort();

    expect(names).toEqual(expected);
    expect(registry.list().find(extension => extension.id === 'builtin:workspace-tools')?.tools.sort())
      .toEqual(expected);
  });

  it('reads bounded line windows and rejects paths outside the active workspace', async () => {
    const { root, registry, context } = await setup();
    await writeFile(path.join(root, 'notes.txt'), 'alpha\nbeta\ngamma\ndelta');

    await expect(registry.executeTool('read', { path: 'notes.txt', offset: 2, limit: 2 }, context))
      .resolves.toMatchObject({ content: 'beta\ngamma\n\n[1 more lines in file. Use offset=4 to continue.]' });
    await expect(registry.executeTool('read', { path: '../outside.txt' }, context))
      .rejects.toThrow();

    await writeFile(path.join(root, 'large.txt'), Array.from({ length: 2_010 }, (_, index) => `line ${index + 1}`).join('\n'));
    const bounded = await registry.executeTool('read', { path: 'large.txt' }, context);
    expect(bounded.content).toContain('Showing lines 1-2000 of 2010');
    expect((bounded.details as { truncation?: { truncated: boolean } }).truncation?.truncated).toBe(true);
  });

  it('gates mutations on trust, creates parent directories, and applies exact edits atomically', async () => {
    const { root, registry, context } = await setup();
    await expect(registry.executeTool('write', { path: 'src/file.txt', content: 'one\ntwo\n' }, context))
      .rejects.toThrow(/trust/i);

    context.projectTrusted = true;
    await registry.executeTool('write', { path: 'src/file.txt', content: 'one\ntwo\n' }, context);
    await registry.executeTool('edit', {
      path: 'src/file.txt',
      edits: [
        { oldText: 'one', newText: 'ONE' },
        { oldText: 'two', newText: 'TWO' },
      ],
    }, context);
    expect(await readFile(path.join(root, 'src/file.txt'), 'utf8')).toBe('ONE\nTWO\n');

    await writeFile(path.join(root, 'duplicate.txt'), 'same\nsame\n');
    await expect(registry.executeTool('edit', {
      path: 'duplicate.txt', edits: [{ oldText: 'same', newText: 'changed' }],
    }, context)).rejects.toThrow(/not unique/i);
    expect(await readFile(path.join(root, 'duplicate.txt'), 'utf8')).toBe('same\nsame\n');
  });

  it('does not follow an escaping symlink for reads or writes', async () => {
    const { root, registry, context } = await setup();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'aih-tools-outside-'));
    temporaryDirectories.push(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'outside');
    await symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(registry.executeTool('read', { path: 'escape/secret.txt' }, context))
      .rejects.toThrow(/outside|hors/i);
    context.projectTrusted = true;
    await expect(registry.executeTool('write', { path: 'escape/new.txt', content: 'unsafe' }, context))
      .rejects.toThrow(/outside|hors/i);
  });

  it('shares git-aware find and grep behavior across interfaces', async () => {
    const { root, registry, context } = await setup();
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, '.gitignore'), 'ignored.ts\n');
    await writeFile(path.join(root, 'ignored.ts'), 'needle ignored\n');
    await writeFile(path.join(root, 'nested', 'visible.ts'), 'first\nneedle visible\nlast\n');
    await writeFile(path.join(root, 'nested', 'other.md'), 'needle markdown\n');
    await execFileAsync('git', ['init', '-q', root]);

    await expect(registry.executeTool('find', { pattern: '**/*.ts' }, context))
      .resolves.toMatchObject({ content: 'nested/visible.ts' });
    const grep = await registry.executeTool('grep', {
      pattern: 'needle', glob: '*.ts', context: 1,
    }, context);
    expect(grep.content).toContain('nested/visible.ts:2: needle visible');
    expect(grep.content).not.toContain('ignored');
    expect(grep.content).not.toContain('other.md');

    const listing = await registry.executeTool('ls', { path: 'nested' }, context);
    expect(listing.content).toBe('other.md\nvisible.ts');
  });

  it('runs trusted shell commands with bounded metadata and persists the command record', async () => {
    const { root, registry, sessions, context } = await setup();
    const session = await sessions.create({ title: 'Tools', cwd: root });
    context.currentSessionId = session.id;
    context.projectTrusted = true;
    const outputChunks: string[] = [];
    context.onProcessOutput = chunk => outputChunks.push(chunk);
    const command = process.platform === 'win32' ? 'Write-Output shared-output' : 'printf shared-output';

    const result = await registry.executeTool('bash', { command, timeout: 2 }, context);

    expect(result).toMatchObject({ content: 'shared-output', isError: false });
    expect(outputChunks.join('')).toContain('shared-output');
    expect(sessions.get(session.id)?.commands).toEqual([
      expect.objectContaining({ command, cwd: root, status: 'completed', exitCode: 0, excludedFromContext: true }),
    ]);
  });

  it('applies Pi shell path and prefix settings to the model bash tool', async () => {
    if (process.platform === 'win32') return;
    const { registry, context } = await setup({
      shellPath: '/bin/bash',
      shellCommandPrefix: 'export AIH_WORKSPACE_PREFIX=configured',
    });
    context.projectTrusted = true;
    await expect(registry.executeTool('bash', {
      command: 'printf %s "$AIH_WORKSPACE_PREFIX"', timeout: 2,
    }, context)).resolves.toMatchObject({ content: 'configured', isError: false });
  });

  it('persists the host full-output path for truncated shell results', async () => {
    const { root, registry, sessions, context } = await setup();
    const session = await sessions.create({ title: 'Truncated shell', cwd: root });
    context.currentSessionId = session.id;
    context.projectTrusted = true;
    context.processOutputPath = path.join(root, 'full-output.log');
    const executable = process.execPath.replace(/"/g, '\\"');
    const command = process.platform === 'win32'
      ? `& "${executable}" -e "process.stdout.write('x'.repeat(60000))"`
      : `"${executable}" -e "process.stdout.write('x'.repeat(60000))"`;

    const result = await registry.executeTool('bash', { command, timeout: 2 }, context);

    expect(result.details).toMatchObject({ truncated: true, fullOutputPath: context.processOutputPath });
    expect(sessions.get(session.id)?.commands?.at(-1)).toMatchObject({
      truncated: true, downloadPath: context.processOutputPath,
    });
  });

  it('waits for asynchronous process-output sinks before completing shell commands', async () => {
    const { registry, context } = await setup();
    context.projectTrusted = true;
    let releaseOutput!: () => void;
    let markOutputStarted!: () => void;
    const outputStarted = new Promise<void>(resolve => { markOutputStarted = resolve; });
    const outputGate = new Promise<void>(resolve => { releaseOutput = resolve; });
    context.onProcessOutput = async () => {
      markOutputStarted();
      await outputGate;
    };
    const command = process.platform === 'win32' ? 'Write-Output backpressure' : 'printf backpressure';
    const execution = registry.executeTool('bash', { command, timeout: 2 }, context);

    await outputStarted;
    const state = await Promise.race([
      execution.then(() => 'completed'),
      new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 20)),
    ]);
    expect(state).toBe('blocked');
    releaseOutput();
    await expect(execution).resolves.toMatchObject({ isError: false });
  });

  it('does not expose credential-like parent environment variables to shell commands', async () => {
    const { registry, context } = await setup();
    context.projectTrusted = true;
    const previousSecret = process.env.AI_HARNESS_TEST_SECRET;
    const previousAccessKey = process.env.AWS_ACCESS_KEY_ID;
    process.env.AI_HARNESS_TEST_SECRET = 'must-not-leak';
    process.env.AWS_ACCESS_KEY_ID = 'must-not-leak-either';
    try {
      const command = process.platform === 'win32'
        ? 'Write-Output "$env:AI_HARNESS_TEST_SECRET$env:AWS_ACCESS_KEY_ID"'
        : 'printf %s "$AI_HARNESS_TEST_SECRET$AWS_ACCESS_KEY_ID"';
      const result = await registry.executeTool('bash', { command, timeout: 2 }, context);
      expect(result.content).not.toContain('must-not-leak');
    } finally {
      if (previousSecret === undefined) delete process.env.AI_HARNESS_TEST_SECRET;
      else process.env.AI_HARNESS_TEST_SECRET = previousSecret;
      if (previousAccessKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
      else process.env.AWS_ACCESS_KEY_ID = previousAccessKey;
    }
  });

  it('propagates cancellation to the active shell process and persists its status', async () => {
    const { root, registry, sessions, context } = await setup();
    const session = await sessions.create({ title: 'Cancelled tool', cwd: root });
    context.currentSessionId = session.id;
    context.projectTrusted = true;
    const controller = new AbortController();
    const command = process.platform === 'win32'
      ? 'Write-Output partial; Start-Sleep -Seconds 5'
      : 'printf partial; sleep 5';
    const execution = registry.executeTool('bash', { command, timeout: 10 }, context, controller.signal);
    setTimeout(() => controller.abort(), 25);

    await expect(execution).rejects.toThrow(/aborted/i);
    expect(sessions.get(session.id)?.commands).toEqual([
      expect.objectContaining({
        command, status: 'cancelled', output: expect.stringContaining('partial'), exitCode: 130,
        excludedFromContext: true,
      }),
    ]);
  });
});
