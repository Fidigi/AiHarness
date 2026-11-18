import { request } from 'node:http';
import { beginOpenRouterLogin, type ProviderCredentialService } from '@ai-harness/core';
import { completeOpenRouterLoopback } from './oauth-loopback.js';

/** Standalone input only: no readline history/echo; never borrow the interactive TUI's input owner. */
export function readOpenRouterRedirect(signal: AbortSignal, cancel: () => void, input: NodeJS.ReadStream = process.stdin): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw, wasFlowing = input.readableFlowing; let settled = false, bytes = 0, changedRaw = false; const chunks: Buffer[] = [];
    const finish = (error?: Error, value?: string) => {
      if (settled) return; settled = true; input.off('data', data); input.off('end', end); input.off('error', failed); signal.removeEventListener('abort', aborted);
      if (changedRaw) input.setRawMode(false); if (wasFlowing !== true) input.pause(); chunks.length = 0;
      if (error) reject(error); else resolve(value);
    };
    const end = () => { try { const value = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); finish(undefined, value || undefined); } catch { finish(new Error('Invalid OpenRouter callback input.')); } };
    const failed = () => finish(new Error('OpenRouter callback input failed.')), aborted = () => finish(new Error('OpenRouter callback input cancelled.'));
    const data = (value: Buffer | string) => {
      const chunk = typeof value === 'string' ? Buffer.from(value) : value;
      if (input.isTTY && chunk.includes(3)) { cancel(); aborted(); return; }
      const stop = chunk.findIndex(byte => byte === 10 || byte === 13 || input.isTTY && byte === 4), part = stop < 0 ? chunk : chunk.subarray(0, stop); bytes += part.length;
      if (bytes > 8192) { finish(new Error('Invalid OpenRouter callback input.')); return; }
      chunks.push(Buffer.from(part)); if (stop >= 0) end();
    };
    if (signal.aborted) { aborted(); return; } if (input.readableEnded) { end(); return; }
    try { if (input.isTTY && !wasRaw) { input.setRawMode(true); changedRaw = true; } input.on('data', data); input.once('end', end); input.once('error', failed); signal.addEventListener('abort', aborted, { once: true }); input.resume(); }
    catch { failed(); }
  });
}
async function forwardCallback(value: string, callbackUrl: string, signal: AbortSignal): Promise<void> {
  if (Buffer.byteLength(value) > 8192 || /[\u0000-\u0020\u007f-\u009f]/u.test(value)) throw new Error('Invalid OpenRouter callback input.');
  const target = new URL(value), expected = new URL(callbackUrl);
  if (target.origin !== expected.origin || target.pathname !== expected.pathname || target.username || target.password || target.hash) throw new Error('Invalid OpenRouter callback input.');
  // Reach only the listener this login already owns; its existing parser and Core PKCE remain authoritative.
  await new Promise<void>((resolve, reject) => {
    const client = request(target, { method: 'GET', signal, headers: { connection: 'close' } }, response => { response.resume(); response.once('end', () => response.statusCode === 200 ? resolve() : reject(new Error('OpenRouter callback refused.'))); response.once('error', reject); });
    client.once('error', reject); client.end();
  });
}
/** Explicit OpenRouter issuer; the result is an ordinary permanent API key, never a refresh pair. */
export async function loginOpenRouter(credentials: ProviderCredentialService, label: string, instructions: (message: string) => void, signal: AbortSignal,
  manualInput?: (signal: AbortSignal) => Promise<string | undefined>): Promise<void> {
  const owner = new AbortController(), lifetime = AbortSignal.any([signal, owner.signal]); let callbackUrl = '';
  try {
    lifetime.throwIfAborted(); const publish = await credentials.prepareApiKeyLogin(label, lifetime); lifetime.throwIfAborted();
    await completeOpenRouterLoopback(callback => { callbackUrl = callback; return beginOpenRouterLogin(callback, { signal: lifetime, redactor: credentials.redactor }); },
      url => { if (manualInput) void manualInput(lifetime).then(value => value === undefined ? undefined : forwardCallback(value, callbackUrl, lifetime)).catch(() => { if (!lifetime.aborted) owner.abort(); }); instructions(url); }, lifetime, value => publish(value.apiKey));
    lifetime.throwIfAborted();
  } finally { owner.abort(); }
}
