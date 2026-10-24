import { expect, test } from './fixtures/test-budget';
import { installMockApi, mockSession } from './fixtures/mock-api';

for (const initialTitle of ['', 'Previously listed title']) {
  test(`session metadata title refresh preserves the first valid stream frame (${initialTitle || 'empty title'})`, async ({ page }) => {
    const id = 'metadata-title-stream';
    const session = mockSession(id, initialTitle);
    await installMockApi(page, { sessions: [session], holdAgentRun: true });
    const refreshed = { ...session, title: 'Fresh canonical title' };
    const run = { id: 'metadata-run', sessionId: id, cwd: '/workspace', provider: 'mock', phase: 'streaming',
      steerQueue: [], followUpQueue: [], lastSequence: 0 };
    const snapshot = { sessionId: id, run, lastSequence: 0 };
    let first = true;
    await page.route(`**/api/agent/sessions/${id}/state?*`, route => route.fulfill({
      contentType: 'application/json', body: JSON.stringify({ ...snapshot, session: refreshed }),
    }));
    await page.route(`**/api/agent/sessions/${id}/events*`, async route => {
      // No sleeps/gates/new waits: exactly the first response carries this legitimate
      // ready+notice pair. A title-driven reconnect must not erase the notice.
      const body = first
        ? `event: connection.ready\ndata: ${JSON.stringify({ snapshot, reset: true })}\n\nevent: notice\ndata: ${JSON.stringify({
          protocolVersion: 1, id: `${id}:1`, sequence: 1, sessionId: id, runId: run.id,
          type: 'notice', timestamp: '2026-10-10T12:00:00.000Z', data: { message: 'FIRST STREAM FRAME SURVIVES METADATA', level: 'info' },
        })}\n\n`
        : `event: connection.ready\ndata: ${JSON.stringify({ snapshot, reset: false })}\n\n`;
      first = false;
      await route.fulfill({ contentType: 'text/event-stream', body });
    });
    await page.goto(`/chat/${id}?cwd=%2Fworkspace`);
    await expect(page.getByText('FIRST STREAM FRAME SURVIVES METADATA', { exact: true })).toBeVisible();
  });
}

test('matching terminal frame reconciles once after canonical discovery observed its watermark', async ({ page }) => {
  const id = 'terminal-watermark';
  const partial = mockSession(id, 'Terminal watermark', [{ role: 'assistant', content: 'Earlier reading projection' }]);
  const final = mockSession(id, 'Terminal watermark', [{ role: 'assistant', content: 'Canonical terminal history' }]);
  await installMockApi(page, { sessions: [partial], holdAgentRun: true });
  const run = { id: 'terminal-run', sessionId: id, cwd: '/workspace', provider: 'mock', phase: 'completed',
    steerQueue: [], followUpQueue: [], lastSequence: 22 };
  const snapshot = { sessionId: id, run, lastSequence: 22 };
  let released = false, reads = 0;
  await page.route(`**/api/agent/sessions/${id}/state?*`, route => {
    reads++;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...snapshot, session: released ? final : partial }) });
  });
  // This isolated admission control deliberately mocks transport. The open
  // stream prevents reconnect polling from concealing a rejected terminal frame.
  await page.addInitScript(({ id, snapshot }) => {
    const original = window.fetch, encoder = new TextEncoder();
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.pathname !== `/api/agent/sessions/${id}/events`) return original(input, init);
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(encoder.encode(`event: connection.ready\ndata: ${JSON.stringify({ snapshot, reset: false })}\n\n`));
        Reflect.set(window, '__releaseTerminalControl', () => controller.enqueue(encoder.encode(`event: run.completed\ndata: ${JSON.stringify({
          protocolVersion: 1, id: `${id}:22`, sequence: 22, sessionId: id, runId: snapshot.run.id,
          type: 'run.completed', timestamp: '2026-10-10T12:00:00.000Z', data: {},
        })}\n\n`)));
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    };
  }, { id, snapshot });
  await page.goto(`/chat/${id}?cwd=%2Fworkspace`);
  await expect(page.getByText('Earlier reading projection', { exact: true })).toBeVisible();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const before = reads; released = true;
  await page.evaluate(() => Reflect.get(window, '__releaseTerminalControl')());
  await expect(page.getByText('Canonical terminal history', { exact: true })).toBeVisible();
  expect(reads).toBe(before + 1);
  await page.evaluate(() => Reflect.get(window, '__releaseTerminalControl')());
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(reads).toBe(before + 1);
});
