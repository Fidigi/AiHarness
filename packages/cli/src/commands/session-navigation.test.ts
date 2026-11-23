import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlSessionStore, MockProvider, SessionManager } from '@ai-harness/core';
import { CommandHandler } from './handler.js';
import type { TerminalUI } from '../tui/terminal-ui.js';

afterEach(() => vi.restoreAllMocks());
async function fixture(skipPrompt = false) {
  const manager = new SessionManager();
  const session = await manager.create({ title: 'Navigation command' });
  await manager.addMessage(session.id, { role: 'user', content: 'Common' });
  const target = session.activeLeafId!;
  await manager.addMessage(session.id, { role: 'assistant', content: 'Abandoned result' });
  const source = session.activeLeafId!;
  const provider = new MockProvider({ type: 'mock', model: 'mock-model' });
  const chat = vi.spyOn(provider, 'chat').mockResolvedValue({ content: 'Alternative result', model: 'mock-model',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.01 } });
  const output: string[] = [];
  const errors: string[] = [];
  const terminal = { isCurrentlyStreaming: () => false, writeOutput: (value: string) => output.push(value),
    showError: (value: string) => errors.push(value), addTranscriptEntry: () => undefined } as unknown as TerminalUI;
  const handler = new CommandHandler(manager, new JsonlSessionStore(undefined, false), terminal, undefined, undefined,
    { cwd: '/workspace', providers: new Map([['mock', provider]]),
      agentSettings: () => ({ branchSummary: { skipPrompt, reserveTokens: 8_192 } }) });
  handler.getContext().currentSessionId = session.id;
  return { manager, session, target, source, provider, chat, output, errors, handler };
}

describe('optional command navigation', () => {
  it('lists entry identities without model work, state changes or disclosing custom state', async () => {
    const f = await fixture();
    await f.manager.appendCustomEntry(f.session.id, 'state', { privateData: 'Never displayed' });
    const leaf = f.session.activeLeafId;
    await f.handler.execute('/navigate');
    expect(f.output.join('\n')).toContain(f.target);
    expect(f.output.join('\n')).toContain(f.source);
    expect(f.output.join('\n')).not.toContain('Never displayed');
    expect(f.session.activeLeafId).toBe(leaf);
    expect(f.chat).not.toHaveBeenCalled();
  });

  it('asks for an explicit choice by default and does not silently navigate', async () => {
    const f = await fixture();
    await f.handler.execute(`/navigate ${f.target}`);
    expect(f.output.join('\n')).toContain('Repeat with --summarize or --no-summary');
    expect(f.session.activeLeafId).toBe(f.source);
    expect(f.chat).not.toHaveBeenCalled();
  });

  it.each([false, true])('navigates without model authority with explicit refusal or skipPrompt (%s)', async skip => {
    const f = await fixture(skip);
    await f.handler.execute(`/navigate ${f.target}${skip ? '' : ' --no-summary'}`);
    expect(f.session.activeLeafId).toBe(f.target);
    expect(f.session.messages.map(message => message.content)).toEqual(['Common']);
    expect(f.chat).not.toHaveBeenCalled();
    expect(f.errors).toEqual([]);
  });

  it('uses the configured tool-free provider once and persists its historical usage', async () => {
    const f = await fixture();
    await f.handler.execute(`/navigate ${f.target} --summarize --instructions "Preserve failures"`);
    expect(f.chat).toHaveBeenCalledTimes(1);
    const [messages, options] = f.chat.mock.calls[0];
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('Abandoned result');
    expect(messages[0].content).toContain('Preserve failures');
    expect(messages[0].content).not.toContain('[user] Common');
    expect(options).toMatchObject({ tools: [], maxTokens: 4_096, model: 'mock-model' });
    expect(await f.manager.getBranchSummaries(f.session.id)).toMatchObject([{ fromEntryId: f.source,
      parentEntryId: f.target, provider: 'mock', model: 'mock-model', usage: { costUsd: 0.01, inputTokens: 10 } }]);
    expect(f.output.join('\n')).toContain('Branch summary saved.');
    expect(f.errors).toEqual([]);
  });

  it.each(['--wat', '--summarize --no-summary', '--instructions focus --no-summary'])(
    'refuses malformed/conflicting flags %s before provider work', async flags => {
      const f = await fixture();
      await f.handler.execute(`/navigate ${f.target} ${flags}`);
      expect(f.session.activeLeafId).toBe(f.source);
      expect(f.chat).not.toHaveBeenCalled();
    });

  it('propagates the foreground signal and publishes nothing after cancellation', async () => {
    const f = await fixture();
    const controller = new AbortController();
    f.handler.getContext().signal = controller.signal;
    f.chat.mockImplementationOnce(async (_messages, options) => {
      expect(options?.signal).toBe(controller.signal);
      controller.abort();
      throw new Error('provider aborted');
    });
    await f.handler.execute(`/navigate ${f.target} --summarize`);
    expect(f.session.activeLeafId).toBe(f.source);
    expect(f.output.join('\n')).toContain('Navigation cancelled.');
    expect(await f.manager.getBranchSummaries(f.session.id)).toEqual([]);
  });
});
