/**
 * Conservative shell-word reader used only by MCP paste import. It removes
 * ordinary POSIX quoting but never expands a variable, performs command
 * substitution, or invokes a shell. Operators and multiple commands are
 * refused because treating only the first command as an MCP server would make
 * a later automatic connection execute something different from the preview.
 */

export type McpShellErrorCode =
  | 'command-substitution'
  | 'multiple-commands'
  | 'shell-operator'
  | 'too-many-words'
  | 'unsafe-character'
  | 'unterminated-quote'
  | 'word-too-long';

export type McpShellSplitResult =
  | { ok: true; words: string[] }
  | { ok: false; code: McpShellErrorCode };

const MAX_WORDS = 256;
const MAX_WORD_BYTES = 16 * 1024;
const UNSAFE_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/u;
const OPERATOR_START = new Set(['|', '&', ';', '<', '>', '(', ')']);
const ESCAPABLE = new Set([' ', '\t', '\n', "'", '"', '\\', '$', '`', '|', '&', ';', '<', '>', '(', ')', '#']);

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function continuationLength(input: string, index: number): number {
  let cursor = index + 1;
  while (input[cursor] === ' ' || input[cursor] === '\t') cursor++;
  if (input[cursor] === '\r' && input[cursor + 1] === '\n') return cursor + 2 - index;
  if (input[cursor] === '\n') return cursor + 1 - index;
  return 0;
}

function startsWindowsPath(input: string, index: number): boolean {
  return /^(?:[A-Za-z]:\\|\\\\[A-Za-z0-9.$_-])/u.test(input.slice(index, index + 5));
}

class ShellReader {
  private index = 0;
  private readonly words: string[] = [];
  private word: string | undefined;
  private wordBytes = 0;
  private windowsWord = false;
  private lineEnded = false;

  constructor(private readonly input: string) {}

  run(): McpShellSplitResult {
    while (this.index < this.input.length) {
      const character = this.input[this.index]!;
      if (character === ' ' || character === '\t' || character === '\r') {
        const failure = this.finishWord();
        if (failure) return failure;
        this.index++;
        continue;
      }
      if (character === '\n') {
        const failure = this.finishWord();
        if (failure) return failure;
        if (this.words.length > 0) this.lineEnded = true;
        this.index++;
        continue;
      }
      if ((character === '\\' || character === '^' || character === '`')
        && continuationLength(this.input, this.index) > 0) {
        this.index += continuationLength(this.input, this.index);
        continue;
      }
      if (character === '#' && this.word === undefined) {
        while (this.index < this.input.length && this.input[this.index] !== '\n') this.index++;
        continue;
      }
      if (this.lineEnded) return { ok: false, code: 'multiple-commands' };
      if (character === "'") {
        const failure = this.readSingleQuote();
        if (failure) return failure;
        continue;
      }
      if (character === '"') {
        const failure = this.readDoubleQuote();
        if (failure) return failure;
        continue;
      }
      if (character === '`' || (character === '$' && this.input[this.index + 1] === '(')) {
        return { ok: false, code: 'command-substitution' };
      }
      if (OPERATOR_START.has(character)) return { ok: false, code: 'shell-operator' };
      if (character === '\\') {
        const failure = this.readBackslash();
        if (failure) return failure;
        continue;
      }
      const failure = this.append(character);
      if (failure) return failure;
      this.index++;
    }
    const failure = this.finishWord();
    return failure ?? { ok: true, words: this.words };
  }

  private startWord(): void {
    if (this.word !== undefined) return;
    this.word = '';
    this.wordBytes = 0;
    this.windowsWord = startsWindowsPath(this.input, this.index);
  }

  private append(value: string): McpShellSplitResult | undefined {
    this.startWord();
    const next = `${this.word ?? ''}${value}`;
    this.word = next;
    this.wordBytes += byteLength(value);
    if (this.wordBytes > MAX_WORD_BYTES) return { ok: false, code: 'word-too-long' };
    return undefined;
  }

  private finishWord(): McpShellSplitResult | undefined {
    if (this.word === undefined) return undefined;
    this.words.push(this.word);
    this.word = undefined;
    this.wordBytes = 0;
    this.windowsWord = false;
    if (this.words.length > MAX_WORDS) return { ok: false, code: 'too-many-words' };
    return undefined;
  }

  private readSingleQuote(): McpShellSplitResult | undefined {
    this.startWord();
    const end = this.input.indexOf("'", this.index + 1);
    if (end < 0) return { ok: false, code: 'unterminated-quote' };
    const failure = this.append(this.input.slice(this.index + 1, end));
    this.index = end + 1;
    return failure;
  }

  private readDoubleQuote(): McpShellSplitResult | undefined {
    this.startWord();
    const windowsPath = startsWindowsPath(this.input, this.index + 1);
    this.index++;
    while (this.index < this.input.length) {
      const character = this.input[this.index]!;
      if (character === '"') {
        this.index++;
        return undefined;
      }
      if (character === '`' || (character === '$' && this.input[this.index + 1] === '(')) {
        return { ok: false, code: 'command-substitution' };
      }
      if (character === '\\') {
        const next = this.input[this.index + 1];
        if (next === '\n') {
          this.index += 2;
          continue;
        }
        if (next === '\r' && this.input[this.index + 2] === '\n') {
          this.index += 3;
          continue;
        }
        if (next === '"' || (!windowsPath && (next === '$' || next === '`' || next === '\\'))) {
          const failure = this.append(next);
          if (failure) return failure;
          this.index += 2;
          continue;
        }
      }
      const failure = this.append(character);
      if (failure) return failure;
      this.index++;
    }
    return { ok: false, code: 'unterminated-quote' };
  }

  private readBackslash(): McpShellSplitResult | undefined {
    this.startWord();
    const next = this.input[this.index + 1];
    if (next === undefined || this.windowsWord || !ESCAPABLE.has(next)) {
      const failure = this.append('\\');
      this.index++;
      return failure;
    }
    const failure = this.append(next);
    this.index += 2;
    return failure;
  }
}

export function splitMcpShellWords(input: string): McpShellSplitResult {
  if (UNSAFE_CHARACTER.test(input)) return { ok: false, code: 'unsafe-character' };
  return new ShellReader(input).run();
}
