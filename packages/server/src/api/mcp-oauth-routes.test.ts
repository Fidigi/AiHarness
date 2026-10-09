import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  McpOAuthCredentialManager,
  McpOAuthFlowService,
  type McpOAuthCredentialBackend,
  type McpOAuthFlowDriver,
  type McpServerTestTarget,
} from '@ai-harness/core';
import type { RuntimeServices } from '../runtime/services.js';

vi.mock('../security/request-security.js', () => ({
  requireCapability: (): RequestHandler => (_request, _response, next) => next(),
}));

import { createMcpRouter } from './mcp-routes.js';

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

const flowServices: McpOAuthFlowService[] = [];
let flowSequence = 0;

function target(): McpServerTestTarget {
  return {
    scope: 'global',
    name: 'docs',
    sourcePath: '/agent/mcp.json',
    configKey: 'a'.repeat(64),
    config: { url: 'https://mcp.example.test/api' },
    cwd: '/workspace',
  };
}

function runtime(driver?: McpOAuthFlowDriver) {
  const credentials = new McpOAuthCredentialManager(new MemoryBackend());
  const flows = new McpOAuthFlowService(credentials, {
    ...(driver ? { driver } : {}),
    createId: () => `route-flow-${String(++flowSequence).padStart(20, '0')}`,
  });
  flowServices.push(flows);
  return { credentials, flows };
}

function application(
  oauthRuntime: ReturnType<typeof runtime> | undefined,
  overrides: { getOverview?: () => Promise<unknown>; disconnect?: ReturnType<typeof vi.fn> } = {},
) {
  const current = target();
  const disconnect = overrides.disconnect ?? vi.fn(async () => undefined);
  const services = {
    mcpInventory: {
      getOverview: overrides.getOverview ?? vi.fn(async () => ({ files: [], servers: [] })),
      resolveServerTarget: vi.fn(async (input: { expectedConfigKey?: string }) => {
        if (input.expectedConfigKey !== current.configKey) throw new Error('stale');
        return { target: current, validate: async () => current };
      }),
    },
    mcpHost: { disconnectServer: disconnect },
  } as unknown as RuntimeServices;
  const getOAuthRuntime = vi.fn(async () => oauthRuntime);
  const app = express();
  app.use(express.json());
  app.use('/api/mcp', createMcpRouter(Promise.resolve(services), { getOAuthRuntime }));
  return { app, getOAuthRuntime, disconnect };
}

afterEach(async () => {
  await Promise.all(flowServices.splice(0).map(service => service.shutdown()));
});

describe('MCP OAuth routes', () => {
  it('keeps the inventory GET passive', async () => {
    const oauth = runtime(async () => ({}));
    const getOverview = vi.fn(async () => ({ files: [], servers: [] }));
    const { app, getOAuthRuntime } = application(oauth, { getOverview });

    await request(app).get('/api/mcp').expect(200, { files: [], servers: [] });
    expect(getOverview).toHaveBeenCalledTimes(1);
    expect(getOAuthRuntime).not.toHaveBeenCalled();
  });

  it('polls an explicit flow, accepts a pasted redirect, exposes no tokens, and signs out', async () => {
    const driver: McpOAuthFlowDriver = async context => {
      const binding = await context.manager.createProvider({
        identity: { name: context.target.name, url: 'https://mcp.example.test/api' },
        mode: 'interactive',
        redirectUrl: context.redirectUrl,
        state: context.state,
      });
      context.publishAuthorizationUrl(new URL(
        `https://login.example.test/authorize?state=${encodeURIComponent(context.state)}`,
      ));
      const code = await context.waitForAuthorizationCode();
      expect(code).toBe('route-code');
      await binding.provider.saveTokens({
        access_token: 'route-access-secret',
        refresh_token: 'route-refresh-secret',
        token_type: 'Bearer',
      });
      context.publishVerifying();
      return {};
    };
    const oauth = runtime(driver);
    const { app, disconnect } = application(oauth);
    const descriptor = { scope: 'global', name: 'docs', configKey: 'a'.repeat(64) };

    const before = await request(app).post('/api/mcp/oauth/status').send({ servers: [descriptor] }).expect(200);
    expect(before.body.statuses).toEqual([expect.objectContaining({ signedIn: false, stateStored: false })]);

    const started = await request(app).post('/api/mcp/oauth/start').send(descriptor).expect(200);
    expect(JSON.stringify(started.body)).not.toContain('secret');
    const id = started.body.flowId as string;
    let flow: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      const polled = await request(app).get(`/api/mcp/oauth/flows/${id}`).expect(200);
      flow = polled.body as Record<string, unknown>;
      if (flow.phase === 'authorize') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(flow?.phase).toBe('authorize');
    const authorizationUrl = new URL(flow?.authorizationUrl as string);
    const state = authorizationUrl.searchParams.get('state');
    const redirectUrl = flow?.redirectUrl as string;

    const refused = await request(app).post(`/api/mcp/oauth/flows/${id}/redirect`).send({
      redirectUrl: `${redirectUrl}?code=wrong&state=wrong`,
    }).expect(400);
    expect(refused.body).toMatchObject({ code: 'state-mismatch' });
    await request(app).post(`/api/mcp/oauth/flows/${id}/redirect`).send({
      redirectUrl: `${redirectUrl}?code=route-code&state=${encodeURIComponent(state!)}`,
    }).expect(200);

    let completedText = '';
    for (let attempt = 0; attempt < 100; attempt++) {
      const polled = await request(app).get(`/api/mcp/oauth/flows/${id}`).expect(200);
      completedText = polled.text;
      if (polled.body.phase === 'connected') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(JSON.parse(completedText)).toMatchObject({ phase: 'connected' });
    expect(completedText).not.toContain('route-access-secret');
    expect(completedText).not.toContain('route-refresh-secret');

    const signedIn = await request(app).post('/api/mcp/oauth/status').send({ servers: [descriptor] }).expect(200);
    expect(signedIn.text).not.toContain('route-access-secret');
    expect(signedIn.body.statuses).toEqual([expect.objectContaining({ signedIn: true, stateStored: true })]);
    const stale = await oauth.credentials.createProvider({
      identity: { name: 'docs', url: 'https://mcp.example.test/api' },
      mode: 'passive',
    });

    const loggedOut = await request(app).post('/api/mcp/oauth/logout').send(descriptor).expect(200);
    expect(loggedOut.body).toMatchObject({ removed: true, ...descriptor });
    expect(disconnect).toHaveBeenCalledWith('global', 'docs');
    await expect(stale.provider.saveTokens({
      access_token: 'must-not-resurrect', token_type: 'Bearer',
    })).rejects.toMatchObject({ name: 'McpOAuthSignedOutError' });
    const after = await request(app).post('/api/mcp/oauth/status').send({ servers: [descriptor] }).expect(200);
    expect(after.body.statuses).toEqual([expect.objectContaining({ signedIn: false, stateStored: false })]);
  });

  it('returns a stable unavailable result when encrypted storage is disabled', async () => {
    const { app } = application(undefined);
    const descriptor = { scope: 'global', name: 'docs', configKey: 'a'.repeat(64) };
    await request(app).post('/api/mcp/oauth/status').send({ servers: [descriptor] })
      .expect(503, { error: 'Le stockage OAuth MCP est indisponible.', code: 'oauth-unavailable' });
    await request(app).post('/api/mcp/oauth/start').send(descriptor)
      .expect(503, { error: 'Le stockage OAuth MCP est indisponible.', code: 'oauth-unavailable' });
    await request(app).get('/api/mcp/oauth/flows/route-flow-00000000000000000001')
      .expect(503, { error: 'Le stockage OAuth MCP est indisponible.', code: 'oauth-unavailable' });
    await request(app).post('/api/mcp/oauth/flows/route-flow-00000000000000000001/redirect')
      .send({ redirectUrl: 'http://127.0.0.1:1234/oauth/callback?code=x&state=y' })
      .expect(503, { error: 'Le stockage OAuth MCP est indisponible.', code: 'oauth-unavailable' });
    await request(app).delete('/api/mcp/oauth/flows/route-flow-00000000000000000001')
      .expect(503, { error: 'Le stockage OAuth MCP est indisponible.', code: 'oauth-unavailable' });
    await request(app).post('/api/mcp/oauth/logout').send(descriptor)
      .expect(503, { error: 'Le stockage OAuth MCP est indisponible.', code: 'oauth-unavailable' });
  });

  it('bounds malformed flow and status requests', async () => {
    const { app } = application(runtime(async () => ({})));
    await request(app).post('/api/mcp/oauth/status').send({ servers: 'all' }).expect(400);
    await request(app).post('/api/mcp/oauth/start').send({
      scope: 'global', name: 'docs', configKey: 'not-a-key', extra: true,
    }).expect(400);
    await request(app).get('/api/mcp/oauth/flows/not-valid').expect(400);
    await request(app).post('/api/mcp/oauth/logout').send({
      scope: 'global', name: 'docs', configKey: 'not-a-key',
    }).expect(400);
  });
});
