import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCliProviderRuntime } from './provider-runtime.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('CLI provider runtime', () => {
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
