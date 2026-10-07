import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { ExternalOpenError, externalOpenCommand, openExternalTarget } from './open-external.js';

function spawnedChild(event: 'spawn' | 'error' = 'spawn'): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.unref = vi.fn(() => child);
  child.kill = vi.fn(() => true);
  queueMicrotask(() => child.emit(event, event === 'error' ? new Error('missing') : undefined));
  return child;
}

describe('host external opener', () => {
  it('selects shell-free platform commands for URLs and directories', () => {
    expect(externalOpenCommand('/tmp/project & notes', 'directory', 'linux'))
      .toEqual({ command: 'xdg-open', args: ['/tmp/project & notes'] });
    expect(externalOpenCommand('/Users/test/project', 'directory', 'darwin'))
      .toEqual({ command: 'open', args: ['/Users/test/project'] });
    expect(externalOpenCommand('C:\\project & notes', 'directory', 'win32'))
      .toEqual({ command: 'explorer.exe', args: ['C:\\project & notes'] });
    expect(externalOpenCommand('http://127.0.0.1:3099', 'url', 'win32'))
      .toEqual({ command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', 'http://127.0.0.1:3099'] });
    expect(externalOpenCommand('/tmp/project', 'directory', 'aix')).toBeUndefined();
  });

  it('launches detached with a bounded secret-free environment', async () => {
    const launch = vi.fn(() => spawnedChild());
    await openExternalTarget('/tmp/project & notes', 'directory', {
      platform: 'linux',
      spawnProcess: launch,
      environment: { PATH: '/bin', HOME: '/home/test', DISPLAY: ':1', OPENAI_API_KEY: 'secret' },
    });

    expect(launch).toHaveBeenCalledWith('xdg-open', ['/tmp/project & notes'], expect.objectContaining({
      detached: true,
      stdio: 'ignore',
      env: expect.objectContaining({ PATH: '/bin', HOME: '/home/test', DISPLAY: ':1' }),
    }));
    expect(launch.mock.calls[0]?.[2].env).not.toHaveProperty('OPENAI_API_KEY');
  });

  it('reports unsupported platforms and launch failures without leaking process details', async () => {
    await expect(openExternalTarget('/tmp/project', 'directory', { platform: 'aix' }))
      .rejects.toMatchObject<Partial<ExternalOpenError>>({ code: 'UNSUPPORTED_PLATFORM' });
    await expect(openExternalTarget('/tmp/project', 'directory', {
      platform: 'linux', spawnProcess: () => spawnedChild('error'),
    })).rejects.toMatchObject<Partial<ExternalOpenError>>({ code: 'LAUNCH_FAILED' });
    await expect(openExternalTarget('bad\0path', 'directory', { platform: 'linux' }))
      .rejects.toMatchObject<Partial<ExternalOpenError>>({ code: 'INVALID_TARGET' });
    await expect(openExternalTarget('relative/path', 'directory', { platform: 'linux' }))
      .rejects.toMatchObject<Partial<ExternalOpenError>>({ code: 'INVALID_TARGET' });
    await expect(openExternalTarget('file:///tmp/project', 'url', { platform: 'linux' }))
      .rejects.toMatchObject<Partial<ExternalOpenError>>({ code: 'INVALID_TARGET' });
  });

  it('bounds a launcher that emits neither spawn nor error', async () => {
    const child = new EventEmitter() as ChildProcess;
    child.unref = vi.fn(() => child);
    child.kill = vi.fn(() => true);
    await expect(openExternalTarget('/tmp/project', 'directory', {
      platform: 'linux', spawnProcess: () => child, timeoutMs: 100,
    })).rejects.toMatchObject<Partial<ExternalOpenError>>({ code: 'LAUNCH_FAILED' });
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
