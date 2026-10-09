import { describe, expect, it, vi } from 'vitest';
import { ExtensionRegistry, type ExtensionRuntimeContext } from '../extensions/extension-registry.js';
import { SessionManager } from '../sessions/session-manager.js';
import { runToolLoop } from '../agent/tool-loop.js';
import { collectCodemodeStore, runCodemode, testCodemodeSandbox } from './codemode.js';
import { createAgentToolLoadout } from './tool-search.js';

const context = {} as ExtensionRuntimeContext;
const read = { name: 'read', description: 'Read documentation', extensionId: 'builtin:workspace-tools',
  namespace: { name: 'workspace', description: 'Files' }, parameters: { type: 'object' } };
function run(code: string, extra: Partial<Parameters<typeof runCodemode>[0]> = {}) {
  return runCodemode({ code, context, tools: () => [read], execute: async () => ({ content: 'document' }), ...extra });
}

describe('bounded QuickJS codemode', () => {
  it('self-tests isolation without granting ambient Node/network/timer capabilities', async () => {
    expect(await testCodemodeSandbox()).toMatchObject({ state: 'passed', engine: 'QuickJS' });
    const result = await run('return [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof __hostCall];');
    expect(result.content).toContain('["undefined","undefined","undefined","undefined","undefined"]');
  });

  it('supports async/parallel tools, output, search, namespaces and transactional JSON store', async () => {
    let active = 0;
    let maximum = 0;
    const result = await run(`
      const results = await Promise.allSettled(Array.from({length: 10}, () => tools.read({path: 'README.md'})));
      text(results.filter(r => r.status === 'fulfilled').length);
      text((await searchTools('documentation', {namespace: 'workspace'}))[0].name);
      text((await describeNamespace('workspace')).tools.length);
      store('cursor', {page: 2}); return load('cursor');
    `, { execute: async () => {
      maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active--; return { content: 'document' };
    } });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('\n10\nread\n1\n{"page":2}');
    expect(maximum).toBeLessThanOrEqual(4);
    expect(result.details?.store).toEqual({ cursor: { page: 2 } });
    expect(result.details?.nestedCalls).toHaveLength(10);
  });

  it('reapplies policy after discovery and rejects model-only/hidden/control tools', async () => {
    const execute = vi.fn(async () => ({ content: 'ok' }));
    const result = await run(`
      text(ALL_TOOLS.map(t => t.name));
      await tools.read({}); await tools.read({});
    `, { execute, tools: () => execute.mock.calls.length ? [] : [read,
      { ...read, name: 'codemode' }, { ...read, name: 'spawn_subagent' },
      { ...read, name: 'secret', exposure: 'hidden' }, { ...read, name: 'control', exposure: 'model-only' },
    ] });
    expect(result.content).toContain('["read"]');
    expect(result.content).toContain('Nested tool is not enabled.');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rechecks queued authorization and prevents late notifications or interaction/raw-output bypasses', async () => {
    let allowed = true;
    let nested: ExtensionRuntimeContext | undefined;
    const notify = vi.fn();
    const execute = vi.fn(async (_name, _input, ctx: ExtensionRuntimeContext) => {
      nested = ctx; allowed = false;
      await new Promise(resolve => setTimeout(resolve, 20));
      return { content: 'ok' };
    });
    const result = await run(`
      const results = await Promise.allSettled([tools.read({}), tools.read({}), tools.read({})]);
      text(results.map(result => result.status));
    `, { tools: () => allowed ? [read] : [], execute, limits: { concurrency: 1 },
      context: { ...context, toolPreset: 'read-only', notify, onProcessOutput: vi.fn(), processOutputPath: '/private/output',
        requestInteraction: vi.fn() } });
    expect(result.content).toContain('["fulfilled","rejected","rejected"]');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(nested?.toolPreset).toBe('read-only');
    expect(nested?.onProcessOutput).toBeUndefined();
    expect(nested?.processOutputPath).toBeUndefined();
    expect(nested?.requestInteraction).toBeUndefined();
    nested?.notify('late notification', 'warning');
    expect(notify).not.toHaveBeenCalled();
  });

  it('bounds an infinite loop and an infinite promise job chain', async () => {
    for (const code of ['while (true) {}', 'await new Promise(() => {});', 'while(true) await Promise.resolve();']) {
      const started = Date.now();
      const result = await run(code, { limits: { timeoutMs: 500 } });
      expect(result.isError).toBe(true);
      expect(Date.now() - started).toBeLessThan(2_000);
    }
  });

  it('caps VM memory/stack, source, output, input, calls and nested result sizes', async () => {
    for (const code of [
      'const a=[]; while(true) a.push("x".repeat(100000));',
      'function recurse(){return recurse()} recurse();',
      'text("x".repeat(70000));',
      'await tools.read({v:"x".repeat(70000)});',
      'await Promise.all(Array.from({length:65}, () => tools.read({})));',
      'await tools.read({});',
    ]) {
      const result = await run(code, { execute: async () => ({ content: 'x'.repeat(300_000) }), limits: { timeoutMs: 1_000 } });
      expect(result.isError).toBe(true);
      expect(result.details?.store).toBeUndefined();
    }
    await expect(run('x'.repeat(65_537))).rejects.toThrow('source limit');
    await expect(run('x'.repeat(65_537), { limits: { sourceBytes: 1_000_000 } })).rejects.toThrow('source limit');
    const fuel = await run('while (true) {}', { limits: { interrupts: 2 } });
    expect(fuel.isError).toBe(true);
    expect(fuel.content).toContain('interrupted');
  });

  it('cancels unawaited and uncooperative nested calls on success, abort and timeout', async () => {
    for (const code of ['tools.read({}); return 42;', 'await tools.read({});']) {
      let received: AbortSignal | undefined;
      const result = await run(code, { execute: (_name, _input, _context, signal) => {
        received = signal; return new Promise(() => {});
      }, limits: { timeoutMs: 500 } });
      expect(received?.aborted).toBe(true);
      expect(result.isError).toBe(code.startsWith('await'));
    }
    const controller = new AbortController();
    const promise = run('await tools.read({});', { signal: controller.signal, execute: () => new Promise(() => {}) });
    setTimeout(() => controller.abort(), 200);
    expect((await promise).content).toContain('aborted');
  });

  it('retains partial output but rolls back store on failure and redacts nested/output/store values', async () => {
    const failed = await run('store("cursor", 2); text("partial"); throw new Error("failure");');
    expect(failed.content).toContain('partial');
    expect(failed.details?.store).toBeUndefined();
    const safe = await run('const value = await tools.read({}); store("value", value); return value;', {
      execute: async () => ({ content: 'test-secret' }), redact: value => value.replaceAll('test-secret', '[redacted]'),
    });
    expect(JSON.stringify(safe)).not.toContain('test-secret');
    expect(safe.details?.store).toEqual({ value: '[redacted]' });
  });

  it('counts output separators and redaction expansion before committing store', async () => {
    const separators = await run('text(""); text(""); text("");', { limits: { outputBytes: 1 } });
    expect(separators.isError).toBe(true);
    const expanded = await run('store("cursor", 1); text("x");', {
      limits: { outputBytes: 2 }, redact: value => value.replaceAll('x', '😀😀'),
    });
    expect(expanded.isError).toBe(true);
    expect(expanded.details?.store).toBeUndefined();
    expect(expanded.content).not.toContain('�');
    const splitSecret = await run('text("test"); text("secret");', {
      redact: value => value.replaceAll('test\nsecret', '[redacted]'),
    });
    expect(splitSecret.content).toContain('[redacted]');
  });

  it('rejects key/value/aggregate and UTF-8 store overflow without publishing state', async () => {
    for (const code of [
      'for (let i=0; i<129; i++) store(String(i), i);',
      'store("large", "x".repeat(65537));',
      'for (let i=0; i<5; i++) store(String(i), "x".repeat(60000));',
      'store("unicode", "😀".repeat(20000));',
    ]) {
      const result = await run(code);
      expect(result.isError).toBe(true);
      expect(result.details?.store).toBeUndefined();
    }
  });

  it('enforces the worker quota and releases capacity after cancellation', async () => {
    const controller = new AbortController();
    const pending = Array.from({ length: 8 }, () => run('await new Promise(() => {});', {
      signal: controller.signal, limits: { timeoutMs: 5_000 },
    }));
    try {
      await expect(run('return 1;')).rejects.toThrow('capacity');
    } finally {
      controller.abort();
      await Promise.all(pending);
    }
    expect((await run('return 42;')).isError).toBe(false);
  });

  it('restores only store entries on the active branch, including empty-store deletion', () => {
    const entries = [
      { id: 'a', metadata: { codemode: { store: { cursor: 1 } } } },
      { id: 'b', parentMessageId: 'a', metadata: { codemode: { store: { cursor: 2 } } } },
      { id: 'c', parentMessageId: 'a' },
      { id: 'd', parentMessageId: 'c', metadata: { codemode: { store: {} } } },
    ];
    expect(collectCodemodeStore(entries, 'b')).toEqual({ cursor: 2 });
    expect(collectCodemodeStore(entries, 'c')).toEqual({ cursor: 1 });
    expect(collectCodemodeStore(entries, 'd')).toEqual({});
  });

  it('keeps codemode inactive by default, honors only mode and read-only policy for nested calls', async () => {
    const staticTools = [read, { ...read, name: 'write' }];
    expect(createAgentToolLoadout({ staticTools }).isCodemode('codemode')).toBe(false);
    const loadout = createAgentToolLoadout({ staticTools, selection: { preset: 'read-only' },
      codemode: { enabled: true, mode: 'only', inlineBudget: 0 } });
    expect(loadout.getTools().map(tool => tool.name)).toEqual(['codemode']);
    const result = await loadout.executeCodemode({ code: 'await tools.write({});' }, context, vi.fn());
    expect(result.isError).toBe(true);
    expect(loadout.resultMetadata('codemode', { ...result })).toBeUndefined();
    expect(loadout.resultMetadata('codemode', result)).toMatchObject({ codemode: { nestedCalls: [] } });
  });

  it('cancels before VM startup even when an indirect source ignores cancellation', async () => {
    const execute = vi.fn();
    const loadout = createAgentToolLoadout({ staticTools: [], codemode: { enabled: true }, dynamicSource: {
      directTools: [], hasPotentialSearchableTools: true, currentSearchableTools: () => [],
      waitForSearchableTools: () => new Promise(() => undefined), has: () => false,
    } });
    const controller = new AbortController();
    const running = loadout.executeCodemode({ code: 'return 1' }, context, execute, controller.signal);
    controller.abort(new Error('cancelled preparation'));
    await expect(running).rejects.toThrow('cancelled preparation');
    expect(execute).not.toHaveBeenCalled();
  });

  it('persists successful authenticated store metadata through the common tool loop', async () => {
    const manager = new SessionManager();
    const session = await manager.create();
    const registry = new ExtensionRegistry();
    const loadout = createAgentToolLoadout({ staticTools: [], codemode: { enabled: true } });
    let round = 0;
    await runToolLoop({ sessionManager: manager, sessionId: session.id, extensionRegistry: registry,
      toolContext: { sessionManager: manager, currentSessionId: session.id, notify() {} },
      resolveTools: () => loadout.getTools(),
      executeTool: (name, input, ctx, signal) => loadout.executeCodemode(input, ctx, vi.fn(), signal),
      getToolResultMetadata: (name, result) => loadout.resultMetadata(name, result),
      streamTurn: async () => round++ === 0 ? { content: '', toolCalls: [{ id: 'script', name: 'codemode', input: { code: 'store("cursor", 7); return 42;' } }] } : { content: 'done' },
    });
    expect(collectCodemodeStore(await manager.getRawEntries(session.id), manager.get(session.id)?.activeLeafId)).toEqual({ cursor: 7 });
  });
});
