import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { EncryptedCredentialStore, JsonlSessionStore, MockProvider, ProviderCredentialService, SessionManager, type ProviderOAuthCredential } from '@ai-harness/core';
import { CommandHandler } from './handler.js';
import type { TerminalUI } from '../tui/terminal-ui.js';
import * as radiusLogin from '../security/radius-login.js';

const roots: string[] = [], gateway = 'https://synthetic-command-radius.test';
const tokens = () => Response.json({ access_token: 'private-radius-access', refresh_token: 'private-radius-refresh', expires_in: 3600 });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(persistent = true, hold = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-radius-command-')); roots.push(root); vi.stubEnv('RADIUS_GATEWAY', gateway);
  for (const name of ['RADIUS_API_KEY', 'AI_HARNESS_RADIUS_API_KEY', 'AI_HARNESS_RADIUS_API_KEY_COMMAND']) vi.stubEnv(name, undefined);
  const file = path.join(root, 'credentials.enc'), credentials = new ProviderCredentialService({ ...(persistent ? { store: new EncryptedCredentialStore(file, 'synthetic-radius-master-key') } : {}) }); await credentials.load();
  const messages: string[] = [], errors: string[] = [], host = new AbortController(), caller = new AbortController(), mock = new MockProvider({ type: 'mock' });
  const handler = new CommandHandler(new SessionManager(), new JsonlSessionStore(root), { writeOutput: (message: string) => messages.push(message), showError: (message: string) => errors.push(message) } as unknown as TerminalUI,
    undefined, undefined, { cwd: root, providers: new Map([['mock', mock]]), credentialService: credentials, providerLifetime: host.signal }); handler.getContext().signal = caller.signal;
  let release!: (value: Response) => void, ready!: () => void; const reached = new Promise<void>(resolve => { ready = resolve; }), held = new Promise<Response>(resolve => { release = resolve; });
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    if (String(url) === gateway + '/v1/oauth/device') return Response.json({ device_code: 'private-radius-device', user_code: 'VISIBLE-CODE', verification_uri: 'https://synthetic-login.test/device', expires_in: 600, interval: 1 });
    expect(String(url)).toBe(gateway + '/v1/oauth/token'); ready(); return hold ? held : tokens();
  });
  return { handler, credentials, messages, errors, host, caller, mock, fetch, file, reached, release: () => release(tokens()) };
}
it.each(['radius', 'team-radius'])('mounts only canonical %s native OAuth without selection, catalogue discovery or key flattening', async label => {
  const f = await fixture(); await f.handler.execute(`/login ${label} --issuer radius`);
  expect(f.errors).toEqual([]); expect(f.messages[0]).toBe('Ouvrez https://synthetic-login.test/device et saisissez le code VISIBLE-CODE.');
  expect(f.messages.at(-1)).toContain('Authentification OAuth réussie'); expect(f.handler.getContext().provider).toBe(f.mock);
  expect(f.handler.getContext().providers.has('radius')).toBe(label === 'radius'); expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(await f.credentials.resolve(label, { env: {} })).toBeUndefined();
  expect((await f.credentials.resolve(label, { env: {}, subscriptionProvider: 'radius' }))?.credential).toMatchObject({ accessToken: 'private-radius-access', subscription: { provider: 'radius', gateway } });
  for (const secret of ['private-radius-access', 'private-radius-refresh', 'private-radius-device']) expect(f.messages.join('\n') + await readFile(f.file, 'utf8')).not.toContain(secret);
  if (label === 'radius') { await f.credentials.delete(label); await expect(f.handler.getContext().providers.get(label)!.chat([])).rejects.toThrow('Radius'); expect(f.fetch).toHaveBeenCalledTimes(2); }
});
it.each(['logout', 'caller', 'host'] as const)('does not publish a held Radius login after %s retirement', async owner => {
  const f = await fixture(true, true), pending = f.handler.execute('/login radius --issuer=radius'); await f.reached;
  if (owner === 'logout') await f.credentials.delete('radius'); else if (owner === 'caller') f.caller.abort(); else f.host.abort();
  if (owner !== 'logout') await pending; f.release(); await pending;
  expect(f.errors).toEqual(['Command failed.']); expect(f.messages.join('\n')).not.toContain('Authentification OAuth réussie');
  expect(f.handler.getContext().providers.has('radius')).toBe(false); expect(await f.credentials.resolve('radius', { env: {}, subscriptionProvider: 'radius' })).toBeUndefined();
});
it('does not mount a retired owner after native Radius credentials were already committed', async () => {
  const f = await fixture();
  vi.spyOn(radiusLogin, 'loginRadius').mockImplementationOnce(async (credentials, label, _method, _instructions, signal) => {
    const credential: ProviderOAuthCredential = { version: 1, type: 'oauth', accessToken: 'private-radius-access', refreshToken: 'private-radius-refresh', expiresAt: Date.now() + 3600000,
      subscription: { provider: 'radius', gateway, grantId: '293da824-4f8b-4d80-84b9-e542c22215eb' } };
    const publish = await credentials.prepareOAuthLogin(label, signal); await publish(credential); f.host.abort(); return credential;
  });
  await f.handler.execute('/login radius --issuer radius --method browser'); expect(f.errors).toEqual(['Command failed.']); expect(f.messages).toEqual([]);
  expect(f.handler.getContext().providers.has('radius')).toBe(false); expect((await f.credentials.resolve('radius', { env: {}, subscriptionProvider: 'radius' }))?.credential.type).toBe('oauth');
});
it('requires an encrypted store before native Radius browser discovery or listener setup', async () => {
  const f = await fixture(false); await f.handler.execute('/login radius --issuer radius --method browser'); expect(f.messages.at(-1)).toContain('stockage chiffré'); expect(f.fetch).not.toHaveBeenCalled();
});
