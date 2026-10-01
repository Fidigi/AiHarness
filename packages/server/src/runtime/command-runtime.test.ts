import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '@ai-harness/core';
import { CommandRuntime } from './command-runtime.js';

const directories: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aih-command-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function waitForExit(runtime: CommandRuntime, id: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (runtime.get(id)?.status !== 'running') return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Command did not exit');
}

describe('CommandRuntime', () => {
  it('streams, replays, bounds, and persists command output with context policy', async () => {
    const cwd = await temporaryDirectory();
    const manager = new SessionManager();
    const session = await manager.create({ cwd });
    const runtime = new CommandRuntime(manager);
    const live: string[] = [];
    const command = runtime.start({
      sessionId: session.id,
      cwd,
      command: "printf 'hello'; printf ' error' >&2",
      excludedFromContext: false,
    });
    const unsubscribe = runtime.subscribe(command.id, event => {
      if (event.type === 'output') live.push(String(event.data.chunk));
    });

    await waitForExit(runtime, command.id);
    await new Promise(resolve => setTimeout(resolve, 10));
    unsubscribe?.();

    expect(runtime.get(command.id)).toMatchObject({ status: 'completed', exitCode: 0, output: expect.stringContaining('hello') });
    expect(live.join('')).toContain('hello');
    const replay = runtime.replay(command.id, 0);
    expect(replay.at(-1)?.type).toBe('exit');
    expect(replay.map(event => event.sequence)).toEqual(replay.map(event => event.sequence).sort((a, b) => a - b));
    expect(manager.get(session.id)?.commands?.[0]).toMatchObject({
      command: command.command,
      excludedFromContext: false,
      status: 'completed',
    });
    expect(manager.getEffectiveContext(session.id).some(entry => entry.type === 'message' && entry.content.includes('$ printf'))).toBe(true);
  });

  it('cancels a running process and excludes !! commands from model context', async () => {
    const cwd = await temporaryDirectory();
    const manager = new SessionManager();
    const session = await manager.create({ cwd });
    const runtime = new CommandRuntime(manager);
    const command = runtime.start({
      sessionId: session.id,
      cwd,
      command: 'sleep 30',
      excludedFromContext: true,
    });

    expect(runtime.cancel(command.id)).toMatchObject({ status: 'cancelled', exitCode: 130 });
    await waitForExit(runtime, command.id);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(manager.get(session.id)?.commands?.[0]?.status).toBe('cancelled');
    expect(manager.getEffectiveContext(session.id).some(entry => entry.id === `context-command-${command.id}`)).toBe(false);
  });
});
