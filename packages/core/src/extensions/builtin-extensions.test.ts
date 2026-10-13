import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_EXTENSION_NAMES, resolveBuiltinExtensionPolicy } from './builtin-extensions.js';
import { createAgentToolLoadout } from '../tools/tool-search.js';
import type { ExtensionRuntimeContext } from './extension-registry.js';

const all = { codemode: true, 'tool-search': true, mcp: true };
const none = { codemode: false, 'tool-search': false, mcp: false };
describe('optional built-in extension policy', () => {
  it.each([null, 1, [], { projectTrusted: 'false' }, { noExtensions: 'true' }].map(options => ({ options })))('rejects malformed policy options (%#)', ({ options }) => {
    expect(() => resolveBuiltinExtensionPolicy(options as unknown as Parameters<typeof resolveBuiltinExtensionPolicy>[0])).toThrow('policy options are invalid');
  });
  it('publishes immutable bounded capability names and copied default policy', () => {
    expect(BUILTIN_EXTENSION_NAMES).toEqual(['codemode', 'tool-search', 'mcp']);
    expect(Object.isFrozen(BUILTIN_EXTENSION_NAMES)).toBe(true);
    const policy = resolveBuiltinExtensionPolicy(); expect(policy).toEqual(all);
    expect(Reflect.set(policy, 'mcp', false)).toBe(false); expect(resolveBuiltinExtensionPolicy()).toEqual(all);
  });
  it.each([['-builtin:mcp', '+builtin:mcp'], ['+builtin:mcp', '-builtin:mcp']])('global exact removals win (%#)', (...global) => {
    expect(resolveBuiltinExtensionPolicy({ global })).toEqual({ ...all, mcp: false });
  });
  it('global exact additions override globs; plain IDs do not override exclusions', () => {
    expect(resolveBuiltinExtensionPolicy({ global: ['!builtin:*', 'builtin:mcp', '+builtin:codemode'] })).toEqual({ ...none, codemode: true });
  });
  it('last matching trusted project override wins; files never act as virtual IDs', () => {
    expect(resolveBuiltinExtensionPolicy({ global: ['!builtin:*'], projectTrusted: true,
      project: ['+builtin:mcp', '-builtin:mcp', '+builtin:mcp', '+./builtin:codemode', '+mcp', 'a/*.mjs'] })).toEqual({ ...none, mcp: true });
  });
  it('applies broad resource globs to virtual IDs without filesystem expansion', () => {
    expect(resolveBuiltinExtensionPolicy({ global: ['!*'] })).toEqual(none);
    expect(resolveBuiltinExtensionPolicy({ global: ['!**/*.mjs', '!builtin:tool-*'] })).toEqual({ ...all, 'tool-search': false });
  });
  it('never consults refused project entries', () => {
    const read = vi.fn(() => { throw new Error('refused project accessed'); });
    expect(resolveBuiltinExtensionPolicy(Object.defineProperty({ projectTrusted: false }, 'project', { get: read }))).toEqual(all);
    expect(read).not.toHaveBeenCalled();
  });
  it('disables all automatic capabilities, ignoring settings, but honors explicit built-ins', () => {
    const read = vi.fn(() => { throw new Error('suppressed settings accessed'); });
    const options = Object.defineProperties({ noExtensions: true, explicit: ['builtin:mcp', '/literal/file.mjs'] }, { global: { get: read }, project: { get: read } });
    expect(resolveBuiltinExtensionPolicy(options)).toEqual({ ...none, mcp: true }); expect(read).not.toHaveBeenCalled();
  });
  it('explicit selection wins over both settings layers, not tool activation policy', () => {
    expect(resolveBuiltinExtensionPolicy({ global: ['-builtin:mcp'], projectTrusted: true, project: ['-builtin:mcp'], explicit: ['builtin:mcp'] })).toEqual(all);
    expect(resolveBuiltinExtensionPolicy({ explicit: ['./builtin:mcp'] })).toEqual(all);
  });
  it.each(['builtin:unknown-secret', '+builtin:unknown-secret', '-builtin:unknown-secret', '!builtin:unknown-secret'])('rejects unknown exact IDs without their value (%#)', entry => {
    expect(() => resolveBuiltinExtensionPolicy({ global: [entry] })).toThrow('Unknown built-in extension.');
    expect(() => resolveBuiltinExtensionPolicy({ explicit: ['builtin:unknown-secret'] })).toThrow('Unknown built-in extension.');
  });
  it.each([[''], ['!'], ['+'], ['-'], ['a\0b'], ['a'.repeat(32769)], Array<string>(201).fill('builtin:mcp')])('rejects invalid or over-limit selectors (%#)', (...global) => {
    expect(() => resolveBuiltinExtensionPolicy({ global })).toThrow(/invalid|limit/);
  });
  it('suppresses only the hosted search tool, retaining prior eligible activation and custom replacements', async () => {
    const deferred = { name: 'docs', description: 'Search documentation', parameters: {}, exposure: 'deferred' as const, extensionId: 'test', execute: async () => ({ content: 'docs' }) };
    const disabled = createAgentToolLoadout({ staticTools: [deferred], toolSearchEnabled: false, initialLoadedTools: ['docs'] });
    expect(disabled.getTools().map(tool => tool.name)).toEqual(['docs']); expect(disabled.isToolSearch('tool_search')).toBe(false);
    await expect(disabled.executeToolSearch({ query: 'docs' }, {} as ExtensionRuntimeContext)).rejects.toThrow('not enabled');
    const enabled = createAgentToolLoadout({ staticTools: [deferred] }); expect(enabled.isToolSearch('tool_search')).toBe(true);
    const replacement = { ...deferred, name: 'tool_search', exposure: 'direct' as const };
    expect(createAgentToolLoadout({ staticTools: [replacement], toolSearchEnabled: false }).getTools()).toEqual([replacement]);
  });
});
