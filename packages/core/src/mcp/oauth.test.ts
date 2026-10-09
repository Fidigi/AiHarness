import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EncryptedCredentialStore } from '../security/credential-store.js';
import {
  McpOAuthAuthorizationRequiredError,
  McpOAuthCredentialManager,
  McpOAuthSignedOutError,
  mcpOAuthStorageName,
  mcpOAuthUrl,
  type McpOAuthCredentialBackend,
} from './oauth.js';

const directories: string[] = [];

async function encryptedManager() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-harness-mcp-oauth-'));
  directories.push(directory);
  const filePath = path.join(directory, 'credentials.enc');
  const store = new EncryptedCredentialStore(
    filePath,
    'correct horse battery staple',
  );
  const secrets: string[] = [];
  const manager = new McpOAuthCredentialManager(store, {
    add: value => { if (value) secrets.push(value); },
    redact: value => secrets.reduce((text, secret) => text.split(secret).join('•••'), value),
  });
  return { manager, store, secrets, filePath };
}

function tokens(access: string, refresh = `${access}-refresh`) {
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: 'Bearer',
    expires_in: 3600,
  };
}

async function saveInteractive(
  manager: McpOAuthCredentialManager,
  identity: { name: string; url: string },
  access: string,
) {
  const binding = await manager.createProvider({
    identity,
    mode: 'interactive',
    redirectUrl: 'http://127.0.0.1:43123/oauth/callback',
  });
  await binding.provider.saveClientInformation?.({
    client_id: `${identity.name}-client`,
    redirect_uris: ['http://127.0.0.1:43123/oauth/callback'],
  });
  await binding.provider.saveTokens(tokens(access));
  return binding;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('MCP OAuth credentials', () => {
  it('isolates encrypted credentials by server name and normalized URL', async () => {
    const { manager, store } = await encryptedManager();
    const first = { name: 'first', url: 'https://mcp.example.test/api' };
    const second = { name: 'second', url: 'https://mcp.example.test/api' };

    await saveInteractive(manager, first, 'first-token');
    await saveInteractive(manager, second, 'second-token');

    expect(await manager.status(first)).toEqual({ available: true, signedIn: true, stateStored: true });
    expect(await manager.status(second)).toEqual({ available: true, signedIn: true, stateStored: true });
    expect(mcpOAuthStorageName(first)).not.toBe(mcpOAuthStorageName(second));
    expect(store.list().filter(name => name.startsWith('mcp-oauth:'))).toHaveLength(2);
    expect(JSON.stringify(store.list())).not.toContain('mcp.example.test');
  });

  it('keeps ordinary connections passive while allowing stored tokens', async () => {
    const { manager } = await encryptedManager();
    const identity = { name: 'docs', url: 'https://mcp.example.test/' };
    const empty = await manager.createProvider({ identity, mode: 'passive' });

    await expect(empty.provider.clientInformation()).rejects.toBeInstanceOf(
      McpOAuthAuthorizationRequiredError,
    );
    await expect(empty.provider.redirectToAuthorization(new URL('https://login.example.test/authorize')))
      .rejects.toBeInstanceOf(McpOAuthAuthorizationRequiredError);

    await saveInteractive(manager, identity, 'stored-access');
    const passive = await manager.createProvider({ identity, mode: 'passive' });
    await expect(Promise.resolve(passive.provider.tokens())).resolves.toMatchObject({
      access_token: 'stored-access',
      refresh_token: 'stored-access-refresh',
    });
    expect(passive.redact('Bearer stored-access')).toBe('Bearer •••');
  });

  it('supports configured clients without exposing their secret', async () => {
    const { manager, secrets } = await encryptedManager();
    const resolveClientSecret = vi.fn(async () => 'configured-client-secret');
    const binding = await manager.createProvider({
      identity: { name: 'configured', url: 'https://mcp.example.test/configured' },
      mode: 'interactive',
      redirectUrl: 'http://127.0.0.1:42000/oauth/callback',
      settings: { clientId: 'configured-client', resolveClientSecret, scopes: ['tools.read'] },
    });

    await expect(binding.provider.clientInformation()).resolves.toEqual({
      client_id: 'configured-client',
      client_secret: 'configured-client-secret',
    });
    expect(binding.provider.clientMetadata.scope).toBe('tools.read');
    expect(resolveClientSecret).toHaveBeenCalledTimes(1);
    expect(secrets).toContain('configured-client-secret');
    expect(binding.redact('configured-client-secret')).toBe('•••');
  });

  it('drops tokens when configured client identity changes or is removed', async () => {
    const { manager } = await encryptedManager();
    const identity = { name: 'client-change', url: 'https://mcp.example.test/client-change' };
    const first = await manager.createProvider({
      identity,
      mode: 'interactive',
      settings: { clientId: 'configured-client', resolveClientSecret: async () => 'first-secret' },
    });
    await first.provider.clientInformation();
    await first.provider.saveTokens(tokens('configured-access'));
    expect(await manager.status(identity)).toMatchObject({ signedIn: true });

    const changed = await manager.createProvider({
      identity,
      mode: 'passive',
      settings: { clientId: 'configured-client', resolveClientSecret: async () => 'second-secret' },
    });
    await expect(changed.provider.clientInformation()).resolves.toMatchObject({
      client_id: 'configured-client', client_secret: 'second-secret',
    });
    expect(changed.provider.tokens()).toBeUndefined();
    expect(await manager.status(identity)).toMatchObject({ signedIn: false, stateStored: true });

    const removed = await manager.createProvider({ identity, mode: 'passive' });
    await expect(removed.provider.clientInformation()).rejects.toBeInstanceOf(
      McpOAuthAuthorizationRequiredError,
    );
    expect(await manager.status(identity)).toMatchObject({ signedIn: false, stateStored: false });
  });

  it('prevents a provider created before logout from restoring tokens', async () => {
    const { manager } = await encryptedManager();
    const identity = { name: 'logout', url: 'https://mcp.example.test/logout' };
    const stale = await saveInteractive(manager, identity, 'old-access');

    await expect(manager.signOut(identity)).resolves.toBe(true);
    await expect(stale.provider.saveTokens(tokens('resurrected')))
      .rejects.toBeInstanceOf(McpOAuthSignedOutError);
    expect(await manager.status(identity)).toEqual({
      available: true,
      signedIn: false,
      stateStored: false,
    });
  });

  it('refuses a stale cross-process writer even after a status read advances the shared cache', async () => {
    const { manager, filePath } = await encryptedManager();
    const identity = { name: 'cross-process', url: 'https://mcp.example.test/race' };
    const stale = await saveInteractive(manager, identity, 'old-access');
    const other = new McpOAuthCredentialManager(new EncryptedCredentialStore(
      filePath, 'correct horse battery staple',
    ));
    await other.signOut(identity);
    await expect(manager.status(identity)).resolves.toMatchObject({ signedIn: false });
    await expect(stale.provider.saveTokens(tokens('resurrected')))
      .rejects.toMatchObject({ name: 'McpOAuthCredentialWriteError' });
    await expect(other.status(identity)).resolves.toMatchObject({ signedIn: false, stateStored: false });
  });

  it('persists a revocation marker that rejects an empty-baseline writer in another process', async () => {
    const { manager, filePath } = await encryptedManager();
    const identity = { name: 'empty-race', url: 'https://mcp.example.test/empty-race' };
    const stale = await manager.createProvider({ identity, mode: 'interactive' });
    const other = new McpOAuthCredentialManager(new EncryptedCredentialStore(
      filePath, 'correct horse battery staple',
    ));
    await expect(other.signOut(identity)).resolves.toBe(false);
    await manager.status(identity);
    await expect(stale.provider.saveTokens(tokens('must-not-resurrect')))
      .rejects.toMatchObject({ name: 'McpOAuthCredentialWriteError' });
    const fresh = await other.createProvider({ identity, mode: 'interactive' });
    await fresh.provider.saveTokens(tokens('explicit-new-login'));
    await expect(other.status(identity)).resolves.toMatchObject({ signedIn: true });
  });

  it('deletes a refresh write that was already in flight when logout began', async () => {
    class DelayedBackend implements McpOAuthCredentialBackend {
      values = new Map<string, string>();
      compareStarted!: () => void;
      readonly started = new Promise<void>(resolve => { this.compareStarted = resolve; });
      release!: () => void;
      readonly gate = new Promise<void>(resolve => { this.release = resolve; });
      async load() {}
      get(name: string) { return this.values.get(name); }
      async set(name: string, value: string) { this.values.set(name, value); }
      async delete(name: string) { return this.values.delete(name); }
      async compareAndSet(name: string, expected: string | undefined, value: string | undefined) {
        this.compareStarted();
        await this.gate;
        if (this.values.get(name) !== expected) return false;
        if (value === undefined) this.values.delete(name);
        else this.values.set(name, value);
        return true;
      }
    }
    const backend = new DelayedBackend();
    const manager = new McpOAuthCredentialManager(backend);
    const identity = { name: 'race', url: 'https://mcp.example.test/race' };
    const binding = await manager.createProvider({ identity, mode: 'interactive' });
    const saving = binding.provider.saveTokens(tokens('late-access'));
    await backend.started;
    const logout = manager.signOut(identity);
    backend.release();

    await saving;
    await expect(logout).resolves.toBe(true);
    expect(await manager.status(identity)).toMatchObject({ signedIn: false, stateStored: false });
  });

  it('only offers OAuth for HTTP entries without an Authorization header', () => {
    expect(mcpOAuthUrl({ url: 'https://mcp.example.test' })).toBe('https://mcp.example.test/');
    expect(mcpOAuthUrl({
      url: 'https://mcp.example.test',
      headers: { authorization: 'Bearer ${TOKEN}' },
    })).toBeUndefined();
    expect(mcpOAuthUrl({ command: 'node' })).toBeUndefined();
  });
});
