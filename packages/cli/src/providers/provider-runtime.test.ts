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
  it('persists credentials encrypted and resolves only their process-local value', async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-credentials-'));
    roots.push(agentDir);
    const env = { AI_HARNESS_MASTER_KEY: 'a sufficiently long test master key' };
    const first = await createCliProviderRuntime(agentDir, {}, env);
    const descriptor = await first.credentials.setApiKey('openai', 'private-cli-secret');
    expect(descriptor).toMatchObject({ provider: 'openai', source: 'encrypted-store' });
    expect(JSON.stringify(descriptor)).not.toContain('private-cli-secret');

    const restored = await createCliProviderRuntime(agentDir, {}, env);
    expect(restored.values.get('openai')).toBe('private-cli-secret');
    expect(await readFile(path.join(agentDir, 'credentials.enc'), 'utf8')).not.toContain('private-cli-secret');
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
