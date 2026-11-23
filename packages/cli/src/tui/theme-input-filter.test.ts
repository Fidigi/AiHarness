import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { describe, expect, it } from 'vitest';
import { ThemeFilteredInput } from './theme-input-filter.js';

describe('ThemeFilteredInput', () => {
  it('keeps fragmented OSC and scheme reports out of the fullscreen keypress stream', async () => {
    const source = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(_mode: boolean) {},
    });
    const input = new ThemeFilteredInput(source);
    const keys: Array<{ text: string | undefined; name?: string }> = [];
    readline.emitKeypressEvents(input as NodeJS.ReadStream);
    input.on('keypress', (text: string | undefined, key: readline.Key) => keys.push({ text, name: key.name }));

    source.write(Buffer.from('\u001b]11;rgb:ffff/'));
    source.write(Buffer.from('ffff/ffff\u0007\u001b[?997;2n'));
    source.write(Buffer.from('x\u001b[A'));
    await new Promise(resolve => setImmediate(resolve));

    expect(keys).toEqual([
      { text: 'x', name: 'x' },
      { text: undefined, name: 'up' },
    ]);
    input.dispose();
    source.destroy();
  });
});
