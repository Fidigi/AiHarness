import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { start, stop } from '../index.js';

it('scrubs a genuinely configured provider credential through streaming, children, journals, shares and exports', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-privacy-http-'));
  const cwd = path.join(root, 'work'), dataDir = path.join(root, 'private');
  const secret = 'disposable-selected-provider-secret-012345';
  vi.stubEnv('AI_HARNESS_MASTER_KEY', 'disposable-privacy-http-master');
  vi.stubEnv('AI_HARNESS_AUTH_TOKEN', ''); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', '');
  let calls = 0, fixtureError: unknown;
  const provider = createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
      const body = JSON.parse(text); expect(body.stream).toBe(true);
      expect(request.headers.authorization).toBe(`Bearer ${secret}`); calls++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const content of ['Public prefix ', secret.slice(0, 19), secret.slice(19), ' public suffix']) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }], model: 'privacy-model' })}\n\n`);
      }
      response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], model: 'privacy-model' })}\n\ndata: [DONE]\n\n`);
    } catch (error) { fixtureError = error; response.writeHead(500); response.end('Invalid privacy fixture'); }
  });
  await mkdir(cwd);
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  try {
    const server = await start({ port: 0, host: '127.0.0.1', dataDir, allowedRoots: [cwd], defaultCwd: cwd });
    const base = `http://127.0.0.1:${server.port}`, headers = { 'Content-Type': 'application/json' };
    const post = (route: string, body: unknown) => fetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
    expect((await post('/api/workspaces/trust', { cwd, confirm: true })).status).toBe(200);
    expect((await post('/api/config', { type: 'local', apiKey: secret, model: 'privacy-model',
      baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1` })).status).toBe(200);
    expect(await readFile(path.join(dataDir, 'credentials.enc'), 'utf8')).not.toContain(secret);
    const response = await post('/api/agent/runs', { cwd, provider: 'local', input: 'Public parent request' });
    expect(response.status).toBe(202);
    const { run } = await response.json() as { run: { id: string; sessionId: string } };
    await vi.waitFor(async () => {
      expect(await fetch(`${base}/api/agent/runs/${run.id}`).then(result => result.json())).toMatchObject({ phase: 'completed' });
    });
    const spawned = await post('/api/subagents/runs', { parentSessionId: run.sessionId, profileId: 'general',
      task: 'Public child request', provider: 'local', background: true });
    expect(spawned.status).toBe(202);
    const child = await spawned.json() as { id: string; childSessionId: string };
    await vi.waitFor(async () => {
      const result = await fetch(`${base}/api/subagents/runs/${child.id}`).then(value => value.text());
      expect(result).not.toContain(secret); expect(JSON.parse(result)).toMatchObject({ status: 'completed' });
    });
    for (const id of [run.sessionId, child.childSessionId]) {
      for (const route of [`/api/sessions/${id}`, `/api/sessions/${id}/export?format=json`, `/api/sessions/${id}/export?format=markdown`]) {
        const result = await fetch(`${base}${route}`); expect(result.status).toBe(200);
        const text = await result.text(); expect(text).not.toContain(secret); expect(text).toContain('[REDACTED]');
        expect(text).toContain('Public prefix'); expect(text).toContain('public suffix');
      }
      const file = await readFile(path.join(dataDir, 'sessions', `${id}.jsonl`), 'utf8');
      expect(file).not.toContain(secret); expect(file).toContain('[REDACTED]');
      const shared = await post(`/api/sessions/${id}/share`, {}); expect(shared.status).toBe(201);
      const { url } = await shared.json() as { url: string };
      const page = await fetch(url); expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
      const html = await page.text(); expect(html).not.toContain(secret); expect(html).toContain('[REDACTED]');
      const controller = new AbortController();
      const events = await fetch(`${base}/api/agent/sessions/${id}/events?after=0`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
      });
      const reader = events.body!.getReader(); let replay = '';
      try {
        for (;;) {
          const item = await reader.read(); replay += new TextDecoder().decode(item.value);
          expect(replay.length).toBeLessThan(1_000_000);
          if (item.done || replay.includes('event: run.completed')) break;
        }
      } finally { controller.abort(); await reader.cancel().catch(() => undefined); }
      expect(replay).not.toContain(secret); expect(replay).toContain('[REDACTED]'); expect(replay).toContain('run.completed');
    }
    expect(fixtureError).toBeUndefined(); expect(calls).toBe(2);
  } finally {
    await stop(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
  }
}, 15_000);
