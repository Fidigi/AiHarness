import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_SCHEMA_VERSION, type Session } from '../types/index.js';
import { deserializeSession, serializeSession } from './serialization.js';
import { JsonlSessionStore } from './session-manager.js';

const directories: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aih-serialization-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function richSession(): Session {
  return {
    id: 'rich-session',
    schemaVersion: SESSION_SCHEMA_VERSION,
    title: 'Rich data',
    cwd: '/workspace',
    workspaceId: 'workspace-1',
    gitBranch: 'feature/rich',
    parentId: 'parent',
    branchId: 'branch',
    activeLeafId: 'message-1',
    agentId: 'agent-1',
    messages: [{
      id: 'message-1',
      role: 'assistant',
      content: 'Result',
      timestamp: new Date('2026-01-02T03:04:05.000Z'),
      blocks: [
        { type: 'text', text: 'Result' },
        { type: 'reasoning', text: 'Private chain summary', durationMs: 42 },
        { type: 'image', mediaType: 'image/png', name: 'plot.png', size: 12, url: 'data:image/png;base64,AA==' },
        { type: 'tool_call', id: 'call-1', name: 'read', input: { path: 'README.md' } },
        { type: 'tool_result', toolCallId: 'call-1', name: 'read', content: 'text', truncated: false },
      ],
      model: 'model-1',
      provider: 'custom',
      usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, totalTokens: 14, costUsd: .001 },
      durationMs: 100,
      agentId: 'agent-1',
    }],
    commands: [{
      id: 'command-1',
      command: 'npm test',
      cwd: '/workspace',
      timestamp: new Date('2026-01-02T03:04:06.000Z'),
      status: 'completed',
      output: 'ok',
      exitCode: 0,
      durationMs: 55,
      excludedFromContext: true,
    }],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T03:04:06.000Z'),
    model: 'model-1',
    thinking: 'high',
    toolPreset: 'read-only',
    autoCompaction: false,
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, costUsd: .001 },
    providerConfig: {
      type: 'custom' as never,
      model: 'model-1',
      baseUrl: 'https://provider.invalid',
      apiKey: 'must-not-leak',
      authorization: 'must-not-leak-either',
    },
    metadata: { compactionSummary: 'summary', custom: { retained: true } },
  };
}

describe('versioned session serialization', () => {
  it('round-trips rich blocks, commands, branches, usage and dates while redacting credentials', () => {
    const original = richSession();
    const serialized = serializeSession(original);
    const encoded = JSON.stringify(serialized);

    expect(serialized.schemaVersion).toBe(SESSION_SCHEMA_VERSION);
    expect(encoded).not.toContain('must-not-leak');
    expect(serialized.providerConfig).toMatchObject({ type: 'custom', model: 'model-1' });
    expect(serialized.messages[0].blocks).toEqual(original.messages[0].blocks);

    const hydrated = deserializeSession(serialized);
    expect(hydrated).toMatchObject({
      id: original.id,
      cwd: '/workspace',
      parentId: 'parent',
      autoCompaction: false,
      usage: original.usage,
      metadata: original.metadata,
    });
    expect(hydrated.createdAt).toBeInstanceOf(Date);
    expect(hydrated.messages[0].timestamp).toEqual(original.messages[0].timestamp);
    expect(hydrated.commands?.[0]).toMatchObject({ command: 'npm test', excludedFromContext: true });
  });

  it('preserves rich data through JSONL and never writes provider secrets', async () => {
    const directory = await temporaryDirectory();
    const store = new JsonlSessionStore(directory);
    await store.saveSession(richSession());

    const raw = await readFile(path.join(directory, 'rich-session.jsonl'), 'utf8');
    expect(raw).not.toContain('must-not-leak');
    expect(raw).toContain('"version":2');
    expect(raw).toContain('"type":"command"');
    expect(raw).toContain('"type":"reasoning"');

    const loaded = await store.loadSession('rich-session');
    expect(loaded?.messages[0].blocks).toEqual(richSession().messages[0].blocks);
    expect(loaded?.commands?.[0]).toMatchObject({ output: 'ok', exitCode: 0 });
    expect(loaded?.providerConfig?.apiKey).toBeUndefined();
  });

  it('migrates legacy unversioned JSONL entries without dropping messages', async () => {
    const directory = await temporaryDirectory();
    const legacy = [
      { id: 'legacy-message', type: 'message', role: 'user', content: 'old format', timestamp: 1_700_000_000_000 },
      { id: 'legacy-assistant', type: 'message', role: 'assistant', content: 'still readable', timestamp: 1_700_000_001_000 },
    ].map(entry => JSON.stringify(entry)).join('\n');
    await writeFile(path.join(directory, 'legacy.jsonl'), `${legacy}\n`);

    const loaded = await new JsonlSessionStore(directory).loadSession('legacy');
    expect(loaded?.schemaVersion).toBe(SESSION_SCHEMA_VERSION);
    expect(loaded?.messages.map(message => message.content)).toEqual(['old format', 'still readable']);
    expect(loaded?.createdAt.toISOString()).toBe('2023-11-14T22:13:20.000Z');
  });
});
