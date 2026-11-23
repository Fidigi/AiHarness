import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { start, stop } from '../packages/server/dist/index.js';
import { expect, test } from './fixtures/test-budget';
import { closeSettings } from './fixtures/settings-navigation';

test('Settings connects custom OpenRouter with full-paste PKCE, permanent key and native C inference', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-router-settings-')), cwd = path.join(root, 'work'), dataDir = path.join(root, 'data');
  const id = 'web-router', key = 'synthetic-router-web-key', code = 'SYNTHETIC_ROUTER_WEB_CODE', model = 'openai/gpt-4o';
  const names = ['AI_HARNESS_AUTH_TOKEN', 'AI_HARNESS_ADMIN_TOKEN', 'AI_HARNESS_AGENT_DIR', 'AI_HARNESS_MASTER_KEY'] as const, previous = names.map(name => process.env[name]);
  process.env.AI_HARNESS_AUTH_TOKEN = 'router-user'; process.env.AI_HARNESS_ADMIN_TOKEN = 'router-admin'; process.env.AI_HARNESS_AGENT_DIR = path.join(root, 'agent'); process.env.AI_HARNESS_MASTER_KEY = 'synthetic-router-web-master';
  const calls: string[] = []; let failure: unknown, authorization: URL;
  const wire = createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) { text += chunk; expect(Buffer.byteLength(text)).toBeLessThan(2000000); } const body = JSON.parse(text); calls.push(request.url!);
      if (request.url === '/keys') {
        expect(request.headers.authorization).toBeUndefined(); expect(body).toMatchObject({ code, code_challenge_method: 'S256' }); expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(authorization.searchParams.get('code_challenge'));
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ key })); return;
      }
      expect(request.url).toBe('/v1/chat/completions'); expect(request.headers.authorization).toBe(`Bearer ${key}`); expect(body.model).toBe(model); response.setHeader('content-type', 'text/event-stream');
      response.end('data: ' + JSON.stringify({ id: 'synthetic-router-web', choices: [{ delta: { content: 'OpenRouter native Web reply.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }) + '\n\ndata: [DONE]\n\n');
    } catch (error) { failure = error; response.statusCode = 500; response.end('Invalid OpenRouter Web fixture'); }
  });
  await mkdir(cwd); await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve)); const endpoint = `http://127.0.0.1:${(wire.address() as { port: number }).port}`, transport = globalThis.fetch;
  // Fixed production issuer is mapped only to this synthetic loopback; no external-service fallback.
  globalThis.fetch = (input, init) => { const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url); if (url.href === 'https://openrouter.ai/api/v1/auth/keys') return transport(endpoint + '/keys', init); if (url.hostname === '127.0.0.1') return transport(input, init); return Promise.reject(new Error('Outside synthetic OpenRouter Web transport')); };
  try {
    const server = await start({ port: 0, host: '127.0.0.1', dataDir, defaultCwd: cwd, allowedRoots: [cwd], webRoot: path.resolve('packages/web/dist'), enableMockProvider: true }), base = `http://127.0.0.1:${server.port}`;
    expect((await page.request.post(`${base}/api/auth/login`, { data: { token: 'router-admin' } })).status()).toBe(200); expect((await page.request.post(`${base}/api/workspaces/trust`, { data: { cwd, confirm: true } })).status()).toBe(200);
    await page.addInitScript(() => localStorage.setItem('ai-harness-locale', 'en')); await page.goto(`${base}/settings?cwd=${encodeURIComponent(cwd)}#provider-lifecycle`);
    const section = page.locator('#provider-lifecycle'), editor = section.locator('details.custom-resource-editor'), open = async () => { if (await editor.getAttribute('open') === null) await section.getByText('Create or edit a compatible provider', { exact: true }).click(); };
    await open(); const form = editor.locator('form'); await form.getByLabel('ID', { exact: true }).fill(id); await form.getByLabel('Name', { exact: true }).fill('OpenRouter native key'); await form.getByLabel('Base URL', { exact: true }).fill(endpoint); await form.getByRole('combobox', { name: 'API dialect', exact: true }).selectOption('openrouter'); await form.getByRole('button', { name: 'Save', exact: true }).click();
    const card = section.locator(`[data-settings-selection="${id}"]`), status = card.locator(':scope > span'); await expect(status).toHaveText('disconnected · 0 models'); expect(calls).toEqual([]);
    await card.getByRole('button', { name: 'Browser sign-in (PKCE)', exact: true }).click(); const paste = page.locator('.provider-oauth-paste'); await expect(paste).toBeVisible(); authorization = new URL((await paste.getByRole('link', { name: 'Open authorization page', exact: true }).getAttribute('href'))!);
    expect(authorization.origin + authorization.pathname).toBe('https://openrouter.ai/auth'); expect(authorization.searchParams.has('state')).toBe(false);
    await paste.getByLabel('Paste the full OAuth callback address', { exact: true }).fill(authorization.searchParams.get('callback_url')! + '?code=' + code); await paste.getByRole('button', { name: 'Submit callback', exact: true }).click(); await expect(status).toHaveText('connected · 0 models'); await open();
    const [imported] = await Promise.all([page.waitForResponse(response => response.url().endsWith(`/api/provider-registry/custom/${id}/import-models`)), card.getByRole('button', { name: 'Import models', exact: true }).click()]); expect(imported.status()).toBe(200);
    const inventory = await page.request.get(`${base}/api/provider-registry/custom`).then(result => result.json()) as Array<{ id: string; modelCount: number }>, count = inventory.find(provider => provider.id === id)!.modelCount; expect(count).toBeGreaterThan(0);
    expect((await page.request.patch(`${base}/api/configuration/scope`, { data: { scope: 'global', values: { provider: id, model, thinking: 'off', toolPreset: 'chat-only' } } })).status()).toBe(200);
    await page.reload(); await closeSettings(page); await page.getByRole('button', { name: 'New chat', exact: true }).click(); const composer = page.getByRole('textbox', { name: 'Message composer' }); await composer.fill('Native OpenRouter Web'); await composer.press('Enter'); await expect(page.locator('.message.assistant')).toContainText('OpenRouter native Web reply.'); expect(calls).toEqual(['/keys', '/v1/chat/completions']);
    await page.reload(); await expect(page.locator('.message.assistant')).toContainText('OpenRouter native Web reply.'); await page.goto(`${base}/settings?cwd=${encodeURIComponent(cwd)}`); await expect(card).toHaveCount(1); await open(); await expect(status).toHaveText(`connected · ${count} models`); await card.getByRole('button', { name: 'Disconnect', exact: true }).click(); await expect(status).toHaveText(`disconnected · ${count} models`); expect(calls).toEqual(['/keys', '/v1/chat/completions']); expect(failure).toBeUndefined();
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })); for (const secret of [key, code]) expect(storage + await readFile(path.join(dataDir, 'providers.json'), 'utf8') + await readFile(path.join(dataDir, 'provider-secrets.enc'), 'utf8')).not.toContain(secret);
  } finally {
    await page.goto('about:blank').catch(() => undefined); await stop(); globalThis.fetch = transport; wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve())); names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; }); await rm(root, { recursive: true, force: true });
  }
});
