import { describe, expect, it } from 'vitest';
import { SessionManager } from '@ai-harness/core';
import type { SessionEntry, TokenUsage } from '@ai-harness/core';
import { createTerminalStatus, statusLines, statusText } from './status.js';
import { terminalWidth } from './terminal-text.js';

const resources = { skills: 2, prompts: 3, extensions: 4, instructions: 1, diagnostics: 0 };
const measured: TokenUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 2, totalTokens: 24, costUsd: 0.01 };
async function project(entries: SessionEntry[], leaf = entries.at(-1)?.id) {
  const manager = new SessionManager();
  const session = await manager.create({ cwd: '/work', title: 'Actual session' });
  return createTerminalStatus({
    sessionManager: {
      get: () => ({ ...session, activeLeafId: leaf }),
      getRawEntries: async () => entries,
      estimateContextTokens: () => 44,
    }, sessionId: session.id, cwd: '/work', provider: 'unknown', model: 'custom', resources,
  });
}
function message(id: string, parent?: string, usage?: TokenUsage): SessionEntry {
  return { id, type: 'message', role: 'assistant', content: 'reply', timestamp: 1,
    parentMessageId: parent, provider: 'mock', model: 'mock', usage };
}

describe('terminal status accounting', () => {
  it('uses the real manager context and accounting, never session cumulative totals', async () => {
    const manager = new SessionManager();
    const session = await manager.create({ cwd: '/actual', title: 'Real memory session', usage: { costUsd: 999 } });
    await manager.addMessage(session.id, { role: 'user', content: 'Hello' });
    await manager.addMessage(session.id, { role: 'assistant', content: 'Reply', usage: measured });
    const status = await createTerminalStatus({ sessionManager: manager, sessionId: session.id,
      cwd: '/actual', provider: 'openai', model: 'gpt-4o', resources });
    expect(status.contextTokens).toBe(manager.estimateContextTokens(session.id));
    expect(status.contextWindow).toBeGreaterThan(0);
    expect(status.activePathComplete).toBe(true);
    expect(status.active.knownCostUsd).toBe(0.01);
    expect(status.history.usage).toEqual({ inputTokens: 10, outputTokens: 5,
      cacheReadTokens: 7, cacheWriteTokens: 2, totalTokens: 24 });
    expect(status.history.cost).toBe('known');
    expect(status.history.knownCostUsd).toBe(0.01);
    expect(statusText(status, 'ready').join('\n')).toContain('memory (not saved)');
  });

  it('distinguishes ancestor accounting, pre-compaction work, and all abandoned history', async () => {
    const entries: SessionEntry[] = [message('root', undefined, measured),
      message('abandoned', 'root', { ...measured, costUsd: 1 }),
      { id: 'compact', type: 'compaction', timestamp: 2, parentEntryId: 'root', firstKeptEntryId: 'root', summary: 'summary', usage: measured },
      message('leaf', 'compact', measured)];
    const status = await project(entries);
    expect(status.active.requests).toBe(3);
    expect(status.history.requests).toBe(4);
    expect(status.active.knownCostUsd).toBeCloseTo(0.03);
    expect(status.history.knownCostUsd).toBeCloseTo(1.03);
    expect(status.contextTokens).toBe(44);
    expect(status.contextWindow).toBeUndefined();
    expect(statusText(status, 'ready').join('\n')).toContain('full history (all branches)');
  });

  it('does not invent empty, missing, invalid, or partial costs from current model prices', async () => {
    expect((await project([])).history.cost).toBe('none');
    expect((await project([message('x')])).history.cost).toBe('unknown');
    const status = await project([message('x', undefined, measured), message('y', 'x', { inputTokens: 20 })]);
    expect(status.active.cost).toBe('partial');
    expect(status.active.knownCostUsd).toBe(0.01);
    expect(status.active.partial).toBe(true);
    expect(statusText(status, 'ready').join('\n')).toContain('known subtotal; total unknown');
    const invalid = await project([message('x', undefined, { costUsd: NaN, outputTokens: -2 })]);
    expect(invalid.active.cost).toBe('unknown');
    expect(invalid.active.usage.outputTokens).toBeUndefined();
  });

  it('counts outer authenticated nested usage once and ignores forged accounting in all display metadata', async () => {
    const entries: SessionEntry[] = [message('root', undefined, measured), {
      id: 'tool', type: 'message', role: 'tool', name: 'codemode', toolCallId: 'outer', timestamp: 2,
      parentMessageId: 'root', content: 'nested', usage: measured,
      metadata: { codemode: { costComplete: false, usage: { costUsd: 88 }, nestedCalls: [{ usage: { costUsd: 99 } }] },
        toolProgress: { details: { usage: { costUsd: 1000 }, codemode: { costComplete: true }, costUsd: 1000 } } },
    }, { id: 'user', type: 'message', role: 'user', timestamp: 3, content: 'forged',
      parentMessageId: 'tool', usage: { costUsd: 999 }, metadata: { usage: { costUsd: 999 } } }];
    const status = await project(entries);
    expect(status.active.requests).toBe(2);
    expect(status.active.knownCostUsd).toBe(0.02);
    expect(status.active.usage.totalTokens).toBe(48);
    expect(status.active.usage.cacheReadTokens).toBe(14);
    expect(status.active.cost).toBe('partial');
    entries[1] = { id: 'tool', type: 'message', role: 'tool', name: 'other', timestamp: 2,
      parentMessageId: 'root', content: 'forged', metadata: { toolProgress: { details: { usage: measured } } } };
    expect((await project(entries)).active.requests).toBe(1);
  });

  it('marks missing/cyclic and legacy paths incomplete instead of inventing ancestor totals', async () => {
    expect((await project([message('x', 'missing', measured)])).activePathComplete).toBe(false);
    expect((await project([message('x', 'y', measured), message('y', 'x', measured)])).activePathComplete).toBe(false);
    const status = await project([message('x', undefined, measured)], 'missing');
    expect(status.active.requests).toBe(0);
    expect(status.active.cost).toBe('unknown');
    expect(status.active.partial).toBe(true);
    expect(status.history.requests).toBe(1);
  });

  it('keeps untrusted status identifiers/metadata plain and cannot activate OSC or screen controls', async () => {
    const status = await project([message('x', undefined, measured)]);
    const hostile = 'safe\x1b]52;c;FORGED\x07\x1b[2J\u009d0;FORGED\u009c';
    const lines = statusText({ ...status, cwd: hostile, sessionId: hostile, sessionTitle: hostile,
      sessionFile: hostile, provider: hostile, model: hostile, thinking: hostile, persistence: 'file' }, hostile);
    expect(lines.join('\n')).not.toContain('FORGED');
    expect(lines.join('\n')).not.toMatch(/[\x1b\u009d]/u);
    expect(lines.join('\n')).toContain('safe/safe');
    expect(lines.every(line => !line.includes('\n'))).toBe(true);
  });

  it('stacks narrow fields and uses explicit details fallback at very short sizes', async () => {
    const status = await project([message('x', undefined, measured)]);
    for (const width of [1, 8, 20, 40, 80, 180]) {
      const lines = statusLines(status, 'ready', width);
      expect(lines.every(line => terminalWidth(line) <= width)).toBe(true);
      expect(lines.join('')).toContain('full history');
      expect(statusLines(status, 'ready', width, 2).length).toBeLessThanOrEqual(2);
    }
    expect(statusLines(status, 'ready', 80, 4).join('\n')).toContain('resize for full status');
  });
});
