import { expect, test, type Page, type Route } from './fixtures/test-budget';
import type { AgentRunSnapshot, ExtensionInteractionSnapshot } from '@ai-harness/core';
import { installMockApi, mockSession } from './fixtures/mock-api';

const sessionId = 'interaction-assets';
const request = (id: string): ExtensionInteractionSnapshot => ({ id, kind: 'input', title: `Request ${id}`,
  message: 'Plain-text approval', createdAt: '2026-01-01T00:00:00Z' });
async function product(page: Page, heads: string[] = []) {
  await page.addInitScript(() => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({
    version: 4, theme: 'light', sidebarVisible: false, filesOpen: false, sound: false,
  })));
  const session = mockSession(sessionId, 'Lazy interaction assets');
  await installMockApi(page, { sessions: [session, mockSession('other', 'Other session')], holdAgentRun: true });
  let run: AgentRunSnapshot = { id: 'asset-run', sessionId, cwd: '/workspace', phase: 'tool', provider: 'mock',
    lastSequence: 1, steerQueue: [], followUpQueue: [], extensionRequests: heads.map(request) };
  let stream: Route | undefined;
  const replies: unknown[] = [];
  const json = (route: Route, data: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  await page.route('**/api/agent/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/api/agent/sessions/${sessionId}/state`) await json(route, { sessionId, session, lastSequence: run.lastSequence, run });
    else if (path === `/api/agent/sessions/${sessionId}/events`) stream = route;
    else if (path.includes(`/sessions/${sessionId}/interactions/`)) {
      replies.push(route.request().postDataJSON());
      run = { ...run, lastSequence: run.lastSequence + 1, extensionRequests: run.extensionRequests?.slice(1) };
      await json(route, run);
    } else if (path === '/api/agent/runs/asset-run/stop') {
      run = { ...run, lastSequence: run.lastSequence + 1, phase: 'stopped', extensionRequests: [] };
      await json(route, run);
    } else if (path === '/api/agent/runs') await json(route, [run]);
    else if (path === '/api/agent/runs/asset-run') await json(route, run);
    else await route.fallback();
  });
  return { replies, async update(heads: string[], phase: AgentRunSnapshot['phase'] = 'tool') {
    await expect.poll(() => Boolean(stream)).toBe(true);
    run = { ...run, phase, lastSequence: run.lastSequence + 1, extensionRequests: heads.map(request) };
    const route = stream!; stream = undefined;
    await route.fulfill({ contentType: 'text/event-stream', body: `event: connection.ready\ndata: ${JSON.stringify({
      snapshot: { sessionId, lastSequence: run.lastSequence, run }, reset: true,
    })}\n\n` });
  } };
}
const url = `/chat/${sessionId}?cwd=%2Fworkspace`;
const js = /\/assets\/ExtensionInteractionDialog-[^/]+\.js$/;
const css = /\/assets\/ExtensionInteractionDialog-[^/]+\.css$/;

test('production JS/CSS stay absent without a head, load once on demand and keep the form across heads', async ({ page }) => {
  const api = await product(page);
  const assets: string[] = [];
  page.on('request', req => { if (js.test(req.url()) || css.test(req.url())) assets.push(req.url()); });
  await page.goto(url);
  await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).toBeVisible();
  expect(assets).toEqual([]);
  await api.update(['a', 'b']);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName('Request a');
  await expect(dialog).toHaveCSS('display', 'grid');
  expect(assets.filter(asset => js.test(asset))).toHaveLength(1);
  expect(assets.filter(asset => css.test(asset))).toHaveLength(1);
  await dialog.evaluate(el => el.setAttribute('data-identity', 'stable'));
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveAccessibleName('Request b');
  await expect(dialog).toHaveAttribute('data-identity', 'stable');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await api.update(['c']);
  await expect(dialog).toHaveAccessibleName('Request c');
  expect(assets.filter(asset => js.test(asset))).toHaveLength(1);
});

test('delayed production chunk keeps waiting/cancel/Stop usable and mounts the latest head only', async ({ page }) => {
  let held: Route | undefined;
  await page.route(js, route => { held = route; });
  const api = await product(page, ['a', 'b']);
  await page.goto(url);
  const waiting = page.getByRole('region', { name: 'Request a', exact: true });
  await expect(waiting).toBeVisible();
  await expect(waiting).toContainText('1 waiting');
  await expect(waiting.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
  await expect(page.locator('.stop-button')).toBeEnabled();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await waiting.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Request b', exact: true })).toBeVisible();
  await expect.poll(() => Boolean(held)).toBe(true);
  await held!.continue();
  await expect(page.getByRole('dialog')).toHaveAccessibleName('Request b');
  await expect(page.getByRole('dialog').getByRole('textbox')).toBeFocused();
  expect(api.replies).toEqual([{ cancelled: true }]);
});

for (const [kind, asset] of [['JS', js], ['CSS', css]] as const) {
 test(`failed production ${kind} presents bounded error with working cancellation`, async ({ page }) => {
  await page.route(asset, route => route.abort('failed'));
  const api = await product(page, ['a']);
  await page.goto(url);
  const waiting = page.getByRole('region', { name: 'Request a', exact: true });
  await expect(waiting.getByRole('status')).toHaveText('The extension interaction could not be completed.');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await waiting.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(waiting).toHaveCount(0);
  expect(api.replies).toEqual([{ cancelled: true }]);
 });
}

for (const end of ['stop', 'terminal', 'navigation'] as const) {
  test(`late production chunk after ${end} cannot reopen or steal focus`, async ({ page }) => {
    let held: Route | undefined;
    await page.route(js, route => { held = route; });
    const api = await product(page, ['a']);
    await page.goto(url);
    await expect(page.getByRole('region', { name: 'Request a', exact: true })).toBeVisible();
    await expect.poll(() => Boolean(held)).toBe(true);
    if (end === 'stop') await page.locator('.stop-button').click();
    else if (end === 'terminal') await api.update([], 'completed');
    else await page.evaluate(() => { history.pushState(null, '', '/chat/other?cwd=%2Fworkspace'); window.dispatchEvent(new PopStateEvent('popstate')); });
    await expect(page.getByRole('region', { name: 'Request a', exact: true })).toHaveCount(0);
    const composer = page.getByRole('textbox', { name: 'Message composer', exact: true });
    await composer.focus();
    const loaded = page.waitForResponse(response => js.test(response.url()));
    await held!.continue();
    await loaded;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(composer).toBeFocused();
  });
}
