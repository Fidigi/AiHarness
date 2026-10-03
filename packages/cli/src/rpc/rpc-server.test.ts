import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { MockProvider, SessionManager } from '@ai-harness/core';
import { handleRpcRequest, runRpcMode, type RpcContext } from './rpc-server';

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

  it('uses the startup provider when a chat request omits one', async () => {
    const ctx = await context();
    ctx.providers = new Map([['preferred', new MockProvider({ type: 'mock' as any }, ['Startup provider'])]]);
    ctx.defaultProviderName = 'preferred';
    const session = await ctx.sessionManager.create({ title: 'Default provider' });

    const response = await handleRpcRequest({
      id: 'default-provider',
      method: 'chat.send',
      params: { sessionId: session.id, content: 'Bonjour' },
    }, ctx);

    expect(response.result).toMatchObject({ content: 'Startup provider' });
  });

  it('serializes custom protocol sinks under backpressure', async () => {
    const records: Array<Record<string, unknown>> = [];
    let releaseFirst = (): void => undefined;
    const firstWrite = new Promise<void>(resolve => { releaseFirst = resolve; });
    let first = true;
    let deliveryStarted = false;
    let deliveriesInFlight = 0;
    let maximumDeliveriesInFlight = 0;
    const running = runRpcMode({
      noSession: true,
      input: Readable.from([
        '{"type":"get_state","id":"state-1"}\n',
        '{"type":"get_state","id":"state-2"}\n',
      ]),
      output: async record => {
        deliveriesInFlight++;
        maximumDeliveriesInFlight = Math.max(maximumDeliveriesInFlight, deliveriesInFlight);
        deliveryStarted = true;
        try {
          if (first) {
            first = false;
            await firstWrite;
          }
          records.push(record);
        } finally {
          deliveriesInFlight--;
        }
      },
    });

    await vi.waitFor(() => expect(deliveryStarted).toBe(true));
    expect(records).toEqual([]);
    expect(maximumDeliveriesInFlight).toBe(1);
    releaseFirst();
    await running;

    expect(maximumDeliveriesInFlight).toBe(1);
    expect(records).toHaveLength(2);
    expect(records.map(record => record.id).sort()).toEqual(['state-1', 'state-2']);
  });

  it('treats asynchronous protocol delivery failure as terminal', async () => {
    await expect(runRpcMode({
      noSession: true,
      input: Readable.from(['{"type":"get_state","id":"state"}\n']),
      output: async () => { throw new Error('closed protocol output'); },
    })).rejects.toThrow('closed protocol output');
  });

  it('returns a structured error for unknown methods', async () => {
    const ctx = await context();
    await expect(handleRpcRequest({ id: 9, method: 'unknown' }, ctx)).resolves.toEqual({
      id: 9,
      error: { code: 'METHOD_NOT_FOUND', message: 'Méthode inconnue : unknown' },
    });
  });
});
