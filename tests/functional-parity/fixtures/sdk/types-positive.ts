import {
  AI_HARNESS_CORE_API_VERSION,
  AI_HARNESS_EXTENSION_API_VERSION,
  ExtensionRegistry,
  SessionManager,
  type ExtensionFactory,
  type ExtensionRuntimeContext,
  type Session,
} from '@ai-harness/core';

const coreVersion: 1 = AI_HARNESS_CORE_API_VERSION;
const extensionVersion: 1 = AI_HARNESS_EXTENSION_API_VERSION;
const manager = new SessionManager();
const context: ExtensionRuntimeContext = {
  sessionManager: manager,
  notify(_message, _level) {},
};
const factory: ExtensionFactory = api => {
  const apiVersion: 1 = api.version;
  api.registerCommand('typed_probe', {
    description: 'Typed probe',
    handler: (_args, runtime): string => runtime.currentSessionId ?? 'none',
  });
  void apiVersion;
};
const registry = new ExtensionRegistry();
const session: Session = {
  id: 'typed-session',
  messages: [],
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

void [coreVersion, extensionVersion, context, factory, registry, session];
