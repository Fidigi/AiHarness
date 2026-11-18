import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getSessionCacheWarmingStatus, MockProvider } from '../packages/core/dist/index.js';
import { getProxy, start, stop } from '../packages/server/dist/index.js';
import { createRuntimeServices } from '../packages/server/dist/runtime/services.js';
import { expect, test } from './fixtures/test-budget';

for (const [locale, theme, width] of [['en', 'light', 1280], ['fr', 'dark', 390]] as const) {
  test(`${locale}/${theme}: historical notices survive reload/branches and global hiding does not dispatch; virtual selection dispatches physically`, async ({ page }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-model-cache-web-')), cwd = path.join(root, 'work');
    const names = ['AI_HARNESS_AUTH_TOKEN', 'AI_HARNESS_ADMIN_TOKEN', 'AI_HARNESS_AGENT_DIR'] as const;
    const before = names.map(name => process.env[name]);
    process.env.AI_HARNESS_AUTH_TOKEN = 'cache-user'; process.env.AI_HARNESS_ADMIN_TOKEN = 'cache-admin';
    process.env.AI_HARNESS_AGENT_DIR = path.join(root, 'agent');
    let calls = 0, routes = 0;
    const cacheCalls: Array<number | undefined> = [];
    let finishCacheForeground: (() => void) | undefined;
    let services!: Awaited<ReturnType<typeof createRuntimeServices>>;
    await mkdir(cwd);
    try {
      const server = await start({ port: 0, host: '127.0.0.1', dataDir: path.join(root, 'data'), defaultCwd: cwd, allowedRoots: [cwd],
        webRoot: path.resolve('packages/web/dist'), enableMockProvider: true, runtimeServicesFactory: async (proxy, options) => {
          services = await createRuntimeServices(proxy, options);
          const physical = new MockProvider({ type: 'mock', model: 'physical-proof' });
          physical.streamChat = async (_messages, chunk, complete, _error, options) => {
            calls++; expect(options?.model).toBe('physical-proof'); expect(options?.thinking).toBe('off');
            await chunk('Physical browser response.');
            complete?.({ content: 'Physical browser response.', model: 'physical-proof', usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } });
          };
          proxy.setCustomProvider('physical-proof', physical);
          const cachePhysical = proxy.getAgentProvider('mock')!;
          cachePhysical.getPublishedModels = () => [{ id: 'mock-model', name: 'Disposable cache fixture', api: 'openai-completions',
            capabilities: { reasoning: false, imageInput: false, toolCalls: true }, promptCache: { short: 11 },
            pricing: { inputPerMillion: 1000, outputPerMillion: 10, cacheReadPerMillion: 0.01, cacheWritePerMillion: 1250 } }];
          cachePhysical.streamChat = async (_messages, chunk, complete, _error, options) => {
            cacheCalls.push(options?.maxTokens);
            if (options?.maxTokens === 1) {
              expect(options.maxRetries).toBe(0); await chunk('WARM_ONLY_DO_NOT_PUBLISH');
              complete?.({ content: 'WARM_ONLY_DO_NOT_PUBLISH', model: 'mock-model',
                usage: { promptTokens: 0, completionTokens: 1, cacheReadTokens: 1000, totalTokens: 1001 } });
            } else {
              await new Promise<void>(resolve => { finishCacheForeground = resolve; });
              await chunk('Foreground cache proof.');
              complete?.({ content: 'Foreground cache proof.', model: 'mock-model',
                usage: { promptTokens: 1000, completionTokens: 1, totalTokens: 1001 } });
            }
          };
          await services.extensionRegistry.load('browser-router', api => {
            api.registerVirtualModel({ provider: 'browser-router', id: 'auto', route() {
              routes++; return { provider: 'physical-proof', id: 'physical-proof', state: { private: 'PRIVATE_ROUTER_PROOF' } };
            } });
          });
          return services;
        } });
      const base = `http://127.0.0.1:${server.port}`;
      await page.request.post(`${base}/api/auth/login`, { data: { token: 'cache-admin' } });
      expect((await page.request.post(`${base}/api/workspaces/trust`, { data: { cwd, confirm: true } })).status()).toBe(200);
      const manager = services.sessionManager, session = await manager.create({ cwd, title: 'Historical cache proof' });
      await manager.addMessage(session.id, { role: 'assistant', content: 'Cached historical reply.', provider: 'anthropic', model: 'claude-sonnet-4-6',
        usage: { cacheReadTokens: 100_000, outputTokens: 1 } });
      const first = session.messages[0].id;
      await manager.recordProviderUsage(session.id, { provider: 'anthropic', model: 'claude-sonnet-4-6',
        usage: { cacheReadTokens: 100_000, outputTokens: 1, costUsd: 0.03 } }, session.activeLeafId!);
      await manager.addMessage(session.id, { role: 'assistant', content: 'Uncached historical reply.', provider: 'anthropic', model: 'claude-sonnet-4-6',
        usage: { inputTokens: 100_000, outputTokens: 1 } });
      const last = session.messages.at(-1)!.id;
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(({ locale, theme }) => {
        localStorage.setItem('ai-harness-locale', locale);
        localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme }));
      }, { locale, theme });
      const chat = `${base}/chat/${session.id}?cwd=${encodeURIComponent(cwd)}`;
      await page.goto(chat);
      await expect(page.locator('.cache-notice')).toHaveCount(2);
      await expect(page.locator('.cache-notice').first()).toHaveCSS('color', 'rgb(238, 242, 250)');
      await expect(page.locator('.cache-notice').first()).toContainText(locale === 'fr' ? 'Cache réchauffé' : 'Cache warmed');
      const isSessionStream = (response: { url(): string; status(): number }) => response.url().includes(`/api/agent/sessions/${session.id}/events?`) && response.status() === 200;
      const connected = page.waitForResponse(isSessionStream);
      await page.reload(); await connected; await expect(page.locator('.cache-notice')).toHaveCount(2);
      expect(calls).toBe(0); expect(routes).toBe(0);
      let stateReads = 0;
      page.on('request', request => { if (request.url().includes(`/api/agent/sessions/${session.id}/state`)) stateReads++; });
      for (const enabled of [false, true]) {
        const beforeReconnect = stateReads;
        await page.context().setOffline(true);
        // Offline emulation alone leaves an established SSE response open in Chromium.
        await page.evaluate(() => window.stop());
        await expect.poll(() => stateReads).toBeGreaterThan(beforeReconnect);
        await services.configurationStore.patch('global', { showCacheMissNotices: enabled });
        const reconnected = page.waitForResponse(isSessionStream);
        await page.context().setOffline(false);
        await reconnected;
        await expect(page.locator('.cache-notice')).toHaveCount(enabled ? 2 : 0);
      }
      expect(calls).toBe(0); expect(routes).toBe(0);
      await manager.navigateTree(session.id, first);
      await page.reload(); await expect(page.locator('.message.assistant')).toHaveCount(1); await expect(page.locator('.cache-notice')).toHaveCount(0);
      await manager.navigateTree(session.id, last);
      await page.reload(); await expect(page.locator('.cache-notice')).toHaveCount(2);
      await page.screenshot({ path: test.info().outputPath(`cache-history-${locale}-${theme}.png`), fullPage: true });
      await page.goto(`${base}/settings?cwd=${encodeURIComponent(cwd)}`);
      await page.locator('.cache-notice-settings summary').click();
      const checkbox = page.getByRole('checkbox', { name: locale === 'fr' ? 'Afficher les notices de cache (global)' : 'Show cache notices (global)' });
      await expect(checkbox).toBeChecked(); await checkbox.click(); await expect(checkbox).not.toBeChecked(); await expect(checkbox).toBeEnabled();
      await page.reload(); await page.locator('.cache-notice-settings summary').click(); await expect(checkbox).not.toBeChecked();
      await page.goto(chat); await expect(page.locator('.message.assistant')).toHaveCount(2); await expect(page.locator('.cache-notice')).toHaveCount(0);
      expect(calls).toBe(0); expect(routes).toBe(0);
      expect((await page.request.patch(`${base}/api/configuration/scope`, { data: { scope: 'global', values: {
        showCacheMissNotices: true, provider: 'browser-router', model: 'auto', toolPreset: 'chat-only',
      } } })).status()).toBe(200);
      await page.reload(); await expect(page.locator('.cache-notice')).toHaveCount(2);
      if (width < 600) await page.getByRole('button', { name: 'Afficher ou masquer la navigation', exact: true }).click();
      await page.getByRole('button', { name: locale === 'fr' ? 'Nouvelle conversation' : 'New chat', exact: true }).click();
      await page.getByRole('textbox', { name: locale === 'fr' ? 'Zone de rédaction' : 'Message composer' }).fill('Route this browser request');
      await page.getByRole('button', { name: locale === 'fr' ? 'Envoyer' : 'Send', exact: true }).click();
      await expect(page.locator('.message.assistant')).toContainText('Physical browser response.');
      expect(calls).toBe(1); expect(routes).toBe(1);
      await page.reload(); await expect(page.locator('.message.assistant')).toContainText('Physical browser response.');
      const id = new URL(page.url()).pathname.split('/').at(-1)!;
      const wire = await page.request.get(`${base}/api/sessions/${id}`).then(response => response.json());
      expect(wire.messages.at(-1)).toMatchObject({ provider: 'physical-proof', model: 'physical-proof', metadata: { selection: { provider: 'browser-router', id: 'auto' } } });
      expect(JSON.stringify(wire)).not.toContain('PRIVATE_ROUTER_PROOF');
      expect(calls).toBe(1); expect(routes).toBe(1);
      await services.extensionRegistry.unload('browser-router');
      await page.getByRole('textbox', { name: locale === 'fr' ? 'Zone de rédaction' : 'Message composer' }).fill('Continue without the router');
      await page.getByRole('button', { name: locale === 'fr' ? 'Envoyer' : 'Send', exact: true }).click();
      await expect(page.locator('.message.assistant')).toHaveCount(2);
      await expect(page.locator('.message.assistant').last()).toContainText('Physical browser response.');
      await page.reload(); await expect(page.locator('.message.assistant')).toHaveCount(2);
      const resumed = await page.request.get(`${base}/api/sessions/${id}`).then(response => response.json());
      expect(resumed.messages.at(-1)).toMatchObject({ provider: 'physical-proof', model: 'physical-proof',
        metadata: { selection: { provider: 'browser-router', id: 'auto' } } });
      expect(JSON.stringify(resumed)).not.toContain('PRIVATE_ROUTER_PROOF');
      expect(calls).toBe(2); expect(routes).toBe(1);

      // Real scheduler/host billing with disposable prices and an explicitly declared 11-second cache.
      expect((await page.request.patch(`${base}/api/configuration/scope`, { data: { scope: 'global', values: {
        provider: 'mock', model: 'mock-model', showCacheMissNotices: false,
      } } })).status()).toBe(200);
      const liveCache = await manager.create({ cwd, model: 'mock-model', title: 'Live warming proof' });
      await page.goto(`${base}/chat/${liveCache.id}?cwd=${encodeURIComponent(cwd)}`);
      await page.getByRole('textbox', { name: locale === 'fr' ? 'Zone de rédaction' : 'Message composer' }).fill('warm prefix '.repeat(400));
      await page.getByRole('button', { name: locale === 'fr' ? 'Envoyer' : 'Send', exact: true }).click();
      try {
        await expect.poll(async () => (await manager.getRawEntries(liveCache.id)).some(entry =>
          entry.type === 'custom' && entry.customType === 'provider.cache_warm')).toBe(true);
      } finally {
        await test.info().attach('live-cache-state', { contentType: 'application/json', body: JSON.stringify({
          cacheCalls, status: getSessionCacheWarmingStatus(manager, liveCache.id), model: liveCache.model,
          messages: liveCache.messages.map(({ role, provider, model }) => ({ role, provider, model })),
        }) });
      }
      expect(cacheCalls).toHaveLength(2); expect(cacheCalls[1]).toBe(1);
      await expect(page.locator('.cache-notice')).toHaveCount(0);
      finishCacheForeground?.();
      await services.agentRuntime.wait(services.agentRuntime.getSessionRun(liveCache.id)!.id);
      await expect(page.locator('.message.assistant')).toContainText('Foreground cache proof.');
      const paid = await page.request.get(`${base}/api/sessions/${liveCache.id}`).then(response => response.json());
      expect(paid.messages).toHaveLength(2); expect(paid.cacheNotices).toEqual([]);
      expect(JSON.stringify(paid)).not.toContain('WARM_ONLY_DO_NOT_PUBLISH');
      expect(getProxy().getUsage('mock')).toMatchObject({ requests: 2, cacheReadTokens: 1000 });
      // Adapter-owned prices apply to both the foreground turn and its cache warming.
      const foregroundCost = (1000 * 1000 + 10) / 1_000_000;
      const warmingCost = (1000 * 0.01 + 10) / 1_000_000;
      expect(getProxy().getUsage('mock')?.costUsd).toBeCloseTo(foregroundCost + warmingCost, 12);
      expect((await page.request.patch(`${base}/api/configuration/scope`, { data: { scope: 'global', values: {
        showCacheMissNotices: true,
      } } })).status()).toBe(200);
      await page.reload(); await expect(page.locator('.cache-notice')).toHaveCount(1);
      await expect(page.locator('.cache-notice')).toContainText(locale === 'fr' ? 'Cache réchauffé' : 'Cache warmed');
      // Native reader intent retires scroll restoration; a programmatic target scroll can race it.
      const history = page.locator('.messages-container');
      await history.hover();
      await page.mouse.wheel(0, await history.evaluate(element => element.scrollHeight));
      await expect.poll(() => history.evaluate(element => Math.abs(element.scrollHeight - element.scrollTop - element.clientHeight))).toBeLessThan(1);
      await expect(page.locator('.cache-notice')).toBeInViewport();
      await page.screenshot({ path: test.info().outputPath(`cache-live-${locale}-${theme}.png`), fullPage: true });
      expect(cacheCalls).toHaveLength(2); expect(calls).toBe(2);
    } finally {
      finishCacheForeground?.();
      await page.goto('about:blank').catch(() => undefined); await stop();
      names.forEach((name, index) => { if (before[index] === undefined) delete process.env[name]; else process.env[name] = before[index]; });
      await rm(root, { recursive: true, force: true });
    }
  });
}
