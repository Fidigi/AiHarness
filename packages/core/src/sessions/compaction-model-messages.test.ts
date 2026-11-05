import { describe, expect, it } from 'vitest';
import { SessionManager } from './session-manager.js';
import type { Message } from '../types/index.js';
import { compactionMessagesFromEntries, getCompactionModelMessages } from './compaction-model-messages.js';

async function fixture() {
  const manager = new SessionManager();
  manager.setCompactionSettings({ enabled: false });
  const session = await manager.create();
  const id = session.id;
  for (let index = 0; index < 4; index++) await manager.addMessage(id,
    { role: index % 2 ? 'assistant' : 'user', content: `ordinary-${index}` }, { skipAutoCompaction: true });
  return { manager, id };
}

describe('shared model projection for compaction', () => {
  it.each([true, false])('keeps prior summaries and display:%s public custom content, never private state/details', async display => {
    const { manager, id } = await fixture();
    await manager.applyCompaction(id, 'PRIOR_BACKGROUND', manager.get(id)!.messages.at(-2)!.id);
    await manager.appendCustomEntry(id, 'state', { value: 'PRIVATE_STATE' });
    await manager.appendCustomMessage(id, 'notice', 'PUBLIC_CUSTOM', { display, details: { value: 'PRIVATE_DETAILS' } });
    await manager.addMessage(id, { role: 'user', content: 'recent user' }, { skipAutoCompaction: true });
    const before = JSON.stringify(await manager.getRawEntries(id));
    const messages = getCompactionModelMessages(manager, id), encoded = JSON.stringify(messages);
    expect(encoded).toContain('PRIOR_BACKGROUND'); expect(encoded).toContain('PUBLIC_CUSTOM');
    expect(encoded).not.toContain('PRIVATE_STATE'); expect(encoded).not.toContain('PRIVATE_DETAILS');
    expect(before).toContain('PRIVATE_STATE'); expect(before).toContain('PRIVATE_DETAILS');
    expect(JSON.stringify(await manager.getRawEntries(id))).toBe(before);
    const custom = messages.find(message => message.content.includes('PUBLIC_CUSTOM'))!;
    expect(custom).not.toHaveProperty('details'); expect(custom).not.toHaveProperty('data');
  });

  it('uses Core shell-context inclusion without importing private download paths', async () => {
    const { manager, id } = await fixture();
    await manager.addCommand(id, { command: 'visible-command', cwd: '/workspace', status: 'completed',
      output: 'VISIBLE_OUTPUT', exitCode: 0, downloadPath: '/PRIVATE_DOWNLOAD_PATH' });
    await manager.addCommand(id, { command: 'excluded-command', cwd: '/workspace', status: 'completed',
      output: 'EXCLUDED_OUTPUT', excludedFromContext: true });
    await manager.addCommand(id, { command: 'running-command', cwd: '/workspace', status: 'running', output: 'RUNNING_OUTPUT' });
    const encoded = JSON.stringify(getCompactionModelMessages(manager, id));
    expect(encoded).toContain('visible-command'); expect(encoded).toContain('VISIBLE_OUTPUT');
    expect(encoded).not.toContain('PRIVATE_DOWNLOAD_PATH'); expect(encoded).not.toContain('EXCLUDED_OUTPUT');
    expect(encoded).not.toContain('RUNNING_OUTPUT');
  });

  it('retains complete multi-tool groups and does not revive orphan tool results', async () => {
    const { manager, id } = await fixture();
    await manager.addMessage(id, { role: 'assistant', content: 'tool declaration', toolCalls: [
      { id: 'a', name: 'alpha', input: { value: 1 } }, { id: 'b', name: 'beta', input: { value: 2 } },
    ] }, { skipAutoCompaction: true });
    for (const call of ['a', 'b']) await manager.addMessage(id,
      { role: 'tool', toolCallId: call, content: `result-${call}` }, { skipAutoCompaction: true });
    await manager.addMessage(id, { role: 'user', content: 'next user' }, { skipAutoCompaction: true });
    await manager.addMessage(id, { role: 'tool', toolCallId: 'orphan', content: 'ORPHAN_RESULT' }, { skipAutoCompaction: true });
    const messages = getCompactionModelMessages(manager, id);
    expect(messages.find(message => message.content === 'tool declaration')!.toolCalls?.map(call => call.id)).toEqual(['a', 'b']);
    expect(messages.filter(message => message.role === 'tool').map(message => message.toolCallId)).toEqual(['a', 'b']);
    expect(JSON.stringify(messages)).not.toContain('ORPHAN_RESULT');
  });

  it('owns nested model input, never exposing writable aliases into Core history', async () => {
    const { manager, id } = await fixture();
    const blocks: NonNullable<Message['blocks']> = [
      { type: 'text', text: 'owned declaration', textSignature: 'PRIVATE_TEXT' },
      { type: 'reasoning', text: 'visible thought', thinkingSignature: 'PRIVATE_THINKING' },
      { type: 'reasoning', text: '', redacted: true, thinkingSignature: 'PRIVATE_REDACTED' },
      { type: 'tool_call', id: 'owned', name: 'tool', input: { nested: { value: 'ORIGINAL' } }, thoughtSignature: 'PRIVATE_BLOCK_TOOL' },
    ];
    const toolCalls = [{ id: 'owned', name: 'tool', input: { nested: { value: 'ORIGINAL' } }, thoughtSignature: 'PRIVATE_COMPAT_TOOL' }];
    await manager.addMessage(id, { role: 'assistant', content: 'owned declaration', blocks, toolCalls,
      provider: 'native-owner', api: 'anthropic-messages', model: 'native-model', metadata: { private: 'PRIVATE_METADATA' } }, { skipAutoCompaction: true });
    await manager.addMessage(id, { role: 'tool', toolCallId: 'owned', content: 'owned result' }, { skipAutoCompaction: true });
    const before = JSON.stringify(manager.getEffectiveContext(id));
    const messages = getCompactionModelMessages(manager, id), declaration = messages.find(message => message.toolCalls?.length)!;
    expect(declaration).toMatchObject({ blocks, toolCalls, provider: 'native-owner', api: 'anthropic-messages',
      model: 'native-model', metadata: { private: 'PRIVATE_METADATA' } });
    for (const block of declaration.blocks!) {
      if (block.type === 'text') block.textSignature = 'MUTATED_TEXT_SIGNATURE';
      if (block.type === 'reasoning') { block.thinkingSignature = 'MUTATED_THINKING_SIGNATURE'; block.redacted = false; }
      if (block.type === 'tool_call') block.thoughtSignature = 'MUTATED_BLOCK_TOOL_SIGNATURE';
    }
    declaration.toolCalls![0].thoughtSignature = 'MUTATED_COMPAT_TOOL_SIGNATURE';
    declaration.metadata!.private = 'MUTATED_METADATA';
    messages[0].content = 'MUTATED';
    const input = declaration.toolCalls![0].input as { nested: { value: string } };
    input.nested.value = 'MUTATED_NESTED';
    expect(JSON.stringify(manager.getEffectiveContext(id))).toBe(before);
    expect(JSON.stringify(getCompactionModelMessages(manager, id))).not.toContain('MUTATED');
  });

  it('conserves ordinary legacy Message fields with independently mutable input arrays', async () => {
    const { manager, id } = await fixture();
    await manager.addMessage(id, { role: 'assistant', content: 'ordinary ABI', provider: 'mock', model: 'mock-model',
      durationMs: 7, usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, metadata: { legacy: [1, 2] } },
    { skipAutoCompaction: true });
    const message = getCompactionModelMessages(manager, id).at(-1)!;
    expect(message).toMatchObject({ provider: 'mock', model: 'mock-model', durationMs: 7,
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, metadata: { legacy: [1, 2] } });
    (message.metadata!.legacy as number[]).push(3);
    expect(manager.get(id)!.messages.at(-1)!.metadata).toEqual({ legacy: [1, 2] });
  });

  it('follows parent-owned append order rather than source clocks', async () => {
    const manager = new SessionManager();
    const forward = new Date('2040-01-01'), backward = new Date('2000-01-01');
    const { id } = await manager.create({ activeLeafId: 'backward', messages: [
      { id: 'forward', role: 'user', content: 'clock-forward', timestamp: forward },
      { id: 'backward', role: 'assistant', content: 'clock-backward', timestamp: backward, parentMessageId: 'forward' },
    ] });
    const messages = getCompactionModelMessages(manager, id);
    expect(messages.map(message => message.timestamp.getTime())).toEqual([forward.getTime(), backward.getTime()]);
    expect(messages.slice(-2).map(message => message.content)).toEqual(['clock-forward', 'clock-backward']);
  });

  it.each([0, 1, 4])('converts only the captured %s-entry prefix without rereading or aliasing the source', async count => {
    const { manager, id } = await fixture();
    const prefix = manager.getEffectiveContext(id).slice(0, count), before = JSON.stringify(prefix);
    await manager.addMessage(id, { role: 'user', content: 'LATER_SUFFIX_NOT_ADMITTED' }, { skipAutoCompaction: true });
    const messages = compactionMessagesFromEntries(prefix);
    expect(messages.map(message => message.id)).toEqual(prefix.map(entry => entry.id));
    expect(JSON.stringify(messages)).not.toContain('LATER_SUFFIX_NOT_ADMITTED');
    for (const message of messages) expect(message.timestamp).toBeInstanceOf(Date);
    if (messages.length) messages[0].content = 'LOCAL_MUTATION';
    expect(JSON.stringify(prefix)).toBe(before);
    expect(JSON.stringify(manager.getEffectiveContext(id))).not.toContain('LOCAL_MUTATION');
  });

  it('has no model data or generation side effects for a missing session', () => {
    expect(getCompactionModelMessages(new SessionManager(), 'missing')).toEqual([]);
  });
});
