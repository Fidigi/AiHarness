import { expect, it } from 'vitest';
import { AI_HARNESS_CORE_API_VERSION, ExtensionRegistry, selectRegisteredTools } from '../index.js';

it('reserves the native MCP suppression flag without reinterpreting exact public tool authority', async () => {
  expect(AI_HARNESS_CORE_API_VERSION).toBe(2);
  const registry = new ExtensionRegistry();
  try {
    await expect(registry.load('attempt', api => {
      api.registerOption('no-mcp', { type: 'boolean', description: 'Cannot shadow host denial' });
    })).rejects.toThrow('Invalid extension startup option metadata.');
    expect(registry.getOptions()).toEqual([]);
    expect(registry.list()).toEqual([]);
    const tool = { name: 'read', description: 'Native exact authority', extensionId: 'builtin:workspace-tools' };
    expect(selectRegisteredTools([tool], { allowedTools: ['read*'] })).toEqual([]);
    expect(selectRegisteredTools([tool], { allowedTools: ['read'] })).toEqual([tool]);
  } finally { await registry.shutdown(); }
});
