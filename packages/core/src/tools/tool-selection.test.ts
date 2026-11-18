import { describe, expect, it } from 'vitest';
import {
  selectRegisteredTools,
  toChatToolDefinitions,
  unknownToolNames,
  type RegisteredAgentTool,
} from './tool-selection.js';

const tools: RegisteredAgentTool[] = [
  { name: 'read', description: 'Read', extensionId: 'builtin:workspace-tools' },
  { name: 'bash', description: 'Shell', extensionId: 'builtin:workspace-tools' },
  { name: 'edit', description: 'Edit', extensionId: 'builtin:workspace-tools' },
  { name: 'write', description: 'Write', extensionId: 'builtin:workspace-tools' },
  { name: 'grep', description: 'Search', extensionId: 'builtin:workspace-tools' },
  { name: 'extension_tool', description: 'Extension', extensionId: 'extension:one' },
  { name: 'server_tool', description: 'Server', extensionId: 'server:internal' },
];

const selectedNames = (options: Parameters<typeof selectRegisteredTools>[1]): string[] =>
  selectRegisteredTools(tools, options).map(tool => tool.name);

describe('shared tool selection', () => {
  it('applies coding-tool defaults while retaining extension tools', () => {
    expect(selectedNames({
      defaultTools: ['read', 'bash', 'edit', 'write'],
      builtInExtensionId: 'builtin:workspace-tools',
      includeNonBuiltInByDefault: true,
    })).toEqual(['read', 'bash', 'edit', 'write', 'extension_tool', 'server_tool']);
  });

  it('lets an explicit allowlist replace defaults before applying exclusions', () => {
    expect(selectedNames({
      allowedTools: ['grep', 'extension_tool'],
      excludedTools: ['extension_tool'],
      defaultTools: ['read'],
      noTools: true,
      noBuiltInTools: true,
      builtInExtensionId: 'builtin:workspace-tools',
    })).toEqual(['grep']);
  });

  it('supports no-tools, no-builtins, and shared runtime presets', () => {
    expect(selectedNames({ noTools: true })).toEqual([]);
    expect(selectedNames({
      noBuiltInTools: true,
      builtInExtensionId: 'builtin:workspace-tools',
      includeNonBuiltInByDefault: true,
    })).toEqual(['extension_tool', 'server_tool']);
    expect(selectedNames({ preset: 'chat-only' })).toEqual([]);
    expect(selectedNames({ preset: 'read-only' })).toEqual(['read', 'grep']);
  });

  it('keeps platform-owned tools while restricting third-party extensions', () => {
    expect(selectedNames({ allowedExtensions: [] })).toEqual([
      'read', 'bash', 'edit', 'write', 'grep', 'server_tool',
    ]);
    expect(selectedNames({ allowedExtensions: ['extension:one'] })).toHaveLength(tools.length);
  });

  it('reports unknown requested names and builds provider definitions', () => {
    expect(unknownToolNames(tools, ['READ', 'missing'], ['other', 'missing']))
      .toEqual(['missing', 'other']);
    expect(toChatToolDefinitions([tools[0]])).toEqual([{
      name: 'read', description: 'Read', parameters: { type: 'object', properties: {} },
    }]);
  });
});
