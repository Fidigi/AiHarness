import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

function family(pattern) {
  return execFileSync('fc-match', ['-f', '%{family}', pattern], { encoding: 'utf8', timeout: 2_000, maxBuffer: 4_096 });
}
test('CJK support does not restyle historical generic Latin fonts', () => {
  for (const name of ['sans-serif', 'system-ui', 'serif', 'monospace']) {
    assert.match(family(name), /Liberation Mono/);
  }
  assert.match(family('Arial'), /Liberation Sans/);
});
test('missing CJK glyphs and existing emoji still have real fallback fonts', () => {
  assert.match(family('sans-serif:charset=4e2d'), /Noto.*CJK/);
  assert.match(family('sans-serif:charset=1f510'), /Noto Color Emoji/);
});
