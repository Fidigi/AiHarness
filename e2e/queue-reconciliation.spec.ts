import { expect, test, type Page, type Route } from '@playwright/test';
import type { AgentRunSnapshot } from '@ai-harness/core';
import { installMockApi, mockSession } from './fixtures/mock-api';

const sessionId = 'poll-queue';
const run = (id: string, sequence: number, phase: AgentRunSnapshot['phase'] = 'tool'): AgentRunSnapshot => ({
  id, sessionId, cwd: '/workspace', provider: 'mock', phase, lastSequence: sequence,
  steerQueue: [], followUpQueue: [], extensionRequests: ['head', 'waiting'].map(suffix => ({
    id: `${id}-${suffix}`, kind: 'input', title: `${id} ${suffix}`, createdAt: '2026-01-01T00:00:00Z',
  })),
});
// These actions are the real production store used by App and ChatView, loaded by Vite.
// No replacement App/ChatView or duplicated test store is installed.
async function admit(page: Page, snapshot?: AgentRunSnapshot) {
  await page.evaluate(async ({ sessionId, snapshot }) => {
    const modulePath = '/src/store/session-store.ts';
    const { useSessionStore } = await import(modulePath);
    useSessionStore.getState().setRun(sessionId, snapshot);
  }, { sessionId, snapshot });
}
async function stored(page: Page) {
  return page.evaluate(async sessionId => {
    const modulePath = '/src/store/session-store.ts';
    const { useSessionStore } = await import(modulePath);
    return useSessionStore.getState().runs[sessionId] as AgentRunSnapshot | undefined;
  }, sessionId);
}
async function fixture(page: Page) {
  await page.addInitScript(() => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, sidebarVisible: false, filesOpen: false })));
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const session = mockSession(sessionId, 'App polling queue');
  await installMockApi(page, { sessions: [session, mockSession('other-session', 'Other session')], holdAgentRun: true });
  let current: AgentRunSnapshot | undefined = run('old', 10);
  let sequence = 10;
  let stream: Route | undefined;
  let heldList: Route | undefined;
  let heldGet: Route | undefined;
  let holdList = false; let holdGet = false; let empty = false;
  const json = (route: Route, data: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  await page.route('**/api/agent/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/agent/runs' && route.request().method() === 'POST') {
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({
        session, run: current, workspace: { id: 'workspace-e2e', cwd: '/workspace', name: 'workspace', trusted: true },
      }) });
    } else if (url.pathname === '/api/agent/running') {
      if (holdList) heldList = route;
      else await json(route, empty || !current ? [] : [current]);
    } else if (url.pathname === `/api/agent/sessions/${sessionId}/state`) {
      await json(route, { session, sessionId, lastSequence: sequence, run: current });
    } else if (url.pathname.endsWith('/events')) {
      if (url.pathname.includes(sessionId)) stream = route;
      // Hold the SSE connection: regressions below exercise App's independent polling.
    } else if (/\/api\/agent\/runs\/[^/]+$/.test(url.pathname)) {
      if (holdGet) heldGet = route;
      else await json(route, current);
    } else await route.fallback();
  });
  await page.goto(`/chat/${sessionId}?cwd=%2Fworkspace`);
  await expect(page.getByRole('dialog')).toHaveAccessibleName('old head');
  const refresh = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  return { json, refresh,
    async delayList() { holdList = true; heldList = undefined; await refresh(); await expect.poll(() => Boolean(heldList)).toBe(true); return heldList!; },
    async delayGet() { empty = true; holdGet = true; heldGet = undefined; await refresh(); await expect.poll(() => Boolean(heldGet)).toBe(true); return heldGet!; },
    current(next: AgentRunSnapshot) { current = next; sequence = next.lastSequence; },
    async missingSnapshot(lastSequence: number) {
      current = undefined; sequence = lastSequence;
      await expect.poll(() => Boolean(stream)).toBe(true);
      await stream!.fulfill({ contentType: 'text/event-stream', body: `event: connection.ready\ndata: ${JSON.stringify({ reset: true, snapshot: { sessionId, lastSequence } })}\n\n` });
    },
  };
}

for (const delayed of ['list', 'get'] as const) {
  test(`actual App delayed ${delayed} cannot overwrite newly admitted different-run queue`, async ({ page }, testInfo) => {
    const api = await fixture(page);
    const held = delayed === 'list' ? await api.delayList() : await api.delayGet();
    const next = run('new', 20); api.current(next); await admit(page, next);
    await expect(page.getByRole('dialog')).toHaveAccessibleName('new head');
    await expect(page.getByRole('dialog').getByRole('status')).toHaveText('1 waiting');
    await page.getByRole('dialog').getByRole('textbox').fill('new draft');
    await api.json(held, delayed === 'list' ? [run('old', 10)] : run('old', 30, 'completed'));
    await expect.poll(async () => (await stored(page))?.id).toBe('new');
    await expect(page.getByRole('dialog')).toHaveAccessibleName('new head');
    await expect(page.getByRole('dialog').getByRole('textbox')).toHaveValue('new draft');
    if (delayed === 'list') await page.screenshot({ path: testInfo.outputPath('actual-app-new-queue-after-late-list.png') });
  });
}

test('actual App stale list after a missing-run clear cannot resurrect either queue after reconnect', async ({ page }) => {
  const api = await fixture(page);
  const held = await api.delayList();
  await admit(page, run('new', 20));
  await admit(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await api.json(held, [run('old', 10)]);
  expect(await stored(page)).toBeUndefined();
  await admit(page, run('new', 30));
  expect(await stored(page)).toBeUndefined();
  await admit(page, run('reconnected', 40));
  await expect(page.getByRole('dialog')).toHaveAccessibleName('reconnected head');
});

test('actual App empty poll never treats newly admitted work as absent; fresh terminal/empty is authoritative', async ({ page }) => {
  const api = await fixture(page);
  const held = await api.delayList();
  const next = run('new', 20); api.current(next); await admit(page, next);
  const gets: string[] = [];
  page.on('request', request => { if (/\/api\/agent\/runs\/[^/]+$/.test(new URL(request.url()).pathname)) gets.push(new URL(request.url()).pathname); });
  await api.json(held, []);
  await expect(page.getByRole('dialog')).toHaveAccessibleName('new head');
  await expect.poll(() => gets).toEqual(['/api/agent/runs/old']); // Never reconcile newly admitted work against an old empty list.
  await admit(page, { ...next, lastSequence: 21, extensionRequests: [] });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await admit(page, run('new', 22, 'completed'));
  expect((await stored(page))?.extensionRequests).toEqual([]);
  await admit(page, run('new', 23));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await admit(page, run('next', 24));
  await expect(page.getByRole('dialog')).toHaveAccessibleName('next head');
});

test('real connection.ready missing-run clear blocks a delayed App list, including after session navigation back', async ({ page }) => {
  const api = await fixture(page);
  const held = await api.delayList();
  await api.missingSnapshot(21);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await stored(page)).toBeUndefined();
  await api.json(held, [run('old', 10)]);
  expect(await stored(page)).toBeUndefined();
  await page.evaluate(() => { history.pushState(null, '', '/chat/other-session?cwd=%2Fworkspace'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => { history.pushState(null, '', '/chat/poll-queue?cwd=%2Fworkspace'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await stored(page)).toBeUndefined();
});

test('real composer POST admission keeps its new queue against an older App running-list reply', async ({ page }) => {
  const api = await fixture(page);
  const held = await api.delayList();
  await admit(page, run('old', 20, 'completed'));
  const next = run('posted', 30); api.current(next);
  const posted = page.waitForRequest(request => new URL(request.url()).pathname === '/api/agent/runs' && request.method() === 'POST');
  const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
  await composer.fill('A genuinely submitted new run');
  await composer.press('Enter');
  await posted;
  await expect(page.getByRole('dialog')).toHaveAccessibleName('posted head');
  await api.json(held, [run('old', 10)]);
  await expect.poll(async () => (await stored(page))?.id).toBe('posted');
  await expect(page.getByRole('dialog')).toHaveAccessibleName('posted head');
  await expect(page.getByRole('dialog').getByRole('status')).toHaveText('1 waiting');
});

for (const destination of ['session', 'workspace'] as const) {
  test(`actual App delayed list is inert across ${destination} navigation and delete/reset`, async ({ page }) => {
    const api = await fixture(page);
    const held = await api.delayList();
    if (destination === 'session') {
      await page.evaluate(() => { history.pushState(null, '', '/chat/other-session?cwd=%2Fworkspace'); window.dispatchEvent(new PopStateEvent('popstate')); });
      await expect(page.getByRole('dialog')).toHaveCount(0);
    } else {
      await page.evaluate(async () => {
        const modulePath = '/src/store/session-store.ts';
        const { useSessionStore } = await import(modulePath);
        await useSessionStore.getState().setWorkspace({ id: 'other-workspace', cwd: '/other-workspace', name: 'Other', trusted: true });
      });
    }
    await page.evaluate(async sessionId => {
      const modulePath = '/src/store/session-store.ts';
      const { useSessionStore } = await import(modulePath);
      useSessionStore.getState().removeSession(sessionId);
    }, sessionId);
    await api.json(held, [run('old', 50)]);
    expect(await stored(page)).toBeUndefined();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
}

// Exact-review append-only causal regression: a fresh missing-run projection
// must keep its session watermark in the shared store, not only Chat's ref.
test('exact queue: fresh absence watermark rejects later App discovery of an unseen retired-era run', async ({ page }, testInfo) => {
  const api = await fixture(page);
  await page.clock.runFor(100); // settle initial effect/reconnect; no App poll interval elapsed
  await api.missingSnapshot(21);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await stored(page)).toBeUndefined();
  const held = await api.delayList(); // captures AFTER authoritative absence
  await api.json(held, [run('unseen-before-absence', 15)]);
  const evidence = await page.evaluate(async sessionId => {
    const modulePath = '/src/store/session-store.ts';
    const { useSessionStore } = await import(modulePath);
    return { authority: useSessionStore.getState().runAuthorities[sessionId], run: useSessionStore.getState().runs[sessionId] };
  }, sessionId);
  await testInfo.attach('post-absence-discovery.json', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  expect(evidence.authority.sequence).toBe(21);
  expect(await stored(page)).toBeUndefined();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const fresh = run('genuinely-after-absence', 22); api.current(fresh);
  const next = await api.delayList();
  await api.json(next, [fresh]);
  await expect(page.getByRole('dialog')).toHaveAccessibleName('genuinely-after-absence head');
});
