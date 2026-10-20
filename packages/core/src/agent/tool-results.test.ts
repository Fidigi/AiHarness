import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../sessions/session-manager.js';
import { ExtensionRegistry, type ExtensionRuntimeContext, type ExtensionTool } from '../extensions/extension-registry.js';
import { runToolLoop, type ToolLoopOptions } from './tool-loop.js';
import { getSessionAccounting } from '../sessions/session-accounting.js';

const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT6sAAAAASUVORK5CYII=';
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(tools: ExtensionTool[], calls = tools.map(tool => tool.name)) {
  const manager = new SessionManager(); const registry = new ExtensionRegistry();
  await registry.load('test', api => { for (const tool of tools) api.registerTool(tool); });
  const session = await manager.create({ title: 'Tool contract' });
  await manager.addMessage(session.id, { role: 'user', content: 'run tools' });
  const turn = vi.fn<ToolLoopOptions['streamTurn']>().mockResolvedValueOnce({ content: '',
    toolCalls: calls.map((name, i) => ({ id: `call-${i}`, name, input: {} })) }).mockResolvedValue({ content: 'done' });
  const options: ToolLoopOptions = { sessionId: session.id, sessionManager: manager, extensionRegistry: registry,
    toolContext: { sessionManager: manager, currentSessionId: session.id, notify() {} }, streamTurn: turn };
  return { manager, registry, session, turn, options, run: (extra: Partial<ToolLoopOptions> = {}) => runToolLoop({ ...options, ...extra }),
    results: () => manager.get(session.id)!.messages.filter(message => message.role === 'tool') };
}

describe('native tool result and nested execution contract', () => {
  it('vetoes public results without granting codemode store authority or losing completed usage', async () => {
    const f = await fixture([{ name: 'probe', description: '', execute: () => ({ content: 'original' }) }]);
    await f.registry.load('veto', api => { api.before('before:tool:result', () => false); });
    await f.run({ getToolResultMetadata: () => ({ codemode: { usage: { totalTokens: 7 }, store: { counter: 1 } } }) });
    expect(f.results()[0].isError).toBe(true);
    expect(f.results()[0].metadata?.codemode).toEqual({ usage: { totalTokens: 7 } });
    expect(f.results()[0].usage?.totalTokens).toBe(7);
  });

  it('conserves provider usage on message veto and never executes its pending tool calls', async () => {
    const execute = vi.fn(() => ({ content: 'unreachable' }));
    const f = await fixture([{ name: 'probe', description: '', execute }]);
    f.turn.mockReset().mockResolvedValue({ content: 'billed', toolCalls: [{ id: 'pending', name: 'probe', input: {} }],
      usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } });
    await f.registry.load('veto', api => { api.before('before:message', () => false); });
    await expect(f.run()).rejects.toThrow('Extension message cancelled.');
    expect(execute).not.toHaveBeenCalled();
    expect(f.manager.get(f.session.id)?.usage.totalTokens).toBe(3);
    expect(f.manager.get(f.session.id)?.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'billed',
      metadata: { outputError: 'Extension message publication refused.' } });
    expect(f.manager.get(f.session.id)?.messages.at(-1)?.toolCalls).toBeUndefined();
  });

  it('joins readonly batches in declared order before starting a mutator', async () => {
    const a = gate(), b = gate(), started: string[] = [];
    const f = await fixture([
      { name: 'a', description: '', readOnly: true, execute: async () => { started.push('a'); await a.promise; return { content: 'A' }; } },
      { name: 'b', description: '', readOnly: true, execute: async () => { started.push('b'); await b.promise; return { content: 'B' }; } },
      { name: 'mutate', description: '', execute: () => { started.push('mutate'); return { content: 'M' }; } },
    ]);
    const running = f.run();
    try {
      await vi.waitFor(() => expect(started).toEqual(['a', 'b']));
      b.resolve(); await Promise.resolve(); expect(started).not.toContain('mutate'); expect(f.results()).toHaveLength(0);
      a.resolve(); await expect(running).resolves.toBe('done');
      expect(started).toEqual(['a', 'b', 'mutate']); expect(f.results().map(result => result.content)).toEqual(['A', 'B', 'M']);
    } finally { a.resolve(); b.resolve(); await running.catch(() => {}); }
  });

  it('admits at most four adjacent readonly tools before joining the next batch', async () => {
    const hold = gate(); const started: string[] = [];
    const f = await fixture(['a', 'b', 'c', 'd', 'e'].map(name => ({ name, description: '', readOnly: true,
      execute: async () => { started.push(name); await hold.promise; return { content: name }; } })));
    const running = f.run();
    try {
      await vi.waitFor(() => expect(started).toEqual(['a', 'b', 'c', 'd']));
      expect(f.results()).toHaveLength(0); hold.resolve(); await running;
      expect(started).toEqual(['a', 'b', 'c', 'd', 'e']); expect(f.results().map(result => result.name)).toEqual(started);
    } finally { hold.resolve(); await running.catch(() => {}); }
  });

  it('publishes every completed batch member even when the first result observer fails', async () => {
    const f = await fixture(['a', 'b'].map(name => ({ name, description: '', readOnly: true, execute: () => ({ content: name }) })));
    const observed: string[] = [];
    await expect(f.run({ onToolResult: result => { observed.push(result.call.name); if (result.call.name === 'a') throw new Error('observer failed'); } }))
      .rejects.toThrow('observer failed');
    expect(f.results().map(result => result.name)).toEqual(['a', 'b']); expect(observed).toEqual(['a', 'b']);
    expect(f.turn).toHaveBeenCalledOnce();
  });

  it('retains the slot until all parallel work physically settles on cancellation', async () => {
    const a = gate(), b = gate(), started: string[] = []; const controller = new AbortController(); let settled = false;
    const f = await fixture(['a', 'b', 'mutate'].map(name => ({ name, description: '', readOnly: name !== 'mutate',
      execute: async () => { started.push(name); await (name === 'a' ? a : b).promise; return { content: name }; } })));
    const running = f.run({ signal: controller.signal }).catch(error => error).finally(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(started).toEqual(['a', 'b'])); controller.abort(); a.resolve();
      await new Promise(resolve => setTimeout(resolve, 20)); expect(settled).toBe(false);
      b.resolve(); await running; expect(started).toEqual(['a', 'b']);
      expect(f.results()).toHaveLength(2); expect(f.results().every(result => result.isError && result.metadata?.interrupted)).toBe(true);
      expect(f.turn).toHaveBeenCalledOnce();
    } finally { a.resolve(); b.resolve(); await running; }
  });

  it('authorizes and hooks nested calls, joins ignored children and retires captured callbacks', async () => {
    const hold = gate(); const started: string[] = []; let nested!: NonNullable<ExtensionRuntimeContext['executeTool']>; let settled = false;
    const f = await fixture([
      { name: 'parent', description: '', execute: async (_input, context) => {
        nested = context.executeTool!; const input = { value: 1 }; void nested('child', input); input.value = 2; return { content: 'parent' };
      } },
      { name: 'child', description: '', execute: async input => { expect(input).toEqual({ value: 1 }); started.push('child'); await hold.promise; return { content: 'child', structuredContent: { ok: true } }; } },
    ], ['parent']);
    const hook = vi.fn(); await f.registry.load('hooks', api => api.before('before:tool', data => { hook(data.tool); return data; }));
    const running = f.run().finally(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(started).toEqual(['child'])); expect(settled).toBe(false);
      hold.resolve(); await running;
      expect(hook.mock.calls.map(call => call[0])).toEqual(['parent', 'child']);
      expect(f.results()).toHaveLength(1); expect(f.results()[0].metadata?.nestedTools).toEqual([
        expect.objectContaining({ name: 'child', parentId: 'call-0', isError: false, structuredContent: { ok: true } }),
      ]);
      await expect(nested('child', {})).rejects.toThrow('no longer active'); expect(started).toHaveLength(1);
    } finally { hold.resolve(); await running.catch(() => {}); }
  });

  it('allows four child levels and refuses a fifth without dispatch', async () => {
    const started: string[] = []; const names = ['parent', 'a', 'b', 'c', 'd', 'e'];
    const f = await fixture(names.map((name, index) => ({ name, description: '', execute: async (_input, context) => {
      started.push(name);
      return index < names.length - 1 ? await context.executeTool!(names[index + 1], {}) : { content: 'too deep' };
    } })), ['parent']);
    await f.run(); expect(started).toEqual(['parent', 'a', 'b', 'c', 'd']); expect(f.results()[0].isError).toBe(true);
    const records = f.results()[0].metadata!.nestedTools as Array<{ id: string; parentId: string; name: string }>;
    expect(records).toHaveLength(4);
    for (const [child, parent] of [['a', 'parent'], ['b', 'a'], ['c', 'b'], ['d', 'c']]) {
      expect(records.find(record => record.name === child)!.parentId).toBe(parent === 'parent' ? 'call-0' : records.find(record => record.name === parent)!.id);
    }
  });

  it('joins an ignored nested child on cancellation and suppresses its late rich output', async () => {
    const hold = gate(), admitted = gate(); const controller = new AbortController(); let settled = false;
    const f = await fixture([
      { name: 'parent', description: '', execute: (_input, context) => { void context.executeTool!('child', {}); return { content: 'parent' }; } },
      { name: 'child', description: '', execute: async (_input, _context, signal) => {
        expect(signal).toBe(controller.signal); admitted.resolve(); await hold.promise;
        return { content: 'LATE CHILD', structuredContent: { value: 'LATE CHILD' }, blocks: [{ type: 'image', mediaType: 'image/png', url: pixel }] };
      } },
    ], ['parent']);
    const running = f.run({ signal: controller.signal }).catch(error => error).finally(() => { settled = true; });
    try {
      await admitted.promise; controller.abort(); await new Promise(resolve => setTimeout(resolve, 20)); expect(settled).toBe(false);
      hold.resolve(); await running; expect(f.results()).toHaveLength(1);
      expect(f.results()[0].metadata!.nestedTools).toEqual([expect.objectContaining({ name: 'child', isError: true, content: 'Nested tool execution interrupted.', blocks: [] })]);
      expect(JSON.stringify(f.results())).not.toContain('LATE CHILD'); expect(f.results()[0].metadata!.interrupted).toBe(true);
    } finally { hold.resolve(); await running; }
  });

  it('rechecks current selection, prevents recursion and pins nested authority through hook context replacement', async () => {
    let enabled = true; const child = vi.fn(() => ({ content: 'not allowed' })); const forged = vi.fn();
    const f = await fixture([
      { name: 'parent', description: '', execute: async (_input, context) => {
        const denied = await context.executeTool!('child', {}); const recursive = await context.executeTool!('parent', {});
        return { content: `${denied.isError}:${recursive.isError}` };
      } },
      { name: 'child', description: '', execute: child },
    ], ['parent']);
    await f.registry.load('hooks', api => api.before('before:tool', data => {
      if (data.tool === 'child') enabled = false;
      return { ...data, context: { ...data.context, executeTool: forged } };
    }));
    await f.run({ resolveTools: () => (enabled ? ['parent', 'child'] : ['parent']).map(name => ({ name, description: '', parameters: {} })) });
    expect(f.results()[0].content).toBe('true:true'); expect(child).not.toHaveBeenCalled(); expect(forged).not.toHaveBeenCalled();
  });

  it('bounds nested admissions to 64, serializes siblings and joins accepted work after a limit refusal', async () => {
    let calls = 0, active = 0, maximum = 0; const getter = vi.fn();
    const f = await fixture([
      { name: 'parent', description: '', execute: async (_input, context) => {
        const input = Object.defineProperty({}, 'value', { get: getter, enumerable: true });
        await expect(context.executeTool!('child', input)).rejects.toThrow();
        await Promise.all(Array.from({ length: 65 }, () => context.executeTool!('child', {})));
        return { content: 'unreachable' };
      } },
      { name: 'child', description: '', execute: async () => {
        calls++; active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; return { content: calls === 1 ? 'x'.repeat(400 * 1024) : 'child' };
      } },
    ], ['parent']);
    await f.run(); expect(calls).toBe(64); expect(maximum).toBe(1); expect(getter).not.toHaveBeenCalled();
    expect(f.results()[0].isError).toBe(true);
    const records = f.results()[0].metadata!.nestedTools as Array<{ content: string; isError: boolean }>;
    expect(records).toHaveLength(64); expect(records[0].isError).toBe(true); expect(records[0].content).toBe('Nested tool result exceeded the aggregate limit.');
    expect(Buffer.byteLength(JSON.stringify(records))).toBeLessThanOrEqual(512 * 1024);
  });

  it('redacts JSON-escaped structured keys/values and credential-shaped primitives before publication', async () => {
    const secret = 'quoted"\\secret';
    const f = await fixture([{ name: 'structured', description: '', execute: () => ({ content: '',
      structuredContent: { [secret]: secret, nested: [secret], number: 89123 } }) }]);
    await f.run({ redactText: text => text.replaceAll(secret, '[REDACTED]').replaceAll('89123', '[REDACTED]') });
    const block = f.results()[0].blocks!.find(block => block.type === 'tool_result')!;
    expect(block.structuredContent).toEqual({ '[REDACTED]': '[REDACTED]', nested: ['[REDACTED]'], number: '[REDACTED]' });
    expect(f.results()[0].content).toContain('[REDACTED]');
  });

  it('owns redacted structured/text/image outputs without authenticating nested usage', async () => {
    const image = { type: 'image' as const, mediaType: 'image/png', url: pixel, name: 'private-token.png' };
    const f = await fixture([{ name: 'rich', description: '', execute: () => ({ content: 'private-token',
      structuredContent: { value: 'private-token', usage: { totalTokens: 9999 } },
      blocks: [{ type: 'text', text: 'additional text' }, image], isError: true }) }]);
    await f.run({ redactText: value => value.replaceAll('private-token', '[REDACTED]'), maxToolResultLength: 80 });
    const result = f.results()[0]; expect(result.isError).toBe(true); expect(result.content).toContain('[REDACTED]');
    const block = result.blocks!.find(block => block.type === 'tool_result')!;
    expect(block.type === 'tool_result' && block.fullContent).toContain('additional text');
    expect(block.type === 'tool_result' && block.structuredContent).toEqual({ value: '[REDACTED]', usage: { totalTokens: 9999 } });
    expect(result.blocks).toContainEqual({ ...image, name: '[REDACTED].png' }); image.name = 'mutated';
    expect(JSON.stringify(f.results())).not.toContain('private-token'); expect(JSON.stringify(f.results())).not.toContain('mutated');
    expect(getSessionAccounting(await f.manager.getRawEntries(f.session.id), f.manager.get(f.session.id)!.activeLeafId).active.usage.totalTokens).toBeUndefined();
  });

  it.each(['accessor', 'svg', 'remote', 'oversize'])('refuses %s result data without executing accessors or admitting active images', async mode => {
    const getter = vi.fn(() => 'private-token');
    const structuredContent = mode === 'accessor' ? Object.defineProperty({}, 'secret', { get: getter, enumerable: true }) : {};
    const f = await fixture([{ name: 'invalid', description: '', execute: () => ({ content: mode === 'oversize' ? 'x'.repeat(4 * 1024 * 1024 + 1) : 'text',
      structuredContent, blocks: mode === 'accessor' || mode === 'oversize' ? [] : [{ type: 'image',
        mediaType: mode === 'svg' ? 'image/svg+xml' : 'image/png', url: mode === 'svg' ? 'data:image/svg+xml;base64,AAAA' : 'https://example.test/x.png' }] }) }]);
    await f.run(); expect(f.results()[0].isError).toBe(true); expect(getter).not.toHaveBeenCalled();
    expect(f.results()[0].blocks?.some(block => block.type === 'image')).toBe(false);
  });
});
