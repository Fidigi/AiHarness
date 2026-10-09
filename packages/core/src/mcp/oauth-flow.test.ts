import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpServerTestTarget } from './config-inventory.js';
import {
  McpOAuthCredentialManager,
  type McpOAuthCredentialBackend,
} from './oauth.js';
import {
  McpOAuthFlowService,
  type McpOAuthFlowDriver,
  type McpOAuthFlowInfo,
} from './oauth-flow.js';

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

const services: McpOAuthFlowService[] = [];
let sequence = 0;

function target(overrides: Partial<McpServerTestTarget> = {}): McpServerTestTarget {
  return {
    scope: 'global',
    name: 'docs',
    sourcePath: '/agent/mcp.json',
    configKey: 'a'.repeat(64),
    cwd: '/workspace',
    config: { url: 'https://mcp.example.test/api' },
    ...overrides,
  };
}

function manager(): McpOAuthCredentialManager {
  return new McpOAuthCredentialManager(new MemoryBackend());
}

function flowService(
  credentialManager: McpOAuthCredentialManager,
  driver: McpOAuthFlowDriver,
  ttlMs = 2_000,
): McpOAuthFlowService {
  const service = new McpOAuthFlowService(credentialManager, {
    driver,
    ttlMs,
    keepMs: 100,
    createId: () => `flow-${String(++sequence).padStart(20, '0')}`,
  });
  services.push(service);
  return service;
}

async function waitFor(
  service: McpOAuthFlowService,
  id: string,
  phase: McpOAuthFlowInfo['phase'],
): Promise<McpOAuthFlowInfo> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const current = service.read(id);
    if (current?.phase === phase) return current;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Flow did not reach ${phase}.`);
}

function authorizationDriver(saveTokens = true): McpOAuthFlowDriver {
  return async context => {
    const binding = await context.manager.createProvider({
      identity: { name: context.target.name, url: (context.target.config as { url: string }).url },
      mode: 'interactive',
      redirectUrl: context.redirectUrl,
      state: context.state,
      validateWrite: async () => { await context.validateTarget(); },
    });
    context.publishAuthorizationUrl(new URL(
      `https://login.example.test/authorize?state=${encodeURIComponent(context.state)}&redirect_uri=${encodeURIComponent(context.redirectUrl)}`,
    ));
    const code = await context.waitForAuthorizationCode();
    expect(code).toBe('authorization-code');
    await context.validateTarget();
    if (saveTokens) {
      await binding.provider.saveTokens({
        access_token: 'flow-access-token',
        refresh_token: 'flow-refresh-token',
        token_type: 'Bearer',
      });
    }
    context.publishVerifying();
    return {};
  };
}

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.shutdown()));
  vi.restoreAllMocks();
});

describe('MCP OAuth flow service', () => {
  it('publishes a schema-safe poll state and accepts a pasted redirect', async () => {
    const credentials = manager();
    const service = flowService(credentials, authorizationDriver());
    const initial = target();
    const started = service.start({ target: initial, validate: async () => initial });
    expect(started.joined).toBe(false);
    expect(started.flow.phase).toBe('starting');
    expect(JSON.stringify(started.flow)).not.toContain('token');

    const authorize = await waitFor(service, started.flow.flowId, 'authorize');
    expect(authorize.authorizationUrl).toContain('https://login.example.test/authorize');
    expect(authorize.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/u);
    const authUrl = new URL(authorize.authorizationUrl!);
    const state = authUrl.searchParams.get('state');

    expect(service.pasteRedirect(
      started.flow.flowId,
      `${authorize.redirectUrl}?code=wrong&state=another-flow`,
    )).toEqual({ ok: false, code: 'state-mismatch' });
    expect(service.read(started.flow.flowId)?.phase).toBe('authorize');
    const valid = `${authorize.redirectUrl}?code=authorization-code&state=${encodeURIComponent(state!)}`;
    for (const malformed of [
      `${valid}#fragment`,
      valid.replace('http://', 'http://user:password@'),
      `${valid}&state=${encodeURIComponent(state!)}`,
      `${valid}&code=second-code`,
      `${authorize.redirectUrl}?state=${encodeURIComponent(state!)}`,
      `${authorize.redirectUrl}?code=authorization-code`,
      valid.replace('/oauth/callback', '/wrong-callback'),
      valid.replace('127.0.0.1', 'localhost'),
    ]) {
      expect(service.pasteRedirect(started.flow.flowId, malformed)).toEqual({ ok: false, code: 'invalid-redirect' });
      expect(service.read(started.flow.flowId)?.phase).toBe('authorize');
    }

    const accepted = service.pasteRedirect(
      started.flow.flowId,
      `${authorize.redirectUrl}?code=authorization-code&state=${encodeURIComponent(state!)}`,
    );
    expect(accepted?.ok).toBe(true);
    const completed = await waitFor(service, started.flow.flowId, 'connected');
    expect(completed.authorizationUrl).toBeUndefined();
    expect(JSON.stringify(completed)).not.toContain('flow-access-token');
    await expect(credentials.status({ name: initial.name, url: 'https://mcp.example.test/api' }))
      .resolves.toMatchObject({ signedIn: true });
  });

  it('accepts the browser loopback callback and joins a duplicate start', async () => {
    const service = flowService(manager(), authorizationDriver(false));
    const initial = target();
    const first = service.start({ target: initial, validate: async () => initial });
    const second = service.start({ target: initial, validate: async () => initial });
    expect(second).toEqual({ flow: expect.objectContaining({ flowId: first.flow.flowId }), joined: true });

    const authorize = await waitFor(service, first.flow.flowId, 'authorize');
    const state = new URL(authorize.authorizationUrl!).searchParams.get('state');
    const response = await fetch(
      `${authorize.redirectUrl}?code=authorization-code&state=${encodeURIComponent(state!)}`,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('authorization-code');
    await waitFor(service, first.flow.flowId, 'connected');
  });

  it('revalidates the target after runtime resolution before the first network request', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'));
    const initial = target();
    let validations = 0;
    const service = new McpOAuthFlowService(manager());
    services.push(service);
    const started = service.start({
      target: initial,
      validate: async () => ++validations === 1 ? initial : target({ configKey: 'b'.repeat(64) }),
    });
    expect(await waitFor(service, started.flow.flowId, 'failed'))
      .toMatchObject({ failure: 'configuration-changed' });
    expect(validations).toBe(2);
    expect(network).not.toHaveBeenCalled();
  });

  it('does not join an identical configuration from a different cwd or scope', async () => {
    const service = flowService(manager(), authorizationDriver(false));
    const initial = target();
    const first = service.start({ target: initial, validate: async () => initial });
    await waitFor(service, first.flow.flowId, 'authorize');
    const otherCwd = target({ cwd: '/other-workspace' });
    const second = service.start({ target: otherCwd, validate: async () => otherCwd });
    expect(second.joined).toBe(false);
    expect(service.read(first.flow.flowId)?.phase).toBe('cancelled');
    await waitFor(service, second.flow.flowId, 'authorize');
    const project = target({ scope: 'project', sourcePath: '/workspace/.ai-harness/mcp.json', cwd: '/other-workspace' });
    const third = service.start({ target: project, validate: async () => project });
    expect(third.joined).toBe(false);
    expect(service.read(second.flow.flowId)?.phase).toBe('cancelled');
    await waitFor(service, third.flow.flowId, 'authorize');
  });

  it('cancels a detached flow and refuses later pasted redirects', async () => {
    const service = flowService(manager(), authorizationDriver(false));
    const initial = target();
    const started = service.start({ target: initial, validate: async () => initial });
    const authorize = await waitFor(service, started.flow.flowId, 'authorize');

    expect(service.cancel(started.flow.flowId)?.phase).toBe('cancelled');
    expect(service.pasteRedirect(
      started.flow.flowId,
      `${authorize.redirectUrl}?code=authorization-code&state=ignored`,
    )).toEqual({ ok: false, code: 'flow-not-authorizing' });
  });

  it('closes the callback immediately even when the driver ignores cancellation', async () => {
    const service = flowService(manager(), async context => {
      context.publishAuthorizationUrl(new URL('https://login.example.test/authorize'));
      await new Promise<void>(() => {});
      return {};
    });
    const initial = target();
    const started = service.start({ target: initial, validate: async () => initial });
    const authorize = await waitFor(service, started.flow.flowId, 'authorize');
    service.cancel(started.flow.flowId);
    await expect(fetch(authorize.redirectUrl!)).rejects.toThrow();
    await service.shutdown();
    expect(service.read(started.flow.flowId)?.phase).toBe('cancelled');
  });

  it('reports a stable credential-write failure without exposing backend details', async () => {
    const backend = new MemoryBackend();
    backend.compareAndSet = async () => { throw new Error('backend-secret-detail'); };
    const credentials = new McpOAuthCredentialManager(backend);
    const service = flowService(credentials, authorizationDriver());
    const initial = target();
    const started = service.start({ target: initial, validate: async () => initial });
    const authorize = await waitFor(service, started.flow.flowId, 'authorize');
    const state = new URL(authorize.authorizationUrl!).searchParams.get('state');
    service.pasteRedirect(
      started.flow.flowId,
      `${authorize.redirectUrl}?code=authorization-code&state=${encodeURIComponent(state!)}`,
    );

    const failed = await waitFor(service, started.flow.flowId, 'failed');
    expect(failed).toMatchObject({ phase: 'failed', failure: 'credential-write-rejected' });
    expect(JSON.stringify(failed)).not.toContain('backend-secret-detail');
  });

  it('expires a flow and revalidates configuration before accepting credentials', async () => {
    const initial = target();
    let current = initial;
    const service = flowService(manager(), authorizationDriver(), 50);
    const started = service.start({ target: initial, validate: async () => current });
    const authorize = await waitFor(service, started.flow.flowId, 'authorize');
    current = target({ configKey: 'b'.repeat(64) });
    const state = new URL(authorize.authorizationUrl!).searchParams.get('state');
    service.pasteRedirect(
      started.flow.flowId,
      `${authorize.redirectUrl}?code=authorization-code&state=${encodeURIComponent(state!)}`,
    );
    const failed = await waitFor(service, started.flow.flowId, 'failed');
    expect(failed.failure).toBe('configuration-changed');

    const expiring = service.start({ target: current, validate: async () => current });
    const expired = await waitFor(service, expiring.flow.flowId, 'expired');
    expect(expired.authorizationUrl).toBeUndefined();
  });
});
