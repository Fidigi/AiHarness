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
        expect(messages.map((message: { role: string }) => message.role)).toEqual(['user', 'assistant', 'tool', 'user']);
        expect(messages[2]).toMatchObject({
          content: '5',
          toolCallId: 'call-1',
          name: 'sum',
          isError: false,
        });
        expect(messages[3]).toMatchObject({ content: 'Priorité suivante' });
        return { content: 'Le résultat est 5.' };
      });
    const onToolResult = vi.fn();
    const onAssistantResponse = vi.fn();
    const onTurnEnd = vi.fn();

    const content = await runToolLoop({
      sessionManager,
      sessionId: session.id,
      extensionRegistry,
      toolContext: { sessionManager, currentSessionId: session.id, notify: vi.fn() },
      streamTurn,
      onAssistantResponse,
      onToolResult,
      onTurnEnd,
      beforeNextTurn: () => sessionManager.addMessage(session.id, {
        role: 'user', content: 'Priorité suivante',
      }).then(() => undefined),
    });

    expect(content).toBe('Le résultat est 5.');
    expect(streamTurn).toHaveBeenCalledTimes(2);
    expect(streamTurn.mock.calls[0][1]).toEqual([
      expect.objectContaining({ name: 'sum', description: 'Additionner deux nombres' }),
    ]);
    expect(onAssistantResponse).toHaveBeenCalledTimes(2);
    expect(onAssistantResponse).toHaveBeenNthCalledWith(1, expect.objectContaining({
      toolCalls: [expect.objectContaining({ id: 'call-1' })],
    }), 0, expect.any(Number));
    expect(onToolResult).toHaveBeenCalledWith(expect.objectContaining({ content: '5', isError: false }));
    expect(onTurnEnd).toHaveBeenCalledTimes(2);
    expect(onTurnEnd).toHaveBeenNthCalledWith(1, expect.any(Object), [
      expect.objectContaining({ content: '5', isError: false }),
    ], 0);
    expect(onTurnEnd).toHaveBeenNthCalledWith(2, expect.any(Object), [], 1);
    expect(sessionManager.get(session.id)?.messages.map(message => message.role)).toEqual([
      'user', 'assistant', 'tool', 'user', 'assistant',
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

  it('returns an error instead of executing a registered tool omitted from the run allowlist', async () => {
    const { sessionManager, session, extensionRegistry } = await setup();
    const execute = vi.fn(() => ({ content: 'unsafe' }));
    await extensionRegistry.load('hidden', api => {
      api.registerTool({ name: 'hidden', description: 'Hidden tool', execute });
    });
    const streamTurn = vi.fn()
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{ id: 'hidden-1', name: 'hidden', input: {} }],
      })
      .mockImplementationOnce(async messages => {
        expect(messages[2]).toMatchObject({ role: 'tool', name: 'hidden', isError: true });
        expect(messages[2].content).toContain('not enabled');
        return { content: 'Tool refused.' };
      });

    await expect(runToolLoop({
      sessionManager,
      sessionId: session.id,
      extensionRegistry,
      tools: [],
      toolContext: { sessionManager, currentSessionId: session.id, notify: vi.fn() },
      streamTurn,
    })).resolves.toBe('Tool refused.');
    expect(execute).not.toHaveBeenCalled();
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
