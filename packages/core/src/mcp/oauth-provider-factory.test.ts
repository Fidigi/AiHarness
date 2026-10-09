import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpServerTestTarget } from './config-inventory.js';
import { McpOAuthCredentialManager, type McpOAuthCredentialBackend } from './oauth.js';
import { createMcpOAuthProviderFactory } from './oauth-provider-factory.js';

class MemoryBackend implements McpOAuthCredentialBackend {
  readonly values = new Map<string, string>();
  async load() {}
  get(name: string) { return this.values.get(name); }
  async set(name: string, value: string) { this.values.set(name, value); }
  async delete(name: string) { return this.values.delete(name); }
  async compareAndSet(name: string, expected: string | undefined, value: string | undefined) {
    if (this.values.get(name) !== expected) return false;
    if (value === undefined) this.values.delete(name);
    else this.values.set(name, value);
    return true;
  }
}

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function target(marker: string): McpServerTestTarget {
  return {
    scope: 'global',
    name: 'factory',
    sourcePath: '/agent/mcp.json',
    configKey: 'a'.repeat(64),
    cwd: path.dirname(marker),
    config: {
      url: 'https://mcp.example.test/factory',
      oauth: {
        clientId: 'factory-client',
        clientSecret: `!touch ${marker}; printf factory-secret`,
      },
    },
  };
}

describe('persistent MCP OAuth provider factory', () => {
  it('defers configured secret commands until an auth challenge and revalidates first', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-harness-oauth-factory-'));
    directories.push(directory);
    const marker = path.join(directory, 'command-ran');
    const initial = target(marker);
    let current = initial;
    const factory = createMcpOAuthProviderFactory({
      manager: new McpOAuthCredentialManager(new MemoryBackend()),
      resolveTarget: async () => current,
    });
    const binding = await factory(initial, new AbortController().signal);
    expect(binding).toBeDefined();
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });

    current = { ...initial, configKey: 'b'.repeat(64) };
    await expect(binding!.provider.clientInformation()).rejects.toThrow(
      'configuration changed during OAuth refresh',
    );
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });

    current = initial;
    const fresh = await factory(initial, new AbortController().signal);
    await expect(fresh!.provider.clientInformation()).resolves.toEqual({
      client_id: 'factory-client',
      client_secret: 'factory-secret',
    });
    await expect(readFile(marker, 'utf8')).resolves.toBe('');
  });
});
