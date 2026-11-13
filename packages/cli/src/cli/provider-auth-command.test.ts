import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLocalTLSFixture } from './fixtures/oauth-local-tls.mjs';
import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EncryptedCredentialStore, ProviderCredentialService } from '@ai-harness/core';

const entry = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const execute = promisify(execFile);
let root: string, cwd: string, agent: string;
let server: Server | undefined;
let requests: string[];
let issuerForms: { url: string; method?: string; contentType?: string; authorization?: string; apiKey?: string; originalUrl?: string; body: string }[];
let transportErrors: { name: string; code?: string }[];
let endpoint: string;
let mode: 'success' | 'device-stall' | 'token-stall' | 'pending' | 'publication-failure' | 'transport-reset';
let activeResponses = 0;
let deviceUserCode = 'VISIBLE-123';
let copilotPickerModel = 'gpt-4o';
let copilotResponseEvents: unknown[] = [];
let holdCopilotCatalogue = false;
let releaseCopilotCatalogue: (() => void) | undefined;
const token = 'disposable-fixture-access-741';
const refresh = 'disposable-fixture-refresh-742';
const master = 'disposable-fixture-master-key-at-least-32-bytes';

function launch(args: string[], env: NodeJS.ProcessEnv = {}, input = '') {
  const bin = process.env.AIH_TOP_LEVEL_CLI_BIN;
  const child = spawn(bin ?? process.execPath, bin ? args : [entry, ...args], {
    cwd, env: { ...process.env, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent,
      AI_HARNESS_MASTER_KEY: master, NO_COLOR: '1', NODE_EXTRA_CA_CERTS: path.join(root, 'cert.pem'),
      AI_HARNESS_OAUTH_OPENAI_DEVICE_URL: `${endpoint}/device`,
      AI_HARNESS_OAUTH_OPENAI_TOKEN_URL: `${endpoint}/token`, AI_HARNESS_OAUTH_OPENAI_CLIENT_ID: 'fixture-client',
      AI_HARNESS_OPENAI_API_KEY_COMMAND: `touch '${path.join(cwd, 'command-ran')}'`, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(input);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const done = new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Auth child hung: ${stderr}`)); }, 12_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
  return { child, done };
}
async function invoke(args: string[], env?: NodeJS.ProcessEnv, input = '') { return launch(args, env, input).done; }
async function waitForRequest(route: string, childDone: ReturnType<typeof launch>['done']) {
  const deadline = Date.now() + 5000;
  while (!requests.includes(route) && Date.now() < deadline) {
    const closed = await Promise.race([
      childDone.then(({ code, signal }) => ({ code, signal })),
      new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 10)),
    ]);
    if (closed && !requests.includes(route)) {
      throw new Error(`Auth child exited before issuer request was observed (code=${closed.code}, signal=${closed.signal}).`);
    }
  }
  expect(requests).toContain(route);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'aih-top-auth-'));
  cwd = path.join(root, 'workspace'); agent = path.join(root, 'agent');
  await mkdir(cwd); await mkdir(agent);
  requests = []; mode = 'success'; activeResponses = 0; deviceUserCode = 'VISIBLE-123';
  copilotPickerModel = 'gpt-4o'; copilotResponseEvents = []; holdCopilotCatalogue = false; releaseCopilotCatalogue = undefined;
  const caseTransportErrors: typeof transportErrors = [];
  transportErrors = caseTransportErrors;
  const caseIssuerForms: typeof issuerForms = [];
  issuerForms = caseIssuerForms;
  server = createServer(await createLocalTLSFixture(root), (req, res) => {
    requests.push(req.url!);
    activeResponses++;
    res.once('close', () => { activeResponses--; });
    if (req.url?.startsWith('/api/oauth/') || req.url === '/coding/v1/messages'
      || ['/login/device/code', '/login/oauth/access_token', '/copilot_internal/v2/token', '/models', '/responses'].includes(req.url!)) {
      let body = '';
      req.on('data', chunk => { body += String(chunk); if (Buffer.byteLength(body) > (req.url === '/responses' ? 2_000_000 : 8192)) req.destroy(); });
      req.on('error', (error: NodeJS.ErrnoException) => { caseTransportErrors.push({ name: error.name, code: error.code }); });
      req.once('end', () => {
        caseIssuerForms.push({ url: req.url!, method: req.method, contentType: req.headers['content-type'],
          authorization: req.headers.authorization, apiKey: req.headers['x-api-key'] as string | undefined,
          originalUrl: req.headers['x-fixture-original-url'] as string | undefined, body });
        if (req.url === '/responses') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(copilotResponseEvents.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
          return;
        }
        const grant = new URLSearchParams(body).get('grant_type');
        res.setHeader('Content-Type', 'application/json');
        const copilotBody = req.url === '/login/device/code' ? { device_code: 'copilot-private-device', user_code: deviceUserCode,
          verification_uri: 'https://github.com/login/device', expires_in: 30, interval: 0.01 }
          : req.url === '/login/oauth/access_token' ? { access_token: refresh, token_type: 'bearer' }
          : req.url === '/copilot_internal/v2/token' ? { token, expires_at: Math.floor(Date.now() / 1000) + 3600 }
          : req.url === '/models' ? { data: [{ id: copilotPickerModel, model_picker_enabled: true }, { id: 'disabled', model_picker_enabled: true, policy: { state: 'disabled' } }] }
          : undefined;
        if (req.url === '/models' && holdCopilotCatalogue) {
          releaseCopilotCatalogue = () => res.end(JSON.stringify(copilotBody));
          return;
        }
        res.end(JSON.stringify(copilotBody ?? (req.url === '/api/oauth/device_authorization' ? {
          device_code: 'private-device-code-743', user_code: deviceUserCode,
          verification_uri: `${endpoint}/verify?private=do-not-print`, verification_uri_complete: `${endpoint}/verify?device=private-device-code-743`,
          expires_in: 30, interval: 0.01,
        } : req.url === '/coding/v1/messages' ? {
          id: 'issuer-message', type: 'message', role: 'assistant', model: 'kimi-for-coding',
          content: [{ type: 'text', text: 'Ready after refresh.' }], stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        } : { access_token: grant === 'refresh_token' ? 'rotated-kimi-access' : token,
          refresh_token: grant === 'refresh_token' ? 'rotated-kimi-refresh' : refresh, expires_in: 3600, token_type: 'Bearer' })));
      });
      return;
    }
    req.resume();
    if (req.url === '/token' && mode === 'publication-failure') mkdirSync(path.join(agent, 'credentials.enc'));
    if ((req.url === '/device' && mode === 'device-stall') || (req.url === '/token' && mode === 'token-stall')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/device' ? {
      device_code: 'private-device-code-743', user_code: deviceUserCode,
      verification_uri: `${endpoint}/verify?private=do-not-print`, verification_uri_complete: `${endpoint}/verify?device=private-device-code-743`,
      expires_in: 30, interval: 0.01,
    } : mode === 'pending' ? { error: 'authorization_pending' } : { access_token: token, refresh_token: refresh, expires_in: 3600, token_type: 'Bearer' }));
  });
  server.on('connection', socket => { if (mode === 'transport-reset') socket.destroy(); });
  server.on('tlsClientError', (error: NodeJS.ErrnoException) => {
    caseTransportErrors.push({ name: error.name, code: error.code });
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  endpoint = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
  await rm(root, { recursive: true, force: true });
});

describe('actual top-level provider auth CLI', () => {
  it('discovers help and rejects unknown/boolean/conflicting options before startup', async () => {
    const help = await invoke(['auth', '--help']);
    expect(help).toMatchObject({ code: 0, signal: null, stderr: '' });
    expect(help.stdout).toContain('Usage: ai-harness auth');
    expect((await invoke(['--help'])).stdout).toContain('auth --help');
    for (const args of [['list', '--json=false'], ['list', '--help=false'], ['login', 'openai', '--timeout=0'],
      ['login', 'openai', '--timeout=1', '--timeout=2'], ['login', 'team-code', '--issuer=unknown'],
      ['login', 'team-code', '--issuer'], ['login', 'team-code', '--issuer=kimi-coding', '--issuer=kimi-coding'],
      ['login', 'team-code', '--method=browser'], ['login', 'team-code', '--issuer=github-copilot', '--method=browser'],
      ['login', 'team-code', '--issuer=openai-codex', '--method=other'], ['login', 'team-code', '--issuer=openai-codex', '--method=browser', '--method=device'],
      ['list', '--issuer=kimi-coding'], ['logout', 'openai', '--json'], ['list', '--extension', 'evil.mjs'], ['help', '--bad']]) {
      const result = await invoke(['auth', ...args]);
      expect(result).toMatchObject({ code: 2, signal: null, stdout: '' });
      expect(result.stderr).toBe('Auth usage error. Run "ai-harness auth --help".\n');
    }
    expect(requests).toEqual([]);
    expect(await readdir(agent)).toEqual([]);
    expect(await readdir(cwd)).toEqual([]);
  }, 30_000);

  it.each([false, true])('publishes a Copilot CLI login only without intervening logout (withdraw=%s)', async withdraw => {
    const preload = path.join(root, 'copilot-routing.mjs');
    // Capture fixed vendor targets while delegating real HTTPS to this disposable issuer.
    // This is a transport fixture, not a real GitHub account or vendor TLS qualification.
    await writeFile(preload, `const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const target = new URL(String(input));
  if (!['github.com', 'api.github.com', 'api.individual.githubcopilot.com'].includes(target.hostname)) throw new Error('Unexpected fixture target');
  const headers = new Headers(init?.headers); headers.set('x-fixture-original-url', target.href);
  return originalFetch(new URL(target.pathname + target.search, ${JSON.stringify(endpoint)}), { ...init, headers });
};\n`);
    holdCopilotCatalogue = withdraw;
    const pending = launch(['auth', 'login', 'copilot-team', '--issuer=github-copilot'], {
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${preload}`,
    });
    if (withdraw) {
      await waitForRequest('/models', pending.done);
      try { expect((await invoke(['auth', 'logout', 'copilot-team'])).code).toBe(0); }
      finally { releaseCopilotCatalogue?.(); }
    }
    const result = await pending.done;
    expect(result).toEqual({ code: withdraw ? 1 : 0, signal: null, stdout: withdraw ? '' : 'Provider credentials encrypted and saved.\n',
      stderr: `Authorize at https://github.com/login/device\nUser code: ${deviceUserCode}\n${withdraw ? 'Auth operation failed.\n' : ''}` });
    expect(requests).toEqual(['/login/device/code', '/login/oauth/access_token', '/copilot_internal/v2/token', '/models']);
    expect(issuerForms.map(item => item.originalUrl)).toEqual(['https://github.com/login/device/code', 'https://github.com/login/oauth/access_token',
      'https://api.github.com/copilot_internal/v2/token', 'https://api.individual.githubcopilot.com/models']);
    expect(issuerForms.map(item => item.method)).toEqual(['POST', 'POST', 'GET', 'GET']);
    expect(issuerForms.map(item => item.authorization)).toEqual([undefined, undefined, `Bearer ${refresh}`, `Bearer ${token}`]);
    expect(issuerForms.slice(0, 2).map(item => Object.fromEntries(new URLSearchParams(item.body)))).toEqual([
      { client_id: 'Iv1.b507a08c87ecfe98', scope: 'read:user' },
      { client_id: 'Iv1.b507a08c87ecfe98', device_code: 'copilot-private-device', grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
    ]);
    const file = path.join(agent, 'credentials.enc'), service = new ProviderCredentialService({ store: new EncryptedCredentialStore(file, master) });
    await service.load();
    const saved = await service.resolve('copilot-team', { env: {}, subscriptionProvider: 'github-copilot' });
    if (withdraw) {
      expect(saved).toBeUndefined(); expect(service.list()).toEqual([]);
      for (const secret of [token, refresh, 'copilot-private-device']) expect(await readFile(file, 'utf8') + result.stdout + result.stderr).not.toContain(secret);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      return;
    }
    expect(saved?.credential).toMatchObject({ version: 1, type: 'oauth', accessToken: token, refreshToken: refresh,
      subscription: { provider: 'github-copilot', availableModelIds: ['gpt-4o'] } });
    expect(await service.resolve('copilot-team', { env: {} })).toBeUndefined();
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const bytes = await readFile(file, 'utf8');
    for (const secret of [token, refresh, 'copilot-private-device']) expect(bytes + result.stdout + result.stderr).not.toContain(secret);
    const listed = await invoke(['auth', 'list', '--json']);
    expect(JSON.parse(listed.stdout).find((item: { provider: string }) => item.provider === 'copilot-team').stored).toEqual(saved!.descriptor);
    expect((await invoke(['auth', 'logout', 'copilot-team'])).code).toBe(0);
    await service.load();
    expect(await service.resolve('copilot-team', { env: {}, subscriptionProvider: 'github-copilot' })).toBeUndefined();
    expect(requests).toHaveLength(4);
    expect(await readdir(cwd)).toEqual([]);
  });

  it.each(['print', 'json', 'rpc'])('uses an encrypted Copilot login for an actual %s inference turn and refuses it after logout', async mode => {
    copilotPickerModel = 'gpt-5-mini';
    const fixture = JSON.parse(await readFile(new URL('../../../../tests/fixtures/github-copilot-routing-reference.json', import.meta.url), 'utf8')) as {
      rows: Array<{ model: string; case: string; responseEvents: unknown[] }>;
    };
    copilotResponseEvents = fixture.rows.find(row => row.model === copilotPickerModel && row.case === 'user')!.responseEvents;
    const preload = path.join(root, 'copilot-inference-routing.mjs');
    await writeFile(preload, `const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const target = new URL(String(input));
  if (!['github.com', 'api.github.com', 'api.individual.githubcopilot.com'].includes(target.hostname)) throw new Error('Unexpected fixture target');
  const headers = new Headers(init?.headers); headers.set('x-fixture-original-url', target.href);
  return originalFetch(new URL(target.pathname + target.search, ${JSON.stringify(endpoint)}), { ...init, headers });
};\n`);
    const env = { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${preload}`, AI_HARNESS_OPENAI_API_KEY_COMMAND: '' };
    const login = await invoke(['auth', 'login', 'github-copilot', '--issuer=github-copilot'], env);
    expect(login, login.stderr).toMatchObject({ code: 0, signal: null });
    const sessions = path.join(root, 'sessions');
    const args = ['--approve', ...(mode === 'print' ? ['--print'] : ['--mode', mode]), '--session-dir', sessions, '--provider', 'github-copilot', '--model', copilotPickerModel, '--thinking', 'off', ...(mode === 'rpc' ? [] : ['probe'])];
    const input = mode === 'rpc' ? JSON.stringify({ type: 'prompt', id: 'copilot-prompt', message: 'probe' }) + '\n' : '';
    const turn = await invoke(args, env, input);
    expect(turn, turn.stderr).toMatchObject({ code: 0, signal: null });
    if (mode === 'print') expect(turn.stdout).toBe('ok\n');
    else {
      const records = turn.stdout.trim().split('\n').map(line => JSON.parse(line));
      expect(records.find(record => record.type === 'message_end' && record.message?.role === 'assistant')?.message)
        .toMatchObject({ provider: 'github-copilot', api: 'openai-responses', model: copilotPickerModel });
    }
    expect(requests).toEqual(['/login/device/code', '/login/oauth/access_token', '/copilot_internal/v2/token', '/models', '/responses']);
    const request = issuerForms.at(-1)!;
    expect(request).toMatchObject({ method: 'POST', originalUrl: 'https://api.individual.githubcopilot.com/responses', authorization: `Bearer ${token}` });
    expect(request.apiKey).toBeUndefined();
    expect(JSON.parse(request.body)).toMatchObject({ model: copilotPickerModel, stream: true, store: false });
    const journal = (await Promise.all((await readdir(sessions)).filter(file => file.endsWith('.jsonl')).map(file => readFile(path.join(sessions, file), 'utf8')))).join('\n');
    const entries = journal.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(entries).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant',
      provider: 'github-copilot', api: 'openai-responses', model: copilotPickerModel }));
    expect((await stat(path.join(agent, 'credentials.enc'))).mode & 0o777).toBe(0o600);
    for (const secret of [token, refresh]) expect(login.stdout + login.stderr + turn.stdout + turn.stderr + journal).not.toContain(secret);
    if (mode === 'rpc') {
      const service = new ProviderCredentialService({ store: new EncryptedCredentialStore(path.join(agent, 'credentials.enc'), master) });
      await service.load();
      await service.setOAuth('github-copilot', { accessToken: token, refreshToken: refresh, expiresAt: 1,
        subscription: { provider: 'github-copilot', availableModelIds: [copilotPickerModel] } });
      holdCopilotCatalogue = true;
      const starting = launch(args, env, input);
      const deadline = Date.now() + 5000;
      while (requests.filter(route => route === '/models').length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      expect(requests.filter(route => route === '/models')).toHaveLength(2);
      starting.child.kill('SIGTERM');
      const stopped = await starting.done;
      expect(stopped, stopped.stderr).toMatchObject({ code: 143, signal: null });
      releaseCopilotCatalogue?.(); holdCopilotCatalogue = false;
      await service.load();
      expect(service.list().find(item => item.provider === 'github-copilot')?.expiresAt).toBe(1);
      expect(requests.slice(-2)).toEqual(['/copilot_internal/v2/token', '/models']);
    }
    expect((await invoke(['auth', 'logout', 'github-copilot'])).code).toBe(0);
    const withdrawn = await invoke(args, env, input);
    expect(withdrawn.signal).toBeNull(); expect(withdrawn.code).not.toBe(0);
    expect(requests).toHaveLength(mode === 'rpc' ? 7 : 5);
  }, 30000);

  it('lists metadata without credential commands, refresh or agents', async () => {
    const result = await invoke(['auth', 'list', '--json']);
    expect(result).toMatchObject({ code: 0, signal: null, stderr: '' });
    const output = JSON.parse(result.stdout);
    expect(output.find((item: { provider: string }) => item.provider === 'openai')).toEqual({ provider: 'openai', deviceFlowConfigured: true, stored: null });
    expect(requests).toEqual([]); expect(await readdir(cwd)).toEqual([]);
  });

  it.each(['\u202e', '\u2066'])('refuses terminal-formatting user codes before instructions or polling (%j)', async control => {
    deviceUserCode = `VISIBLE${control}SPOOFED`;
    const result = await invoke(['auth', 'login', 'openai']);
    expect(result).toEqual({ code: 1, signal: null, stdout: '', stderr: 'Auth operation failed.\n' });
    expect(result.stderr).not.toContain(control);
    expect(requests).toEqual(['/device']);
    await expect(readFile(path.join(agent, 'credentials.enc'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(cwd)).toEqual([]);
  });

  it('refuses login and logout without durable encryption before contacting the issuer', async () => {
    for (const action of ['login', 'logout']) {
      const result = await invoke(['auth', action, 'openai'], { AI_HARNESS_MASTER_KEY: '' });
      expect(result).toMatchObject({ code: 1, signal: null, stdout: '' });
      expect(result.stderr).toContain('encrypted persistent storage is required');
    }
    expect(requests).toEqual([]); expect(await readdir(agent)).toEqual([]);
  });

  it('performs a real HTTPS flow, persists encrypted before success and deletes durably', async () => {
    const result = await invoke(['auth', 'login', 'openai']);
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stdout: 'Provider credentials encrypted and saved.\n' });
    expect(requests).toEqual(['/device', '/token']);
    expect(result.stderr).toContain('User code: VISIBLE-123');
    for (const secret of [token, refresh, master, 'private-device-code-743', 'do-not-print']) expect(result.stdout + result.stderr).not.toContain(secret);
    const file = path.join(agent, 'credentials.enc');
    const bytes = await readFile(file, 'utf8');
    for (const secret of [token, refresh]) expect(bytes).not.toContain(secret);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const service = new ProviderCredentialService({ store: new EncryptedCredentialStore(file, master) }); await service.load();
    expect((await service.resolve('openai', { env: {} }))?.credential).toMatchObject({ type: 'oauth', accessToken: token, refreshToken: refresh });
    const list = await invoke(['auth', 'list', '--json']); expect(list.stdout).not.toContain(token);
    expect(JSON.parse(list.stdout).find((item: { provider: string }) => item.provider === 'openai').stored.source).toBe('encrypted-store');
    expect(await invoke(['auth', 'logout', 'openai'])).toMatchObject({ code: 0, signal: null, stderr: '' });
    const reopened = new ProviderCredentialService({ store: new EncryptedCredentialStore(file, master) }); await reopened.load();
    expect(reopened.list()).toEqual([]); expect(await readdir(cwd)).toEqual([]);
  });

  it('does not infer an issuer from the CLI credential label', async () => {
    const result = await invoke(['auth', 'login', 'kimi-coding'], {
      AI_HARNESS_OAUTH_KIMI_CODING_DEVICE_URL: `${endpoint}/device`,
      AI_HARNESS_OAUTH_KIMI_CODING_TOKEN_URL: `${endpoint}/token`, AI_HARNESS_OAUTH_KIMI_CODING_CLIENT_ID: 'fixture-client',
      KIMI_CODE_OAUTH_HOST: 'https://must-not-contact.invalid',
    });
    expect(result).toMatchObject({ code: 0, signal: null, stdout: 'Provider credentials encrypted and saved.\n' });
    expect(requests).toEqual(['/device', '/token']);
    expect(await readdir(cwd)).toEqual([]);
  });

  it('accepts equal-form Kimi issuer selection and the fallback host without using operator endpoints', async () => {
    const result = await invoke(['auth', 'login', 'team-code', '--issuer=kimi-coding'], {
      KIMI_CODE_OAUTH_HOST: '', KIMI_OAUTH_HOST: endpoint,
      AI_HARNESS_OAUTH_TEAM_CODE_DEVICE_URL: 'https://must-not-contact.invalid/device',
      AI_HARNESS_OAUTH_TEAM_CODE_TOKEN_URL: 'https://must-not-contact.invalid/token',
      AI_HARNESS_OAUTH_TEAM_CODE_CLIENT_ID: 'operator-client',
    });
    expect(result).toMatchObject({ code: 0, signal: null, stdout: 'Provider credentials encrypted and saved.\n' });
    expect(requests).toEqual(['/api/oauth/device_authorization', '/api/oauth/token']);
    expect(transportErrors).toEqual([]);
    expect(await readdir(cwd)).toEqual([]);
  });

  it('selects the Kimi issuer separately from an operator label and refreshes encrypted credentials before real Bearer dispatch', async () => {
    const result = await invoke(['auth', 'login', 'team-code', '--issuer', 'kimi-coding'], {
      KIMI_CODE_OAUTH_HOST: endpoint, KIMI_OAUTH_HOST: 'https://must-not-contact.invalid',
    });
    expect(result).toMatchObject({ code: 0, signal: null, stdout: 'Provider credentials encrypted and saved.\n' });
    expect(result.stderr).toContain('User code: VISIBLE-123');
    const file = path.join(agent, 'credentials.enc');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const beforeRefresh = await readFile(file, 'utf8');
    for (const value of [token, refresh]) expect(beforeRefresh).not.toContain(value);
    const core = new URL('../../../core/dist/index.js', import.meta.url).href;
    const code = `import { EncryptedCredentialStore, ProviderCredentialService, getKimiCodingOAuthConfig, KimiCodingProvider } from ${JSON.stringify(core)};
const service = new ProviderCredentialService({ store: new EncryptedCredentialStore(process.env.ISSUER_STORE, process.env.ISSUER_MASTER) });
await service.load();
const initial = await service.resolve('team-code', { env: {}, now: 0, allowRefresh: false });
if (initial?.credential.type !== 'oauth' || !Number.isSafeInteger(initial.credential.expiresAt)) throw new Error('Kimi stored expiry fixture refused.');
const resolved = await service.resolve('team-code', { env: {}, now: initial.credential.expiresAt + 1, oauth: getKimiCodingOAuthConfig(process.env.ISSUER_HOST) });
if (resolved?.credential.type !== 'oauth' || resolved.credential.accessToken !== 'rotated-kimi-access' || resolved.credential.refreshToken !== 'rotated-kimi-refresh') throw new Error('Kimi refresh fixture refused.');
const provider = new KimiCodingProvider({ type: 'operator', apiKey: resolved.credential.accessToken, kimiAuthMode: 'oauth', model: 'kimi-for-coding', baseUrl: process.env.ISSUER_HOST + '/coding' });
const reply = await provider.chat([{ id: 'issuer-user', role: 'user', content: 'Fixture only.', timestamp: new Date() }]);
if (reply.content !== 'Ready after refresh.') throw new Error('Kimi dispatch fixture refused.');
process.stdout.write('Kimi issuer SDK fixture passed.\\n');`;
    const sdk = await execute(process.execPath, ['--input-type=module', '-e', code], { cwd,
      env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(root, 'cert.pem'), ISSUER_STORE: file, ISSUER_MASTER: master, ISSUER_HOST: endpoint },
      timeout: 12_000, maxBuffer: 1024 * 1024 });
    expect(sdk).toEqual({ stdout: 'Kimi issuer SDK fixture passed.\n', stderr: '' });
    expect(requests).toEqual(['/api/oauth/device_authorization', '/api/oauth/token', '/api/oauth/token', '/coding/v1/messages']);
    expect(issuerForms.slice(0, 3).map(item => Object.fromEntries(new URLSearchParams(item.body)))).toEqual([
      { client_id: '17e5f671-d194-4dfb-9706-5516cb48c098' },
      { client_id: '17e5f671-d194-4dfb-9706-5516cb48c098', device_code: 'private-device-code-743', grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
      { client_id: '17e5f671-d194-4dfb-9706-5516cb48c098', refresh_token: refresh, grant_type: 'refresh_token' },
    ]);
    expect(issuerForms.slice(0, 3).every(item => item.method === 'POST' && item.contentType === 'application/x-www-form-urlencoded' && item.authorization === undefined)).toBe(true);
    expect(issuerForms[3]).toMatchObject({ method: 'POST', authorization: 'Bearer rotated-kimi-access', apiKey: undefined });
    const afterRefresh = await readFile(file, 'utf8');
    expect(afterRefresh).not.toBe(beforeRefresh);
    for (const value of [token, refresh, 'rotated-kimi-access', 'rotated-kimi-refresh']) expect(afterRefresh + result.stdout + result.stderr + sdk.stdout + sdk.stderr).not.toContain(value);
    const reopened = new ProviderCredentialService({ store: new EncryptedCredentialStore(file, master) }); await reopened.load();
    expect((await reopened.resolve('team-code', { env: {}, now: 0, allowRefresh: false }))?.credential).toMatchObject({ type: 'oauth', accessToken: 'rotated-kimi-access', refreshToken: 'rotated-kimi-refresh' });
    expect(reopened.list().map(item => item.provider)).toEqual(['team-code']);
    expect(await invoke(['auth', 'logout', 'team-code'])).toMatchObject({ code: 0, signal: null, stderr: '' });
    await reopened.load(); expect(reopened.list()).toEqual([]);
    expect(await readdir(cwd)).toEqual([]);
    expect(transportErrors).toEqual([]);
  }, 30_000);

  it.each(['exit', 'signal'] as const)('reports early auth child %s before an issuer request', async outcome => {
    const run = launch(['auth', 'login', 'openai', '--unknown-option']);
    if (outcome === 'signal') run.child.kill('SIGTERM');
    await expect(waitForRequest('/device', run.done)).rejects.toThrow(outcome === 'signal'
      ? 'Auth child exited before issuer request was observed (code=null, signal=SIGTERM).'
      : 'Auth child exited before issuer request was observed (code=2, signal=null).');
    expect(requests).toEqual([]);
  });

  it.each(['device-stall', 'token-stall', 'pending'] as const)('cancels the real %s transport/poll and exits with no token publication', async selected => {
    mode = selected;
    const run = launch(['auth', 'login', 'openai']);
    await waitForRequest(selected === 'device-stall' ? '/device' : '/token', run.done);
    const start = Date.now(); run.child.kill('SIGINT');
    expect(await run.done).toMatchObject({ code: 130, signal: null, stdout: '' });
    expect(Date.now() - start).toBeLessThan(3000);
    expect(activeResponses).toBe(0);
    await expect(readFile(path.join(agent, 'credentials.enc'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(agent)).filter(name => /lock|tmp|staging/.test(name))).toEqual([]);
  });

  it.each(['device-stall', 'token-stall'] as const)('bounds the real %s body with a deadline and cleans up', async selected => {
    mode = selected;
    const start = Date.now();
    const result = await invoke(['auth', 'login', 'openai', '--timeout=1']);
    expect(result, JSON.stringify({ requests, transportErrors })).toMatchObject({
      code: 124, signal: null, stdout: '', stderr: expect.stringContaining('Auth deadline exceeded.'),
    });
    expect(Date.now() - start).toBeLessThan(4000);
    expect(activeResponses).toBe(0);
    await expect(readFile(path.join(agent, 'credentials.enc'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a pre-HTTP transport reset as an operation failure, not a deadline or successful login', async () => {
    mode = 'transport-reset';
    const start = performance.now();
    const result = await invoke(['auth', 'login', 'openai', '--timeout=10']);
    expect(result).toEqual({ code: 1, signal: null, stdout: '', stderr: 'Auth operation failed.\n' });
    expect(performance.now() - start).toBeLessThan(4000);
    expect(requests).toEqual([]); expect(activeResponses).toBe(0);
    await expect(readFile(path.join(agent, 'credentials.enc'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(agent)).toEqual([]); expect(await readdir(cwd)).toEqual([]);
  });

  it('refuses encrypted publication failure after a real token exchange without success or residue', async () => {
    mode = 'publication-failure';
    expect(await invoke(['auth', 'login', 'openai'])).toMatchObject({ code: 1, signal: null, stdout: '', stderr: expect.stringContaining('Auth operation failed.') });
    expect(requests).toEqual(['/device', '/token']);
    expect((await stat(path.join(agent, 'credentials.enc'))).isDirectory()).toBe(true);
    expect((await readdir(agent)).filter(name => /lock|tmp|staging/.test(name))).toEqual([]);
  });

  it('does not report success on an unsafe encrypted publication', async () => {
    await mkdir(path.join(agent, 'credentials.enc'));
    const result = await invoke(['auth', 'login', 'openai']);
    expect(result).toMatchObject({ code: 1, signal: null, stdout: '', stderr: 'Auth operation failed.\n' });
    expect(requests).toEqual([]);
    expect(await readdir(cwd)).toEqual([]);
  });
});

it('refuses issuer user codes that cannot survive UTF-8 output', async () => {
  deviceUserCode = 'VISIBLE\ud800BROKEN';
  const result = await invoke(['auth', 'login', 'openai']);
  expect(result).toEqual({ code: 1, signal: null, stdout: '', stderr: 'Auth operation failed.\n' });
  expect(requests).toEqual(['/device']);
  await expect(readFile(path.join(agent, 'credentials.enc'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readdir(cwd)).toEqual([]);
});

it('refuses authorization when redaction changes the issuer user code', async () => {
  const result = await invoke(['auth', 'login', 'openai'], { OPENAI_API_KEY: deviceUserCode });
  expect(result).toEqual({ code: 1, signal: null, stdout: '', stderr: 'Auth operation failed.\n' });
  expect(requests).toEqual(['/device']);
  await expect(readFile(path.join(agent, 'credentials.enc'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readdir(cwd)).toEqual([]);
});

it('keeps the actual authorization deadline bounded after wall-clock rollback', async () => {
  mode = 'pending';
  const preload = path.join(root, 'rollback-clock.mjs');
  const marker = path.join(root, 'clock-shifted');
  // Delegate the genuine HTTPS request and body unchanged. Only the child clock
  // jumps after device headers, between initial deadline and polling admission.
  await writeFile(preload, `import { writeFileSync } from 'node:fs';
const now = Date.now.bind(Date), fetch = globalThis.fetch;
globalThis.fetch = async function (...args) {
  const response = await Reflect.apply(fetch, this, args);
  if (new URL(response.url).pathname === '/device') {
    Date.now = () => now() - 3600000;
    writeFileSync(${JSON.stringify(marker)}, 'shifted');
  }
  return response;
};\n`);
  const started = performance.now();
  const run = launch(['auth', 'login', 'openai', '--timeout=1'], {
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${preload}`,
  });
  // This bounded escape is a negative control, not a substitute deadline: old
  // code exits 130 here; the product must itself expire with 124 before it fires.
  const escape = setTimeout(() => { run.child.kill('SIGINT'); }, 2500);
  try {
    const result = await run.done;
    expect(await readFile(marker, 'utf8')).toBe('shifted');
    expect(result).toMatchObject({ code: 124, signal: null, stdout: '',
      stderr: expect.stringContaining('Auth deadline exceeded.') });
    expect(performance.now() - started).toBeLessThan(4000);
    expect(requests).toContain('/device');
    expect(requests).toContain('/token');
    expect(activeResponses).toBe(0);
    await expect(readFile(path.join(agent, 'credentials.enc'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(cwd)).toEqual([]);
  } finally { clearTimeout(escape); }
}, 10_000);
