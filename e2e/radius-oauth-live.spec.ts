import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { start, stop } from '../packages/server/dist/index.js';
import { expect, test } from './fixtures/test-budget';

test('Settings connects a custom Radius gateway with native PKCE, account discovery and P inference', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-radius-settings-')), cwd = path.join(root, 'work'), dataDir = path.join(root, 'data');
  const id = 'web-radius', token = 'synthetic-radius-web-access', refresh = 'synthetic-radius-web-refresh', code = 'SYNTHETIC_RADIUS_WEB_CODE', model = 'account-only';
  const names = ['AI_HARNESS_AUTH_TOKEN', 'AI_HARNESS_ADMIN_TOKEN', 'AI_HARNESS_AGENT_DIR', 'AI_HARNESS_MASTER_KEY'] as const, previous = names.map(name => process.env[name]);
  process.env.AI_HARNESS_AUTH_TOKEN = 'radius-user'; process.env.AI_HARNESS_ADMIN_TOKEN = 'radius-admin'; process.env.AI_HARNESS_AGENT_DIR = path.join(root, 'agent'); process.env.AI_HARNESS_MASTER_KEY = 'synthetic-radius-web-master';
  const calls: Array<{ path?: string; auth?: string; body?: Record<string, any> }> = []; let failure: unknown, authorization: URL;
  const wire = createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) { text += chunk; expect(Buffer.byteLength(text)).toBeLessThan(2000000); }
      const gateway = `http://127.0.0.1:${(wire.address() as { port: number }).port}`;
      calls.push({ path: request.url, auth: request.headers.authorization, body: text && request.url !== '/v1/oauth/token' ? JSON.parse(text) : undefined }); response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/oauth') { response.end(JSON.stringify({ authorizationEndpoint: gateway + '/authorize' })); return; }
      if (request.url === '/v1/oauth/token') {
        const form = Object.fromEntries(new URLSearchParams(text)); expect(request.headers.authorization).toBeUndefined();
        expect(form).toMatchObject({ client_id: 'pi-gateway', grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:1456/oauth/callback' });
        expect(createHash('sha256').update(form.code_verifier!).digest('base64url')).toBe(authorization.searchParams.get('code_challenge'));
        response.end(JSON.stringify({ access_token: token, refresh_token: refresh, expires_in: 3600 })); return;
      }
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      if (request.url === '/v1/config') { response.end(JSON.stringify({ baseUrl: gateway + '/p/v1', models: [{ id: model, name: 'Owned Radius', reasoning: false, input: ['text'], contextWindow: 1000000, maxTokens: 65536, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] })); return; }
      expect(request.url).toBe('/p/v1/messages'); response.setHeader('content-type', 'text/event-stream');
      response.end([{ type: 'start' }, { type: 'text_start', contentIndex: 0 }, { type: 'text_delta', contentIndex: 0, delta: 'Radius native Web reply.' }, { type: 'text_end', contentIndex: 0, content: 'Radius native Web reply.', contentSignature: 'radius-web-private-text' },
        { type: 'done', reason: 'stop', usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: 0.001 } } }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    } catch (error) { failure = error; response.statusCode = 500; response.end('Invalid Radius Web fixture'); }
  });
  await mkdir(cwd); await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  try {
    const server = await start({ port: 0, host: '127.0.0.1', dataDir, defaultCwd: cwd, allowedRoots: [cwd], webRoot: path.resolve('packages/web/dist'), enableMockProvider: true }), base = `http://127.0.0.1:${server.port}`;
    expect((await page.request.post(`${base}/api/auth/login`, { data: { token: 'radius-admin' } })).status()).toBe(200);
    expect((await page.request.post(`${base}/api/workspaces/trust`, { data: { cwd, confirm: true } })).status()).toBe(200);
    await page.addInitScript(() => localStorage.setItem('ai-harness-locale', 'en')); await page.goto(`${base}/settings?cwd=${encodeURIComponent(cwd)}`);
    const section = page.locator('#provider-lifecycle'), editor = section.locator('details.custom-resource-editor');
    const open = async () => { if (await editor.getAttribute('open') === null) await section.getByText('Create or edit a compatible provider', { exact: true }).click(); };
    await open(); const form = editor.locator('form');
    await form.getByLabel('ID', { exact: true }).fill(id); await form.getByLabel('Name', { exact: true }).fill('Radius native account');
    await form.getByLabel('Base URL', { exact: true }).fill(`http://127.0.0.1:${(wire.address() as { port: number }).port}`); await form.getByRole('combobox', { name: 'API dialect', exact: true }).selectOption('radius');
    await form.getByRole('button', { name: 'Save', exact: true }).click(); const card = section.locator(`[data-settings-selection="${id}"]`), status = card.locator(':scope > span');
    await expect(status).toHaveText('disconnected · 0 models'); expect(calls).toEqual([]);
    await card.getByRole('button', { name: 'Browser sign-in (PKCE)', exact: true }).click(); const paste = page.locator('.provider-oauth-paste');
    await expect(paste).toBeVisible(); authorization = new URL((await paste.getByRole('link', { name: 'Open authorization page', exact: true }).getAttribute('href'))!);
    expect(authorization.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1456/oauth/callback');
    await paste.getByLabel('Paste the full OAuth callback address', { exact: true }).fill(`http://127.0.0.1:1456/oauth/callback?state=${authorization.searchParams.get('state')}&code=${code}`);
    await paste.getByRole('button', { name: 'Submit callback', exact: true }).click(); await expect(status).toHaveText('connected · 0 models'); await open();
    const [imported] = await Promise.all([page.waitForResponse(response => response.url().endsWith(`/api/provider-registry/custom/${id}/import-models`)), card.getByRole('button', { name: 'Import models', exact: true }).click()]); expect(imported.status()).toBe(200);
    expect((await page.request.patch(`${base}/api/configuration/scope`, { data: { scope: 'global', values: { provider: id, model, thinking: 'off', toolPreset: 'chat-only' } } })).status()).toBe(200);
    await page.reload(); await page.getByRole('button', { name: 'New chat', exact: true }).click(); const composer = page.getByRole('textbox', { name: 'Message composer' });
    await composer.fill('Native Radius Web'); await composer.press('Enter'); await expect(page.locator('.message.assistant')).toContainText('Radius native Web reply.');
    expect(calls.filter(call => call.path === '/p/v1/messages')).toHaveLength(1); await page.reload(); await expect(page.locator('.message.assistant')).toContainText('Radius native Web reply.');
    await page.goto(`${base}/settings?cwd=${encodeURIComponent(cwd)}`); await expect(card).toHaveCount(1); await open(); await card.getByRole('button', { name: 'Disconnect', exact: true }).click(); await expect(status).toHaveText('disconnected · 1 models');
    expect(calls.filter(call => call.path === '/p/v1/messages')).toHaveLength(1); expect(failure).toBeUndefined();
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    for (const secret of [token, refresh, code]) expect(storage + await readFile(path.join(dataDir, 'providers.json'), 'utf8') + await readFile(path.join(dataDir, 'provider-secrets.enc'), 'utf8')).not.toContain(secret);
  } finally {
    await page.goto('about:blank').catch(() => undefined); await stop(); wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve()));
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; }); await rm(root, { recursive: true, force: true });
  }
});
