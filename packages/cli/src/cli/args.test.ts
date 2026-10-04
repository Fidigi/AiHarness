import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  CliArgumentError,
  cliVersion,
  formatCliHelp,
  parseCliArguments,
  readPipedStdin,
  resolveCliApplicationMode,
} from './args.js';

describe('CLI arguments', () => {
  it('parses modes, aliases, repeatable resources, tools, and startup model options', () => {
    expect(parseCliArguments([
      '--mode=text', '--tui-mode', 'regular', '-e', './one.js', '--extension=./two.js',
      '--tools', 'read,GREP,read', '-xt', 'bash', '--provider', 'openai', '--model', 'gpt-test',
      '--models', 'openai/o*,anthropic/Claude*,openai/o*',
      '--thinking=max', '--system-prompt', './SYSTEM.md',
      '--append-system-prompt=first', '--append-system-prompt', './extra.md', '-nc',
      '--session-dir', './sessions', '--session-id', 'run-1',
      '--name', 'Review run', '@notes.txt', 'review this',
    ])).toMatchObject({
      mode: 'text',
      tuiMode: 'regular',
      extensions: ['./one.js', './two.js'],
      tools: ['read', 'grep'],
      excludeTools: ['bash'],
      provider: 'openai',
      model: 'gpt-test',
      models: ['openai/o*', 'anthropic/Claude*'],
      thinking: 'max',
      systemPrompt: './SYSTEM.md',
      appendSystemPrompts: ['first', './extra.md'],
      noContextFiles: true,
      sessionDir: './sessions',
      sessionId: 'run-1',
      name: 'Review run',
      fileArgs: ['notes.txt'],
      messages: ['review this'],
    });
  });

  it('honours -- termination and rejects unknown, malformed, and incompatible options', () => {
    expect(parseCliArguments(['--', '-literal', '@file.txt']).messages).toEqual(['-literal']);
    expect(parseCliArguments(['--', '-literal', '@file.txt']).fileArgs).toEqual(['file.txt']);
    expect(() => parseCliArguments(['--unknown'])).toThrow(CliArgumentError);
    expect(() => parseCliArguments(['--tui-mode', 'wide'])).toThrow(/Invalid TUI mode/);
    expect(() => parseCliArguments(['--tools', ''])).toThrow(/non-empty|at least one/i);
    expect(() => parseCliArguments(['--models', ', ,'])).toThrow(/at least one model pattern/i);
    expect(() => parseCliArguments(['--system-prompt', ''])).toThrow(/non-empty/i);
    expect(() => parseCliArguments(['--append-system-prompt'])).toThrow(/requires a value/i);
    expect(() => parseCliArguments(['--provider', 'openai'])).toThrow(/requires --model/i);
    expect(parseCliArguments(['--api-key', 'temporary', '--models', 'openai/gpt*']))
      .toMatchObject({ apiKey: 'temporary', models: ['openai/gpt*'] });
    expect(parseCliArguments(['--list-models', 'sonnet'])).toMatchObject({ listModels: 'sonnet' });
    expect(parseCliArguments(['--list-models'])).toMatchObject({ listModels: true });
    expect(() => parseCliArguments(['--list-models=', 'ignored'])).toThrow(/non-empty search/i);
    expect(() => parseCliArguments(['--list-models', 'sonnet', 'prompt'])).toThrow(/cannot be combined/i);
    expect(() => parseCliArguments(['--rpc', 'prompt'])).toThrow(/does not accept/i);
    expect(() => parseCliArguments(['--rpc', '--print'])).toThrow(/cannot be combined/i);
    expect(() => parseCliArguments(['--continue', '--session', 'one'])).toThrow(/cannot be combined/i);
    expect(() => parseCliArguments(['--fork', 'one', '--no-session'])).toThrow(/cannot be combined/i);
    expect(() => parseCliArguments(['--session-id', '../bad'])).toThrow(/Session ID/i);
    expect(() => parseCliArguments(['--rpc', '--resume'])).toThrow(/interactive terminal/i);
    expect(parseCliArguments(['--rpc', '--session', 'saved'])).toMatchObject({ mode: 'rpc', session: 'saved' });
    expect(parseCliArguments(['-c'])).toMatchObject({ continueSession: true });
    expect(parseCliArguments(['-r'])).toMatchObject({ resume: true });
  });

  it('resolves terminal, redirected print, JSON, and RPC lifecycles', () => {
    const base = parseCliArguments([]);
    expect(resolveCliApplicationMode(base, { stdinIsTTY: true, stdoutIsTTY: true })).toBe('interactive');
    expect(resolveCliApplicationMode(base, { stdinIsTTY: false, stdoutIsTTY: true })).toBe('print');
    expect(resolveCliApplicationMode(parseCliArguments(['--print']), {
      stdinIsTTY: true, stdoutIsTTY: true,
    })).toBe('print');
    expect(resolveCliApplicationMode(parseCliArguments(['--mode', 'json']), {})).toBe('json');
    expect(resolveCliApplicationMode(parseCliArguments(['--mode', 'rpc']), {})).toBe('rpc');
  });

  it('provides stable help/version metadata and bounded piped input', async () => {
    expect(cliVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(formatCliHelp()).toContain('ai-harness [options]');
    expect(formatCliHelp()).toContain('--append-system-prompt');
    expect(formatCliHelp()).toContain('--list-models [search]');
    expect(formatCliHelp()).toContain('AI_HARNESS_AGENT_DIR');
    expect(formatCliHelp()).toContain('AI_HARNESS_SESSIONS_DIR');
    expect(formatCliHelp()).toContain('.ai-harness/settings.json');
    await expect(readPipedStdin(Readable.from([' hello ', 'world\n']), 100)).resolves.toBe('hello world');
    await expect(readPipedStdin(Readable.from(['too large']), 3)).rejects.toThrow(/exceeds/i);
  });
});
