import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { EncryptedCredentialStore, JsonlSessionStore, MockProvider, ProviderCredentialService, SessionManager } from '@ai-harness/core';
import { CommandHandler } from './handler.js';
import type { TerminalUI } from '../tui/terminal-ui.js';
import * as codexLogin from '../security/codex-login.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const token = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'cli-account' } })).toString('base64url') + '.cHJpdmF0ZQ';
const refresh = 'private-codex-cli-refresh';
const tokens = () => Response.json({ access_token: token, refresh_token: refresh, expires_in: 3600 });
async function fixture(hold = false, persistent = true, code = 'PUBLIC-CODE') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-codex-login-')); roots.push(root);
  const file = path.join(root, 'credentials.enc');
  const reopen = () => new ProviderCredentialService({ ...(persistent ? { store: new EncryptedCredentialStore(file, 'disposable-codex-master') } : {}) });
  const credentials = reopen(); await credentials.load();
  const messages: string[] = [], errors: string[] = [], host = new AbortController(), caller = new AbortController();
  const mock = new MockProvider({ type: 'mock' });
  const handler = new CommandHandler(new SessionManager(), new JsonlSessionStore(root), {
    writeOutput: (message: string) => messages.push(message), showError: (message: string) => errors.push(message),
  } as unknown as TerminalUI, undefined, undefined, { cwd: root, credentialService: credentials,
    providers: new Map([['mock', mock]]), providerLifetime: host.signal });
  handler.getContext().signal = caller.signal;
  let ready!: () => void, release!: (response: Response) => void;
  const reached = new Promise<void>(resolve => { ready = resolve; });
  const held = new Promise<Response>(resolve => { release = resolve; });
  const calls: Array<{ url: string; body: string; method: string; authorization: string | null }> = [];
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body ?? ''), method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('authorization') });
    if (String(url).endsWith('/deviceauth/usercode')) return Response.json({ device_auth_id: 'private-codex-device', user_code: code, interval: 1 });
    if (String(url).endsWith('/deviceauth/token')) return Response.json({ authorization_code: 'private-codex-code', code_verifier: 'private-codex-verifier' });
    expect(String(url)).toBe('https://auth.openai.com/oauth/token'); ready();
    return hold ? held : tokens();
  });
  return { handler, file, reopen, credentials, messages, errors, host, caller, mock, calls, transport, reached, release: () => release(tokens()) };
}

it.each(['openai-codex', 'team-label'])('publishes the explicit Codex issuer under %s without selecting it or discovering models', async label => {
  const f = await fixture();
  await f.handler.execute(`/login ${label} --issuer openai-codex`);
  expect(f.errors).toEqual([]);
  expect(f.messages).toContain('Ouvrez https://auth.openai.com/codex/device et saisissez le code PUBLIC-CODE.');
  expect(f.messages.at(-1)).toContain('Authentification OAuth réussie');
  expect(f.handler.getContext().provider).toBe(f.mock);
  expect(f.handler.getContext().providers.has('openai-codex')).toBe(label === 'openai-codex');
  const reader = f.reopen(); await reader.load();
  expect((await reader.resolve(label, { env: {}, subscriptionProvider: 'openai-codex' }))?.credential).toMatchObject({
    accessToken: token, refreshToken: refresh, subscription: { provider: 'openai-codex', accountId: 'cli-account' },
  });
  expect(await reader.resolve(label, { env: {} })).toBeUndefined();
  expect(await reader.resolve(label, { env: {}, subscriptionProvider: 'github-copilot' })).toBeUndefined();
  expect(f.calls.map(({ url, method, authorization }) => ({ url, method, authorization }))).toEqual([
    { url: 'https://auth.openai.com/api/accounts/deviceauth/usercode', method: 'POST', authorization: null },
    { url: 'https://auth.openai.com/api/accounts/deviceauth/token', method: 'POST', authorization: null },
    { url: 'https://auth.openai.com/oauth/token', method: 'POST', authorization: null },
  ]);
  expect(JSON.parse(f.calls[0]!.body)).toEqual({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' });
  expect((await stat(f.file)).mode & 0o777).toBe(0o600);
  for (const secret of [token, refresh, 'private-codex-device', 'private-codex-code', 'private-codex-verifier']) {
    expect((await readFile(f.file, 'utf8')) + f.messages.join('\n')).not.toContain(secret);
  }
  if (label === 'openai-codex') {
    await reader.delete(label);
    await expect(f.handler.getContext().providers.get(label)!.chat([])).rejects.toThrow('OpenAI Codex');
    expect(f.calls).toHaveLength(3);
  }
});

it.each(['logout', 'replace', 'cancel', 'close', 'new-login'] as const)('cannot resurrect a held Codex login after %s', async mutation => {
  const f = await fixture(true);
  const pending = f.handler.execute('/login openai-codex --issuer=openai-codex'); await f.reached;
  if (mutation === 'logout') await f.handler.execute('/logout openai-codex');
  else if (mutation === 'replace') await f.reopen().setApiKey('openai-codex', 'replacement-key');
  else if (mutation === 'new-login') await f.credentials.prepareOAuthLogin('openai-codex');
  else if (mutation === 'cancel') f.caller.abort();
  else f.host.abort();
  if (mutation === 'cancel' || mutation === 'close') await pending;
  f.release(); await pending;
  expect(f.errors).toEqual(['Command failed.']);
  expect(f.messages.join('\n')).not.toContain('Authentification OAuth réussie');
  expect(f.handler.getContext().providers.has('openai-codex')).toBe(false);
  const reader = f.reopen(); await reader.load();
  expect(await reader.resolve('openai-codex', { env: {}, subscriptionProvider: 'openai-codex' })).toBeUndefined();
  expect((await reader.resolve('openai-codex', { env: {} }))?.credential).toEqual(mutation === 'replace'
    ? { version: 1, type: 'api-key', apiKey: 'replacement-key' } : undefined);
});

it('saves explicit login but retains other providers when Codex cannot use the host transport', async () => {
  const f = await fixture();
  f.handler.getContext().providerNetwork = { transport: 'websocket', httpIdleTimeoutMs: 12, websocketConnectTimeoutMs: 34,
    requestTimeoutMs: 56, maxRetries: 0, maxRetryDelayMs: 78 };
  await f.handler.execute('/login openai-codex --issuer openai-codex');
  expect(f.errors).toEqual([]); expect(f.messages.at(-1)).toContain('Authentification OAuth réussie');
  expect(f.handler.getContext().provider).toBe(f.mock);
  expect(f.handler.getContext().providers.has('openai-codex')).toBe(false);
  const reader = f.reopen(); await reader.load();
  expect((await reader.resolve('openai-codex', { env: {}, subscriptionProvider: 'openai-codex' }))?.credential).toMatchObject({ type: 'oauth', accessToken: token });
});

it('requires encrypted storage before contacting the Codex issuer', async () => {
  const f = await fixture(false, false);
  await f.handler.execute('/login openai-codex --issuer openai-codex');
  expect(f.messages.at(-1)).toContain('stockage chiffré'); expect(f.transport).not.toHaveBeenCalled();
});

it.each(['--method browser', '--issuer github-copilot --method browser', '--issuer openai-codex --method other',
  '--issuer openai-codex --method browser --method device'])('refuses ambiguous browser arguments: %s', async args => {
  const f = await fixture();
  await f.handler.execute('/login openai-codex ' + args);
  expect(f.messages).toHaveLength(1); expect(f.messages[0]).toContain('Usage: /login');
  expect(f.transport).not.toHaveBeenCalled(); expect(f.credentials.list()).toEqual([]);
});

it('does not mount a retired CLI owner after a browser helper returns with credentials already committed', async () => {
  const f = await fixture();
  vi.spyOn(codexLogin, 'loginOpenAICodexBrowser').mockImplementationOnce(async (credentials, label, _instructions, signal) => {
    const publish = await credentials.prepareOAuthLogin(label, signal);
    await publish({ accessToken: token, refreshToken: refresh, expiresAt: Date.now() + 3600_000,
      subscription: { provider: 'openai-codex', accountId: 'cli-account' } });
    f.host.abort();
  });
  await f.handler.execute('/login openai-codex --issuer=openai-codex --method=browser');
  expect(f.errors).toEqual(['Command failed.']); expect(f.messages).toEqual([]);
  expect(f.handler.getContext().providers.has('openai-codex')).toBe(false); expect(f.handler.getContext().provider).toBe(f.mock);
  const reader = f.reopen(); await reader.load();
  expect((await reader.resolve('openai-codex', { env: {}, subscriptionProvider: 'openai-codex' }))?.credential).toMatchObject({ accessToken: token, refreshToken: refresh });
});

it('requires encrypted storage before opening a browser callback listener', async () => {
  const f = await fixture(false, false);
  await f.handler.execute('/login openai-codex --issuer=openai-codex --method=browser');
  expect(f.messages.at(-1)).toContain('stockage chiffré'); expect(f.transport).not.toHaveBeenCalled();
});

it('refuses terminal-altered instructions without polling or publication', async () => {
  const f = await fixture(false, true, '\u001b[31mCODE');
  await f.handler.execute('/login openai-codex --issuer openai-codex');
  expect(f.errors).toEqual(['Command failed.']); expect(f.messages).toEqual([]);
  expect(f.calls).toHaveLength(1); expect(f.credentials.list()).toEqual([]);
});
