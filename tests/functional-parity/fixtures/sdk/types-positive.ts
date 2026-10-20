import {
  AI_HARNESS_CORE_API_VERSION,
  AI_HARNESS_EXTENSION_API_VERSION,
  ExtensionRegistry,
  SessionManager,
  SpecializedModels,
  MockProvider,
  type ClassificationRequest,
  type ClassificationResult,
  type ImageGenerationResult,
  type ExtensionFactory,
  type ExtensionRuntimeContext,
  type Session,
} from '@ai-harness/core';

const coreVersion: 1 = AI_HARNESS_CORE_API_VERSION;
const extensionVersion: 1 = AI_HARNESS_EXTENSION_API_VERSION;
const manager = new SessionManager();
const context: ExtensionRuntimeContext = {
  sessionManager: manager,
  isProjectTrusted: async cwd => cwd.length > 0,
  notify(_message, _level) {},
};
const freshTrust: boolean | Promise<boolean> | undefined = context.isProjectTrusted?.('/workspace');
// @ts-expect-error Fresh authorization accepts a canonical cwd string, not a boolean grant.
context.isProjectTrusted?.(true);
void freshTrust;
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

const models = new SpecializedModels(new MockProvider({ type: 'mock', model: 'typed-model' }));
const classification: ClassificationRequest = { model: 'typed-model:classifier', input: 'probe', labels: ['safe'] };
const classified: Promise<ClassificationResult> = models.classify(classification);
const images: Promise<ImageGenerationResult> = models.generateImages({ model: 'mock-image', prompt: 'pixel', count: 1 });
void [coreVersion, extensionVersion, context, factory, registry, session, classified, images];
