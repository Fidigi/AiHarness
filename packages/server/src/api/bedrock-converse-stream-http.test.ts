import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { getProxy, start, stop } from '../index.js';
import { bedrockText } from '../../../../tests/fixtures/bedrock-event-stream.js';

it.each(['sigv4', 'bearer'] as const)('routes built-in Bedrock %s settings through actual binary HTTP and reloads encrypted credentials and native history', async auth => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-bedrock-http-'));
  const cwd = path.join(root, 'work'), dataDir = path.join(root, 'private'), model = 'fixture:0';
  const calls: Array<{ url?: string; authorization?: string; token?: string; authHeaders: string[]; body: unknown }> = [];
  const keyFile = path.join(root, 'loopback.key'), certFile = path.join(root, 'loopback.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyFile, '-out', certFile], { stdio: 'ignore', timeout: 10_000 });
  const authorities = getCACertificates();
  const cert = await readFile(certFile, 'utf8'); setDefaultCACertificates([...authorities, cert]);
  let fixtureError: unknown;
  const upstream = createServer({ key: await readFile(keyFile), cert }, async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
      calls.push({ url: request.url, authorization: request.headers.authorization, token: request.headers['x-amz-security-token'] as string, authHeaders: Object.keys(request.headers).filter(name => name.startsWith('x-amz-')), body: JSON.parse(text) });
      response.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
      response.end(bedrockText('native-bedrock-http-ok', 'end_turn', { inputTokens: 7, outputTokens: 2, cacheReadInputTokens: 3, totalTokens: 12 }));
    } catch (error) { fixtureError = error; response.writeHead(500); response.end('Invalid Bedrock fixture'); }
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('AI_HARNESS_MASTER_KEY', 'disposable-bedrock-http-master');
  vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'bedrock-user'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'bedrock-admin');
  const privateValue = auth === 'sigv4' ? 'disposablehttpsecret' : 'disposablehttp:opaque:bearer';
  const credential = auth === 'sigv4' ? 'DISPOSABLEHTTP:disposablehttpsecret:disposablehttpsession' : JSON.stringify({ bearerToken: privateValue });
  let sessionId: string | undefined;
  if (auth === 'bearer') vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', privateValue);
  try {
    await mkdir(cwd);
    for (let index = 0; index < 2; index++) {
      const server = await start({ port: 0, host: '127.0.0.1', dataDir, allowedRoots: [cwd], defaultCwd: cwd });
      const base = `http://127.0.0.1:${server.port}`, headers = { 'Content-Type': 'application/json', Authorization: 'Bearer bedrock-admin' };
      if (auth === 'bearer') {
        expect((await fetch(`${base}/api/providers`, { headers })).status).toBe(200);
        const restored = getProxy().getAgentProvider('bedrock');
        expect(restored?.validateConfig()).toBe(true);
        expect((restored as unknown as { config: { apiKey: string } }).config.apiKey).toBe(privateValue);
      }
      const post = (route: string, body: unknown, token = 'bedrock-admin') => fetch(`${base}${route}`, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      if (!index) {
        const definition = { type: 'bedrock', apiKey: credential, model, baseUrl: `https://127.0.0.1:${(upstream.address() as { port: number }).port}/proxy` };
        expect((await post('/api/config', definition, 'bedrock-user')).status).toBe(403);
        expect((await post('/api/config', { ...definition, baseUrl: definition.baseUrl.replace('https:', 'http:') })).status).toBe(400);
        const saved = await post('/api/config', definition); const savedText = await saved.text();
        expect(saved.status, savedText).toBe(200); expect(savedText).not.toContain(privateValue);
        expect(await readFile(path.join(dataDir, 'credentials.enc'), 'utf8')).not.toContain(privateValue);
        expect((await post('/api/workspaces/trust', { cwd, confirm: true })).status).toBe(200);
        const response = await post('/api/agent/runs', { cwd, provider: 'bedrock', model, input: 'hello' }); expect(response.status).toBe(202);
        const { run } = await response.json() as { run: { id: string; sessionId: string } }; sessionId = run.sessionId;
        await vi.waitFor(async () => expect(await fetch(`${base}/api/agent/runs/${run.id}`, { headers }).then(result => result.json())).toMatchObject({ phase: 'completed' }));
      }
      const catalog = await fetch(`${base}/api/models`, { headers }).then(result => result.json());
      const models = catalog.providers.find((provider: { provider: string }) => provider.provider === 'bedrock')?.models;
      if (!index) expect(models).toContainEqual(expect.objectContaining({ id: model, api: 'bedrock-converse-stream', available: true }));
      else expect(models.some((item: { available: boolean; api: string }) => item.available && item.api === 'bedrock-converse-stream')).toBe(true);
      const text = await fetch(`${base}/api/agent/sessions/${sessionId}/state`, { headers }).then(result => result.text());
      expect(text).toContain('native-bedrock-http-ok'); expect(text).toContain('"api":"bedrock-converse-stream"');
      const journal = await readFile(path.join(dataDir, 'sessions', `${sessionId}.jsonl`), 'utf8');
      expect(journal.trim().split('\n').map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', provider: 'bedrock', api: 'bedrock-converse-stream',
        usage: expect.objectContaining({ inputTokens: 7, outputTokens: 2, cacheReadTokens: 3, totalTokens: 12 }) }));
      expect(text + journal + JSON.stringify(catalog)).not.toContain(privateValue);
      await stop();
      if (auth === 'bearer') vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', undefined);
    }
    expect(fixtureError).toBeUndefined(); expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: '/proxy/model/fixture%3A0/converse-stream', authorization: auth === 'sigv4' ? expect.stringContaining('Credential=DISPOSABLEHTTP/') : `Bearer ${privateValue}`, token: auth === 'sigv4' ? 'disposablehttpsession' : undefined, body: { messages: expect.any(Array) } });
    if (auth === 'bearer') expect(calls[0].authHeaders).toEqual([]);
  } finally {
    await stop(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); vi.unstubAllEnvs(); setDefaultCACertificates(authorities); await rm(root, { recursive: true, force: true });
  }
}, 30_000);
