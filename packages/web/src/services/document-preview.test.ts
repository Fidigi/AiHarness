import { afterEach, expect, it, vi } from 'vitest';
import { readDocumentPreview } from './document-preview';
import { setAuthToken } from './api';

afterEach(() => { setAuthToken(''); vi.unstubAllGlobals(); });
it('uses only a fixed authenticated same-origin route with encoded selectors and the owned signal', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('%PDF-test', { headers: { 'Content-Type': 'application/pdf' } }));
  vi.stubGlobal('fetch', fetch); setAuthToken('disposable-preview-token');
  const signal = new AbortController().signal;
  const result = await readDocumentPreview('/work?x#y', 'report.pdf?url=https://foreign.invalid', signal);
  expect(result.kind).toBe('pdf');
  const [url, options] = fetch.mock.calls[0];
  expect(url).toBe('/api/files/preview?cwd=%2Fwork%3Fx%23y&path=report.pdf%3Furl%3Dhttps%3A%2F%2Fforeign.invalid');
  expect(options).toMatchObject({ credentials: 'same-origin', headers: { Authorization: 'Bearer disposable-preview-token' }, signal });
});
it('bounds the actual streamed bytes even without a trustworthy length and cancels the reader', async () => {
  const cancel = vi.fn();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel,
  }))));
  await expect(readDocumentPreview('/work', 'huge.pdf', new AbortController().signal)).rejects.toThrow('Preview limit');
  expect(cancel).toHaveBeenCalledOnce();
});
it('accepts only bounded text DTOs and never reflects server/parser error bodies', async () => {
  for (const response of [new Response('private server diagnostic', { status: 500 }), Response.json({ kind: 'html', text: '<script>' }),
    Response.json({ kind: 'docx', text: 'x'.repeat(200_001) })]) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(readDocumentPreview('/work', 'sample.docx', new AbortController().signal)).rejects.toThrow('Preview unavailable');
  }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ kind: 'docx', text: '<script>literal</script>' })));
  expect(await readDocumentPreview('/work', 'sample.docx', new AbortController().signal)).toEqual({ kind: 'docx', text: '<script>literal</script>' });
});
