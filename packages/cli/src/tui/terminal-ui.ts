// ============================================================
// Terminal UI - Enhanced TUI Component with Streaming Support
// Features: scrollable transcript, character-by-character streaming,
// fullscreen/regular mode toggle, markdown-like rendering
// ============================================================

import chalk from 'chalk';
import type { Interface, Key } from 'readline';
import { ThemeManager, type TerminalTheme } from './theme-manager.js';
import { statusLines, type TerminalStatus } from './status.js';
import { TerminalTextFilter, terminalText, wrapTerminalText } from './terminal-text.js';

interface TerminalTextRedactor {
  push(chunk: string): string;
  flush(): string;
}

export interface TerminalOptions {
  title?: string;
  theme?: 'dark' | 'light' | TerminalTheme;
  redactText?: (value: string) => string;
  createTextRedactor?: () => TerminalTextRedactor;
}

export interface TranscriptEntry {
  type: 'user' | 'assistant' | 'system' | 'command';
  content: string;
  timestamp: Date;
}

export interface ShellCommandSummary {
  status: 'completed' | 'failed' | 'cancelled';
  exitCode?: number;
  truncated: boolean;
  fullOutputPath?: string;
}

export interface ShellCommandWriter {
  write(chunk: string): void;
  finish(summary: ShellCommandSummary): void;
}

const MAX_TERMINAL_TEXT_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

/** Manages terminal output with scrollable transcript and streaming support */
export class TerminalUI {
  private options: { title: string; theme: 'dark' | 'light' | TerminalTheme };
  protected theme: TerminalTheme;
  protected isStreaming = false;
  private readonly redact: (value: string) => string;
  private readonly createTextRedactor?: () => TerminalTextRedactor;
  protected terminalStatus?: TerminalStatus;

  /** Composition owns snapshots; rendering never reads journals or contacts providers. */
  setStatus(status: TerminalStatus): void {
    this.terminalStatus = structuredClone(status);
    this.onStatusChanged();
  }

  protected onStatusChanged(): void { /* Regular output is printed at prompt boundaries. */ }

  protected editorStatus(): string {
    return this.isMultiLineMode ? `multiline (${this.multiLineBuffer.length} lines)`
      : this.isStreaming ? 'ready · Enter steer · Alt+Enter follow-up' : 'ready · Enter send · /edit multiline';
  }

  /** Call before restoring readline's prompt, never in the middle of a stream. */
  displayStatus(): void {
    if (!this.terminalStatus || this.isStreaming) return;
    const width = Math.max(1, process.stdout.columns ?? 80);
    for (const line of statusLines(this.terminalStatus, this.editorStatus(), width)) {
      console.log(chalk.hex(this.theme.colors.muted)(this.safeText(line)));
    }
  }
  
  // Transcript for session conversations (scrollable)
  private transcript: TranscriptEntry[] = [];
  private transcriptBytes = 0;
  private readonly maxTranscriptEntries = 500;
  private scrollPosition = 0;
  private isScrolling = false;

  // Multi-line editor state
  protected isMultiLineMode = false;
  protected multiLineBuffer: string[] = [];
  protected readonly maxMultiLineLines = 100;

  constructor(options: TerminalOptions = {}) {
    this.redact = options.redactText ?? (value => value);
    this.createTextRedactor = options.createTextRedactor;
    const mode = typeof options.theme === 'string' ? options.theme : options.theme?.mode || 'dark';
    this.theme = typeof options.theme === 'object'
      ? options.theme
      : ThemeManager.builtins().find(theme => theme.mode === mode)!;
    this.options = {
      title: options.title || 'AiHarness',
      theme: options.theme || this.theme,
    };
  }

  /** Replace the active palette without rebuilding the runtime. */
  setTheme(theme: TerminalTheme): void {
    this.theme = theme;
    this.options.theme = theme;
    this.onThemeChanged();
  }

  protected onThemeChanged(): void {
    // Regular terminals apply colors on their next write.
  }

  protected safeText(value: string, allowSgr = false): string {
    const safe = terminalText(this.redact(value), allowSgr);
    return Buffer.byteLength(safe) <= MAX_TERMINAL_TEXT_BYTES
      ? safe
      : '[REDACTED: terminal output exceeded safe limit]';
  }

  protected createSafeTextRedactor(): TerminalTextRedactor {
    const redactor = this.createTextRedactor?.() ?? {
      push: (chunk: string) => this.redact(chunk),
      flush: () => '',
    };
    const filter = new TerminalTextFilter();
    const bounded = (value: string): string => Buffer.byteLength(value) <= MAX_TERMINAL_TEXT_BYTES
      ? filter.push(value) : '[REDACTED: terminal output exceeded safe limit]';
    return { push: chunk => bounded(redactor.push(chunk)), flush: () => bounded(redactor.flush()) };
  }

  /** Display welcome screen */
  welcome(): void {
    console.clear();
    const accent = chalk.bold.hex(this.theme.colors.accent);
    const dim = chalk.hex(this.theme.colors.muted);

    const width = Math.max(1, process.stdout.columns ?? 80);
    for (const line of wrapTerminalText(this.safeText(this.options.title), width)) console.log(accent(line));
    this.displayStatus();
    console.log();
    for (const hint of [
      '  Type /help for available commands',
      '  Providers: mock, openai, anthropic, google, local, azure, vertex, bedrock',
      '  Tip: Use Escape or Ctrl+C to interrupt active work',
    ]) for (const line of wrapTerminalText(hint, width)) console.log(dim(line));
    console.log();
  }

  /** Display user message */
  displayUserMessage(content: string): void {
    // Clear any streaming output first
    if (this.isStreaming) {
      this.clearCurrentLine();
      process.stdout.write('\n');
    }

    const prompt = chalk.bold.hex(this.theme.colors.userMessageText)('you> ');
    console.log(prompt + this.safeText(content));
  }

  /** Display assistant response (non-streaming, for /command output) */
  displayAssistantMessage(content: string): void {
    if (this.isStreaming) {
      this.clearCurrentLine();
      process.stdout.write('\n');
    }

    const border = chalk.hex(this.theme.colors.borderMuted);
    const body = chalk.hex(this.theme.colors.text);
    console.log(border('┌─ Assistant'));
    // Render Markdown before formatting the assistant frame.
    const lines = this.renderMarkdown(this.safeText(content)).split('\n');
    for (const line of lines) console.log(border('│ ') + body(line));
    console.log(border('└──────────────'));
    console.log();
  }

  /** Display streaming response character by character */
  async displayStreamingResponse(
    _onChunk: (chunk: string) => void,
    onComplete?: () => void,
    onError?: (error: Error) => void,
  ): Promise<void> {
    this.isStreaming = true;

    // Print header
    process.stdout.write(chalk.hex(this.theme.colors.borderMuted)('┌─ Assistant\n│ '));

    try {
      await new Promise<void>((resolve, reject) => {
        const streamPromise = (async () => {
          // The caller drives the streaming via onChunk callback
          resolve();
        })();

        streamPromise.then(resolve).catch(reject);
      });

      process.stdout.write('\n');
      console.log(chalk.hex(this.theme.colors.borderMuted)('└──────────────'));
      onComplete?.();
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      this.isStreaming = false;
    }
  }

  /** Start a streaming response and return control for adding chunks */
  startStreaming(): {
    write: (text: string) => void;
    finish: () => void;
    cancel: () => void;
  } {
    this.isStreaming = true;
    const border = chalk.hex(this.theme.colors.borderMuted);
    const redactor = this.createSafeTextRedactor();
    process.stdout.write(border('┌─ Assistant\n│ '));
    const write = (text: string): void => {
      if (!text) return;
      if (text.includes('\n')) {
        const parts = text.split('\n');
        for (let i = 0; i < parts.length; i++) {
          process.stdout.write(parts[i]);
          if (i < parts.length - 1) process.stdout.write('\n' + border('│ '));
        }
      } else process.stdout.write(text);
    };

    return {
      write: (text: string) => write(redactor.push(text)),
      finish: () => {
        write(redactor.flush());
        console.log('\n' + border('└──────────────'));
        this.isStreaming = false;
      },
      cancel: () => {
        write(redactor.flush());
        console.log(chalk.hex(this.theme.colors.warning)('[Interrupted]'));
        this.isStreaming = false;
      },
    };
  }

  /** Write unframed command output. Fullscreen backends override this sink. */
  writeOutput(output: string): void {
    process.stdout.write(`${this.safeText(output, true)}\n\n`);
  }

  /** Deliberate local-only bypass used solely by `/credential reveal <provider>`. */
  writeExplicitCredentialReveal(output: string): void {
    process.stdout.write(`${output}\n\n`);
  }

  /** Stream a direct `!`/`!!` command without buffering unbounded terminal output. */
  startShellCommand(command: string, excludedFromContext: boolean): ShellCommandWriter {
    const policy = excludedFromContext ? 'excluded from model context' : 'included in model context';
    process.stdout.write(`${chalk.hex(this.theme.colors.bashMode)(`[shell] $ ${this.safeText(command)}`)} ${chalk.hex(this.theme.colors.dim)(`(${policy})`)}\n`);
    const redactor = this.createSafeTextRedactor();
    let wroteOutput = false;
    let endedWithNewline = true;
    return {
      write: chunk => {
        const safe = redactor.push(chunk);
        if (!safe) return;
        wroteOutput = true;
        endedWithNewline = safe.endsWith('\n');
        process.stdout.write(safe);
      },
      finish: summary => {
        const suffix = redactor.flush();
        if (suffix) {
          wroteOutput = true;
          endedWithNewline = suffix.endsWith('\n');
          process.stdout.write(suffix);
        }
        if (wroteOutput && !endedWithNewline) process.stdout.write('\n');
        if (!wroteOutput) process.stdout.write(chalk.dim('(no output)\n'));
        const status = summary.status === 'cancelled'
          ? 'cancelled'
          : `exit ${summary.exitCode ?? 'unknown'}`;
        process.stdout.write(chalk.dim(`[${status}${summary.truncated ? ' · truncated' : ''}]\n`));
        if (summary.fullOutputPath) {
          process.stdout.write(chalk.dim(`[full output: ${this.safeText(summary.fullOutputPath)}]\n`));
        }
        process.stdout.write('\n');
      },
    };
  }

  /** Display command output */
  displayCommand(name: string, output: string): void {
    if (this.isStreaming) {
      this.clearCurrentLine();
      process.stdout.write('\n');
    }
    console.log(chalk.hex(this.theme.colors.toolTitle)(`[${this.safeText(name)}]`));
    const lines = this.safeText(output).split('\n');
    for (const line of lines) {
      console.log(line);
    }
    console.log();
  }

  /** Display error message */
  showError(message: string): void {
    if (this.isStreaming) {
      this.clearCurrentLine();
      process.stdout.write('\n');
    }
    console.error(chalk.hex(this.theme.colors.error)(`[Error] ${this.safeText(message)}`));
    console.log();
  }

  /** Show help menu */
  showHelp(): void {
    const helpText = `
${chalk.bold('Available Commands:')}

${chalk.bold('Conversation and sessions')}
  ${chalk.cyan('/new [title]')}                 Create a conversation
  ${chalk.cyan('/list [search]')}               List or filter conversations
  ${chalk.cyan('/switch <id|number>')}          Switch conversation
  ${chalk.cyan('/name <title>')}                Rename the active conversation
  ${chalk.cyan('/delete <id>')}                 Delete a conversation
  ${chalk.cyan('/clear')}                       Clear the active conversation
  ${chalk.cyan('/session [-a|--all]')}          Show session statistics
  ${chalk.cyan('/search <text>')}               Search the transcript
  ${chalk.cyan('/copy')}                        Copy the last assistant response

${chalk.bold('Providers and context')}
  ${chalk.cyan('/provider [name]')}              List or select a provider
  ${chalk.cyan('/model [list|cycle|name]')}      List or select a model
  ${chalk.cyan('/thinking [level]')}             Set off/minimal/low/medium/high/xhigh/max
  ${chalk.cyan('/login <provider>')}             Start a configured OAuth device flow
  ${chalk.cyan('/compact [instructions]')}       Compact the active conversation
  ${chalk.cyan('/summarize-branch [id] [text]')} Store a branch summary
  ${chalk.cyan('/fork <id> [index] [title]')}    Fork a conversation
  ${chalk.cyan('/clone <id> [title]')}           Clone a conversation
  ${chalk.cyan('/tree [branch-id]')}             Show the session tree

${chalk.bold('Files, resources and sharing')}
  ${chalk.cyan('/export <format> [path]')}        Export json/markdown/jsonl/html
  ${chalk.cyan('/import <path>')}                Import JSON or JSONL sessions
  ${chalk.cyan('/share [hours]')}                Create a temporary share link
  ${chalk.cyan('/bug [description]')}            Prepare a GitHub issue URL
  ${chalk.cyan('/skills')}                       List discovered skills
  ${chalk.cyan('/skill:<name> [request]')}       Invoke a skill
  ${chalk.cyan('/prompts')}                      List prompt templates
  ${chalk.cyan('/<prompt> [arguments]')}         Expand a prompt template

${chalk.bold('Extensions and application')}
  ${chalk.cyan('/extensions')}                   List loaded extensions
  ${chalk.cyan('/tools')}                        List built-in and extension tools
  ${chalk.cyan('/tool <name> [json]')}           Run a registered tool
  ${chalk.cyan('/trust [status|allow|allow-parent|refuse|forget|list]')} Manage project trust decisions
  ${chalk.cyan('/reload')}                       Reload settings, resources and extensions
  ${chalk.cyan('/settings')}                     Show effective agent settings and sources
  ${chalk.cyan('/config')}                       Show storage configuration
  ${chalk.cyan('/help')}                         Show this help
  ${chalk.cyan('/quit')} or ${chalk.cyan('/exit')}                  Exit AiHarness

${chalk.bold('Input')}
  ${chalk.cyan('/edit')} / ${chalk.cyan('/send')} / ${chalk.cyan('/cancel')}          Multi-line input
  ${chalk.cyan('!<command>')}                    Run a shell command and include its output in context
  ${chalk.cyan('!!<command>')}                   Run a shell command outside model context
  ${chalk.cyan('Enter')}                         Send now, or steer an active response
  ${chalk.cyan('Alt+Enter / Ctrl+Q')}             Queue a follow-up after the active task
  ${chalk.cyan('Alt+Up')}                        Restore queued messages to the editor
  ${chalk.cyan('Ctrl+G')}                        Open $VISUAL or $EDITOR
  ${chalk.cyan('Escape / Ctrl+C')}               Interrupt; queued messages return to the editor

${chalk.bold('Providers:')}
  mock, openai, anthropic, google, local, azure, vertex, bedrock

${chalk.bold('Main environment variables:')}
  ${chalk.dim('OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY')}
  ${chalk.dim('LOCAL_BASE_URL / LLAMA_BASE_URL, AI_HARNESS_AGENT_DIR')}
  ${chalk.dim('AI_HARNESS_SESSIONS_DIR, AI_HARNESS_TUI_MODE')}
`;
    console.log(helpText);
  }

  /** Display exit message */
  exitMessage(message: string): void {
    console.log(chalk.green(`\n${this.safeText(message)}`));
  }

  /** Clear terminal */
  clear(): void {
    process.stdout.write('\x1Bc');
  }

  /** Get current theme name */
  getThemeName(): string {
    return typeof this.options.theme === 'string' ? this.options.theme : this.options.theme.name;
  }

  /** Check if currently streaming */
  isCurrentlyStreaming(): boolean {
    return this.isStreaming;
  }

  // ===================================================================
  // Transcript Management (for TUI mode)
  // ===================================================================

  /** Add an entry to the transcript buffer */
  addTranscriptEntry(entry: Omit<TranscriptEntry, 'timestamp'>): void {
    const content = this.safeText(entry.content);
    this.transcript.push({ ...entry, content, timestamp: new Date() });
    this.transcriptBytes += Buffer.byteLength(content);
    while (this.transcript.length > this.maxTranscriptEntries || this.transcriptBytes > MAX_TRANSCRIPT_BYTES) {
      const removed = this.transcript.shift();
      if (removed) this.transcriptBytes -= Buffer.byteLength(removed.content);
    }
  }

  /** Display the transcript with scrolling support */
  displayTranscript(sessionId?: string, limit: number = 50): void {
    limit = Number.isSafeInteger(limit) ? Math.max(0, Math.min(500, limit)) : 50;
    const entries = sessionId 
      ? this.transcript.filter(e => e.type !== 'system') // Filter by session if needed
      : this.transcript;

    console.log(chalk.bold('\n📜 Transcript (last ' + Math.min(limit, entries.length) + ' entries):'));
    console.log('─'.repeat(60));

    const displayEntries = entries.slice(-limit);
    
    for (const entry of displayEntries) {
      const time = new Date(entry.timestamp).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      
      switch (entry.type) {
        case 'user':
          console.log(`${chalk.green(`[${time}]`)} ${chalk.bold.green('You')}: ${entry.content.slice(0, 80)}`);
          break;
        case 'assistant':
          console.log(`${chalk.blue(`[${time}]`)} ${chalk.bold.blue('AI')}: ${entry.content.slice(0, 80)}`);
          break;
        case 'command':
          console.log(`${chalk.yellow(`[${time}]`)} ${chalk.dim(entry.content)}`);
          break;
      }
    }

    if (entries.length > limit) {
      console.log(chalk.dim(`... and ${entries.length - limit} more entries`));
    }
  }

  /** Toggle scroll mode for transcript navigation */
  toggleScrollMode(): void {
    this.isScrolling = !this.isScrolling;
    if (this.isScrolling) {
      console.log(chalk.yellow('📜 Scroll mode enabled. Use ↑/↓ to navigate, q to exit.'));
    } else {
      console.log(chalk.green('✓ Scroll mode disabled')); // Fixed: removed extra space
    }
  }

  /** Scroll up in transcript */
  scrollUp(lines: number = 1): void {
    if (this.transcript.length === 0) return;
    
    this.scrollPosition = Math.max(0, this.scrollPosition - lines);
    const visibleEntries = this.transcript.slice(-Math.min(this.scrollPosition + 20, this.transcript.length));
    
    console.log(chalk.dim(`[Scroll: showing last ${visibleEntries.length} entries]`));
  }

  /** Scroll down in transcript */
  scrollDown(lines: number = 1): void {
    if (this.transcript.length === 0) return;
    
    this.scrollPosition = Math.min(this.transcript.length - 20, this.scrollPosition + lines);
    const visibleEntries = this.transcript.slice(-Math.min(this.scrollPosition + 20, this.transcript.length));
    
    console.log(chalk.dim(`[Scroll: showing last ${visibleEntries.length} entries]`)); // Fixed: removed extra space
  }

  /** Get transcript statistics */
  getTranscriptStats(): { totalMessages: number; userCount: number; assistantCount: number } {
    const stats = this.transcript.reduce((acc, entry) => {
      if (entry.type === 'user') acc.userCount++;
      else if (entry.type === 'assistant') acc.assistantCount++;
      return acc;
    }, { totalMessages: 0, userCount: 0, assistantCount: 0 });
    
    stats.totalMessages = this.transcript.length;
    return stats;
  }

  // ===================================================================
  // Readline Integration (for TUI mode)
  // ===================================================================

  /** Set the readline instance for keyboard handling */
  setReadline(_rl: Interface): void {
    // Kept as a compatibility hook for future fullscreen TUI integration.
  }

  /** Handle keypress events in TUI mode */
  handleKeypress(key: Key, _input?: string): boolean {
    // Ctrl+C - interrupt or exit
    if (key.ctrl && key.name === 'c') {
      if (this.isStreaming) {
        process.stdout.write('\n');
        console.log(chalk.hex(this.theme.colors.warning)('[Interrupted]'));
        return true; // Handled
      }
      // Not streaming, let it pass through for readline's default behavior
    }
    
    // Alt+Up/Down - scroll transcript (TUI mode)
    if (key.meta) {
      switch (key.name) {
        case 'up':
          this.scrollUp();
          return true;
        case 'down':
          this.scrollDown();
          return true;
      }
    }
    
    // Ctrl+L - clear screen
    if (key.ctrl && key.name === 'l') {
      this.clear();
      return true;
    }
    
    // Escape from scroll mode
    if (!this.isStreaming && key.name === 'escape' && this.isScrolling) {
      this.toggleScrollMode();
      return true;
    }
    
    return false; // Not handled, let readline process it
  }

  // ===================================================================
  // Transcript Search
  // ===================================================================

  /** Search through the transcript buffer for a query string */
  searchTranscript(query: string, maxResults: number = 20): { matches: TranscriptEntry[]; totalMatches: number } {
    if (!query || Buffer.byteLength(query) > 4_096 || !query.trim()) {
      return { matches: [], totalMatches: 0 };
    }

    const normalizedQuery = query.toLowerCase().trim();
    const results: TranscriptEntry[] = [];

    for (const entry of this.transcript) {
      // Skip non-conversation entries for search
      if (entry.type !== 'user' && entry.type !== 'assistant') continue;
      
      if (entry.content.toLowerCase().includes(normalizedQuery)) {
        results.push(entry);
        if (results.length >= maxResults) break;
      }
    }

    return { matches: results, totalMatches: results.length };
  }

  /** Display search results in the transcript */
  displaySearchResults(query: string): void {
    const result = this.searchTranscript(query);

    const safeQuery = this.safeText(query);
    if (result.matches.length === 0) {
      console.log(chalk.yellow(`No matches found for "${chalk.cyan(safeQuery)}"`));
      return;
    }

    // Check if we truncated results
    const actualTotal = this.transcript.filter(e => 
      (e.type === 'user' || e.type === 'assistant') && 
      e.content.toLowerCase().includes(query.toLowerCase())
    ).length;

    console.log(chalk.bold(`\n🔍 Search results for "${chalk.cyan(safeQuery)}": ${result.matches.length} match(es)`));
    if (actualTotal > result.matches.length) {
      console.log(chalk.dim(`   (showing first ${result.matches.length} of ${actualTotal})`));
    }
    console.log('─'.repeat(60));

    for (const entry of result.matches) {
      const time = new Date(entry.timestamp).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      
      // Highlight the matching text
      const content = this.highlightMatch(entry.content, query);
      
      switch (entry.type) {
        case 'user':
          console.log(`${chalk.green(`[${time}]`)} ${chalk.bold.green('You')}:\n  ${content}\n`);
          break;
        case 'assistant':
          console.log(`${chalk.blue(`[${time}]`)} ${chalk.bold.blue('AI')}:\n  ${content}\n`);
          break;
      }
    }

    // Show navigation hint
    if (result.matches.length > 1) {
      console.log(chalk.dim('Tip: Use ↑/↓ to navigate between results, q to exit search mode.'));
    }
  }

  /** Highlight matching text within a string */
  private highlightMatch(content: string, query: string): string {
    if (!query) return content;
    
    const normalizedQuery = query.toLowerCase();
    const lowerContent = content.toLowerCase();
    let result = '';
    let lastIndex = 0;

    // Find all occurrences of the query in the content (limit to first few for readability)
    let searchFrom = 0;
    let matchCount = 0;
    const maxHighlight = 3; // Only highlight up to 3 matches per entry

    while ((searchFrom = lowerContent.indexOf(normalizedQuery, searchFrom)) !== -1 && matchCount < maxHighlight) {
      result += content.slice(lastIndex, searchFrom);
      
      // Highlight the matching portion (truncate if too long)
      const matchEnd = searchFrom + query.length;
      const displayMatch = content.slice(searchFrom, matchEnd);
      if (displayMatch.length > 100) {
        result += chalk.bgYellow.black(displayMatch.slice(0, 50) + '...');
      } else {
        result += chalk.bgYellow.black(displayMatch);
      }
      
      lastIndex = matchEnd;
      searchFrom = matchEnd;
      matchCount++;
    }

    // Add the rest of the content (truncated if too long)
    const remaining = content.slice(lastIndex);
    if (remaining.length > 200) {
      result += '...' + chalk.dim(remaining.slice(-150));
    } else {
      result += remaining;
    }

    return result;
  }

  /** Get transcript as markdown for export */
  getTranscriptMarkdown(): string {
    let md = '# AiHarness Conversation Transcript\n\n';
    
    for (const entry of this.transcript) {
      const time = new Date(entry.timestamp).toLocaleString('fr-FR');
      
      switch (entry.type) {
        case 'user':
          md += `## 👤 You (${time})\n\n${entry.content}\n\n---\n\n`;
          break;
        case 'assistant':
          md += `## 🤖 Assistant (${time})\n\n${entry.content}\n\n---\n\n`;
          break;
      }
    }
    
    return md;
  }

  // ===================================================================
  // Multi-line Editor Support
  // ===================================================================

  isMultiLineModeActive(): boolean {
    return this.isMultiLineMode;
  }

  /** Enter line-oriented multi-line mode. `/send` submits and `/cancel` aborts. */
  startMultiLineEditor(): void {
    this.isMultiLineMode = true;
    this.multiLineBuffer = [];
    console.log(chalk.yellow('\n📝 Multi-line edit mode'));
    console.log(chalk.dim('   Enter one line at a time. Use /send to submit or /cancel to abort.'));
  }

  addMultiLineBuffer(line: string): void {
    if (!this.isMultiLineMode) return;
    this.multiLineBuffer.push(line);

    if (this.multiLineBuffer.length > this.maxMultiLineLines) {
      this.multiLineBuffer.shift();
    }
  }

  /** Submit the buffer and always leave editor mode. */
  getMultiLineContent(): string | null {
    if (!this.isMultiLineMode) return null;
    const content = this.multiLineBuffer.join('\n');
    this.exitMultiLineEditor();
    return content || null;
  }

  cancelMultiLineEditor(): void {
    if (this.isMultiLineMode) console.log(chalk.yellow('\n[Multi-line edit cancelled]'));
    this.exitMultiLineEditor();
  }

  protected exitMultiLineEditor(): void {
    this.isMultiLineMode = false;
    this.multiLineBuffer = [];
  }

  // ===================================================================
  // Markdown Rendering
  // ===================================================================

  /** Render common Markdown constructs to ANSI-styled terminal text. */
  renderMarkdown(text: string): string {
    if (!text) return '';

    const protectedBlocks: string[] = [];
    const protect = (value: string): string => {
      const index = protectedBlocks.push(value) - 1;
      return `\u0001P${index}\u0002`;
    };

    let result = this.safeText(text).replace(/```(?:([\w+#-]+))?\s*\n?([\s\S]*?)```/g, (_, lang: string | undefined, code: string) => {
      const body = chalk.hex(this.theme.colors.mdCodeBlock)(code.replace(/\n$/, ''));
      const label = chalk.bgHex(this.theme.colors.customMessageBg)
        .hex(this.theme.colors.customMessageLabel)(` ${lang ?? 'code'} `);
      return protect(`${label}\n${body}`);
    });

    result = result.replace(/`([^`\n]+)`/g, (_, code: string) =>
      protect(chalk.bgHex(this.theme.colors.selectedBg).hex(this.theme.colors.mdCode)(code)),
    );
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, url: string) =>
      protect(`${chalk.underline.hex(this.theme.colors.mdLink)(label)} (${chalk.hex(this.theme.colors.mdLinkUrl)(url)})`),
    );

    result = result.replace(/^#{1,6}\s+(.+)$/gm, (_, heading: string) =>
      chalk.bold.hex(this.theme.colors.mdHeading)(heading),
    );
    result = result.replace(/\*\*(.+?)\*\*/g, (_, value: string) => chalk.bold(value));
    result = result.replace(/__(.+?)__/g, (_, value: string) => chalk.bold(value));
    result = result.replace(/~~(.+?)~~/g, (_, value: string) => chalk.dim(chalk.strikethrough(value)));
    result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*/g, (_, value: string) => chalk.italic(value));
    result = result.replace(/(?<!_)_(?!_)(.+?)_(?!_)/g, (_, value: string) => chalk.italic(value));
    result = result.replace(/^(\s*)[-*]\s+(.+)$/gm, (_, indent: string, value: string) =>
      `${indent}${chalk.hex(this.theme.colors.mdListBullet)('•')} ${value}`,
    );
    result = result.replace(/^(\s*)(\d+)\.\s+(.+)$/gm, (_, indent: string, number: string, value: string) =>
      `${indent}${chalk.hex(this.theme.colors.mdListBullet)(`${number}.`)} ${value}`,
    );
    result = result.replace(/^>\s?(.*)$/gm, (_, value: string) =>
      chalk.hex(this.theme.colors.mdQuoteBorder)('│ ') + chalk.hex(this.theme.colors.mdQuote)(value),
    );
    result = result.replace(/^\s*(-{3,}|\*{3,})\s*$/gm, () =>
      chalk.hex(this.theme.colors.mdHr)('─'.repeat(60)),
    );

    return result.replace(/\u0001P(\d+)\u0002/g, (_, index: string) => protectedBlocks[Number(index)] ?? '');
  }

  // Private helpers
  private clearCurrentLine(): void {
    process.stdout.write('\r\x1b[K');
  }
}
