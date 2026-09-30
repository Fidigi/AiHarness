import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { start, stop } from './index.js';

const html = '<!doctype html><html><head><title>AiHarness Test</title></head><body>Web bundle</body></html>';

describe('combined Web server', () => {
  let webRoot = '';
  let baseUrl = '';

  beforeAll(async () => {
    webRoot = await mkdtemp(path.join(os.tmpdir(), 'ai-harness-web-'));
    await writeFile(path.join(webRoot, 'index.html'), html);
    const server = await start({ port: 0, host: '127.0.0.1', webRoot });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await stop();
    await rm(webRoot, { recursive: true, force: true });
  });

  it('serves the Web bundle from the root', async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('AiHarness Test');
  });

  it('uses the Web entry point as the SPA fallback', async () => {
    const response = await fetch(`${baseUrl}/settings`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Web bundle');
  });

  it('keeps API routes available on the same port', async () => {
    const response = await fetch(`${baseUrl}/api/providers`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('openai');
  });
});
