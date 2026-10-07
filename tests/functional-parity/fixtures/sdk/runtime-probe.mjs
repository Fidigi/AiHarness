import {
  AI_HARNESS_CORE_API_VERSION,
  AI_HARNESS_EXTENSION_API_VERSION,
  ExtensionRegistry,
  SESSION_SCHEMA_VERSION,
  SessionManager,
  serializeSession,
} from '@ai-harness/core';

const sessions = new SessionManager();
const session = await sessions.create({
  id: 'sdk-contract-session',
  title: 'SDK contract',
  messages: [{
    id: 'sdk-message',
    role: 'user',
    content: 'Probe',
    timestamp: new Date('2026-01-02T03:04:05.000Z'),
  }],
  activeLeafId: 'sdk-message',
  createdAt: new Date('2026-01-02T03:04:05.000Z'),
  updatedAt: new Date('2026-01-02T03:04:06.000Z'),
});

const registry = new ExtensionRegistry();
let factoryVersion;
await registry.load('sdk-probe', api => {
  factoryVersion = api.version;
  api.registerCommand('sdk_echo', {
    description: 'SDK probe command',
    handler: args => `echo:${args}`,
  });
  api.registerTool({
    name: 'sdk_sum',
    description: 'SDK probe tool',
    execute: input => ({ content: String(input.left + input.right), details: { kind: 'sum' } }),
  });
  api.before('before:agent', data => ({ input: data.input.toUpperCase() }));
});

const context = { sessionManager: sessions, notify() {} };
const command = await registry.getCommand('sdk_echo').handler('value', context);
const tool = await registry.executeTool('sdk_sum', { left: 2, right: 3 }, context);
const hook = await registry.runBefore('before:agent', {
  sessionId: session.id,
  provider: 'mock',
  input: 'lowercase',
});

console.log(JSON.stringify({
  versions: {
    core: AI_HARNESS_CORE_API_VERSION,
    extension: AI_HARNESS_EXTENSION_API_VERSION,
    factory: factoryVersion,
    session: SESSION_SCHEMA_VERSION,
  },
  command,
  tool,
  hook,
  registry: registry.list(),
  session: serializeSession(session),
}));

await registry.shutdown();
