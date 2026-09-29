// ============================================================
// Command Handler - CLI Command Router
// ============================================================

import chalk from 'chalk';
import { SessionManager } from '@ai-harness/core';

/** Registry of command handlers */
interface CommandEntry {
  name: string;
  description: string;
  usage?: string;
  handler: (args: string[], sessionManager: SessionManager) => Promise<string>;
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
    handler: async (_, sessionManager) => {
      const title = `Conversation ${sessionManager.list().length + 1}`;
      const session = sessionManager.create({ title });
      return `Created: ${chalk.cyan(session.id)} - ${chalk.dim(title)}`;
    },
  },
  {
    name: 'list',
    description: 'List all conversations',
    handler: async (_, sessionManager) => {
      const sessions = sessionManager.list();
      if (sessions.length === 0) return 'No conversations yet.';

      const lines = sessions.map((s, i) => {
        const status = chalk.green('●');
        const title = s.title || 'Untitled';
        const msgCount = s.messages.length;
        const date = new Date(s.updatedAt).toLocaleDateString('fr-FR');
        return `${status} ${chalk.bold(i + 1)}. ${title}`.padEnd(40) + ` (${msgCount} msgs, ${date})`;
      });
      return lines.join('\n');
    },
  },
  {
    name: 'switch',
    description: 'Switch to a conversation',
    usage: '/switch <id or number>',
    handler: async (args) => {
      if (!args[0]) return chalk.red('Usage: /switch <id>');
      return `Switched to session: ${chalk.cyan(args[0])}`; // TODO: Implement actual switch
    },
  },
  {
    name: 'delete',
    description: 'Delete a conversation',
    usage: '/delete <id>',
    handler: async (args, sessionManager) => {
      if (!args[0]) return chalk.red('Usage: /delete <id>');
      const deleted = sessionManager.delete(args[0]);
      return deleted ? `Deleted session ${chalk.yellow(args[0])}` : chalk.red(`Session not found: ${args[0]}`);
    },
  },
  {
    name: 'clear',
    description: 'Clear current conversation',
    handler: async (_, sessionManager) => {
      // TODO: Clear messages from current session
      return 'Conversation cleared.';
    },
  },
  {
    name: 'provider',
    description: 'Show/change AI provider',
    usage: '/provider [name]',
    handler: async () => `Current provider: ${chalk.cyan('OpenAI')}\nAvailable: OpenAI, Anthropic`,
  },
  {
    name: 'model',
    description: 'List available models',
    handler: async () => `${chalk.bold('Available Models:')}\n- gpt-4\n- gpt-3.5-turbo\n- claude-3-opus`,
  },
  {
    name: 'config',
    description: 'View configuration',
    handler: async () => `Configuration loaded from: ~/.ai-harness/config.json`,
  },
  {
    name: 'export',
    description: 'Export conversation',
    usage: '/export [format]',
    handler: async (args) => {
      const format = args[0] || 'json';
      return `Exporting as ${chalk.cyan(format)}...`; // TODO: Implement export
    },
  },
  {
    name: 'quit',
    description: 'Exit AiHarness',
    handler: async () => '',
  },
];

export class CommandHandler {
  private sessionManager: SessionManager;
  private exiting = false;

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
  }

  /** Execute a command */
  async execute(input: string, currentSession: unknown): Promise<void> {
    const parts = input.slice(1).trim().split(/\s+/);
    const commandName = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    if (!commandName) return;

    const cmd = commands.find((c) => c.name === commandName || c.name.startsWith(commandName));

    if (!cmd) {
      process.stdout.write(`Unknown command: ${chalk.red(commandName)}\n`);
      process.stdout.write('Type /help for available commands.\n');
      return;
    }

    // Special handling for help and quit
    if (commandName === 'quit' || commandName === 'exit') {
      this.exiting = true;
      return;
    }

    const output = await cmd.handler(args, this.sessionManager);
    if (output) {
      process.stdout.write(`${output}\n\n`);
    }
  }

  isExiting(): boolean {
    return this.exiting;
  }
}
