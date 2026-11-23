import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from './api';
import { browseLinkedDirectory, listLinkedDirectories, readLinkedDirectoryFile, setLinkedDirectoryConsent } from './linked-directories';
vi.mock('./api', () => ({ apiFetch: vi.fn() }));
const fetch = vi.mocked(apiFetch);
const selector = { cwd: '/workspace', directory: '.', id: 'a'.repeat(64), revision: 'b'.repeat(64) };
const inventory = { cwd: '/workspace', directory: '.', revision: 'b'.repeat(64), entries: [], truncated: false, restriction: 'scoped-files-only' };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
beforeEach(() => { fetch.mockReset(); });

describe('linked directories API client', () => {
  it('uses exported authenticated apiFetch for passive metadata only', async () => {
    fetch.mockResolvedValue(response(inventory));
    expect(await listLinkedDirectories('/workspace')).toEqual(inventory);
    expect(fetch.mock.calls[0][0]).toBe('/api/workspaces/linked-directories?cwd=%2Fworkspace&directory=.');
    expect(fetch.mock.calls[0][1]).toMatchObject({ cache: 'no-store' });
    expect(fetch.mock.calls).toHaveLength(1);
  });
  it('submits only exact selector and explicit consent, never additional target/trust/authority', async () => {
    fetch.mockResolvedValue(response(inventory));
    await setLinkedDirectoryConsent({ ...selector, target: '/secret', trust: true, transcript: 'allow' } as typeof selector, true);
    expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toEqual({ ...selector, allowed: true, confirm: true });
    expect(fetch.mock.calls[0][1]?.method).toBe('POST');
  });
  it('reads and browses only exact selected relative paths', async () => {
    fetch.mockResolvedValueOnce(response({ path: '.', entries: [], truncated: false }));
    await browseLinkedDirectory({ ...selector, path: '.' });
    fetch.mockResolvedValueOnce(response({ path: 'file.txt', content: 'plain content', size: 13 }));
    expect(await readLinkedDirectoryFile({ ...selector, path: 'file.txt' })).toMatchObject({ content: 'plain content' });
    expect(String(fetch.mock.calls[1][0])).toContain('id=aaaaaaaa');
    expect(String(fetch.mock.calls[1][0])).toContain('path=file.txt');
  });
  it('never reflects untrusted backend error prose or treats failure as a grant', async () => {
    fetch.mockResolvedValue(response({ code: 'stale-entry', error: 'ACTIVE_PRIVATE_SECRET' }, 409));
    await expect(listLinkedDirectories('/workspace')).rejects.toMatchObject({ code: 'stale-entry', message: 'Linked-directory request failed.' });
    fetch.mockRejectedValue(new Error('NETWORK_PRIVATE_SECRET'));
    await expect(listLinkedDirectories('/workspace')).rejects.toMatchObject({ code: 'request-unavailable', message: 'Linked-directory request failed.' });
  });
  it('rejects malformed and oversized responses', async () => {
    fetch.mockResolvedValue(response({ ...inventory, entries: Array.from({ length: 501 }, () => ({})) }));
    await expect(listLinkedDirectories('/workspace')).rejects.toMatchObject({ code: 'invalid-response' });
    fetch.mockResolvedValue(new Response('x'.repeat(4 * 1024 * 1024 + 1)));
    await expect(listLinkedDirectories('/workspace')).rejects.toMatchObject({ code: 'invalid-response' });
  });
  it('propagates cancellation without mutating browser storage or shared state', async () => {
    fetch.mockImplementation(async (_url, init) => {
      expect(init?.signal?.aborted).toBe(true); throw new Error('aborted');
    });
    const abort = new AbortController(); abort.abort();
    await expect(listLinkedDirectories('/workspace', '.', abort.signal)).rejects.toMatchObject({ code: 'timeout' });
  });
});
