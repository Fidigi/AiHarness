import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderCredentialService, type ProviderOAuthCredential } from '@ai-harness/core';
import { createConfiguredProviders, resolveStartupProvider } from './configured-providers.js';
import { createCliProviderRuntime } from './provider-runtime.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('CLI provider runtime', () => {
  it('composes Copilot subscription routing without flattening tokens and observes logout on the next turn', async () => {
    const credentials = new ProviderCredentialService();
    const models = ['claude-fable-5', 'gemini-3.5-flash', 'gpt-5-mini'];
    const access: ProviderOAuthCredential = { version: 1, type: 'oauth', accessToken: 'disposable-cli-copilot', refreshToken: 'disposable-github-grant', expiresAt: Date.now() + 120000,
      subscription: { provider: 'github-copilot', availableModelIds: models } };
    await credentials.setOAuth('github-copilot', access, false);
    const runtime = await createCliProviderRuntime('/unused', {}, {}, credentials, false);
    expect(runtime.values.has('github-copilot')).toBe(false);
    expect(runtime.githubCopilot).toBeDefined();
    const providers = createConfiguredProviders({}, { credentials: runtime.values, githubCopilot: runtime.githubCopilot });
    expect(providers.has('github-copilot')).toBe(true);
    const fixture = JSON.parse(await readFile(new URL('../../../../tests/fixtures/github-copilot-routing-reference.json', import.meta.url), 'utf8')) as {
      rows: Array<{ model: string; case: string; expectedPath: string; expectedBody: unknown; responseEvents: Array<{ type?: string }> }>;
    };
    const transport = vi.spyOn(globalThis, 'fetch');
    for (const model of models) {
      const selected = await resolveStartupProvider(providers, { provider: 'github-copilot', model }, {});
      const row = fixture.rows.find(row => row.model === model && row.case === 'user')!;
      let posted: { url: string; body: unknown; authorization: string | null } | undefined;
      transport.mockImplementationOnce(async (url, init) => {
        posted = { url: String(url), body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get('authorization') };
        return new Response(row.responseEvents.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (row.responseEvents[0].type ? '' : 'data: [DONE]\n\n'), { headers: { 'content-type': 'text/event-stream' } });
      });
      const result = await selected.provider.chat([{ id: 'probe', role: 'user', content: 'probe', timestamp: new Date(0) }], {
        systemPrompt: 'Follow instructions', maxTokens: 64, cacheRetention: 'none',
        tools: [{ name: 'echo', description: 'Echo input', parameters: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'], additionalProperties: false } }],
      });
      const expected = structuredClone(row.expectedBody) as Record<string, unknown>; delete expected.tool_choice;
      expect(posted).toEqual({ url: 'https://api.individual.githubcopilot.com' + row.expectedPath, body: expected, authorization: 'Bearer disposable-cli-copilot' });
      expect(result).toMatchObject({ provider: 'github-copilot', model, content: 'ok' });
    }
    await credentials.delete('github-copilot');
    await expect(providers.get('github-copilot')!.chat([])).rejects.toThrow('GitHub Copilot');
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it.each(['runtime', 'parent', 'caller'] as const)('retires Copilot refresh and future resolution through the %s lifetime', async owner => {
    const credentials = new ProviderCredentialService(), parent = new AbortController(), caller = new AbortController();
    const original = { accessToken: 'runtime-original-token', refreshToken: 'runtime-github-grant', expiresAt: Date.now() + 120000,
      subscription: { provider: 'github-copilot' as const, availableModelIds: ['gpt-5-mini'] } };
    await credentials.setOAuth('github-copilot', original, false);
    const runtime = await createCliProviderRuntime('/unused', {}, {}, credentials, false, [], undefined, false, parent.signal);
    const expired = { ...original, expiresAt: Date.now() - 1000 };
    await credentials.setOAuth('github-copilot', expired, false);
    let ready!: () => void, release!: (response: Response) => void;
    const entered = new Promise<void>(resolve => { ready = resolve; });
    const held = new Promise<Response>(resolve => { release = resolve; });
    let calls = 0;
    const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (++calls === 1) return Response.json({ token: 'new-runtime-token', expires_at: Math.floor(Date.now() / 1000) + 3600 });
      ready(); return held;
    });
    const pending = runtime.githubCopilot!.credentialSource(caller.signal).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await entered;
    if (owner === 'runtime') runtime.close();
    else if (owner === 'parent') parent.abort();
    else caller.abort();
    expect((await pending).error).toMatchObject({ name: 'AbortError' });
    release(Response.json({ data: [{ id: 'gpt-5-mini', model_picker_enabled: true }] }));
    expect((await credentials.resolve('github-copilot', { env: {}, subscriptionProvider: 'github-copilot', now: 0 }))?.credential)
      .toEqual({ version: 1, type: 'oauth', ...expired });
    if (owner !== 'caller') await expect(runtime.githubCopilot!.credentialSource()).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport).toHaveBeenCalledTimes(2);
    runtime.close();
  });

  it('does not infer subscription consumers from API keys, generic OAuth, or a foreign storage label', async () => {
    for (const kind of ['api-key', 'oauth', 'foreign-label']) {
      const credentials = new ProviderCredentialService();
      if (kind === 'api-key') await credentials.setApiKey('github-copilot', 'disposable-api-key', false);
      else await credentials.setOAuth(kind === 'foreign-label' ? 'openai' : 'github-copilot', {
        accessToken: 'disposable-oauth', refreshToken: 'disposable-github-grant', expiresAt: Date.now() + 120000,
        ...(kind === 'foreign-label' ? { subscription: { provider: 'github-copilot' as const, availableModelIds: ['gpt-5-mini'] } } : {}),
      }, false);
      const runtime = await createCliProviderRuntime('/unused', {}, {}, credentials, false);
      expect(runtime.githubCopilot).toBeUndefined();
      expect(createConfiguredProviders({}, { credentials: runtime.values, githubCopilot: runtime.githubCopilot }).has('github-copilot')).toBe(false);
      if (kind === 'foreign-label') expect(runtime.values.has('openai')).toBe(false);
    }
  });

  it('does not refresh expired Copilot credentials when the CLI is offline', async () => {
    const credentials = new ProviderCredentialService();
    await credentials.setOAuth('github-copilot', { accessToken: 'disposable-expired', refreshToken: 'disposable-github', expiresAt: 1,
      subscription: { provider: 'github-copilot', availableModelIds: ['gpt-5-mini'] } }, false);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
    const runtime = await createCliProviderRuntime('/unused', {}, {}, credentials, false, [], undefined, true);
    expect(runtime.githubCopilot).toBeUndefined();
    expect(runtime.values.has('github-copilot')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([['cerebras', 'CEREBRAS_API_KEY', 'AI_HARNESS_CEREBRAS_API_KEY'],
    ['mistral-conversations', 'MISTRAL_API_KEY', 'AI_HARNESS_MISTRAL_CONVERSATIONS_API_KEY']] as const)(
    'resolves native %s environment, command and encrypted credentials without registration', async (provider, variable, firstVariable) => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-cerebras-credentials-'));
    roots.push(agentDir);
    const key = 'synthetic-cerebras-env';
    const environment = await createCliProviderRuntime(agentDir, {}, { [variable]: key });
    expect(environment.values.get(provider)).toBe(key);
    expect(environment.redactor.redact(key)).toBe('[REDACTED]');
    const env = { AI_HARNESS_MASTER_KEY: 'sufficiently long synthetic Cerebras master key' };
    const first = await createCliProviderRuntime(agentDir, {}, env);
    await first.credentials.setApiKey(provider, 'synthetic-cerebras-stored');
    const settings = { providerApiKeyCommands: { [provider]: `${JSON.stringify(process.execPath)} -e "process.stdout.write('synthetic-cerebras-command')"` } };
    const command = await createCliProviderRuntime(agentDir, settings, env);
    expect(command.values.get(provider)).toBe('synthetic-cerebras-command');
    const override = await createCliProviderRuntime(agentDir, settings, { ...env, [variable]: key, [firstVariable]: 'synthetic-cerebras-first' });
    expect(override.values.get(provider)).toBe('synthetic-cerebras-first');
    const offline = await createCliProviderRuntime(agentDir, settings, env, undefined, true, [], undefined, true);
    expect(offline.values.has(provider)).toBe(false);
    const restored = await createCliProviderRuntime(agentDir, {}, env);
    expect(restored.values.get(provider)).toBe('synthetic-cerebras-stored');
    expect(restored.redactor.redact('synthetic-cerebras-stored')).toBe('[REDACTED]');
    const bytes = await readFile(path.join(agentDir, 'credentials.enc'), 'utf8');
    for (const secret of [key, 'synthetic-cerebras-stored', 'synthetic-cerebras-command', 'synthetic-cerebras-first']) expect(bytes).not.toContain(secret);
  });

  it('redacts extension default API keys before use and on reload without changing credential precedence', async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-extension-credentials-'));
    roots.push(agentDir);
    const definition = (apiKey: string) => ({ type: 'extension', definition: {
      defaultConfig: { apiKey, model: 'public-model' }, create: () => { throw new Error('Must not construct providers while collecting secrets'); },
    } });
    const first = await createCliProviderRuntime(agentDir, {}, {}, undefined, false, [definition('extension-default-private-key')]);
    expect(first.values.has('extension')).toBe(false);
    expect(first.credentials.list()).toEqual([]);
    expect(first.redactor.redactJson({ thinkingSignature: 'opaque-extension-default-private-key-tail', model: 'public-model' }))
      .toEqual({ thinkingSignature: 'opaque-[REDACTED]-tail', model: 'public-model' });
    const reloaded = await createCliProviderRuntime(agentDir, {}, { AI_HARNESS_EXTENSION_API_KEY: 'extension-resolved-private-key' },
      first.credentials, false, [definition('extension-reloaded-private-key')]);
    expect(reloaded.values.get('extension')).toBe('extension-resolved-private-key');
    expect(reloaded.redactor).toBe(first.redactor);
    for (const secret of ['extension-default-private-key', 'extension-reloaded-private-key', 'extension-resolved-private-key'])
      expect(reloaded.redactor.redact(`opaque-${secret}-tail`)).toBe('opaque-[REDACTED]-tail');
    expect(reloaded.credentials.list()).toEqual([]);
  });

  it('persists credentials encrypted and resolves only their process-local value', async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-credentials-'));
    roots.push(agentDir);
    const env = { AI_HARNESS_MASTER_KEY: 'a sufficiently long test master key' };
    const first = await createCliProviderRuntime(agentDir, {}, env);
    const descriptor = await first.credentials.setApiKey('openai', 'private-cli-secret');
    expect(descriptor).toMatchObject({ provider: 'openai', source: 'encrypted-store' });
    expect(JSON.stringify(descriptor)).not.toContain('private-cli-secret');
    await first.credentials.setApiKey('bedrock', JSON.stringify({ bearerToken: 'private:bedrock:bearer' }));

    const restored = await createCliProviderRuntime(agentDir, {}, env);
    expect(restored.values.get('openai')).toBe('private-cli-secret');
    expect(await readFile(path.join(agentDir, 'credentials.enc'), 'utf8')).not.toContain('private-cli-secret');
    expect(restored.values.get('bedrock')).toBe(JSON.stringify({ bearerToken: 'private:bedrock:bearer' }));
    expect(restored.redactor.redact('private:bedrock:bearer')).toBe('[REDACTED]');
    expect(await readFile(path.join(agentDir, 'credentials.enc'), 'utf8')).not.toContain('private:bedrock:bearer');
  });

  it('resolves trusted configured commands and bounded network settings', async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-command-'));
    roots.push(agentDir);
    const runtime = await createCliProviderRuntime(agentDir, {
      providerApiKeyCommands: {
        openai: `${JSON.stringify(process.execPath)} -e "process.stdout.write('command-secret')"`,
        extension: `${JSON.stringify(process.execPath)} -e "process.stdout.write('extension-secret')"`,
      },
      transport: 'websocket',
      httpIdleTimeoutMs: 123,
      websocketConnectTimeoutMs: 456,
      retry: { provider: { timeoutMs: 789, maxRetries: 2, maxRetryDelayMs: 321 } },
    }, {});

    expect(runtime.values.get('openai')).toBe('command-secret');
    expect(runtime.values.get('extension')).toBe('extension-secret');
    expect(runtime.network).toEqual({
      transport: 'websocket', httpIdleTimeoutMs: 123, websocketConnectTimeoutMs: 456,
      requestTimeoutMs: 789, maxRetries: 2, maxRetryDelayMs: 321,
    });
  });
});
