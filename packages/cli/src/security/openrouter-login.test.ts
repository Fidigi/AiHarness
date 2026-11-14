import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EncryptedCredentialStore, ProviderCredentialService } from '@ai-harness/core';
import { expect, it, vi } from 'vitest';
import * as login from './openrouter-login.js';
const callback = 'http://127.0.0.1:32123/oauth/callback/293da824-4f8b-4d80-84b9-e542c22215eb?code=synthetic-private-code';
it('never forwards a pasted foreign endpoint or replaces a prior key on invalid manual input', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-router-manual-')); let calls = 0; const foreign = createServer((_request, response) => { calls++; response.end(); }); await new Promise<void>(resolve => foreign.listen(0, '127.0.0.1', resolve));
  const credentials = new ProviderCredentialService({ store: new EncryptedCredentialStore(path.join(root, 'credentials.enc'), 'synthetic-manual-master') }); await credentials.load(); await credentials.setApiKey('openrouter', 'synthetic-prior-key');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 1000);
  try {
    await expect(login.loginOpenRouter(credentials, 'openrouter', () => undefined, controller.signal, async () => `http://127.0.0.1:${(foreign.address() as { port: number }).port}/oauth/callback/293da824-4f8b-4d80-84b9-e542c22215eb?code=synthetic-private-code`)).rejects.toThrow();
    expect(calls).toBe(0); expect((await credentials.resolve('openrouter', { env: {} }))?.credential).toMatchObject({ type: 'api-key', apiKey: 'synthetic-prior-key' });
  } finally { clearTimeout(timer); controller.abort(); foreign.closeAllConnections(); await new Promise<void>(resolve => foreign.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
function input() { const stream = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: vi.fn((value: boolean) => { stream.isRaw = value; }) }); return stream; }
it('reads one hidden standalone callback line without echo/history and restores the owned raw input', async () => {
  const stream = input(), controller = new AbortController(), cancel = vi.fn(), pending = login.readOpenRouterRedirect(controller.signal, cancel, stream as unknown as NodeJS.ReadStream);
  stream.write(callback + '\r\n'); expect(await pending).toBe(callback); expect(stream.setRawMode.mock.calls).toEqual([[true], [false]]); expect(stream.listenerCount('data')).toBe(0); expect(stream.isPaused()).toBe(true); expect(cancel).not.toHaveBeenCalled();
});
it('clips hidden callback UTF8/size and treats EOF as disabling manual input, not cancelling browser login', async () => {
  for (const value of [Buffer.from([0xff, 10]), Buffer.from('x'.repeat(8193) + '\n')]) { const stream = input(), pending = login.readOpenRouterRedirect(new AbortController().signal, vi.fn(), stream as unknown as NodeJS.ReadStream); stream.write(value); await expect(pending).rejects.toThrow(); expect(stream.isRaw).toBe(false); expect(stream.listenerCount('data')).toBe(0); }
  const stream = input(), cancel = vi.fn(), pending = login.readOpenRouterRedirect(new AbortController().signal, cancel, stream as unknown as NodeJS.ReadStream); stream.end(); expect(await pending).toBeUndefined(); expect(cancel).not.toHaveBeenCalled(); expect(stream.isRaw).toBe(false);
});
it('releases hidden stdin on caller retirement and forwards raw Ctrl-C to the standalone owner', async () => {
  const stream = input(), controller = new AbortController(), pending = login.readOpenRouterRedirect(controller.signal, vi.fn(), stream as unknown as NodeJS.ReadStream); controller.abort(); await expect(pending).rejects.toThrow(); expect(stream.isRaw).toBe(false); expect(stream.listenerCount('data')).toBe(0);
  const raw = input(), cancel = vi.fn(), keyboard = login.readOpenRouterRedirect(new AbortController().signal, cancel, raw as unknown as NodeJS.ReadStream); raw.write(Buffer.from([3])); await expect(keyboard).rejects.toThrow(); expect(cancel).toHaveBeenCalledOnce(); expect(raw.isRaw).toBe(false);
});
