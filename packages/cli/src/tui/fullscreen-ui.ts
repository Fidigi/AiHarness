import chalk from 'chalk';
import {
  TerminalUI,
  type ShellCommandWriter,
  type TerminalOptions,
  type TranscriptEntry,
} from './terminal-ui.js';
import { statusLines } from './status.js';
import { clipTerminalText, plainTerminalText, tailTerminalText, terminalWidth, wrapTerminalText } from './terminal-text.js';

interface ScreenWriter {
  write(chunk: string): unknown;
  columns?: number;
  rows?: number;
  isTTY?: boolean;
}

export interface FullscreenOptions extends TerminalOptions {
  output?: ScreenWriter;
  columns?: number;
  rows?: number;
}

interface ScreenEntry {
  type: TranscriptEntry['type'];
  content: string;
}

const MAX_SCREEN_BYTES = 16 * 1024 * 1024;
const MAX_SCREEN_ENTRY_BYTES = 1024 * 1024;

/**
 * Fullscreen terminal backend based on the ANSI alternate screen.
 *
 * It deliberately uses Node terminal primitives instead of a native ncurses
 * addon, which keeps the CLI portable on supported Node versions and in the
 * project's slim Docker image.
 */
export class FullscreenUI extends TerminalUI {
  private readonly output: ScreenWriter;
  private readonly configuredColumns?: number;
  private readonly configuredRows?: number;
  private readonly screenEntries: ScreenEntry[] = [];
  private screenBytes = 0;
  private active = false;
  private promptLabel = '> ';
  private inputValue = '';
  private inputCursor = 0;
  private status = 'Prêt';
  private streamingContent = '';
  private scrollOffset = 0;
  private panelProvider?: () => string[];

  constructor(options: FullscreenOptions = {}) {
    super(options);
    this.output = options.output ?? process.stdout;
    this.configuredColumns = options.columns;
    this.configuredRows = options.rows;
  }

  static isSupported(
    input: Pick<NodeJS.ReadStream, 'isTTY' | 'setRawMode'> = process.stdin,
    output: Pick<NodeJS.WriteStream, 'isTTY'> = process.stdout,
  ): boolean {
    return Boolean(input.isTTY && output.isTTY && typeof input.setRawMode === 'function');
  }

  isActive(): boolean {
    return this.active;
  }

  enter(): void {
    if (this.active) return;
    this.active = true;
    this.output.write('\u001b[?1049h\u001b[?25h');
    this.render();
  }

  leave(): void {
    if (!this.active) return;
    this.active = false;
    this.output.write('\u001b[?25h\u001b[?1049l');
  }

  welcome(): void {
    this.enter();
    this.status = 'Tapez /help pour afficher les commandes';
    this.render();
  }

  protected override onThemeChanged(): void {
    this.render();
  }

  protected override onStatusChanged(): void { this.render(); }

  override displayStatus(): void { this.render(); }

  setPanelProvider(provider: () => string[]): void {
    this.panelProvider = provider;
    this.render();
  }

  setPrompt(label: string): void {
    this.promptLabel = this.safeText(label).replace(/[\n\t]/g, ' ') || '> ';
    this.render();
  }

  setInput(value: string, cursor: number = value.length): void {
    this.inputValue = this.safeText(value);
    this.inputCursor = Math.min(this.inputValue.length,
      this.safeText(value.slice(0, Math.max(0, Math.min(value.length, cursor)))).length);
    this.render();
  }

  displayUserMessage(_content: string): void {
    this.status = 'Message envoyé';
    this.render();
  }

  displayAssistantMessage(content: string): void {
    this.addTranscriptEntry({ type: 'assistant', content });
  }

  addTranscriptEntry(entry: Omit<TranscriptEntry, 'timestamp'>): void {
    const safeEntry = { ...entry, content: this.safeText(entry.content) };
    super.addTranscriptEntry(safeEntry);
    this.addScreenEntry(safeEntry);
    this.scrollOffset = 0;
    this.render();
  }

  writeOutput(output: string): void {
    if (!output) return;
    this.addScreenEntry({ type: 'command', content: this.stripAnsi(this.safeText(output)) });
    this.scrollOffset = 0;
    this.render();
  }

  override writeExplicitCredentialReveal(output: string): void {
    const wasActive = this.active;
    if (wasActive) this.leave();
    process.stdout.write(`${output}\n\n`);
    if (wasActive) this.enter();
  }

  displayCommand(name: string, output: string): void {
    this.writeOutput(`[${name}]\n${output}`);
  }

  showError(message: string): void {
    this.addScreenEntry({ type: 'system', content: `[Erreur] ${this.safeText(message)}` });
    this.status = 'Erreur';
    this.render();
  }

  showHelp(): void {
    this.writeOutput([
      'Commandes principales',
      '/help · /new [titre] · /list [filtre] · /switch <id>',
      '/provider · /model · /compact · /search <texte>',
      '/edit · /export · /import · /settings · /extensions · /tools · /trust · /reload · /exit',
      '!commande (contexte) · !!commande (hors contexte)',
      '',
      'Entrée : envoyer/steer · Alt+Entrée ou Ctrl+Q : follow-up · Alt+↑ : rappeler la file',
      'Escape/Ctrl+C : interrompre · ↑/↓ historique · Alt+↓ transcript · Ctrl+L rafraîchir',
    ].join('\n'));
  }

  displaySearchResults(query: string): void {
    const result = this.searchTranscript(query);
    if (result.matches.length === 0) {
      this.writeOutput(`Aucun résultat pour « ${query} »`);
      return;
    }

    const lines = result.matches.map(entry => {
      const label = entry.type === 'user' ? 'Vous' : 'Assistant';
      return `${label}: ${entry.content}`;
    });
    this.writeOutput(`Résultats pour « ${query} » (${result.totalMatches})\n${lines.join('\n\n')}`);
  }

  exitMessage(message: string): void {
    const safe = this.safeText(message);
    this.status = safe;
    this.render();
    this.leave();
    process.stdout.write(`${safe}\n`);
  }

  clear(): void {
    this.render();
  }

  startMultiLineEditor(): void {
    this.isMultiLineMode = true;
    this.multiLineBuffer = [];
    this.status = 'Mode multi-lignes · /send pour envoyer · /cancel pour annuler';
    this.render();
  }

  cancelMultiLineEditor(): void {
    this.exitMultiLineEditor();
    this.status = 'Édition multi-lignes annulée';
    this.render();
  }

  addMultiLineBuffer(line: string): void {
    super.addMultiLineBuffer(line);
    this.status = `Mode multi-lignes · ${this.multiLineBuffer.length} ligne(s)`;
    this.render();
  }

  startShellCommand(command: string, excludedFromContext: boolean): ShellCommandWriter {
    const policy = excludedFromContext ? 'hors contexte modèle' : 'inclus dans le contexte modèle';
    const safeCommand = this.safeText(command);
    const entry: ScreenEntry = { type: 'command', content: `$ ${safeCommand}\n(${policy})` };
    this.addScreenEntry(entry);
    super.addTranscriptEntry({ type: 'command', content: `$ ${safeCommand} (${policy})` });
    const redactor = this.createSafeTextRedactor();
    let output = '';
    let outputBounded = false;
    this.status = 'Commande en cours…';
    this.render();
    const append = (chunk: string): void => {
      output += chunk;
      if (output.length > 50_000) {
        output = output.slice(-50_000);
        outputBounded = true;
      }
      this.updateScreenEntry(entry, `$ ${safeCommand}\n(${policy})\n${outputBounded ? '[… sortie précédente masquée …]\n' : ''}${output}`);
    };
    return {
      write: chunk => {
        append(redactor.push(chunk));
        this.render();
      },
      finish: summary => {
        append(redactor.flush());
        const status = summary.status === 'cancelled'
          ? 'annulée'
          : `code ${summary.exitCode ?? 'inconnu'}`;
        const details = [status, summary.truncated ? 'tronquée' : undefined].filter(Boolean).join(' · ');
        this.updateScreenEntry(
          entry,
          `$ ${safeCommand}\n(${policy})\n${outputBounded ? '[… sortie précédente masquée …]\n' : ''}${output || '(aucune sortie)'}\n[${details}]${summary.fullOutputPath ? `\n[sortie complète : ${this.safeText(summary.fullOutputPath)}]` : ''}`,
        );
        this.status = summary.status === 'cancelled' ? 'Commande interrompue' : 'Commande terminée';
        this.render();
      },
    };
  }

  startStreaming(): { write: (text: string) => void; finish: () => void; cancel: () => void } {
    this.isStreaming = true;
    this.streamingContent = '';
    this.status = 'Réponse en cours…';
    const redactor = this.createSafeTextRedactor();
    this.render();
    const append = (text: string): void => {
      if (!text) return;
      this.streamingContent += text;
      if (Buffer.byteLength(this.streamingContent) > MAX_SCREEN_ENTRY_BYTES) {
        this.streamingContent = '[… réponse précédente masquée …]\n'
          + this.streamingContent.slice(-Math.floor(MAX_SCREEN_ENTRY_BYTES / 2));
      }
    };
    const finish = (status: string): void => {
      append(redactor.flush());
      this.isStreaming = false;
      this.streamingContent = '';
      this.status = status;
      this.render();
    };
    return {
      write: (text: string) => {
        if (!this.isStreaming) return;
        append(redactor.push(text));
        this.render();
      },
      finish: () => finish('Réponse terminée'),
      cancel: () => finish('Réponse interrompue'),
    };
  }

  scrollUp(lines = 3): void {
    this.scrollOffset = Math.min(this.getRenderedTranscriptLines().length, this.scrollOffset + lines);
    this.render();
  }

  scrollDown(lines = 3): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - lines);
    this.render();
  }

  render(): void {
    if (!this.active) return;

    const width = Math.max(1, this.configuredColumns ?? this.output.columns ?? 80);
    const height = Math.max(2, this.configuredRows ?? this.output.rows ?? 24);
    const innerWidth = Math.max(1, width - 2);
    const panels = (this.panelProvider?.() ?? [])
      .slice(0, 32)
      .flatMap(panel => this.wrap(this.stripAnsi(this.safeText(panel)), width))
      .slice(0, Math.max(0, height - 7));
    const footerBudget = Math.max(0, height - 6 - panels.length);
    const footer = this.terminalStatus
      ? statusLines(this.terminalStatus, this.editorStatus(), width, footerBudget)
        .map(line => chalk.hex(this.theme.colors.muted)(this.safeText(line))) : [];
    const viewportHeight = Math.max(0, height - 4 - panels.length - footer.length);
    const separator = chalk.hex(this.theme.colors.borderMuted)('─'.repeat(width));
    const title = this.fit(` AiHarness CLI · ${this.safeText(this.status).replace(/\s+/g, ' ')} `, width);
    const transcript = this.getRenderedTranscriptLines();
    const streaming = this.streamingContent
      ? this.wrap(`Assistant: ${this.streamingContent}`, innerWidth)
          .map(line => chalk.hex(this.theme.colors.text)(line))
      : [];
    const allLines = [...transcript, ...streaming];
    const end = Math.max(0, allLines.length - this.scrollOffset);
    const start = Math.max(0, end - viewportHeight);
    const visible = allLines.slice(start, end);

    while (visible.length < viewportHeight) visible.unshift('');

    const before = `${this.promptLabel}${this.inputValue.slice(0, this.inputCursor)}`.replace(/[\n\t]/g, ' ');
    const after = this.inputValue.slice(this.inputCursor).replace(/[\n\t]/g, ' ');
    // Horizontal editor window keeps the real caret visible after shrink/resize.
    const windowBefore = tailTerminalText(before, width - 1);
    const safeInput = clipTerminalText(windowBefore + after, width);
    const input = chalk.hex(this.theme.colors.accent)(safeInput);
    const cursorFromEnd = Math.max(0, terminalWidth(safeInput) - terminalWidth(windowBefore));
    const cursorMove = cursorFromEnd > 0 ? `\u001b[${cursorFromEnd}D` : '';
    const frame = [
      chalk.bold.hex(this.theme.colors.accent)(title),
      ...panels.map(panel => this.fit(panel, width)),
      separator,
      ...visible.map(line => this.fit(line, width)),
      separator,
      ...footer.map(line => this.fit(line, width)),
      input,
    ].slice(-(height)).join('\n');

    this.output.write(`\u001b[2J\u001b[H${frame}${cursorMove}`);
  }

  private addScreenEntry(entry: ScreenEntry): void {
    if (Buffer.byteLength(entry.content) > MAX_SCREEN_ENTRY_BYTES) {
      entry.content = '[REDACTED: terminal output exceeded safe limit]';
    }
    this.screenEntries.push(entry);
    this.screenBytes += Buffer.byteLength(entry.content);
    while (this.screenEntries.length > 500 || this.screenBytes > MAX_SCREEN_BYTES) {
      const removed = this.screenEntries.shift();
      if (removed) this.screenBytes -= Buffer.byteLength(removed.content);
    }
  }

  private updateScreenEntry(entry: ScreenEntry, content: string): void {
    if (!this.screenEntries.includes(entry)) return;
    this.screenBytes -= Buffer.byteLength(entry.content);
    entry.content = Buffer.byteLength(content) <= MAX_SCREEN_ENTRY_BYTES
      ? content
      : '[REDACTED: terminal output exceeded safe limit]';
    this.screenBytes += Buffer.byteLength(entry.content);
    while (this.screenEntries.length > 1 && this.screenBytes > MAX_SCREEN_BYTES) {
      const removed = this.screenEntries.shift();
      if (removed) this.screenBytes -= Buffer.byteLength(removed.content);
    }
  }

  private getRenderedTranscriptLines(): string[] {
    const width = Math.max(1, (this.configuredColumns ?? this.output.columns ?? 80) - 2);
    return this.screenEntries.flatMap(entry => {
      const prefix = entry.type === 'user'
        ? 'Vous: '
        : entry.type === 'assistant'
          ? 'Assistant: '
          : entry.type === 'system'
            ? 'Système: '
            : 'Commande: ';
      const color = entry.type === 'user'
        ? this.theme.colors.userMessageText
        : entry.type === 'assistant'
          ? this.theme.colors.text
          : entry.type === 'command'
            ? this.theme.colors.toolOutput
            : this.theme.colors.muted;
      return this.wrap(`${prefix}${this.stripAnsi(entry.content)}`, width)
        .map(line => chalk.hex(color)(line));
    });
  }

  private wrap(value: string, width: number): string[] {
    return wrapTerminalText(value, width);
  }

  private fit(value: string, width: number): string {
    const clipped = clipTerminalText(value, width);
    return clipped + ' '.repeat(Math.max(0, width - terminalWidth(clipped)));
  }

  private stripAnsi(value: string): string {
    return plainTerminalText(value);
  }
}
