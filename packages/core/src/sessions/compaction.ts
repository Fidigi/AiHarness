// ============================================================
// Compaction Service - LLM-based conversation summarization
// Generates summaries of old messages to reduce context size
// ============================================================

import { Message } from '../types/index.js';
import type { MessageEntry, SessionEntry } from './session-manager.js';
export type { SessionEntry } from './session-manager.js';

/** Configuration for compaction */
export interface CompactionConfig {
  /** Minimum number of messages before triggering auto-compaction */
  minMessages?: number;
  /** Maximum tokens reserved for the response */
  reserveTokens?: number;
  /** Number of recent tokens to keep without summarization */
  keepRecentTokens?: number;
  /** Whether compaction is enabled (for testing) */
  enabled?: boolean;
}

const DEFAULT_CONFIG: Required<CompactionConfig> = {
  minMessages: 4,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
  enabled: true,
};

/** Result of a compaction operation */
export interface CompactionResult {
  /** The generated summary replacing the compacted messages */
  summary: string;
  /** Messages that were kept (not summarized) */
  keptMessages: SessionEntry[];
  /** Token estimate of the resulting context */
  tokenEstimate?: number;
}

/** Token estimation helper */
export class TokenEstimator {
  /** Rough token count for English text (~1 token per 4 chars) */
  static estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /** Estimate tokens for a message entry including role overhead */
  static estimateMessageEntry(entry: SessionEntry): number {
    const text = 'content' in entry ? entry.content : 'summary' in entry ? entry.summary : '';
    const base = this.estimateTokens(text || '');
    // Add overhead for role markers, metadata (~4 tokens per message)
    return base + 4;
  }

  /** Total token count for a list of entries */
  static totalEntries(entries: SessionEntry[]): number {
    return entries.reduce((sum, e) => sum + this.estimateMessageEntry(e), 0);
  }

  /** Estimate tokens for a message object */
  static estimateMessage(msg: Message): number {
    const base = this.estimateTokens(msg.content || '');
    // Role prefix overhead (~6 tokens per message in API format)
    return base + 6;
  }
}

/**
 * CompactionService handles LLM-based summarization of conversation history.
 * It identifies which messages can be summarized and generates a concise summary.
 */
export class CompactionService {
  private config: Required<CompactionConfig>;
  private compactFn?: (messages: Message[], instructions?: string) => Promise<string>;

  constructor(config?: Partial<CompactionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Set the function used to generate summaries via LLM */
  setCompactFunction(fn: (messages: Message[], instructions?: string) => Promise<string>): void {
    this.compactFn = fn;
  }

  /** Update compaction settings */
  setCompactionSettings(settings: Partial<CompactionConfig>): void {
    if ('enabled' in settings && !settings.enabled!) {
      // Special handling for disabling - use a very high threshold instead
      this.config = { ...this.config, enabled: false };
    } else {
      this.config = { ...this.config, ...settings };
    }
  }

  /** Check if compaction is needed for a session's messages */
  needsCompaction(messages: SessionEntry[]): boolean {
    if (!this.config.enabled) return false;
    const totalTokens = TokenEstimator.totalEntries(messages);
    // Use a practical threshold (100k tokens max context - reserve)
    const maxContextTokens = 100000 - this.config.reserveTokens;
    return totalTokens > maxContextTokens && messages.length >= this.config.minMessages;
  }

  /** Determine which messages should be compacted and which to keep */
  identifyCompactionTarget(messages: SessionEntry[]): { toCompact: SessionEntry[]; keptEntries: SessionEntry[] } | null {
    if (!this.config.enabled) return null;
    if (messages.length < this.config.minMessages) return null;

    const totalTokens = TokenEstimator.totalEntries(messages);
    // Use a practical threshold instead of MAX_SAFE_INTEGER for real calculations
    const maxContextTokens = 100000 - this.config.reserveTokens;

    if (totalTokens <= maxContextTokens) {
      return null; // Context is within limits
    }

    // Find the cut point: walk backwards keeping recent tokens
    let accumulatedTokens = 0;
    let cutIndex = messages.length - 1;

    for (let i = messages.length - 1; i >= 0; i--) {
      const entryTokens = TokenEstimator.estimateMessageEntry(messages[i]);
      if (accumulatedTokens + entryTokens > this.config.keepRecentTokens) break;
      accumulatedTokens += entryTokens;
      cutIndex = i;
    }

    // If we'd keep everything, no compaction needed
    if (cutIndex === 0) return null;

    const toCompact = messages.slice(0, cutIndex);
    const keptEntries = messages.slice(cutIndex);

    return { toCompact, keptEntries };
  }

  /** Build the prompt for LLM summarization */
  buildSummaryPrompt(messages: SessionEntry[], instructions?: string): Message[] {
    // Convert session entries back to message format for the API
    const conversationMessages = messages
      .filter(e => e.type === 'message')
      .map(e => ({
        id: e.id,
        role: (e as any).role || 'user',
        content: e.content,
        timestamp: new Date(e.timestamp),
      }));

    const instructionsText = instructions || 'Summarize this conversation concisely. Preserve key information, decisions, and context that will be needed for future responses.';

    return [
      {
        id: '__system__',
        role: 'user',
        content: `${instructionsText}\n\nConversation to summarize:\n${conversationMessages.map(m => `[${m.role}]: ${m.content}`).join('\n---\n')}`,
        timestamp: new Date(),
      },
    ];
  }

  /** Execute compaction with LLM summarization */
  async compact(
    messages: SessionEntry[],
    summaryFn?: (promptMessages: Message[]) => Promise<string>,
    instructions?: string,
  ): Promise<CompactionResult> {
    const summarizer = summaryFn ?? this.compactFn;
    if (!summarizer) throw new Error('No compaction summarizer configured');

    const target = this.identifyCompactionTarget(messages);

    if (!target) {
      // If no compaction needed but we have enough messages, still allow manual compaction
      return this.manualCompact(messages, summarizer, instructions);
    }

    const summary = await summarizer(this.buildSummaryPrompt(target.toCompact, instructions));

    return {
      summary,
      keptMessages: target.keptEntries,
      tokenEstimate: TokenEstimator.totalEntries([
        ...target.keptEntries,
        { id: 'compaction-summary', type: 'message' as const, role: 'system' as any, content: summary, timestamp: Date.now() },
      ]),
    };
  }

  /** Manual compaction - summarize all messages (used for /compact command) */
  private async manualCompact(
    messages: SessionEntry[],
    summaryFn: (promptMessages: Message[]) => Promise<string>,
    instructions?: string,
  ): Promise<CompactionResult> {
    const toCompact = messages.filter((entry): entry is MessageEntry => entry.type === 'message');

    if (toCompact.length < 3) {
      // For manual compaction, allow fewer messages but still need some content
      return { summary: '', keptMessages: [], tokenEstimate: 0 };
    }

    const summary = await summaryFn(this.buildSummaryPrompt(toCompact, instructions));

    return {
      summary,
      keptMessages: toCompact.slice(-2), // Keep last 2 messages as context anchor
      tokenEstimate: TokenEstimator.totalEntries([
        ...toCompact.slice(-2),
        { id: 'compaction-summary', type: 'message' as const, role: 'system', content: summary, timestamp: Date.now() },
      ]),
    };
  }

  /** Apply compaction result to a message list */
  applyCompaction(messages: SessionEntry[], result: CompactionResult): SessionEntry[] {
    // Filter out compacted messages and add the summary entry
    const keptIds = new Set(result.keptMessages.map(m => m.id));

    return [
      ...messages.filter(e => e.type !== 'message' || keptIds.has(e.id)),
      {
        id: `compaction-${Date.now()}`,
        type: 'message',
        role: 'system',
        content: `[Context Summary] ${result.summary}`,
        timestamp: Date.now(),
      } as SessionEntry,
    ];
  }

  /** Get current configuration */
  getConfig(): Required<CompactionConfig> {
    return this.config;
  }
}
