import {
  parseShellCommandInput,
  ShellCommandRuntime,
  type SessionManager,
  type ShellCommandEvent,
  type ShellCommandRuntimeOptions,
} from '@ai-harness/core';
import type { TerminalUI } from '../tui/terminal-ui.js';

export interface InteractiveShellContext {
  getSessionId(): string;
  getCwd(): string;
  isTrusted(cwd: string): boolean | Promise<boolean>;
  reportError(message: string): void;
}

/** Interactive adapter around Core's CLI/Web shell runtime. */
export class InteractiveShellController {
  private readonly runtime: ShellCommandRuntime;
  private activeCommandId?: string;

  constructor(
    sessions: SessionManager,
    private readonly terminal: TerminalUI,
    private readonly context: InteractiveShellContext,
    runtimeOptions: ShellCommandRuntimeOptions = {},
  ) {
    this.runtime = new ShellCommandRuntime(sessions, {
      maxOutputBytes: 50 * 1024,
      outputTruncation: 'tail',
      retainFullOutput: true,
      ...runtimeOptions,
    });
  }

  /** Return false when input is not shell syntax, otherwise consume it. */
  async handle(input: string): Promise<boolean> {
    const parsed = parseShellCommandInput(input);
    if (!parsed) return false;
    if (!parsed.command) {
      this.context.reportError('Saisissez une commande après ! ou !!.');
      return true;
    }
    if (this.activeCommandId) {
      this.context.reportError('Une commande shell est déjà en cours.');
      return true;
    }

    const cwd = this.context.getCwd();
    if (!await this.context.isTrusted(cwd)) {
      this.context.reportError("Approuvez le workspace actif avec /trust add avant d'exécuter une commande.");
      return true;
    }

    const writer = this.terminal.startShellCommand(parsed.command, parsed.excludedFromContext);
    const onEvent = (event: ShellCommandEvent): void => {
      if (event.type === 'output' && typeof event.data.chunk === 'string') writer.write(event.data.chunk);
    };

    try {
      const started = this.runtime.start({
        sessionId: this.context.getSessionId(),
        command: parsed.command,
        cwd,
        excludedFromContext: parsed.excludedFromContext,
      }, onEvent);
      this.activeCommandId = started.id;
      const completed = await this.runtime.wait(started.id);
      if (!completed) throw new Error('La commande shell a disparu avant sa terminaison.');
      writer.finish({
        status: completed.status === 'running' ? 'failed' : completed.status,
        exitCode: completed.exitCode,
        truncated: completed.truncated,
        fullOutputPath: completed.fullOutputPath,
      });
    } catch (error) {
      this.context.reportError(error instanceof Error ? error.message : String(error));
      writer.finish({ status: 'failed', exitCode: 1, truncated: false });
    } finally {
      this.activeCommandId = undefined;
    }
    return true;
  }

  abort(): boolean {
    if (!this.activeCommandId) return false;
    this.runtime.cancel(this.activeCommandId);
    return true;
  }

  async close(): Promise<void> {
    await this.runtime.shutdown();
    this.activeCommandId = undefined;
  }
}
