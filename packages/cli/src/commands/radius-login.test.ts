import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { EncryptedCredentialStore, JsonlSessionStore, MockProvider, ProviderCredentialService, SessionManager, type ProviderOAuthCredential } from '@ai-harness/core';
import { CommandHandler } from './handler.js';
import type { TerminalUI } from '../tui/terminal-ui.js';
import * as radiusLogin from '../security/radius-login.js';
import * as kimiLogin from '../security/kimi-login.js';
import * as metaLogin from '../security/meta-login.js';
import * as anthropicLogin from '../security/anthropic-login.js';
import * as openrouterLogin from '../security/openrouter-login.js';

const roots: string[] = [], gateway = 'https://synthetic-command-radius.test';
const tokens = () => Response.json({ access_token: 'private-radius-access', refresh_token: 'private-radius-refresh', expires_in: 3600 });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(persistent = true, hold = false, issuer: 'radius' | 'kimi-coding' = 'radius') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-radius-command-')); roots.push(root); vi.stubEnv('RADIUS_GATEWAY', gateway); vi.stubEnv('KIMI_CODE_OAUTH_HOST', gateway);
  for (const name of ['KIMI_CODING_API_KEY', 'AI_HARNESS_KIMI_CODING_API_KEY', 'AI_HARNESS_KIMI_CODING_API_KEY_COMMAND']) vi.stubEnv(name, undefined);
  for (const name of ['RADIUS_API_KEY', 'AI_HARNESS_RADIUS_API_KEY', 'AI_HARNESS_RADIUS_API_KEY_COMMAND']) vi.stubEnv(name, undefined);
  const file = path.join(root, 'credentials.enc'), credentials = new ProviderCredentialService({ ...(persistent ? { store: new EncryptedCredentialStore(file, 'synthetic-radius-master-key') } : {}) }); await credentials.load();
  const messages: string[] = [], errors: string[] = [], host = new AbortController(), caller = new AbortController(), mock = new MockProvider({ type: 'mock' });
  const handler = new CommandHandler(new SessionManager(), new JsonlSessionStore(root), { writeOutput: (message: string) => messages.push(message), showError: (message: string) => errors.push(message) } as unknown as TerminalUI,
    undefined, undefined, { cwd: root, providers: new Map([['mock', mock]]), credentialService: credentials, providerLifetime: host.signal }); handler.getContext().signal = caller.signal;
  let release!: (value: Response) => void, ready!: () => void; const reached = new Promise<void>(resolve => { ready = resolve; }), held = new Promise<Response>(resolve => { release = resolve; });
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    if (String(url) === gateway + (issuer === 'radius' ? '/v1/oauth/device' : '/api/oauth/device_authorization')) return Response.json({ device_code: 'private-radius-device', user_code: 'VISIBLE-CODE', verification_uri: 'https://synthetic-login.test/device', verification_uri_complete: 'https://synthetic-login.test/device?code=VISIBLE-CODE', expires_in: 600, interval: issuer === 'radius' ? 1 : 0.001 });
    expect(String(url)).toBe(gateway + (issuer === 'radius' ? '/v1/oauth/token' : '/api/oauth/token')); ready(); return hold ? held : tokens();
  });
  return { handler, credentials, messages, errors, host, caller, mock, fetch, file, reached, release: () => release(tokens()) };
}
async function metaFixture(hold = false) {
  const f = await fixture(); for (const name of ['META_API_KEY', 'AI_HARNESS_META_API_KEY', 'AI_HARNESS_META_API_KEY_COMMAND']) vi.stubEnv(name, undefined); vi.stubEnv('META_BASE_URL', 'https://synthetic-interactive-meta.test/v1'); vi.stubEnv('META_MODEL', 'muse-spark-1.1'); let entered!: () => void, cancel = 0; const ready = new Promise<void>(resolve => { entered = resolve; });
  f.fetch.mockImplementation(async url => {
    if (String(url) === 'https://auth.meta.com/oidc/device/authorization/') return Response.json({ device_code: 'private-meta-device', user_code: 'VISIBLE-META', verification_uri_complete: 'https://auth.meta.com/verify?code=VISIBLE-META', expires_in: 600, interval: 1 });
    if (String(url) === 'https://auth.meta.com/oidc/device/token/') return Response.json({ access_token: 'private-meta-identity' });
    expect(String(url)).toBe('https://api.meta.ai/muse-code/key'); entered(); return hold ? new Response(new ReadableStream({ cancel() { cancel++; return new Promise(() => {}); } })) : Response.json({ api_key: 'private-meta-api-key' });
  }); return { ...f, ready, cancellations: () => cancel };
}
it.each(['meta', 'team-meta'])('mounts canonical-only %s native Meta Device state without selection or identity/key flattening', async label => {
  const f = await metaFixture(); await f.handler.execute(`/login ${label} --issuer meta --method device`); expect(f.errors).toEqual([]); expect(f.messages[0]).toBe('Ouvrez https://auth.meta.com/verify?code=VISIBLE-META et saisissez le code VISIBLE-META.'); expect(f.handler.getContext().provider).toBe(f.mock); expect(f.handler.getContext().providers.has('meta')).toBe(label === 'meta'); expect(f.fetch).toHaveBeenCalledTimes(3); expect(await f.credentials.resolve(label, { env: {} })).toBeUndefined(); expect((await f.credentials.resolve(label, { env: {}, subscriptionProvider: 'meta' }))?.credential).toMatchObject({ accessToken: 'private-meta-api-key', refreshToken: 'private-meta-identity', subscription: { provider: 'meta' } }); for (const secret of ['private-meta-device', 'private-meta-identity', 'private-meta-api-key']) expect(f.messages.join('\n') + await readFile(f.file, 'utf8')).not.toContain(secret);
});
it.each(['environment', 'command'] as const)('retains Meta %s key priority after explicit native interactive login', async source => {
  const f = await metaFixture(); if (source === 'environment') vi.stubEnv('META_API_KEY', 'priority-meta-key'); else vi.stubEnv('AI_HARNESS_META_API_KEY_COMMAND', 'must-not-run'); await f.handler.execute('/login meta --issuer meta'); expect(f.errors).toEqual([]); if (source === 'command') { expect(f.handler.getContext().providers.has('meta')).toBe(false); return; }
  f.fetch.mockImplementation(async (_url, init) => { expect(new Headers(init?.headers).get('authorization')).toBe('Bearer priority-meta-key'); return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'r', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'priority kept' }] }], usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } }); }); expect((await f.handler.getContext().providers.get('meta')!.chat([{ id: 'u', role: 'user', timestamp: new Date(), content: 'Probe' }])).content).toBe('priority kept');
});
it('does not mount retired Meta ownership after encrypted commit or erase the committed native credential', async () => {
  const f = await fixture(); vi.spyOn(metaLogin, 'loginMeta').mockImplementationOnce(async (credentials, label, _instructions, signal) => { const credential: ProviderOAuthCredential = { version: 1, type: 'oauth', accessToken: 'committed-meta-key', refreshToken: 'committed-meta-identity', expiresAt: Date.now() + 86400000, subscription: { provider: 'meta', grantId: '12345678-1234-4234-8234-123456789abc' } }; const publish = await credentials.prepareOAuthLogin(label, signal); await publish(credential); f.host.abort(); return credential; }); await f.handler.execute('/login meta --issuer meta'); expect(f.errors).toEqual(['Command failed.']); expect(f.handler.getContext().providers.has('meta')).toBe(false); expect((await f.credentials.resolve('meta', { env: {}, subscriptionProvider: 'meta' }))?.credential.type).toBe('oauth'); expect(f.fetch).not.toHaveBeenCalled();
});
it('cancels held Meta mint with the interactive caller without late publication and rejects browser before I/O', async () => {
  const f = await metaFixture(true); await f.handler.execute('/login meta --issuer meta --method browser'); expect(f.fetch).not.toHaveBeenCalled(); const pending = f.handler.execute('/login meta --issuer meta'); await f.ready; f.caller.abort(); await pending; expect(f.cancellations()).toBe(1); expect(f.handler.getContext().providers.has('meta')).toBe(false); expect(await f.credentials.resolve('meta', { env: {}, subscriptionProvider: 'meta' })).toBeUndefined();
});
async function anthropicFixture(hold = false) {
  const realFetch = globalThis.fetch, f = await fixture(); for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'AI_HARNESS_ANTHROPIC_API_KEY_COMMAND']) vi.stubEnv(name, undefined); vi.stubEnv('ANTHROPIC_BASE_URL', 'https://synthetic-interactive-anthropic.test');
  let entered!: () => void, cancellation = 0, callback: Promise<unknown> | undefined; const ready = new Promise<void>(resolve => { entered = resolve; }), writes = f.handler.getContext().terminal.writeOutput;
  f.handler.getContext().terminal.writeOutput = message => { writes(message); const value = message.match(/https:\/\/claude\.ai\/oauth\/authorize\?\S+/u)?.[0]; if (!value) return; const authorization = new URL(value), target = new URL(authorization.searchParams.get('redirect_uri')!); target.searchParams.set('code', 'synthetic-private-claude-code'); target.searchParams.set('state', authorization.searchParams.get('state')!); callback = realFetch(target).then(response => response.text(), error => error); };
  f.fetch.mockImplementation(async url => { expect(String(url)).toBe('https://platform.claude.com/v1/oauth/token'); entered(); return hold ? new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('{')); }, cancel() { cancellation++; return new Promise(() => undefined); } })) : Response.json({ access_token: 'synthetic-claude-access', refresh_token: 'synthetic-claude-refresh', expires_in: 3600 }); });
  return { ...f, ready, callback: () => callback, cancellations: () => cancellation };
}
it.each(['anthropic', 'team-claude'])('mounts canonical-only %s native Anthropic browser state without selection/key flattening', async label => {
  const f = await anthropicFixture(); await f.handler.execute(`/login ${label} --issuer=anthropic --method=browser`); await f.callback(); expect(f.errors).toEqual([]); expect(f.messages.at(-1)).toContain('Authentification OAuth réussie'); expect(f.handler.getContext().provider).toBe(f.mock); expect(f.handler.getContext().providers.has('anthropic')).toBe(label === 'anthropic'); expect(f.fetch).toHaveBeenCalledOnce(); expect(await f.credentials.resolve(label, { env: {} })).toBeUndefined(); expect((await f.credentials.resolve(label, { env: {}, subscriptionProvider: 'anthropic' }))?.credential).toMatchObject({ subscription: { provider: 'anthropic' } }); for (const secret of ['synthetic-private-claude-code', 'synthetic-claude-access', 'synthetic-claude-refresh']) expect(f.messages.join('\n') + await readFile(f.file, 'utf8')).not.toContain(secret);
});
it.each(['environment', 'command'] as const)('retains Anthropic %s key priority after native interactive login', async source => {
  const f = await anthropicFixture(); if (source === 'environment') vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-priority-claude-key'); else vi.stubEnv('AI_HARNESS_ANTHROPIC_API_KEY_COMMAND', 'synthetic-command-must-not-run'); await f.handler.execute('/login anthropic --issuer anthropic'); await f.callback(); expect(f.errors).toEqual([]); if (source === 'command') { expect(f.handler.getContext().providers.has('anthropic')).toBe(false); return; }
  f.fetch.mockImplementation(async (url, init) => { expect(String(url)).toBe('https://synthetic-interactive-anthropic.test/v1/messages'); expect(new Headers(init?.headers).get('x-api-key')).toBe('synthetic-priority-claude-key'); expect(new Headers(init?.headers).get('authorization')).toBeNull(); return Response.json({ model: 'claude-sonnet-4-6', stop_reason: 'end_turn', content: [{ type: 'text', text: 'priority-kept' }], usage: { input_tokens: 1, output_tokens: 1 } }); }); expect((await f.handler.getContext().providers.get('anthropic')!.chat([{ id: 'u', role: 'user', timestamp: new Date(), content: 'synthetic' }])).content).toBe('priority-kept');
});
it('does not mount retired Anthropic login after its native grant is committed', async () => {
  const f = await fixture(); vi.spyOn(anthropicLogin, 'loginAnthropic').mockImplementationOnce(async (credentials, label, _method, _instructions, signal) => { const credential: ProviderOAuthCredential = { version: 1, type: 'oauth', accessToken: 'synthetic-committed-claude', refreshToken: 'synthetic-committed-refresh', expiresAt: Date.now() + 3600000, subscription: { provider: 'anthropic', grantId: '12345678-1234-4234-8234-123456789abc' } }; const publish = await credentials.prepareOAuthLogin(label, signal); await publish(credential); f.host.abort(); return credential; }); await f.handler.execute('/login anthropic --issuer anthropic'); expect(f.errors).toEqual(['Command failed.']); expect(f.handler.getContext().providers.has('anthropic')).toBe(false); expect((await f.credentials.resolve('anthropic', { env: {}, subscriptionProvider: 'anthropic' }))?.credential.type).toBe('oauth'); expect(f.fetch).not.toHaveBeenCalled();
});
it('retires the interactive Anthropic listener/held token body with the caller without late publication', async () => {
  const f = await anthropicFixture(true), pending = f.handler.execute('/login anthropic --issuer anthropic'); await f.ready; f.caller.abort(); await pending; await f.callback(); expect(f.errors).toEqual(['Command failed.']); expect(f.cancellations()).toBe(1); expect(f.handler.getContext().providers.has('anthropic')).toBe(false); expect(await f.credentials.resolve('anthropic', { env: {}, subscriptionProvider: 'anthropic' })).toBeUndefined();
});
it('does not borrow interactive TUI input for Anthropic copy-code or device methods', async () => {
  const f = await fixture(); for (const method of ['copy-code', 'device']) await f.handler.execute('/login anthropic --issuer anthropic --method ' + method); expect(f.messages.every(message => message.includes('Usage:'))).toBe(true); expect(f.fetch).not.toHaveBeenCalled(); expect(f.credentials.list()).toEqual([]);
});
async function openrouterFixture(hold = false) {
  const realFetch = globalThis.fetch, f = await fixture(); for (const name of ['OPENROUTER_API_KEY', 'AI_HARNESS_OPENROUTER_API_KEY', 'AI_HARNESS_OPENROUTER_API_KEY_COMMAND']) vi.stubEnv(name, undefined);
  let entered!: () => void, cancellation = 0, callback: Promise<unknown> | undefined; const ready = new Promise<void>(resolve => { entered = resolve; });
  const writes = f.handler.getContext().terminal.writeOutput;
  f.handler.getContext().terminal.writeOutput = message => { writes(message); const value = message.match(/https:\/\/openrouter\.ai\/auth\?\S+/u)?.[0]; if (!value) return;
    const authorization = new URL(value), target = new URL(authorization.searchParams.get('callback_url')!); expect(Number(target.port)).toBeGreaterThan(0); expect(target.pathname).toMatch(/^\/oauth\/callback\/[a-f0-9-]{36}$/u); expect(authorization.searchParams.has('state')).toBe(false);
    target.searchParams.set('code', 'synthetic-router-code'); callback = realFetch(target).then(response => response.text(), error => error);
  };
  f.fetch.mockImplementation(async url => {
    expect(String(url)).toBe('https://openrouter.ai/api/v1/auth/keys'); entered();
    return hold ? new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('{')); }, cancel() { cancellation++; return new Promise(() => undefined); } })) : Response.json({ key: 'synthetic-router-permanent-key' });
  });
  return { ...f, ready, callback: () => callback, cancellations: () => cancellation };
}
it.each(['openrouter', 'team-router'])('publishes canonical-only %s OpenRouter PKCE key login without selecting it or inventing refresh', async label => {
  const f = await openrouterFixture(); await f.handler.execute(`/login ${label} --issuer openrouter`);
  expect(f.errors).toEqual([]); expect(f.messages.at(-1)).toContain('Authentification OAuth réussie'); await f.callback();
  expect(f.handler.getContext().provider).toBe(f.mock); expect(f.handler.getContext().providers.has('openrouter')).toBe(label === 'openrouter'); expect(f.fetch).toHaveBeenCalledOnce();
  expect((await f.credentials.resolve(label, { env: {} }))?.credential).toEqual({ version: 1, type: 'api-key', apiKey: 'synthetic-router-permanent-key' }); expect(f.credentials.list()).toMatchObject([{ type: 'api-key', refreshable: false }]);
  for (const secret of ['synthetic-router-code', 'synthetic-router-permanent-key']) expect(f.messages.join('\n') + await readFile(f.file, 'utf8')).not.toContain(secret);
});
it.each(['environment', 'command'] as const)('preserves OpenRouter %s key priority after interactive login', async source => {
  const f = await openrouterFixture();
  if (source === 'environment') vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-priority-router-key'); else vi.stubEnv('AI_HARNESS_OPENROUTER_API_KEY_COMMAND', 'synthetic-command-must-not-run');
  await f.handler.execute('/login openrouter --issuer openrouter'); expect(f.errors).toEqual([]); await f.callback();
  if (source === 'command') { expect(f.handler.getContext().providers.has('openrouter')).toBe(false); return; }
  f.fetch.mockImplementation(async (url, init) => { expect(String(url)).toBe('https://openrouter.ai/api/v1/chat/completions'); expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-priority-router-key');
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'priority-kept' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }); });
  const result = await f.handler.getContext().providers.get('openrouter')!.chat([{ id: 'synthetic-user', role: 'user', content: 'check', timestamp: new Date() }]); expect(result.content).toBe('priority-kept');
});
it('does not mount a retired OpenRouter helper or erase its already committed permanent key', async () => {
  const f = await fixture(); vi.spyOn(openrouterLogin, 'loginOpenRouter').mockImplementationOnce(async (credentials, label, _instructions, signal) => {
    const publish = await credentials.prepareApiKeyLogin(label, signal); await publish('synthetic-committed-router-key'); f.host.abort();
  });
  await f.handler.execute('/login openrouter --issuer openrouter'); expect(f.errors).toEqual(['Command failed.']); expect(f.handler.getContext().providers.has('openrouter')).toBe(false);
  expect((await f.credentials.resolve('openrouter', { env: {} }))?.credential).toMatchObject({ type: 'api-key', apiKey: 'synthetic-committed-router-key' }); expect(f.fetch).not.toHaveBeenCalled();
});
it('retires an interactive OpenRouter listener and held key body with the caller', async () => {
  const f = await openrouterFixture(true), pending = f.handler.execute('/login openrouter --issuer openrouter'); await f.ready; f.caller.abort(); await pending; await f.callback();
  expect(f.errors).toEqual(['Command failed.']); expect(f.cancellations()).toBe(1); expect(f.handler.getContext().providers.has('openrouter')).toBe(false); expect(await f.credentials.resolve('openrouter', { env: {} })).toBeUndefined();
});
it.each(['kimi-coding', 'team-kimi'])('mounts only canonical %s native Kimi issuer state without selection or key flattening', async label => {
  const f = await fixture(true, false, 'kimi-coding'); await f.handler.execute(`/login ${label} --issuer kimi-coding`);
  expect(f.errors).toEqual([]); expect(f.messages[0]).toBe('Ouvrez https://synthetic-login.test/device et saisissez le code VISIBLE-CODE.'); expect(f.handler.getContext().provider).toBe(f.mock);
  expect(f.handler.getContext().providers.has('kimi-coding')).toBe(label === 'kimi-coding'); expect(f.fetch).toHaveBeenCalledTimes(2); expect(await f.credentials.resolve(label, { env: {} })).toBeUndefined();
  expect((await f.credentials.resolve(label, { env: {}, subscriptionProvider: 'kimi-coding' }))?.credential).toMatchObject({ accessToken: 'private-radius-access', subscription: { provider: 'kimi-coding', oauthHost: gateway } });
  for (const secret of ['private-radius-access', 'private-radius-refresh', 'private-radius-device']) expect(f.messages.join('\n') + await readFile(f.file, 'utf8')).not.toContain(secret);
});
it('does not publish a held native Kimi login over absent-slot logout', async () => {
  const f = await fixture(true, true, 'kimi-coding'), pending = f.handler.execute('/login kimi-coding --issuer kimi-coding'); await f.reached; await f.credentials.delete('kimi-coding'); f.release(); await pending;
  expect(f.errors).toEqual(['Command failed.']); expect(f.handler.getContext().providers.has('kimi-coding')).toBe(false); expect(await f.credentials.resolve('kimi-coding', { env: {}, subscriptionProvider: 'kimi-coding' })).toBeUndefined();
});
it('does not mount a retired Kimi owner after its grant was already committed', async () => {
  const f = await fixture(true, false, 'kimi-coding');
  vi.spyOn(kimiLogin, 'loginKimiCoding').mockImplementationOnce(async (credentials, label, _instructions, signal) => {
    const credential: ProviderOAuthCredential = { version: 1, type: 'oauth', accessToken: 'private-kimi', refreshToken: 'private-kimi-refresh', expiresAt: Date.now() + 3600000,
      subscription: { provider: 'kimi-coding', oauthHost: gateway, grantId: '293da824-4f8b-4d80-84b9-e542c22215eb' } };
    const publish = await credentials.prepareOAuthLogin(label, signal); await publish(credential); f.host.abort(); return credential;
  });
  await f.handler.execute('/login kimi-coding --issuer kimi-coding'); expect(f.errors).toEqual(['Command failed.']); expect(f.handler.getContext().providers.has('kimi-coding')).toBe(false);
  expect((await f.credentials.resolve('kimi-coding', { env: {}, subscriptionProvider: 'kimi-coding' }))?.credential.type).toBe('oauth');
});
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
