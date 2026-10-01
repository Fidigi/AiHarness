import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(import.meta.dirname, '../..');

describe('PWA static contract', () => {
  it('publishes an installable scoped manifest from the Web shell', async () => {
    const manifest = JSON.parse(await readFile(path.join(webRoot, 'public/manifest.webmanifest'), 'utf8')) as {
      start_url: string;
      scope: string;
      display: string;
      icons: Array<{ src: string; sizes: string; purpose: string }>;
    };
    const html = await readFile(path.join(webRoot, 'index.html'), 'utf8');

    expect(manifest).toMatchObject({ start_url: '/', scope: '/', display: 'standalone' });
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: '/icons/icon-192.png', sizes: '192x192' }),
      expect.objectContaining({ src: '/icons/icon-512.png', sizes: '512x512' }),
      expect.objectContaining({ src: '/icons/icon.svg', sizes: 'any' }),
    ]));
    expect(manifest.icons[0].purpose).toContain('maskable');
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
  });

  it('provides an offline fallback while explicitly excluding API requests from caches', async () => {
    const worker = await readFile(path.join(webRoot, 'public/sw.js'), 'utf8');
    const offline = await readFile(path.join(webRoot, 'public/offline.html'), 'utf8');

    expect(worker).toContain("url.pathname.startsWith('/api/')");
    expect(worker).toContain("caches.match('/offline.html')");
    expect(worker).toContain("event.data?.type === 'SKIP_WAITING'");
    expect(offline).toContain('AiHarness is offline');
    expect(offline).toContain('maximumAttempts = 3');
  });
});
