import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtensionRegistry, ProviderCredentialService, SessionManager } from '@ai-harness/core';
import { completeCliOptions, formatCliHelp, parseCliArguments } from './args.js';
import { resolveOfflineMode } from './offline-mode.js';
import { createConfiguredProviders, resolveStartupProvider } from '../providers/configured-providers.js';
import { createCliProviderRuntime } from '../providers/provider-runtime.js';
import { formatConfiguredModelList } from './model-list.js';
import { RpcController } from '../rpc/rpc-controller.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), 'aih-offline-cli-')); roots.push(root); return root; }

describe('CLI process-only offline policy', () => {
  for (const value of [undefined, '', '0', 'false', 'no', 'true-extra', '1\0', ' 1 ', '1', 'true', 'TRUE', 'yes', 'YeS']) {
    it(`snapshots the documented environment spelling ${JSON.stringify(value)}`, () => {
      const env = { AI_HARNESS_OFFLINE: value }; const expected = ['1', 'true', 'yes'].includes(value?.trim().toLowerCase() ?? '');
      expect(resolveOfflineMode(false, env)).toBe(expected);
      expect(resolveOfflineMode(undefined, env)).toBe(expected);
      expect(resolveOfflineMode(true, env)).toBe(true);
      expect(env.AI_HARNESS_OFFLINE).toBe(value);
    });
  }
  it('keeps the flag strict, reserved, idempotent, discoverable and distinct from prompt text', async () => {
    expect(parseCliArguments([]).offline).toBe(false);
    expect(parseCliArguments(['--offline', '--offline']).offline).toBe(true);
    for (const bootstrap of [false, true]) for (const value of ['true', 'false', '1', '']) {
      expect(() => parseCliArguments(['--offline=' + value], [], bootstrap)).toThrow('--offline does not accept a value.');
    }
    expect(parseCliArguments(['--', '--offline'])).toMatchObject({ offline: false, messages: ['--offline'] });
    expect(parseCliArguments(['prompt', '--offline'])).toMatchObject({ offline: false, messages: ['prompt', '--offline'] });
    await expect(new ExtensionRegistry().load('shadow', api => { api.registerOption('offline', { type: 'boolean', description: 'Shadow' }); }))
      .rejects.toThrow('Invalid extension startup option metadata.');
    const ambiguous = ['--offline-custom', 'Hello.', '--offline'];
    expect(parseCliArguments(ambiguous, [], true).offline).toBe(true);
    expect(parseCliArguments(ambiguous, [{ name: 'offline-custom', extensionId: 'arity', type: 'boolean', description: 'Arity' }]).offline).toBe(false);
    expect(formatCliHelp()).toContain('AI_HARNESS_OFFLINE'); expect(completeCliOptions('--off', [])).toEqual(['--offline']);
  });
  it('retains scoped startup selection and model listing without discovery, conserving default live discovery', async () => {
    const providers = createConfiguredProviders({}); const local = providers.get('local')!;
    const live = vi.spyOn(local, 'getAvailableModels').mockResolvedValue(['live-only']);
    expect(await resolveStartupProvider(providers, { models: ['mock/*'], offline: true }, {})).toMatchObject({ providerName: 'mock' });
    expect(await formatConfiguredModelList(providers, undefined, true)).toContain('local-model'); expect(live).not.toHaveBeenCalled();
    await expect(resolveStartupProvider(providers, { models: ['local/live-only'], offline: true }, {})).rejects.toThrow('Model "local/live-only" not found.');
    await resolveStartupProvider(providers, { models: ['mock/*'] }, {}); expect(live).toHaveBeenCalledTimes(1);
    expect(await formatConfiguredModelList(providers)).toContain('live-only'); expect(live).toHaveBeenCalledTimes(2);
  });
  for (const offline of [false, true]) {
    it(`RPC offline=${offline}: host callbacks and uncached catalogue requests respect the snapshot`, async () => {
      const providers = createConfiguredProviders({}), provider = providers.get('mock')!, sessionManager = new SessionManager();
      const discover = vi.spyOn(provider, 'getAvailableModels').mockResolvedValue(['live-only']);
      const callback = vi.fn(async () => [{ provider: 'mock', id: 'callback-only' }]);
      const controller = new RpcController({ offline, provider, providers, providerName: 'mock', model: 'mock-model', sessionManager, sessionId: 'offline-rpc', extensionRegistry: new ExtensionRegistry(), tools: [], providerModels: callback, modelDiscoveryCacheMs: 0,
        toolContext: { sessionManager, currentSessionId: 'offline-rpc', provider, providerName: 'mock', cwd: process.cwd(), projectTrusted: false, notify: () => undefined } }, () => undefined);
      await controller.initialize();
      for (const id of ['first', 'second']) {
        const result = await controller.handle({ type: 'get_available_models', id });
        expect(result).toMatchObject({ success: true });
        expect(JSON.stringify(result).includes('callback-only')).toBe(!offline);
        if (offline) expect(JSON.stringify(result)).toContain('mock-model');
      }
      expect(callback).toHaveBeenCalledTimes(offline ? 0 : 2); expect(discover).not.toHaveBeenCalled();
    });
  }
  it('skips configured credential commands in startup and reload composition while retaining valid environment keys', async () => {
    const root = await fixture(), marker = path.join(root, 'command');
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');process.stdout.write('fixture-key')`)}`;
    const settings = { providerApiKeyCommands: { local: command, extra: command } };
    const offline = await createCliProviderRuntime(root, settings, {}, undefined, false, [], undefined, true);
    expect([...offline.values]).toEqual([]); await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    const reloaded = await createCliProviderRuntime(root, settings, { LOCAL_API_KEY: 'environment-key' }, offline.credentials, false, [], undefined, true);
    expect([...reloaded.values]).toEqual([['local', 'environment-key']]); await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    const online = await createCliProviderRuntime(root, settings, {}, undefined, false);
    expect([...online.values]).toEqual([['local', 'fixture-key'], ['extra', 'fixture-key']]); expect(await readFile(marker, 'utf8')).toBe('executed');
  });
  it('skips expired OAuth refresh in automatic composition but preserves an explicit online refresh', async () => {
    const root = await fixture(), credentials = new ProviderCredentialService();
    await credentials.setOAuth('openai', { accessToken: 'expired-access', refreshToken: 'held-refresh', expiresAt: 1 }, false);
    const env = { AI_HARNESS_OAUTH_OPENAI_TOKEN_URL: 'https://oauth.example.test/token', AI_HARNESS_OAUTH_OPENAI_CLIENT_ID: 'fixture-client' };
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ access_token: 'fresh-access', expires_in: 3600 }), { status: 200 }));
    const offline = await createCliProviderRuntime(root, {}, env, credentials, false, [], undefined, true);
    expect(offline.credentials).toBe(credentials); expect(offline.values.has('openai')).toBe(false); expect(fetcher).not.toHaveBeenCalled();
    const online = await createCliProviderRuntime(root, {}, env, credentials, false);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(online.values.get('openai')).toBe('fresh-access');
  });
});
