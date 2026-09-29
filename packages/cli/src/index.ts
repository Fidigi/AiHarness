#!/usr/bin/env node
// ============================================================
// AiHarness CLI - Main Entry Point
// ============================================================

import { SessionManager } from '@ai-harness/core';
import readline from 'readline';
import { CommandHandler } from './commands/handler';
import { TerminalUI } from './tui/terminal-ui';

async function main(): Promise<void> {
  const sessionManager = new SessionManager();
  const terminal = new TerminalUI({ title: 'AiHarness CLI' });
  const commandHandler = new CommandHandler(sessionManager, terminal);

  // Create default session if none exists
  let currentSession = sessionManager.list()[0];
  if (!currentSession) {
    currentSession = sessionManager.create({ title: 'New Conversation' });
  }

  terminal.welcome();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${currentSession.title || '>'} `,
  });

  rl.on('line', async (input) => {
    const trimmed = input.trim();

    if (!trimmed) return;

    // Handle commands (starting with /)
    if (trimmed.startsWith('/')) {
      await commandHandler.execute(trimmed, currentSession);
      if (!commandHandler.isExiting()) {
        rl.prompt();
      } else {
        rl.close();
      }
      return;
    }

    // Handle regular messages
    sessionManager.addMessage(currentSession.id, {
      role: 'user',
      content: trimmed,
    });

    terminal.displayUserMessage(trimmed);

    // TODO: Call AI provider and display response
    await new Promise((resolve) => setTimeout(resolve, 500));
    const mockResponse = `This is a placeholder response to your message: "${trimmed}"`;
    
    sessionManager.addMessage(currentSession.id, {
      role: 'assistant',
      content: mockResponse,
    });

    terminal.displayAssistantMessage(mockResponse);
    rl.prompt();
  });

  process.on('SIGINT', () => {
    terminal.exitMessage('Goodbye! 👋');
    process.exit(0);
  });

  rl.prompt();
}

main().catch(console.error);
