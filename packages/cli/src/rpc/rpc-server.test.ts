import { describe, expect, it, vi } from 'vitest';
import { MockProvider, SessionManager } from '@ai-harness/core';
import { handleRpcRequest, type RpcContext } from './rpc-server';

async function context(): Promise<RpcContext> {
  const sessionManager = new SessionManager();
  return {
    sessionManager,
    providers: new Map([['mock', new MockProvider({ type: 'mock' as any }, ['Réponse RPC'])]]),
    emit: vi.fn(),
  };
}

describe('RPC server', () => {
  it('creates, lists, gets, and deletes sessions', async () => {
    const ctx = await context();
    const created = await handleRpcRequest({ id: 1, method: 'session.create', params: { title: 'RPC' } }, ctx);
    const sessionId = (created.result as { id: string }).id;

    expect((await handleRpcRequest({ id: 2, method: 'session.list' }, ctx)).result).toHaveLength(1);
    expect((await handleRpcRequest({ id: 3, method: 'session.get', params: { sessionId } }, ctx)).result).toMatchObject({ title: 'RPC' });
    expect((await handleRpcRequest({ id: 4, method: 'session.delete', params: { sessionId } }, ctx)).result).toEqual({ deletedCount: 1 });
  });

  it('streams chat events and persists both messages', async () => {
    const ctx = await context();
    const created = await ctx.sessionManager.create({ title: 'Chat' });

    const response = await handleRpcRequest({
      id: 'chat-1',
      method: 'chat.send',
      params: { sessionId: created.id, provider: 'mock', content: 'Bonjour' },
    }, ctx);

    expect(response.result).toMatchObject({ content: 'Réponse RPC' });
    expect(ctx.sessionManager.get(created.id)?.messages.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(ctx.emit).toHaveBeenCalledWith(expect.objectContaining({ event: 'text_delta' }));
    expect(ctx.emit).toHaveBeenCalledWith(expect.objectContaining({ event: 'message_end' }));
  });

  it('returns a structured error for unknown methods', async () => {
    const ctx = await context();
    await expect(handleRpcRequest({ id: 9, method: 'unknown' }, ctx)).resolves.toEqual({
      id: 9,
      error: { code: 'METHOD_NOT_FOUND', message: 'Méthode inconnue : unknown' },
    });
  });
});
