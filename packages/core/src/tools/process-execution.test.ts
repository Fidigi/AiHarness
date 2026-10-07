import { EventEmitter } from 'node:events';
import { access, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: childProcessMocks.spawn,
}));

import {
  cleanupExpiredProcessOutputs,
  createTemporaryProcessOutput,
  executeProcess,
} from './process-execution.js';

function uncooperativeChild(): EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: null;
  signalCode: null;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
} {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    pid: 42_424,
    kill: vi.fn(() => true),
  });
}

describe('executeProcess forced completion', () => {
  beforeEach(() => childProcessMocks.spawn.mockReset());

  it('settles after timeout even when the child never emits close', async () => {
    const child = uncooperativeChild();
    childProcessMocks.spawn.mockReturnValue(child);
    const startedAt = Date.now();

    const result = await executeProcess({
      executable: '/bin/uncooperative',
      args: [],
      cwd: process.cwd(),
      timeoutMs: 10,
    });

    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  }, 4_000);
});

describe('temporary process output cleanup', () => {
  it('removes only expired owned directories and never follows a matching symlink', async () => {
    const prefix = `aih-output-test-${process.pid}-${Date.now()}-`;
    const retentionMs = 60_000;
    const stale = await createTemporaryProcessOutput({ prefix, retentionMs });
    const fresh = await createTemporaryProcessOutput({ prefix, retentionMs });
    const staleFile = (await stale.finalize(true))!;
    const freshFile = (await fresh.finalize(true))!;
    const staleDirectory = path.dirname(staleFile);
    const freshDirectory = path.dirname(freshFile);
    const external = await mkdtemp(path.join(os.tmpdir(), 'aih-output-external-'));
    const marker = path.join(external, 'marker.txt');
    const linked = path.join(os.tmpdir(), `${prefix}linked`);
    await writeFile(marker, 'keep');
    await symlink(external, linked, process.platform === 'win32' ? 'junction' : 'dir');

    try {
      const old = new Date(Date.now() - retentionMs - 5_000);
      await utimes(staleDirectory, old, old);
      await cleanupExpiredProcessOutputs({ prefix, retentionMs });

      await expect(access(staleDirectory)).rejects.toThrow();
      await expect(access(freshDirectory)).resolves.toBeUndefined();
      await expect(access(marker)).resolves.toBeUndefined();
    } finally {
      await rm(staleDirectory, { recursive: true, force: true });
      await rm(freshDirectory, { recursive: true, force: true });
      await rm(linked, { force: true });
      await rm(external, { recursive: true, force: true });
    }
  });
});
