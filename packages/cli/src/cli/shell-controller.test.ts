import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '@ai-harness/core';
import type { ShellCommandSummary, ShellCommandWriter, TerminalUI } from '../tui/terminal-ui.js';
import { InteractiveShellController } from './shell-controller.js';

const temporaryDirectories: string[] = [];

function nodeCommand(script: string): string {
  const executable = process.execPath.replace(/"/g, '\\"');
  return `"${executable}" -e ${JSON.stringify(script)}`;
}

async function setup(options: ConstructorParameters<typeof InteractiveShellController>[3] = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-shell-'));
  temporaryDirectories.push(cwd);
  const sessions = new SessionManager();
  const session = await sessions.create({ cwd });
  const output: string[] = [];
  const summaries: ShellCommandSummary[] = [];
  const writer: ShellCommandWriter = {
    write: chunk => output.push(chunk),
    finish: summary => summaries.push(summary),
  };
  const terminal = {
    startShellCommand: vi.fn(() => writer),
  } as unknown as TerminalUI;
  const errors: string[] = [];
  let trusted = true;
  const controller = new InteractiveShellController(sessions, terminal, {
    getSessionId: () => session.id,
    getCwd: () => cwd,
    isTrusted: () => trusted,
    reportError: message => errors.push(message),
  }, options);
  return {
    cwd, sessions, session, controller, terminal, output, summaries, errors,
    setTrusted: (value: boolean) => { trusted = value; },
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('InteractiveShellController', () => {
  it('only consumes shell syntax and validates command/trust before execution', async () => {
    const context = await setup({ retainFullOutput: false });
    await expect(context.controller.handle('normal prompt')).resolves.toBe(false);
    await expect(context.controller.handle('!!  ')).resolves.toBe(true);
    expect(context.errors.at(-1)).toMatch(/après !/i);

    context.setTrusted(false);
    await expect(context.controller.handle('!echo blocked')).resolves.toBe(true);
    expect(context.errors.at(-1)).toMatch(/trust|approuvez/i);
    expect(context.terminal.startShellCommand).not.toHaveBeenCalled();
  });

  it('streams ! and !! commands and persists their model-context policy', async () => {
    const context = await setup({ retainFullOutput: false });
    await expect(context.controller.handle(`!${nodeCommand("process.stdout.write('public')")}`)).resolves.toBe(true);
    await expect(context.controller.handle(`!!${nodeCommand("process.stdout.write('private')")}`)).resolves.toBe(true);

    expect(context.output.join('')).toBe('publicprivate');
    expect(context.summaries).toEqual([
      expect.objectContaining({ status: 'completed', exitCode: 0, truncated: false }),
      expect.objectContaining({ status: 'completed', exitCode: 0, truncated: false }),
    ]);
    expect(context.sessions.get(context.session.id)?.commands).toEqual([
      expect.objectContaining({ output: 'public', excludedFromContext: false }),
      expect.objectContaining({ output: 'private', excludedFromContext: true }),
    ]);
    const effective = context.sessions.getEffectiveContext(context.session.id);
    expect(effective.some(entry => entry.type === 'message' && entry.content.includes('public'))).toBe(true);
    expect(effective.some(entry => entry.type === 'message' && entry.content.includes('private'))).toBe(false);
  });

  it('aborts an active command and exposes retained output when the transcript is truncated', async () => {
    const context = await setup({ maxOutputBytes: 16, fullOutputRetentionMs: 60_000 });
    let streamed!: () => void;
    const firstChunk = new Promise<void>(resolve => { streamed = resolve; });
    (context.terminal.startShellCommand as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      write: (chunk: string) => { context.output.push(chunk); streamed(); },
      finish: (summary: ShellCommandSummary) => context.summaries.push(summary),
    }));
    const execution = context.controller.handle(
      `!${nodeCommand("process.stdout.write('x'.repeat(64)); setInterval(() => {}, 1000)")}`,
    );
    await firstChunk;
    expect(context.controller.abort()).toBe(true);
    await execution;

    expect(context.summaries[0]).toMatchObject({ status: 'cancelled', truncated: true, fullOutputPath: expect.any(String) });
    const fullOutputPath = context.summaries[0]!.fullOutputPath!;
    expect(await readFile(fullOutputPath, 'utf8')).toBe('x'.repeat(64));
    expect(context.sessions.get(context.session.id)?.commands?.[0]).toMatchObject({
      status: 'cancelled', excludedFromContext: false, downloadPath: fullOutputPath,
    });
    await rm(path.dirname(fullOutputPath), { recursive: true, force: true });
  });
});
