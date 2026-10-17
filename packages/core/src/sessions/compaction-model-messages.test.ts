import { describe, expect, it } from 'vitest';
import { SessionManager } from './session-manager.js';
import { getCompactionModelMessages } from './compaction-model-messages.js';

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
    await manager.addMessage(id, { role: 'assistant', content: 'owned declaration',
      toolCalls: [{ id: 'owned', name: 'tool', input: { nested: { value: 'ORIGINAL' } } }] }, { skipAutoCompaction: true });
    await manager.addMessage(id, { role: 'tool', toolCallId: 'owned', content: 'owned result' }, { skipAutoCompaction: true });
    const before = JSON.stringify(manager.getEffectiveContext(id));
    const messages = getCompactionModelMessages(manager, id);
    messages[0].content = 'MUTATED';
    const input = messages.find(message => message.toolCalls?.length)!.toolCalls![0].input as { nested: { value: string } };
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

  it('has no model data or generation side effects for a missing session', () => {
    expect(getCompactionModelMessages(new SessionManager(), 'missing')).toEqual([]);
  });
});
