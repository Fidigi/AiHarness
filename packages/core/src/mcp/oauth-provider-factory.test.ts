import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpServerTestTarget } from './config-inventory.js';
import { McpOAuthCredentialManager, mcpOAuthTargetName, type McpOAuthCredentialBackend } from './oauth.js';
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
  vi.restoreAllMocks();
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
  it('isolates registration OAuth credentials from files, foreign owners and replacement generations', async () => {
    const manager = new McpOAuthCredentialManager(new MemoryBackend());
    const file = { ...target('/workspace/marker'), config: { url: 'https://mcp.example.test/factory', oauth: { clientId: 'factory-client' } } };
    const first: McpServerTestTarget = { ...file, configKey: 'registration-one', registration: { extensionId: 'owner', id: '00000000-0000-4000-8000-000000000001' } };
    let current: McpServerTestTarget = first;
    const factory = createMcpOAuthProviderFactory({ manager, resolveTarget: async () => current });
    const seed = async (value: McpServerTestTarget, token: string) => {
      const binding = await manager.createProvider({ identity: { name: mcpOAuthTargetName(value), url: file.config.url }, mode: 'interactive', settings: { clientId: 'factory-client' } });
      await binding.provider.clientInformation(); await binding.provider.saveTokens({ access_token: token, token_type: 'Bearer' });
    };
    await seed(file, 'file-bearer');
    expect(await (await factory(first, new AbortController().signal))!.provider.tokens()).toBeUndefined();
    await seed(first, 'owner-bearer');
    const owned = await factory(first, new AbortController().signal);
    expect(await owned!.provider.tokens()).toMatchObject({ access_token: 'owner-bearer' });
    current = { ...first, configKey: 'replacement', registration: { extensionId: 'foreign', id: '00000000-0000-4000-8000-000000000002' } };
    expect(await (await factory(current, new AbortController().signal))!.provider.tokens()).toBeUndefined();
    await expect(owned!.provider.saveTokens({ access_token: 'late-bearer', token_type: 'Bearer' })).rejects.toThrow('configuration changed');
    current = file;
    expect(await (await factory(file, new AbortController().signal))!.provider.tokens()).toMatchObject({ access_token: 'file-bearer' });
    expect(mcpOAuthTargetName({ ...first, name: 'x'.repeat(256) })).toBe(mcpOAuthTargetName(first));
  });
  it('loads configured metadata only after challenge, revalidates, and never echoes malformed bodies', async () => {
    const initial: McpServerTestTarget = { ...target('/workspace/marker'), config: {
      url: 'https://mcp.example.test/factory', oauth: { authServerMetadataUrl: 'https://issuer.example/metadata' },
    } };
    let current = initial;
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('PRIVATE_REMOTE_METADATA invalid json'));
    const factory = createMcpOAuthProviderFactory({ manager: new McpOAuthCredentialManager(new MemoryBackend()), resolveTarget: async () => current });
    const binding = await factory(initial, new AbortController().signal);
    expect(network).not.toHaveBeenCalled();
    await expect(binding!.provider.discoveryState?.()).rejects.toThrow(/^OAuth metadata is invalid\.$/u);
    expect(network).toHaveBeenCalledTimes(1);
    current = { ...initial, configKey: 'b'.repeat(64) };
    await expect(binding!.provider.discoveryState?.()).rejects.toThrow('configuration changed during OAuth refresh');
    expect(network).toHaveBeenCalledTimes(1);
  });
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
