import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ResourceManager, parseResourceCommandLine } from './resource-manager.js';

const argumentsCases: Array<[string, string[]]> = [
  ['', []], ['   ', []], ['""', ['']], ["''", ['']],
  ['"" middle \'\' tail', ['', 'middle', '', 'tail']],
  ['a""b \'two words\' "雪 🙂"', ['ab', 'two words', '雪 🙂']],
  ['one\\ two "\\\"quoted\\\""', ['one two', '"quoted"']],
  ["'$HOME' '$(touch nope)'", ['$HOME', '$(touch nope)']],
];

describe('A3-CLI-16 owned template arguments', () => {
  it.each(argumentsCases)('preserves exact tokens for %j', (input, expected) => {
    expect(parseResourceCommandLine(input)).toEqual(expected);
  });
  it.each(['"unterminated', "'unterminated"])( 'rejects unclosed %j without reflecting input', input => {
    expect(() => parseResourceCommandLine(input)).toThrow('Resource command contains an unterminated quote.');
  });
  it('retains the existing argument-count and byte ceilings', () => {
    expect(() => parseResourceCommandLine(Array(257).fill('""').join(' '))).toThrow('too many arguments');
    expect(() => parseResourceCommandLine('雪'.repeat(22_000))).toThrow('too large');
  });
  it('defaults apply to missing positions, not explicitly empty positions; replacement is not recursive', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-template-args-'));
    try {
      const file = path.join(root, 'review.md'); await mkdir(path.join(root, 'cwd'));
      await writeFile(file, '${1:-first}|${2:-second}|${3:-third}|$1|$2|$ARGUMENTS|$@|${@:2:2}|${@:2}|${@:-all}');
      const manager = new ResourceManager({ cwd: path.join(root, 'cwd'), homeDir: path.join(root, 'home'), agentDir: path.join(root, 'agent'), promptPaths: [file] });
      expect(await manager.loadAll()).toEqual({ prompts: 1, skills: 0, errors: [] });
      expect(manager.expandPromptLine('review', '')).toBe('first|second|third|||||||all');
      expect(manager.expandPromptLine('review', '"" middle')).toBe('|middle|third||middle| middle| middle|middle|middle| middle');
      expect(manager.expandPromptLine('review', "'' ''")).toBe(['', '', 'third', '', '', ' ', ' ', '', '', ' '].join('|'));
      expect(manager.expandPrompt('review', ['$2'])).toBe('$2|second|third|$2||$2|$2|||$2');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
