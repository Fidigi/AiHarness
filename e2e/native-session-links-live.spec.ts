import AxeBuilder from '@axe-core/playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test, type Page } from './fixtures/test-budget';
import { nativeFrontendRelay, type NativeFrontendRelay } from '../packages/web/src/test-support/native-frontend-relay';

// Only new independent journeys; retain the original new-fixture60s budget.
// Separate native intents before freeze rather than exhausting real API quota
// inside one case. Never retry an in-case429 or change the shared limiter.
test.describe.configure({ timeout: 60_000 });
const activations = ['modified', 'middle', 'explicit', 'project', 'search', 'plain', 'missing'] as const;
type Activation = typeof activations[number];
async function openNavigation(page: Page) {
  const toggle = page.getByRole('button', { name: /^(Toggle navigation|Afficher ou masquer la navigation)$/ });
  if (page.viewportSize()!.width < 960 && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await expect(page.locator('.workspace-button')).toBeVisible();
}

/** Genuine Server-owned sessions. No provider/runtime/API/link data is fabricated. */
async function exercise(page: Page, prefix: string, locale: string, theme: string, activation: Activation, relay?: NativeFrontendRelay) {
  const cwd = await mkdtemp(path.join(process.cwd(), 'e2e', '.native-links-live-'));
  const ids: string[] = [], messageIds: string[] = [];
  const snapshots: unknown[] = [];
  const mutations: string[] = [], quotaFailures: string[] = [];
  const validationReads: Array<string | null> = [];
  const record = (request: { method(): string; url(): string; postData(): string | null }) => {
    const pathname = new URL(request.url()).pathname;
    // Existing canonical metadata read, not a trust/session mutation.
    if (request.method() === 'POST' && pathname === '/api/workspaces/validate') validationReads.push(request.postData());
    else if (request.method() !== 'GET' && pathname.startsWith('/api/')) mutations.push(request.url());
  };
  const quota = (response: { status(): number; url(): string }) => {
    const pathname = new URL(response.url()).pathname;
    if (response.status() === 429 && pathname.startsWith('/api/')) {
      quotaFailures.push(pathname); console.error('[native-link-fixture] In-case API quota refusal.', { pathname, status: 429 });
    }
  };
  try {
    expect((await page.request.post('/api/workspaces/trust', { data: { cwd, confirm: true } })).status()).toBe(200);
    for (const label of ['NATIVE_OLD', 'NATIVE_TARGET']) {
      const created = await page.request.post('/api/sessions', { data: { cwd, title: label } });
      expect(created.status()).toBe(201);
      const session = await created.json() as { id: string }; ids.push(session.id);
      const appended = await page.request.post(`/api/sessions/${session.id}/messages`, { data: { role: 'user', content: `${label}_PUBLIC_BODY` } });
      expect(appended.status()).toBe(201);
      const message = await appended.json() as { id: string };
      expect(typeof message.id).toBe('string'); expect(message.id).not.toBe(''); messageIds.push(message.id);
      const snapshot = await page.request.get(`/api/sessions/${session.id}`);
      expect(snapshot.status()).toBe(200); snapshots.push(await snapshot.json());
    }
    relay?.startRead();
    page.context().on('request', record); page.context().on('response', quota);
    await page.addInitScript(({ locale, theme }) => {
      localStorage.setItem('ai-harness-locale', locale);
      localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme, filesOpen: false, sidebarVisible: true }));
    }, { locale, theme });
    await page.goto(`${prefix}/chat/${ids[0]}?cwd=${encodeURIComponent(cwd)}&token=MUST_NOT_PROPAGATE#old`);
    await expect(page.getByRole('log')).toContainText('NATIVE_OLD_PUBLIC_BODY');
    const input = page.locator('.input-container textarea'); await input.fill('NATIVE_UNSENT_DRAFT');
    await openNavigation(page);
    const link = page.locator('.sidebar-nav a.session-main').filter({ hasText: 'NATIVE_TARGET' });
    await expect(link).toHaveCount(1);
    const href = await link.getAttribute('href'); expect(href).toBeTruthy();
    const destination = new URL(href!, page.url());
    expect(destination.origin).toBe(new URL(page.url()).origin);
    expect(destination.pathname).toBe(`${prefix}/chat/${ids[1]}`);
    expect(destination.searchParams.get('cwd')).toBe(cwd);
    expect(destination.searchParams.has('token')).toBe(false); expect(destination.hash).toBe('');
    const original = page.url();
    const controlSize = await link.locator('..').locator('.session-actions button').first().evaluate(element => getComputedStyle(element).fontSize);
    expect(await link.evaluate(element => getComputedStyle(element).fontSize)).toBe(controlSize);
    // Real DOM observations after React, not a physical OS/macOS certification.
    await page.evaluate(() => {
      document.addEventListener('click', event => {
        if ((event.target as Element).closest('.session-main')) Reflect.set(window, '__nativeClick', event.defaultPrevented);
      });
      document.addEventListener('contextmenu', event => {
        if ((event.target as Element).closest('.session-main')) Reflect.set(window, '__nativeContextMenu', event.defaultPrevented);
      });
    });
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    if (activation === 'modified' || activation === 'middle' || activation === 'explicit') {
      const popupPromise = page.context().waitForEvent('page');
      if (activation === 'modified') await link.click({ modifiers: [modifier] });
      else if (activation === 'middle') await link.click({ button: 'middle' });
      else {
        await link.hover();
        await link.locator('..').getByRole('link', { name: /^(Open conversation in a new tab|Ouvrir la conversation dans un nouvel onglet)$/ }).click();
      }
      const popup = await popupPromise;
      try {
        await expect(popup).toHaveURL(destination.href);
        await expect(popup.getByRole('log')).toContainText('NATIVE_TARGET_PUBLIC_BODY');
        if (activation === 'explicit') expect(await popup.evaluate(() => window.opener === null)).toBe(true);
        await popup.reload(); await expect(popup).toHaveURL(destination.href);
        await expect(popup.getByRole('log')).toContainText('NATIVE_TARGET_PUBLIC_BODY');
        expect(page.url()).toBe(original); await expect(input).toHaveValue('NATIVE_UNSENT_DRAFT');
      } finally { await popup.close(); }
      if (activation === 'modified') {
        expect(await page.evaluate(() => Reflect.get(window, '__nativeClick'))).toBe(false);
        await link.click({ button: 'right' });
        expect(await page.evaluate(() => Reflect.get(window, '__nativeContextMenu'))).toBe(false);
        await page.keyboard.press('Escape'); expect(page.url()).toBe(original); await openNavigation(page);
      }
    } else if (activation === 'project') {
      const project = page.getByRole('link', { name: /^(Open project in a new tab|Ouvrir le projet dans un nouvel onglet)$/ });
      const popupPromise = page.context().waitForEvent('page'); await project.click(); const popup = await popupPromise;
      try {
        await expect.poll(() => new URL(popup.url()).searchParams.get('cwd')).toBe(cwd);
        expect(new URL(popup.url()).searchParams.has('token')).toBe(false);
        await expect(popup.locator('.workspace-button small')).toContainText(cwd);
        expect(await popup.evaluate(() => window.opener === null)).toBe(true);
        expect(page.url()).toBe(original); await expect(input).toHaveValue('NATIVE_UNSENT_DRAFT');
      } finally { await popup.close(); }
    } else if (activation === 'search') {
      await page.getByRole('searchbox', { name: /^(Search conversations|Rechercher dans les conversations)$/ }).fill('NATIVE_TARGET_PUBLIC_BODY');
      const searchLink = page.locator('.search-results .session-search-link'); await expect(searchLink).toHaveCount(1);
      const searchDestination = new URL((await searchLink.getAttribute('href'))!, page.url());
      expect(searchDestination.pathname).toBe(destination.pathname); expect(searchDestination.searchParams.get('cwd')).toBe(cwd);
      expect(searchDestination.searchParams.has('token')).toBe(false);
      expect(searchDestination.hash).toBe(`#${encodeURIComponent(messageIds[1]!)}`);
      const accessibility = await new AxeBuilder({ page }).include('.sidebar').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(accessibility.violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
      const popupPromise = page.context().waitForEvent('page'); await searchLink.click({ modifiers: [modifier] }); const popup = await popupPromise;
      try {
        await expect(popup).toHaveURL(searchDestination.href); await expect(popup.getByRole('log')).toContainText('NATIVE_TARGET_PUBLIC_BODY');
        await popup.reload(); await expect(popup).toHaveURL(searchDestination.href); await expect(popup.getByRole('log')).toContainText('NATIVE_TARGET_PUBLIC_BODY');
        expect(page.url()).toBe(original); await expect(input).toHaveValue('NATIVE_UNSENT_DRAFT');
      } finally { await popup.close(); }
    } else if (activation === 'plain') {
      await link.focus(); await page.keyboard.press('Enter');
      await expect(page).toHaveURL(destination.href); await expect(page.getByRole('log')).toContainText('NATIVE_TARGET_PUBLIC_BODY');
      await page.reload(); await expect(page).toHaveURL(destination.href); await expect(page.getByRole('log')).toContainText('NATIVE_TARGET_PUBLIC_BODY');
    } else {
      const missing = new URL(destination); missing.pathname = missing.pathname.replace(ids[1]!, `missing-${crypto.randomUUID()}`);
      await page.goto(missing.href); await expect(page.locator('.chat-empty[role="alert"]')).toBeVisible(); expect(page.url()).toBe(missing.href);
      await expect(page.getByRole('log')).toHaveCount(0); await expect(page.locator('.input-container textarea')).toHaveCount(0);
      await page.reload(); await expect(page.locator('.chat-empty[role="alert"]')).toBeVisible(); expect(page.url()).toBe(missing.href);
      await expect(page.getByRole('log')).toHaveCount(0); await expect(page.locator('.input-container textarea')).toHaveCount(0);
    }
    expect(quotaFailures).toEqual([]); expect(mutations).toEqual([]);
    expect(validationReads.length).toBeGreaterThan(0); expect(validationReads).toEqual(validationReads.map(() => JSON.stringify({ cwd })));
    if (relay) {
      expect(relay.quota).toEqual([]); expect(relay.errors).toEqual([]);
      expect(relay.writes.filter(write => write.method !== 'POST' || write.pathname !== '/api/workspaces/validate')).toEqual([]);
      expect(relay.writes.map(write => write.body)).toEqual(relay.writes.map(() => JSON.stringify({ cwd })));
    }
    for (const [index, id] of ids.entries()) {
      const snapshot = await page.request.get(`/api/sessions/${id}`);
      expect(snapshot.status()).toBe(200); expect(await snapshot.json()).toEqual(snapshots[index]);
    }
    const list = await page.request.get(`/api/sessions?cwd=${encodeURIComponent(cwd)}`); expect(list.status()).toBe(200);
    expect((await list.json() as Array<{ id: string }>).map(session => session.id).sort()).toEqual([...ids].sort());
  } finally {
    relay?.stopRead();
    page.context().off('request', record); page.context().off('response', quota);
    for (const id of ids) await page.request.delete(`/api/sessions/${id}`);
    await rm(cwd, { recursive: true, force: true });
  }
}
for (const scenario of [
  { locale: 'en', theme: 'light', width: 1440 }, { locale: 'en', theme: 'dark', width: 390 },
  { locale: 'fr', theme: 'dark', width: 1440 }, { locale: 'fr', theme: 'light', width: 390 },
]) for (const activation of activations) test(`${scenario.locale}/${scenario.theme}/${scenario.width}/${activation}: actual native links conserve identity and history`, async ({ page }) => {
  await page.setViewportSize({ width: scenario.width, height: 1000 });
  await exercise(page, '', scenario.locale, scenario.theme, activation);
});

async function stopSubpathChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill();
  const deadline = setTimeout(() => child.kill('SIGKILL'), 2_000);
  try { await closed; } finally { clearTimeout(deadline); }
}
async function subpathServer(): Promise<{ prefix: string; stop(): Promise<void> }> {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'aih-native-vite-'));
  const launch = `import {createServer} from 'vite';
    const server=await createServer({root:'packages/web',configFile:'packages/web/vite.config.ts',
      base:'/navigation/',cacheDir:process.argv[1],server:{host:'127.0.0.1',port:0,strictPort:true}});
    await server.listen(); server.printUrls();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', launch, cacheDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stopping = false, output = '';
  const stop = async () => {
    stopping = true;
    try { await stopSubpathChild(child); } finally { await rm(cacheDir, { recursive: true, force: true }); }
  };
  try {
    const prefix = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Native subpath fixture did not listen.')), 15_000);
      const onData = (data: Buffer) => {
        output = (output + data.toString().replace(/\x1b\[[0-9;]*m/g, '')).slice(-8192);
        const url = /http:\/\/127\.0\.0\.1:\d+\/navigation\//u.exec(output)?.[0];
        if (url) { clearTimeout(timeout); resolve(url.slice(0, -1)); }
      };
      child.stdout!.on('data', onData); child.stderr!.on('data', onData);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timeout); if (!stopping) console.error('[native-link-fixture] Unexpected child exit.', { code, signal }, output);
        reject(new Error('Native subpath fixture exited before readiness.'));
      });
    });
    return { prefix, stop };
  } catch (error) { console.error('[native-link-fixture] Readiness failure; bounded child output.', output); await stop(); throw error; }
}
const prefixTest = test.extend<{ nativeRelay: NativeFrontendRelay }>({
  nativeRelay: async ({ baseURL }, use) => {
    const child = await subpathServer(); let relay: NativeFrontendRelay | undefined;
    try { relay = await nativeFrontendRelay(baseURL!, child.prefix); await use(relay); }
    finally { try { await relay?.close(); } finally { await child.stop(); } }
  },
  // New fixture transport only. Real browser origin stays localhost:3080; no
  // API/CSRF/Origin rewrite or page-route fulfilment. Native first documents go
  // through an actual HTTP proxy, including background tabs and WS tunnels.
  proxy: async ({ nativeRelay }, use) => { await use({ server: nativeRelay.url, bypass: '<-loopback>' }); },
});
for (const activation of activations) prefixTest(`real Vite /navigation/ base: ${activation} keeps exact native destination`, async ({ page, nativeRelay }) => {
  try {
    await exercise(page, '/navigation', 'en', 'light', activation, nativeRelay);
    expect(nativeRelay.evidence.filter(item => item.document && item.pathname.startsWith('/navigation/')).length).toBeGreaterThanOrEqual(2);
    expect(nativeRelay.evidence.some(item => item.pathname === '/navigation/src/index.tsx' && item.base === '/navigation/')).toBe(true);
  } catch (error) {
    console.error('[native-prefix-fixture] Bounded real HTTP evidence.', { activation, responses: nativeRelay.evidence.slice(-24), errors: nativeRelay.errors });
    throw error;
  }
});
