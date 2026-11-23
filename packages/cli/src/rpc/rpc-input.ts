import type { Readable } from 'node:stream';

export const MAX_RPC_FRAME_BYTES = 32 * 1024 * 1024;
export const MAX_RPC_INPUT_BYTES = 64 * 1024 * 1024;
const READ_BYTES = 64 * 1024;

class RpcFrameTooLargeError extends Error {
  constructor() {
    super('RPC_FRAME_TOO_LARGE');
  }
}

interface RpcFrame {
  line: string;
  release(): void;
}

/**
 * Pull bounded byte chunks; retain a frame's byte lease until its handler settles.
 * Stream-owned prefetch, parsed objects and decoded images are not an RSS budget.
 */
export async function* readRpcFrames(
  input: Readable,
  signalShutdown: () => boolean,
): AsyncGenerator<RpcFrame> {
  let retainedBytes = 0;
  let frameBytes = 0;
  let chargedFrameBytes = 0;
  let parts: Buffer[] = [];
  let pendingSurrogate = '';
  let wake: (() => void) | undefined;
  let failure: unknown;
  let ended = input.readableEnded;
  let closed = input.destroyed;
  const notify = (): void => { wake?.(); wake = undefined; };
  const onEnd = (): void => { ended = true; notify(); };
  const onClose = (): void => { closed = true; notify(); };
  const onError = (error: unknown): void => { failure = error; notify(); };
  const wait = (): Promise<void> => new Promise(resolve => { wake = resolve; });
  const release = (bytes: number): void => { retainedBytes -= bytes; notify(); };
  const finish = (): RpcFrame => {
    const bytes = frameBytes;
    const chargedBytes = chargedFrameBytes;
    const payload = Buffer.concat(parts, bytes);
    const length = payload.at(-1) === 13 ? bytes - 1 : bytes;
    const line = payload.toString('utf8', 0, length);
    parts = [];
    frameBytes = 0;
    chargedFrameBytes = 0;
    let released = false;
    return { line, release() { if (!released) { released = true; release(chargedBytes); } } };
  };
  function* toBytes(chunk: string | Buffer): Generator<Buffer> {
    if (typeof chunk !== 'string' && pendingSurrogate) {
      yield Buffer.from(pendingSurrogate);
      pendingSurrogate = '';
    }
    // Embedded object/string streams may loan larger chunks. Encode bounded
    // slices instead of allocating their entire UTF-8 representation up front.
    for (let offset = 0; offset < chunk.length; offset += READ_BYTES) {
      if (typeof chunk !== 'string') { yield chunk.subarray(offset, offset + READ_BYTES); continue; }
      let text = pendingSurrogate + chunk.slice(offset, offset + READ_BYTES);
      pendingSurrogate = '';
      const last = text.charCodeAt(text.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        pendingSurrogate = text.slice(-1);
        text = text.slice(0, -1);
      }
      if (text) yield Buffer.from(text, 'utf8');
    }
  }
  input.on('readable', notify);
  input.on('end', onEnd);
  input.on('close', onClose);
  input.on('error', onError);
  try {
    while (true) {
      if (failure) throw failure;
      if (closed && !ended) {
        throw Object.assign(new Error('RPC input closed before EOF.'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
      }
      // At a full-size frame, only LF/optional CR can still be admitted.
      // Read that delimiter even at the aggregate ceiling; any payload byte is fatal.
      const delimiterOnly = frameBytes >= MAX_RPC_FRAME_BYTES;
      if (retainedBytes >= MAX_RPC_INPUT_BYTES && !delimiterOnly) { await wait(); continue; }
      // read(n) waits for n bytes on an open pipe. Use only currently buffered
      // bytes (or one byte to request more), so a short live command never stalls.
      let chunk: unknown = input.read(Math.min(READ_BYTES, input.readableLength || 1,
        Math.max(MAX_RPC_INPUT_BYTES - retainedBytes, delimiterOnly ? 1 : 0)));
      if (chunk === null) {
        if (!ended) { await wait(); continue; }
        if (!pendingSurrogate) break;
        chunk = Buffer.from(pendingSurrogate);
        pendingSurrogate = '';
      }
      for (const buffer of toBytes(chunk as string | Buffer)) {
        let offset = 0;
        while (offset < buffer.length) {
          if (failure) throw failure;
          if (closed && !ended) {
            throw Object.assign(new Error('RPC input closed before EOF.'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
          }
          if (retainedBytes >= MAX_RPC_INPUT_BYTES && buffer[offset] !== 10) {
            if (frameBytes === MAX_RPC_FRAME_BYTES && buffer[offset] === 13) {
              // This byte can only be a delimiter, never payload. Do not charge it.
              parts.push(Buffer.from([13]));
              frameBytes++;
              offset++;
            } else if (frameBytes >= MAX_RPC_FRAME_BYTES) {
              throw new RpcFrameTooLargeError();
            } else {
              await wait();
            }
            continue;
          }
          const newline = buffer.indexOf(10, offset);
          const end = newline < 0 ? buffer.length : newline;
          const length = Math.min(end - offset, MAX_RPC_INPUT_BYTES - retainedBytes);
          if (length) {
            // One extra byte is permitted only while it may be a CR delimiter.
            const nextBytes = frameBytes + length;
            if (nextBytes > MAX_RPC_FRAME_BYTES + 1
              || nextBytes > MAX_RPC_FRAME_BYTES && buffer[offset + length - 1] !== 13) {
              throw new RpcFrameTooLargeError();
            }
            parts.push(Buffer.from(buffer.subarray(offset, offset + length)));
            frameBytes = nextBytes;
            chargedFrameBytes += length;
            retainedBytes += length;
            offset += length;
          }
          if (offset === end && newline >= 0) {
            yield finish();
            offset++;
          }
        }
      }
    }
    if (frameBytes) yield finish();
  } catch (error) {
    // Only the host's intentional signal-induced close is normal shutdown.
    if (!(signalShutdown() && input.destroyed && error instanceof Error
      && 'code' in error && error.code === 'ERR_STREAM_PREMATURE_CLOSE')) throw error;
  } finally {
    parts = [];
    input.off('readable', notify);
    input.off('end', onEnd);
    input.off('close', onClose);
    input.off('error', onError);
    if (!input.destroyed) input.destroy();
  }
}
