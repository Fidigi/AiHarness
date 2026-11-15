import { fetchOAuthResponse } from './oauth-device.js';
import type { CredentialRedactor } from './credentials.js';
const failure = () => new Error('Invalid AWS metadata source.');
/** Shared bounded reader for explicit AWS metadata, including uncooperative cancellation. */
export async function readAwsMetadataText(response: Response, signal: AbortSignal, maximum: number): Promise<string> {
  const length = response.headers.get('content-length'), reader = response.body?.getReader();
  if (!reader) throw failure();
  const aborted = Symbol('aborted'); let onAbort!: () => void, complete = false, bytes = 0; const chunks: Uint8Array[] = [];
  const cancellation = new Promise<typeof aborted>(resolve => { onAbort = () => resolve(aborted); if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); });
  try {
    if (length !== null && (!/^(?:0|[1-9]\d*)$/u.test(length) || Number(length) > maximum)) throw failure();
    while (true) { const item = await Promise.race([reader.read(), cancellation]); if (item === aborted) throw failure(); if (item.done) break; bytes += item.value.byteLength; if (bytes > maximum) throw failure(); chunks.push(item.value); }
    const value = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); signal.throwIfAborted(); complete = true; return value;
  } finally { signal.removeEventListener('abort', onAbort); if (!complete) void reader.cancel().catch(() => undefined); try { reader.releaseLock(); } catch { /* A hostile pending read need not settle. */ } }
}
/** Admitted endpoint only; direct/no inference proxy/headers/retry, no IMDSv1 downgrade or token persistence. */
export async function awsImdsV2Session(endpoint: string, ttl: 300 | 21600, signal: AbortSignal, assertParent: (signal: AbortSignal) => Promise<void>, redactor?: Pick<CredentialRedactor, 'add'>): Promise<(suffix: string) => Promise<Response>> {
  const request = async (suffix: string, method: string, headers: Record<string, string>): Promise<Response> => {
    const init: RequestInit = { method, headers, redirect: 'manual', signal };
    const response = await fetchOAuthResponse(endpoint + suffix, init, signal, async (url, init) => { await assertParent(signal); signal.throwIfAborted(); return fetch(url, init); });
    if (response.status !== 200) { void response.body?.cancel().catch(() => undefined); throw failure(); } return response;
  };
  const token = await readAwsMetadataText(await request('/latest/api/token', 'PUT', { 'x-aws-ec2-metadata-token-ttl-seconds': String(ttl) }), signal, 4096);
  if (!/^[!-~]{1,4096}$/u.test(token)) throw failure(); redactor?.add(token);
  return suffix => request(suffix, 'GET', { 'x-aws-ec2-metadata-token': token });
}
