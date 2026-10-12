import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EncryptedCredentialStore, McpOAuthCredentialManager } from '@ai-harness/core';
import { afterEach, describe, expect, it } from 'vitest';

const cleanups: Array<() => Promise<unknown>> = [];
const entry = fileURLToPath(new URL('../index.ts', import.meta.url));
const tsx = createRequire(import.meta.url).resolve('tsx');
const masterKey = 'CLI OAuth integration master key';
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function fixture() {
  let base = '';
  let challenge = '';
  let redirect = '';
  let tokenCalls = 0;
  const json = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, base);
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
        json(response, 200, { resource: `${base}/mcp`, authorization_servers: [base] }); return;
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        json(response, 200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
          response_types_supported: ['code'], grant_types_supported: ['authorization_code'],
          token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'] }); return;
      }
      if (url.pathname === '/authorize') {
        challenge = url.searchParams.get('code_challenge')!;
        redirect = url.searchParams.get('redirect_uri')!;
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        expect(url.searchParams.get('client_id')).toBe('fixture-client');
        const target = new URL(redirect);
        target.searchParams.set('code', 'fixture-code'); target.searchParams.set('state', url.searchParams.get('state')!);
        response.writeHead(302, { Location: target.href }).end(); return;
      }
      if (url.pathname === '/token') {
        const values = new URLSearchParams(await body(request));
        if (values.get('code') !== 'fixture-code' || values.get('redirect_uri') !== redirect
          || createHash('sha256').update(values.get('code_verifier') ?? '').digest('base64url') !== challenge) {
          json(response, 400, { error: 'invalid_grant' }); return;
        }
        tokenCalls++;
        json(response, 200, { access_token: 'cli-access-private', refresh_token: 'cli-refresh-private', token_type: 'Bearer' }); return;
      }
      if (url.pathname === '/mcp') {
        if (request.headers.authorization !== 'Bearer cli-access-private') {
          response.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` }).end(); return;
        }
        if (request.method === 'GET') { response.writeHead(405).end(); return; }
        const message = JSON.parse(await body(request));
        if (message.id === undefined) { response.writeHead(202).end(); return; }
        json(response, 200, { jsonrpc: '2.0', id: message.id, result: message.method === 'initialize'
          ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
          : { tools: [] } }); return;
      }
      response.writeHead(404).end();
    } catch { response.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  base = `http://127.0.0.1:${address.port}`;
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-oauth-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, 'agent');
  const cwd = path.join(root, 'project');
  await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  await writeFile(path.join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { protected: {
    url: `${base}/mcp`, oauth: { clientId: 'fixture-client' },
  } } }));
  return { root, agentDir, cwd, base, tokenCalls: () => tokenCalls };
}

function invoke(target: Awaited<ReturnType<typeof fixture>>, args: string[], key = masterKey) {
  const child = spawn(process.execPath, ['--import', tsx, entry, 'mcp', ...args], {
    cwd: target.cwd, env: { ...process.env, AI_HARNESS_AGENT_DIR: target.agentDir, AI_HARNESS_MASTER_KEY: key, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  cleanups.push(async () => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const finished = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI OAuth test timeout')); }, 12_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  const authorization = async () => {
    for (let i = 0; i < 500; i++) {
      const match = stderr.match(/http:\/\/127\.0\.0\.1:\d+\/authorize[^\n]+/);
      if (match) return new URL(match[0]);
      if (child.exitCode !== null) throw new Error(`CLI ended before authorization: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Authorization URL not emitted');
  };
  return { child, finished, authorization };
}

describe('CLI MCP OAuth', () => {
  it('completes real issuer PKCE login into encrypted storage, then signs out locally', async () => {
    const target = await fixture();
    const login = invoke(target, ['login', 'protected', '--no-open']);
    const authorization = await login.authorization();
    expect((await fetch(authorization)).ok).toBe(true);
    const result = await login.finished;
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('Authorize:');
    expect(result.stderr).not.toMatch(/cli-access-private|cli-refresh-private/);
    expect(result.stdout).toContain('MCP protected: connected');
    expect(result.stdout).not.toContain('cli-access-private');
    expect(target.tokenCalls()).toBe(1);
    const file = await readFile(path.join(target.agentDir, 'credentials.enc'), 'utf8');
    expect(file).not.toMatch(/cli-access-private|cli-refresh-private|fixture-code/);
    const manager = new McpOAuthCredentialManager(new EncryptedCredentialStore(path.join(target.agentDir, 'credentials.enc'), masterKey));
    expect(await manager.status({ name: 'protected', url: `${target.base}/mcp` })).toMatchObject({ signedIn: true });
    const logout = await invoke(target, ['logout', 'protected']).finished;
    expect(logout).toMatchObject({ code: 0, stderr: '' });
    expect(logout.stdout).toContain('Issuer-side tokens are not revoked');
    const fresh = new McpOAuthCredentialManager(new EncryptedCredentialStore(path.join(target.agentDir, 'credentials.enc'), masterKey));
    expect(await fresh.status({ name: 'protected', url: `${target.base}/mcp` })).toMatchObject({ signedIn: false });
  }, 20_000);

  it('cleans up loopback callbacks after SIGINT and bounded expiry without accepting a late callback', async () => {
    const target = await fixture();
    for (const cancel of [true, false]) {
      const login = invoke(target, ['login', 'protected', '--no-open', '--timeout', '1']);
      const url = await login.authorization();
      const callback = new URL(url.searchParams.get('redirect_uri')!);
      login.child.stdin.end();
      if (cancel) login.child.kill('SIGINT');
      expect((await login.finished).code).toBe(cancel ? 130 : 1);
      await expect(fetch(callback)).rejects.toThrow();
    }
    expect(target.tokenCalls()).toBe(0);
  }, 20_000);

  it('fails before authorization without durable encryption and rejects invalid timeouts', async () => {
    const target = await fixture();
    const missing = await invoke(target, ['login', 'protected', '--no-open'], '').finished;
    expect(missing.code).toBe(1); expect(missing.stdout).toBe('');
    expect(missing.stderr).toContain('durable storage');
    const invalid = await invoke(target, ['login', 'protected', '--timeout', '301']).finished;
    expect(invalid.code).toBe(1); expect(invalid.stdout).toBe('');
    expect(target.tokenCalls()).toBe(0);
  });
});
