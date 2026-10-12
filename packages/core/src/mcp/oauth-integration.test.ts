import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtensionRuntimeContext } from '../extensions/extension-registry.js';
import { ProjectTrustManager } from '../security/project-trust.js';
import { inspectMcpConfig, type McpServerTestTarget } from './config-inventory.js';
import { McpOAuthCredentialManager, type McpOAuthCredentialBackend } from './oauth.js';
import { McpOAuthFlowService, type McpOAuthFlowInfo } from './oauth-flow.js';
import { createMcpOAuthProviderFactory } from './oauth-provider-factory.js';
import { McpSessionHost } from './session-host.js';

class MemoryBackend implements McpOAuthCredentialBackend {
  readonly values = new Map<string, string>();
  async load() {}
  get(name: string) { return this.values.get(name); }
  async set(name: string, value: string) { this.values.set(name, value); }
  async delete(name: string) { return this.values.delete(name); }
  async compareAndSet(name: string, expected: string | undefined, value: string | undefined) {
    if (this.values.get(name) !== expected) return false;
    if (value === undefined) this.values.delete(name);
    else this.values.set(name, value);
    return true;
  }
}

const cleanups: Array<() => Promise<void>> = [];
const context = {} as ExtensionRuntimeContext;

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 64 * 1024) throw new Error('request too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function waitFor(
  flows: McpOAuthFlowService,
  id: string,
  phase: McpOAuthFlowInfo['phase'],
): Promise<McpOAuthFlowInfo> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = flows.read(id);
    if (value?.phase === phase) return value;
    if (value && ['failed', 'cancelled', 'expired'].includes(value.phase)) {
      throw new Error(`OAuth flow ended as ${value.phase}:${value.failure ?? ''}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`OAuth flow did not reach ${phase}.`);
}

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()));
});

describe('MCP OAuth end-to-end', () => {
  it('keeps runtime auth passive, completes explicit loopback login, and refreshes stored tokens', async () => {
    let baseUrl = '';
    let acceptedAccess = 'access-1';
    let registrationCalls = 0;
    let refreshCalls = 0;
    let stalledRefreshCalls = 0;
    const registeredRedirects = new Map<string, string>();
    let authorizationChallenge: string | undefined;
    let authorizationClient: string | undefined;
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', baseUrl || 'http://127.0.0.1');
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
        json(response, 200, {
          resource: `${baseUrl}/mcp`,
          authorization_servers: [baseUrl],
          scopes_supported: ['tools.read'],
        });
        return;
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        json(response, 200, {
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/token`,
          registration_endpoint: `${baseUrl}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
          code_challenge_methods_supported: ['S256'],
        });
        return;
      }
      if (url.pathname === '/register' && request.method === 'POST') {
        registrationCalls++;
        const registration = JSON.parse(await body(request)) as { redirect_uris: string[] };
        const clientId = `client-${registrationCalls}`;
        registeredRedirects.set(clientId, registration.redirect_uris[0]!);
        json(response, 201, {
          ...registration,
          client_id: clientId,
          client_secret: `secret-${registrationCalls}`,
          token_endpoint_auth_method: 'client_secret_post',
        });
        return;
      }
      if (url.pathname === '/authorize') {
        const redirect = url.searchParams.get('redirect_uri');
        const state = url.searchParams.get('state');
        const clientId = url.searchParams.get('client_id');
        if (!redirect || !state || !clientId || registeredRedirects.get(clientId) !== redirect
          || !url.searchParams.get('code_challenge')
          || url.searchParams.get('code_challenge_method') !== 'S256') {
          response.writeHead(400).end();
          return;
        }
        authorizationChallenge = url.searchParams.get('code_challenge')!;
        authorizationClient = clientId;
        const target = new URL(redirect);
        target.searchParams.set('code', 'fixture-code');
        target.searchParams.set('state', state);
        response.writeHead(302, { Location: target.href, 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      if (url.pathname === '/token' && request.method === 'POST') {
        const values = new URLSearchParams(await body(request));
        if (values.get('grant_type') === 'authorization_code') {
          const verifier = values.get('code_verifier');
          if (values.get('code') !== 'fixture-code' || !verifier
            || createHash('sha256').update(verifier).digest('base64url') !== authorizationChallenge
            || values.get('client_id') !== authorizationClient
            || values.get('client_secret') !== 'secret-1'
            || values.get('redirect_uri') !== registeredRedirects.get(authorizationClient!)) {
            json(response, 400, { error: 'invalid_grant' });
            return;
          }
          acceptedAccess = 'access-1';
          json(response, 200, {
            access_token: 'access-1',
            refresh_token: 'refresh-1',
            token_type: 'Bearer',
            scope: 'tools.read',
          });
          return;
        }
        if (values.get('grant_type') === 'refresh_token' && values.get('refresh_token') === 'refresh-2') {
          stalledRefreshCalls++;
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.write('{"access_token":');
          return;
        }
        if (values.get('grant_type') === 'refresh_token' && values.get('refresh_token') === 'refresh-1') {
          refreshCalls++;
          acceptedAccess = 'access-2';
          json(response, 200, {
            access_token: 'access-2',
            refresh_token: 'refresh-2',
            token_type: 'Bearer',
            scope: 'tools.read',
          });
          return;
        }
        json(response, 400, { error: 'invalid_grant' });
        return;
      }
      if (url.pathname === '/mcp') {
        if (request.headers.authorization !== `Bearer ${acceptedAccess}`) {
          response.writeHead(401, {
            'WWW-Authenticate': `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp", scope="tools.read"`,
            'Cache-Control': 'no-store',
          });
          response.end();
          return;
        }
        if (request.method === 'GET') {
          response.writeHead(405).end();
          return;
        }
        const message = JSON.parse(await body(request)) as {
          id?: string | number;
          method?: string;
          params?: { protocolVersion?: string; name?: string; arguments?: unknown };
        };
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        if (message.method === 'initialize') {
          json(response, 200, {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'oauth-fixture', version: '1.0.0' },
            },
          });
          return;
        }
        if (message.method === 'tools/list') {
          json(response, 200, {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              tools: [{
                name: 'lookup',
                description: 'OAuth-protected lookup',
                inputSchema: { type: 'object', properties: {} },
                annotations: { readOnlyHint: true },
              }],
            },
          });
          return;
        }
        if (message.method === 'tools/call') {
          json(response, 200, {
            jsonrpc: '2.0',
            id: message.id,
            result: { content: [{ type: 'text', text: `protected:${JSON.stringify(message.params?.arguments ?? {})}` }] },
          });
          return;
        }
        json(response, 200, {
          jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' },
        });
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not listen');
    baseUrl = `http://127.0.0.1:${address.port}`;
    cleanups.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-harness-mcp-oauth-integration-'));
    const agentDir = path.join(root, 'agent');
    const project = path.join(root, 'project');
    await Promise.all([mkdir(agentDir), mkdir(project)]);
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(agentDir, 'mcp.json'), JSON.stringify({
      version: 1,
      mcpServers: { protected: { url: `${baseUrl}/mcp`, exposure: 'direct' } },
    }));
    const trust = new ProjectTrustManager(path.join(agentDir, 'trust.json'));
    await trust.load();
    await trust.trust(project);
    const credentials = new McpOAuthCredentialManager(new MemoryBackend());
    const providerFactory = createMcpOAuthProviderFactory({
      manager: credentials,
      resolveTarget: async current => current,
    });
    const host = new McpSessionHost({
      agentDir,
      trustManager: trust,
      oauthProviderFactory: providerFactory,
      startupWaitMs: 2_000,
      requestTimeoutMs: 2_000,
      closeWaitMs: 250,
    });
    cleanups.push(() => host.shutdown());

    const unauthenticated = await host.prepareForPrompt({ sessionId: 'oauth', cwd: project });
    expect(unauthenticated.tools).toEqual([]);
    expect(registrationCalls).toBe(0);
    const unauthenticatedInventory = host.decorateInventory(await inspectMcpConfig({ agentDir }));
    expect(unauthenticatedInventory.servers[0]?.runtimeStatus?.state).toBe('needs-auth');

    const target: McpServerTestTarget = {
      scope: 'global',
      name: 'protected',
      sourcePath: path.join(agentDir, 'mcp.json'),
      configKey: unauthenticatedInventory.servers[0]!.configKey,
      config: { url: `${baseUrl}/mcp`, exposure: 'direct' },
      cwd: project,
    };
    const flows = new McpOAuthFlowService(credentials, {
      requestTimeoutMs: 2_000,
      commandTimeoutMs: 1_000,
      closeWaitMs: 250,
    });
    cleanups.push(() => flows.shutdown());
    const started = flows.start({ target, validate: async () => target });
    const authorize = await waitFor(flows, started.flow.flowId, 'authorize');
    const browser = await fetch(authorize.authorizationUrl!, { redirect: 'follow' });
    expect(browser.status).toBe(200);
    await waitFor(flows, started.flow.flowId, 'connected');
    expect(registrationCalls).toBe(1);
    await expect(credentials.status({ name: 'protected', url: `${baseUrl}/mcp` }))
      .resolves.toMatchObject({ signedIn: true });

    await host.reconnect('oauth');
    const authenticated = await host.prepareForPrompt({ sessionId: 'oauth', cwd: project });
    expect(authenticated.tools.map(tool => tool.name)).toEqual(['mcp__protected__lookup']);
    await expect(authenticated.execute('mcp__protected__lookup', { topic: 'oauth' }, context))
      .resolves.toMatchObject({ content: 'protected:{"topic":"oauth"}' });

    acceptedAccess = 'access-must-refresh';
    await host.reconnect('oauth');
    const refreshed = await host.prepareForPrompt({ sessionId: 'oauth', cwd: project });
    expect(refreshed.tools.map(tool => tool.name)).toEqual(['mcp__protected__lookup']);
    expect(refreshCalls).toBe(1);
    await expect(credentials.status({ name: 'protected', url: `${baseUrl}/mcp` }))
      .resolves.toMatchObject({ signedIn: true });

    // A challenge during a tool call (not startup) must also bound OAuth body reads.
    acceptedAccess = 'access-expired-during-call';
    await expect(refreshed.execute('mcp__protected__lookup', {}, context)).rejects.toThrow();
    expect(stalledRefreshCalls).toBe(1);
    const unchanged = await credentials.createProvider({
      identity: { name: 'protected', url: `${baseUrl}/mcp` }, mode: 'passive',
    });
    expect(await unchanged.provider.tokens()).toMatchObject({ access_token: 'access-2' });
  });
});
