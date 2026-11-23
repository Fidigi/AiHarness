import type { Page } from '@playwright/test';
import type { TerminalSnapshot } from '../../packages/web/src/services/api';
import { installMockApi } from './mock-api';
/** Controlled terminal transport only. Not PTY/auth/trust or physical-keyboard proof. */
export async function installTerminalControls(page: Page, pending = false) {
  await installMockApi(page);
  let release!: () => void;
  const admitted = new Promise<void>(resolve => { release = resolve; });
  if (!pending) release();
  let snapshot: TerminalSnapshot | undefined;
  let output = 'TERMINAL_CONTROLS_READY\r\n', oldestOffset = 0;
  let failed = false;
  const input: string[] = [];
  let created = 0, deleted = 0, eventRequests = 0;
  await page.route('**/api/terminals**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (url.pathname === '/api/terminals' && method === 'GET') { await json(snapshot ? [snapshot] : []); return; }
    if (url.pathname === '/api/terminals' && method === 'POST') {
      const body = request.postDataJSON() as { cwd: string; name: string };
      created++;
      snapshot = { id: 'terminal-controls', cwd: body.cwd, name: body.name, shell: '/bin/sh', pid: 4242,
        cols: 80, rows: 24, status: 'running', startedAt: '2026-10-01T12:00:00.000Z', lastOffset: 0 };
      await json(snapshot, 201); return;
    }
    if (!snapshot) { await json({ error: 'Terminal not found' }, 404); return; }
    if (url.pathname.endsWith('/events')) {
      eventRequests++; await admitted;
      if (failed) { await json({ error: 'Controlled terminal disconnect' }, 503); return; }
      const bytes = Buffer.from(output);
      const after = Number(url.searchParams.get('after') ?? 0), lastOffset = oldestOffset + bytes.length;
      const reset = after < oldestOffset || after > lastOffset, offset = reset ? oldestOffset : after;
      snapshot.lastOffset = lastOffset;
      let records = `event: connection.ready\ndata: ${JSON.stringify({ snapshot, reset, oldestOffset, lastOffset })}\n\n`;
      if (offset < lastOffset) records += `event: output\ndata: ${JSON.stringify({ type: 'output', terminalId: snapshot.id,
        offset, endOffset: lastOffset, data: bytes.subarray(offset - oldestOffset).toString(), timestamp: snapshot.startedAt })}\n\n`;
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: records }); return;
    }
    if (url.pathname.endsWith('/input')) { input.push((request.postDataJSON() as { data: string }).data); await json(snapshot); return; }
    if (url.pathname.endsWith('/resize')) { Object.assign(snapshot, request.postDataJSON()); await json(snapshot); return; }
    if (method === 'DELETE') { deleted++; snapshot.status = 'killed'; await json(snapshot); return; }
    await json({ error: 'Unhandled terminal control fixture' }, 404);
  });
  return { input, release, counts: () => ({ created, deleted, eventRequests }),
    applicationCursor(value: boolean) { output += value ? '\x1b[?1h' : '\x1b[?1l'; output += value ? 'APP_CURSOR_ON\r\n' : 'APP_CURSOR_OFF\r\n'; },
    expire() { oldestOffset += Buffer.byteLength(output) + 1_000; output = 'REPLAY_RETAINED_é😀\r\n'; },
    disconnect(value: boolean) { failed = value; },
    exit() { if (snapshot) snapshot.status = 'exited'; },
  };
}
