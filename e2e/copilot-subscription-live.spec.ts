import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, reserveReadBudget } from './fixtures/test-budget';
import { start, stop } from '../packages/server/dist/index.js';
import { EncryptedCredentialStore, ProviderCredentialService } from '../packages/core/dist/index.js';

// Real emitted Server/static Web and encrypted storage; only outbound vendor
// responses are synthetic. No real subscription or GitHub authorization claim.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const previous = Object.fromEntries(['AI_HARNESS_MASTER_KEY', 'AI_HARNESS_AUTH_TOKEN', 'AI_HARNESS_ADMIN_TOKEN'].map(key => [key, process.env[key]]));
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-copilot-browser-'));
  const cwd = path.join(root, 'work'), dataDir = path.join(root, 'data'), file = path.join(dataDir, 'credentials.enc');
  const master = 'disposable-copilot-browser-master', grant = 'PRIVATE_COPILOT_BROWSER_GRANT';
  const token = 'tid=PRIVATE_COPILOT_BROWSER_TOKEN;proxy-ep=proxy.business.githubcopilot.com';
  const device = { device_code: 'PRIVATE_COPILOT_DEVICE', user_code: 'WEB-CODE', verification_uri: 'https://github.com/login/device', expires_in: 600, interval: 1 };
  const catalogue = { data: [{ id: 'gpt-5-mini', model_picker_enabled: true }, { id: 'claude-fable-5', model_picker_enabled: true, policy: { state: 'disabled' } }] };
  const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
  const originalFetch = globalThis.fetch;
  let hold: { target: 'device' | 'catalogue'; reached: ReturnType<typeof deferred<AbortSignal>>; response: ReturnType<typeof deferred<Response>> } | undefined;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    // Release checks share api.github.com, but are not subscription traffic.
    if (target === 'https://api.github.com/repos/Fidigi/AiHarness/releases/latest') return new Response(null, { status: 404 });
    if (!['github.com', 'api.github.com', 'api.business.githubcopilot.com'].includes(new URL(target).hostname)) return originalFetch(url, init);
    calls.push({ url: target, method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('authorization') });
    if (target === 'https://github.com/login/device/code') {
      if (hold?.target === 'device') { hold.reached.resolve(init!.signal!); return hold.response.promise; }
      return Response.json(device);
    }
    if (target === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: grant });
    if (target === 'https://api.github.com/copilot_internal/v2/token') return Response.json({ token, expires_at: Math.floor(Date.now() / 1000) + 3600 });
    if (target === 'https://api.business.githubcopilot.com/models') {
      if (hold?.target === 'catalogue') { hold.reached.resolve(init!.signal!); return hold.response.promise; }
      return Response.json(catalogue);
    }
    throw new Error('Unexpected Copilot browser outbound request.');
  };
  process.env.AI_HARNESS_MASTER_KEY = master;
  process.env.AI_HARNESS_AUTH_TOKEN = 'copilot-browser-user'; process.env.AI_HARNESS_ADMIN_TOKEN = 'copilot-browser-admin';
  const reader = () => new ProviderCredentialService({ store: new EncryptedCredentialStore(file, master) });
  const close = async () => {
    hold?.response.resolve(Response.json({ data: [] }));
    try { await stop(); await rm(root, { recursive: true, force: true }); }
    finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  };
  try {
    await mkdir(cwd); await mkdir(dataDir);
    const server = await start({ host: '127.0.0.1', port: 0, dataDir, defaultCwd: cwd, allowedRoots: [root],
      webRoot: fileURLToPath(new URL('../packages/web/dist/', import.meta.url)), enableMockProvider: true });
    return { base: `http://localhost:${server.port}`, file, token, grant, calls, reader, close,
      hold(target: 'device' | 'catalogue') {
        const current = { target, reached: deferred<AbortSignal>(), response: deferred<Response>() }; hold = current;
        return { reached: current.reached.promise, release: () => {
          hold = undefined; current.response.resolve(Response.json(target === 'device' ? device : catalogue));
        } };
      } };
  } catch (error) { await close(); throw error; }
}

for (const locale of ['en', 'fr'] as const) test(`native Copilot Settings ${locale}: explicit encrypted login, cancellation, reload and logout`, async ({ page }) => {
  const f = await fixture();
  const copy = locale === 'fr'
    ? { connect: 'Connecter', reconnect: 'Reconnecter', disconnect: 'Déconnecter', cancel: 'Annuler', connected: 'Fournisseur connecté.', select: 'Sélectionner le Provider IA' }
    : { connect: 'Connect', reconnect: 'Reconnect', disconnect: 'Disconnect', cancel: 'Cancel', connected: 'Provider connected.', select: 'Select the AI Provider' };
  try {
    expect((await page.request.post(f.base + '/api/auth/login', { headers: { Origin: f.base }, data: { token: 'copilot-browser-admin' } })).status()).toBe(200);
    await reserveReadBudget(page.request, f.base);
    await page.addInitScript(locale => {
      localStorage.setItem('ai-harness-locale', locale);
      localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme: 'light', lastSettingsSection: 'provider-lifecycle' }));
    }, locale);
    const mutations: string[] = [];
    page.on('request', request => { if (request.method() !== 'GET' && request.url().includes('/api/')) mutations.push(new URL(request.url()).pathname); });
    await page.goto(f.base + '/settings#provider-lifecycle');
    const section = page.locator('#provider-lifecycle'), panel = section.locator('.oauth-device-flow');
    const card = section.locator('article[data-settings-selection="github-copilot"]');
    await expect(card.getByRole('button', { name: copy.connect, exact: true })).toBeVisible();
    const selection = await page.getByLabel(copy.select, { exact: true }).inputValue();
    expect(f.calls).toEqual([]);

    // Cancel before the Server can return a flow ID; HTTP disconnect owns this start.
    const device = f.hold('device');
    await card.getByRole('button', { name: copy.connect, exact: true }).click();
    const deviceSignal = await device.reached;
    await expect(panel.getByRole('button', { name: copy.cancel, exact: true })).toBeVisible();
    await panel.getByRole('button', { name: copy.cancel, exact: true }).click();
    await expect.poll(() => deviceSignal.aborted).toBe(true);
    device.release();
    await expect(panel).toHaveCount(0);
    expect(f.calls).toHaveLength(1);

    // Cancel after the GitHub grant, with account discovery held before publication.
    const catalogue = f.hold('catalogue');
    await card.getByRole('button', { name: copy.connect, exact: true }).click();
    await expect(panel).toContainText('WEB-CODE');
    await expect(panel.locator('a')).toHaveAttribute('href', 'https://github.com/login/device');
    await catalogue.reached;
    const cancelled = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().includes('/auth/oauth/'));
    await panel.getByRole('button', { name: copy.cancel, exact: true }).click();
    expect((await cancelled).status()).toBe(200);
    catalogue.release();
    const absent = f.reader(); await absent.load();
    expect(await absent.resolve('github-copilot', { env: {}, subscriptionProvider: 'github-copilot' })).toBeUndefined();

    await card.getByRole('button', { name: copy.connect, exact: true }).click();
    await expect(panel).toContainText(copy.connected);
    await expect(card.getByRole('button', { name: copy.reconnect, exact: true })).toBeVisible();
    expect(await page.getByLabel(copy.select, { exact: true }).inputValue()).toBe(selection);
    const stored = f.reader(); await stored.load();
    expect((await stored.resolve('github-copilot', { env: {}, subscriptionProvider: 'github-copilot' }))?.credential).toMatchObject({
      accessToken: f.token, refreshToken: f.grant, subscription: { provider: 'github-copilot', availableModelIds: ['gpt-5-mini'] },
    });
    const encrypted = await readFile(f.file, 'utf8');
    expect((await stat(f.file)).mode & 0o777).toBe(0o600);
    const visible = await page.locator('body').innerText();
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    for (const secret of [f.token, f.grant, 'PRIVATE_COPILOT_DEVICE']) {
      expect(encrypted).not.toContain(secret); expect(visible).not.toContain(secret); expect(storage).not.toContain(secret);
    }
    await page.reload();
    await expect(card.getByRole('button', { name: copy.reconnect, exact: true })).toBeVisible();

    // The poll sampled a connected state before logout; its delayed browser response
    // must not restore retired presentation or start a replacement catalogue reload.
    const sampled = deferred<void>(), released = deferred<void>();
    await page.route('**/api/provider-registry/auth/oauth/*', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      expect((await response.json()).state).toBe('connected');
      sampled.resolve(); await released.promise;
      // Retirement can abort the request while its real response is held.
      if (!route.request().failure()) await route.fulfill({ response });
    });
    await card.getByRole('button', { name: copy.reconnect, exact: true }).click();
    await sampled.promise;
    const logout = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().endsWith('/auth/github-copilot'));
    await card.getByRole('button', { name: copy.disconnect, exact: true }).click();
    expect((await logout).status()).toBe(200);
    released.resolve();
    await expect(panel).toHaveCount(0);
    await expect(card.getByRole('button', { name: copy.connect, exact: true })).toBeVisible();
    const withdrawn = f.reader(); await withdrawn.load();
    expect(await withdrawn.resolve('github-copilot', { env: {}, subscriptionProvider: 'github-copilot' })).toBeUndefined();
    expect(mutations.some(path => path.includes('/models/enabled') || path.includes('/configuration/'))).toBe(false);
    expect(f.calls).toHaveLength(13);
    expect(f.calls.filter(call => call.method !== 'GET').every(call => call.url.startsWith('https://github.com/login/'))).toBe(true);
  } finally {
    // Timeout closes Playwright's page before teardown. Still close the owned
    // Server and restore process-local fixtures; never replace the test failure.
    await page.goto('about:blank').catch(() => undefined);
    await f.close();
  }
});
