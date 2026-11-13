import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, reserveReadBudget } from './fixtures/test-budget';
import { start, stop } from '../packages/server/dist/index.js';
import { EncryptedCredentialStore, ProviderCredentialService } from '../packages/core/dist/index.js';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
async function fixture() {
  const previous = Object.fromEntries(['AI_HARNESS_MASTER_KEY', 'AI_HARNESS_AUTH_TOKEN', 'AI_HARNESS_ADMIN_TOKEN'].map(key => [key, process.env[key]]));
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-codex-browser-')), cwd = path.join(root, 'work'), dataDir = path.join(root, 'data');
  const file = path.join(dataDir, 'credentials.enc'), master = 'disposable-codex-browser-master';
  const token = 'e30.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'codex-browser-account' } })).toString('base64url') + '.c2ln';
  const grant = 'PRIVATE_CODEX_BROWSER_REFRESH', device = { device_auth_id: 'PRIVATE_CODEX_DEVICE', user_code: 'WEB-CODE', interval: 1 };
  const calls: Array<{ url: string; method: string }> = [], originalFetch = globalThis.fetch;
  let hold: { target: 'device' | 'token'; reached: ReturnType<typeof deferred<AbortSignal>>; response: ReturnType<typeof deferred<Response>> } | undefined;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target === 'https://api.github.com/repos/Fidigi/AiHarness/releases/latest') return new Response(null, { status: 404 });
    if (!['auth.openai.com', 'chatgpt.com'].includes(new URL(target).hostname)) return originalFetch(url, init);
    calls.push({ url: target, method: init?.method ?? 'GET' });
    if (target.endsWith('/usercode')) {
      if (hold?.target === 'device') { hold.reached.resolve(init!.signal!); return hold.response.promise; }
      return Response.json(device);
    }
    if (target.endsWith('/deviceauth/token')) return Response.json({ authorization_code: 'PRIVATE_CODEX_CODE', code_verifier: 'PRIVATE_CODEX_VERIFIER' });
    if (target === 'https://auth.openai.com/oauth/token') {
      if (hold?.target === 'token') { hold.reached.resolve(init!.signal!); return hold.response.promise; }
      return Response.json({ access_token: token, refresh_token: grant, expires_in: 3600 });
    }
    expect(target).toBe('https://chatgpt.com/backend-api/codex/models?client_version=0.167.2');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + token);
    expect(new Headers(init?.headers).get('chatgpt-account-id')).toBe('codex-browser-account');
    return Response.json({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list' }] });
  };
  process.env.AI_HARNESS_MASTER_KEY = master;
  process.env.AI_HARNESS_AUTH_TOKEN = 'codex-browser-user'; process.env.AI_HARNESS_ADMIN_TOKEN = 'codex-browser-admin';
  const reader = () => new ProviderCredentialService({ store: new EncryptedCredentialStore(file, master) });
  const close = async () => {
    hold?.response.resolve(Response.json({}));
    try { await stop(); await rm(root, { recursive: true, force: true }); }
    finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  };
  try {
    await mkdir(cwd); await mkdir(dataDir);
    const server = await start({ host: '127.0.0.1', port: 0, dataDir, defaultCwd: cwd, allowedRoots: [root], enableMockProvider: true,
      webRoot: fileURLToPath(new URL('../packages/web/dist/', import.meta.url)) });
    return { base: `http://localhost:${server.port}`, file, token, grant, calls, reader, close,
      hold(target: 'device' | 'token') {
        const current = { target, reached: deferred<AbortSignal>(), response: deferred<Response>() }; hold = current;
        return { reached: current.reached.promise, release: () => {
          hold = undefined; current.response.resolve(Response.json(target === 'device' ? device : { access_token: token, refresh_token: grant, expires_in: 3600 }));
        } };
      } };
  } catch (error) { await close(); throw error; }
}

for (const locale of ['en', 'fr'] as const) test(`native Codex Settings ${locale}: device login, encrypted account, cancellation and logout`, async ({ page }) => {
  const f = await fixture();
  const copy = locale === 'fr'
    ? { connect: 'Connecter', reconnect: 'Reconnecter', disconnect: 'Déconnecter', cancel: 'Annuler', connected: 'Fournisseur connecté.', select: 'Sélectionner le Provider IA' }
    : { connect: 'Connect', reconnect: 'Reconnect', disconnect: 'Disconnect', cancel: 'Cancel', connected: 'Provider connected.', select: 'Select the AI Provider' };
  try {
    expect((await page.request.post(f.base + '/api/auth/login', { headers: { Origin: f.base }, data: { token: 'codex-browser-admin' } })).status()).toBe(200);
    await reserveReadBudget(page.request, f.base);
    await page.addInitScript(locale => {
      localStorage.setItem('ai-harness-locale', locale);
      localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme: 'light', lastSettingsSection: 'provider-lifecycle' }));
    }, locale);
    const mutations: string[] = [];
    page.on('request', request => { if (request.method() !== 'GET' && request.url().includes('/api/')) mutations.push(new URL(request.url()).pathname); });
    await page.goto(f.base + '/settings#provider-lifecycle');
    const section = page.locator('#provider-lifecycle'), panel = section.locator('.oauth-device-flow'), card = section.locator('article[data-settings-selection="openai-codex"]');
    await expect(card.getByRole('button', { name: copy.connect, exact: true })).toBeVisible();
    const selected = await page.getByLabel(copy.select, { exact: true }).inputValue(); expect(f.calls).toEqual([]);
    const device = f.hold('device');
    await card.getByRole('button', { name: copy.connect, exact: true }).click(); const deviceSignal = await device.reached;
    await panel.getByRole('button', { name: copy.cancel, exact: true }).click(); await expect.poll(() => deviceSignal.aborted).toBe(true);
    device.release(); await expect(panel).toHaveCount(0); expect(f.calls).toHaveLength(1);
    const token = f.hold('token');
    await card.getByRole('button', { name: copy.connect, exact: true }).click(); await token.reached;
    await expect(panel).toContainText('WEB-CODE'); await expect(panel.locator('a')).toHaveAttribute('href', 'https://auth.openai.com/codex/device');
    const cancelled = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().includes('/auth/oauth/'));
    await panel.getByRole('button', { name: copy.cancel, exact: true }).click(); expect((await cancelled).status()).toBe(200); token.release();
    const absent = f.reader(); await absent.load(); expect(await absent.resolve('openai-codex', { env: {}, subscriptionProvider: 'openai-codex' })).toBeUndefined();
    await card.getByRole('button', { name: copy.connect, exact: true }).click(); await expect(panel).toContainText(copy.connected);
    await expect(card.getByRole('button', { name: copy.reconnect, exact: true })).toBeVisible();
    expect(await page.getByLabel(copy.select, { exact: true }).inputValue()).toBe(selected);
    const stored = f.reader(); await stored.load(); expect((await stored.resolve('openai-codex', { env: {}, subscriptionProvider: 'openai-codex' }))?.credential).toMatchObject({
      accessToken: f.token, refreshToken: f.grant, subscription: { provider: 'openai-codex', accountId: 'codex-browser-account' } });
    expect((await stat(f.file)).mode & 0o777).toBe(0o600);
    const encrypted = await readFile(f.file, 'utf8'), visible = await page.locator('body').innerText();
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    for (const secret of [f.token, f.grant, 'PRIVATE_CODEX_DEVICE', 'PRIVATE_CODEX_CODE', 'PRIVATE_CODEX_VERIFIER']) {
      expect(encrypted + visible + storage).not.toContain(secret);
    }
    await page.reload(); await expect(card.getByRole('button', { name: copy.reconnect, exact: true })).toBeVisible();
    const sampled = deferred<void>(), released = deferred<void>();
    await page.route('**/api/provider-registry/auth/oauth/*', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch(); expect((await response.json()).state).toBe('connected'); sampled.resolve(); await released.promise;
      if (!route.request().failure()) await route.fulfill({ response });
    });
    await card.getByRole('button', { name: copy.reconnect, exact: true }).click(); await sampled.promise;
    const logout = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().endsWith('/auth/openai-codex'));
    await card.getByRole('button', { name: copy.disconnect, exact: true }).click(); expect((await logout).status()).toBe(200); released.resolve();
    await expect(panel).toHaveCount(0); await expect(card.getByRole('button', { name: copy.connect, exact: true })).toBeVisible();
    const withdrawn = f.reader(); await withdrawn.load(); expect(await withdrawn.resolve('openai-codex', { env: {}, subscriptionProvider: 'openai-codex' })).toBeUndefined();
    expect(mutations.some(path => path.includes('/models/enabled') || path.includes('/configuration/'))).toBe(false);
    expect(f.calls.filter(call => call.method !== 'GET').every(call => call.url.startsWith('https://auth.openai.com/'))).toBe(true);
  } finally { await page.goto('about:blank').catch(() => undefined); await f.close(); }
});
