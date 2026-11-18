import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { start, stop } from '../packages/server/dist/index.js';
import { bedrockText } from '../tests/fixtures/bedrock-event-stream.js';
import { expect, test } from './fixtures/test-budget';

for (const auth of ['sigv4', 'bearer'] as const) {
test(`configured built-in Bedrock ${auth} reaches binary HTTPS from the browser and survives transcript reload`, async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-bedrock-web-'));
  const cwd = path.join(root, 'work'), dataDir = path.join(root, 'data'), model = 'fixture:0';
  const names = ['AI_HARNESS_AUTH_TOKEN', 'AI_HARNESS_ADMIN_TOKEN', 'AI_HARNESS_AGENT_DIR', 'AI_HARNESS_MASTER_KEY'] as const;
  const previous = names.map(name => process.env[name]);
  process.env.AI_HARNESS_AUTH_TOKEN = 'bedrock-user'; process.env.AI_HARNESS_ADMIN_TOKEN = 'bedrock-admin';
  process.env.AI_HARNESS_AGENT_DIR = path.join(root, 'agent'); process.env.AI_HARNESS_MASTER_KEY = 'disposable-bedrock-web-master';
  const keyFile = path.join(root, 'loopback.key'), certFile = path.join(root, 'loopback.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyFile, '-out', certFile], { stdio: 'ignore', timeout: 10_000 });
  const authorities = getCACertificates(), cert = await readFile(certFile, 'utf8'); setDefaultCACertificates([...authorities, cert]);
  const calls: Array<{ path?: string; authorization?: string; authHeaders: string[]; body: unknown }> = [];
  let fixtureError: unknown;
  const wire = createServer({ key: await readFile(keyFile), cert }, async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
      calls.push({ path: request.url, authorization: request.headers.authorization, authHeaders: Object.keys(request.headers).filter(name => name.startsWith('x-amz-')), body: JSON.parse(text) });
      response.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
      response.end(bedrockText('Bedrock native wire received.', 'end_turn', { inputTokens: 7, outputTokens: 2, cacheReadInputTokens: 3, totalTokens: 12 }));
    } catch (error) { fixtureError = error; response.writeHead(500); response.end('Invalid Bedrock fixture'); }
  });
  await mkdir(cwd); await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  try {
    const server = await start({ port: 0, host: '127.0.0.1', dataDir, defaultCwd: cwd, allowedRoots: [cwd],
      webRoot: path.resolve('packages/web/dist'), enableMockProvider: true });
    const base = `http://127.0.0.1:${server.port}`;
    expect((await page.request.post(`${base}/api/auth/login`, { data: { token: 'bedrock-admin' } })).status()).toBe(200);
    expect((await page.request.post(`${base}/api/workspaces/trust`, { data: { cwd, confirm: true } })).status()).toBe(200);
    expect((await page.request.post(`${base}/api/config`, { data: { type: 'bedrock', apiKey: auth === 'sigv4' ? 'DISPOSABLEWEB:disposablewebsecret' : JSON.stringify({ bearerToken: 'disposableweb:opaque:bearer' }), model,
      baseUrl: `https://127.0.0.1:${(wire.address() as { port: number }).port}/proxy` } })).status()).toBe(200);
    expect((await page.request.patch(`${base}/api/configuration/scope`, { data: { scope: 'global',
      values: { provider: 'bedrock', model, toolPreset: 'chat-only' } } })).status()).toBe(200);
    await page.addInitScript(() => localStorage.setItem('ai-harness-locale', 'en'));
    await page.goto(`${base}/settings?cwd=${encodeURIComponent(cwd)}`);
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message composer' }).fill('Exercise native Bedrock');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message.assistant')).toContainText('Bedrock native wire received.');
    expect(fixtureError).toBeUndefined(); expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: '/proxy/model/fixture%3A0/converse-stream', authorization: auth === 'sigv4' ? expect.stringContaining('Credential=DISPOSABLEWEB/') : 'Bearer disposableweb:opaque:bearer', body: { messages: expect.any(Array) } });
    if (auth === 'bearer') expect(calls[0].authHeaders).toEqual([]);
    await page.reload(); await expect(page.locator('.message.assistant')).toHaveCount(1);
    await expect(page.locator('.message.assistant')).toContainText('Bedrock native wire received.'); expect(calls).toHaveLength(1);
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('disposablewebsecret');
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('disposableweb:opaque:bearer');
  } finally {
    await page.goto('about:blank').catch(() => undefined); await stop();
    wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve())); setDefaultCACertificates(authorities);
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    await rm(root, { recursive: true, force: true });
  }
});
}
