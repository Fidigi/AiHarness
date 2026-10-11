import { expect, test } from '@playwright/test';
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
    await page.route(`**/api/agent/sessions/${id}/state`, route => route.fulfill({
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
