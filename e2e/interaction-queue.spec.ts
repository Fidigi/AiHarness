import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from './fixtures/test-budget';
import type { AgentEvent, AgentRunSnapshot, AgentStateSnapshot, ExtensionInteractionSnapshot } from '@ai-harness/core';
import { installMockApi, mockSession } from './fixtures/mock-api';

// Queue-specific transport stays here; the shared single-interaction mock is not modified.
const date = '2026-01-01T12:00:00.000Z';
const interaction = (id: string, extra: Partial<ExtensionInteractionSnapshot> = {}): ExtensionInteractionSnapshot => ({
  id, kind: 'input', title: `Request ${id}`, message: 'Plain-text extension approval.', createdAt: date, ...extra,
});
const sessionId = 'interaction-queue';
const initialRun = (requests: ExtensionInteractionSnapshot[] = []): AgentRunSnapshot => ({
  id: 'queue-run', sessionId, cwd: '/workspace', provider: 'mock', phase: 'tool', startedAt: date,
  steerQueue: [], followUpQueue: [], lastSequence: 1, extensionRequests: requests, extensionRequest: requests[0],
});

async function queueFixture(page: Page, initial = initialRun()) {
  const session = mockSession(sessionId, 'Concurrent extension requests', [
    { role: 'user', content: 'Collect three approvals concurrently with Promise.all.' },
    { role: 'assistant', content: 'The host presents approvals in admission order.' },
  ]);
  await installMockApi(page, { sessions: [session, mockSession('other-session', 'Other session')], holdAgentRun: true });
  let run: AgentRunSnapshot | undefined = initial;
  let sequence = initial.lastSequence;
  let stream: { route: Route; snapshot: AgentStateSnapshot } | undefined;
  const replies: Array<{ id: string; body: unknown }> = [];
  let replyHandler: ((route: Route) => Promise<void>) | undefined;
  let nextState: ((route: Route) => Promise<void>) | undefined;
  const snapshot = (): AgentStateSnapshot => structuredClone({ sessionId, lastSequence: sequence, run });
  const json = (route: Route, data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  await page.route('**/api/agent/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === `/api/agent/sessions/${sessionId}/state`) {
      if (nextState) { const handler = nextState; nextState = undefined; await handler(route); }
      else await json(route, { ...snapshot(), session });
    } else if (url.pathname === `/api/agent/sessions/${sessionId}/events`) {
      stream = { route, snapshot: snapshot() };
    } else if (url.pathname.includes(`/sessions/${sessionId}/interactions/`)) {
      const id = decodeURIComponent(url.pathname.split('/').at(-1)!);
      replies.push({ id, body: route.request().postDataJSON() });
      if (replyHandler) await replyHandler(route);
      else {
        sequence++;
        const requests = (run?.extensionRequests ?? []).filter(entry => entry.id !== id);
        run = { ...run!, lastSequence: sequence, extensionRequests: requests, extensionRequest: requests[0] };
        await json(route, run);
      }
    } else if (url.pathname === '/api/agent/runs' && route.request().method() === 'GET') {
      await json(route, run ? [run] : []);
    } else if (url.pathname === '/api/agent/runs/queue-run/stop') {
      sequence++;
      run = { ...run!, phase: 'stopped', lastSequence: sequence, extensionRequests: [], extensionRequest: undefined };
      await json(route, run);
    } else if (/\/api\/agent\/runs\/[^/]+$/.test(url.pathname) && route.request().method() === 'GET') {
      await json(route, run);
    } else await route.fallback();
  });
  const waitStream = async () => { await expect.poll(() => Boolean(stream)).toBe(true); };
  const send = async (changes: Array<{ type?: AgentEvent['type']; data: unknown }> = [], ready?: AgentStateSnapshot) => {
    await waitStream();
    const pending = stream!; stream = undefined;
    let body = `event: connection.ready\ndata: ${JSON.stringify({ snapshot: ready ?? pending.snapshot, reset: true })}\n\n`;
    for (const change of changes) {
      sequence++;
      const type = change.type ?? 'extension.ui';
      const event: AgentEvent = { protocolVersion: 1, id: `${sessionId}:${sequence}`, sessionId, runId: run?.id,
        sequence, timestamp: date, type, data: change.data };
      body += `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
      const data = change.data as { action?: string; request?: ExtensionInteractionSnapshot; requestId?: string } | null;
      if (run) {
        let requests = run.extensionRequests ?? (run.extensionRequest ? [run.extensionRequest] : []);
        if (data?.action === 'request' && data.request?.kind) {
          const replacement = data.request;
          requests = requests.some(entry => entry.id === replacement.id)
            ? requests.map(entry => entry.id === replacement.id ? replacement : entry) : [...requests, replacement];
        }
        if (data?.action === 'resolved') requests = requests.filter(entry => entry.id !== data.requestId);
        if (type === 'run.stopped') requests = [];
        run = { ...run, phase: type === 'run.stopped' ? 'stopped' : run.phase, lastSequence: sequence,
          extensionRequests: requests, extensionRequest: requests[0] };
      }
    }
    await pending.route.fulfill({ status: 200, contentType: 'text/event-stream', body });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  };
  return { send, waitStream, replies, snapshot, json,
    setReply(handler: (route: Route) => Promise<void>) { replyHandler = handler; },
    setNextState(handler: (route: Route) => Promise<void>) { nextState = handler; },
    replace(next: AgentRunSnapshot | undefined, lastSequence: number) { run = next; sequence = lastSequence; },
  };
}

async function preferences(page: Page, theme = 'light', sound = false) {
  await page.addInitScript(({ theme, sound }) => {
    localStorage.setItem('ai-harness-preferences-v4', JSON.stringify({ version: 4, theme, sound,
      soundEvents: { completion: false, attention: true }, sidebarVisible: false, filesOpen: false }));
    let count = 0;
    Object.defineProperty(window, '__attentionCount', { get: () => count });
    const Original = window.AudioContext;
    window.AudioContext = class extends Original { constructor() { super(); count++; } };
    const focusLog: string[] = [];
    Object.defineProperty(window, '__queueFocus', { value: focusLog });
    document.addEventListener('focusin', event => { focusLog.push((event.target as HTMLElement).tagName + ':' + ((event.target as HTMLElement).getAttribute('aria-label') ?? '')); });
  }, { theme, sound });
}
const soundCount = (page: Page) => page.evaluate(() => (window as unknown as { __attentionCount: number }).__attentionCount);

test('Promise.all transport presents in admission order, closes out of order and sounds only newly presented heads', async ({ page }) => {
  await preferences(page, 'light', true);
  const api = await queueFixture(page);
  await page.goto(`/chat/${sessionId}?cwd=%2Fworkspace`);
  // These are the ordered events emitted by the Core Promise.all admission contract (Core execution is separately tested).
  await api.send(['a', 'b', 'c'].map(id => ({ data: { action: 'request', request: interaction(id) } })));
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName('Request a');
  await expect(dialog.getByRole('status')).toHaveText('2 waiting');
  await expect.poll(() => soundCount(page)).toBe(1);
  await dialog.getByRole('textbox').fill('kept draft');
  await api.send([{ data: { action: 'resolved', requestId: 'c' } }, { data: { action: 'request', request: interaction('a', { message: 'Display replacement' }) } }]);
  await expect(dialog.getByRole('status')).toHaveText('1 waiting');
  await expect(dialog.getByRole('textbox')).toHaveValue('kept draft');
  expect(await soundCount(page)).toBe(1);
  await dialog.evaluate(element => element.setAttribute('data-container-identity', 'preserved'));
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(dialog).toHaveAccessibleName('Request b');
  await expect(dialog).toHaveAttribute('data-container-identity', 'preserved');
  await expect(dialog.getByRole('textbox')).toHaveValue('');
  await expect.poll(() => soundCount(page)).toBe(2);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(api.replies).toEqual([{ id: 'a', body: { cancelled: false, value: 'kept draft' } }, { id: 'b', body: { cancelled: true } }]);
  await api.send([{ data: { action: 'request', request: interaction('a') } }]);
  await expect(dialog).toHaveCount(0);
});

test('same-ID full schema update retains compatible drafts only and ignores malformed partial events', async ({ page }) => {
  await preferences(page);
  const old = interaction('schema', { kind: 'custom', fields: [
    { name: 'keep', label: 'Keep', type: 'text' }, { name: 'changed', label: 'Changed', type: 'text' },
    { name: 'pick', label: 'Pick', type: 'select', required: true, options: [{ label: 'Old', value: 'old' }] },
    { name: 'removed', label: 'Removed', type: 'text' },
  ] });
  const api = await queueFixture(page, initialRun([old]));
  await page.goto(`/chat/${sessionId}?cwd=%2Fworkspace`);
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Keep', { exact: true }).fill('valid draft');
  await dialog.getByLabel('Changed', { exact: true }).fill('reset me');
  const next = { ...old, fields: [old.fields![0]!, { name: 'changed', label: 'Changed', type: 'textarea' as const },
    { name: 'pick', label: 'Pick', type: 'select' as const, required: true, options: [{ label: 'New', value: 'new' }] },
    { name: 'added', label: 'Added', type: 'checkbox' as const }] };
  await api.send([{ data: null }, { data: { action: 'request', request: { id: 'broken' } } },
    { data: { action: 'request', request: next } }]);
  await expect(dialog.getByLabel('Keep', { exact: true })).toHaveValue('valid draft');
  await expect(dialog.getByLabel('Changed', { exact: true })).toHaveValue('');
  await expect(dialog.getByRole('combobox', { name: /^Pick/ })).toHaveValue('new');
  await expect(dialog.getByLabel('Removed', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('Added', { exact: true })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.replies[0]?.body).toEqual({ cancelled: false, value: { keep: 'valid draft', changed: '', pick: 'new', added: false } });
});

test('stale GET, connection.ready with no run, different-run snapshots and late HTTP failure cannot replace a newer head', async ({ page }) => {
  await preferences(page);
  const api = await queueFixture(page, initialRun([interaction('a'), interaction('b')]));
  await page.goto(`/chat/${sessionId}?cwd=%2Fworkspace`);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName('Request a');
  let heldReply: Route | undefined;
  api.setReply(async route => { heldReply = route; });
  await dialog.getByRole('textbox').fill('reply');
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect.poll(() => Boolean(heldReply)).toBe(true);
  let heldState: Route | undefined;
  api.setNextState(async route => { heldState = route; });
  await api.send([{ type: 'tool.completed', data: { id: 'tool' } }, { data: { action: 'resolved', requestId: 'a' } }]);
  await expect(dialog).toHaveAccessibleName('Request b');
  await expect.poll(() => Boolean(heldState)).toBe(true);
  await api.json(heldState!, { sessionId, lastSequence: 1, session: mockSession(sessionId, 'stale'), run: undefined });
  await api.json(heldReply!, { error: 'OLD HTTP FAILURE' }, 409);
  await api.send([], { sessionId, lastSequence: 1 });
  await expect(dialog).toHaveAccessibleName('Request b');
  await expect(page.getByText('OLD HTTP FAILURE', { exact: true })).toHaveCount(0);
  await api.send([], { sessionId, lastSequence: 1, run: { ...initialRun([interaction('old')]), id: 'old-run' } });
  await expect(dialog).toHaveAccessibleName('Request b');
  const fresh = api.snapshot();
  // Even an equal-sequence replay containing a resolved ID is filtered by the per-run tombstone.
  await api.send([], { ...fresh, run: { ...fresh.run!, extensionRequests: [interaction('a'), interaction('b')] } });
  await expect(dialog).toHaveAccessibleName('Request b');
  // A success response from an older sequence must not resurrect the resolved target either.
  api.setReply(async route => { await api.json(route, initialRun([interaction('a')])); });
  await dialog.getByRole('textbox').fill('second');
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(dialog).toHaveAccessibleName('Request b');
});

test('late successful HTTP response cannot overwrite a replacement run in the same view', async ({ page }) => {
  await preferences(page);
  const api = await queueFixture(page, initialRun([interaction('old')]));
  await page.goto(`/chat/${sessionId}?cwd=%2Fworkspace`);
  let held: Route | undefined;
  api.setReply(async route => { held = route; });
  await page.getByRole('dialog').getByRole('textbox').fill('pending');
  await page.getByRole('dialog').getByRole('button', { name: 'Submit', exact: true }).click();
  await expect.poll(() => Boolean(held)).toBe(true);
  const replacement = { ...initialRun([interaction('new')]), id: 'replacement-run', lastSequence: 10 };
  api.replace(replacement, 10);
  await api.send([], { sessionId, lastSequence: 10, run: replacement });
  await expect(page.getByRole('dialog')).toHaveAccessibleName('Request new');
  await api.json(held!, { ...initialRun([interaction('resurrected')]), lastSequence: 11 });
  await expect(page.getByRole('dialog')).toHaveAccessibleName('Request new');
});

test('HTTP completion after view epoch switch is ignored', async ({ page }) => {
  await preferences(page);
  const api = await queueFixture(page, initialRun([interaction('a')]));
  await page.goto(`/chat/${sessionId}?cwd=%2Fworkspace`);
  let held: Route | undefined;
  api.setReply(async route => { held = route; });
  await page.getByRole('dialog').getByRole('textbox').fill('pending');
  await page.getByRole('dialog').getByRole('button', { name: 'Submit', exact: true }).click();
  await expect.poll(() => Boolean(held)).toBe(true);
  // Client-side navigation keeps the delayed fetch alive, unlike a document reload.
  await page.evaluate(() => { history.pushState(null, '', '/chat/other-session?cwd=%2Fworkspace'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await api.json(held!, { error: 'OLD EPOCH ERROR' }, 409);
  await expect(page.getByText('OLD EPOCH ERROR', { exact: true })).toHaveCount(0);
});

test('fresh empty/missing/terminal reconnect clears, stop clears, absent plural alone restores legacy primary without attention replay', async ({ page }) => {
  await preferences(page, 'light', true);
  const legacy = { ...initialRun(), extensionRequests: undefined, extensionRequest: interaction('legacy') };
  const api = await queueFixture(page, legacy);
  await page.goto(`/chat/${sessionId}?cwd=%2Fworkspace`);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName('Request legacy');
  expect(await soundCount(page)).toBe(0);
  const empty = { ...legacy, lastSequence: 2, extensionRequests: [] };
  api.replace(empty, 2);
  await api.send([], { sessionId, lastSequence: 2, run: empty });
  await expect(dialog).toHaveCount(0);
  const second = { ...initialRun([interaction('stop')]), id: 'second-run', lastSequence: 3 };
  api.replace(second, 3);
  await api.send([], { sessionId, lastSequence: 3, run: second });
  await expect(dialog).toHaveAccessibleName('Request stop');
  await api.send([{ type: 'run.stopped', data: {} }]);
  await expect(dialog).toHaveCount(0);
  const third = { ...initialRun([interaction('missing')]), id: 'third-run', lastSequence: 5 };
  api.replace(third, 5);
  await api.send([], { sessionId, lastSequence: 5, run: third });
  await expect(dialog).toHaveAccessibleName('Request missing');
  api.replace(undefined, 6);
  await api.send([], { sessionId, lastSequence: 6 });
  await expect(dialog).toHaveCount(0);
  const fourth = { ...initialRun([interaction('terminal')]), id: 'fourth-run', lastSequence: 7 };
  api.replace(fourth, 7);
  await api.send([], { sessionId, lastSequence: 7, run: fourth });
  await expect(dialog).toHaveAccessibleName('Request terminal');
  const terminal = { ...fourth, phase: 'completed' as const, lastSequence: 8 };
  api.replace(terminal, 8);
  await api.send([], { sessionId, lastSequence: 8, run: terminal });
  await expect(dialog).toHaveCount(0);
});

for (const scenario of [
  { name: 'desktop-light', width: 1440, mobile: false, theme: 'light' },
  { name: 'desktop-dark', width: 1440, mobile: false, theme: 'dark' },
  { name: 'mobile-light', width: 390, mobile: true, theme: 'light' },
  { name: 'mobile-dark', width: 390, mobile: true, theme: 'dark' },
] as const) {
  test.describe(scenario.name, () => {
    test.use({ viewport: { width: scenario.width, height: 844 }, isMobile: scenario.mobile, hasTouch: scenario.mobile });
    test('queue focus, waiting count, accessibility and visual baseline', async ({ page }) => {
      await preferences(page, scenario.theme);
      const api = await queueFixture(page);
      await page.goto(`/chat/${sessionId}?cwd=%2Fworkspace`);
      await page.getByRole('textbox', { name: 'Message composer', exact: true }).focus();
      await page.evaluate(() => ((window as unknown as { __queueFocus: string[] }).__queueFocus.length = 0));
      await api.send(['a', 'b', 'c'].map(id => ({ data: { action: 'request', request: interaction(id) } })));
      const dialog = page.getByRole('dialog');
      await expect(dialog).toHaveAccessibleName('Request a');
      await expect(dialog.getByRole('status')).toHaveText('2 waiting');
      if (scenario.mobile) {
        await expect(dialog).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(dialog.getByRole('button', { name: 'Submit', exact: true })).toBeFocused();
        await dialog.focus();
      } else await expect(dialog.getByRole('textbox')).toBeFocused();
      await page.evaluate(async () => { await document.fonts.ready; });
      await expect(page.locator('.chat-view')).toHaveScreenshot(`interaction-queue-${scenario.name}.png`, {
        animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02,
      });
      const accessibility = await new AxeBuilder({ page }).include('.extension-interaction')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(accessibility.violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
      await dialog.evaluate(element => element.setAttribute('data-focus-identity', 'same'));
      await api.send([{ data: { action: 'resolved', requestId: 'a' } }]);
      await expect(dialog).toHaveAccessibleName('Request b');
      await expect(dialog).toHaveAttribute('data-focus-identity', 'same');
      if (scenario.mobile) await expect(dialog).toBeFocused();
      else await expect(dialog.getByRole('textbox')).toBeFocused();
      await dialog.getByRole('button', { name: 'Submit', exact: true }).focus();
      await page.keyboard.press('Tab');
      await expect(dialog.getByRole('textbox')).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(dialog.getByRole('button', { name: 'Submit', exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveAccessibleName('Request c');
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      if (scenario.mobile) {
        await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).not.toBeFocused();
        expect(await page.evaluate(() => (window as unknown as { __queueFocus: string[] }).__queueFocus
          .filter(entry => entry === 'TEXTAREA:Message composer'))).toEqual([]);
      } else await expect(page.getByRole('textbox', { name: 'Message composer', exact: true })).toBeFocused();
    });
  });
}

// Append-only: equal-sequence replay must not re-enable the pending response guard.
test('exact queue: duplicate snapshot preserves draft and pending submission guard', async ({ page }) => {
  await preferences(page);
  const api = await queueFixture(page, initialRun([interaction('pending')]));
  await page.goto(`/chat/${sessionId}?cwd=%2Fworkspace`);
  const dialog = page.getByRole('dialog');
  let held: Route | undefined;
  api.setReply(async route => { held = route; });
  await dialog.getByRole('textbox').fill('pending draft');
  const submit = dialog.getByRole('button', { name: 'Submit', exact: true });
  await submit.click();
  await expect.poll(() => Boolean(held)).toBe(true);
  await expect(submit).toBeDisabled();
  await api.send([], api.snapshot()); // byte-equivalent authoritative replay, not settlement
  await expect(dialog.getByRole('textbox')).toHaveValue('pending draft');
  await expect(submit).toBeDisabled();
  expect(api.replies).toHaveLength(1);
  await api.json(held!, { error: 'Current response rejected' }, 409);
  await expect(submit).toBeEnabled();
  await expect(dialog.getByRole('textbox')).toHaveValue('pending draft');
});

// Append-only: rejected event IDs cannot poison the watermark or write transcript state.
test('foreign lifecycle discovery cannot admit its run or poison the current queue watermark', async ({ page }) => {
  await preferences(page);
  const api = await queueFixture(page, initialRun([interaction('first')]));
  let sent = false;
  await page.route(`**/api/agent/sessions/${sessionId}/events*`, async route => {
    let body = `event: connection.ready\ndata: ${JSON.stringify({ snapshot: api.snapshot(), reset: true })}\n\n`;
    if (!sent) {
      sent = true;
      const events: AgentEvent[] = [{ protocolVersion: 1, id: `${sessionId}:200`, sessionId,
        runId: 'foreign-run', sequence: 200, timestamp: date, type: 'run.started', data: { cwd: '/workspace', provider: 'mock' } },
      { protocolVersion: 1, id: `${sessionId}:2`, sessionId,
        runId: 'queue-run', sequence: 2, timestamp: date, type: 'extension.ui',
        data: { action: 'request', request: interaction('second') } }];
      for (const event of events) body += `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    }
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });
  await page.goto(`/chat/${sessionId}?cwd=%2Fworkspace`);
  await expect(page.getByRole('dialog')).toHaveAccessibleName('Request first');
  await expect(page.getByRole('dialog').getByRole('status')).toHaveText('1 waiting');
});

test('exact queue: foreign future event is inert before watermark and transcript admission', async ({ page }) => {
  await preferences(page);
  const api = await queueFixture(page, initialRun([interaction('first')]));
  let sent = false;
  await page.route(`**/api/agent/sessions/${sessionId}/events*`, async route => {
    let body = `event: connection.ready\ndata: ${JSON.stringify({ snapshot: api.snapshot(), reset: true })}\n\n`;
    if (!sent) {
      sent = true;
      const foreign: AgentEvent = { protocolVersion: 1, id: `${sessionId}:200`, sessionId,
        runId: 'retired-or-foreign-run', sequence: 200, timestamp: date, type: 'message.delta',
        data: { messageId: 'foreign-message', content: 'STALE FOREIGN TRANSCRIPT' } };
      const current: AgentEvent = { protocolVersion: 1, id: `${sessionId}:2`, sessionId,
        runId: 'queue-run', sequence: 2, timestamp: date, type: 'extension.ui',
        data: { action: 'request', request: interaction('second') } };
      for (const event of [foreign, current]) body += `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    }
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });
  await page.goto(`/chat/${sessionId}?cwd=%2Fworkspace`);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName('Request first');
  await expect(dialog.getByRole('status')).toHaveText('1 waiting');
  await expect(page.getByText('STALE FOREIGN TRANSCRIPT', { exact: true })).toHaveCount(0);
});

test('exact queue: terminal run event is inert while later session notice remains eligible', async ({ page }) => {
  await preferences(page);
  const api = await queueFixture(page, { ...initialRun(), phase: 'completed' });
  let sent = false;
  await page.route(`**/api/agent/sessions/${sessionId}/events*`, async route => {
    let body = `event: connection.ready\ndata: ${JSON.stringify({ snapshot: api.snapshot(), reset: true })}\n\n`;
    if (!sent) {
      sent = true;
      const late: AgentEvent = { protocolVersion: 1, id: `${sessionId}:200`, sessionId,
        runId: 'queue-run', sequence: 200, timestamp: date, type: 'message.delta',
        data: { messageId: 'late-message', content: 'LATE TERMINAL TRANSCRIPT' } };
      const notice: AgentEvent = { protocolVersion: 1, id: `${sessionId}:2`, sessionId,
        sequence: 2, timestamp: date, type: 'notice', data: { message: 'CURRENT SESSION NOTICE' } };
      for (const event of [late, notice]) body += `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    }
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });
  await page.goto(`/chat/${sessionId}?cwd=%2Fworkspace`);
  await expect(page.getByText('CURRENT SESSION NOTICE', { exact: true })).toBeVisible();
  await expect(page.getByText('LATE TERMINAL TRANSCRIPT', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

// Append-only unknown identity control: missing runId cannot admit run-bound transcript or consume its sequence.
test('current queue: uncorrelated future run frame cannot poison the next admitted interaction', async ({ page }) => {
  await preferences(page);
  const api = await queueFixture(page, initialRun([interaction('first')]));
  let sent = false;
  await page.route(`**/api/agent/sessions/${sessionId}/events*`, async route => {
    let body = 'event: connection.ready\ndata: ' + JSON.stringify({ snapshot: api.snapshot(), reset: true }) + '\n\n';
    if (!sent) {
      sent = true;
      const unknown: AgentEvent = { protocolVersion: 1, id: sessionId + ':200', sessionId, sequence: 200,
        timestamp: date, type: 'message.delta', data: { messageId: 'unknown-message', content: 'UNKNOWN RUN TRANSCRIPT' } };
      const current: AgentEvent = { protocolVersion: 1, id: sessionId + ':2', sessionId, runId: 'queue-run', sequence: 2,
        timestamp: date, type: 'extension.ui', data: { action: 'request', request: interaction('second') } };
      for (const event of [unknown, current]) body += 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n';
    }
    await route.fulfill({ contentType: 'text/event-stream', body });
  });
  await page.goto('/chat/' + sessionId + '?cwd=%2Fworkspace');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName('Request first');
  await expect(dialog.getByRole('status')).toHaveText('1 waiting');
  await expect(page.getByText('UNKNOWN RUN TRANSCRIPT', { exact: true })).toHaveCount(0);
});
