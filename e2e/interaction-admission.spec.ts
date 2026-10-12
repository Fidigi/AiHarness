import { expect, test, type Page, type Route } from './fixtures/test-budget';
import type { AgentRunSnapshot, AgentStateSnapshot } from '@ai-harness/core';
import { installMockApi, mockSession } from './fixtures/mock-api';

// Real App/Chat/store/API code, controlled HTTP/SSE only. No replacement store,
// declaration/source hook or backend Stop execution claim.
async function fixture(page: Page, id: string, withHead = false, initiallyEmpty = false) {
  await page.addInitScript(() => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, sidebarVisible: false, filesOpen: false, sound: false })));
  const session = mockSession(id, 'Admission lifetime');
  await installMockApi(page, { sessions: [session, mockSession('away', 'Away')], holdAgentRun: true });
  const initial: AgentRunSnapshot = { id: 'owned-run', sessionId: id, cwd: '/workspace', provider: 'mock', phase: 'tool', lastSequence: initiallyEmpty ? 0 : 1,
    steerQueue: [], followUpQueue: [], extensionRequests: withHead ? [{ id: 'owned-head', kind: 'input', title: 'Owned approval', createdAt: '2026-01-01' }] : [] };
  let current: AgentRunSnapshot | undefined = initiallyEmpty ? undefined : initial;
  let sequence = initial.lastSequence;
  let stream: Route | undefined;
  let heldStop: Route | undefined;
  let heldReply: Route | undefined;
  let heldList: Route | undefined;
  let holdLists = false;
  let blockReadbacks = false;
  const readbacks: Route[] = [];
  const snapshot = (): AgentStateSnapshot => structuredClone({ sessionId: id, lastSequence: sequence, run: current });
  const json = (route: Route, data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  await page.route('**/api/agent/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/agent/running') {
      if (holdLists) heldList = route;
      else if (blockReadbacks) readbacks.push(route);
      else await json(route, current ? [current] : []);
    } else if (path === `/api/agent/sessions/${encodeURIComponent(id)}/state`) {
      if (blockReadbacks) readbacks.push(route); else await json(route, { ...snapshot(), session });
    } else if (path === `/api/agent/sessions/${encodeURIComponent(id)}/events`) stream = route;
    else if (path === '/api/agent/runs/owned-run/stop') heldStop = route;
    else if (path === `/api/agent/sessions/${encodeURIComponent(id)}/interactions/owned-head`) heldReply = route;
    else if (path === '/api/agent/runs/owned-run') {
      if (blockReadbacks) readbacks.push(route); else await json(route, current);
    } else await route.fallback();
  });
  const address = `/chat/${encodeURIComponent(id)}?cwd=%2Fworkspace`;
  await page.goto(address);
  await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).toBeVisible();
  await expect.poll(() => Boolean(stream)).toBe(true);
  return { initial, snapshot, json, address,
    block() { blockReadbacks = true; },
    replace(run: AgentRunSnapshot | undefined, lastSequence: number) { current = run; sequence = lastSequence; },
    async ready(value = snapshot()) {
      await expect.poll(() => Boolean(stream)).toBe(true);
      const pending = stream!; stream = undefined;
      await pending.fulfill({ contentType: 'text/event-stream', body: `event: connection.ready\ndata: ${JSON.stringify({ snapshot: value, reset: true })}\n\n` });
    },
    async stop() { await page.locator('.stop-button').click(); await expect.poll(() => Boolean(heldStop)).toBe(true); return heldStop!; },
    async reply() {
      const dialog = page.getByRole('dialog', { name: 'Owned approval' });
      await dialog.getByRole('textbox').fill('Preserved input');
      await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
      await expect.poll(() => Boolean(heldReply)).toBe(true); return heldReply!;
    },
    async delayList() { holdLists = true; await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await expect.poll(() => Boolean(heldList)).toBe(true); return heldList!; },
    async readbackHeld() { await expect.poll(() => readbacks.length).toBeGreaterThan(0); },
  };
}

for (const response of ['success', 'failure'] as const) {
  test(`unchanged duplicate admission keeps a held interaction ${response} eligible`, async ({ page }) => {
    const api = await fixture(page, 'duplicate-' + response, true);
    const held = await api.reply();
    const before = api.snapshot();
    api.block();
    await api.ready(before);
    await api.readbackHeld(); // resync cannot hide a lost HTTP admission
    const dialog = page.getByRole('dialog', { name: 'Owned approval' });
    await expect(dialog.getByRole('textbox')).toHaveValue('Preserved input');
    await expect(dialog.getByRole('button', { name: 'Submit', exact: true })).toBeDisabled();
    if (response === 'success') {
      await api.json(held, { ...api.initial, lastSequence: 2, extensionRequests: [], extensionRequest: undefined });
      await expect(dialog).toHaveCount(0);
    } else {
      await api.json(held, { error: 'CURRENT HELD RESPONSE REJECTED' }, 409);
      await expect(page.getByText('CURRENT HELD RESPONSE REJECTED', { exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Submit', exact: true })).toBeEnabled();
      await expect(dialog.getByRole('textbox')).toHaveValue('Preserved input');
    }
  });
}

for (const response of ['success', 'failure'] as const) {
  for (const destination of ['current', 'address-ABA', 'unmount'] as const) {
    test(`actual browser Stop ${response} belongs to its ${destination} admission`, async ({ page }) => {
      const api = await fixture(page, 'stop-' + response + '-' + destination);
      const held = await api.stop();
      if (destination === 'address-ABA') {
        await page.evaluate(() => { history.pushState(null, '', '/chat/away?cwd=%2Fworkspace'); window.dispatchEvent(new PopStateEvent('popstate')); });
        await expect(page.locator('.chat-view')).toContainText('Away');
        await page.evaluate(address => { history.pushState(null, '', address); window.dispatchEvent(new PopStateEvent('popstate')); }, api.address);
        await expect(page.locator('.stop-button')).toBeEnabled();
      } else if (destination === 'unmount') {
        await page.evaluate(() => { history.pushState(null, '', '/settings'); window.dispatchEvent(new PopStateEvent('popstate')); });
        await expect(page.locator('.chat-view')).toHaveCount(0);
      }
      api.block();
      if (response === 'success') await api.json(held, { ...api.initial, phase: 'stopped', lastSequence: 2 });
      else await api.json(held, { error: 'HELD STOP REJECTED' }, 409);
      if (destination === 'current') {
        if (response === 'success') await expect(page.locator('.stop-button')).toHaveCount(0);
        else await expect(page.getByText('HELD STOP REJECTED', { exact: true })).toBeVisible();
      } else {
        await expect(page.getByText('HELD STOP REJECTED', { exact: true })).toHaveCount(0);
        if (destination === 'address-ABA') await expect(page.locator('.stop-button')).toBeEnabled();
        else {
          await page.evaluate(address => { history.pushState(null, '', address); window.dispatchEvent(new PopStateEvent('popstate')); }, api.address);
          // Release canonical readbacks only after checking that the old callback
          // did not write a terminal run into the shared store: the cached run stays active.
          await expect(page.locator('.stop-button')).toBeEnabled();
        }
      }
    });
  }
}

for (const id of ['__proto__', 'constructor', 'toString']) {
  test(`actual consumer admits own zero-sequence ${id}, then rejects its delayed callback after clear`, async ({ page }) => {
    const api = await fixture(page, id, true, true);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    api.replace(api.initial, 0);
    await api.ready();
    const dialog = page.getByRole('dialog', { name: 'Owned approval' });
    await expect(dialog).toBeVisible();
    const held = await api.reply();
    api.replace(undefined, 2);
    await api.ready();
    await expect(dialog).toHaveCount(0);
    await api.json(held, { ...api.initial, lastSequence: 1000 });
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).toBeVisible();
  });
}

for (const suffix of ['#replacement', '&replacement=1']) {
  test(`actual App held discovery retires on same-session address ${suffix}`, async ({ page }) => {
    const api = await fixture(page, 'poll-address');
    const held = await api.delayList();
    await page.evaluate(address => { history.pushState(null, '', address); window.dispatchEvent(new PopStateEvent('popstate')); }, api.address + suffix);
    await expect(page.locator('.stop-button')).toBeEnabled();
    await api.json(held, [{ ...api.initial, id: 'unadmitted-old-discovery', phase: 'stopped', lastSequence: 1000 }]);
    await expect(page.locator('.stop-button')).toBeEnabled();
  });
}

for (const scenario of ['live-queue', 'terminal-notice'] as const) {
  test(`workspace bootstrap admits the first ${scenario} stream only into its bound lifetime`, async ({ page }) => {
    const id = 'bootstrap-' + scenario;
    await page.addInitScript(() => localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, sidebarVisible: false, filesOpen: false, sound: false })));
    const session = mockSession(id, 'Bootstrap admission');
    await installMockApi(page, { sessions: [session], holdAgentRun: true });
    let releaseWorkspace!: () => void;
    const workspaceGate = new Promise<void>(resolve => { releaseWorkspace = resolve; });
    let workspaceReads = 0;
    await page.route(/\/api\/workspaces\/(?:default|validate)(?:\?|$)/, async route => {
      workspaceReads++;
      await workspaceGate;
      await route.fallback(); // untouched shared canonical workspace fixture
    });
    const head = (id: string) => ({ id, kind: 'input' as const, title: 'Bootstrap ' + id, createdAt: '2026-01-01' });
    const run: AgentRunSnapshot = { id: 'bootstrap-run', sessionId: id, cwd: '/workspace', provider: 'mock', phase: scenario === 'live-queue' ? 'tool' : 'completed', lastSequence: 1,
      steerQueue: [], followUpQueue: [], extensionRequests: scenario === 'live-queue' ? [head('first')] : [] };
    let stateReads = 0;
    let subscriptions = 0;
    const payload = { sessionId: id, session, lastSequence: 1, run };
    await page.route('**/api/agent/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === `/api/agent/sessions/${id}/state`) { stateReads++; await route.fulfill({ contentType:'application/json', body:JSON.stringify(payload) }); }
      else if (path === `/api/agent/sessions/${id}/events`) {
        subscriptions++;
        const rejected = { protocolVersion: 1, id:id+':200', sessionId:id, runId:scenario === 'live-queue' ? 'foreign-run' : run.id,
          sequence:200, timestamp:'2026-01-01', type:'message.delta', data:{messageId:'foreign',content:'UNADMITTED BOOTSTRAP TRANSCRIPT'} };
        const admitted = { protocolVersion:1, id:id+':2', sessionId:id, ...(scenario === 'live-queue' ? {runId:run.id} : {}), sequence:2, timestamp:'2026-01-01',
          type:scenario === 'live-queue' ? 'extension.ui' : 'notice', data:scenario === 'live-queue' ? { action:'request', request:head('second') } : {message:'ADMITTED BOOTSTRAP NOTICE'} };
        let body=`event: connection.ready\ndata: ${JSON.stringify({snapshot:payload, reset:true})}\n\n`;
        // One-shot producer. Replacement subscriptions cannot repair a consumed
        // before-workspace response. No timing/wait alteration to older cases.
        if(subscriptions === 1) for(const event of [rejected, admitted])body+=`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        await route.fulfill({contentType:'text/event-stream',body});
      } else if(path === '/api/agent/running')await route.fulfill({contentType:'application/json',body:JSON.stringify([run])});
      else if(path === '/api/agent/runs/bootstrap-run')await route.fulfill({contentType:'application/json',body:JSON.stringify(run)});
      else await route.fallback();
    });
    await page.goto(`/chat/${id}?cwd=%2Fworkspace`);
    await expect.poll(() => workspaceReads).toBeGreaterThan(0);
    await expect(page.locator('.app')).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(stateReads).toBe(0);
    expect(subscriptions).toBe(0);
    releaseWorkspace();
    if(scenario === 'live-queue') {
      const dialog=page.getByRole('dialog',{name:'Bootstrap first'});
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('status')).toHaveText('1 waiting');
    } else await expect(page.getByText('ADMITTED BOOTSTRAP NOTICE',{exact:true})).toBeVisible();
    await expect(page.getByText('UNADMITTED BOOTSTRAP TRANSCRIPT',{exact:true})).toHaveCount(0);
  });
}
