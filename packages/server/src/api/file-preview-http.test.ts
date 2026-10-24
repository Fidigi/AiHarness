import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { start, stop } from '../index.js';
import { docxDocument, pdfDocument } from '../../../../tests/fixtures/web04-documents.js';

describe('native authenticated document reads', () => {
  let root: string, cwd: string, base: string;
  const admin = 'web04-disposable-admin', user = 'web04-disposable-user';
  const read = (file: string, token = admin, folder = cwd, origin?: string) => fetch(`${base}/api/files/preview?${new URLSearchParams({ cwd: folder, path: file })}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}) },
  });
  beforeAll(async () => {
    vi.stubEnv('AI_HARNESS_AUTH_TOKEN', user); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', admin);
    root = await mkdtemp(path.join(os.tmpdir(), 'aih-preview-http-')); cwd = path.join(root, 'work');
    await mkdir(cwd); await writeFile(path.join(cwd, 'AGENTS.md'), 'Requires explicit project trust.');
    await writeFile(path.join(cwd, 'sample.pdf'), pdfDocument());
    await writeFile(path.join(cwd, 'sample.docx'), docxDocument());
    const server = await start({ port: 0, host: '127.0.0.1', dataDir: path.join(root, 'data'), defaultCwd: cwd, allowedRoots: [cwd], enableMockProvider: true });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(async () => { await stop(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

  it('requires authentication, current project trust and same-origin admission before reading', async () => {
    expect((await read('sample.docx', '')).status).toBe(401);
    expect((await read('sample.docx')).status).toBe(409);
    expect((await fetch(`${base}/api/workspaces/trust`, { method: 'POST', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, confirm: true }) })).status).toBe(200);
    expect((await read('sample.pdf', user, cwd, 'https://foreign.invalid')).status).toBe(403);
    const pdf = await read('sample.pdf', user);
    expect(pdf.status).toBe(200); expect(pdf.headers.get('Cache-Control')).toBe('no-store');
    expect(pdf.headers.get('Content-Type')).toContain('application/pdf');
    expect(pdf.headers.get('Content-Disposition')).toBe('attachment');
    expect(Buffer.from(await pdf.arrayBuffer())).toEqual(pdfDocument());
    const docx = await read('sample.docx', user);
    expect(docx.status).toBe(200);
    expect(await docx.json()).toEqual({ kind: 'docx', text: 'Read-only DOCX <script>literal</script>' });
  });

  it('refuses traversal, symbolic/hard links, wrong formats and bounded invalid data without parser diagnostics', async () => {
    await writeFile(path.join(root, 'outside.pdf'), pdfDocument());
    await symlink(path.join(root, 'outside.pdf'), path.join(cwd, 'escape.pdf'));
    await link(path.join(root, 'outside.pdf'), path.join(cwd, 'hard.pdf'));
    for (const filename of ['../outside.pdf', 'escape.pdf', 'hard.pdf']) expect((await read(filename)).ok).toBe(false);
    await writeFile(path.join(cwd, 'wrong.txt'), 'text');
    expect((await read('wrong.txt')).status).toBe(415);
    for (const filename of ['bad.pdf', 'bad.docx']) {
      await writeFile(path.join(cwd, filename), 'private parser diagnostic marker');
      const response = await read(filename);
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ code: 'FILE_PREVIEW_INVALID', error: 'Document preview unavailable.' });
    }
    await writeFile(path.join(cwd, 'large.pdf'), Buffer.alloc(2 * 1024 * 1024 + 1));
    expect((await read('large.pdf')).status).toBe(413);
  });

  it('redacts decoded DOCX text and refuses sensitive PDF bytes, preserving independent attachment downloads', async () => {
    await writeFile(path.join(cwd, 'secret.docx'), docxDocument(`<w:p><w:r><w:t>Before &#119;${admin.slice(1)} After</w:t></w:r></w:p>`));
    const text = await read('secret.docx').then(response => response.text());
    expect(text).toContain('Before'); expect(text).toContain('After'); expect(text).not.toContain(admin);
    await writeFile(path.join(cwd, 'secret.pdf'), Buffer.concat([pdfDocument(), Buffer.from(admin)]));
    expect((await read('secret.pdf')).status).toBe(409);
    const download = await fetch(`${base}/api/files/download?${new URLSearchParams({ cwd, path: 'sample.docx' })}`, { headers: { Authorization: `Bearer ${user}` } });
    expect(download.status).toBe(200); expect(Buffer.from(await download.arrayBuffer())).toEqual(docxDocument());
  });
});
