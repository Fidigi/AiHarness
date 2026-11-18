import { expect, test } from './fixtures/test-budget';
import { installMockApi, mockSession } from './fixtures/mock-api';
import type { Page, TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const cacheCredentialCanary = 'must-not-reach-session-storage';
const longMessages = Array.from({ length: 320 }, (_, index) => ({
  role: index % 2 ? 'assistant' as const : 'user' as const,
  content: `Performance message ${index + 1}: ${'bounded content '.repeat(8)}`,
}));

// Test-only instrumentation of the real renderer, not a product profiling mode.
async function profileBrowser(page: Page, info: TestInfo, messages: number, work: () => Promise<void>): Promise<void> {
  const commits: Array<{ path: string; time: number; duration: number }> = [];
  const attach = async (name: string, body: string | Buffer, contentType: string): Promise<void> => {
    const file = info.outputPath(name);
    await writeFile(file, body);
    await info.attach(name, { path: file, contentType });
  };
  await page.exposeBinding('__architectureCommit', (_source, commit: typeof commits[number]) => {
    if (commits.length < 2_000) commits.push(commit);
  });
  await page.addInitScript(() => {
    const renderers = new Map<number, unknown>();
    Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: {
      supportsFiber: true, renderers,
      inject(renderer: unknown) { const id = renderers.size + 1; renderers.set(id, renderer); return id; },
      onCommitFiberRoot(_id: number, root: { current: { actualDuration?: number } }) {
        // Never capture Fiber props, state, message content or credential material.
        void (window as unknown as { __architectureCommit(value: unknown): Promise<void> }).__architectureCommit({
          path: location.pathname, time: performance.now(), duration: root.current.actualDuration ?? 0,
        });
      },
      onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    } });
  });
  const client = await page.context().newCDPSession(page);
  await client.send('Performance.enable');
  await client.send('Profiler.enable');
  await client.send('Profiler.setSamplingInterval', { interval: 1_000 });
  await client.send('Profiler.start');
  // React user-timing details can contain props; record layout/script events only.
  await client.send('Tracing.start', { categories: 'devtools.timeline,v8', transferMode: 'ReturnAsStream' });
  let scenarioFailed = false, failed = false;
  try { await work(); }
  catch (error) { scenarioFailed = failed = true; throw error; }
  finally {
    try {
      const { profile } = await client.send('Profiler.stop');
      const { metrics } = await client.send('Performance.getMetrics');
      const completed = new Promise<{ stream?: string }>(resolve => client.once('Tracing.tracingComplete', resolve));
      await client.send('Tracing.end');
      const { stream } = await completed;
      if (!stream) throw new Error('Browser timeline stream missing.');
      const chunks: Buffer[] = []; let bytes = 0;
      try {
        while (true) {
          const part = await client.send('IO.read', { handle: stream, size: 65_536 });
          const chunk = Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8'); bytes += chunk.length;
          if (bytes > 16 * 1024 * 1024) throw new Error('Browser timeline exceeded its evidence limit.');
          chunks.push(chunk); if (part.eof) break;
        }
      } finally { await client.send('IO.close', { handle: stream }); }
      const timeline = Buffer.concat(chunks);
      expect(timeline.includes(Buffer.from(cacheCredentialCanary)), 'Timeline must not retain the fixture credential canary').toBe(false);
      expect(JSON.stringify(profile).includes(cacheCredentialCanary), 'CPU profile must not retain the fixture credential canary').toBe(false);
      await attach('browser-timeline.json', timeline, 'application/json');
      await attach('browser-cpu.cpuprofile', JSON.stringify(profile), 'application/json');
      await attach('react-render-metrics.json', JSON.stringify({
        scenario: info.title, messages, browser: page.context().browser()?.version(), viewport: page.viewportSize(), online: await page.evaluate(() => navigator.onLine),
        commits, metrics, mountedMessages: await page.locator('.message').count(), timelineBytes: bytes,
        limits: 'One instrumented owning-host scenario, not production latency or an optimization gain. Commit timings exclude props/state; CPU/trace instrumentation overhead is present in both comparisons.',
      }, null, 2), 'application/json');
      await attach('profile-ui.png', await page.screenshot(), 'image/png');
      if (!scenarioFailed) {
        expect(profile.samples?.length).toBeGreaterThan(0);
        expect(commits.some(commit => commit.duration > 0)).toBe(true);
        expect(JSON.parse(timeline.toString()).traceEvents.some((event: { name: string }) => event.name === 'Layout')).toBe(true);
      }
    } catch (error) {
      failed = true;
      if (!scenarioFailed) throw error;
      await info.attach('profile-cleanup-failed.txt', { body: 'Profiling also failed after the original scenario failure; retain the original failure.', contentType: 'text/plain' });
    } finally { await client.detach().catch(error => { if (!failed) throw error; }); }
  }
}

test.describe('Budgets et longues conversations', () => {
  test('virtualise une conversation longue et restaure sa vue bornée avant le réseau', async ({ page }, info) => {
    await profileBrowser(page, info, longMessages.length, async () => {
      const longSession = mockSession('long', 'Long session', longMessages);
      longSession.providerConfig = { type: 'mock', model: 'mock-model', apiKey: cacheCredentialCanary };
      await installMockApi(page, { sessions: [longSession] });
      await page.goto('/chat/long?cwd=%2Fworkspace#long-message-101');

      const target = page.locator('#long-message-101');
      await expect(target).toBeVisible();
      await expect(page.locator('.messages-container[data-virtualized="true"]')).toBeVisible();
      expect(await page.locator('.message').count()).toBeLessThan(45);
      expect(await page.locator('.virtual-message-list').evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(5_000);

      // Let the bounded per-tab cache flush, then make every session request slower than the assertion window.
      const cachedViews = () => page.evaluate(() => JSON.stringify(Object.fromEntries(
        Array.from({ length: sessionStorage.length }, (_, index) => {
          const key = sessionStorage.key(index) ?? '';
          return [key, sessionStorage.getItem(key) ?? ''];
        }),
      )));
      await expect.poll(cachedViews).toContain('long-message-101');
      expect(await cachedViews()).not.toContain(cacheCredentialCanary);
      await page.route('**/api/sessions**', async route => {
        await new Promise(resolve => setTimeout(resolve, 4_000));
        await route.fallback();
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('#long-message-101')).toBeVisible({ timeout: 2_500 });
      expect(await page.locator('.message').count()).toBeLessThan(45);
    });
  });

  test('ne charge le lourd client terminal qu’à sa première ouverture', async ({ page }, info) => {
    await profileBrowser(page, info, 0, async () => {
      const requested: string[] = [];
      page.on('request', request => requested.push(request.url()));
      await installMockApi(page, { sessions: [mockSession('empty', 'Empty')] });
      await page.goto('/chat/empty');
      await expect(page.getByPlaceholder(/Type your message/)).toBeVisible();
      await page.waitForTimeout(150);
      expect(requested.some(url => url.includes('TerminalPanel') || url.includes('@xterm'))).toBe(false);

      await page.getByRole('button', { name: 'Open workspace terminal' }).click();
      await expect(page.getByRole('region', { name: 'Terminal' })).toBeVisible();
      expect(requested.some(url => url.includes('TerminalPanel') || url.includes('@xterm'))).toBe(true);
    });
  });
});
