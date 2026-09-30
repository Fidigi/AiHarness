import chalk from 'chalk';
import { TerminalUI, type TerminalOptions, type TranscriptEntry } from './terminal-ui.js';

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

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

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

  setPanelProvider(provider: () => string[]): void {
    this.panelProvider = provider;
    this.render();
  }

  setPrompt(label: string): void {
    this.promptLabel = label || '> ';
    this.render();
  }

  setInput(value: string, cursor: number = value.length): void {
    this.inputValue = value;
    this.inputCursor = Math.max(0, Math.min(value.length, cursor));
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
    super.addTranscriptEntry(entry);
    this.screenEntries.push(entry);
    if (this.screenEntries.length > 500) this.screenEntries.shift();
    this.scrollOffset = 0;
    this.render();
  }

  writeOutput(output: string): void {
    if (!output) return;
    this.screenEntries.push({ type: 'command', content: this.stripAnsi(output) });
    if (this.screenEntries.length > 500) this.screenEntries.shift();
    this.scrollOffset = 0;
    this.render();
  }

  displayCommand(name: string, output: string): void {
    this.writeOutput(`[${name}]\n${output}`);
  }

  showError(message: string): void {
    this.screenEntries.push({ type: 'system', content: `[Erreur] ${message}` });
    this.status = 'Erreur';
    this.render();
  }

  showHelp(): void {
    this.writeOutput([
      'Commandes principales',
      '/help · /new [titre] · /list [filtre] · /switch <id>',
      '/provider · /model · /compact · /search <texte>',
      '/edit · /export · /import · /extensions · /tools · /reload · /exit',
      '',
      'Navigation : ↑/↓ historique · Alt+↑/↓ transcript · Ctrl+L rafraîchir',
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
    this.status = message;
    this.render();
    this.leave();
    process.stdout.write(`${message}\n`);
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

  startStreaming(): { write: (text: string) => void; finish: () => void; cancel: () => void } {
    this.isStreaming = true;
    this.streamingContent = '';
    this.status = 'Réponse en cours…';
    this.render();

    return {
      write: (text: string) => {
        if (!this.isStreaming) return;
        this.streamingContent += text;
        this.render();
      },
      finish: () => {
        this.isStreaming = false;
        this.streamingContent = '';
        this.status = 'Réponse terminée';
        this.render();
      },
      cancel: () => {
        this.isStreaming = false;
        this.streamingContent = '';
        this.status = 'Réponse interrompue';
        this.render();
      },
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

    const width = Math.max(20, this.configuredColumns ?? this.output.columns ?? 80);
    const height = Math.max(8, this.configuredRows ?? this.output.rows ?? 24);
    const innerWidth = Math.max(1, width - 2);
    const panels = (this.panelProvider?.() ?? []).flatMap(panel => this.wrap(this.stripAnsi(panel), width));
    const viewportHeight = Math.max(1, height - 5 - panels.length);
    const separator = '─'.repeat(width);
    const title = this.fit(` AiHarness CLI · ${this.status} `, width);
    const transcript = this.getRenderedTranscriptLines();
    const streaming = this.streamingContent
      ? this.wrap(`Assistant: ${this.streamingContent}`, innerWidth)
      : [];
    const allLines = [...transcript, ...streaming];
    const end = Math.max(0, allLines.length - this.scrollOffset);
    const start = Math.max(0, end - viewportHeight);
    const visible = allLines.slice(start, end);

    while (visible.length < viewportHeight) visible.unshift('');

    const input = this.stripAnsi(`${this.promptLabel}${this.inputValue}`).slice(0, width);
    const cursorFromEnd = Math.max(0, this.inputValue.length - this.inputCursor);
    const cursorMove = cursorFromEnd > 0 ? `\u001b[${cursorFromEnd}D` : '';
    const frame = [
      chalk.bold.hex(this.theme.colors.accent)(title),
      ...panels.map(panel => this.fit(panel, width)),
      separator,
      ...visible.map(line => this.fit(line, width)),
      separator,
      input,
    ].join('\n');

    this.output.write(`\u001b[2J\u001b[H${frame}${cursorMove}`);
  }

  private getRenderedTranscriptLines(): string[] {
    const width = Math.max(18, (this.configuredColumns ?? this.output.columns ?? 80) - 2);
    return this.screenEntries.flatMap(entry => {
      const prefix = entry.type === 'user'
        ? 'Vous: '
        : entry.type === 'assistant'
          ? 'Assistant: '
          : entry.type === 'system'
            ? 'Système: '
            : 'Commande: ';
      return this.wrap(`${prefix}${this.stripAnsi(entry.content)}`, width);
    });
  }

  private wrap(value: string, width: number): string[] {
    const lines: string[] = [];
    for (const sourceLine of value.split('\n')) {
      if (!sourceLine) {
        lines.push('');
        continue;
      }
      for (let offset = 0; offset < sourceLine.length; offset += width) {
        lines.push(sourceLine.slice(offset, offset + width));
      }
    }
    return lines;
  }

  private fit(value: string, width: number): string {
    const plain = this.stripAnsi(value);
    if (plain.length >= width) return plain.slice(0, width);
    return plain + ' '.repeat(width - plain.length);
  }

  private stripAnsi(value: string): string {
    return value.replace(ANSI_PATTERN, '');
  }
}
