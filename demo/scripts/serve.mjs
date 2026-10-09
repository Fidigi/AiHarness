import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateBase } from './base-path.mjs';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'demo-manifest.json'), 'utf8'));
const base = validateBase(manifest.base);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const allowed = new Set([...manifest.assets, base + 'sw.js', base + 'demo-manifest.json']);
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
  if (url.pathname === base.slice(0, -1) && base !== '/') { response.writeHead(308, { Location: base }); response.end(); return; }
  const asset = url.pathname === base ? base + 'index.html' : url.pathname;
  if (!allowed.has(asset)) { response.writeHead(404); response.end('Static demo asset not found.'); return; }
  try {
    const data = await readFile(path.join(root, asset.slice(base.length)));
    response.writeHead(200, { 'Content-Type': mime[path.extname(asset)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch { response.writeHead(404); response.end(); }
});
const host = process.env.DEMO_HOST ?? '127.0.0.1';
if (!['127.0.0.1', '0.0.0.0'].includes(host)) throw new Error('DEMO_HOST must be 127.0.0.1 or 0.0.0.0.');
server.listen(Number(process.env.DEMO_PORT ?? 4173), host, () => console.log(`Demo static host: http://${host}:${process.env.DEMO_PORT ?? 4173}${base}`));
