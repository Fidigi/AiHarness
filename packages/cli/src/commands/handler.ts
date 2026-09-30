// ============================================================
// Command Handler - CLI Command Router with AI Integration
// Features: full session management, LLM-based compaction,
// JSONL persistence loading, streaming support, file I/O for export/import
// ============================================================

import chalk from 'chalk';
import { SessionManager, JsonlSessionStore, AiProvider, ProviderFactory, Message, Session } from '@ai-harness/core';
import type { ExtensionRegistry, ExtensionRuntimeContext, ThinkingLevel } from '@ai-harness/core';
import type { TerminalUI } from '../tui/terminal-ui.js';
import { renderSessionHtml, sanitizeFilename } from '../utils/session-export.js';
import { copyToClipboard } from '../utils/system-integration.js';
import type { ProjectTrustManager } from '../security/project-trust.js';
import { OAuthDeviceClient, oauthConfigFromEnv } from '../security/oauth-device.js';
import * as fs from 'fs/promises';
import * as path from 'path';

/** Registry of command handlers */
interface CommandEntry {
  name: string;
  description: string;
  usage?: string;
  handler: (args: string[], ctx: CommandContext) => Promise<string>;
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
}

function createExtensionContext(ctx: CommandContext): ExtensionRuntimeContext {
  return {
    sessionManager: ctx.sessionManager,
    currentSessionId: ctx.currentSessionId,
    provider: ctx.provider,
    notify: (message, level = 'info') => {
      if (level === 'error') ctx.terminal.showError(message);
      else if (typeof ctx.terminal.writeOutput === 'function') ctx.terminal.writeOutput(message);
      else process.stdout.write(`${message}\n`);
    },
  };
}

function syncExtensionProviders(ctx: CommandContext): void {
  for (const name of ctx.extensionProviderNames) ctx.providers.delete(name);
  ctx.extensionProviderNames.clear();

  for (const { type, definition } of ctx.extensionRegistry?.getProviderDefinitions() ?? []) {
    try {
      const provider = ProviderFactory.create({
        ...definition.defaultConfig,
        type,
      } as any);
      ctx.providers.set(type, provider);
      ctx.extensionProviderNames.add(type);
    } catch (error) {
      ctx.terminal.showError(`Failed to initialize extension provider "${type}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const activeType = (ctx.provider as any)?.config?.type as string | undefined;
  if (activeType && !ctx.providers.has(activeType)) ctx.provider = ctx.providers.get('mock');
}

const commands: CommandEntry[] = [
  {
    name: 'help',
    description: 'Show available commands',
    handler: async () => '', // Handled by TerminalUI.showHelp()
  },
  {
    name: 'new',
    description: 'Create a new conversation',
    usage: '/new [title]',
    handler: async (args, ctx) => {
      const title = args.length > 0 ? args.join(' ') : `Conversation ${ctx.sessionManager.list().length + 1}`;
      const session = await ctx.sessionManager.create({ title });
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
      ctx.sessionManager['sessions'].set(newSession.id, newSession as any);

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
          const providerConfig = p['config'] as any;
          if (providerConfig?.type === providerName) {
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
          const mockProvider = ProviderFactory.create({ type: 'mock', apiKey: '' } as any);
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
    description: 'List/switch/cycle models for current provider',
    usage: '/model [list|cycle|<model-name>]',
    handler: async (args, ctx) => {
      const provider = ctx.provider;
      if (!provider) return chalk.yellow('No active provider configured.');

      // Get the config type to determine available models
      const configType = (provider as any)['config']?.type || 'unknown';
      
      // Define available models per provider
      const modelRegistry: Record<string, { name: string; description: string }[]> = {
        openai: [
          { name: 'gpt-4o', description: 'default, recommended' },
          { name: 'gpt-4-turbo', description: 'fast and capable' },
          { name: 'gpt-3.5-turbo', description: 'lightweight, cost-effective' },
        ],
        anthropic: [
          { name: 'claude-3-opus-20240229', description: 'most capable' },
          { name: 'claude-3-sonnet-20240229', description: 'balanced performance' },
          { name: 'claude-3-haiku-20240307', description: 'fastest, cost-effective' },
        ],
        google: [
          { name: 'gemini-2.5-pro', description: 'advanced reasoning' },
          { name: 'gemini-2.0-flash', description: 'fast, multimodal' },
          { name: 'gemini-2.0-flash-lite', description: 'lightweight' },
        ],
        azure: [{ name: 'gpt-4o', description: 'Azure OpenAI deployment' }],
        vertex: [{ name: 'gemini-2.0-flash', description: 'Google Vertex AI' }],
        bedrock: [{ name: 'anthropic.claude-3-haiku-20240307-v1:0', description: 'AWS Bedrock Converse' }],
        mock: [
          { name: 'mock-model-v1', description: 'for testing only' },
        ],
      };

      let models = modelRegistry[configType] || [];
      if (configType === 'local' && provider.getAvailableModels) {
        const discoveredModels = await provider.getAvailableModels();
        models = discoveredModels.map(name => ({ name, description: 'modèle local détecté' }));
        if (models.length === 0) {
          const configuredModel = (provider as any)['config']?.model || 'local-model';
          models = [{ name: configuredModel, description: 'modèle local configuré' }];
        }
      }

      // Handle cycling (e.g., /model cycle or just /model with --cycle)
      if (args.length > 0 && (args[0].toLowerCase() === 'cycle' || args[0].toLowerCase() === '--cycle')) {
        const currentModel = (provider as any)['config']?.model;
        let currentIndex = -1;

        // Find the index of the current model in the registry
        if (currentModel) {
          currentIndex = models.findIndex(m => m.name.toLowerCase().includes(currentModel.toLowerCase()));
        }

        const nextIndex = (currentIndex + 1) % models.length;
        const nextModel = models[nextIndex];

        // Update the provider's model config
        if ((provider as any)['config']) {
          (provider as any)['config'].model = nextModel.name;
        }

        return `${chalk.green('✅')} Switched to ${chalk.cyan(nextModel.name)} (${nextModel.description})` +
          `\n   Cycle: [${models.map(m => chalk.dim(m.name)).join(' → ')}]`;
      }

      // Handle setting a specific model (e.g., /model gpt-4o)
      if (args.length > 0) {
        const modelName = args[0].toLowerCase();
        
        // Find matching model
        const matchedModel = models.find(m => m.name.toLowerCase().includes(modelName));
        
        if (!matchedModel) {
          return chalk.red(`Unknown model: ${chalk.yellow(args[0])}. Available:` +
            `\n  ${models.map(m => `${chalk.cyan(m.name)} - ${m.description}`).join('\n  ')}`);
        }

        // Update the provider's model config
        if ((provider as any)['config']) {
          (provider as any)['config'].model = matchedModel.name;
        }

        return `${chalk.green('✅')} Set model to ${chalk.cyan(matchedModel.name)}` +
          ` (${matchedModel.description})`;
      }

      // No args - show current model and available options
      const currentModel = (provider as any)['config']?.model || models[0]?.name;
      
      let output = `${chalk.bold('Current Model:')} ${chalk.cyan(currentModel)}\n`;
      output += `\n${chalk.bold(`${configType.toUpperCase()} Models:`)}\n`;

      for (const model of models) {
        const marker = model.name === currentModel ? chalk.green('●') : chalk.dim('○');
        output += `  ${marker} ${chalk.cyan(model.name)} - ${model.description}\n`;
      }

      output += `\n${chalk.yellow('Commands:')}\n`;
      output += `  /model <name>     Set specific model\n`;
      output += `  /model cycle       Cycle to next model in list`; // No trailing newline for cleaner display

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
    name: 'login',
    description: 'Authentifier un provider avec un flux OAuth device',
    usage: '/login <provider>',
    handler: async (args, ctx) => {
      const providerName = args[0]?.toLowerCase();
      if (!providerName) return chalk.red('Usage: /login <provider>');
      const config = oauthConfigFromEnv(providerName);
      if (!config) {
        return chalk.yellow(`OAuth non configuré pour ${providerName}. Définissez AI_HARNESS_OAUTH_${providerName.toUpperCase()}_{DEVICE_URL,TOKEN_URL,CLIENT_ID}.`);
      }
      const client = new OAuthDeviceClient(config);
      const prompt = await client.requestCode();
      ctx.terminal.writeOutput(`Ouvrez ${prompt.verificationUriComplete || prompt.verificationUri} et saisissez le code ${prompt.userCode}.`);
      const token = await client.pollToken(prompt);
      const existing = ctx.providers.get(providerName) as unknown as { config?: Record<string, unknown> } | undefined;
      const provider = ProviderFactory.create({
        ...(existing?.config ?? {}),
        type: providerName,
        apiKey: token,
      } as any);
      ctx.providers.set(providerName, provider);
      ctx.provider = provider;
      return chalk.green(`Authentification OAuth réussie pour ${providerName}.`);
    },
  },
  {
    name: 'thinking',
    description: 'Configurer le niveau de raisonnement du modèle',
    usage: '/thinking [off|low|medium|high|xhigh]',
    handler: async (args, ctx) => {
      const level = args[0]?.toLowerCase() as ThinkingLevel | undefined;
      if (!level) return `Niveau de raisonnement : ${chalk.cyan(ctx.thinkingLevel)}`;
      if (!['off', 'low', 'medium', 'high', 'xhigh'].includes(level)) {
        return chalk.red('Usage: /thinking [off|low|medium|high|xhigh]');
      }
      ctx.thinkingLevel = level;
      return chalk.green(`Niveau de raisonnement défini sur ${level}.`);
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
        const result = await provider.chat(summaryMessages, { systemPrompt: instructionsText });

        if (!result.content) {
          return chalk.red('Compaction failed: no summary generated.');
        }

        // Apply compaction - replace old messages with summary
        const firstKeptId = session.messages[session.messages.length - 2]?.id || '';
        await ctx.sessionManager.applyCompaction(
          session.id,
          result.content,
          firstKeptId,
        );

        return chalk.green(`✅ Compacted ${chalk.bold(session.title || 'conversation')}\n` +
          `   Summary: ${(result.content as string).slice(0, 100)}${(result.content as string).length > 100 ? '...' : ''}`);
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
      const baseUrl = (process.env.AI_HARNESS_SERVER_URL || 'http://127.0.0.1:3080').replace(/\/$/, '');
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/share`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.AI_HARNESS_AUTH_TOKEN ? { Authorization: `Bearer ${process.env.AI_HARNESS_AUTH_TOKEN}` } : {}),
        },
        body: JSON.stringify({ ttlHours: Number(args[0]) || 24 }),
      });
      if (!response.ok) return chalk.red(`Partage impossible (${response.status}) : ${await response.text()}`);
      const result = await response.json() as { url: string; expiresInHours: number };
      return chalk.green(`Lien valable ${result.expiresInHours} h : ${result.url}`);
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
        // Auto-generate filename in sessions directory
        const sessionDir = path.join(process.env.HOME || '.', '.ai-harness', 'exports');
        await fs.mkdir(sessionDir, { recursive: true });
        const extMap: Record<string, string> = { json: 'json', markdown: 'md', jsonl: 'jsonl', html: 'html' };
        const safeTitle = sanitizeFilename(session.title || 'export');
        filename = path.join(sessionDir, `${safeTitle}-${timestamp}.${extMap[format]}`);
      }

      // Write to file
      await fs.writeFile(filename, content, 'utf-8');

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
  // Alias for /name (Pi compatibility)
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
      const filePath = args[0];
      if (!filePath) return chalk.red('Usage: /import <path-to-jsonl-file>');

      // Resolve the file path
      const resolvedPath = path.resolve(filePath);

      try {
        // Read and parse JSONL file
        const rawContent = await fs.readFile(resolvedPath, 'utf-8');
        const lines = rawContent.split('\n').filter(line => line.trim());

        if (lines.length === 0) {
          return chalk.yellow(`No messages found in ${chalk.cyan(path.basename(resolvedPath))}`);
        }

        // Try to detect format: JSON array of sessions or single-session JSONL
        let importedCount = 0;

        try {
          // Attempt to parse as a JSON array (multi-session export)
          const data = JSON.parse(lines.join('\n'));
          if (Array.isArray(data)) {
            // Multi-session format: [{id, title, messages: [...]}, ...]
            for (const sessionData of data) {
              if (sessionData.id && Array.isArray(sessionData.messages)) {
                await ctx.sessionManager.create({ 
                  id: sessionData.id,
                  title: sessionData.title || 'Imported Session',
                  messages: sessionData.messages.map((m: any) => ({
                    ...m,
                    timestamp: new Date(m.timestamp),
                  })),
                });
                importedCount++;
              }
            }
          }
        } catch {
          // Not a JSON array, try JSONL format (one message per line)
          const messages: Message[] = [];
          let title = 'Imported Session';

          for (const line of lines) {
            try {
              const msgData = JSON.parse(line);
              if (msgData.role && msgData.content !== undefined) {
                // Check for session metadata in first message
                if (messages.length === 0 && msgData.sessionTitle) {
                  title = msgData.sessionTitle;
                }
                messages.push({
                  id: msgData.id || `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  role: msgData.role as Message['role'],
                  content: String(msgData.content),
                  timestamp: msgData.timestamp ? new Date(msgData.timestamp) : new Date(),
                  toolCalls: msgData.toolCalls,
                  toolCallId: msgData.toolCallId,
                  name: msgData.name,
                  isError: msgData.isError,
                });
              }
            } catch {
              // Skip malformed lines
              continue;
            }
          }

          if (messages.length > 0) {
            await ctx.sessionManager.create({ title, messages });
            importedCount++;
          }
        }

        if (importedCount === 0) {
          return chalk.red(`Failed to import: unrecognized format in ${chalk.cyan(path.basename(resolvedPath))}`);
        }

        const sessionType = importedCount > 1 ? 'sessions' : 'session';
        return chalk.green(`✅ Imported ${importedCount} ${sessionType} from ${chalk.cyan(path.basename(resolvedPath))}\n   → ${chalk.dim(importedCount === 1 ? `Session: ${ctx.sessionManager.list()[0]?.title || 'Imported Session'}` : `${importedCount} sessions loaded`)}`);

      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        return chalk.red(`❌ Import failed: ${err}\n   File: ${chalk.cyan(resolvedPath)}`);
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
    name: 'tools',
    description: 'List tools registered by extensions',
    handler: async (_args, ctx) => {
      const tools = ctx.extensionRegistry?.getTools() ?? [];
      if (tools.length === 0) return chalk.yellow('No extension tools registered.');
      return tools.map(tool => `${chalk.green('●')} ${chalk.cyan(tool.name)} — ${tool.description}`).join('\n');
    },
  },
  {
    name: 'tool',
    description: 'Execute an extension tool manually',
    usage: '/tool <name> [json-input]',
    handler: async (args, ctx) => {
      if (!ctx.extensionRegistry || !args[0]) return chalk.red('Usage: /tool <name> [json-input]');
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
    usage: '/trust [status|add|remove|list]',
    handler: async (args, ctx) => {
      if (!ctx.trustManager) return chalk.yellow('La gestion de confiance n’est pas configurée.');
      const action = args[0]?.toLowerCase() || 'status';
      if (action === 'list') {
        const projects = ctx.trustManager.list();
        return projects.length ? projects.join('\n') : 'Aucun projet approuvé.';
      }
      if (action === 'add') {
        const trusted = await ctx.trustManager.trust(process.cwd());
        return chalk.green(`Projet approuvé : ${trusted}. Utilisez /reload pour charger ses extensions.`);
      }
      if (action === 'remove') {
        const removed = await ctx.trustManager.untrust(process.cwd());
        return chalk.yellow(`Confiance retirée : ${removed}. Utilisez /reload.`);
      }
      if (action !== 'status') return chalk.red('Usage: /trust [status|add|remove|list]');
      return await ctx.trustManager.isTrusted(process.cwd())
        ? chalk.green('Le projet courant est approuvé.')
        : chalk.yellow('Le projet courant n’est pas approuvé ; ses extensions sont ignorées.');
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
  ) {
    // Initialize providers
    const providers = new Map<string, AiProvider>();

    // Mock provider (always available for testing)
    providers.set('mock', ProviderFactory.create({ type: 'mock' as any, apiKey: '' }));

    // Try to initialize real providers if API keys are configured
    try {
      const openaiKey = process.env.OPENAI_API_KEY;
      if (openaiKey) {
        providers.set('openai', ProviderFactory.create({ type: 'openai' as any, apiKey: openaiKey }));
      }
    } catch { /* Skip OpenAI provider initialization */ }

    try {
      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      if (anthropicKey) {
        providers.set('anthropic', ProviderFactory.create({ type: 'anthropic' as any, apiKey: anthropicKey }));
      }
    } catch { /* Skip Anthropic provider initialization */ }

    try {
      const googleKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
      if (googleKey) {
        providers.set('google', ProviderFactory.create({
          type: 'google' as any,
          apiKey: googleKey,
          model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
        }));
      }
    } catch { /* Skip Gemini provider initialization */ }

    try {
      if (process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT) {
        providers.set('azure', ProviderFactory.create({
          type: 'azure' as any,
          apiKey: process.env.AZURE_OPENAI_API_KEY,
          baseUrl: process.env.AZURE_OPENAI_ENDPOINT,
          deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
          model: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o',
          apiVersion: process.env.AZURE_OPENAI_API_VERSION,
        }));
      }
    } catch { /* Skip Azure initialization */ }

    try {
      if (process.env.GOOGLE_VERTEX_ACCESS_TOKEN && process.env.GOOGLE_CLOUD_PROJECT) {
        providers.set('vertex', ProviderFactory.create({
          type: 'vertex' as any,
          apiKey: process.env.GOOGLE_VERTEX_ACCESS_TOKEN,
          project: process.env.GOOGLE_CLOUD_PROJECT,
          location: process.env.GOOGLE_CLOUD_LOCATION,
          model: process.env.VERTEX_MODEL || 'gemini-2.0-flash',
        }));
      }
    } catch { /* Skip Vertex initialization */ }

    try {
      if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
        providers.set('bedrock', ProviderFactory.create({
          type: 'bedrock' as any,
          region: process.env.AWS_REGION,
          model: process.env.BEDROCK_MODEL,
        }));
      }
    } catch { /* Skip Bedrock initialization */ }

    // Local OpenAI-compatible provider (Ollama, llama.cpp, AirNES router).
    try {
      providers.set('local', ProviderFactory.create({
        type: 'local' as any,
        baseUrl: process.env.LOCAL_BASE_URL || process.env.LLAMA_BASE_URL || 'http://localhost:11434/v1',
        apiKey: process.env.LOCAL_API_KEY || process.env.LLAMA_API_KEY || 'local',
        model: process.env.LOCAL_MODEL || process.env.LLAMA_MODEL || 'local-model',
      }));
    } catch { /* Skip invalid local provider initialization */ }

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
    const parts = input.slice(1).trim().split(/\s+/);
    const commandName = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    if (!commandName) return;

    // Special handling for quit/exit commands (before command lookup)
    if (commandName === 'quit' || commandName === 'exit') {
      this.exiting = true;
      return;
    }

    const exactCommand = commands.find(command => command.name === commandName);
    const extensionCommand = exactCommand ? undefined : this.ctx.extensionRegistry?.getCommand(commandName);

    if (extensionCommand) {
      try {
        const output = await extensionCommand.handler(args.join(' '), createExtensionContext(this.ctx));
        if (output) this.writeOutput(output);
      } catch (error) {
        this.ctx.terminal.showError(`Extension command failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    const cmd = exactCommand ?? commands.find(command => command.name.startsWith(commandName));
    if (!cmd) {
      this.writeOutput(`Unknown command: ${chalk.red(commandName)}\nType /help for available commands.`);
      return;
    }

    const output = await cmd.handler(args, this.ctx);
    if (output) this.writeOutput(output);
  }

  private writeOutput(output: string): void {
    if (typeof this.ctx.terminal.writeOutput === 'function') this.ctx.terminal.writeOutput(output);
    else process.stdout.write(`${output}\n\n`);
  }

  getContext(): CommandContext {
    return this.ctx;
  }

  isExiting(): boolean {
    return this.exiting;
  }
}
