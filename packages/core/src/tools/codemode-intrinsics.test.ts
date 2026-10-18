import { describe, expect, it, vi } from 'vitest';
import type { ExtensionRuntimeContext } from '../extensions/extension-registry.js';

const observed = vi.hoisted(() => ({ live: new Set<object>(), peak: 0, created: 0, exited: 0 }));
vi.mock('node:worker_threads', async importActual => {
  const actual = await importActual<typeof import('node:worker_threads')>();
  return { ...actual, Worker: class extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args); observed.created++; observed.live.add(this); observed.peak = Math.max(observed.peak, observed.live.size);
      this.once('exit', () => { observed.live.delete(this); observed.exited++; });
    }
  } };
});
import { runCodemode } from './codemode.js';
import { createAgentToolLoadout } from './tool-search.js';

const context = {} as ExtensionRuntimeContext;
const tool = { name: 'read', description: 'Read an exact path', extensionId: 'fixture', parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } }, additionalProperties: false } };
function run(code: string, extra: Partial<Parameters<typeof runCodemode>[0]> = {}) {
  return runCodemode({ code, context, tools: () => [tool], execute: async () => ({ content: 'document' }), ...extra });
}
describe('A3-CLI-05 guest bootstrap and actual worker lifetimes', () => {
  it.each(['Object', 'Array', 'Function', 'Promise', 'String', 'Number', 'Boolean', 'BigInt', 'Symbol', 'RegExp', 'Date', 'Error', 'InternalError', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'ArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'JSON', 'Math', 'Reflect'])(
    'freezes %s and its prototype before guest execution', async name => {
      const result = await run(`const value = globalThis[${JSON.stringify(name)}]; return [Object.isFrozen(value), !value.prototype || Object.isFrozen(value.prototype)];`);
      expect(result.isError).toBe(false); expect(result.content).toMatch(/\n\[true,true\]$/);
      expect(observed.live.size).toBe(0);
    });
  it('cannot pollute guest prototypes or replace builtin methods used by the bridge', async () => {
    const execute = vi.fn(async (_name: string, _input: unknown) => ({ content: 'document' }));
    const result = await run(`
      if (Reflect.set(Object.prototype, 'toJSON', () => ({forged: true}))) throw new Error('prototype mutable');
      if (Reflect.set(JSON, 'stringify', () => '{"path":"forged"}')) throw new Error('JSON mutable');
      if (Reflect.set(Promise.prototype, 'then', () => null)) throw new Error('Promise mutable');
      return await tools.read({path:'requested'});
    `, { execute });
    expect(result.isError).toBe(false); expect(result.content).toMatch(/\ndocument$/);
    expect(execute.mock.calls).toHaveLength(1); expect(execute.mock.calls[0]?.[1]).toEqual({ path: 'requested' });
  });
  it('retains bridge serialization when a script replaces its own global JSON binding', async () => {
    const execute = vi.fn(async (_name: string, _input: unknown) => ({ content: 'document' }));
    const result = await run(`globalThis.JSON = {stringify: () => '{"path":"forged"}', parse: () => 'forged result'}; return await tools.read({path:'requested'});`, { execute });
    expect(result.isError).toBe(false); expect(result.content).toMatch(/\ndocument$/);
    expect(execute.mock.calls[0]?.[1]).toEqual({ path: 'requested' });
  });
  it('retains a native guest Error and message when a script shadows its Error global', async () => {
    const execute = vi.fn(async () => { throw new Error('Controlled nested failure.'); });
    const result = await run(`const OriginalError=Error; globalThis.Error=function(){throw 'forged'};
      try { await tools.read({path:'requested'}); } catch(error) { return [error instanceof OriginalError,error.name,error.message]; }`, {execute});
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/\n\[true,"Error","Controlled nested failure\."\]$/);
    expect(execute).toHaveBeenCalledTimes(1); expect(observed.live.size).toBe(0);
  });
  it.each([
    ['text("x".repeat(66000));', 'Script output limit exceeded.'],
    ['await tools.read({path:"x".repeat(66000)});', 'Nested input limit exceeded.'],
    ['for(let i=0;i<65;i++) await describeTool("read");', 'Nested call limit exceeded.'],
  ])('retains host-callback errors after intrinsic freezing: %s', async (code, message) => {
    const execute = vi.fn();
    const result = await run(code!, {execute});
    expect(result.isError).toBe(true); expect(result.content).toContain('Script error: '+message);
    expect(execute).not.toHaveBeenCalled(); expect(observed.live.size).toBe(0);
  });
  it('counts physical worker creation through exit during repeated abort storms', async () => {
    observed.peak = 0; const before = observed.created;
    for (let round = 0; round < 12; round++) {
      const controller = new AbortController();
      const work = Array.from({ length: 8 }, () => run('await new Promise(() => {});', { signal: controller.signal }));
      await expect(run('return 1')).rejects.toThrow('capacity');
      controller.abort();
      await Promise.all(work);
      expect(observed.live.size).toBe(0);
    }
    expect(observed.created - before).toBe(96); expect(observed.peak).toBe(8);
    expect(observed.exited).toBe(observed.created);
    expect((await run('return 42')).content).toMatch(/\n42$/); expect(observed.live.size).toBe(0);
  }, 10_000);
  it('retains physical admission through repeated eight-worker deadline storms', async () => {
    observed.peak = 0; const before = observed.created;
    for (let round = 0; round < 3; round++) {
      const work = Array.from({ length: 8 }, () => run('/(a+)+$/.test("a".repeat(10000)+"!")', { limits: { timeoutMs: 200 } }));
      await expect(run('return 1')).rejects.toThrow('capacity');
      const results = await Promise.all(work);
      expect(results.every(result => result.isError && result.content.includes('Codemode deadline exceeded.'))).toBe(true);
      expect(observed.live.size).toBe(0);
    }
    expect(observed.created - before).toBe(24); expect(observed.peak).toBe(8);
    expect(observed.exited).toBe(observed.created);
    expect((await run('return 42')).isError).toBe(false); expect(observed.live.size).toBe(0);
  }, 10_000);
  it.each(['while(true) {}', 'while(true) await Promise.resolve()', 'text("x".repeat(50000000))', '/(a+)+$/.test("a".repeat(10000)+"!")'])(
    'leaves no actual worker after deadline or non-interruptible computation: %s', async code => {
      const result = await run(code, { limits: { timeoutMs: 200 } });
      expect(result.isError).toBe(true); expect(observed.live.size).toBe(0);
      expect((await run('return 42')).isError).toBe(false); expect(observed.live.size).toBe(0);
    });
  it('freezes generator/async and iterator prototypes, not only named globals', async () => {
    const result = await run(`return [
      Object.getPrototypeOf(async function(){}), Object.getPrototypeOf(function*(){}), Object.getPrototypeOf(async function*(){}),
      Object.getPrototypeOf([][Symbol.iterator]()), Object.getPrototypeOf(''[Symbol.iterator]()),
      Object.getPrototypeOf(new Map().entries()), Object.getPrototypeOf(new Set().values()), Object.getPrototypeOf(''.matchAll(/x/g))
    ].every(value => Object.isFrozen(value) && Object.isFrozen(Object.getPrototypeOf(value)));`);
    expect(result.isError).toBe(false); expect(result.content).toMatch(/\ntrue$/); expect(observed.live.size).toBe(0);
  });
  it.each([null, [], { code: 42 }, { code: 'return 1', timeoutMs: 1 }, { code: 'return 1', limits: {} },
    { code: 'return 1', options: {} }, { code: 'return 1', tools: [] }].map(input => [input]))('rejects malformed/misplaced hosted options before worker creation: %j', async input => {
    const loadout = createAgentToolLoadout({ staticTools: [tool], codemode: { enabled: true } });
    const before = observed.created, execute = vi.fn();
    await expect(loadout.executeCodemode(input, context, execute)).rejects.toThrow('Invalid or disabled codemode input.');
    expect(observed.created).toBe(before); expect(observed.live.size).toBe(0); expect(execute).not.toHaveBeenCalled();
  });
  it('makes the exact schema constraints visible inline and through describeTool', async () => {
    const loadout = createAgentToolLoadout({ staticTools: [tool], codemode: { enabled: true } });
    expect(loadout.getTools().find(item => item.name === 'codemode')?.description).toContain(JSON.stringify(tool.parameters));
    const result = await run('return (await describeTool("read")).parameters;');
    expect(result.isError).toBe(false); expect(result.content.split('\n').slice(1).join('\n')).toBe(JSON.stringify(tool.parameters));
    expect(observed.live.size).toBe(0);
  });
  it('assembles bounded output once and retains guest schema constraints', async () => {
    const redact = vi.fn((value: string) => value);
    const result = await run('text((await describeTool("read")).parameters); for(let i=0;i<900;i++) text("snow 雪");', { redact });
    expect(result.isError).toBe(false); expect(result.content).toContain('"additionalProperties":false');
    expect(result.content.split('\n').slice(2)).toHaveLength(900);
    const complete = redact.mock.calls.filter(([value]) => value.includes('snow 雪'));
    expect(complete).toHaveLength(1); expect(complete[0]?.[0].split('\n')).toHaveLength(901);
    expect(observed.live.size).toBe(0);
  });
});
