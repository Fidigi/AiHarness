import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { EncryptedCredentialStore, JsonlSessionStore, MockProvider, ProviderCredentialService, SessionManager } from '@ai-harness/core';
import { CommandHandler } from './handler.js';
import type { TerminalUI } from '../tui/terminal-ui.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const grant = 'private-interactive-github-grant', token = 'private-interactive-inference';
async function fixture(hold = false, code = 'PUBLIC-CODE', expiry = 30) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-interactive-login-')); roots.push(root);
  const file = path.join(root, 'credentials.enc'), master = 'disposable-interactive-master';
  const reopen = () => new ProviderCredentialService({ store: new EncryptedCredentialStore(file, master) });
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
    if (String(url).endsWith('/login/device/code')) return Response.json({ device_code: 'private-interactive-device', user_code: code,
      verification_uri: 'https://github.com/login/device?not-for-display=private-interactive-device', expires_in: expiry, interval: 0.001 });
    if (String(url).endsWith('/login/oauth/access_token')) return Response.json({ access_token: grant });
    if (String(url).endsWith('/copilot_internal/v2/token')) return Response.json({ token, expires_at: Math.floor(Date.now() / 1000) + 3600 });
    expect(String(url)).toBe('https://api.individual.githubcopilot.com/models'); ready();
    return hold ? held : Response.json({ data: [{ id: 'gpt-5-mini', model_picker_enabled: true }] });
  });
  return { handler, file, reopen, credentials, messages, errors, host, caller, mock, calls, transport, reached,
    release: () => release(Response.json({ data: [{ id: 'gpt-5-mini', model_picker_enabled: true }] })) };
}

it.each(['github-copilot', 'team-label'])('keeps native issuer, storage and current selection distinct for %s', async label => {
  const f = await fixture();
  await f.handler.execute(`/login ${label} --issuer github-copilot`);
  expect(f.errors).toEqual([]);
  expect(f.messages).toContain(`Ouvrez https://github.com/login/device et saisissez le code PUBLIC-CODE.`);
  expect(f.messages.join('\n')).toContain('Authentification OAuth réussie');
  expect(f.handler.getContext().provider).toBe(f.mock);
  expect(f.handler.getContext().providers.has('github-copilot')).toBe(label === 'github-copilot');
  const reader = f.reopen(); await reader.load();
  expect((await reader.resolve(label, { env: {}, subscriptionProvider: 'github-copilot' }))?.credential).toMatchObject({
    accessToken: token, refreshToken: grant, subscription: { provider: 'github-copilot', availableModelIds: ['gpt-5-mini'] },
  });
  expect(await reader.resolve(label, { env: {} })).toBeUndefined();
  expect(f.calls.map(call => [call.url, call.method, call.authorization])).toEqual([
    ['https://github.com/login/device/code', 'POST', null], ['https://github.com/login/oauth/access_token', 'POST', null],
    ['https://api.github.com/copilot_internal/v2/token', 'GET', `Bearer ${grant}`], ['https://api.individual.githubcopilot.com/models', 'GET', `Bearer ${token}`],
  ]);
  expect(Object.fromEntries(new URLSearchParams(f.calls[0]!.body))).toEqual({ client_id: 'Iv1.b507a08c87ecfe98', scope: 'read:user' });
  expect((await stat(f.file)).mode & 0o777).toBe(0o600);
  for (const secret of [grant, token, 'private-interactive-device']) expect((await readFile(f.file, 'utf8')) + f.messages.join('\n')).not.toContain(secret);
  if (label === 'github-copilot') {
    await reader.delete(label);
    expect(await f.handler.getContext().providers.get(label)!.getAvailableModels()).toEqual([]);
    await expect(f.handler.getContext().providers.get(label)!.chat([])).rejects.toThrow('GitHub Copilot');
    expect(f.calls).toHaveLength(4);
  }
});

it.each(['logout', 'replace', 'cancel', 'close', 'expiry'] as const)('cannot publish a held interactive grant after %s', async mutation => {
  const f = await fixture(true, 'PUBLIC-CODE', mutation === 'expiry' ? 1 : 30);
  const pending = f.handler.execute('/login github-copilot --issuer=github-copilot');
  await f.reached;
  if (mutation === 'logout') await f.handler.execute('/logout github-copilot');
  else if (mutation === 'replace') await f.reopen().setApiKey('github-copilot', 'replacement-key');
  else if (mutation === 'cancel') f.caller.abort();
  else if (mutation === 'close') f.host.abort();
  if (mutation === 'expiry' || mutation === 'cancel' || mutation === 'close') await pending;
  f.release(); await pending;
  expect(f.errors).toEqual(['Command failed.']);
  expect(f.messages.join('\n')).not.toContain('Authentification OAuth réussie');
  expect(f.handler.getContext().providers.has('github-copilot')).toBe(false);
  const reader = f.reopen(); await reader.load();
  expect(await reader.resolve('github-copilot', { env: {}, subscriptionProvider: 'github-copilot' })).toBeUndefined();
  expect((await reader.resolve('github-copilot', { env: {} }))?.credential).toEqual(mutation === 'replace'
    ? { version: 1, type: 'api-key', apiKey: 'replacement-key' } : undefined);
});

it.each(['\u001b[31mCODE', '\ud800', 'REDACTED-CODE'])('refuses altered issuer instructions (%j) before token exchange', async code => {
  const f = await fixture(false, code);
  if (code === 'REDACTED-CODE') f.credentials.redactor.add(code);
  await f.handler.execute('/login github-copilot --issuer github-copilot');
  expect(f.errors).toEqual(['Command failed.']);
  expect(f.messages).toEqual([]);
  expect(f.calls).toHaveLength(1);
  const reader = f.reopen(); await reader.load(); expect(reader.list()).toEqual([]);
});

it('rejects unsupported or conflicting issuer syntax without transport or credential writes', async () => {
  const f = await fixture();
  for (const args of ['github-copilot --issuer other', 'github-copilot --issuer', 'github-copilot --issuer github-copilot extra']) {
    await f.handler.execute('/login ' + args);
    expect(f.messages.at(-1)).toContain('Usage: /login');
  }
  expect(f.transport).not.toHaveBeenCalled(); expect(f.credentials.list()).toEqual([]);
});
