import { AgentRuntime } from '../agent/runtime.js';
import { AGENT_EVENT_PROTOCOL_VERSION, type AgentRunSnapshot } from '../agent/events.js';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import { CredentialRedactor } from '../providers/credentials.js';
import { ProviderFactory, type AiProvider } from '../providers/index.js';
import { closeProviderNetworkDispatchers, createProviderNetworkScope, PROVIDER_NETWORK_SCOPE } from '../providers/provider-network.js';
import { AI_HARNESS_CORE_API_VERSION } from '../public-api-version.js';
import { WorkspaceManager } from '../security/workspace-manager.js';
import { SessionManager } from '../sessions/session-manager.js';
import { serializeSession } from '../sessions/serialization.js';
import type { Session } from '../types/index.js';
import type { LoadedAgentResources } from './resource-loader.js';
import { SessionStoreAdapter } from './session-store.js';
import type {
  AgentSession, AgentSessionCapabilities, AgentSessionOwnership, CreateAgentSessionOptions,
} from './types.js';

const BUILTINS = new Set(['openai', 'anthropic', 'google', 'azure', 'vertex', 'bedrock', 'local', 'mock']);
const terminal = (run: AgentRunSnapshot): boolean => ['completed', 'failed', 'stopped'].includes(run.phase);

/** Compose Core API v1 primitives. Never loads executable resources or discovers models. */
export async function createAgentSession(options: CreateAgentSessionOptions): Promise<AgentSession> {
  // Capture value options and borrowed identities before the first await. A caller
  // must not be able to change the group's ownership or accepted configuration.
  options = {
    ...options,
    allowedRoots: options.allowedRoots ? [...options.allowedRoots] : undefined,
    provider: options.provider.kind === 'config'
      ? { kind: 'config', config: structuredClone(options.provider.config) }
      : { ...options.provider },
    auth: options.auth ? { ...options.auth, secrets: options.auth.secrets ? [...options.auth.secrets] : undefined } : undefined,
    session: options.session ? structuredClone(options.session) : undefined,
    runDefaults: options.runDefaults ? structuredClone(options.runDefaults) : undefined,
    compaction: options.compaction ? {
      ...options.compaction,
      settings: options.compaction.settings ? structuredClone(options.compaction.settings) : undefined,
    } : undefined,
  };
  const workspace = new WorkspaceManager({ defaultCwd: options.cwd, allowedRoots: options.allowedRoots });
  await workspace.initialize();
  const cwd = await workspace.getDefaultCwd();
  const redactor = options.auth?.redactor ?? new CredentialRedactor();
  redactor.addAll(options.auth?.secrets ?? []);
  // Registration only: no environment credential resolution/commands/store access.
  // Existing cloud providers may use ambient credentials when explicitly prompted.
  redactor.addEnvironment(process.env);
  const scope = createProviderNetworkScope();
  let provider: AiProvider | undefined;
  let providerName: string;
  // Snapshot configs without constructing a provider (cloud adapters may initialize SDKs).
  const binding = options.provider;
  const config = binding.kind === 'config' ? binding.config : undefined;
  if (config) {
    if (!BUILTINS.has(config.type)) throw new Error('SDK config requires a built-in provider. Supply an instance for custom providers.');
    providerName = config.type;
    redactor.add(config.apiKey);
    redactor.addEnvironment({
      AWS_ACCESS_KEY_ID: typeof config.accessKeyId === 'string' ? config.accessKeyId : undefined,
      AWS_SECRET_ACCESS_KEY: typeof config.secretAccessKey === 'string' ? config.secretAccessKey : undefined,
      AWS_SESSION_TOKEN: typeof config.sessionToken === 'string' ? config.sessionToken : undefined,
    });
    if (typeof config.httpProxy === 'string') redactor.addEnvironment({ HTTP_PROXY: config.httpProxy });
    if (config.headers && typeof config.headers === 'object') {
      redactor.addAll(Object.values(config.headers).filter((value): value is string => typeof value === 'string'));
    }
  } else if (binding.kind === 'instance') {
    providerName = binding.name;
    if (!providerName.trim()) throw new Error('Provider name is required.');
    provider = binding.provider;
  } else {
    throw new Error('Invalid provider binding.');
  }
  const safe = <T>(value: T): T => redactor.redactJson(structuredClone(value));
  const manager = new SessionManager({
    ...(options.store ? { store: new SessionStoreAdapter(options.store) } : {}),
    redactText: value => redactor.redact(value),
    redactJson: value => redactor.redactJson(value),
  });
  if (options.compaction?.settings) manager.setCompactionSettings(options.compaction.settings);
  const summarize = options.compaction?.summarize;
  if (summarize) manager.setAutoCompactionCallback(async (...args) => {
    const result = await summarize(args[0], safe(args[1]), safe(args[2]), args[3]);
    if (args[3]?.aborted) throw new DOMException('Compaction cancelled', 'AbortError');
    return safe(result);
  });
  const policy = options.compaction?.policy;
  if (policy) manager.setAutoCompactionPolicy(session => policy(safe(session)));
  const registry = options.extensionRegistry ?? new ExtensionRegistry();
  const trust = options.isProjectTrusted ?? (() => false);
  const onUsage = options.onUsage;
  const runtime = new AgentRuntime({
    sessionManager: manager,
    extensionRegistry: registry,
    isProjectTrusted: async candidate => trust(await workspace.resolve(candidate, { kind: 'directory' })),
    resolveProvider: name => {
      // Hook-based switches cannot silently activate another provider.
      if (name !== providerName) return undefined;
      if (!provider && config) provider = ProviderFactory.create({ ...config, [PROVIDER_NETWORK_SCOPE]: scope });
      return provider;
    },
    onUsage: onUsage ? (name, model, usage) => onUsage(
      redactor.redact(name), model === undefined ? undefined : redactor.redact(model), safe(usage),
    ) : undefined,
    redactText: value => redactor.redact(value),
    redactJson: value => redactor.redactJson(value),
    createTextRedactor: () => redactor.createStream(),
  });
  // Reuse Core's existing compaction lifecycle and event protocol.
  manager.on('compaction:start', event => { runtime.publishSessionEvent(event.sessionId, 'compaction.started', event); });
  manager.on('compaction:end', event => { runtime.publishSessionEvent(event.sessionId, 'compaction.completed', event); });
  manager.on('compaction:error', event => { runtime.publishSessionEvent(event.sessionId, 'compaction.failed', event); });
  const defaults = structuredClone(options.runDefaults ?? {});
  const capabilities: Readonly<AgentSessionCapabilities> = Object.freeze({
    coreApiVersion: AI_HARNESS_CORE_API_VERSION,
    persistence: options.store ? 'caller-store' : 'memory',
    conversation: true,
    eventProtocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
    stop: 'acknowledge-then-wait', history: 'active-and-raw', fork: 'copy-user-entry',
    branch: 'before-user-entry', clone: 'active-projection', compaction: 'caller-summary',
    automaticCompaction: Boolean(options.compaction?.summarize),
    resources: options.resourceLoader ? 'explicit-loader' : 'none',
    executableLoading: false, modelDiscovery: false, oauthLogin: false, mcpHosting: false,
  });
  const ownership: Readonly<AgentSessionOwnership> = Object.freeze({
    runtime: 'sdk', manager: 'sdk', provider: config ? 'sdk' : 'caller',
    store: options.store ? 'caller' : 'none', registry: options.extensionRegistry ? 'caller' : 'sdk',
    resourceLoader: options.resourceLoader ? 'caller' : 'none', cleanup: 'last-handle',
  });
  let handles = 0;
  const safeError = (value: unknown): Error => {
    const error = new Error(redactor.redact(value instanceof Error ? value.message : 'SDK operation failed.'));
    if (value instanceof Error) {
      error.name = value.name;
      const details = value as Error & { code?: unknown; status?: unknown };
      if (typeof details.code === 'string') Object.assign(error, { code: redactor.redact(details.code) });
      if (typeof details.status === 'number') Object.assign(error, { status: details.status });
    }
    return error;
  };

  function handle(sessionId: string): AgentSession {
    handles++;
    let disposed = false;
    let disposal: Promise<void> | undefined;
    let tail: Promise<unknown> = Promise.resolve();
    let settlement: Promise<AgentRunSnapshot | undefined> | undefined;
    let busy = false;
    let loaded: LoadedAgentResources | undefined;
    const subscriptions = new Set<() => void>();
    const open = (): void => { if (disposed) throw new Error('Agent session is disposed.'); };
    const idle = (): void => { if (busy) throw new Error('Agent session is busy; await wait() before changing history/settings.'); };
    const current = (): Session => {
      open();
      const session = manager.get(sessionId);
      if (!session) throw new Error('Session not found.');
      return session;
    };
    const serial = <T>(operation: () => Promise<T>): Promise<T> => {
      open();
      const next = tail.catch(() => undefined).then(operation).catch(error => { throw safeError(error); });
      tail = next;
      return next;
    };
    const serialInput = <A, T>(input: A, operation: (snapshot: A) => Promise<T>): Promise<T> => {
      open();
      const snapshot = structuredClone(input);
      return serial(() => operation(snapshot));
    };
    const active = (): AgentRunSnapshot => {
      open();
      const run = runtime.getSessionRun(sessionId);
      if (!run || terminal(run)) throw new Error('No active agent run.');
      return run;
    };
    const loadResources = async (): Promise<LoadedAgentResources> => {
      if (!options.resourceLoader) throw new Error('No resource loader configured.');
      const canonical = await workspace.resolve(cwd, { kind: 'directory' });
      // Never serve cached project bodies after trust revocation.
      loaded = undefined;
      const candidate = await options.resourceLoader.load({ cwd: canonical, projectTrusted: await trust(canonical) });
      loaded = candidate;
      return candidate;
    };
    const api: AgentSession = {
      id: sessionId, cwd, capabilities, ownership,
      snapshot: () => safe(current()),
      state: () => { open(); return safe(runtime.snapshot(sessionId)); },
      messages: () => safe(current().messages),
      effectiveContext: () => { open(); return safe(manager.getEffectiveContext(sessionId)); },
      history: async () => {
        open();
        try { return safe(await manager.getRawEntries(sessionId)); }
        catch (error) { throw safeError(error); }
      },
      exportSession: () => safe(serializeSession(current())),
      prompt: (input, promptOptions = {}) => serialInput(promptOptions, async promptOptions => {
        idle();
        const run = await runtime.start({
          ...defaults, ...promptOptions,
          sessionId, cwd, provider: providerName, input, persistSettings: false,
          model: promptOptions.model ?? current().model ?? defaults.model,
          thinking: promptOptions.thinking ?? current().thinking ?? defaults.thinking,
          toolPreset: promptOptions.toolPreset ?? current().toolPreset ?? defaults.toolPreset,
        });
        busy = true;
        settlement = runtime.wait(run.id).finally(() => { busy = false; });
        return safe(run);
      }),
      async promptAndWait(input, promptOptions) {
        const run = await api.prompt(input, promptOptions);
        // Use this exact run, not a later prompt that another caller could start.
        const result = await runtime.wait(run.id);
        if (!result) throw new Error('Agent run not found.');
        return safe(result);
      },
      wait: () => {
        open();
        // Wait behind accepted starts, but do not occupy the mutation queue:
        // stop/dispose must still be able to cancel the run being awaited.
        return tail.catch(() => undefined).then(async () => safe(await settlement));
      },
      stop: () => serial(async () => {
        const run = runtime.getSessionRun(sessionId);
        return run && !terminal(run) ? safe(runtime.stop(run.id)) : safe(run);
      }),
      steer: (content, blocks) => safe(runtime.enqueue(active().id, 'steer', content, blocks)),
      followUp: (content, blocks) => safe(runtime.enqueue(active().id, 'follow-up', content, blocks)),
      clearQueue: kind => safe(runtime.clearQueue(active().id, kind)),
      respondToInteraction: (id, response) => { open(); return safe(runtime.respondToInteraction(sessionId, id, response)); },
      subscribe(listener) {
        open();
        let attached = true;
        const unsubscribe = runtime.journal.subscribe(sessionId, event => {
          try { void Promise.resolve(listener(safe(event))).catch(() => undefined); }
          catch { /* A consumer observer cannot abort the shared Core loop. */ }
        });
        const detach = (): void => {
          if (!attached) return;
          attached = false;
          unsubscribe();
          subscriptions.delete(detach);
        };
        subscriptions.add(detach);
        return detach;
      },
      events: (after = 0) => {
        open();
        if (!Number.isSafeInteger(after) || after < 0) throw new Error('Event cursor must be a non-negative integer.');
        return safe(runtime.journal.replay(sessionId, after));
      },
      rename: title => serial(async () => { idle(); await manager.update(sessionId, { title }); }),
      setModel: model => serial(async () => { idle(); await manager.update(sessionId, { model }); }),
      setThinking: thinking => serial(async () => { idle(); await manager.update(sessionId, { thinking }); }),
      fork: (id, forkOptions = {}) => serialInput(forkOptions, async forkOptions => {
        idle();
        const session = await manager.forkSessionAtEntry(sessionId, id, forkOptions.title, { before: forkOptions.before });
        if (!session) throw new Error('Fork requires a durable user entry.');
        return handle(session.id);
      }),
      branchBefore: id => serial(async () => {
        idle();
        const message = await manager.branchBeforeEntry(sessionId, id);
        if (!message) throw new Error('Branch requires a durable user entry.');
        return safe(message);
      }),
      clone: title => serial(async () => {
        idle();
        const session = await manager.cloneSession(sessionId, title);
        if (!session) throw new Error('Session cannot be cloned.');
        return handle(session.id);
      }),
      compactionTarget: () => { open(); idle(); return safe(manager.requestCompaction(sessionId)); },
      applyCompaction: (summary, firstKeptEntryId, details) => serialInput(details, async details => {
        idle();
        if (!current().messages.some(message => message.id === firstKeptEntryId)) throw new Error('Compaction boundary is not an active message.');
        runtime.publishSessionEvent(sessionId, 'compaction.started', { automatic: false });
        try {
          await manager.applyCompaction(sessionId, summary, firstKeptEntryId, details);
          runtime.publishSessionEvent(sessionId, 'compaction.completed', { automatic: false, summaryLength: redactor.redact(summary).trim().length });
        } catch (error) {
          runtime.publishSessionEvent(sessionId, 'compaction.failed', { automatic: false, error: redactor.redact(error instanceof Error ? error.message : 'Compaction failed.') });
          throw error;
        }
      }),
      reloadResources: () => serial(async () => safe((await loadResources()).inventory())),
      resources: () => { open(); return safe(loaded?.inventory() ?? []); },
      resourceDiagnostics: () => { open(); return safe([...(loaded?.diagnostics ?? [])]); },
      expandPrompt: (name, args) => serialInput(args, async args => redactor.redact((await loadResources()).expandPrompt(name, args))),
      invokeSkill: (name, request) => serial(async () => redactor.redact((await loadResources()).invokeSkill(name, request))),
      dispose() {
        if (disposal) return disposal;
        disposed = true;
        disposal = tail.catch(() => undefined).then(async () => {
          const run = runtime.getSessionRun(sessionId);
          if (run && !terminal(run)) runtime.stop(run.id);
          await settlement;
          for (const detach of [...subscriptions]) detach();
          loaded = undefined;
          runtime.journal.clear(sessionId);
          handles--;
          if (handles === 0) {
            manager.removeAllListeners();
            if (!options.extensionRegistry) await registry.unloadAll();
            await closeProviderNetworkDispatchers(scope, { permanent: true });
          }
        });
        return disposal;
      },
    };
    return api;
  }

  try {
    let session: Session | null;
    if (options.session?.kind === 'resume') {
      if (!options.store) throw new Error('Resume requires a caller SessionStore.');
      session = await manager.loadFromStore(options.session.id);
      if (!session) throw new Error('Session not found.');
      // Do not silently move a resumed conversation to a different workspace.
      if (session.cwd && await workspace.resolve(session.cwd, { kind: 'directory' }) !== cwd) throw new Error('Session workspace differs from SDK cwd.');
    } else {
      session = await manager.create({
        ...options.session?.options,
        cwd,
        model: options.session?.options?.model ?? defaults.model ?? config?.model,
        thinking: options.session?.options?.thinking ?? defaults.thinking,
      });
    }
    return handle(session.id);
  } catch (error) {
    await closeProviderNetworkDispatchers(scope, { permanent: true });
    throw new Error(redactor.redact(error instanceof Error ? error.message : 'Agent session creation failed.'));
  }
}
