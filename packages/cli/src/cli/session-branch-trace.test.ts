import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fixture = fileURLToPath(new URL('./fixtures/session-branch-terminal.mjs', import.meta.url));
const record = { kind: 'observed', model: 'Nested "JSON" and a newline\nwith UTF-8 é' };
const large = { kind: 'observed', model: 'x'.repeat(65_536) };
const cases: Array<[string, string, unknown[]]> = [
  ['empty', '', []],
  ['incomplete object', '{"kind":"observed","model":"', []],
  ['unterminated valid object', JSON.stringify(record), []],
  ['complete object', JSON.stringify(record) + '\n', [record]],
  ['large complete object', JSON.stringify(large) + '\n', [large]],
  ['complete record and partial suffix', JSON.stringify(record) + '\n{"kind":"observed","model":"', [record]],
  ['large partial suffix', JSON.stringify(record) + '\n{"model":"' + 'x'.repeat(16_384), [record]],
  ['several complete records', JSON.stringify(record) + '\n{"kind":"aborted"}\n', [record, { kind: 'aborted' }]],
  ['blank lines', '\n' + JSON.stringify(record) + '\n\n', [record]],
  ['CRLF record', JSON.stringify(record) + '\r\n', [record]],
];

describe('terminal branch fixture JSONL trace framing', () => {
  it.each(cases)('reads only completed records: %s', (_name, input, expected) => {
    const result = spawnSync(process.execPath, [fixture, '--trace-records'], {
      input, encoding: 'utf8', timeout: 5_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(expected);
    expect(result.stdout.endsWith('\n')).toBe(true);
  });

  it.each(['{"kind":}\n', JSON.stringify(record) + '\n{"kind":}\n'])(
    'still rejects malformed completed records: %s', input => {
      const result = spawnSync(process.execPath, [fixture, '--trace-records'], {
        input, encoding: 'utf8', timeout: 5_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.signal).toBeNull();
      expect(result.stderr).toContain('SyntaxError');
      expect(result.stdout).toBe('');
    },
  );
});
