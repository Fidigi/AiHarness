// ============================================================
// Terminal UI - TUI Component
// ============================================================

import chalk from 'chalk';

export interface TerminalOptions {
  title?: string;
  theme?: 'dark' | 'light';
}

/** Manages terminal output and display */
export class TerminalUI {
  private options: Required<TerminalOptions>;

  constructor(options: TerminalOptions = {}) {
    this.options = {
      title: options.title || 'AiHarness',
      theme: options.theme || 'dark',
    };
  }

  /** Display welcome screen */
  welcome(): void {
    console.clear();
    console.log(chalk.bold.blue(`╔══════════════════════════════════╗`));
    console.log(chalk.bold.blue(`║        ${chalk.bold.cyan('AiHarness CLI')}              ║`));
    console.log(chalk.bold.blue(`║      Unified AI Agent Platform   ║`));
    console.log(chalk.bold.blue(`╚══════════════════════════════════╝`));
    console.log();
    console.log(chalk.dim('Type /help for available commands'));
    console.log();
  }

  /** Display user message */
  displayUserMessage(content: string): void {
    console.log(chalk.bold.green(`> ${content}`));
    console.log();
  }

  /** Display assistant response with streaming effect */
  displayAssistantMessage(content: string, stream?: boolean): void {
    if (stream) {
      // TODO: Implement streaming display
      process.stdout.write(chalk.cyan(content));
    } else {
      console.log(chalk.dim('┌─ Assistant'));
      console.log(chalk.white(`│ ${content}`));
      console.log(chalk.dim('└──────────────'));
    }
    console.log();
  }

  /** Display command output */
  displayCommand(name: string, output: string): void {
    console.log(chalk.yellow(`[${name}]`));
    console.log(output);
    console.log();
  }

  /** Display error message */
  showError(message: string): void {
    console.error(chalk.red(`[Error] ${message}`));
    console.log();
  }

  /** Show help menu */
  showHelp(): void {
    const helpText = `
${chalk.bold('Available Commands:')}

  ${chalk.cyan('/help')}        Show this help message
  ${chalk.cyan('/new')}         Create a new conversation
  ${chalk.cyan('/list')}         List all conversations
  ${chalk.cyan('/switch <id>')}   Switch to a different conversation
  ${chalk.cyan('/delete <id>')}   Delete a conversation
  ${chalk.cyan('/clear')}        Clear the current conversation
  ${chalk.cyan('/provider')}      Show/change AI provider
  ${chalk.cyan('/model')}         List available models
  ${chalk.cyan('/config')}       View/edit configuration
  ${chalk.cyan('/export')}       Export conversation
  ${chalk.cyan('/quit')} or /exit   Exit AiHarness

${chalk.bold('Keyboard Shortcuts:')}
  ${chalk.dim('(Coming soon in TUI mode)')}
`;
    console.log(helpText);
  }

  /** Display exit message */
  exitMessage(message: string): void {
    console.log(chalk.green(`\n${message}`));
  }

  /** Clear terminal */
  clear(): void {
    process.stdout.write('\x1Bc');
  }
}
