import { afterEach, expect, it, vi } from 'vitest';
import { copyDisplayedSession } from './session-row-copy';
const fetch = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ apiFetch: fetch }));
afterEach(() => fetch.mockReset());
const target = { sessionId: 'session:native', entryId: 'custom:displayed', cwd: '/workspace/[literal] %20', workspaceId: 'workspace-id' };
const copied = () => ({ id: 'new-copy', cwd: target.cwd, metadata: { clonedFromSessionId: target.sessionId, clonedFromEntryId: target.entryId } });

it('uses fixed native transport with exact captured entry/scope and signal, never generic clone or a URL token', async () => {
  const signal = new AbortController().signal; fetch.mockResolvedValue(new Response(JSON.stringify(copied()), { status: 201 }));
  expect((await copyDisplayedSession(target, signal)).success).toBe(true);
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/sessions/session%3Anative/clone', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ entryId: target.entryId, expectedCwd: target.cwd }),
  });
});
it.each([401, 403, 409, 429])('retains real refusal%d without retry/fallback or private error output', async status => {
  fetch.mockResolvedValue(new Response(JSON.stringify({ error: 'PRIVATE_SERVER_VALUE' }), { status }));
  expect(await copyDisplayedSession(target)).toEqual({ success: false, error: 'Displayed session entry could not be copied.' });
  expect(fetch).toHaveBeenCalledOnce();
});
it.each(['id', 'cwd', 'entry'] as const)('refuses wrong native copy echo%s rather than selecting another conversation/scope', async field => {
  const data = copied();
  if (field === 'id') data.id = target.sessionId;
  if (field === 'cwd') data.cwd = '/other';
  if (field === 'entry') data.metadata.clonedFromEntryId = 'later';
  fetch.mockResolvedValue(new Response(JSON.stringify(data), { status: 201 }));
  expect((await copyDisplayedSession(target)).success).toBe(false); expect(fetch).toHaveBeenCalledOnce();
});
it('contains abort/transport failures without retrying or revealing exception text', async () => {
  fetch.mockRejectedValue(new Error('PRIVATE_TRANSPORT_VALUE'));
  expect(await copyDisplayedSession(target)).toEqual({ success: false, error: 'Displayed session entry could not be copied.' });
  expect(fetch).toHaveBeenCalledOnce();
});
