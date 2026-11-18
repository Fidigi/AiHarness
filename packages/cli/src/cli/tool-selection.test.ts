import { describe, expect, it } from 'vitest';
import { createAgentToolLoadout, selectRegisteredTools, type RegisteredAgentTool } from '@ai-harness/core';
import { parseCliArguments, CliArgumentError } from './args.js';
import { cliToolsDisabled, cliToolSelectionOptions, unknownCliToolNames, type CliToolSelection } from './tool-selection.js';

const tools: RegisteredAgentTool[] = ['read', 'bash', 'edit', 'write', 'grep', 'ls'].map(name => ({
  name, description: name, extensionId: 'builtin:workspace-tools',
})).concat([
  { name: 'mcp__ordinary', description: 'Ordinary extension', extensionId: 'extension:fixture' },
  { name: 'read[docs]', description: 'Literal punctuation', extensionId: 'extension:fixture' },
]);
const defaults: CliToolSelection = { defaultTools: ['read', 'bash', 'edit', 'write'],
  builtInExtensionId: 'builtin:workspace-tools', includeNonBuiltInByDefault: true };
const selected = (options: CliToolSelection) => selectRegisteredTools(tools,
  cliToolSelectionOptions(() => tools, { ...defaults, ...options })).map(tool => tool.name);

describe('CLI-only concrete tool selection', () => {
  it('replaces with star patterns and applies exclusions last without regex syntax or prefix denial', () => {
    expect(selected({ tools: ['r*', 'mcp__*'], excludeTools: ['*ordinary', '*[docs]'] })).toEqual(['read']);
    expect(selected({ tools: ['read[docs]'] })).toEqual(['read[docs]']);
    expect(selected({ tools: ['r?ad'] })).toEqual([]);
    expect(selected({ tools: ['r**d', 'no-match*'] })).toEqual(['read']);
    expect(selected({ tools: ['*'], excludeTools: ['*'] })).toEqual([]);
    expect(selected({ tools: ['mcp__ordinary'] })).toEqual(['mcp__ordinary']);
    expect(selectRegisteredTools(tools, { allowedTools: ['read*'] })).toEqual([]);
  });

  it('adjusts configured defaults and extension defaults in order, preserving repeated removals', () => {
    const parsed = parseCliArguments(['--tools', '+grep,-read,+read,-read', '--exclude-tools', 'g*']);
    expect(parsed.tools).toEqual(['+grep', '-read', '+read', '-read']);
    expect(selected(parsed)).toEqual(['bash', 'edit', 'write', 'mcp__ordinary', 'read[docs]']);
    expect(selected({ tools: ['+read'], defaultTools: ['ls'] })).toEqual(['read', 'ls', 'mcp__ordinary', 'read[docs]']);
    expect(selected({ tools: ['read'] })).toEqual(['read']);
    expect(selected({ tools: ['+read'], excludeTools: ['read'] })).not.toContain('read');
  });

  it('retains no-tools/no-builtins bases, explicit additions and preset refusal', () => {
    expect(selected({ tools: ['+grep'], noTools: true })).toEqual(['grep']);
    expect(selected({ tools: ['-read'], noTools: true })).toEqual([]);
    expect(selected({ tools: ['+read'], noBuiltInTools: true })).toEqual(['read', 'mcp__ordinary', 'read[docs]']);
    expect(selected({ tools: ['+bash'], preset: 'read-only' })).toEqual(['read']);
    expect(selected({ tools: ['*'], preset: 'chat-only' })).toEqual([]);
    expect(cliToolsDisabled({ tools: ['-read'], noTools: true })).toBe(true);
    expect(cliToolsDisabled({ tools: ['+read'], noTools: true })).toBe(false);
  });

  it('rejects malformed actual lists while preserving negative values and definitive contributed arity', () => {
    for (const value of ['read,+grep', '+r*', '-r*', '+', '-']) {
      expect(() => parseCliArguments([`--tools=${value}`])).toThrow(CliArgumentError);
    }
    expect(parseCliArguments(['--tools', '-read,+grep']).tools).toEqual(['-read', '+grep']);
    expect(() => parseCliArguments(['--tools', '--provider'])).toThrow(/requires a value/);
    expect(() => parseCliArguments(['--exclude-tools=+read'])).toThrow(CliArgumentError);
    const metadata = [{ name: 'review-check', extensionId: 'review', type: 'boolean' as const, description: 'Check', default: false }];
    const prompt = ['--review-check', 'hello', '--tools', 'read,+grep'];
    expect(parseCliArguments(prompt, [], true).deferredOptions).toEqual(['--review-check']);
    expect(parseCliArguments(prompt, metadata).messages).toEqual(['hello', '--tools', 'read,+grep']);
    expect(() => parseCliArguments(['--review-check', '--tools', 'read,+grep'], metadata)).toThrow(CliArgumentError);
    expect(unknownCliToolNames(tools, { tools: ['+missing', '-read', '+mcp__later__lookup'], excludeTools: ['missing*'] })).toEqual(['missing']);
  });

  it('re-expands exact lists after lazy metadata publication without changing Core matching', () => {
    let available = [...tools];
    const options = cliToolSelectionOptions(() => available, { ...defaults, tools: ['mcp__*'], excludeTools: ['*mutate'] });
    const dynamic = (name: string): RegisteredAgentTool => ({ name, description: name, extensionId: 'builtin:mcp', exposure: 'deferred' });
    available.push(dynamic('mcp__docs__lookup'), dynamic('mcp__docs__mutate'));
    expect(selectRegisteredTools(available, options).map(tool => tool.name)).toEqual(['mcp__ordinary', 'mcp__docs__lookup']);
    available = tools;
    expect(selectRegisteredTools(available, options).map(tool => tool.name)).toEqual(['mcp__ordinary']);
  });

  it('does not activate the optional code helper accidentally when adjusting ordinary defaults', () => {
    const ordinary = cliToolSelectionOptions(() => tools, { ...defaults, tools: ['+grep'] });
    expect(createAgentToolLoadout({ staticTools: tools, selection: ordinary }).isCodemode('codemode')).toBe(false);
    const deferred: RegisteredAgentTool = { name: 'docs', description: 'Docs', extensionId: 'extension:docs', exposure: 'deferred' };
    const available = [...tools, deferred];
    const options = cliToolSelectionOptions(() => available, { ...defaults, tools: ['+grep'], codemodeConfigured: true });
    expect(createAgentToolLoadout({ staticTools: available, selection: options, codemode: { mode: 'on' } }).isCodemode('codemode')).toBe(true);
    const denied = cliToolSelectionOptions(() => available, { ...defaults, tools: ['+grep'], codemodeConfigured: true, noBuiltInTools: true });
    expect(createAgentToolLoadout({ staticTools: available, selection: denied, codemode: { mode: 'on' } }).isCodemode('codemode')).toBe(false);
  });
});
