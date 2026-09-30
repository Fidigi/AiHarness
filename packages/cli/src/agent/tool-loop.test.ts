import { describe, expect, it, vi } from 'vitest';
import { ExtensionRegistry, SessionManager } from '@ai-harness/core';
import { runToolLoop } from './tool-loop';

async function setup() {
  const sessionManager = new SessionManager();
  const session = await sessionManager.create({ title: 'Tool loop' });
  await sessionManager.addMessage(session.id, { role: 'user', content: 'Additionne 2 et 3' });
  const extensionRegistry = new ExtensionRegistry();
  return { sessionManager, session, extensionRegistry };
}

describe('runToolLoop', () => {
  it('injects schemas, executes a tool, persists its result, and resumes the model', async () => {
    const { sessionManager, session, extensionRegistry } = await setup();
    await extensionRegistry.load('math', api => {
      api.registerTool({
        name: 'sum',
        description: 'Additionner deux nombres',
        parameters: {
          type: 'object',
          properties: { a: { type: 'number' }, b: { type: 'number' } },
          required: ['a', 'b'],
        },
        execute: input => {
          const { a, b } = input as { a: number; b: number };
          return { content: String(a + b) };
        },
      });
    });
    const streamTurn = vi.fn()
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{ id: 'call-1', name: 'sum', input: { a: 2, b: 3 } }],
      })
      .mockImplementationOnce(async messages => {
        expect(messages.map((message: { role: string }) => message.role)).toEqual(['user', 'assistant', 'tool']);
        expect(messages[2]).toMatchObject({
          content: '5',
          toolCallId: 'call-1',
          name: 'sum',
          isError: false,
        });
        return { content: 'Le résultat est 5.' };
      });
    const onToolResult = vi.fn();

    const content = await runToolLoop({
      sessionManager,
      sessionId: session.id,
      extensionRegistry,
      toolContext: { sessionManager, currentSessionId: session.id, notify: vi.fn() },
      streamTurn,
      onToolResult,
    });

    expect(content).toBe('Le résultat est 5.');
    expect(streamTurn).toHaveBeenCalledTimes(2);
    expect(streamTurn.mock.calls[0][1]).toEqual([
      expect.objectContaining({ name: 'sum', description: 'Additionner deux nombres' }),
    ]);
    expect(onToolResult).toHaveBeenCalledWith(expect.objectContaining({ content: '5', isError: false }));
    expect(sessionManager.get(session.id)?.messages.map(message => message.role)).toEqual([
      'user', 'assistant', 'tool', 'assistant',
    ]);
  });

  it('includes the latest compaction summary in the provider context', async () => {
    const { sessionManager, session, extensionRegistry } = await setup();
    await sessionManager.applyCompaction(session.id, 'Earlier decisions', session.messages[0].id);
    const streamTurn = vi.fn(async messages => {
      expect(messages[0]).toMatchObject({
        role: 'system',
        content: '[Context Summary] Earlier decisions',
      });
      expect(messages[1]).toMatchObject({ role: 'user', content: 'Additionne 2 et 3' });
      return { content: 'Réponse finale' };
    });

    await runToolLoop({
      sessionManager,
      sessionId: session.id,
      extensionRegistry,
      toolContext: { sessionManager, currentSessionId: session.id, notify: vi.fn() },
      streamTurn,
    });

    expect(streamTurn).toHaveBeenCalledOnce();
  });

  it('returns tool failures to the model as error results', async () => {
    const { sessionManager, session, extensionRegistry } = await setup();
    const streamTurn = vi.fn()
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{ id: 'missing-1', name: 'missing', input: {} }],
      })
      .mockImplementationOnce(async messages => {
        expect(messages[2]).toMatchObject({ role: 'tool', name: 'missing', isError: true });
        expect(messages[2].content).toContain('Unknown extension tool');
        return { content: 'Je ne peux pas exécuter cet outil.' };
      });

    await expect(runToolLoop({
      sessionManager,
      sessionId: session.id,
      extensionRegistry,
      toolContext: { sessionManager, currentSessionId: session.id, notify: vi.fn() },
      streamTurn,
    })).resolves.toBe('Je ne peux pas exécuter cet outil.');
  });

  it('passes cancellation to an active tool and does not persist a partial result', async () => {
    const { sessionManager, session, extensionRegistry } = await setup();
    const controller = new AbortController();
    await extensionRegistry.load('slow', api => {
      api.registerTool({
        name: 'slow',
        description: 'Wait',
        execute: (_input, _context, signal) => new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
          queueMicrotask(() => controller.abort());
        }),
      });
    });

    await expect(runToolLoop({
      sessionManager,
      sessionId: session.id,
      extensionRegistry,
      toolContext: { sessionManager, currentSessionId: session.id, notify: vi.fn() },
      streamTurn: vi.fn().mockResolvedValue({
        content: '',
        toolCalls: [{ id: 'slow-1', name: 'slow', input: {} }],
      }),
      signal: controller.signal,
    })).rejects.toThrow("Exécution de l'agent interrompue");

    expect(sessionManager.get(session.id)?.messages.map(message => message.role)).toEqual(['user', 'assistant']);
  });

  it('stops an infinite tool loop at the configured safety limit', async () => {
    const { sessionManager, session, extensionRegistry } = await setup();
    await extensionRegistry.load('loop', api => {
      api.registerTool({
        name: 'again',
        description: 'Continue',
        execute: () => 'encore',
      });
    });
    let call = 0;
    const streamTurn = vi.fn(async () => ({
      content: '',
      toolCalls: [{ id: `call-${++call}`, name: 'again', input: {} }],
    }));

    await expect(runToolLoop({
      sessionManager,
      sessionId: session.id,
      extensionRegistry,
      toolContext: { sessionManager, currentSessionId: session.id, notify: vi.fn() },
      streamTurn,
      maxToolRounds: 2,
    })).rejects.toThrow("Limite de 2 tours d'outils atteinte");
    expect(streamTurn).toHaveBeenCalledTimes(2);
  });
});
