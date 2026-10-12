/** High-level AiHarness SDK, additive to Core API major 1. */
export { createAgentSession } from './agent-session.js';
export { createAgentResourceLoader } from './resource-loader.js';
export type {
  AgentResourceContext,
  AgentResourceLoader,
  AgentResourceLoaderOptions,
  LoadedAgentResources,
} from './resource-loader.js';
export type { SessionStore } from './session-store.js';
export type {
  AgentAuthDescriptor,
  AgentAuthOptions,
  AgentBuiltinProvider,
  AgentCompactionDetails,
  AgentCompactionTarget,
  AgentCredential,
  AgentModel,
  AgentPromptOptions,
  AgentProvider,
  AgentProviderConfig,
  AgentSession,
  AgentSessionCapabilities,
  AgentSessionOwnership,
  CreateAgentSessionOptions,
} from './types.js';
// Reuse the existing Date/wire conversion; do not invent another message schema.
export { serializeSession, deserializeSession } from '../sessions/serialization.js';
export type { SerializedMessage, SerializedSession } from '../sessions/serialization.js';
