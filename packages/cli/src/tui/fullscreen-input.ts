import readline from 'readline';
import type { FullscreenUI } from './fullscreen-ui.js';

export interface FullscreenInputHandlers {
  onLine: (line: string) => void | Promise<void>;
  onInterrupt: () => void;
  onExit: () => void;
  onError?: (error: Error) => void;
  complete?: (input: string) => string[];
  onExternalEditor?: (currentInput: string) => Promise<string | undefined>;
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
  private processing = Promise.resolve();
  private readonly keypressListener: (text: string, key: readline.Key) => void;

  constructor(
    private readonly ui: FullscreenUI,
    private readonly handlers: FullscreenInputHandlers,
    private readonly input: KeypressInput = process.stdin,
  ) {
    this.keypressListener = (text, key) => this.handleKeypress(text, key);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    readline.emitKeypressEvents(this.input as NodeJS.ReadStream);
    if (this.input.isTTY && this.input.setRawMode) this.input.setRawMode(true);
    this.input.on('keypress', this.keypressListener);
    this.input.resume();
    this.ui.setInput(this.value, this.cursor);
  }

  stop(): void {
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
    this.stop();
    this.ui.leave();
  }

  getValue(): string {
    return this.value;
  }

  handleKeypress(text: string, key: readline.Key = {}): void {
    if (key.ctrl && key.name === 'c') {
      this.handlers.onInterrupt();
      return;
    }

    if (key.ctrl && key.name === 'd') {
      if (!this.value) this.handlers.onExit();
      return;
    }

    if (key.ctrl && key.name === 'l') {
      this.ui.render();
      return;
    }

    if (key.ctrl && key.name === 'g' && this.handlers.onExternalEditor) {
      this.processing = this.processing.then(async () => {
        this.stop();
        try {
          const edited = await this.handlers.onExternalEditor!(this.value);
          if (edited !== undefined) {
            this.value = edited;
            this.cursor = edited.length;
          }
        } catch (error) {
          this.handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
        } finally {
          this.start();
        }
      });
      return;
    }

    if (key.meta && key.name === 'up') {
      this.ui.scrollUp();
      return;
    }

    if (key.meta && key.name === 'down') {
      this.ui.scrollDown();
      return;
    }

    switch (key.name) {
      case 'return':
      case 'enter':
        this.submit();
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
        this.cursor = 0;
        break;
      case 'end':
        this.cursor = this.value.length;
        break;
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

  private submit(): void {
    const line = this.value;
    if (line.trim()) {
      this.history.push(line);
      if (this.history.length > 100) this.history.shift();
    }
    this.historyIndex = this.history.length;
    this.value = '';
    this.cursor = 0;
    this.ui.setInput('', 0);

    this.processing = this.processing
      .then(() => this.handlers.onLine(line))
      .catch(error => this.handlers.onError?.(error instanceof Error ? error : new Error(String(error))));
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
