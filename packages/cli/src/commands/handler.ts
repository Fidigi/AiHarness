// ============================================================
// Command Handler - CLI Command Router with AI Integration
// Features: full session management, LLM-based compaction,
// JSONL persistence loading, streaming support, file I/O for export/import
// ============================================================

import chalk from 'chalk';
import {
  atomicWriteStableFile,
  clampPublishedThinkingLevel,
  closeProviderNetworkDispatchers,
  collectProviderModelCatalog,
  flattenModelCatalog,
  getSupportedThinkingLevels,
  isValidSessionId,
  resolveModelReference,
  resolveModelScope,
  ProviderFactory,
  readBoundedResourceText,
  WorkspaceManager
} from '@ai-harness/core';
import type {
  AgentProviderNetworkSettings,
  ExtensionRegistry,
  ExtensionRuntimeContext,
  McpConfigInventory,
  PreparedMcpTools,
  ModelCatalogEntry,
  ProviderCredentialService,
  ThemeInventoryItem,
  ThinkingLevel,

  SessionManager,
  JsonlSessionStore,
  AiProvider,
  Message,
  Session} from '@ai-harness/core';
import type { TerminalUI } from '../tui/terminal-ui.js';
import { renderSessionHtml, sanitizeFilename } from '../utils/session-export.js';
import { copyToClipboard } from '../utils/system-integration.js';
import type { ProjectTrustManager } from '../security/project-trust.js';
import { OAuthDeviceClient, oauthConfigFromEnv } from '../security/oauth-device.js';
import { createConfiguredProviders } from '../providers/configured-providers.js';
import * as path from 'path';

interface ExplicitCredentialRevealOutput {
  text: string;
  /** Unforgeable outside this module's built-in command registry. */
  kind: 'explicit-local-credential-reveal';
}

type CommandOutput = string | ExplicitCredentialRevealOutput;

const MAX_SHARE_RESPONSE_BYTES = 256 * 1024;
const SHARE_REQUEST_TIMEOUT_MS = 30_000;

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(normalized);
}

function resolveShareServerUrl(value: string): URL | undefined {
  if (!value || Buffer.byteLength(value) > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)))
      || parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
    parsed.pathname = `${parsed.pathname.replace(/\/$/u, '')}/`;
    return parsed;
  } catch {
    return undefined;
  }
}

async function readBoundedShareResponse(response: Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_SHARE_RESPONSE_BYTES)) {
    throw new Error('Share response is invalid.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_SHARE_RESPONSE_BYTES) throw new Error('Share response is invalid.');
      chunks.push(item.value);
    }
  } finally {
    void Promise.resolve(reader.cancel()).catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const chunk of chunks) {
    Buffer.from(chunk).copy(bytes, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Registry of command handlers */
interface CommandEntry {
  name: string;
  description: string;
  usage?: string;
  handler: (args: string[], ctx: CommandContext) => Promise<CommandOutput>;
}

export interface CommandContext {
  sessionManager: SessionManager;
  jsonlStore: JsonlSessionStore;
  terminal: TerminalUI;
  currentSessionId?: string;
  provider?: AiProvider;
  providers: Map<string, AiProvider>;
  extensionRegistry?: ExtensionRegistry;
  extensionProviderNames: Set<string>;
  thinkingLevel: ThinkingLevel;
  trustManager?: ProjectTrustManager;
  isProjectTrusted?: () => boolean;
  cwd: string;
  workspaceManager?: WorkspaceManager;
  workspaceId?: string;
  enabledToolNames?: () => readonly string[];
  modelPatterns?: readonly string[];
  settingsInfo?: () => string;
  credentialService?: ProviderCredentialService;
  providerCredentialValues?: ReadonlyMap<string, string>;
  allowCredentialReveal?: boolean;
  providerNetwork?: AgentProviderNetworkSettings;
  themeControl?: CommandThemeControl;
  mcpControl?: CommandMcpControl;
  redactText?: (value: string) => string;
  redactJson?: <T>(value: T) => T;
}

export interface CommandThemeControl {
  current(): string;
  list(): Promise<ThemeInventoryItem[]>;
  select(name: string): Promise<string>;
}

export interface CommandMcpControl {
  overview(): Promise<McpConfigInventory>;
  prepare(sessionId: string, preset?: Session['toolPreset']): Promise<PreparedMcpTools>;
  finish(sessionId: string): void;
  reconnect(sessionId: string): Promise<void>;
}

export interface CommandWorkspaceContext {
  cwd: string;
  workspaceManager?: WorkspaceManager;
  workspaceId?: string;
  isProjectTrusted?: () => boolean;
  enabledToolNames?: () => readonly string[];
  modelPatterns?: readonly string[];
  settingsInfo?: () => string;
  providers?: Map<string, AiProvider>;
  credentialService?: ProviderCredentialService;
  providerCredentialValues?: ReadonlyMap<string, string>;
  allowCredentialReveal?: boolean;
  providerNetwork?: AgentProviderNetworkSettings;
  themeControl?: CommandThemeControl;
  mcpControl?: CommandMcpControl;
  redactText?: (value: string) => string;
  redactJson?: <T>(value: T) => T;
}

function safeText(ctx: CommandContext, value: string): string {
  return ctx.redactText?.(value) ?? value;
}

function safeJson<T>(ctx: CommandContext, value: T): T {
  return ctx.redactJson?.(value) ?? value;
}

function parseCommandLine(input: string): string[] | undefined {
  if (typeof input !== 'string' || Buffer.byteLength(input) > 1024 * 1024 || input.includes('\0')) return undefined;
  const result: string[] = [];
  let token = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let started = false;
  const push = (): boolean => {
    if (!started) return true;
    if (Buffer.byteLength(token) > 64 * 1024 || result.length >= 256) return false;
    result.push(token);
    token = '';
    started = false;
    return true;
  };
  for (const character of input.trim()) {
    if (escaped) {
      token += /[\s\\"']/u.test(character) ? character : `\\${character}`;
      started = true;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      started = true;
      continue;
    }
    if ((character === '"' || character === "'") && !started) {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (!push()) return undefined;
      continue;
    }
    token += character;
    started = true;
  }
  if (escaped) token += '\\';
  if (quote || !push()) return undefined;
  return result;
}

function commandProjectTrusted(ctx: CommandContext): boolean {
  return ctx.isProjectTrusted?.() ?? ctx.trustManager?.isTrustedSync(ctx.cwd) ?? false;
}

async function commandWorkspaceManager(ctx: CommandContext): Promise<WorkspaceManager> {
  if (ctx.workspaceManager) return ctx.workspaceManager;
  const manager = new WorkspaceManager({ allowedRoots: [ctx.cwd], defaultCwd: ctx.cwd });
  await manager.initialize();
  ctx.workspaceManager = manager;
  return manager;
}

async function resolveCommandPath(
  ctx: CommandContext,
  input: string,
  options: { mustExist: boolean; kind?: 'file' | 'directory' | 'any' },
): Promise<string> {
  if (typeof input !== 'string' || !input || Buffer.byteLength(input) > 4_096
    || /[\u0000-\u001f\u007f-\u009f]/u.test(input)) {
    throw new Error('Invalid workspace path.');
  }
  const manager = await commandWorkspaceManager(ctx);
  if (!options.mustExist) {
    return manager.resolveDestination(input, { base: ctx.cwd, kind: options.kind });
  }
  if (options.kind === 'file') {
    return manager.resolveStableFile(input, { base: ctx.cwd });
  }
  return manager.resolve(input, { base: ctx.cwd, mustExist: true, kind: options.kind });
}

function createExtensionContext(ctx: CommandContext): ExtensionRuntimeContext {
  return {
    sessionManager: ctx.sessionManager,
    currentSessionId: ctx.currentSessionId,
    provider: ctx.provider,
    providerName: String((ctx.provider as unknown as { config?: { type?: string } } | undefined)?.config?.type ?? 'unknown'),
    cwd: ctx.cwd,
    workspaceId: ctx.workspaceId,
    projectTrusted: ctx.isProjectTrusted?.() ?? ctx.trustManager?.isTrustedSync(ctx.cwd) ?? false,
    notify: (message, level = 'info') => {
      const safeMessage = safeText(ctx, message);
      if (level === 'error') ctx.terminal.showError(safeMessage);
      else if (typeof ctx.terminal.writeOutput === 'function') ctx.terminal.writeOutput(safeMessage);
      else process.stdout.write(`${safeMessage}\n`);
    },
  };
}

function syncExtensionProviders(ctx: CommandContext): void {
  for (const name of ctx.extensionProviderNames) ctx.providers.delete(name);
  ctx.extensionProviderNames.clear();

  for (const { type, definition } of ctx.extensionRegistry?.getProviderDefinitions() ?? []) {
    try {
      const network = ctx.providerNetwork;
      const credential = ctx.providerCredentialValues?.get(type);
      const provider = ProviderFactory.create({
        ...definition.defaultConfig,
        ...(credential ? { apiKey: credential } : {}),
        ...(network ? {
          transport: network.transport,
          ...(network.httpProxy ? { httpProxy: network.httpProxy } : {}),
          httpIdleTimeoutMs: network.httpIdleTimeoutMs,
          websocketConnectTimeoutMs: network.websocketConnectTimeoutMs,
          requestTimeoutMs: network.requestTimeoutMs,
          providerMaxRetries: network.maxRetries,
          providerMaxRetryDelayMs: network.maxRetryDelayMs,
        } : {}),
        type,
      });
      ctx.providers.set(type, provider);
      ctx.extensionProviderNames.add(type);
    } catch (error) {
      ctx.terminal.showError(safeText(ctx, `Failed to initialize extension provider "${type}": ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  const activeType = ctx.provider?.getProviderType();
  if (activeType && !ctx.providers.has(activeType)) ctx.provider = ctx.providers.get('mock');
}

async function availableCommandModels(ctx: CommandContext): Promise<ModelCatalogEntry[]> {
  return flattenModelCatalog(await collectProviderModelCatalog(ctx.providers, {
    timeoutMs: 2_000,
    retries: 0,
  })).filter(model => model.available);
}

function modelLabel(model: ModelCatalogEntry): string {
  return model.name === model.id ? model.source : model.name;
}

function importedMessage(value: unknown): Message {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid imported message.');
  }
  const source = value as Record<string, unknown>;
  if (!['user', 'assistant', 'system', 'tool'].includes(String(source.role))
    || typeof source.content !== 'string') {
    throw new Error('Invalid imported message.');
  }
  const timestamp = source.timestamp === undefined ? new Date() : new Date(source.timestamp as string | number);
  if (!Number.isFinite(timestamp.getTime())) throw new Error('Invalid imported message.');
  return {
    id: typeof source.id === 'string' && source.id ? source.id : `import-${crypto.randomUUID()}`,
    role: source.role as Message['role'],
    content: source.content,
    timestamp,
    ...(source.blocks !== undefined ? { blocks: source.blocks as Message['blocks'] } : {}),
    ...(source.toolCalls !== undefined ? { toolCalls: source.toolCalls as Message['toolCalls'] } : {}),
    ...(typeof source.toolCallId === 'string' ? { toolCallId: source.toolCallId } : {}),
    ...(typeof source.name === 'string' ? { name: source.name } : {}),
    ...(typeof source.isError === 'boolean' ? { isError: source.isError } : {}),
    ...(typeof source.provider === 'string' ? { provider: source.provider } : {}),
    ...(typeof source.model === 'string' ? { model: source.model } : {}),
    ...(source.usage && typeof source.usage === 'object' ? { usage: source.usage as Message['usage'] } : {}),
    ...(typeof source.durationMs === 'number' ? { durationMs: source.durationMs } : {}),
    ...(typeof source.parentMessageId === 'string' ? { parentMessageId: source.parentMessageId } : {}),
    ...(typeof source.agentId === 'string' ? { agentId: source.agentId } : {}),
    ...(source.metadata && typeof source.metadata === 'object' && !Array.isArray(source.metadata)
      ? { metadata: source.metadata as Record<string, unknown> } : {}),
  };
}

async function selectCommandModel(
  ctx: CommandContext,
  model: ModelCatalogEntry,
  thinkingLevel?: ThinkingLevel,
): Promise<void> {
  const provider = ctx.providers.get(model.provider);
  if (!provider) throw new Error(`Provider unavailable: ${model.provider}`);
  provider.setConfiguredModel(model.id);
  ctx.provider = provider;
  if (thinkingLevel) {
    ctx.thinkingLevel = clampPublishedThinkingLevel(
      thinkingLevel,
      getSupportedThinkingLevels(model.provider, model.id),
    );
  } else {
    ctx.thinkingLevel = clampPublishedThinkingLevel(
      ctx.thinkingLevel,
      getSupportedThinkingLevels(model.provider, model.id),
    );
  }
}

const commands: CommandEntry[] = [
  {
    name: 'help',
    description: 'Show available commands',
    handler: async () => '', // Handled by TerminalUI.showHelp()
  },
  {
    name: 'settings',
    description: 'Show effective agent settings and their source scopes',
    handler: async (_args, ctx) => ctx.settingsInfo?.()
      ?? chalk.yellow('Agent settings are not configured for this runtime.'),
  },
  {
    name: 'new',
    description: 'Create a new conversation',
    usage: '/new [title]',
    handler: async (args, ctx) => {
      const title = args.length > 0 ? args.join(' ') : `Conversation ${ctx.sessionManager.list().length + 1}`;
      const session = await ctx.sessionManager.create({
        title,
        cwd: ctx.cwd,
        workspaceId: ctx.workspaceId,
      });
      // Switch to the newly created session
      ctx.currentSessionId = session.id;
      return `Created: ${chalk.cyan(session.id)} - ${chalk.dim(title)}`;
    },
  },
  {
    name: 'list',
    description: 'List all conversations (with optional search filter)',
    usage: '/list [search-query]',
    handler: async (args, ctx) => {
      const sessions = ctx.sessionManager.list();
      if (sessions.length === 0) return chalk.yellow('No conversations yet.');

      // Optional search/filter by query
      const filterQuery = args[0]?.toLowerCase().trim();
      let filteredSessions = sessions;

      if (filterQuery) {
        filteredSessions = sessions.filter(s => 
          s.title?.toLowerCase().includes(filterQuery) ||
          s.messages.some(m => m.content.toLowerCase().includes(filterQuery))
        );
      }

      const countLabel = filterQuery ? `filtered (${chalk.cyan(filteredSessions.length)} of ${sessions.length})` : 'total';
      
      if (filteredSessions.length === 0) {
        return chalk.yellow(`No sessions matching "${filterQuery}".\n   Showing all ${countLabel}: ${sessions.length} session(s)`);
      }

      const lines = filteredSessions.map((s, i) => {
        const status = chalk.green('●');
        const title = s.title || 'Untitled';
        const msgCount = s.messages.length;
        const date = new Date(s.updatedAt).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
        
        // Highlight matching text in title if filtering
        let displayTitle = title;
        if (filterQuery && s.title?.toLowerCase().includes(filterQuery)) {
          const idx = s.title.toLowerCase().indexOf(filterQuery);
          if (idx !== -1) {
            displayTitle = chalk.bgYellow.black(title.slice(idx, idx + filterQuery.length));
          }
        }
        
        return `${status} ${chalk.bold(i + 1)}. ${displayTitle}`.padEnd(40) + ` (${msgCount} msgs, ${date})`;
      });

      const header = chalk.bold(`Sessions [${countLabel}]:\n`);
      return header + lines.join('\n');
    },
  },
  {
    name: 'switch',
    description: 'Switch to a conversation (loads from JSONL)',
    usage: '/switch <id or number>',
    handler: async (args, ctx) => {
      if (!args[0]) return chalk.red('Usage: /switch <id>');

      const target = args[0];
      let session: Session | null | undefined = ctx.sessionManager.get(target);

      if (!session) session = await ctx.sessionManager.loadFromStore(target);

      const numericIndex = Number.parseInt(target, 10);
      if (!session && numericIndex > 0) {
        session = ctx.sessionManager.list()[numericIndex - 1];
      }

      if (!session && numericIndex > 0) {
        const allIds = await ctx.jsonlStore.listSessionIds();
        const persistedId = allIds[numericIndex - 1];
        if (persistedId) session = await ctx.sessionManager.loadFromStore(persistedId);
      }

      if (!session) {
        return chalk.red(`Session not found: ${chalk.yellow(target)}. Use /list to see available sessions.`);
      }

      ctx.currentSessionId = session.id;
      return `Switched to session: ${chalk.cyan(session.id)} - ${chalk.dim(session.title || 'Untitled')} (${session.messages.length} msgs)`;
    },
  },
  {
    name: 'delete',
    description: 'Delete a conversation',
    usage: '/delete <id>',
    handler: async (args, ctx) => {
      if (!args[0]) return chalk.red('Usage: /delete <id>');

      const deleted = await ctx.sessionManager.delete(args[0]);
      return deleted ? `Deleted session ${chalk.yellow(args[0])}` : chalk.red(`Session not found: ${chalk.yellow(args[0])}`);
    },
  },
  {
    name: 'clear',
    description: 'Clear current conversation messages',
    handler: async (_, ctx) => {
      const sessions = ctx.sessionManager.list();
      if (sessions.length === 0) return chalk.yellow('No active session to clear.');

      const session = (ctx.currentSessionId && ctx.sessionManager.get(ctx.currentSessionId)) || sessions[0];
      await ctx.jsonlStore.deleteSession(session.id);

      // Create a fresh empty session with same ID
      const title = session.title || 'Untitled';
      const newSession = { ...session, messages: [], createdAt: new Date(), updatedAt: new Date() };
      const sessionCache = ctx.sessionManager as unknown as { sessions: Map<string, Session> };
      sessionCache.sessions.set(newSession.id, newSession);

      return chalk.green(`Cleared ${chalk.bold(title)} — conversation is now empty.`);
    },
  },
  {
    name: 'provider',
    description: 'Show/change AI provider',
    usage: '/provider [name]',
    handler: async (args, ctx) => {
      if (args[0]) {
        // Try to set the provider
        const providerName = args[0].toLowerCase();
        let newProvider: AiProvider | undefined;

        for (const [, p] of ctx.providers) {
          const configType = p.constructor.name.toLowerCase().replace('provider', '');
          if (configType.includes(providerName)) {
            newProvider = p;
            break;
          }
        }

        // Also check by type string in config
        for (const [, p] of ctx.providers) {
          if (p.getProviderType() === providerName) {
            newProvider = p;
            break;
          }
        }

        if (newProvider) {
          ctx.provider = newProvider;
          return `Switched to provider: ${chalk.cyan(providerName)}`;
        }

        // Try creating a new one from default configs
        if (providerName === 'mock' && !ctx.providers.has('mock')) {
          const mockProvider = ProviderFactory.create({ type: 'mock', apiKey: '' });
          ctx.providers.set('mock', mockProvider);
          ctx.provider = mockProvider;
          return `Switched to provider: ${chalk.cyan('mock')} (for testing)`;
        }

        return chalk.red(`Unknown provider: ${chalk.yellow(args[0])}. Available: ${[...ctx.providers.keys()].join(', ')}`);
      }

      // Show current providers
      const lines = ['Available AI Providers:', ''];
      for (const [name, p] of ctx.providers) {
        const isValid = p.validateConfig();
        const status = isValid ? chalk.green('✓') : chalk.yellow('?');
        lines.push(`  ${status} ${chalk.cyan(name)}${isValid ? '' : ' (no API key)'}`);
      }

      return lines.join('\n');
    },
  },
  {
    name: 'model',
    description: 'List/switch/cycle models from the shared catalogue',
    usage: '/model [list|cycle|<[provider/]model[:thinking]>]',
    handler: async (args, ctx) => {
      const activeProvider = ctx.provider;
      if (!activeProvider) return chalk.yellow('No active provider configured.');
      const activeProviderName = String((activeProvider as unknown as { config?: { type?: string } }).config?.type ?? 'unknown');
      const available = await availableCommandModels(ctx);
      if (!available.length) return chalk.yellow('No models available for configured providers.');

      if (args[0]?.toLowerCase() === 'cycle' || args[0]?.toLowerCase() === '--cycle') {
        const scope = ctx.modelPatterns?.length
          ? resolveModelScope(ctx.modelPatterns, available).models
          : available.filter(model => model.provider === activeProviderName)
            .map(model => ({ model, thinkingLevel: undefined as ThinkingLevel | undefined }));
        if (!scope.length) return chalk.yellow('No models match the active model scope.');
        const currentModel = activeProvider.getConfiguredModel();
        const currentIndex = scope.findIndex(item => (
          item.model.provider === activeProviderName && item.model.id === currentModel
        ));
        const next = scope[(currentIndex + 1 + scope.length) % scope.length]!;
        await selectCommandModel(ctx, next.model, next.thinkingLevel);
        return `${chalk.green('✅')} Switched to ${chalk.cyan(`${next.model.provider}/${next.model.id}`)}`
          + ` (${modelLabel(next.model)})\n   Cycle: [`
          + `${scope.map(item => chalk.dim(`${item.model.provider}/${item.model.id}`)).join(' → ')}]`;
      }

      if (args.length > 0 && args[0]?.toLowerCase() !== 'list') {
        const reference = args.join(' ');
        const resolved = resolveModelReference(reference, available);
        if (!resolved.model) {
          return chalk.red(`${resolved.message ?? `Unknown model: ${reference}`} Available:\n  `
            + available.map(model => `${chalk.cyan(`${model.provider}/${model.id}`)} - ${modelLabel(model)}`).join('\n  '));
        }
        await selectCommandModel(ctx, resolved.model, resolved.thinkingLevel);
        return `${chalk.green('✅')} Set model to ${chalk.cyan(`${resolved.model.provider}/${resolved.model.id}`)}`
          + ` (${modelLabel(resolved.model)})`;
      }

      const currentModel = activeProvider.getConfiguredModel();
      const models = available.filter(model => model.provider === activeProviderName);
      let output = `${chalk.bold('Current Model:')} ${chalk.cyan(currentModel ?? 'none')}\n`;
      output += `\n${chalk.bold(`${activeProviderName.toUpperCase()} Models:`)}\n`;
      for (const model of models) {
        const marker = model.id === currentModel ? chalk.green('●') : chalk.dim('○');
        output += `  ${marker} ${chalk.cyan(model.id)} - ${modelLabel(model)}\n`;
      }
      output += `\n${chalk.yellow('Commands:')}\n`;
      output += `  /model <name>      Set a fuzzy or provider-qualified model\n`;
      output += `  /model cycle       Cycle through the active --models scope`;
      return output;
    },
  },
  {
    name: 'config',
    description: 'View configuration',
    handler: async () => `Configuration:
  Sessions directory: ~/.ai-harness/sessions/
  Persistence: JSONL format
  Auto-save: Enabled`,
  },
  {
    name: 'theme',
    description: 'Lister ou sélectionner un thème terminal à chaud',
    usage: '/theme [name]',
    handler: async (args, ctx) => {
      if (!ctx.themeControl) return chalk.yellow('La sélection de thème n’est pas disponible.');
      const selected = args.join(' ').trim();
      if (selected) {
        const name = await ctx.themeControl.select(selected);
        return chalk.green(`Thème actif : ${name}.`);
      }
      const inventory = await ctx.themeControl.list();
      return inventory.map(theme => {
        const marker = theme.active || theme.name === ctx.themeControl?.current() ? '●' : '○';
        const source = `${theme.provenance.scope}/${theme.provenance.source}`;
        return `${marker} ${theme.name} (${source})${theme.valid ? '' : ' [invalide]'}`;
      }).join('\n');
    },
  },
  {
    name: 'login',
    description: 'Authentifier un provider avec un flux OAuth device',
    usage: '/login <provider>',
    handler: async (args, ctx) => {
      const providerName = args[0]?.trim().toLowerCase();
      if (!providerName) return chalk.red('Usage: /login <provider>');
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(providerName)) return chalk.red('Provider OAuth invalide.');
      const credentialService = ctx.credentialService as (typeof ctx.credentialService
        & { hasPersistentStore?: () => boolean }) | undefined;
      if (!credentialService?.hasPersistentStore?.()) {
        return chalk.yellow('Un stockage chiffré persistant est requis avant une authentification OAuth.');
      }
      const config = oauthConfigFromEnv(providerName);
      if (!config) {
        return chalk.yellow(`OAuth non configuré pour ${providerName}. Définissez AI_HARNESS_OAUTH_${providerName.toUpperCase()}_{DEVICE_URL,TOKEN_URL,CLIENT_ID}.`);
      }
      const client = new OAuthDeviceClient(config);
      const prompt = await client.requestCode();
      ctx.terminal.writeOutput(`Ouvrez ${prompt.verificationUriComplete || prompt.verificationUri} et saisissez le code ${prompt.userCode}.`);
      const credential = await client.pollCredential(prompt);
      await credentialService.setOAuth(providerName, credential);
      const existing = ctx.providers.get(providerName) as unknown as { config?: Record<string, unknown> } | undefined;
      const provider = ProviderFactory.create({
        ...(existing?.config ?? {}),
        type: providerName,
        apiKey: credential.accessToken,
      });
      ctx.providers.set(providerName, provider);
      ctx.provider = provider;
      return chalk.green(`Authentification OAuth réussie pour ${providerName}.`);
    },
  },
  {
    name: 'logout',
    description: 'Supprimer les identifiants enregistrés pour un provider',
    usage: '/logout <provider>',
    handler: async (args, ctx) => {
      const providerName = args[0]?.trim().toLowerCase();
      if (!providerName) return chalk.red('Usage: /logout <provider>');
      if (!ctx.credentialService) return chalk.yellow('Le stockage sécurisé des identifiants n’est pas configuré.');
      await ctx.credentialService.delete(providerName);
      await closeProviderNetworkDispatchers();
      ctx.providers.delete(providerName);
      if ((ctx.provider as unknown as { config?: { type?: string } } | undefined)?.config?.type === providerName) {
        ctx.provider = ctx.providers.get('mock');
      }
      return chalk.green(`Identifiants supprimés pour ${providerName}.`);
    },
  },
  {
    name: 'credentials',
    description: 'Lister les descripteurs non secrets des identifiants enregistrés',
    handler: async (_args, ctx) => {
      if (!ctx.credentialService) return chalk.yellow('Le stockage sécurisé des identifiants n’est pas configuré.');
      const descriptors = ctx.credentialService.list();
      return descriptors.length
        ? descriptors.map(item => `${item.provider} — ${item.type} (${item.source})${item.refreshable ? ' [actualisable]' : ''}`).join('\n')
        : 'Aucun identifiant enregistré.';
    },
  },
  {
    name: 'credential',
    description: 'Révéler explicitement un identifiant dans ce terminal local',
    usage: '/credential reveal <provider>',
    handler: async (args, ctx) => {
      if (args.length !== 2 || args[0] !== 'reveal' || !args[1]) {
        return chalk.red('Usage: /credential reveal <provider>');
      }
      if (!ctx.allowCredentialReveal) {
        return chalk.red('La révélation est disponible uniquement dans un terminal interactif local.');
      }
      if (!ctx.credentialService) return chalk.yellow('Le stockage sécurisé des identifiants n’est pas configuré.');
      const value = await ctx.credentialService.reveal(args[1], { cwd: ctx.cwd });
      return value === undefined
        ? chalk.yellow(`Aucun identifiant résolu pour ${args[1]}.`)
        : { text: value, kind: 'explicit-local-credential-reveal' };
    },
  },
  {
    name: 'thinking',
    description: 'Configurer le niveau de raisonnement du modèle',
    usage: '/thinking [off|minimal|low|medium|high|xhigh|max]',
    handler: async (args, ctx) => {
      const level = args[0]?.toLowerCase() as ThinkingLevel | undefined;
      if (!level) return `Niveau de raisonnement : ${chalk.cyan(ctx.thinkingLevel)}`;
      if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(level)) {
        return chalk.red('Usage: /thinking [off|minimal|low|medium|high|xhigh|max]');
      }
      const available = getSupportedThinkingLevels(
        ctx.provider?.getProviderType() ?? 'unknown',
        ctx.provider?.getConfiguredModel(),
      );
      ctx.thinkingLevel = clampPublishedThinkingLevel(level, available);
      return chalk.green(`Niveau de raisonnement défini sur ${ctx.thinkingLevel}.`);
    },
  },
  {
    name: 'compact',
    description: 'Compact conversation context (summarize old messages)',
    usage: '/compact [instructions]',
    handler: async (args, ctx) => {
      const sessions = ctx.sessionManager.list();
      if (!sessions.length) return chalk.yellow('No active session to compact.');

      const instructions = args.length > 0 ? args.join(' ') : undefined;
      const session = (ctx.currentSessionId && ctx.sessionManager.get(ctx.currentSessionId)) || sessions[0];
      const messages = session.messages;

      if (messages.length < 3) {
        return chalk.yellow(`Not enough messages to compact (${messages.length}/3 minimum).`);
      }

      // Find the provider for LLM summarization
      const provider = ctx.provider;
      if (!provider || !provider.validateConfig()) {
        return chalk.red('No configured AI provider for compaction. Set API keys or use /provider mock.');
      }

      try {
        // Build system prompt for summarization
        const instructionsText = instructions || 'Summarize this conversation concisely, preserving key information and context.';
        const summaryMessages: Message[] = [
          ...messages.map(m => ({ ...m })),
          { id: '__compact__', role: 'user', content: `Please summarize the above conversation. Focus on preserving important facts, decisions, and context needed for future responses. Keep it concise but comprehensive.`, timestamp: new Date() },
        ];

        // Use provider's chat to generate summary (non-streaming for reliability)
        const result = await provider.chat(summaryMessages, {
          systemPrompt: instructionsText,
          sessionId: session.id,
        });

        if (!result.content) {
          return chalk.red('Compaction failed: no summary generated.');
        }

        // Apply only scrubbed provider output so credentials never reach session persistence.
        const summary = safeText(ctx, result.content);
        const firstKeptId = session.messages[session.messages.length - 2]?.id || '';
        await ctx.sessionManager.applyCompaction(
          session.id,
          summary,
          firstKeptId,
        );

        return chalk.green(`✅ Compacted ${chalk.bold(session.title || 'conversation')}\n` +
          `   Summary: ${summary.slice(0, 100)}${summary.length > 100 ? '...' : ''}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return chalk.red(`Compaction failed: ${errorMessage}`);
      }
    },
  },
  // ===================================================================
  // Session Tree Commands (fork/clone/tree)
  // ===================================================================
  {
    name: 'summarize-branch',
    description: 'Résumer une branche sans modifier ses messages',
    usage: '/summarize-branch [session-id] [instructions]',
    handler: async (args, ctx) => {
      const explicitSession = args[0] ? ctx.sessionManager.get(args[0]) : undefined;
      const sessionId = explicitSession?.id || ctx.currentSessionId;
      const session = sessionId ? ctx.sessionManager.get(sessionId) : undefined;
      if (!session) return chalk.red('Aucune branche active à résumer.');
      if (!ctx.provider?.validateConfig()) return chalk.red('Aucun provider configuré pour générer le résumé.');
      const instructionArgs = explicitSession ? args.slice(1) : args;
      const result = await ctx.provider.chat(session.messages.map(message => ({ ...message })), {
        systemPrompt: instructionArgs.join(' ') || 'Résume cette branche de conversation en préservant les décisions, résultats et contexte utiles.',
      });
      if (!result.content.trim()) return chalk.red('Le provider n’a produit aucun résumé.');
      await ctx.sessionManager.addBranchSummary(session.id, result.content, session.title);
      return chalk.green(`Résumé de branche enregistré pour ${session.title || session.id}.`);
    },
  },
  {
    name: 'tree',
    description: 'Show session tree structure',
    usage: '/tree [branch-id]',
    handler: async (args, ctx) => {
      const branchId = args[0];
      const tree = ctx.sessionManager.getSessionTree(branchId);

      if (tree.length === 0) {
        return chalk.yellow('No sessions found.'); // Fixed: removed extra space
      }

      let output = `${chalk.bold('\n🌳 Session Tree')}${branchId ? ` (Branch: ${branchId.slice(0, 8)}...)` : ''}\n`;
      output += '─'.repeat(60) + '\n';

      for (const node of tree) {
        const indent = '  '.repeat(node.depth);
        const marker = node.depth === 0 ? chalk.green('●') : chalk.dim('○');
        const title = node.title || 'Untitled';
        const parentIdStr = node.parentId ? ` (from ${node.parentId.slice(0, 8)}...)` : '';

        output += `${indent}${marker} ${chalk.cyan(title)}${parentIdStr}\n`;
        const summaries = await ctx.sessionManager.getBranchSummaries(node.id);
        for (const summary of summaries) {
          output += `${indent}  ${chalk.dim(`↳ ${summary.summary.slice(0, 100)}${summary.summary.length > 100 ? '…' : ''}`)}\n`;
        }
      }

      return output;
    },
  },
  {
    name: 'fork',
    description: 'Fork a session from a specific point',
    usage: '/fork <session-id> [message-index] [new-title]',
    handler: async (args, ctx) => {
      if (!args[0]) return chalk.red('Usage: /fork <session-id> [message-index] [title]');

      const sessionId = args[0];
      let session: Session | null | undefined = ctx.sessionManager.get(sessionId);

      // Try loading from store if not in memory
      if (!session) {
        session = await ctx.sessionManager.loadFromStore(sessionId);
      }

      if (!session) return chalk.red(`Session not found: ${chalk.yellow(sessionId)}. Use /list to see available sessions.`);

      // Parse optional arguments
      let messageIndex: number | undefined;
      let newTitle: string | undefined;

      if (args[1]) {
        const parsed = parseInt(args[1]);
        if (!isNaN(parsed)) {
          messageIndex = parsed;
        } else {
          // First arg after session ID is the title
          newTitle = args.slice(1).join(' ');
        }
      }

      if (args.length > 2) {
        newTitle = args.slice(2).join(' ');
      }

      const forked = await ctx.sessionManager.forkSession(sessionId, messageIndex, newTitle);

      if (!forked) return chalk.red('Fork failed: session not found');

      return `${chalk.green('✅ Forked session')} ${chalk.cyan(forked.id)}\n` +
        `   Title: ${forked.title || 'Untitled'}\n` +
        `   Messages: ${forked.messages.length} (from message index ${messageIndex !== undefined ? messageIndex : 0})`;
    },
  },
  {
    name: 'clone',
    description: 'Clone a session with all messages',
    usage: '/clone <session-id> [new-title]',
    handler: async (args, ctx) => {
      if (!args[0]) return chalk.red('Usage: /clone <session-id> [title]');

      const sessionId = args[0];
      let session: Session | null | undefined = ctx.sessionManager.get(sessionId);

      // Try loading from store if not in memory
      if (!session) {
        session = await ctx.sessionManager.loadFromStore(sessionId);
      }

      if (!session) return chalk.red(`Session not found: ${chalk.yellow(sessionId)}. Use /list to see available sessions.`);

      const newTitle = args.length > 1 ? args.slice(1).join(' ') : undefined;
      const cloned = await ctx.sessionManager.cloneSession(sessionId, newTitle);

      if (!cloned) return chalk.red('Clone failed: session not found');

      return `${chalk.green('✅ Cloned session')} ${chalk.cyan(cloned.id)}\n` +
        `   Title: ${cloned.title || 'Untitled'}\n` +
        `   Messages: ${cloned.messages.length}`;
    },
  },
  {
    name: 'share',
    description: 'Créer un lien public temporaire pour la session active',
    usage: '/share [durée-heures]',
    handler: async (args, ctx) => {
      const sessionId = ctx.currentSessionId || ctx.sessionManager.list()[0]?.id;
      if (!sessionId) return chalk.red('Aucune session à partager.');
      if (args.length > 1 || (args[0] !== undefined && !/^\d{1,3}$/u.test(args[0]))) {
        return chalk.red('Usage: /share [durée-heures]');
      }
      const ttlHours = args[0] === undefined ? 24 : Number(args[0]);
      if (!Number.isSafeInteger(ttlHours) || ttlHours < 1 || ttlHours > 168) {
        return chalk.red('La durée de partage doit être comprise entre 1 et 168 heures.');
      }
      const baseUrl = resolveShareServerUrl(process.env.AI_HARNESS_SERVER_URL || 'http://127.0.0.1:3080');
      if (!baseUrl) return chalk.red('URL du serveur de partage invalide.');
      const endpoint = new URL(`api/sessions/${encodeURIComponent(sessionId)}/share`, baseUrl);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error('Share request timed out.')), SHARE_REQUEST_TIMEOUT_MS);
      timeout.unref?.();
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            ...(process.env.AI_HARNESS_AUTH_TOKEN ? { Authorization: `Bearer ${process.env.AI_HARNESS_AUTH_TOKEN}` } : {}),
          },
          body: JSON.stringify({ ttlHours }),
        });
        if (!response.ok) {
          void Promise.resolve(response.body?.cancel()).catch(() => undefined);
          return chalk.red(`Partage impossible (${response.status}).`);
        }
        const text = await readBoundedShareResponse(response);
        const result: unknown = JSON.parse(text);
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Share response is invalid.');
        const { url, expiresInHours } = result as Record<string, unknown>;
        if (typeof url !== 'string' || Buffer.byteLength(url) > 4_096
          || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(url)
          || !Number.isSafeInteger(expiresInHours) || (expiresInHours as number) < 1 || (expiresInHours as number) > 168) {
          throw new Error('Share response is invalid.');
        }
        return chalk.green(`Lien valable ${expiresInHours as number} h : ${url}`);
      } finally {
        clearTimeout(timeout);
      }
    },
  },
  {
    name: 'bug',
    description: 'Préparer un rapport de bug GitHub',
    usage: '/bug [description]',
    handler: async args => {
      const description = args.join(' ') || 'Décrivez le problème rencontré.';
      const body = [description, '', `Node: ${process.version}`, `Platform: ${process.platform}/${process.arch}`].join('\n');
      const repository = process.env.AI_HARNESS_ISSUES_URL || 'https://github.com/Fidigi/AiHarness/issues/new';
      return `${repository}?title=${encodeURIComponent('[Bug] ' + description.slice(0, 60))}&body=${encodeURIComponent(body)}`;
    },
  },
  {
    name: 'export',
    description: 'Export conversation to file',
    usage: '/export <format> [path]',
    handler: async (args, ctx) => {
      const format = (args[0] || 'json').toLowerCase();
      let outputPath = args.slice(1).join(' ') || undefined; // Optional explicit path
      
      const sessions = ctx.sessionManager.list();
      if (!sessions.length) return chalk.yellow('No conversations to export.');

      // Export the current session (or most recent if no current session)
      let session: Session | undefined;
      if (ctx.currentSessionId) {
        session = ctx.sessionManager.get(ctx.currentSessionId);
      }
      if (!session) {
        session = sessions[0];
      }
      const rawSession = session;
      const { messages: _messages, commands: rawCommands, ...sessionMetadata } = rawSession;
      session = {
        ...safeJson(ctx, sessionMetadata),
        messages: rawSession.messages.map(message => safeJson(ctx, message)),
        ...(rawCommands ? { commands: rawCommands.map(command => safeJson(ctx, command)) } : {}),
      } as Session;
      let content: string;

      switch (format) {
        case 'json':
          content = JSON.stringify(session, null, 2);
          break;
        case 'markdown':
          content = `# ${session.title || 'Conversation'}\n\n`;
          for (const msg of session.messages) {
            const roleLabel = msg.role === 'user'
              ? '**You**'
              : msg.role === 'assistant'
                ? '**Assistant**'
                : msg.role === 'tool'
                  ? `**Tool${msg.name ? ` (${msg.name})` : ''}**`
                  : '**System**';
            content += `${roleLabel}:\n${msg.content}\n\n---\n\n`;
          }
          break;
        case 'jsonl': {
          // Export as JSONL format (one message per line)
          const lines = session.messages.map(m => JSON.stringify({
            id: m.id,
            role: m.role,
            content: m.content,
            timestamp: m.timestamp.toISOString(),
            ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
            ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
            ...(m.name ? { name: m.name } : {}),
            ...(m.isError !== undefined ? { isError: m.isError } : {}),
          }));
          content = lines.join('\n');
          break;
        }
        case 'html':
          content = renderSessionHtml(session);
          break;
        default:
          return chalk.red(`Unsupported format: ${format}. Use json, markdown, jsonl, or html.`);
      }

      // Determine output path
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      let filename: string;
      
      if (outputPath) {
        // Use user-provided path, ensure proper extension
        const extMap: Record<string, string> = { json: 'json', markdown: 'md', jsonl: 'jsonl', html: 'html' };
        const expectedExt = extMap[format] || format;
        if (!outputPath.endsWith(`.${expectedExt}`)) {
          outputPath = `${outputPath}.${expectedExt}`;
        }
        filename = outputPath;
      } else {
        // Default exports stay in the active, WorkspaceManager-confined directory.
        const extMap: Record<string, string> = { json: 'json', markdown: 'md', jsonl: 'jsonl', html: 'html' };
        const safeTitle = sanitizeFilename(session.title || 'export');
        filename = `${safeTitle}-${timestamp}.${extMap[format]}`;
      }

      const destination = await resolveCommandPath(ctx, filename, { mustExist: false });
      await atomicWriteStableFile(destination, content, { overwrite: true, maxBytes: 64 * 1024 * 1024 });
      filename = destination;

      return `✅ Exported session "${chalk.cyan(session.title || 'Untitled')}" as ${format} (${content.length} chars)\n   → ${chalk.green(path.basename(filename))}`;
    },
  },
  // ===================================================================
  // Session Info & Management Commands
  // ===================================================================
  {
    name: 'session',
    description: 'Show session statistics and token usage',
    handler: async (args, ctx) => {
      const sessions = ctx.sessionManager.list();
      if (sessions.length === 0) return chalk.yellow('No sessions available.');

      // Show stats for the most recent session by default, or all if requested
      const showAll = args.includes('--all') || args.includes('-a');
      
      let output = '';
      const currentSession = (ctx.currentSessionId && ctx.sessionManager.get(ctx.currentSessionId)) || sessions[0];
      const targetSessions = showAll ? sessions : [currentSession];

      for (const session of targetSessions) {
        const tokenCount = ctx.sessionManager.getTokenCount(session.id);
        const userMsgs = session.messages.filter(m => m.role === 'user').length;
        const assistantMsgs = session.messages.filter(m => m.role === 'assistant').length;

        output += `${chalk.bold('📊 Session:')} ${chalk.cyan(session.title || 'Untitled')}\n`;
        output += `   ID: ${chalk.dim(session.id.slice(0, 8))}\n`;
        output += `   Messages: ${userMsgs} (you) + ${assistantMsgs} (AI) = ${session.messages.length} total\n`;
        output += `   Tokens (est.): ~${tokenCount.toLocaleString()} tokens\n`;
        output += `   Created: ${new Date(session.createdAt).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })}\n`;
        output += `   Updated: ${chalk.dim(new Date(session.updatedAt).toLocaleString('fr-FR'))}\n\n`;
      }

      if (showAll) {
        output += chalk.dim(`Showing all ${targetSessions.length} sessions. Use without flags for current session only.`);
      }

      return output.trim();
    },
  },
  {
    name: 'name',
    description: 'Rename the current session',
    usage: '/name <new-title>',
    handler: async (args, ctx) => {
      const title = args.join(' ').trim();
      if (!title) return chalk.red('Usage: /name <new-title>');

      // Get current active session from the terminal or first session
      let sessionId = ctx.currentSessionId;
      
      // If no explicit current session, use the most recent one
      if (!sessionId) {
        const sessions = ctx.sessionManager.list();
        if (sessions.length === 0) return chalk.red('No active session. Create one with /new');
        sessionId = sessions[0].id;
      }

      await ctx.sessionManager.update(sessionId, { title });
      ctx.terminal.addTranscriptEntry({ 
        type: 'command', 
        content: `Session renamed to: ${title}` 
      });
      return chalk.green(`✅ Session title updated to: "${chalk.cyan(title)}"`);
    },
  },
  // Alias for /name.
  {
    name: 'rename',
    description: 'Rename the current session (alias for /name)',
    usage: '/rename <new-title>',
    handler: async (args, ctx) => {
      const title = args.join(' ').trim();
      if (!title) return chalk.red('Usage: /rename <new-title>');

      let sessionId = ctx.currentSessionId;
      if (!sessionId) {
        const sessions = ctx.sessionManager.list();
        if (sessions.length === 0) return chalk.red('No active session. Create one with /new');
        sessionId = sessions[0].id;
      }

      await ctx.sessionManager.update(sessionId, { title });
      ctx.terminal.addTranscriptEntry({ 
        type: 'command', 
        content: `Session renamed to: ${title}` 
      });
      return chalk.green(`✅ Session title updated to: "${chalk.cyan(title)}"`);
    },
  },
  {
    name: 'copy',
    description: 'Copy the last assistant message to clipboard',
    handler: async (_, ctx) => {
      const sessions = ctx.sessionManager.list();
      if (sessions.length === 0) return chalk.yellow('No conversations yet.');

      const session = (ctx.currentSessionId && ctx.sessionManager.get(ctx.currentSessionId)) || sessions[0];
      const lastAssistantMsg = [...session.messages].reverse().find(m => m.role === 'assistant');
      
      if (!lastAssistantMsg) {
        return chalk.yellow('No assistant messages to copy.');
      }

      const content = lastAssistantMsg.content;
      const method = await copyToClipboard(content);
      if (!method) {
        return chalk.yellow('Presse-papiers indisponible (installez wl-copy, xclip ou xsel).') + `\n${content}`;
      }
      return chalk.green(`✅ Dernier message copié (${content.length} caractères, ${method}).`);
    },
  },
  {
    name: 'import',
    description: 'Import sessions from a JSONL file',
    usage: '/import <path-to-jsonl-file>',
    handler: async (args, ctx) => {
      const filePath = args.join(' ').trim();
      if (!filePath) return chalk.red('Usage: /import <path-to-jsonl-file>');
      if (!commandProjectTrusted(ctx)) {
        return chalk.yellow('Project trust is required before importing a workspace file.');
      }

      let displayName = path.basename(filePath);
      try {
        const resolvedPath = await resolveCommandPath(ctx, filePath, { mustExist: true, kind: 'file' });
        displayName = path.basename(resolvedPath);
        const rawContent = await readBoundedResourceText(resolvedPath, 64 * 1024 * 1024);
        const lines = rawContent.split(/\r?\n/u).filter(line => line.trim());
        if (lines.length === 0) {
          return chalk.yellow(`No messages found in ${chalk.cyan(displayName)}`);
        }
        if (lines.length > 100_000) throw new Error('Import entry limit exceeded.');

        const drafts: Array<{ id?: string; title: string; messages: Message[] }> = [];
        let importedMessages = 0;
        if (rawContent.trimStart().startsWith('[')) {
          const data = JSON.parse(rawContent) as unknown;
          if (!Array.isArray(data) || data.length === 0 || data.length > 10_000) {
            throw new Error('Invalid session array.');
          }
          const importedIds = new Set<string>();
          for (const value of data) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
              throw new Error('Invalid imported session.');
            }
            const source = value as Record<string, unknown>;
            if (typeof source.id !== 'string' || !isValidSessionId(source.id)
              || importedIds.has(source.id) || !Array.isArray(source.messages)
              || ctx.sessionManager.get(source.id)) {
              throw new Error('Invalid or duplicate imported session.');
            }
            importedIds.add(source.id);
            importedMessages += source.messages.length;
            if (importedMessages > 100_000) throw new Error('Import message limit exceeded.');
            if (source.title !== undefined && (typeof source.title !== 'string'
              || Buffer.byteLength(source.title) > 4_096
              || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(source.title))) {
              throw new Error('Invalid imported title.');
            }
            drafts.push({
              id: source.id,
              title: source.title ?? 'Imported Session',
              messages: source.messages.map(importedMessage),
            });
          }
        } else {
          const messages: Message[] = [];
          let title = 'Imported Session';
          for (const line of lines) {
            if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw new Error('Imported message is too large.');
            const value = JSON.parse(line) as unknown;
            if (messages.length === 0 && value && typeof value === 'object' && !Array.isArray(value)) {
              const requestedTitle = (value as Record<string, unknown>).sessionTitle;
              if (requestedTitle !== undefined) {
                if (typeof requestedTitle !== 'string' || Buffer.byteLength(requestedTitle) > 4_096
                  || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(requestedTitle)) {
                  throw new Error('Invalid imported title.');
                }
                title = requestedTitle;
              }
            }
            messages.push(importedMessage(value));
          }
          drafts.push({ title, messages });
        }

        const createdIds: string[] = [];
        try {
          for (const draft of drafts) {
            const created = await ctx.sessionManager.create(draft);
            createdIds.push(created.id);
          }
        } catch (error) {
          for (const id of createdIds.reverse()) {
            try { await ctx.sessionManager.delete(id); }
            catch { /* Preserve the import failure while each durable rollback is attempted. */ }
          }
          throw error;
        }
        const importedCount = drafts.length;
        const sessionType = importedCount > 1 ? 'sessions' : 'session';
        return chalk.green(`✅ Imported ${importedCount} ${sessionType} from ${chalk.cyan(displayName)}`);
      } catch {
        return chalk.red(`❌ Import failed: the file is unavailable, unsafe, or invalid.\n   File: ${chalk.cyan(displayName)}`);
      }
    },
  },
  // ===================================================================
  // Search & Discovery Commands
  // ===================================================================
  {
    name: 'search',
    description: 'Search transcript for a query string',
    usage: '/search <query>',
    handler: async (args, ctx) => {
      const query = args.join(' ').trim();
      if (!query) return chalk.red('Usage: /search <query>');

      // Search the transcript buffer
      ctx.terminal.displaySearchResults(query);
      return '';
    },
  },
  {
    name: 'extensions',
    description: 'List loaded extensions',
    handler: async (_args, ctx) => {
      const extensions = ctx.extensionRegistry?.list() ?? [];
      if (extensions.length === 0) return chalk.yellow('No extensions loaded.');
      return extensions.map(extension => {
        const capabilities = [
          extension.commands.length ? `${extension.commands.length} command(s)` : '',
          extension.tools.length ? `${extension.tools.length} tool(s)` : '',
          extension.providers.length ? `${extension.providers.length} provider(s)` : '',
          extension.uiComponents.length ? `${extension.uiComponents.length} UI component(s)` : '',
          extension.hooks.length ? `${extension.hooks.length} before hook(s)` : '',
        ].filter(Boolean).join(', ') || 'no registrations';
        return `${chalk.green('●')} ${chalk.cyan(path.basename(extension.id))} — ${capabilities}`;
      }).join('\n');
    },
  },
  {
    name: 'mcp',
    description: 'Inspect persistent MCP servers and session tools',
    usage: '/mcp [status|tools|reconnect]',
    handler: async (args, ctx) => {
      if (!ctx.mcpControl) return chalk.yellow('MCP runtime is not configured.');
      const action = args[0]?.toLowerCase() || 'status';
      if (action === 'status' || action === 'list') {
        const inventory = await ctx.mcpControl.overview();
        if (inventory.servers.length === 0) return chalk.yellow('No MCP servers configured.');
        return inventory.servers.map(server => {
          const configured = !server.valid ? 'invalid'
            : server.shadowedByProject ? 'shadowed'
              : !server.enabled ? 'disabled' : 'configured';
          const runtime = server.runtimeStatus
            ? ` · ${server.runtimeStatus.state}${server.runtimeStatus.toolCount === undefined ? '' : ` (${server.runtimeStatus.toolCount} tools)`}`
            : '';
          return `${server.runtimeStatus?.state === 'connected' ? chalk.green('●') : chalk.dim('○')} ${chalk.cyan(server.name)} [${server.scope}] — ${configured}${runtime}`;
        }).join('\n');
      }
      if (!ctx.currentSessionId) return chalk.red('An active session is required.');
      const session = ctx.sessionManager.get(ctx.currentSessionId);
      if (action === 'reconnect') {
        await ctx.mcpControl.reconnect(ctx.currentSessionId);
      } else if (action !== 'tools') {
        return chalk.red('Usage: /mcp [status|tools|reconnect]');
      }
      try {
        const prepared = await ctx.mcpControl.prepare(ctx.currentSessionId, session?.toolPreset);
        if (prepared.tools.length === 0) {
          return action === 'reconnect'
            ? chalk.yellow('MCP connections reset; no direct tools are ready yet.')
            : chalk.yellow('No direct MCP tools are ready.');
        }
        const heading = action === 'reconnect' ? `${chalk.green('MCP connections refreshed.')}\n` : '';
        return `${heading}${prepared.tools.map(tool => `${chalk.green('●')} ${chalk.cyan(tool.name)} — ${tool.mcp.server}/${tool.mcp.tool}${tool.readOnly ? ' [read-only]' : ''}`).join('\n')}`;
      } finally {
        ctx.mcpControl.finish(ctx.currentSessionId);
      }
    },
  },
  {
    name: 'tools',
    description: 'List built-in and extension tools',
    handler: async (_args, ctx) => {
      const tools = ctx.extensionRegistry?.getTools() ?? [];
      if (tools.length === 0) return chalk.yellow('No tools registered.');
      const enabled = new Set(ctx.enabledToolNames?.() ?? tools.map(tool => tool.name));
      return tools.map(tool => `${enabled.has(tool.name) ? chalk.green('●') : chalk.dim('○')} ${chalk.cyan(tool.name)} — ${tool.description}${enabled.has(tool.name) ? '' : chalk.dim(' [disabled]')}`).join('\n');
    },
  },
  {
    name: 'tool',
    description: 'Execute a registered tool manually',
    usage: '/tool <name> [json-input]',
    handler: async (args, ctx) => {
      if (!ctx.extensionRegistry || !args[0]) return chalk.red('Usage: /tool <name> [json-input]');
      const enabled = new Set(ctx.enabledToolNames?.() ?? ctx.extensionRegistry.getTools().map(tool => tool.name));
      if (!enabled.has(args[0].toLowerCase())) return chalk.red(`Tool is disabled for this run: ${args[0]}`);
      let input: unknown = {};
      if (args.length > 1) {
        try {
          input = JSON.parse(args.slice(1).join(' '));
        } catch {
          return chalk.red('Tool input must be valid JSON.');
        }
      }
      const result = await ctx.extensionRegistry.executeTool(
        args[0],
        input,
        createExtensionContext(ctx),
      );
      return result.isError ? chalk.red(result.content) : result.content;
    },
  },
  {
    name: 'trust',
    description: 'Gérer la confiance accordée au projet courant',
    usage: '/trust [status|allow|allow-parent|refuse|forget|list]',
    handler: async (args, ctx) => {
      if (!ctx.trustManager) return chalk.yellow('La gestion de confiance n’est pas configurée.');
      const action = args[0]?.toLowerCase() || 'status';
      if (action === 'list') {
        await ctx.trustManager.refresh();
        const decisions = ctx.trustManager.listDecisions();
        return decisions.length
          ? decisions.map(entry => `[${entry.decision ? 'allow' : 'refuse'}] ${entry.path}`).join('\n')
          : 'Aucune décision de confiance enregistrée.';
      }
      if (action === 'add' || action === 'allow') {
        const trusted = await ctx.trustManager.trust(ctx.cwd);
        return chalk.green(`Projet approuvé : ${trusted}. Utilisez /reload pour charger ses ressources.`);
      }
      if (action === 'parent' || action === 'allow-parent') {
        const parent = path.dirname(ctx.cwd);
        if (parent === ctx.cwd) return chalk.red('Le dossier racine ne possède pas de parent approuvable.');
        await ctx.trustManager.setMany([
          { path: parent, decision: true },
          { path: ctx.cwd, decision: null },
        ]);
        return chalk.green(`Dossier parent approuvé : ${parent}. La décision est héritée ; utilisez /reload.`);
      }
      if (action === 'remove' || action === 'deny' || action === 'refuse') {
        const refused = await ctx.trustManager.refuse(ctx.cwd);
        return chalk.yellow(`Refus enregistré : ${refused}. Utilisez /reload.`);
      }
      if (action === 'forget') {
        const forgotten = await ctx.trustManager.forget(ctx.cwd);
        return chalk.yellow(`Décision exacte supprimée : ${forgotten}. Utilisez /reload.`);
      }
      if (action !== 'status') {
        return chalk.red('Usage: /trust [status|allow|allow-parent|refuse|forget|list]');
      }
      const status = await ctx.trustManager.getStatus(ctx.cwd);
      const effectiveTrusted = ctx.isProjectTrusted?.() ?? status.trusted;
      const origin = status.decisionPath
        ? `${status.inherited ? 'héritée de' : 'enregistrée pour'} ${status.decisionPath}`
        : !status.requiresTrust
          ? 'aucune ressource protégée'
          : effectiveTrusted ? 'autorisation limitée au processus' : 'aucune décision enregistrée';
      return effectiveTrusted
        ? chalk.green(`Le projet courant est approuvé (${origin}).`)
        : chalk.yellow(`Le projet courant n’est pas approuvé (${origin}) ; ses ressources sont ignorées.`);
    },
  },
  {
    name: 'reload',
    description: 'Reload extension modules',
    handler: async (_args, ctx) => {
      if (!ctx.extensionRegistry) return chalk.yellow('Extension loading is not configured.');
      await ctx.extensionRegistry.reload();
      syncExtensionProviders(ctx);
      return chalk.green(`Reloaded ${ctx.extensionRegistry.list().length} extension(s).`);
    },
  },
  {
    name: 'quit',
    description: 'Exit AiHarness',
    handler: async () => '',
  },
];

export class CommandHandler {
  private ctx: CommandContext;
  private exiting = false;

  constructor(
    sessionManager: SessionManager,
    jsonlStore: JsonlSessionStore,
    terminal: TerminalUI,
    extensionRegistry?: ExtensionRegistry,
    trustManager?: ProjectTrustManager,
    workspace: CommandWorkspaceContext = { cwd: process.cwd() },
  ) {
    const providers = workspace.providers ?? createConfiguredProviders();

    this.ctx = {
      sessionManager,
      jsonlStore,
      terminal,
      currentSessionId: undefined,
      provider: providers.get('mock'), // Default to mock
      providers,
      extensionRegistry,
      extensionProviderNames: new Set(),
      thinkingLevel: 'off',
      trustManager,
      isProjectTrusted: workspace.isProjectTrusted,
      cwd: workspace.cwd,
      workspaceManager: workspace.workspaceManager,
      workspaceId: workspace.workspaceId,
      enabledToolNames: workspace.enabledToolNames,
      modelPatterns: workspace.modelPatterns,
      settingsInfo: workspace.settingsInfo,
      credentialService: workspace.credentialService,
      providerCredentialValues: workspace.providerCredentialValues,
      allowCredentialReveal: workspace.allowCredentialReveal,
      providerNetwork: workspace.providerNetwork,
      themeControl: workspace.themeControl,
      mcpControl: workspace.mcpControl,
      redactText: workspace.redactText,
      redactJson: workspace.redactJson,
    };
    syncExtensionProviders(this.ctx);
  }

  hasCommand(name: string): boolean {
    const normalized = name.trim().toLowerCase().replace(/^\//, '');
    return commands.some(command => command.name === normalized)
      || Boolean(this.ctx.extensionRegistry?.getCommand(normalized));
  }

  getCommandNames(): string[] {
    return [
      ...commands.map(command => command.name),
      ...(this.ctx.extensionRegistry?.getCommands().map(command => command.name) ?? []),
    ].filter((name, index, all) => all.indexOf(name) === index).sort();
  }

  /** Execute a command */
  async execute(input: string): Promise<void> {
    const parts = parseCommandLine(input.slice(1));
    if (!parts) {
      this.ctx.terminal.showError('Invalid or oversized command line.');
      return;
    }
    const commandName = parts[0]?.toLowerCase();
    const args = parts.slice(1).map(value => safeText(this.ctx, value));

    if (!commandName) return;

    // Special handling for quit/exit commands (before command lookup)
    if (commandName === 'quit' || commandName === 'exit') {
      this.exiting = true;
      return;
    }

    const exactCommand = commands.find(command => command.name === commandName);
    const extensionCommand = !exactCommand || commandName === 'mcp'
      ? this.ctx.extensionRegistry?.getCommand(commandName) : undefined;

    if (extensionCommand) {
      try {
        const output = await extensionCommand.handler(safeText(this.ctx, args.join(' ')), createExtensionContext(this.ctx));
        if (output) this.writeOutput(output);
      } catch (error) {
        this.ctx.terminal.showError(safeText(this.ctx, `Extension command failed: ${error instanceof Error ? error.message : String(error)}`));
      }
      return;
    }

    const prefixMatches = exactCommand ? [exactCommand]
      : commands.filter(command => command.name.startsWith(commandName));
    if (prefixMatches.length === 0) {
      this.writeOutput(`Unknown command: ${chalk.red(commandName)}\nType /help for available commands.`);
      return;
    }
    if (prefixMatches.length > 1) {
      this.writeOutput(`Ambiguous command: ${chalk.red(commandName)} (${prefixMatches.map(command => `/${command.name}`).join(', ')})`);
      return;
    }

    try {
      const selectedCommand = prefixMatches[0]!;
      const commandContext = selectedCommand.name === 'credential' && commandName !== 'credential'
        ? { ...this.ctx, allowCredentialReveal: false }
        : this.ctx;
      const output = await selectedCommand.handler(args, commandContext);
      if (typeof output === 'string') {
        if (output) this.writeOutput(output);
      } else if (output.text) {
        const exactCredentialReveal = commandName === 'credential'
          && args.length === 2 && args[0] === 'reveal' && Boolean(args[1]);
        this.writeOutput(output.text, output.kind === 'explicit-local-credential-reveal' && exactCredentialReveal);
      }
    } catch {
      this.ctx.terminal.showError('Command failed.');
    }
  }

  private writeOutput(output: string, sensitive = false): void {
    if (sensitive) {
      this.ctx.terminal.writeExplicitCredentialReveal(output);
      return;
    }
    const safeOutput = safeText(this.ctx, output);
    if (typeof this.ctx.terminal.writeOutput === 'function') this.ctx.terminal.writeOutput(safeOutput);
    else process.stdout.write(`${safeOutput}\n\n`);
  }

  getContext(): CommandContext {
    return this.ctx;
  }

  isExiting(): boolean {
    return this.exiting;
  }
}
