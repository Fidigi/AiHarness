import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { start, stop } from './index.js';

const html = '<!doctype html><html><head><title>AiHarness Test</title></head><body>Web bundle</body></html>';

describe('combined Web server', () => {
  let webRoot = '';
  let baseUrl = '';

  beforeAll(async () => {
    webRoot = await mkdtemp(path.join(os.tmpdir(), 'ai-harness-web-'));
    await writeFile(path.join(webRoot, 'index.html'), html);
    const server = await start({ port: 0, host: '127.0.0.1', webRoot });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await stop();
    await rm(webRoot, { recursive: true, force: true });
  });

  it('serves the Web bundle from the root', async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('AiHarness Test');
  });

  it('uses the Web entry point as the SPA fallback', async () => {
    const response = await fetch(`${baseUrl}/settings`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Web bundle');
  });

  it('keeps API routes available on the same port', async () => {
    const response = await fetch(`${baseUrl}/api/providers`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('openai');
  });

  it('registers the fixed session tree route before the dynamic session route', async () => {
    const response = await fetch(`${baseUrl}/api/sessions/tree`);
    expect(response.status).toBe(200);
    expect(Array.isArray(await response.json())).toBe(true);
  });

  it('covers the complete session HTTP lifecycle', async () => {
    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'HTTP lifecycle' }),
    });
    expect(createResponse.status).toBe(200);
    const created = await createResponse.json() as { id: string };

    const messageResponse = await fetch(`${baseUrl}/api/sessions/${created.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user', content: '<script>unsafe</script>' }),
    });
    expect(messageResponse.status).toBe(201);

    const renameResponse = await fetch(`${baseUrl}/api/sessions/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed session' }),
    });
    expect(renameResponse.status).toBe(200);

    const getResponse = await fetch(`${baseUrl}/api/sessions/${created.id}`);
    expect(await getResponse.json()).toMatchObject({
      id: created.id,
      title: 'Renamed session',
      messages: [{ role: 'user', content: '<script>unsafe</script>' }],
    });

    const forkResponse = await fetch(`${baseUrl}/api/sessions/${created.id}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageIndex: 0, title: 'Forked' }),
    });
    expect(forkResponse.status).toBe(200);

    const cloneResponse = await fetch(`${baseUrl}/api/sessions/${created.id}/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Cloned' }),
    });
    expect(cloneResponse.status).toBe(200);

    const treeResponse = await fetch(`${baseUrl}/api/sessions/tree?branchId=${created.id}`);
    const tree = await treeResponse.json() as Array<{ id: string; depth: number; messageCount: number }>;
    expect(tree).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.id, depth: 0, messageCount: 1 }),
      expect.objectContaining({ depth: 1, messageCount: 1 }),
    ]));

    const shareResponse = await fetch(`${baseUrl}/api/sessions/${created.id}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttlHours: 2 }),
    });
    expect(shareResponse.status).toBe(201);
    const share = await shareResponse.json() as { url: string; expiresInHours: number };
    expect(share.expiresInHours).toBe(2);
    const publicPage = await fetch(share.url);
    expect(await publicPage.text()).toContain('&lt;script&gt;unsafe&lt;/script&gt;');

    const listResponse = await fetch(`${baseUrl}/api/sessions`);
    const sessions = await listResponse.json() as Array<{ id: string }>;
    expect(sessions.some(session => session.id === created.id)).toBe(true);

    const deleteResponse = await fetch(`${baseUrl}/api/sessions/${created.id}`, { method: 'DELETE' });
    expect(await deleteResponse.json()).toMatchObject({ success: true, deletedCount: 3 });
    expect((await fetch(`${baseUrl}/api/sessions/${created.id}`)).status).toBe(404);
  });

  it('enforces user and administrator API permissions', async () => {
    vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'user-token');
    vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'admin-token');

    expect((await fetch(`${baseUrl}/api/providers`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/providers`, {
      headers: { Authorization: 'Bearer user-token' },
    })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/config`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer user-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'openai', apiKey: 'not-persisted' }),
    })).status).toBe(403);
  });

  it('rejects invalid session message and rename payloads', async () => {
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).then(response => response.json()) as { id: string };

    expect((await fetch(`${baseUrl}/api/sessions/${created.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'system', content: 'invalid' }),
    })).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/sessions/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    })).status).toBe(400);

    await fetch(`${baseUrl}/api/sessions/${created.id}`, { method: 'DELETE' });
  });
});
