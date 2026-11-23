import type { Message } from '@ai-harness/core';

export interface ProcessTurn { id: string; steps: number; header: boolean; finalAnswerId?: string }

/** Projection only: no provider context or accounting authority. Recompute from
 * loaded order, not wall-clock timestamps or a remembered first user message. */
export function processTurns(messages: readonly Message[], gaps: ReadonlySet<string> = new Set()): Map<string, ProcessTurn> {
  const result = new Map<string, ProcessTurn>();
  let pending: Message[] = [];
  let steps = 0;
  const flush = (finalAnswerId?: string): void => {
    const id = pending[0]?.id;
    if (!id) return;
    pending.forEach((message, index) => result.set(message.id, { id, steps, header: index === 0, finalAnswerId }));
    pending = [];
    steps = 0;
  };
  for (const message of messages) {
    if (gaps.has(message.id) || message.role === 'user' || message.role === 'system') flush();
    const blocks = message.blocks ?? [];
    const calls = message.toolCalls?.length || blocks.some(block => block.type === 'tool_call');
    const count = blocks.filter(block => ['reasoning', 'tool_call', 'tool_result', 'command'].includes(block.type)).length
      || (message.role === 'tool' ? 1 : 0);
    if (count) { pending.push(message); steps += count; }
    const final = message.role === 'assistant' && !calls && (message.content.trim()
      || blocks.some(block => block.type === 'image' || block.type === 'text' && block.text.trim()));
    if (final) flush(message.id);
  }
  flush();
  return result;
}
