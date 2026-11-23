import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  fileManagerAvailable,
  isLoopbackAddress,
  isLoopbackFileManagerRequest,
  openWorkspaceDirectory,
} from './workspace-file-manager.js';

function request(host: string, remoteAddress: string): Request {
  return { headers: { host }, socket: { remoteAddress } } as Request;
}

describe('workspace file-manager boundary', () => {
  it('accepts only loopback Host and peer addresses', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.42.0.8')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.2')).toBe(false);
    expect(isLoopbackFileManagerRequest(request('localhost:3099', '127.0.0.1'))).toBe(true);
    expect(isLoopbackFileManagerRequest(request('[::1]:3099', '::1'))).toBe(true);
    expect(isLoopbackFileManagerRequest(request('[::1].example.test', '::1'))).toBe(false);
    expect(isLoopbackFileManagerRequest(request('127.0.0.1:3099:80', '127.0.0.1'))).toBe(false);
    expect(isLoopbackFileManagerRequest(request('127.0.0.1:70000', '127.0.0.1'))).toBe(false);
    expect(isLoopbackFileManagerRequest(request('example.test', '127.0.0.1'))).toBe(false);
    expect(isLoopbackFileManagerRequest(request('localhost:3099', '10.0.0.2'))).toBe(false);
  });

  it('reports remote and unsupported requests without launching anything', () => {
    expect(fileManagerAvailable(request('example.test', '127.0.0.1'), 'linux'))
      .toEqual({ available: false, reason: 'remote-request' });
    expect(fileManagerAvailable(request('localhost', '127.0.0.1'), 'aix'))
      .toEqual({ available: false, reason: 'unsupported-platform' });
    expect(fileManagerAvailable(request('localhost', '127.0.0.1'), 'linux')).toEqual({ available: true });
  });

  it('supports an injected bounded launcher for route tests', async () => {
    const launch = vi.fn(async () => undefined);
    await openWorkspaceDirectory('/workspace/project', { openDirectory: launch });
    expect(launch).toHaveBeenCalledWith('/workspace/project');
  });
});
