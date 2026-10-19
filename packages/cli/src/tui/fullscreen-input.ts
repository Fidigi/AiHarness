import readline from 'readline';
import type { AgentMessageQueueKind } from '@ai-harness/core';
import type { FullscreenUI } from './fullscreen-ui.js';
import { EDITOR_ACTION_KEYS, type TerminalActionId } from '../utils/terminal-actions.js';
import {
  TerminalEscapeSequence,
  TERMINAL_ESCAPE_CODE_TIMEOUT_MS,
} from './terminal-escape.js';

export interface FullscreenInputHandlers {
  onLine: (line: string, kind: AgentMessageQueueKind) => void | Promise<void>;
  onInterrupt: () => void;
  onEscape: () => void;
  onExit: () => void;
  onError?: (error: Error) => void;
  complete?: (input: string) => string[];
  onExternalEditor?: (currentInput: string) => Promise<string | undefined>;
  /** Return replacement editor text, or undefined when there was nothing queued. */
  onDequeue?: (currentInput: string) => string | undefined;
  recordHistory?: () => boolean;
}

interface KeypressInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): void;
  resume(): void;
  pause(): void;
  on(event: 'keypress', listener: (text: string, key: readline.Key) => void): unknown;
  off(event: 'keypress', listener: (text: string, key: readline.Key) => void): unknown;
}

/** Raw-mode line editor used by the fullscreen terminal backend. */
export class FullscreenInput {
  private value = '';
  private cursor = 0;
  private readonly history: string[] = [];
  private historyIndex = 0;
  private started = false;
  private retired = false;
  private processing = Promise.resolve();
  private readonly escapeSequence: TerminalEscapeSequence;
  private readonly keypressListener: (text: string, key: readline.Key) => void;

  constructor(
    private readonly ui: FullscreenUI,
    private readonly handlers: FullscreenInputHandlers,
    private readonly input: KeypressInput = process.stdin,
  ) {
    this.escapeSequence = new TerminalEscapeSequence(handlers.onEscape);
    this.keypressListener = (text, key) => this.handleKeypress(text, key);
  }

  start(): void {
    if (this.started || this.retired) return;
    this.started = true;
    // The optional interface argument supplies Node's raw Escape decoder timeout;
    // fullscreen owns line editing, so only the decoder state object is needed.
    readline.emitKeypressEvents(
      this.input as NodeJS.ReadStream,
      { escapeCodeTimeout: TERMINAL_ESCAPE_CODE_TIMEOUT_MS } as unknown as readline.Interface,
    );
    if (this.input.isTTY && this.input.setRawMode) this.input.setRawMode(true);
    this.input.on('keypress', this.keypressListener);
    this.input.resume();
    this.ui.setInput(this.value, this.cursor);
  }

  stop(): void {
    this.escapeSequence.cancel();
    if (!this.started) return;
    this.started = false;
    this.input.off('keypress', this.keypressListener);
    if (this.input.isTTY && this.input.setRawMode) this.input.setRawMode(false);
    this.input.pause();
  }

  setPrompt(prompt: string): void {
    this.ui.setPrompt(prompt);
  }

  prompt(): void {
    this.ui.render();
  }

  close(): void {
    this.retired = true;
    this.stop();
    this.ui.leave();
  }

  getValue(): string {
    return this.value;
  }

  getCursor(): number { return this.cursor; }

  replaceValue(value: string, cursor = value.length): void {
    this.value = value;
    this.cursor = Number.isFinite(cursor) ? Math.max(0, Math.min(value.length, cursor)) : value.length;
    this.ui.setInput(this.value, this.cursor);
  }

  cancelPendingEscape(): void { this.escapeSequence.cancel(); }

  /** Resolve a split Alt+Enter for binding lookup; native pass-through stays untouched. */
  keyForBindings(key: readline.Key): readline.Key {
    return this.escapeSequence.isFollowingEnter(key) ? { ...key, name: 'enter', meta: true } : key;
  }

  /** Dispatch real native operations without recursively entering the stream gate. */
  performAction(action: TerminalActionId): boolean {
    if (this.retired) return false;
    this.escapeSequence.cancel();
    if (action === 'app.escape') { this.handlers.onEscape(); return true; }
    if (action === 'transcript.up') { this.ui.scrollUp(); return true; }
    if (action === 'transcript.down') { this.ui.scrollDown(); return true; }
    const key = Object.hasOwn(EDITOR_ACTION_KEYS, action) ? EDITOR_ACTION_KEYS[action] : undefined;
    if (!key) return false;
    this.handleKeypress('', key); return true;
  }

  handleKeypress(text: string, key: readline.Key = {}): void {
    if (this.retired) return;
    if (key.ctrl && key.name === 'c') {
      this.escapeSequence.cancel();
      this.handlers.onInterrupt();
      return;
    }

    if (key.ctrl && key.name === 'd') {
      this.escapeSequence.cancel();
      if (!this.value) this.handlers.onExit();
      return;
    }

    if (key.ctrl && key.name === 'q') {
      this.escapeSequence.cancel();
      this.submit('follow-up');
      return;
    }

    if (key.name === 'escape' && !key.ctrl && !key.shift) {
      this.escapeSequence.deferEscape();
      return;
    }

    const escapedEnter = this.escapeSequence.consumeFollowingKey(key);

    if (key.ctrl && key.name === 'l') {
      this.ui.render();
      return;
    }

    if (key.ctrl && key.name === 'g' && this.handlers.onExternalEditor) {
      this.processing = this.processing.then(async () => {
        if (this.retired) return;
        this.stop();
        try {
          const edited = await this.handlers.onExternalEditor!(this.value);
          if (!this.retired && edited !== undefined) {
            this.value = edited;
            this.cursor = edited.length;
          }
        } catch (error) {
          if (!this.retired) this.handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
        } finally {
          if (!this.retired) this.start();
        }
      });
      return;
    }

    if ((key.meta && (key.name === 'return' || key.name === 'enter')) || escapedEnter) {
      this.submit('follow-up');
      return;
    }

    if (key.meta && key.name === 'up') {
      const restored = this.handlers.onDequeue?.(this.value);
      if (restored === undefined) this.ui.scrollUp();
      else this.replaceValue(restored);
      return;
    }

    if (key.meta && key.name === 'down') {
      this.ui.scrollDown();
      return;
    }

    switch (key.name) {
      case 'return':
      case 'enter':
        this.submit('steer');
        return;
      case 'backspace':
        if (this.cursor > 0) {
          this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
          this.cursor--;
        }
        break;
      case 'delete':
        if (this.cursor < this.value.length) {
          this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
        }
        break;
      case 'left':
        this.cursor = Math.max(0, this.cursor - 1);
        break;
      case 'right':
        this.cursor = Math.min(this.value.length, this.cursor + 1);
        break;
      case 'home':
        this.cursor = key.ctrl ? 0 : this.value.slice(0, this.cursor).lastIndexOf('\n') + 1;
        break;
      case 'end': {
        const lineEnd = this.value.indexOf('\n', this.cursor);
        this.cursor = key.ctrl || lineEnd < 0 ? this.value.length : lineEnd;
        break;
      }
      case 'up':
        this.navigateHistory(-1);
        break;
      case 'down':
        this.navigateHistory(1);
        break;
      case 'tab':
        this.complete();
        break;
      case 'u':
        if (key.ctrl) {
          this.value = '';
          this.cursor = 0;
        } else {
          this.insert(text || 'u');
        }
        break;
      default:
        if (text && !key.ctrl && !key.meta && this.isPrintable(text)) this.insert(text);
    }

    this.ui.setInput(this.value, this.cursor);
  }

  private submit(kind: AgentMessageQueueKind): void {
    const line = this.value;
    if (line.trim() && this.handlers.recordHistory?.() !== false) {
      this.history.push(line);
      if (this.history.length > 100) this.history.shift();
    }
    this.historyIndex = this.history.length;
    this.value = '';
    this.cursor = 0;
    this.ui.setInput('', 0);

    try {
      void Promise.resolve(this.handlers.onLine(line, kind))
        .catch(error => this.handlers.onError?.(error instanceof Error ? error : new Error(String(error))));
    } catch (error) {
      this.handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private navigateHistory(direction: -1 | 1): void {
    if (this.history.length === 0) return;
    this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + direction));
    this.value = this.historyIndex === this.history.length ? '' : this.history[this.historyIndex];
    this.cursor = this.value.length;
  }

  private complete(): void {
    const candidates = this.handlers.complete?.(this.value) ?? [];
    if (candidates.length === 0) return;
    let completion = candidates[0];
    for (const candidate of candidates.slice(1)) {
      let index = 0;
      while (index < completion.length && completion[index] === candidate[index]) index++;
      completion = completion.slice(0, index);
    }
    if (completion.length > this.value.length) {
      this.value = completion;
      this.cursor = completion.length;
    }
    if (candidates.length === 1 && !this.value.endsWith(' ')) {
      this.value += ' ';
      this.cursor++;
    }
  }

  private insert(text: string): void {
    this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
    this.cursor += text.length;
  }

  private isPrintable(text: string): boolean {
    return [...text].every(character => character >= ' ' && character !== '\u007f');
  }
}
