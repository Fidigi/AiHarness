import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
let issuerForms: { url: string; method?: string; contentType?: string; authorization?: string; apiKey?: string; body: string }[];
let transportErrors: { name: string; code?: string }[];
let endpoint: string;
let mode: 'success' | 'device-stall' | 'token-stall' | 'pending' | 'publication-failure';
let activeResponses = 0;
let deviceUserCode = 'VISIBLE-123';
const token = 'disposable-fixture-access-741';
const refresh = 'disposable-fixture-refresh-742';
const master = 'disposable-fixture-master-key-at-least-32-bytes';

function launch(args: string[], env: NodeJS.ProcessEnv = {}) {
  const bin = process.env.AIH_TOP_LEVEL_CLI_BIN;
  const child = spawn(bin ?? process.execPath, bin ? args : [entry, ...args], {
    cwd, env: { ...process.env, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent,
      AI_HARNESS_MASTER_KEY: master, NO_COLOR: '1', NODE_EXTRA_CA_CERTS: path.join(root, 'cert.pem'),
      AI_HARNESS_OAUTH_OPENAI_DEVICE_URL: `${endpoint}/device`,
      AI_HARNESS_OAUTH_OPENAI_TOKEN_URL: `${endpoint}/token`, AI_HARNESS_OAUTH_OPENAI_CLIENT_ID: 'fixture-client',
      AI_HARNESS_OPENAI_API_KEY_COMMAND: `touch '${path.join(cwd, 'command-ran')}'`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
async function invoke(args: string[], env?: NodeJS.ProcessEnv) { return launch(args, env).done; }
async function waitForRequest(route: string) {
  const deadline = Date.now() + 5000;
  while (!requests.includes(route) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  expect(requests).toContain(route);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'aih-top-auth-'));
  cwd = path.join(root, 'workspace'); agent = path.join(root, 'agent');
  await mkdir(cwd); await mkdir(agent);
  requests = []; mode = 'success'; activeResponses = 0; deviceUserCode = 'VISIBLE-123';
  const caseTransportErrors: typeof transportErrors = [];
  transportErrors = caseTransportErrors;
  const caseIssuerForms: typeof issuerForms = [];
  issuerForms = caseIssuerForms;
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(root, 'key.pem'),
    '-out', path.join(root, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']);
  server = createServer({ key: await readFile(path.join(root, 'key.pem')), cert: await readFile(path.join(root, 'cert.pem')) }, (req, res) => {
    requests.push(req.url!);
    activeResponses++;
    res.once('close', () => { activeResponses--; });
    if (req.url?.startsWith('/api/oauth/') || req.url === '/coding/v1/messages') {
      let body = '';
      req.on('data', chunk => { body += String(chunk); if (Buffer.byteLength(body) > 8192) req.destroy(); });
      req.on('error', (error: NodeJS.ErrnoException) => { caseTransportErrors.push({ name: error.name, code: error.code }); });
      req.once('end', () => {
        caseIssuerForms.push({ url: req.url!, method: req.method, contentType: req.headers['content-type'],
          authorization: req.headers.authorization, apiKey: req.headers['x-api-key'] as string | undefined, body });
        const grant = new URLSearchParams(body).get('grant_type');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(req.url === '/api/oauth/device_authorization' ? {
          device_code: 'private-device-code-743', user_code: deviceUserCode,
          verification_uri: `${endpoint}/verify?private=do-not-print`, verification_uri_complete: `${endpoint}/verify?device=private-device-code-743`,
          expires_in: 30, interval: 0.01,
        } : req.url === '/coding/v1/messages' ? {
          id: 'issuer-message', type: 'message', role: 'assistant', model: 'kimi-for-coding',
          content: [{ type: 'text', text: 'Ready after refresh.' }], stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        } : { access_token: grant === 'refresh_token' ? 'rotated-kimi-access' : token,
          refresh_token: grant === 'refresh_token' ? 'rotated-kimi-refresh' : refresh, expires_in: 3600, token_type: 'Bearer' }));
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
      ['list', '--issuer=kimi-coding'], ['logout', 'openai', '--json'], ['list', '--extension', 'evil.mjs'], ['help', '--bad']]) {
      const result = await invoke(['auth', ...args]);
      expect(result).toMatchObject({ code: 2, signal: null, stdout: '' });
      expect(result.stderr).toBe('Auth usage error. Run "ai-harness auth --help".\n');
    }
    expect(requests).toEqual([]);
    expect(await readdir(agent)).toEqual([]);
    expect(await readdir(cwd)).toEqual([]);
  }, 30_000);

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
    expect(result).toMatchObject({ code: 0, signal: null, stdout: 'Provider credentials encrypted and saved.\n' });
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

  it.each(['device-stall', 'token-stall', 'pending'] as const)('cancels the real %s transport/poll and exits with no token publication', async selected => {
    mode = selected;
    const run = launch(['auth', 'login', 'openai']);
    await waitForRequest(selected === 'device-stall' ? '/device' : '/token');
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
