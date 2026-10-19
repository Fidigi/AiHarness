import { describe, expect, it } from 'vitest';
import type { ResolvedAgentSettings } from '@ai-harness/core';
import { parseCliArguments, formatCliHelp, completeCliOptions } from './args.js';
import { configuredBuiltinExtensions } from '../extensions/extension-loader.js';

const settings = {
  globalSettings: { extensions: ['-builtin:codemode', '-builtin:tool-search', '-builtin:mcp'] },
  projectSettings: { extensions: ['+builtin:codemode', '+builtin:tool-search', '+builtin:mcp'] },
  projectTrusted: true,
} as ResolvedAgentSettings;

describe('native CLI-only MCP hosting suppression', () => {
  it('keeps the ordinary parser shape and positional option boundary unchanged', () => {
    expect(Object.hasOwn(parseCliArguments([]), 'noMcp')).toBe(false);
    const parsed = parseCliArguments(['Hello', '--no-mcp']);
    expect(Object.hasOwn(parsed, 'noMcp')).toBe(false);
    expect(parsed.messages).toEqual(['Hello', '--no-mcp']);
    expect(parseCliArguments(['--', '--no-mcp']).messages).toEqual(['--no-mcp']);
  });
  it('is an idempotent valueless native flag, independent of tools and extension discovery', () => {
    expect(parseCliArguments(['--no-mcp', '--no-mcp', '--tools', 'read', '-e', 'builtin:mcp', 'Hello']))
      .toMatchObject({ noMcp: true, tools: ['read'], extensions: ['builtin:mcp'], messages: ['Hello'] });
  });
  it.each(['true', 'false', '0', ''])('refuses an inline value%s before startup', value => {
    expect(() => parseCliArguments([`--no-mcp=${value}`])).toThrow('--no-mcp does not accept a value.');
  });
  it('belongs before unknown-arity extension flags in the bootstrap admission pass', () => {
    expect(parseCliArguments(['--no-mcp', '--fixture-option'], [], true)).toMatchObject({ noMcp: true, deferredOptions: ['--fixture-option'] });
    expect(() => parseCliArguments(['--fixture-option', '--no-mcp'], [], true))
      .toThrow('Extension loading and trust options must precede extension-contributed options.');
  });
  it('is passive native help/completion metadata', () => {
    expect(formatCliHelp()).toContain('--no-mcp');
    expect(completeCliOptions('--no-mc', [])).toEqual(['--no-mcp']);
  });
  it.each([false, true])('wins after trusted settings and explicit built-in activation (no-extensions=%s)', noExtensions => {
    const policy = configuredBuiltinExtensions(settings, {
      noExtensions, noMcp: true, extensions: ['builtin:codemode', 'builtin:tool-search', 'builtin:mcp'],
    });
    expect(policy).toEqual({ codemode: true, 'tool-search': true, mcp: false });
    expect(Object.isFrozen(policy)).toBe(true);
  });
  it('keeps native policy unchanged without the flag', () => {
    expect(configuredBuiltinExtensions(settings, {})).toEqual({ codemode: true, 'tool-search': true, mcp: true });
    expect(configuredBuiltinExtensions(settings, { noExtensions: true })).toEqual({ codemode: false, 'tool-search': false, mcp: false });
  });
});
