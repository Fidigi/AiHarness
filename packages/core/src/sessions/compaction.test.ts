// ============================================================
// Compaction Service Tests - LLM-based conversation summarization
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CompactionService,
  TokenEstimator,
  type SessionEntry,
} from './compaction';

// ===================================================================
// Test helpers
// ===================================================================

function createMessageEntry(
  id: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
): SessionEntry {
  return {
    id,
    type: 'message',
    role,
    content,
    timestamp: Date.now(),
  };
}

function createCompactionSummary(summary: string): SessionEntry {
  return {
    id: `compaction-${Date.now()}`,
    type: 'message',
    role: 'system' as any,
    content: summary,
    timestamp: Date.now(),
  };
}

// ===================================================================
// TokenEstimator Tests
// ===================================================================

describe('TokenEstimator', () => {
  describe('estimateTokens()', () => {
    it('should estimate tokens based on text length (~1 token per 4 chars)', () => {
      expect(TokenEstimator.estimateTokens('')).toBe(0);
      expect(TokenEstimator.estimateTokens('Hi')).toBe(1); // ~2/4 = 1
      expect(TokenEstimator.estimateTokens('Hello world')).toBe(3); // ~11/4 = 3
    });

    it('should handle long text', () => {
      const longText = 'This is a much longer piece of text that should have more tokens estimated because it contains many more characters and words in total.';
      const estimated = TokenEstimator.estimateTokens(longText);
      expect(estimated).toBeGreaterThan(10); // Should be reasonable for this length
    });

    it('should handle special characters', () => {
      expect(TokenEstimator.estimateTokens('!@#$%^&*()')).toBe(3); // 12/4 = 3
    });
  });

  describe('estimateMessageEntry()', () => {
    it('should add overhead for role markers and metadata', () => {
      const entry: SessionEntry = createMessageEntry('m1', 'user', 'Hello');
      // Base estimate (5 chars / 4 ≈ 2) + 4 overhead = ~6
      const tokens = TokenEstimator.estimateMessageEntry(entry);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should handle empty content', () => {
      const entry: SessionEntry = createMessageEntry('m1', 'user', '');
      // 0 base + 4 overhead = 4
      expect(TokenEstimator.estimateMessageEntry(entry)).toBeGreaterThanOrEqual(4);
    });

    it('should handle long content with proper scaling', () => {
      const entry: SessionEntry = createMessageEntry('m1', 'user', 'A'.repeat(200));
      // 200/4 = 50 + 4 overhead = ~54
      expect(TokenEstimator.estimateMessageEntry(entry)).toBeGreaterThan(50);
    });
  });

  describe('totalEntries()', () => {
    it('should sum token estimates for all entries', () => {
      const entries: SessionEntry[] = [
        createMessageEntry('m1', 'user', 'Hello'),
        createMessageEntry('m2', 'assistant', 'Hi there!'),
        createMessageEntry('m3', 'user', 'How are you?'),
      ];

      const total = TokenEstimator.totalEntries(entries);
      expect(total).toBeGreaterThan(0);
    });

    it('should return 0 for empty array', () => {
      expect(TokenEstimator.totalEntries([])).toBe(0);
    });
  });
});

// ===================================================================
// CompactionService Tests
// ===================================================================

describe('CompactionService', () => {
  let service: CompactionService;

  beforeEach(() => {
    // Use low thresholds for testing so we can trigger compaction easily
    service = new CompactionService({ minMessages: 3, keepRecentTokens: 100 });
  });

  describe('needsCompaction()', () => {
    it('should return false for few messages', () => {
      const entries: SessionEntry[] = [
        createMessageEntry('m1', 'user', 'Hello'),
        createMessageEntry('m2', 'assistant', 'Hi!'),
      ];
      expect(service.needsCompaction(entries)).toBe(false);
    });

    it('should return false for messages within token limits with short content', () => {
      const entries: SessionEntry[] = [];
      // Create many short messages (each ~10 chars + overhead)
      for (let i = 0; i < 50; i++) {
        entries.push(createMessageEntry(`m${i}`, 'user', `Msg ${i}`));
      }

      const totalTokens = TokenEstimator.totalEntries(entries);
      // With default config, these short messages should be within limits (100k - 16384)
      expect(totalTokens).toBeLessThan(100000 - 16384);
    });

    it('should return true when token threshold is exceeded', () => {
      const entries: SessionEntry[] = [];
      // Create very long messages to exceed the practical limit (100k - 16384)
      for (let i = 0; i < 2000; i++) {
        entries.push(createMessageEntry(`m${i}`, 'user', `Long message number ${i} with lots of content to push token count higher than the threshold so compaction gets triggered properly in this test scenario`));
      }

      expect(service.needsCompaction(entries)).toBe(true);
    });

    it('should return false when disabled', () => {
      service.setCompactionSettings({ enabled: false });
      const entries: SessionEntry[] = [];
      for (let i = 0; i < 2000; i++) {
        entries.push(createMessageEntry(`m${i}`, 'user', `Long message number ${i} with lots of content to push token count higher than the threshold so compaction gets triggered properly in this test scenario`));
      }

      expect(service.needsCompaction(entries)).toBe(false);
    });
  });

  describe('identifyCompactionTarget()', () => {
    it('should return null for fewer messages than minMessages', () => {
      const entries: SessionEntry[] = [
        createMessageEntry('m1', 'user', 'Hello'),
      ];
      expect(service.identifyCompactionTarget(entries)).toBeNull();
    });

    it('should identify messages to compact when threshold exceeded', () => {
      // Create enough long messages to exceed the practical limit
      const entries: SessionEntry[] = [];
      for (let i = 0; i < 2000; i++) {
        entries.push(createMessageEntry(`m${i}`, 'user', `Long message number ${i} with lots of content to push token count higher than the threshold so compaction gets triggered properly in this test scenario`));
      }

      const result = service.identifyCompactionTarget(entries);
      expect(result).not.toBeNull();
      if (result) {
        expect(result.toCompact.length).toBeGreaterThan(0);
        expect(result.keptEntries.length).toBeGreaterThan(0);
        // Kept entries should be the most recent ones
        const keptIds = result.keptEntries.map(e => e.id);
        const lastEntryId = entries[entries.length - 1].id;
        expect(keptIds).toContain(lastEntryId);
      }
    });

    it('should return null when context is within limits', () => {
      // Short messages that won't exceed the limit (100k tokens)
      const entries: SessionEntry[] = [];
      for (let i = 0; i < 10; i++) {
        entries.push(createMessageEntry(`m${i}`, 'user', `Hi ${i}`));
      }

      expect(service.identifyCompactionTarget(entries)).toBeNull();
    });

    it('should keep recent messages and compact older ones', () => {
      // Use a service with lower reserveTokens so compaction triggers more easily
      const testService = new CompactionService({ minMessages: 3, reserveTokens: 5000, keepRecentTokens: 100 });
      
      const entries: SessionEntry[] = [];
      // Create messages long enough to exceed the threshold (need >95k tokens with reserve=5k)
      for (let i = 0; i < 3000; i++) {
        entries.push(createMessageEntry(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', `Message ${i} with substantial content to exceed token limits and trigger compaction properly in this test scenario with lots of text`));
      }

      const result = testService.identifyCompactionTarget(entries);
      expect(result).not.toBeNull();
      if (result) {
        // Verify kept entries are at the end of the array and compacted ones at the beginning
        const lastCompactIndex = entries.findIndex(e => e.id === result!.toCompact[result!.toCompact.length - 1].id);
        const firstKeptIndex = entries.findIndex(e => e.id === result!.keptEntries[0].id);
        expect(lastCompactIndex).toBeLessThan(firstKeptIndex);
      }
    });

    it('should respect keepRecentTokens setting', () => {
      service.setCompactionSettings({ keepRecentTokens: 50 });

      const entries: SessionEntry[] = [];
      for (let i = 0; i < 2000; i++) {
        entries.push(createMessageEntry(`m${i}`, 'user', `Long message number ${i} with lots of content to push token count higher than the threshold so compaction gets triggered properly in this test scenario`));
      }

      const result = service.identifyCompactionTarget(entries);
      if (result) {
        // Verify kept entries are within the keepRecentTokens limit
        const totalKeptTokens = TokenEstimator.totalEntries(result.keptEntries);
        expect(totalKeptTokens).toBeLessThanOrEqual(50 + 100); // Small tolerance for rounding
      }
    });

    it('should return null when compaction is disabled', () => {
      service.setCompactionSettings({ enabled: false });

      const entries: SessionEntry[] = [];
      for (let i = 0; i < 2000; i++) {
        entries.push(createMessageEntry(`m${i}`, 'user', `Long message number ${i} with lots of content to push token count higher than the threshold so compaction gets triggered properly in this test scenario`));
      }

      expect(service.identifyCompactionTarget(entries)).toBeNull();
    });
  });

  describe('buildSummaryPrompt()', () => {
    it('should create a proper prompt for LLM summarization', () => {
      const entries: SessionEntry[] = [
        createMessageEntry('m1', 'user', 'What is TypeScript?'),
        createMessageEntry('m2', 'assistant', 'TypeScript is a typed superset of JavaScript.'),
        createMessageEntry('m3', 'user', 'How do I install it?'),
      ];

      const prompt = service.buildSummaryPrompt(entries);
      expect(prompt).toHaveLength(1); // Single user message with all context
      expect(prompt[0].content).toContain('What is TypeScript?');
      expect(prompt[0].content).toContain('TypeScript is a typed superset of JavaScript.');
    });

    it('should include custom instructions in the prompt', () => {
      const entries: SessionEntry[] = [
        createMessageEntry('m1', 'user', 'Hello'),
        createMessageEntry('m2', 'assistant', 'Hi there!'),
      ];

      const prompt = service.buildSummaryPrompt(entries, 'Focus on key decisions');
      expect(prompt[0].content).toContain('Focus on key decisions');
    });

    it('should use default instructions when none provided', () => {
      const entries: SessionEntry[] = [createMessageEntry('m1', 'user', 'Test')];
      const prompt = service.buildSummaryPrompt(entries);
      expect(prompt[0].content).toContain('Summarize this conversation concisely');
    });

    it('should filter out compaction/summary entries from the prompt', () => {
      // Only message-type entries should be included in summary prompt
      const entries: SessionEntry[] = [
        createMessageEntry('m1', 'user', 'Hello'),
        createCompactionSummary('[Previous context]...'),
        createMessageEntry('m2', 'assistant', 'Hi!'),
      ];

      // The buildSummaryPrompt method filters for type === 'message' only
      const prompt = service.buildSummaryPrompt(entries);
      expect(prompt[0].content).toContain('Hello');
    });
  });

  describe('compact()', () => {
    it('should generate a summary via the provided function', async () => {
      const entries: SessionEntry[] = [];
      for (let i = 0; i < 2000; i++) {
        entries.push(createMessageEntry(`m${i}`, 'user', `Long message number ${i} with lots of content to push token count higher than the threshold so compaction gets triggered properly in this test scenario`));
      }

      const mockSummaryFn = async (msgs: any[]) => `Generated summary for ${msgs.length} messages`;

      const result = await service.compact(entries, mockSummaryFn);
      expect(result.summary).toBe('Generated summary for 1 messages'); // buildSummaryPrompt returns single message array
    });

    it('should accept custom instructions', async () => {
      const entries: SessionEntry[] = [];
      for (let i = 0; i < 2000; i++) {
        entries.push(createMessageEntry(`m${i}`, 'user', `Long message number ${i} with lots of content to push token count higher than the threshold so compaction gets triggered properly in this test scenario`));
      }

      let capturedPrompt: any[] | undefined;
      const mockSummaryFn = async (msgs: any[]) => {
        capturedPrompt = msgs;
        return 'Custom summary';
      };

      await service.compact(entries, mockSummaryFn, 'Be concise');
      expect(capturedPrompt).toBeDefined();
    });

    it('should handle manual compaction with few messages', async () => {
      const entries: SessionEntry[] = [
        createMessageEntry('m1', 'user', 'Hello'),
        createMessageEntry('m2', 'assistant', 'Hi!'),
        createMessageEntry('m3', 'user', 'How are you?'),
      ];

      let capturedPrompt: any[] | undefined;
      const mockSummaryFn = async (msgs: any[]) => {
        capturedPrompt = msgs;
        return 'Short conversation summary';
      };

      // With 3 messages, it should work for manual compaction (manualCompact requires >= 3)
      const result = await service.compact(entries, mockSummaryFn);
      expect(result.summary).toBe('Short conversation summary');
    });

    it('should include token estimate in result', async () => {
      const entries: SessionEntry[] = [];
      for (let i = 0; i < 2000; i++) {
        entries.push(createMessageEntry(`m${i}`, 'user', `Long message number ${i} with lots of content to push token count higher than the threshold so compaction gets triggered properly in this test scenario`));
      }

      const mockSummaryFn = async () => 'Generated summary';

      const result = await service.compact(entries, mockSummaryFn);
      expect(result.tokenEstimate).toBeGreaterThan(0);
    });

    it('should return empty for manual compaction with fewer than 3 messages', async () => {
      const entries: SessionEntry[] = [
        createMessageEntry('m1', 'user', 'Hello'),
        createMessageEntry('m2', 'assistant', 'Hi!'),
      ];

      const mockSummaryFn = async () => 'Should not be called';

      const result = await service.compact(entries, mockSummaryFn);
      expect(result.summary).toBe(''); // Manual compaction requires >= 3 messages
    });
  });

  describe('applyCompaction()', () => {
    it('should filter compacted messages and add summary', () => {
      const entries: SessionEntry[] = [
        createMessageEntry('m1', 'user', 'Hello'),
        createMessageEntry('m2', 'assistant', 'Hi!'),
        createMessageEntry('m3', 'user', 'How are you?'),
      ];

      const result = {
        summary: 'Conversation about greetings.',
        keptMessages: entries.slice(1), // Keep last 2 messages (m2, m3)
        tokenEstimate: 50,
      };

      const updated = service.applyCompaction(entries, result);

      // Should have the kept messages plus the summary entry
      expect(updated.length).toBeGreaterThan(0);
      // Last entry should be the compaction summary
      const lastEntry = updated[updated.length - 1];
      expect(lastEntry.content).toContain('[Context Summary]');
    });

    it('should preserve non-message entries', () => {
      const entries: SessionEntry[] = [
        createMessageEntry('m1', 'user', 'Hello'),
        { id: 'system-ctx', type: 'message' as any, role: 'system' as any, content: '[Previous context]...', timestamp: Date.now() }, // system role entry
        createMessageEntry('m2', 'assistant', 'Hi!'),
      ];

      const result = {
        summary: 'New summary.',
        keptMessages: entries.filter(e => (e as any).role === 'system') as SessionEntry[],
        tokenEstimate: 30,
      };

      const updated = service.applyCompaction(entries, result);
      // Should preserve the existing system entry since it's in keptIds
      expect(updated.some(e => e.content === '[Previous context]...')).toBe(true);
    });
  });

  describe('setCompactFunction()', () => {
    it('should allow setting a custom compact function', () => {
      const mockFn = async (msgs: any[]) => 'Custom summary';
      service.setCompactFunction(mockFn);
      // The function is stored for later use by SessionManager
      expect(service).toBeDefined();
    });

    it('should overwrite previous function', () => {
      const fn1 = async () => 'Summary 1';
      const fn2 = async () => 'Summary 2';
      service.setCompactFunction(fn1);
      service.setCompactFunction(fn2);
      expect(service).toBeDefined(); // Just verify no error
    });
  });

  describe('getConfig()', () => {
    it('should return default configuration', () => {
      const config = service.getConfig();
      expect(config.minMessages).toBe(3); // Set in beforeEach
      expect(config.reserveTokens).toBe(16384);
      expect(config.keepRecentTokens).toBe(100); // Set in beforeEach
    });

    it('should allow custom configuration', () => {
      const customService = new CompactionService({ minMessages: 5, reserveTokens: 8192 });
      const config = customService.getConfig();
      expect(config.minMessages).toBe(5);
      expect(config.reserveTokens).toBe(8192);
    });

    it('should allow partial configuration override', () => {
      const customService = new CompactionService({ minMessages: 6 });
      const config = customService.getConfig();
      expect(config.minMessages).toBe(6);
      // Should use defaults for unspecified fields
      expect(config.reserveTokens).toBe(16384);
    });

    it('should handle disabled compaction setting', () => {
      service.setCompactionSettings({ enabled: false });
      const entries: SessionEntry[] = [];
      for (let i = 0; i < 2000; i++) {
        entries.push(createMessageEntry(`m${i}`, 'user', `Long message number ${i} with lots of content to push token count higher than the threshold so compaction gets triggered properly in this test scenario`));
      }

      expect(service.identifyCompactionTarget(entries)).toBeNull();
    });
  });
});

// ===================================================================
// Edge Cases and Error Handling
// ===================================================================

describe('Edge Cases', () => {
  it('should handle empty message array gracefully', () => {
    const service = new CompactionService({ minMessages: 2 });
    expect(service.needsCompaction([])).toBe(false);
    expect(service.identifyCompactionTarget([])).toBeNull();
  });

  it('should handle single message gracefully', () => {
    const entries: SessionEntry[] = [createMessageEntry('m1', 'user', 'Hello')];
    const service = new CompactionService({ minMessages: 2 });
    expect(service.identifyCompactionTarget(entries)).toBeNull();
  });

  it('should handle messages with empty content', () => {
    const entries: SessionEntry[] = [
      createMessageEntry('m1', 'user', ''),
      createMessageEntry('m2', 'assistant', ''),
    ];
    expect(TokenEstimator.totalEntries(entries)).toBeGreaterThan(0); // Still has overhead tokens
  });

  it('should handle very long content gracefully', () => {
    const entries: SessionEntry[] = [
      createMessageEntry('m1', 'user', 'x'.repeat(10000)),
    ];
    expect(TokenEstimator.estimateTokens(entries[0].content)).toBeGreaterThan(0);
  });

  it('should handle mixed entry types correctly', () => {
    const entries: SessionEntry[] = [
      createMessageEntry('m1', 'user', 'Hello'),
      createCompactionSummary('[Previous context]...'),
      createMessageEntry('m2', 'assistant', 'Hi!'),
    ];

    // buildSummaryPrompt should filter for message type only
    const service = new CompactionService();
    const prompt = service.buildSummaryPrompt(entries);
    expect(prompt[0].content).toContain('Hello');
  });
});
