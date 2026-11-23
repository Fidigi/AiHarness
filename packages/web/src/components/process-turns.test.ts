import type { Message } from '@ai-harness/core';
import { describe, expect, it } from 'vitest';
import { processTurns } from './process-turns';

const message = (id: string, role: Message['role'], extra: Partial<Message> = {}): Message => ({
  id, role, content: '', timestamp: new Date('2026-01-01'), ...extra,
});
const call = (id: string) => message(id, 'assistant', { blocks: [{ type: 'reasoning', text: 'plan' },
  { type: 'tool_call', id: 'outer', name: 'codemode', input: { code: 'text(await tools.read({path:"x"}));' } }],
  toolCalls: [{ id: 'outer', name: 'codemode', input: {} }] });
const result = (id: string) => message(id, 'tool', { content: 'done', name: 'codemode', toolCallId: 'outer',
  blocks: [{ type: 'tool_result', toolCallId: 'outer', content: 'done' }], metadata: { codemode: {
    parentId: 'outer', nestedCalls: [{ id: 'outer:1', parentId: 'outer', state: 'completed' }], costComplete: false,
  } }, usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7, costUsd: 0.001 } });

describe('loaded process turns', () => {
  it('groups mid-turn history without requiring its missing user or assistant call entry', () => {
    const groups = processTurns([result('head'), call('second'), result('third'), message('final', 'assistant', { content: 'answer' })]);
    expect([...groups.values()]).toEqual([
      { id: 'head', steps: 4, header: true, finalAnswerId: 'final' },
      { id: 'head', steps: 4, header: false, finalAnswerId: 'final' },
      { id: 'head', steps: 4, header: false, finalAnswerId: 'final' },
    ]);
  });
  it('changes disclosure ownership exactly when a final answer appears or disappears', () => {
    const process = [call('call'), result('result')];
    expect(processTurns(process).get('call')!.finalAnswerId).toBeUndefined();
    expect(processTurns([...process, message('answer', 'assistant', { content: 'final' })]).get('call')!.finalAnswerId).toBe('answer');
    expect(processTurns(process).get('result')!.finalAnswerId).toBeUndefined();
  });
  it('does not misclassify intermediate assistant text with declared/block-only calls as final', () => {
    const first = call('one'); first.content = 'calling a tool';
    const blockOnly = { ...call('two'), toolCalls: undefined, content: 'another call' };
    const groups = processTurns([first, result('result'), blockOnly]);
    expect(groups.get('one')).toMatchObject({ id: 'one', steps: 5, header: true, finalAnswerId: undefined });
    expect(groups.get('two')).toMatchObject({ id: 'one', header: false });
  });
  it('starts fresh groups at user/context boundaries, final responses, and known history gaps', () => {
    const groups = processTurns([call('one'), message('final', 'assistant', { content: 'answer' }), call('two'),
      message('user', 'user', { content: 'follow-up' }), call('three'), message('context', 'system'), call('four'), result('gap')], new Set(['gap']));
    expect([...groups.values()].map(group => group.id)).toEqual(['one', 'two', 'three', 'four', 'gap']);
  });
  it('counts reasoning/command records once, keeps nested operations inside their outer result, and never alters accounting/inputs', () => {
    const messages = [message('user', 'user', { blocks: [{ type: 'text', text: '@x expanded prompt' }] }), call('call'), result('result'),
      message('command', 'assistant', { blocks: [{ type: 'command', command: 'ls', cwd: '/workspace', output: 'x', status: 'completed' }] }),
      message('final', 'assistant', { content: 'answer', blocks: [{ type: 'reasoning', text: 'done' }, { type: 'text', text: 'answer' }] })];
    const original = structuredClone(messages);
    const groups = processTurns(messages);
    expect(groups.size).toBe(4);
    expect(groups.get('call')).toMatchObject({ steps: 5, finalAnswerId: 'final' });
    expect(messages).toEqual(original);
    expect(messages[2]!.usage!.totalTokens).toBe(7);
    expect(groups.has('outer:1')).toBe(false);
  });
  it('treats final images/text blocks as answers, but not empty or reasoning-only incomplete rows', () => {
    const process = [call('call'), result('result')];
    const empty = message('empty', 'assistant', { blocks: [{ type: 'reasoning', text: 'still thinking' }] });
    expect(processTurns([...process, empty]).get('call')!.finalAnswerId).toBeUndefined();
    expect(processTurns([...process, message('image', 'assistant', { blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,eA==' }] })]).get('call')!.finalAnswerId).toBe('image');
  });
});
