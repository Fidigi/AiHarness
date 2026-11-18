import { describe, expect, it } from 'vitest';
import { describeMcpConfigEntry, mcpToolExposure, type McpExposure } from './config-inventory.js';

const modes: McpExposure[] = ['direct', 'codemode', 'deferred', 'hidden'];

describe('MCP original-name exposure patterns', () => {
  it.each(modes)('applies %s through a star pattern without changing the default', mode => {
    const config = { toolExposure: { 'read_*': mode } };
    expect(mcpToolExposure(config, 'read_file')).toBe(mode);
    expect(mcpToolExposure(config, 'unmatched')).toBe('direct');
    expect(mcpToolExposure(config)).toBe('direct');
  });

  it.each(modes)('keeps exact %s ahead of every matching pattern in either key order', mode => {
    for (const toolExposure of [
      { '*': 'hidden', 'read_*': 'codemode', read_file: mode },
      { read_file: mode, 'read_*': 'codemode', '*': 'hidden' },
    ] as Record<string, McpExposure>[]) {
      expect(mcpToolExposure({ toolExposure }, 'read_file')).toBe(mode);
    }
  });

  it('uses the first matching pattern, not specificity or exposure ranking', () => {
    expect(mcpToolExposure({ toolExposure: { '*': 'hidden', 'read_*': 'direct' } }, 'read_file')).toBe('hidden');
    expect(mcpToolExposure({ toolExposure: { 'read_*': 'deferred', '*': 'direct' } }, 'read_file')).toBe('deferred');
    expect(mcpToolExposure({ toolExposure: { 'read_*': 'codemode', 'read_file*': 'direct' } }, 'read_file')).toBe('codemode');
  });

  it.each([
    ['read_*', 'read_', true], ['*', 'anything', true], ['**', 'anything', true],
    ['a*b*c', 'abc', true], ['a*b*c', 'axbyc', true], ['a*b*c', 'ab', false],
    ['a*a', 'a', false], ['a*a', 'aa', true], ['ab*ab', 'ab', false],
    ['*ab*ab', 'abab', true], ['a**b', 'ab', true], ['*a*b', 'acb', true],
    ['read_*', 'prefix_read_file', false], ['read_*', 'Read_file', false],
    ['*file', 'file_suffix', false], ['read', 'read_more', false],
    ['read?*', 'read_file', false], ['read?*', 'read?file', true],
    ['[read]*', 'read_file', false], ['[read]*', '[read]_file', true],
    ['a.b*', 'axb_file', false], ['a.b*', 'a.b_file', true],
    ['a(+)*', 'a(+)_file', true], ['a\\*', 'a\\file', true],
    ['資料*📄', '資料_é📄', true], ['é*', 'e\u0301_file', false],
    ['a*b', 'a\nb', true], ['a*b', 'a\u0000b', true],
  ] as const)('matches only literal text and star: %j / %j', (pattern, name, matches) => {
    expect(mcpToolExposure({ exposure: 'hidden', toolExposure: { [pattern]: 'deferred' } }, name))
      .toBe(matches ? 'deferred' : 'hidden');
  });

  it('does not treat the omitted tool name or an inherited entry as a match', () => {
    const toolExposure = Object.assign(Object.create({ inherited: 'direct', '*': 'direct' }), { 'read_*': 'codemode' });
    expect(mcpToolExposure({ exposure: 'hidden', toolExposure }, 'inherited')).toBe('hidden');
    expect(mcpToolExposure({ exposure: 'hidden', toolExposure })).toBe('hidden');
    expect(mcpToolExposure({ exposure: 'hidden', toolExposure }, '')).toBe('hidden');
    expect(mcpToolExposure({ exposure: 'hidden', toolExposure: { '*': 'direct' } })).toBe('hidden');
  });

  it('gives a literal star-bearing remote name its exact override first', () => {
    expect(mcpToolExposure({ toolExposure: { '*': 'hidden', 'read_*': 'direct' } }, 'read_*')).toBe('direct');
  });

  it('preserves JSON property order and inert prototype-looking own names', () => {
    const toolExposure = JSON.parse('{"*":"deferred","read_*":"direct","__proto__":"hidden","constructor":"codemode"}');
    expect(mcpToolExposure({ toolExposure }, 'read_file')).toBe('deferred');
    expect(mcpToolExposure({ toolExposure }, '__proto__')).toBe('hidden');
    expect(mcpToolExposure({ toolExposure }, 'constructor')).toBe('codemode');
    expect(Object.getPrototypeOf(toolExposure)).toBe(Object.prototype);
  });

  it('conserves the existing map limits and permits pattern keys in validated configuration', () => {
    const entry = describeMcpConfigEntry('fixture', { command: 'node', exposure: 'hidden', toolExposure: { 'read_*': 'deferred', read_file: 'direct' } });
    expect(entry.valid).toBe(true);
    expect(entry.toolExposure).toEqual({ 'read_*': 'deferred', read_file: 'direct' });
    expect(describeMcpConfigEntry('fixture', { command: 'node', toolExposure: { ['*'.repeat(257)]: 'direct' } }).valid).toBe(false);
    expect(describeMcpConfigEntry('fixture', { command: 'node', toolExposure: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`tool_${i}*`, 'hidden'])) }).valid).toBe(false);
    expect(describeMcpConfigEntry('fixture', { command: 'node', toolExposure: { '*': 'invalid' } }).valid).toBe(false);
  });

  it('handles repeated stars and failing repeated segments without regex backtracking', () => {
    const name = 'a'.repeat(500);
    expect(mcpToolExposure({ exposure: 'hidden', toolExposure: { [`${'a*'.repeat(120)}b`]: 'direct' } }, name)).toBe('hidden');
    expect(mcpToolExposure({ exposure: 'hidden', toolExposure: { [`${'*'.repeat(240)}a`]: 'deferred' } }, name)).toBe('deferred');
  });
});
