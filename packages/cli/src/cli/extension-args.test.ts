import { describe, expect, it } from 'vitest';
import type { ExtensionOptionDescriptor } from '@ai-harness/core';
import { completeCliOptions, formatCliHelp, parseCliArguments } from './args.js';

const options: ExtensionOptionDescriptor[] = [
  { name: 'review-check', extensionId: 'review', type: 'boolean', description: 'Check review', default: false },
  { name: 'review-style', extensionId: 'review', type: 'string', description: 'Review style', default: 'brief', completions: ['brief', 'full'] },
];

describe('extension CLI option parsing/help/completion', () => {
  it('parses explicit booleans and strings, keeping prompt/attachment boundaries', () => {
    expect(parseCliArguments(['--review-check=false', '--review-style=full', '@notes', 'hello', '--review-check'], options))
      .toMatchObject({ extensionOptions: { 'review-check': false, 'review-style': 'full' }, fileArgs: ['notes'], messages: ['hello', '--review-check'] });
    expect(parseCliArguments(['--review-check', '--review-style', 'brief'], options).extensionOptions)
      .toEqual({ 'review-check': true, 'review-style': 'brief' });
    expect(parseCliArguments(['--', '--review-check'], options).extensionOptions).toEqual({});
    expect(parseCliArguments([], options).extensionOptions).toEqual({});
  });

  it('strictly rejects malformed, duplicate, oversized and unknown flags', () => {
    for (const args of [
      ['--review-check=yes'], ['--review-check='], ['--review-style'], ['--review-style='],
      ['--review-check', '--review-check=false'], ['--review-style', 'x'.repeat(4097)],
      ['--review-style=\u001b[2J'], ['--unknown'],
    ]) expect(() => parseCliArguments(args, options)).toThrow();
    expect(() => parseCliArguments(Array(4097).fill('x'))).toThrow(/limit/);
    expect(() => parseCliArguments(['--' + 'x'.repeat(1000)])).toThrow(/^Unknown option: .{0,120}$/);
  });

  it('bootstraps only loading/trust flags before unknown arity and reparses authoritatively', () => {
    expect(parseCliArguments(['--approve', '-e', 'review.mjs', '--review-style', 'full', '--print'], [], true))
      .toMatchObject({ projectTrust: true, extensions: ['review.mjs'], deferredOptions: ['--review-style'], print: true });
    expect(() => parseCliArguments(['--review-check', 'prompt', '--approve'], [], true)).toThrow(/must precede/);
    expect(() => parseCliArguments(['--review-check', '--extension', 'x'], [], true)).toThrow(/must precede/);
    expect(() => parseCliArguments(['-unknown'], [], true)).toThrow(/Unknown/);
  });

  it('generates metadata-only option and literal value candidates', () => {
    expect(formatCliHelp(options)).toContain('--review-style <value>  Review style');
    expect(formatCliHelp(options)).toContain('--review-check[=true|false]');
    expect(completeCliOptions('--review-', options)).toEqual(['--review-check', '--review-style']);
    expect(completeCliOptions('--review-style=f', options)).toEqual(['--review-style=full']);
    expect(completeCliOptions('--review-check=f', options)).toEqual(['--review-check=false']);
    expect(completeCliOptions('--review-style=missing', options)).toEqual([]);
    expect(completeCliOptions('--ver', options)).toContain('--version');
    expect(() => completeCliOptions('\u001b', options)).toThrow(/Invalid/);
  });
});
