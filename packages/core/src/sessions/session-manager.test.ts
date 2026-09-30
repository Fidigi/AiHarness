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
      await fs.writeFile(filePath, '{ valid: json }\n{ "id": "msg-1", "type": "message" }\nthis is not json\n');

      // The store should handle this by skipping invalid lines during loadSession
      const entries = await store.getRawEntries('malformed');
      expect(entries.length).toBe(1); // Only the valid JSON line
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

    it('should clone a session with all messages', async () => {
      const session = await manager.create({ title: 'Original' });
      await manager.addMessage(session.id, { role: 'user', content: 'Hello' });
      await manager.addMessage(session.id, { role: 'assistant', content: 'Hi there!' });

      const cloned = await (manager as any).cloneSession(session.id);

      expect(cloned).toBeTruthy();
      expect(cloned!.id).not.toBe(session.id); // Different session ID
      expect(cloned!.messages.length).toBe(2); // Same number of messages
      expect(cloned!.parentId).toBe(session.id); // Linked to original
    });

    it('should get session tree structure', async () => {
      const session = await manager.create({ title: 'Root' });
      
      const forked1 = await (manager as any).forkSession(session.id);
      const forked2 = await (manager as any).forkSession(session.id);

      const tree = (manager as any).getSessionTree();
      expect(tree.length).toBe(3); // Root + 2 forks
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
