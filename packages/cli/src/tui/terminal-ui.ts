// ============================================================
// Terminal UI - Enhanced TUI Component with Streaming Support
// Features: scrollable transcript, character-by-character streaming,
// fullscreen/regular mode toggle, markdown-like rendering
// ============================================================

import chalk from 'chalk';
import readline from 'readline';
import type { TerminalTheme } from './theme-manager.js';

export interface TerminalOptions {
  title?: string;
  theme?: 'dark' | 'light' | TerminalTheme;
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

/** Manages terminal output with scrollable transcript and streaming support */
export class TerminalUI {
  private options: Required<TerminalOptions>;
  protected readonly theme: TerminalTheme;
  protected isStreaming = false;
  
  // Transcript for session conversations (scrollable)
  private transcript: TranscriptEntry[] = [];
  private readonly maxTranscriptEntries = 500;
  private scrollPosition = 0;
  private isScrolling = false;

  // Multi-line editor state
  protected isMultiLineMode = false;
  protected multiLineBuffer: string[] = [];
  protected readonly maxMultiLineLines = 100;

  constructor(options: TerminalOptions = {}) {
    const mode = typeof options.theme === 'string' ? options.theme : options.theme?.mode || 'dark';
    this.theme = typeof options.theme === 'object' ? options.theme : {
      name: mode,
      mode,
      colors: mode === 'light'
        ? { accent: '#0369a1', user: '#15803d', assistant: '#0f172a', warning: '#a16207', error: '#b91c1c', muted: '#64748b' }
        : { accent: '#22d3ee', user: '#4ade80', assistant: '#f8fafc', warning: '#facc15', error: '#f87171', muted: '#94a3b8' },
    };
    this.options = {
      title: options.title || 'AiHarness',
      theme: options.theme || this.theme,
    };
  }

  /** Display welcome screen */
  welcome(): void {
    console.clear();
    const accent = chalk.bold.hex(this.theme.colors.accent);
    const dim = chalk.hex(this.theme.colors.muted);

    console.log(accent(`╔══════════════════════════════════════╗`));
    console.log(accent(`║${' '.repeat(32)}║`));
    console.log(accent(`║  ${accent('AiHarness CLI')} - Unified AI Agent Platform${' '.repeat(4)}║`));
    console.log(accent(`║${' '.repeat(32)}║`));
    console.log(accent(`╚══════════════════════════════════════╝`));
    console.log();
    console.log(dim('  Type /help for available commands'));
    console.log(dim('  Providers: mock, openai, anthropic, google, local, azure, vertex, bedrock'));
    console.log(dim('  Tip: Use Ctrl+C to interrupt streaming responses'));
    console.log();
  }

  /** Display user message */
  displayUserMessage(content: string): void {
    // Clear any streaming output first
    if (this.isStreaming) {
      this.clearCurrentLine();
      process.stdout.write('\n');
    }

    const prompt = chalk.bold.hex(this.theme.colors.user)('you> ');
    console.log(prompt + content);
  }

  /** Display assistant response (non-streaming, for /command output) */
  displayAssistantMessage(content: string): void {
    if (this.isStreaming) {
      this.clearCurrentLine();
      process.stdout.write('\n');
    }

    console.log(chalk.dim('┌─ Assistant'));
    // Render Markdown before formatting the assistant frame.
    const lines = this.renderMarkdown(content).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i === 0) {
        console.log(chalk.white(`│ ${lines[i]}`));
      } else {
        console.log(chalk.dim('│ ') + chalk.white(lines[i]));
      }
    }
    console.log(chalk.dim('└──────────────'));
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
    process.stdout.write(chalk.dim('┌─ Assistant\n│ '));

    try {
      await new Promise<void>((resolve, reject) => {
        const streamPromise = (async () => {
          // The caller drives the streaming via onChunk callback
          resolve();
        })();

        streamPromise.then(resolve).catch(reject);
      });

      process.stdout.write('\n');
      console.log(chalk.dim('└──────────────'));
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
    process.stdout.write(chalk.dim('┌─ Assistant\n│ '));

    return {
      write: (text: string) => {
        // Handle newlines in streaming content
        if (text.includes('\n')) {
          const parts = text.split('\n');
          for (let i = 0; i < parts.length; i++) {
            process.stdout.write(parts[i]);
            if (i < parts.length - 1) {
              // Move to next line, indent with dim pipe
              process.stdout.write('\n' + chalk.dim('│ '));
            }
          }
        } else {
          process.stdout.write(text);
        }
      },
      finish: () => {
        console.log('\n' + chalk.dim('└──────────────'));
        this.isStreaming = false;
      },
      cancel: () => {
        console.log(chalk.yellow('[Interrupted]'));
        this.isStreaming = false;
      },
    };
  }

  /** Write unframed command output. Fullscreen backends override this sink. */
  writeOutput(output: string): void {
    process.stdout.write(`${output}\n\n`);
  }

  /** Stream a direct `!`/`!!` command without buffering unbounded terminal output. */
  startShellCommand(command: string, excludedFromContext: boolean): ShellCommandWriter {
    const policy = excludedFromContext ? 'excluded from model context' : 'included in model context';
    process.stdout.write(`${chalk.yellow(`[shell] $ ${command}`)} ${chalk.dim(`(${policy})`)}\n`);
    let wroteOutput = false;
    let endedWithNewline = true;
    return {
      write: chunk => {
        if (!chunk) return;
        wroteOutput = true;
        endedWithNewline = chunk.endsWith('\n');
        process.stdout.write(chunk);
      },
      finish: summary => {
        if (wroteOutput && !endedWithNewline) process.stdout.write('\n');
        if (!wroteOutput) process.stdout.write(chalk.dim('(no output)\n'));
        const status = summary.status === 'cancelled'
          ? 'cancelled'
          : `exit ${summary.exitCode ?? 'unknown'}`;
        process.stdout.write(chalk.dim(`[${status}${summary.truncated ? ' · truncated' : ''}]\n`));
        if (summary.fullOutputPath) {
          process.stdout.write(chalk.dim(`[full output: ${summary.fullOutputPath}]\n`));
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
    console.log(chalk.yellow(`[${name}]`));
    const lines = output.split('\n');
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
    console.error(chalk.red(`[Error] ${message}`));
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
  ${chalk.cyan('/trust [status|add|remove|list]')} Manage project trust
  ${chalk.cyan('/reload')}                       Reload settings, resources and extensions
  ${chalk.cyan('/settings')}                     Show effective agent settings and sources
  ${chalk.cyan('/config')}                       Show storage configuration
  ${chalk.cyan('/help')}                         Show this help
  ${chalk.cyan('/quit')} or ${chalk.cyan('/exit')}                  Exit AiHarness

${chalk.bold('Input')}
  ${chalk.cyan('/edit')} / ${chalk.cyan('/send')} / ${chalk.cyan('/cancel')}          Multi-line input
  ${chalk.cyan('!<command>')}                    Run a shell command and include its output in context
  ${chalk.cyan('!!<command>')}                   Run a shell command outside model context
  ${chalk.cyan('Ctrl+G')}                        Open $VISUAL or $EDITOR
  ${chalk.cyan('Ctrl+C')}                        Interrupt streaming/commands or exit

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
    console.log(chalk.green(`\n${message}`));
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
    this.transcript.push({ ...entry, timestamp: new Date() });
    
    // Trim old entries if needed
    while (this.transcript.length > this.maxTranscriptEntries) {
      this.transcript.shift();
    }
  }

  /** Display the transcript with scrolling support */
  displayTranscript(sessionId?: string, limit: number = 50): void {
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
  setReadline(_rl: readline.Interface): void {
    // Kept as a compatibility hook for future fullscreen TUI integration.
  }

  /** Handle keypress events in TUI mode */
  handleKeypress(key: any, _input?: string): boolean {
    // Ctrl+C - interrupt or exit
    if (key.ctrl && key.name === 'c') {
      if (this.isStreaming) {
        process.stdout.write('\n');
        console.log(chalk.yellow('[Interrupted]'));
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
    if (!query || !query.trim()) {
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

    if (result.matches.length === 0) {
      console.log(chalk.yellow(`No matches found for "${chalk.cyan(query)}"`));
      return;
    }

    // Check if we truncated results
    const actualTotal = this.transcript.filter(e => 
      (e.type === 'user' || e.type === 'assistant') && 
      e.content.toLowerCase().includes(query.toLowerCase())
    ).length;

    console.log(chalk.bold(`\n🔍 Search results for "${chalk.cyan(query)}": ${result.matches.length} match(es)`));
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
      let displayMatch = content.slice(searchFrom, matchEnd);
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
    let remaining = content.slice(lastIndex);
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

    let result = text.replace(/```(?:([\w+#-]+))?\s*\n?([\s\S]*?)```/g, (_, lang: string | undefined, code: string) => {
      const body = chalk.gray(code.replace(/\n$/, ''));
      return protect(lang ? `${chalk.bgCyan.black(` ${lang} `)}\n${body}` : body);
    });

    result = result.replace(/`([^`\n]+)`/g, (_, code: string) => protect(chalk.bgYellow.black(code)));
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, url: string) =>
      protect(`${chalk.underline.blue(label)} (${chalk.gray(url)})`),
    );

    result = result.replace(/^#{1,6}\s+(.+)$/gm, (_, heading: string) => chalk.bold.cyan(heading));
    result = result.replace(/\*\*(.+?)\*\*/g, (_, value: string) => chalk.bold(value));
    result = result.replace(/__(.+?)__/g, (_, value: string) => chalk.bold(value));
    result = result.replace(/~~(.+?)~~/g, (_, value: string) => chalk.dim(chalk.strikethrough(value)));
    result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*/g, (_, value: string) => chalk.italic(value));
    result = result.replace(/(?<!_)_(?!_)(.+?)_(?!_)/g, (_, value: string) => chalk.italic(value));
    result = result.replace(/^(\s*)[-*]\s+(.+)$/gm, (_, indent: string, value: string) =>
      `${indent}${chalk.green('•')} ${value}`,
    );
    result = result.replace(/^(\s*)(\d+)\.\s+(.+)$/gm, (_, indent: string, number: string, value: string) =>
      `${indent}${chalk.cyan(`${number}.`)} ${value}`,
    );
    result = result.replace(/^>\s?(.*)$/gm, (_, value: string) => chalk.gray(`│ ${value}`));
    result = result.replace(/^\s*(-{3,}|\*{3,})\s*$/gm, () => chalk.dim('─'.repeat(60)));

    return result.replace(/\u0001P(\d+)\u0002/g, (_, index: string) => protectedBlocks[Number(index)] ?? '');
  }

  // Private helpers
  private clearCurrentLine(): void {
    process.stdout.write('\r\x1b[K');
  }
}
