import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { MAX_RPC_FRAME_BYTES, MAX_RPC_INPUT_BYTES, readRpcFrames } from './rpc-input.js';

const frames = (input: Readable) => readRpcFrames(input, () => false);

async function collect(input: Readable): Promise<string[]> {
  const lines: string[] = [];
  for await (const frame of frames(input)) {
    lines.push(frame.line);
    frame.release();
  }
  return lines;
}

describe('RPC byte-framed input', () => {
  it('preserves fragmented UTF-8, LF/CRLF, empty lines, Unicode separators and final EOF', async () => {
    const bytes = Buffer.from('é😀\u2028\u2029\r\n\nlast\r');
    expect(await collect(Readable.from([...bytes].map(byte => Buffer.from([byte])))))
      .toEqual(['é😀\u2028\u2029', '', 'last']);
    expect(await collect(Readable.from(['one\n', 'two']))).toEqual(['one', 'two']);
  });

  it.each(['object', 'decoded'] as const)('preserves supplementary Unicode from %s string streams', async mode => {
    const line = '{"id":"é😀\\u2028","type":"get_state"}';
    const input = mode === 'object' ? Readable.from((line + '\n').split(''))
      : Readable.from([Buffer.from(line + '\n')], { objectMode: false }).setEncoding('utf8');
    expect(await collect(input)).toEqual([line]);
  });

  it.each(['', '\n', '\r\n'])('accepts exactly 32 MiB UTF-8 with delimiter %j', async delimiter => {
    const payload = Buffer.from('é'.repeat(MAX_RPC_FRAME_BYTES / 2));
    const input = Readable.from([payload, Buffer.from(delimiter)], { objectMode: false });
    const iterator = frames(input);
    const frame = (await iterator.next()).value!;
    expect(Buffer.byteLength(frame.line)).toBe(MAX_RPC_FRAME_BYTES);
    expect(frame.line.length).toBe(MAX_RPC_FRAME_BYTES / 2);
    frame.release();
    expect((await iterator.next()).done).toBe(true);
  });

  it.each(['', '\n', '\r\n'])('rejects one extra byte before dispatch, with delimiter %j', async delimiter => {
    const input = Readable.from([Buffer.alloc(MAX_RPC_FRAME_BYTES, 97), Buffer.from('X' + delimiter)], { objectMode: false });
    await expect(frames(input).next()).rejects.toThrow(/^RPC_FRAME_TOO_LARGE$/);
    expect(input.destroyed).toBe(true);
  });

  it('counts UTF-8 bytes rather than characters and rejects a nonterminal extra CR', async () => {
    for (const suffix of ['é', '\rX']) {
      const input = Readable.from([Buffer.alloc(MAX_RPC_FRAME_BYTES, 97), Buffer.from(suffix)], { objectMode: false });
      await expect(frames(input).next()).rejects.toThrow(/^RPC_FRAME_TOO_LARGE$/);
    }
  });

  it.each([0, 1])('stops pulling at 64 MiB until release (partial frame bytes: %i)', async partialBytes => {
    expect(MAX_RPC_INPUT_BYTES).toBe(2 * MAX_RPC_FRAME_BYTES);
    const payload = Buffer.alloc(MAX_RPC_FRAME_BYTES, 97);
    const input = Readable.from([payload.subarray(partialBytes), Buffer.from('\n'), payload, Buffer.from('\nlast\n')], { objectMode: false });
    const read = vi.spyOn(input, 'read');
    const iterator = frames(input);
    const first = (await iterator.next()).value!;
    const second = (await iterator.next()).value!;
    let settled = false;
    const third = iterator.next().then(value => { settled = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    const pulls = () => read.mock.calls.filter(([size]) => size! > 0).length;
    const calls = pulls();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(pulls()).toBe(calls);
    expect(read.mock.results.reduce((sum, result) => sum + (Buffer.isBuffer(result.value) ? result.value.length : 0), 0))
      .toBe(MAX_RPC_INPUT_BYTES + 2); // Two LF delimiters, no extra JSON payload.
    first.release();
    first.release(); // Lease release is idempotent.
    const last = (await third).value!;
    expect(last.line).toBe('last');
    second.release();
    last.release();
    expect((await iterator.next()).done).toBe(true);
  });
});
