// Shared browser transport primitives; no conversation/terminal/store ownership.
const MAX_CHAT_STREAM_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_CHAT_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_CHAT_STREAM_EVENTS = 100_000;
const CHAT_STREAM_IDLE_TIMEOUT_MS = 120_000;
let authToken = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('ai-harness-auth-token') ?? '' : '';
export function setAuthToken(token: string): void {
  const candidate = typeof token === 'string' ? token.trim() : '';
  authToken = candidate.length <= 10_000 && utf8ByteLength(candidate) <= 10_000
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(candidate)
    ? candidate : '';
  if (typeof sessionStorage !== 'undefined') {
    if (authToken) sessionStorage.setItem('ai-harness-auth-token', authToken);
    else sessionStorage.removeItem('ai-harness-auth-token');
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  return fetch(input, { ...init, headers, credentials: init.credentials ?? 'same-origin' }).then(response => {
    if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event('aih-auth-required'));
    return response;
  });
}

export function authenticateXhr(request: XMLHttpRequest): void {
  if (authToken) request.setRequestHeader('Authorization', `Bearer ${authToken}`);
}

async function readChatStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Provider stream was idle for too long.')), CHAT_STREAM_IDLE_TIMEOUT_MS);
  });
  try { return await Promise.race([reader.read(), deadline]); }
  finally { if (timer) clearTimeout(timer); }
}

export async function* boundedSseRecords(response: Response): AsyncGenerator<{ event: string; data: string }, void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No event stream');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let event = 'message';
  let dataLines: string[] = [];
  let eventBytes = 0;
  let transportedBytes = 0;
  let events = 0;
  let linesSeen = 0;
  let completed = false;
  const dispatch = (): { event: string; data: string } | undefined => {
    if (!dataLines.length) { event = 'message'; return undefined; }
    if (++events > MAX_CHAT_STREAM_EVENTS) throw new Error('Event stream exceeded its limit.');
    const record = { event, data: dataLines.join('\n') };
    event = 'message';
    dataLines = [];
    eventBytes = 0;
    return record;
  };
  try {
    while (true) {
      const { done, value } = await readChatStreamChunk(reader);
      if (value) {
        transportedBytes += value.byteLength;
        if (value.byteLength > MAX_CHAT_STREAM_CHUNK_BYTES || transportedBytes > MAX_CHAT_STREAM_BYTES) {
          throw new Error('Event stream exceeded its output limit.');
        }
        buffer += decoder.decode(value, { stream: !done });
      }
      if (done) { buffer += decoder.decode(); completed = true; }
      if (utf8ByteLength(buffer) > MAX_CHAT_STREAM_CHUNK_BYTES) {
        throw new Error('Event stream record exceeded its output limit.');
      }
      const lines = buffer.split('\n');
      buffer = done ? '' : lines.pop() ?? '';
      for (const rawLine of lines) {
        if (++linesSeen > MAX_CHAT_STREAM_EVENTS * 4) throw new Error('Event stream exceeded its limit.');
        const line = rawLine.replace(/\r$/u, '');
        if (!line) {
          const record = dispatch();
          if (record) yield record;
          continue;
        }
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) {
          const candidate = line.slice(6).trim();
          if (!/^[A-Za-z0-9._-]{1,128}$/u.test(candidate)) throw new Error('Event stream was invalid.');
          event = candidate;
          continue;
        }
        if (line.startsWith('data:')) {
          const valueText = line.slice(5).replace(/^ /u, '');
          eventBytes += utf8ByteLength(valueText);
          if (eventBytes > MAX_CHAT_STREAM_CHUNK_BYTES || dataLines.length >= 10_000) {
            throw new Error('Event stream record exceeded its output limit.');
          }
          dataLines.push(valueText);
        }
      }
      if (done) {
        const record = dispatch();
        if (record) yield record;
        break;
      }
    }
  } finally {
    if (!completed) void reader.cancel('event-stream-abandoned').catch(() => undefined);
    try { reader.releaseLock(); } catch { /* A pending hostile reader may retain the lock. */ }
  }
}
