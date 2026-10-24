import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { start, stop } from '../packages/server/dist/index.js';
import { AiProxyServer } from '../packages/server/dist/api/proxy.js';
import { expect, test } from './fixtures/test-budget';

for (const mobile of [false, true]) for (const theme of ['light', 'dark'] as const) {
  test(`durable sidebar families and projects, ${mobile ? 'mobile' : 'desktop'} ${theme}`, async ({ page, browser }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-sidebar-web-')), cwd = path.join(root, 'work'), dataDir = path.join(root, 'data');
    await mkdir(cwd); await mkdir(path.join(root, 'second'));
    const names = ['AI_HARNESS_AUTH_TOKEN', 'AI_HARNESS_ADMIN_TOKEN', 'AI_HARNESS_AGENT_DIR'] as const;
    const previous = names.map(name => process.env[name]);
    process.env.AI_HARNESS_AUTH_TOKEN = 'sidebar-web-user'; process.env.AI_HARNESS_ADMIN_TOKEN = 'sidebar-web-admin'; process.env.AI_HARNESS_AGENT_DIR = path.join(root, 'agent');
    const peer = await browser.newContext();
    try {
      const proxy = new AiProxyServer({ enableMockProvider: true });
      const provider = proxy.getAgentProvider('mock')!, original = provider.streamChat.bind(provider);
      provider.streamChat = async (...args) => {
        if (!args[0].some(message => message.content === 'Hold sidebar run')) return original(...args);
        const signal = args[4]?.signal;
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) reject(new Error('Stopped sidebar fixture'));
          else signal?.addEventListener('abort', () => reject(new Error('Stopped sidebar fixture')), { once: true });
        });
      };
      const server = await start({ port: 0, host: '127.0.0.1', dataDir, defaultCwd: cwd, allowedRoots: [root], webRoot: path.resolve('packages/web/dist'), proxy });
      const base = `http://127.0.0.1:${server.port}`;
      expect((await page.request.post(`${base}/api/auth/login`, { data: { token: 'sidebar-web-user' } })).status()).toBe(200);
      expect((await peer.request.post(`${base}/api/auth/login`, { data: { token: 'sidebar-web-user' } })).status()).toBe(200);
      const create = async (route: string, body: unknown) => {
        const response = await page.request.post(`${base}/api/sessions${route}`, { data: body }); expect(response.status()).toBe(201); return response.json();
      };
      const source = await create('', { cwd, title: 'Root conversation' });
      await create(`/${source.id}/fork`, { title: 'Related fork' });
      const clone = await create(`/${source.id}/clone`, { title: 'Independent clone' });
      const journals = await Promise.all((await readdir(path.join(dataDir, 'sessions'))).filter(file => file.endsWith('.jsonl'))
        .map(async file => [file, await readFile(path.join(dataDir, 'sessions', file), 'utf8')] as const));
      await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 });
      await page.addInitScript(({ theme, now }) => {
        localStorage.setItem('ai-harness-locale', 'en');
        localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ theme }));
        Date.now = () => now;
      }, { theme, now: Date.parse(clone.updatedAt) });
      await page.goto(`${base}/chat/${clone.id}?cwd=${encodeURIComponent(cwd)}`);
      const sidebar = page.locator('.sidebar');
      const open = async () => { if (mobile) await page.getByRole('button', { name: 'Toggle navigation', exact: true }).click(); };
      await open();
      await sidebar.getByText('Organise navigation', { exact: true }).click();
      const refresh = sidebar.getByRole('button', { name: 'Refresh organisation', exact: true });
      await expect(sidebar.getByRole('link', { name: /Root conversation/ }).first()).toBeVisible();
      await sidebar.getByLabel('Select families', { exact: true }).check();
      const rootSelector = sidebar.getByLabel('Select family: Root conversation', { exact: true });
      await rootSelector.check();
      await expect(sidebar.getByLabel('Select family: Related fork', { exact: true })).toBeChecked();
      const pin = sidebar.getByRole('button', { name: 'Pin', exact: true });
      await expect(pin).toBeEnabled();
      // Native keyboard activation, including on the narrow modal sidebar.
      await pin.focus(); await page.keyboard.press('Enter');
      await expect(sidebar.getByLabel('Pinned', { exact: true })).toHaveCount(2);
      await rootSelector.check(); await sidebar.getByRole('button', { name: 'Archive', exact: true }).click();
      await expect(sidebar.locator('.sidebar-nav li')).toHaveCount(1);
      await sidebar.getByRole('button', { name: 'Undo organisation', exact: true }).click();
      await expect(sidebar.locator('.sidebar-nav li')).toHaveCount(3);
      // A separate authenticated browser changes state without touching this tab's memory.
      const canonical = await (await peer.request.get(`${base}/api/sessions/ui-state`)).json();
      expect((await peer.request.post(`${base}/api/sessions/ui-state`, { data: { revision: canonical.revision,
        change: { kind: 'project', cwd, name: 'Shared project' } } })).status()).toBe(200);
      const afterName = await (await peer.request.get(`${base}/api/sessions/ui-state`)).json();
      expect((await peer.request.post(`${base}/api/sessions/ui-state`, { data: { revision: afterName.revision,
        change: { kind: 'project', cwd: path.join(root, 'second'), name: 'Other workspace' } } })).status()).toBe(200);
      await rootSelector.check(); await sidebar.getByRole('button', { name: 'Unpin', exact: true }).click();
      await expect(sidebar.getByRole('alert')).toContainText('Organisation changed');
      await expect(sidebar.locator('.workspace-button')).toContainText('Shared project');
      await refresh.click();
      await rootSelector.check(); await sidebar.getByRole('button', { name: 'Archive', exact: true }).click();
      await expect(sidebar.locator('.sidebar-nav li')).toHaveCount(1);
      await sidebar.getByLabel('Include archived', { exact: true }).check();
      await expect(sidebar.getByLabel('Archived', { exact: true })).toHaveCount(2);
      await sidebar.getByText('Organise projects', { exact: true }).click();
      await sidebar.getByRole('button', { name: 'Project display name: Shared project', exact: true }).click();
      await sidebar.getByRole('textbox', { name: 'Project display name', exact: true }).fill('Team workspace');
      await sidebar.getByRole('button', { name: 'Save display name', exact: true }).click();
      await expect(sidebar.locator('.workspace-button')).toContainText('Team workspace');
      await sidebar.getByRole('button', { name: 'Move project down: Team workspace', exact: true }).click();
      await expect(sidebar.locator('.sidebar-projects li').first()).toContainText('Other workspace');
      const second = await peer.newPage();
      await second.goto(`${base}/?cwd=${encodeURIComponent(cwd)}`);
      await expect(second.locator('.workspace-button')).toContainText('Team workspace');
      expect((await (await peer.request.get(`${base}/api/sessions/ui-state`)).json()).families).toEqual([{ id: source.id, pinned: true, archived: true }]);
      for (const [file, bytes] of journals) expect(await readFile(path.join(dataDir, 'sessions', file), 'utf8')).toBe(bytes);
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await expect(sidebar).toHaveScreenshot(`sidebar-${mobile ? 'mobile' : 'desktop'}-${theme}.png`, { maxDiffPixelRatio: 0.02,
        mask: [sidebar.locator('.workspace-button small')] });
      // Native session anchor navigation preserves archives and closes the mobile modal.
      await sidebar.locator('.sidebar-nav').getByRole('link', { name: /Root conversation/ }).first().click();
      await expect(page).toHaveURL(new RegExp(`/chat/${source.id}`));
      if (mobile) await expect(page.getByRole('button', { name: 'Toggle navigation', exact: true })).toHaveAttribute('aria-expanded', 'false');
      await page.reload(); await open();
      await expect(sidebar.locator('.workspace-button')).toContainText('Team workspace');
      await expect(sidebar.locator('.sidebar-nav').getByRole('link', { name: /Root conversation/ }).first()).toBeVisible();
      if (mobile) { await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: 'Toggle navigation', exact: true })).toHaveAttribute('aria-expanded', 'false'); }
      if (mobile && theme === 'light') {
        await open();
        await sidebar.getByText('Organise navigation', { exact: true }).click();
        await sidebar.getByLabel('Select families', { exact: true }).check();
        await rootSelector.check();
        let release!: () => void, committed!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const saved = new Promise<void>(resolve => { committed = resolve; });
        let first = true;
        await page.route('**/api/sessions/ui-state', async route => {
          if (route.request().method() !== 'POST' || !first) { await route.continue(); return; }
          first = false;
          const response = await route.fetch(); expect(response.status()).toBe(200); committed();
          await held; await route.fulfill({ response }).catch(() => undefined);
        });
        try {
          await sidebar.getByRole('button', { name: 'Unpin', exact: true }).click(); await saved;
          await page.keyboard.press('Escape'); await open();
          await expect(sidebar.getByLabel('Pinned', { exact: true })).toHaveCount(0);
          await rootSelector.check(); await expect(pin).toBeEnabled();
          await pin.click(); await expect(sidebar.getByLabel('Pinned', { exact: true })).toHaveCount(2);
          release(); await page.unroute('**/api/sessions/ui-state');
          await expect(sidebar.getByRole('alert')).toHaveCount(0);
        } finally { release(); }
      }
      if (!mobile && theme === 'light') {
        await sidebar.getByText('Organise navigation', { exact: true }).click();
        await sidebar.getByLabel('Select families', { exact: true }).check();
        await sidebar.getByLabel('Select family: Root conversation', { exact: true }).check();
        let writes = 0;
        await page.route('**/api/sessions/ui-state', async route => {
          if (route.request().method() !== 'POST') { await route.continue(); return; }
          writes++;
          expect((await route.fetch()).status()).toBe(200); // Server commits; only the reply is lost.
          await route.abort('failed');
        });
        await sidebar.getByRole('button', { name: 'Unpin', exact: true }).click();
        await expect(sidebar.getByRole('alert')).toContainText('Organisation unavailable');
        expect(writes).toBe(1);
        await expect(sidebar.getByLabel('Pinned', { exact: true })).toHaveCount(0);
        await page.unroute('**/api/sessions/ui-state');
        await refresh.click(); await expect(sidebar.getByRole('alert')).toHaveCount(0);
        await page.route('**/api/sessions/ui-state', route => route.fulfill({ status: 503, json: { code: 'sidebar-state-unavailable' } }));
        await refresh.click(); await expect(sidebar.getByRole('alert')).toContainText('Organisation unavailable');
        await sidebar.getByLabel('Select family: Root conversation', { exact: true }).check();
        await expect(pin).toBeDisabled();
        await page.unroute('**/api/sessions/ui-state');
        await refresh.click(); await expect(pin).toBeEnabled();
      }
      if (!mobile && theme === 'dark') {
        // Genuine detached run: an archived, unselected family must reappear without Stop/delete.
        const adminHeaders = { Authorization: 'Bearer sidebar-web-admin' };
        expect((await peer.request.post(`${base}/api/workspaces/trust`, { headers: adminHeaders, data: { cwd, confirm: true } })).status()).toBe(200);
        const started = await peer.request.post(`${base}/api/agent/runs`, { data: { sessionId: source.id, cwd, provider: 'mock', input: 'Hold sidebar run', toolPreset: 'chat-only' } });
        expect(started.status()).toBe(202); const { run } = await started.json();
        await page.goto(`${base}/chat/${clone.id}?cwd=${encodeURIComponent(cwd)}`);
        await expect(sidebar.locator('.sidebar-nav').getByRole('link', { name: /Root conversation/ }).first()).toBeVisible();
        const running = await peer.request.get(`${base}/api/agent/runs/${run.id}`);
        expect(running.status()).toBe(200);
        expect(['completed', 'failed', 'stopped']).not.toContain((await running.json()).phase);
        expect((await peer.request.post(`${base}/api/agent/runs/${run.id}/stop`)).status()).toBe(202);
      }
    } finally {
      await page.goto('about:blank').catch(() => undefined); await peer.close(); await stop();
      names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
      await rm(root, { recursive: true, force: true });
    }
  });
}
