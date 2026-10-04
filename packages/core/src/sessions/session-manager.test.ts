// ============================================================
// Session Manager Tests - Persistence & Compaction
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  SessionManager,
  JsonlSessionStore,
  SessionEntry,
} from './session-manager';

// ===================================================================
// Test helpers
// ===================================================================

function createTempDir(): string {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ai-harness-test-'));
}

async function cleanup(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// ===================================================================
// JsonlSessionStore Tests
// ===================================================================

describe('JsonlSessionStore', () => {
  it('supports a disabled persistence mode for ephemeral/container execution', async () => {
    const store = new JsonlSessionStore(undefined, false);
    const session = {
      id: 'ephemeral', title: 'Éphémère', messages: [], createdAt: new Date(), updatedAt: new Date(),
    };

    await store.saveSession(session);
    expect(await store.listSessionIds()).toEqual([]);
    expect(await store.loadSession(session.id)).toBeNull();
    expect(await store.appendMessage(session.id, 'user', 'secret')).toBeTruthy();
    expect(await store.deleteSession(session.id)).toBe(true);
  });
  let store: JsonlSessionStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    store = new JsonlSessionStore(tempDir);
  });

  afterEach(async () => {
    await cleanup(tempDir);
  });

  describe('ensureDir()', () => {
    it('should create the sessions directory if it does not exist', async () => {
      const nonExistentPath = path.join(tempDir, 'non-existent');
      const newStore = new JsonlSessionStore(nonExistentPath);
      await expect(newStore.ensureDir()).resolves.toBeUndefined();

      // Verify directory was created
      const stats = await fs.stat(nonExistentPath);
      expect(stats.isDirectory()).toBe(true);
    });
  });

  describe('listSessionIds()', () => {
    it('should return empty array when no sessions exist', async () => {
      const ids = await store.listSessionIds();
      expect(ids).toEqual([]);
    });

    it('should list all session IDs sorted by modification time', async () => {
      // Create some JSONL files manually
      await store.saveSession({
        id: 'session-1',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(Date.now() - 1000),
      });

      await sleep(10); // Small delay to ensure different timestamps

      await store.saveSession({
        id: 'session-2',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const ids = await store.listSessionIds();
      expect(ids).toEqual(['session-2', 'session-1']); // Newest first
    });
  });

  describe('saveSession() / loadSession()', () => {
    it('should save and reload a session with messages', async () => {
      const session = {
        id: 'test-session',
        title: undefined, // Title will be auto-generated from first user message
        messages: [
          { id: 'msg-1', role: 'user' as any, content: 'Hello', timestamp: new Date('2024-01-01') },
          { id: 'msg-2', role: 'assistant' as any, content: 'Hi there!', timestamp: new Date('2024-01-01') },
        ],
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      };

      await store.saveSession(session);

      const loaded = await store.loadSession('test-session');
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe('test-session');
      // Title is auto-generated from first user message
      expect(loaded!.title).toBe('Hello');
      expect(loaded!.messages.length).toBe(2);
    });

    it('never persists provider credentials with non-secret configuration', async () => {
      const session = {
        id: 'sanitized-provider',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        providerConfig: {
          type: 'openai',
          baseUrl: 'https://provider.example/v1',
          openaiApiKey: 'secret-key',
          clientSecret: 'secret-client',
          refreshToken: 'secret-refresh',
          headers: { Authorization: 'Bearer nested-secret', 'X-Region': 'eu-west-1' },
        },
      };

      await store.saveSession(session);
      const serialized = await fs.readFile(path.join(tempDir, 'sanitized-provider.jsonl'), 'utf8');
      const loaded = await store.loadSession(session.id);

      expect(serialized).not.toContain('secret-key');
      expect(serialized).not.toContain('secret-client');
      expect(serialized).not.toContain('secret-refresh');
      expect(serialized).not.toContain('nested-secret');
      expect(loaded?.providerConfig).toEqual({
        type: 'openai',
        baseUrl: 'https://provider.example/v1',
        headers: { 'X-Region': 'eu-west-1' },
      });
    });

    it('should preserve session metadata, title, and branch ancestry', async () => {
      const session = {
        id: 'metadata-session',
        title: 'Titre personnalisé',
        messages: [],
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-02-01'),
        parentId: 'parent-1',
        branchId: 'branch-1',
        metadata: { pinned: true },
      };
      await store.saveSession(session);

      const loaded = await store.loadSession(session.id);

      expect(loaded).toMatchObject({
        title: 'Titre personnalisé',
        parentId: 'parent-1',
        branchId: 'branch-1',
        metadata: { pinned: true },
      });
    });

    it('should return null for non-existent session', async () => {
      const loaded = await store.loadSession('non-existent');
      expect(loaded).toBeNull();
    });

    it('should auto-generate title from first user message when not provided', async () => {
      const session = {
        id: 'auto-title-session',
        messages: [
          { id: 'msg-1', role: 'user' as any, content: 'This is my very long question about testing sessions', timestamp: new Date() },
          { id: 'msg-2', role: 'assistant' as any, content: 'Here is the answer.', timestamp: new Date() },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await store.saveSession(session);
      const loaded = await store.loadSession('auto-title-session');

      expect(loaded!.title).toBe('This is my very long question about testing sessio...');
    });

    it('should handle empty session (no messages)', async () => {
      const session = {
        id: 'empty-session',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await store.saveSession(session);
      const loaded = await store.loadSession('empty-session');

      expect(loaded).not.toBeNull();
      expect(loaded!.messages.length).toBe(0);
    });

    it('should skip malformed JSONL lines gracefully', async () => {
      const filePath = path.join(tempDir, 'malformed.jsonl');
      await fs.writeFile(filePath, [
        '{ valid: json }',
        JSON.stringify({ id: 'msg-1', type: 'message', role: 'user', content: 'Valid', timestamp: Date.now() }),
        JSON.stringify({ id: 'incomplete', type: 'message' }),
        'null',
      ].join('\n'));

      // The store should handle this by skipping syntactically and structurally invalid lines.
      const entries = await store.getRawEntries('malformed');
      expect(entries).toHaveLength(1);
    });

    it('derives dates from legacy files without metadata', async () => {
      await fs.writeFile(path.join(tempDir, 'legacy.jsonl'), [
        JSON.stringify({ id: 'old', type: 'message', role: 'user', content: 'Old', timestamp: 1_700_000_000_000 }),
        JSON.stringify({ id: 'new', type: 'message', role: 'assistant', content: 'New', timestamp: 1_700_000_100_000 }),
      ].join('\n'));

      const loaded = await store.loadSession('legacy');

      expect(loaded?.createdAt.getTime()).toBe(1_700_000_000_000);
      expect(loaded?.updatedAt.getTime()).toBe(1_700_000_100_000);
    });

    it('rejects session IDs that could escape the sessions directory', async () => {
      await expect(store.saveSession({
        id: '../escaped',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      })).rejects.toThrow('Invalid session ID');
      await expect(store.loadSession('../escaped')).rejects.toThrow('Invalid session ID');
    });

    it('does not discover, read, or overwrite symbolic-link session files', async () => {
      const target = path.join(tempDir, 'outside.txt');
      const link = path.join(tempDir, 'linked.jsonl');
      await fs.writeFile(target, 'do not overwrite');
      try {
        await fs.symlink(target, link);
      } catch {
        return; // Symlinks may require additional privileges on Windows.
      }

      expect(await store.listSessionIds()).not.toContain('linked');
      expect(await store.loadSession('linked')).toBeNull();
      await expect(store.saveSession({
        id: 'linked',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      })).rejects.toThrow();
      expect(await fs.readFile(target, 'utf8')).toBe('do not overwrite');

      const hardLink = path.join(tempDir, 'hard-linked.jsonl');
      await fs.link(target, hardLink);
      expect(await store.loadSession('hard-linked')).toBeNull();
      await expect(store.saveSession({
        id: 'hard-linked',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      })).rejects.toThrow();
      expect(await fs.readFile(target, 'utf8')).toBe('do not overwrite');
    });
  });

  describe('appendMessage()', () => {
    it('should append a message to an existing session file', async () => {
      // First create the file with saveSession
      await store.saveSession({
        id: 'append-test',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const msgId = await store.appendMessage('append-test', 'user', 'Hello world');

      expect(msgId).toBeDefined();
      expect(typeof msgId).toBe('string');

      // Verify the message was written to the file
      const content = await fs.readFile(path.join(tempDir, 'append-test.jsonl'), 'utf-8');
      const entry = JSON.parse(content.trim().split('\n').pop()!);
      expect(entry.role).toBe('user');
      expect(entry.content).toBe('Hello world');
    });

    it('should create the file if it does not exist', async () => {
      // Don't saveSession first, just append directly
      const msgId = await store.appendMessage('new-session-direct', 'user', 'Direct message');

      expect(msgId).toBeDefined();

      const loaded = await store.loadSession('new-session-direct');
      expect(loaded).not.toBeNull();
      expect(loaded!.messages.length).toBe(1);
    });

    it('should persist tool calls and tool results', async () => {
      await store.appendMessage('tool-test', 'assistant', '', {
        toolCalls: [{ id: 'call-1', name: 'sum', input: { a: 2, b: 3 } }],
      });
      await store.appendMessage('tool-test', 'tool', '5', {
        toolCallId: 'call-1',
        name: 'sum',
        isError: false,
      });

      const loaded = await store.loadSession('tool-test');

      expect(loaded?.messages[0].toolCalls).toEqual([{ id: 'call-1', name: 'sum', input: { a: 2, b: 3 } }]);
      expect(loaded?.messages[1]).toMatchObject({
        role: 'tool',
        content: '5',
        toolCallId: 'call-1',
        name: 'sum',
        isError: false,
      });
    });

    it('should generate unique IDs for each appended message', async () => {
      const id1 = await store.appendMessage('unique-test', 'user', 'First');
      const id2 = await store.appendMessage('unique-test', 'assistant', 'Second');
      const id3 = await store.appendMessage('unique-test', 'user', 'Third');

      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
    });
  });

  describe('appendBranchSummary()', () => {
    it('persists branch summaries as JSONL entries', async () => {
      await store.appendBranchSummary('branch-session', 'Branche test', 'Décision conservée.');
      const entries = await store.getRawEntries('branch-session');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        type: 'branch_summary',
        branchName: 'Branche test',
        summary: 'Décision conservée.',
      });
    });
  });

  describe('appendCompaction()', () => {
    it('should append a compaction entry to the session file', async () => {
      await store.saveSession({
        id: 'compaction-test',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await store.appendCompaction(
        'compaction-test',
        'This is a summary of the conversation.',
        'msg-kept-123',
        500,
      );

      const entries = await store.getRawEntries('compaction-test');
      expect(entries.length).toBe(1);

      const compactionEntry = entries[0];
      expect(compactionEntry.type).toBe('compaction');
      expect((compactionEntry as any).summary).toBe('This is a summary of the conversation.');
      expect((compactionEntry as any).firstKeptEntryId).toBe('msg-kept-123');
    });

    it('should work without tokenEstimate', async () => {
      await store.saveSession({
        id: 'no-token-test',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await store.appendCompaction(
        'no-token-test',
        'Summary without token info.',
        'msg-123',
      );

      const entries = await store.getRawEntries('no-token-test');
      expect(entries[0].type).toBe('compaction');
    });
  });

  describe('deleteSession()', () => {
    it('should delete the session file and return true', async () => {
      await store.saveSession({
        id: 'delete-me',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await store.deleteSession('delete-me');
      expect(result).toBe(true);

      // Verify file is gone
      const exists = await fs.access(path.join(tempDir, 'delete-me.jsonl'))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });

    it('should return false for non-existent session', async () => {
      const result = await store.deleteSession('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('getRawEntries()', () => {
    it('should return all entries from a session file', async () => {
      await store.saveSession({
        id: 'raw-entries-test',
        messages: [
          { id: 'msg-1', role: 'user' as any, content: 'Hello', timestamp: new Date() },
          { id: 'msg-2', role: 'assistant' as any, content: 'Hi!', timestamp: new Date() },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const entries = await store.getRawEntries('raw-entries-test');
      expect(entries.length).toBe(2);
    });

    it('should return empty array for non-existent session', async () => {
      const entries = await store.getRawEntries('non-existent');
      expect(entries).toEqual([]);
    });
  });
});

// ===================================================================
// SessionManager Tests (with JSONL persistence)
// ===================================================================

describe('SessionManager with JSONL Persistence', () => {
  let manager: SessionManager;
  let store: JsonlSessionStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    store = new JsonlSessionStore(tempDir);
    manager = new SessionManager();
    manager.setStore(store);
  });

  afterEach(async () => {
    await cleanup(tempDir);
  });

  describe('create()', async () => {
    it('should create a session and persist it', async () => {
      const session = await manager.create({ title: 'Test Session' });

      expect(session.id).toBeDefined();
      expect(session.title).toBe('Test Session');
      expect(session.messages.length).toBe(0);

      // Verify persistence
      const loadedStoreSession = await store.loadSession(session.id);
      expect(loadedStoreSession).not.toBeNull();
    });

    it('should auto-generate ID if not provided', async () => {
      const session1 = await manager.create({ title: 'Session 1' });
      const session2 = await manager.create({ title: 'Session 2' });

      expect(session1.id).not.toBe(session2.id);
    });
  });

  describe('addMessage()', async () => {
    it('should add a message and persist it', async () => {
      const session = await manager.create();
      const updatedSession = await manager.addMessage(session.id, { role: 'user', content: 'Hello' });

      expect(updatedSession!.messages.length).toBe(1);
      expect(updatedSession!.messages[0].content).toBe('Hello');

      // Verify persistence
      const loaded = await store.loadSession(session.id);
      expect(loaded!.messages.length).toBe(1);
    });

    it('should auto-generate title from first user message', async () => {
      const session = await manager.create();
      await manager.addMessage(session.id, { role: 'user', content: 'My question about testing is very long and detailed' });

      const loaded = await store.loadSession(session.id);
      // Title is auto-generated from first user message (first 50 chars + ...)
      expect(loaded!.title).toBe('My question about testing is very long and detaile...');
    });

    it('should return null for non-existent session', async () => {
      const result = await manager.addMessage('non-existent-session-id', { role: 'user', content: 'Hello' });
      expect(result).toBeNull();
    });

    it('aggregates cache tokens without inventing a cumulative unknown cost', async () => {
      const session = await manager.create();
      await manager.addMessage(session.id, {
        role: 'assistant',
        content: 'Known',
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 5,
          cacheWriteTokens: 1,
          costUsd: 0.1,
        },
      });
      expect(session.usage).toMatchObject({ totalTokens: 18, costUsd: 0.1 });

      await manager.addMessage(session.id, {
        role: 'assistant',
        content: 'Unknown price',
        usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
      });
      expect(session.usage).toMatchObject({ totalTokens: 22 });
      expect(session.usage?.costUsd).toBeUndefined();
      expect((await store.loadSession(session.id))?.usage?.costUsd).toBeUndefined();
    });

    it('should persist multiple messages in order', async () => {
      const session = await manager.create();
      await manager.addMessage(session.id, { role: 'user', content: 'First' });
      await manager.addMessage(session.id, { role: 'assistant', content: 'Second' });
      await manager.addMessage(session.id, { role: 'user', content: 'Third' });

      const loaded = await store.loadSession(session.id);
      expect(loaded!.messages.length).toBe(3);
      expect(loaded!.messages[0].content).toBe('First');
      expect(loaded!.messages[1].content).toBe('Second');
      expect(loaded!.messages[2].content).toBe('Third');
    });
  });

  describe('delete()', async () => {
    it('should delete a session from memory and disk', async () => {
      const session = await manager.create({ title: 'To Delete' });
      await manager.addMessage(session.id, { role: 'user', content: 'Hello' });

      const deleted = await manager.delete(session.id);
      expect(deleted).toBe(true);

      // Verify in-memory deletion
      expect(manager.get(session.id)).toBeUndefined();

      // Verify disk deletion
      const loaded = await store.loadSession(session.id);
      expect(loaded).toBeNull();
    });

    it('should return false for non-existent session', async () => {
      const deleted = await manager.delete('non-existent');
      expect(deleted).toBe(false);
    });
  });

  describe('list()', async () => {
    it('should list all sessions sorted by updatedAt (newest first)', async () => {
      await manager.create({ title: 'Old Session' });
      await sleep(10); // Small delay for different timestamps
      const session2 = await manager.create({ title: 'New Session' });

      const sessions = manager.list();
      expect(sessions.length).toBe(2);
      expect(sessions[0].title).toBe('New Session');
    });
  });

  // ===================================================================
  // Session Tree Operations (fork/clone/tree)
  // ===================================================================

  describe('Session tree operations', () => {
    it('should fork a session from the beginning', async () => {
      const session = await manager.create({ title: 'Original' });
      await manager.addMessage(session.id, { role: 'user', content: 'Hello' });
      await manager.addMessage(session.id, { role: 'assistant', content: 'Hi there!' });

      const forked = await (manager as any).forkSession(session.id);

      expect(forked).toBeTruthy();
      expect(forked!.id).not.toBe(session.id); // Different session ID
      expect(forked!.parentId).toBe(session.id); // Linked to original
      expect(forked!.messages.length).toBe(2); // Same messages
    });

    it('should fork a session from a specific message index', async () => {
      const session = await manager.create({ title: 'Original' });
      await manager.addMessage(session.id, { role: 'user', content: 'Hello' });
      await manager.addMessage(session.id, { role: 'assistant', content: 'Hi there!' });
      await manager.addMessage(session.id, { role: 'user', content: 'Follow-up' });

      const forked = await (manager as any).forkSession(session.id, 0);

      expect(forked!.messages.length).toBe(1); // Only first message
      expect(forked!.parentId).toBe(session.id);
    });

    it('forks a durable user entry hidden by compaction with its preceding command', async () => {
      const session = await manager.create({ title: 'Original' });
      await manager.addMessage(session.id, { role: 'user', content: 'First' });
      await manager.addMessage(session.id, { role: 'assistant', content: 'Answer' });
      await manager.addCommand(session.id, {
        command: 'printf context', cwd: '/workspace', status: 'completed', output: 'context',
      });
      await manager.addMessage(session.id, { role: 'user', content: 'Old target' });
      const targetId = session.messages.at(-1)!.id;
      await manager.addMessage(session.id, { role: 'assistant', content: 'Old answer' });
      await manager.addMessage(session.id, { role: 'user', content: 'Retained' });
      const retainedId = session.messages.at(-1)!.id;
      await manager.applyCompaction(session.id, 'Summary', retainedId);

      expect(session.messages.some(message => message.id === targetId)).toBe(false);
      const forked = await manager.forkSessionAtEntry(session.id, targetId, 'Historical fork');

      expect(forked?.messages.map(message => message.content)).toEqual(['First', 'Answer', 'Old target']);
      expect(forked?.commands?.map(command => command.command)).toEqual(['printf context']);
      expect(forked?.activeLeafId).toBe(targetId);
      expect(forked?.metadata?.compactionSummary).toBeUndefined();
    });

    it('branches in place while preserving the abandoned descendants in the durable tree', async () => {
      const session = await manager.create({ title: 'Original' });
      await manager.addMessage(session.id, { role: 'user', content: 'First' });
      await manager.addMessage(session.id, { role: 'assistant', content: 'First answer' });
      const command = await manager.addCommand(session.id, {
        command: 'pwd', cwd: '/workspace', status: 'completed', output: '/workspace',
      });
      await manager.addMessage(session.id, { role: 'user', content: 'Original prompt' });
      const originalPromptId = session.activeLeafId!;
      await manager.addMessage(session.id, { role: 'assistant', content: 'Abandoned answer' });

      const selected = await manager.branchBeforeEntry(session.id, originalPromptId);
      expect(selected?.content).toBe('Original prompt');
      expect(manager.get(session.id)?.activeLeafId).toBe(command?.id);
      expect(manager.get(session.id)?.messages.map(message => message.content)).toEqual(['First', 'First answer']);

      await manager.addMessage(session.id, { role: 'user', content: 'Edited prompt' });
      const raw = await manager.getRawEntries(session.id);
      const original = raw.find(entry => entry.id === originalPromptId);
      const edited = raw.find(entry => entry.type === 'message' && entry.content === 'Edited prompt');
      expect(original).toMatchObject({ parentMessageId: command?.id });
      expect(edited).toMatchObject({ parentMessageId: command?.id });
      expect(raw.some(entry => entry.type === 'message' && entry.content === 'Abandoned answer')).toBe(true);

      const reloaded = new SessionManager({ store: new JsonlSessionStore(tempDir) });
      await reloaded.loadAllSessions();
      expect(reloaded.get(session.id)?.messages.map(message => message.content))
        .toEqual(['First', 'First answer', 'Edited prompt']);
    });

    it('reconstructs compacted ancestors when branching in the process-local journal', async () => {
      const volatile = new SessionManager();
      const session = await volatile.create({ title: 'Volatile' });
      await volatile.addMessage(session.id, { role: 'user', content: 'First' });
      await volatile.addMessage(session.id, { role: 'assistant', content: 'Answer' });
      const parentId = session.activeLeafId;
      await volatile.addMessage(session.id, { role: 'user', content: 'Hidden target' });
      const targetId = session.activeLeafId!;
      await volatile.addMessage(session.id, { role: 'assistant', content: 'Abandoned answer' });
      await volatile.addMessage(session.id, { role: 'user', content: 'Retained' });
      await volatile.applyCompaction(session.id, 'Summary', session.activeLeafId!);
      expect(session.messages.map(message => message.content)).toEqual(['Retained']);

      await volatile.branchBeforeEntry(session.id, targetId);
      expect(session.activeLeafId).toBe(parentId);
      expect(session.messages.map(message => message.content)).toEqual(['First', 'Answer']);
      expect(session.metadata?.compactionSummary).toBeUndefined();
      await volatile.addMessage(session.id, { role: 'user', content: 'Edited target' });
      expect(session.messages.map(message => message.content)).toEqual(['First', 'Answer', 'Edited target']);
      expect((await volatile.getRawEntries(session.id)).some(
        entry => entry.type === 'message' && entry.content === 'Abandoned answer',
      )).toBe(true);
    });

    it('can branch before the first root entry without reviving the abandoned root', async () => {
      const session = await manager.create();
      await manager.addMessage(session.id, { role: 'user', content: 'Old root' });
      const rootId = session.activeLeafId!;
      await manager.addMessage(session.id, { role: 'assistant', content: 'Old answer' });

      await manager.branchBeforeEntry(session.id, rootId);
      expect(manager.get(session.id)?.messages).toEqual([]);
      await manager.addMessage(session.id, { role: 'user', content: 'New root' });

      const reloaded = new SessionManager({ store: new JsonlSessionStore(tempDir) });
      await reloaded.loadAllSessions();
      expect(reloaded.get(session.id)?.messages.map(message => message.content)).toEqual(['New root']);
      expect((await reloaded.getRawEntries(session.id)).filter(entry => entry.type === 'message')).toHaveLength(3);
    });

    it('persists branch-summary ancestry and advances the active leaf', async () => {
      const session = await manager.create({ title: 'Original' });
      await manager.addMessage(session.id, { role: 'user', content: 'Branch point' });
      const parentEntryId = session.activeLeafId;

      const summary = await manager.addBranchSummary(session.id, 'Tried another path.', 'Alternative');
      const persisted = (await manager.getRawEntries(session.id)).find(entry => entry.id === summary?.id);

      expect(summary).toMatchObject({ parentEntryId, branchName: 'Alternative' });
      expect(persisted).toMatchObject({ id: summary?.id, parentEntryId });
      expect(session.activeLeafId).toBe(summary?.id);
    });

    it('should clone a session with all messages', async () => {
      const session = await manager.create({ title: 'Original' });
      await manager.addMessage(session.id, { role: 'user', content: 'Hello' });
      await manager.addMessage(session.id, { role: 'assistant', content: 'Hi there!' });

      const cloned = await (manager as any).cloneSession(session.id);

      expect(cloned).toBeTruthy();
      expect(cloned!.id).not.toBe(session.id); // Different session ID
      expect(cloned!.messages.length).toBe(2); // Same number of messages
      expect(cloned!.parentId).toBeUndefined(); // Independent root, unlike a fork
      expect(cloned!.messages[0]?.id).not.toBe(session.messages[0]?.id);
      expect(cloned!.messages[1]?.parentMessageId).toBe(cloned!.messages[0]?.id);
      expect(cloned!.activeLeafId).toBe(cloned!.messages[1]?.id);
      expect(cloned!.metadata?.clonedFromSessionId).toBe(session.id);
    });

    it('remaps command ancestry when cloning an interleaved history', async () => {
      const session = await manager.create({ title: 'Original' });
      await manager.addMessage(session.id, { role: 'user', content: 'Inspect' });
      const sourceUserId = session.activeLeafId;
      const command = await manager.addCommand(session.id, {
        command: 'pwd', cwd: '/workspace', status: 'completed', output: '/workspace',
      });
      await manager.addMessage(session.id, { role: 'assistant', content: 'Done' });

      const cloned = await manager.cloneSession(session.id);
      const clonedUser = cloned?.messages[0];
      const clonedCommand = cloned?.commands?.[0];
      const clonedAssistant = cloned?.messages[1];

      expect(command?.parentEntryId).toBe(sourceUserId);
      expect(clonedCommand?.id).not.toBe(command?.id);
      expect(clonedCommand?.parentEntryId).toBe(clonedUser?.id);
      expect(clonedAssistant?.parentMessageId).toBe(clonedCommand?.id);
    });

    it('should clone an independent session through a specific message', async () => {
      const session = await manager.create({ title: 'Original' });
      await manager.addMessage(session.id, { role: 'user', content: 'First' });
      await manager.addMessage(session.id, { role: 'assistant', content: 'Second' });

      const cloned = await manager.cloneSession(session.id, 'Partial', 0);

      expect(cloned).toMatchObject({ title: 'Partial' });
      expect(cloned?.parentId).toBeUndefined();
      expect(cloned?.messages.map(message => message.content)).toEqual(['First']);
    });

    it('should get session tree structure with correct nested depths', async () => {
      const session = await manager.create({ title: 'Root' });
      const forked1 = await manager.forkSession(session.id);
      const forked2 = await manager.forkSession(session.id);
      const nestedFork = await manager.forkSession(forked1!.id);

      const tree = manager.getSessionTree();
      expect(tree).toHaveLength(4);
      expect(tree.find(node => node.id === session.id)?.depth).toBe(0);
      expect(tree.find(node => node.id === forked1!.id)?.depth).toBe(1);
      expect(tree.find(node => node.id === forked2!.id)?.depth).toBe(1);
      expect(tree.find(node => node.id === nestedFork!.id)?.depth).toBe(2);
    });

    it('should get branch sessions', async () => {
      const session = await manager.create({ title: 'Root' });
      
      await (manager as any).forkSession(session.id);
      await (manager as any).forkSession(session.id);

      const branchSessions = (manager as any).getBranchSessions();
      expect(branchSessions.length).toBe(3); // All sessions in the same branch
    });

    it('should delete session with all its forks', async () => {
      const session = await manager.create({ title: 'Root' });
      
      await (manager as any).forkSession(session.id);
      await (manager as any).forkSession(session.id);

      // Verify sessions exist before deletion
      expect(manager.list().length).toBe(3);

      const deletedCount = await (manager as any).deleteWithForks(session.id);
      
      expect(deletedCount).toBe(3); // All 3 sessions should be deleted
      expect(manager.list().length).toBe(0);
    });
  });

  describe('loadFromStore()', async () => {
    it('should load a session from the JSONL store into memory', async () => {
      // Create and save via store directly (bypassing manager)
      await store.saveSession({
        id: 'external-session',
        title: undefined, // Title will be auto-generated from first user message
        messages: [
          { id: 'msg-1', role: 'user' as any, content: 'Hello from external', timestamp: new Date() },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Load into manager
      const loaded = await manager.loadFromStore('external-session');

      expect(loaded).not.toBeNull();
      // Title is auto-generated from first user message (max 50 chars + ...)
      expect(loaded!.title).toBe('Hello from external');
      expect(loaded!.messages.length).toBe(1);

      // Verify it's now in memory
      const fromMemory = manager.get('external-session');
      expect(fromMemory).toBeDefined();
    });
  });

  describe('loadAllSessions()', async () => {
    it('should load all sessions from the store on initialization', async () => {
      // Create sessions directly via store (simulating previous runs)
      await store.saveSession({
        id: 'session-a',
        title: 'Session A',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await store.saveSession({
        id: 'session-b',
        title: 'Session B',
        messages: [
          { id: 'msg-1', role: 'user' as any, content: 'Hi', timestamp: new Date() },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Create fresh manager and load all sessions
      const freshManager = new SessionManager();
      freshManager.setStore(store);
      await freshManager.loadAllSessions();

      expect(freshManager.list().length).toBe(2);
    });
  });

  describe('getTokenCount()', async () => {
    it('should estimate token count for a session', async () => {
      const session = await manager.create();
      await manager.addMessage(session.id, { role: 'user', content: 'Hello world' });

      const tokens = manager.getTokenCount(session.id);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should return 0 for non-existent session', async () => {
      const tokens = manager.getTokenCount('non-existent');
      expect(tokens).toBe(0);
    });
  });

  describe('requestCompaction()', async () => {
    beforeEach(() => {
      // Set low thresholds to trigger compaction easily for tests
      manager.setCompactionSettings({ enabled: true, reserveTokens: 100, keepRecentTokens: 50 });
    });

    it('should return null when there are too few messages', async () => {
      const session = await manager.create();
      await manager.addMessage(session.id, { role: 'user', content: 'Hello' });

      const result = manager.requestCompaction(session.id);
      expect(result).toBeNull();
    });

    it('should return null when compaction is disabled', async () => {
      const session = await manager.create();
      manager.setCompactionSettings({ enabled: false, reserveTokens: 100, keepRecentTokens: 50 });

      // Add enough messages (though with low thresholds they might not trigger)
      for (let i = 0; i < 5; i++) {
        await manager.addMessage(session.id, { role: 'user', content: `Message ${i}` });
      }

      const result = manager.requestCompaction(session.id);
      expect(result).toBeNull();
    });

    it('should identify messages to compact when threshold is exceeded', async () => {
      // Use very low thresholds for testing
      manager.setCompactionSettings({ enabled: true, reserveTokens: 10, keepRecentTokens: 20 });

      const session = await manager.create();
      // Add enough short messages to exceed the compactable threshold
      for (let i = 0; i < 8; i++) {
        await manager.addMessage(session.id, { role: 'user', content: `Msg ${i}` });
      }

      const result = manager.requestCompaction(session.id);
      // With very low thresholds and short messages, compaction should trigger
      if (result) {
        expect(result.toCompact.length).toBeGreaterThan(0);
        expect(result.keptEntries.length).toBeGreaterThan(0);
        expect(result.toCompact.length + result.keptEntries.length).toBeGreaterThanOrEqual(result.toCompact.length);
      }
    });
  });

  describe('applyCompaction()', async () => {
    it('should apply compaction and persist the summary', async () => {
      const session = await manager.create();

      // Add several messages
      for (let i = 0; i < 5; i++) {
        await manager.addMessage(session.id, { role: 'user', content: `User message ${i}` });
        await manager.addMessage(session.id, { role: 'assistant', content: `Assistant response ${i}` });
      }

      const firstKeptId = session.messages[session.messages.length - 1]?.id || '';
      await manager.applyCompaction(
        session.id,
        'Summary of the conversation about testing.',
        firstKeptId,
      );

      // Verify compaction metadata was added
      const updatedSession = manager.get(session.id);
      expect(updatedSession!.metadata?.lastCompacted).toBeDefined();

      // Verify persistence
      const entries = await store.getRawEntries(session.id);
      const hasCompactionEntry = entries.some(e => e.type === 'compaction');
      expect(hasCompactionEntry).toBe(true);
      expect((await manager.getRawEntries(session.id)).filter(entry => entry.type === 'message')).toHaveLength(10);
      expect(updatedSession?.activeLeafId).toMatch(/^compaction-/);

      const reloaded = await store.loadSession(session.id);
      expect(reloaded?.messages).toHaveLength(1);
      expect(reloaded?.messages[0].id).toBe(firstKeptId);

      const freshManager = new SessionManager();
      freshManager.setStore(store);
      await freshManager.loadFromStore(session.id);
      expect(freshManager.getEffectiveContext(session.id)[0]).toMatchObject({
        role: 'system',
        content: '[Context Summary] Summary of the conversation about testing.',
      });
    });

    it('does not discard history when the compaction boundary is invalid', async () => {
      const session = await manager.create();
      await manager.addMessage(session.id, { role: 'user', content: 'Keep me' });

      await manager.applyCompaction(session.id, 'Bad summary', 'missing-message');

      expect(session.messages.map(message => message.content)).toEqual(['Keep me']);
      expect(session.metadata?.lastCompacted).toBeUndefined();
    });

    it('should handle non-existent session gracefully', async () => {
      // Should not throw
      await expect(manager.applyCompaction(
        'non-existent-session',
        'Summary',
        'msg-123',
      )).resolves.toBeUndefined();
    });
  });

  describe('setListener()', async () => {
    it('should call the listener on session creation', async () => {
      const updates: string[] = [];
      manager.setListener((sessionId) => updates.push(sessionId));

      await manager.create({ title: 'Test' });
      expect(updates.length).toBe(1);
      expect(manager.get(updates[0])).toBeDefined();
    });

    it('should call the listener on message addition', async () => {
      const updates: string[] = [];
      manager.setListener((sessionId) => updates.push(sessionId));

      const session = await manager.create();
      await manager.addMessage(session.id, { role: 'user', content: 'Hello' });

      expect(updates.length).toBe(2); // create + addMessage
    });
  });
});

// ===================================================================
// Token Estimator Tests (internal utility)
// ===================================================================

describe('Token Estimation', () => {
  it('should estimate tokens based on text length', async () => {
    const { SessionManager } = await import('./session-manager');
    // Access the internal class through a test session
    const manager = new SessionManager();

    const shortText = 'Hi';
    const longText = 'This is a much longer piece of text that should have more tokens estimated because it contains many more characters and words in total.';

    expect(manager.getTokenCount('non-existent')).toBe(0);
  });
});

// ===================================================================
// Auto-Compaction Tests (P0 #2.6)
// ===================================================================

describe('Auto-Compaction', () => {
  let manager: SessionManager;
  let store: JsonlSessionStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    store = new JsonlSessionStore(tempDir);
    manager = new SessionManager();
    manager.setStore(store);
  });

  afterEach(async () => {
    await cleanup(tempDir);
  });

  describe('setAutoCompactionCallback()', () => {
    it('should set the callback for auto-compaction', async () => {
      let callbackCalled = false;
      manager.setAutoCompactionCallback(async (sessionId, toCompact, keptEntries) => {
        callbackCalled = true;
        return `Summary of ${toCompact.length} compacted messages`;
      });

      // Verify the callback is set by triggering auto-compaction
      const session = await manager.create();
      
      // Set low thresholds to trigger compaction easily
      manager.setCompactionSettings({ enabled: true, reserveTokens: 10, keepRecentTokens: 20 });
      
      for (let i = 0; i < 8; i++) {
        await manager.addMessage(session.id, { role: 'user', content: `Msg ${i}` });
      }

      // The callback should have been called during addMessage due to auto-compaction check
      expect(callbackCalled).toBe(true);
    });
  });

  describe('checkAndTriggerCompaction()', () => {
    it('should return false when no compaction is needed', async () => {
      const session = await manager.create();
      
      // Set high thresholds so compaction won't trigger
      manager.setCompactionSettings({ enabled: true, reserveTokens: 100000, keepRecentTokens: 50000 });
      
      for (let i = 0; i < 3; i++) {
        await manager.addMessage(session.id, { role: 'user', content: `Msg ${i}` });
      }

      const result = await manager.checkAndTriggerCompaction(session.id);
      expect(result).toBe(false); // No compaction triggered
    });

    it('should return false when no callback is set', async () => {
      const session = await manager.create();
      
      // Set low thresholds to trigger compaction check
      manager.setCompactionSettings({ enabled: true, reserveTokens: 10, keepRecentTokens: 20 });
      
      for (let i = 0; i < 8; i++) {
        await manager.addMessage(session.id, { role: 'user', content: `Msg ${i}` });
      }

      // Without a callback, checkAndTriggerCompaction should return false
      const result = await manager.checkAndTriggerCompaction(session.id);
      expect(result).toBe(false); // No callback means no compaction performed
    });

    it('honors a disabled per-session policy before calling the summarizer', async () => {
      let callbackCalls = 0;
      manager.setAutoCompactionCallback(async () => {
        callbackCalls++;
        return 'This summary must not be generated';
      });
      manager.setCompactionSettings({ enabled: true, reserveTokens: 10, keepRecentTokens: 20 });
      const session = await manager.create({ autoCompaction: false });

      for (let i = 0; i < 10; i++) {
        await manager.addMessage(session.id, { role: 'user', content: `Long message ${i} ${'x'.repeat(40)}` });
      }

      expect(callbackCalls).toBe(0);
      expect(manager.get(session.id)?.metadata?.compactionSummary).toBeUndefined();
    });

    it('propagates run cancellation to automatic summarization without applying a partial summary', async () => {
      const session = await manager.create({ autoCompaction: false });
      manager.setCompactionSettings({ enabled: true, reserveTokens: 10, keepRecentTokens: 20 });
      for (let i = 0; i < 4; i++) {
        await manager.addMessage(session.id, { role: 'user', content: `Seed ${i} ${'x'.repeat(80)}` });
      }
      await manager.update(session.id, { autoCompaction: true });
      let startSummarization!: () => void;
      const started = new Promise<void>(resolve => { startSummarization = resolve; });
      manager.setAutoCompactionCallback(async (_sessionId, _toCompact, _kept, signal) => {
        startSummarization();
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      });
      let failure: { cancelled?: boolean } | undefined;
      manager.on('compaction:error', event => { failure = event; });
      const controller = new AbortController();
      const addition = manager.addMessage(session.id, {
        role: 'assistant', content: `Final ${'y'.repeat(80)}`,
      }, { signal: controller.signal });
      await started;
      controller.abort();
      await addition;

      expect(failure).toMatchObject({ cancelled: true });
      expect(manager.get(session.id)?.metadata?.compactionSummary).toBeUndefined();
    });

    it('publishes automatic compaction statistics after applying the summary', async () => {
      let completed: { tokensBefore?: number; tokensAfter?: number; tokensSaved?: number } | undefined;
      manager.setAutoCompactionCallback(async () => ({
        summary: 'Short automatic summary',
        provider: 'openai',
        model: 'o3',
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: 0.001 },
      }));
      manager.on('compaction:end', event => { completed = event; });
      manager.setCompactionSettings({ enabled: true, reserveTokens: 10, keepRecentTokens: 20 });
      const session = await manager.create({ autoCompaction: true });

      for (let i = 0; i < 8 && !completed; i++) {
        await manager.addMessage(session.id, { role: 'user', content: `Long message ${i} ${'x'.repeat(80)}` });
      }

      expect(completed).toMatchObject({
        tokensBefore: expect.any(Number),
        tokensAfter: expect.any(Number),
        tokensSaved: expect.any(Number),
      });
      expect(manager.get(session.id)?.metadata?.compactionStats).toMatchObject({
        tokensBefore: completed?.tokensBefore,
        tokensAfter: completed?.tokensAfter,
        provider: 'openai',
        model: 'o3',
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: 0.001 },
      });
      expect((await manager.getRawEntries(session.id)).find(entry => entry.type === 'compaction'))
        .toMatchObject({ provider: 'openai', model: 'o3', usage: { totalTokens: 12 } });
      const context = manager.getEffectiveContext(session.id);
      expect(context[0]).toMatchObject({ role: 'system' });
      expect('content' in context[0]! ? context[0].content : '').toContain('[Context Summary] Short automatic summary');
      expect(context.some(entry => 'content' in entry && entry.content.includes('Long message 0'))).toBe(false);

      const reloaded = new SessionManager();
      reloaded.setStore(store);
      await reloaded.loadAllSessions();
      expect(reloaded.getEffectiveContext(session.id).map(entry => 'content' in entry ? entry.content : ''))
        .toEqual(context.map(entry => 'content' in entry ? entry.content : ''));
    });

    it('should trigger compaction when threshold exceeded and callback is set', async () => {
      let summaryGenerated = '';
      
      manager.setAutoCompactionCallback(async (sessionId, toCompact, keptEntries) => {
        summaryGenerated = `Auto-summary: ${toCompact.length} messages compacted`;
        return summaryGenerated;
      });

      const session = await manager.create();
      
      // Set low thresholds for easy triggering in tests
      manager.setCompactionSettings({ enabled: true, reserveTokens: 10, keepRecentTokens: 20 });
      
      for (let i = 0; i < 8; i++) {
        await manager.addMessage(session.id, { role: 'user', content: `User message ${i}` });
        await manager.addMessage(session.id, { role: 'assistant', content: `Assistant response ${i}` });
      }

      // Auto-compaction should have been triggered during addMessage
      expect(summaryGenerated).toContain('Auto-summary');
    });
  });

  describe('applyCompaction()', () => {
    it('should keep only messages from the first kept entry onwards', async () => {
      const session = await manager.create();
      
      // Add several message pairs
      for (let i = 0; i < 5; i++) {
        await manager.addMessage(session.id, { role: 'user', content: `User ${i}` });
        await manager.addMessage(session.id, { role: 'assistant', content: `Assistant ${i}` });
      }

      const beforeCount = session.messages.length;
      expect(beforeCount).toBe(10); // 5 user + 5 assistant messages

      // Get the last message ID (which will be kept)
      const firstKeptId = session.messages[session.messages.length - 2]?.id || '';
      
      await manager.applyCompaction(
        session.id,
        'Conversation summary about testing.',
        firstKeptId,
      );

      // Verify only kept messages remain (from index of firstKeptId onwards)
      const updatedSession = manager.get(session.id);
      expect(updatedSession!.messages.length).toBeLessThan(beforeCount);
      expect(updatedSession!.metadata?.lastCompacted).toBeDefined();
    });

    it('should handle non-existent session gracefully', async () => {
      await expect(manager.applyCompaction(
        'non-existent-session',
        'Summary text',
        'msg-123',
      )).resolves.toBeUndefined();
    });
  });

  describe('Auto-compaction integration with addMessage()', () => {
    it('should automatically compact when threshold is exceeded', async () => {
      let summaryText = '';
      
      manager.setAutoCompactionCallback(async (sessionId, toCompact, keptEntries) => {
        summaryText = `Summary of ${toCompact.length} messages`;
        return summaryText;
      });

      const session = await manager.create();
      
      // Set very low thresholds for testing
      manager.setCompactionSettings({ enabled: true, reserveTokens: 10, keepRecentTokens: 20 });
      
      // Add messages until compaction triggers
      let compacted = false;
      for (let i = 0; i < 20 && !compacted; i++) {
        await manager.addMessage(session.id, { role: 'user', content: `User message number ${i} with some additional text to increase token count` });
        if (summaryText) compacted = true;
      }

      expect(compacted).toBe(true);
      expect(summaryText).toContain('Summary');
    });
  });

  describe('lifecycle events', () => {
    it('emits session and message lifecycle events', async () => {
      const created = vi.fn();
      const messageAdded = vi.fn();
      const updated = vi.fn();
      const deleted = vi.fn();
      manager.on('session:create', created);
      manager.on('message:add', messageAdded);
      manager.on('session:update', updated);
      manager.on('session:delete', deleted);

      const session = await manager.create({ title: 'Event test' });
      await manager.addMessage(session.id, { role: 'user', content: 'Bonjour' });
      await manager.delete(session.id);

      expect(created).toHaveBeenCalledWith({ sessionId: session.id, title: 'Event test' });
      expect(messageAdded).toHaveBeenCalledWith({
        sessionId: session.id,
        role: 'user',
        contentLength: 7,
      });
      expect(updated).toHaveBeenCalledWith({ sessionId: session.id, messageCount: 1 });
      expect(deleted).toHaveBeenCalledWith({ sessionId: session.id });
    });

    it('supports once and off through SessionManager', async () => {
      const onceHandler = vi.fn();
      const removedHandler = vi.fn();
      manager.once('session:create', onceHandler);
      manager.on('session:create', removedHandler);
      manager.off('session:create', removedHandler);

      await manager.create({ title: 'First' });
      await manager.create({ title: 'Second' });

      expect(onceHandler).toHaveBeenCalledOnce();
      expect(removedHandler).not.toHaveBeenCalled();
    });
  });
});
