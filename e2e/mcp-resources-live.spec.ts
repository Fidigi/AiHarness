import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { OpenAiProvider } from '../packages/core/dist/index.js';
import { start, stop, getProxy } from '../packages/server/dist/index.js';
import { resourceProvider } from '../packages/core/src/mcp/fixtures/resource-provider.mjs';
import { expect, test, reserveReadBudget } from './fixtures/test-budget';

for (const locale of ['en', 'fr'] as const) test(`native ${locale} MCP resources, structured/images and session-bound binary download`, async ({ page }) => {
  const previous = { AI_HARNESS_AUTH_TOKEN: process.env.AI_HARNESS_AUTH_TOKEN, AI_HARNESS_ADMIN_TOKEN: process.env.AI_HARNESS_ADMIN_TOKEN };
  process.env.AI_HARNESS_AUTH_TOKEN = 'disposable-resource-user'; process.env.AI_HARNESS_ADMIN_TOKEN = 'disposable-resource-admin';
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-resource-browser-')), data = path.join(root, 'data'), cwd = path.join(root, 'work');
  const wire = await resourceProvider();
  try {
    await mkdir(data); await mkdir(cwd);
    const config = { mcpServers: { docs: { command: process.execPath,
      args: [fileURLToPath(new URL('../packages/core/src/mcp/fixtures/resource-server.mjs', import.meta.url))],
      env: { MCP_RICH_TOOL: 'yes', MCP_SECRET: 'disposable-resource-secret' } } } };
    await writeFile(path.join(data, 'mcp.json'), JSON.stringify(config));
    const server = await start({ host: '127.0.0.1', port: 0, dataDir: data, defaultCwd: cwd, allowedRoots: [root],
      webRoot: fileURLToPath(new URL('../packages/web/dist/', import.meta.url)), enableMockProvider: true });
    const base = `http://localhost:${server.port}`;
    // Only the provider is a disposable wire peer; MCP, trust, persistence and Web are native.
    getProxy().setCustomProvider('resources', new OpenAiProvider({ type: 'openai', baseUrl: wire.url, model: 'fixture', apiKey: 'opaque-fixture-provider-key' }));
    expect((await page.request.get(base + '/api/mcp/content/unknown/00000000-0000-4000-8000-000000000001')).status()).toBe(401);
    expect((await page.request.post(base + '/api/auth/login', { headers: { Origin: base }, data: { token: 'disposable-resource-admin' } })).status()).toBe(200);
    await reserveReadBudget(page.request, base);
    expect((await page.request.post(base + '/api/workspaces/trust', { headers: { Origin: base }, data: { cwd, confirm: true } })).status()).toBe(200);
    const started = await page.request.post(base + '/api/agent/runs', { headers: { Origin: base }, data: {
      cwd, provider: 'resources', model: 'fixture', input: 'Read MCP resources', toolPreset: 'read-only',
    } });
    expect(started.status()).toBe(202);
    const { run } = await started.json() as { run: { sessionId: string } };
    await page.addInitScript(value => localStorage.setItem('ai-harness-locale', value), locale);
    if (locale === 'fr') await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/chat/${run.sessionId}?cwd=${encodeURIComponent(cwd)}`);
    await expect(page.locator('.message.assistant').last()).toContainText('MCP resources complete');
    await expect(page.locator('.message.tool img[src^="data:image/png;base64,"]')).toHaveCount(2);
    await expect(page.locator('.message.tool')).toContainText(['resources', 'resourceTemplates', 'MCP returned no text', 'mcp-content:', '42']);
    const links = page.locator('a.mcp-content-download'); await expect(links).toHaveCount(2);
    expect(await page.locator('iframe').count()).toBe(0);
    expect(await page.evaluate(() => (globalThis as typeof globalThis & { mcpAppRan?: unknown }).mcpAppRan)).toBeUndefined();
    const href = await links.first().getAttribute('href'); expect(href).toMatch(new RegExp(`/api/mcp/content/${run.sessionId}/[a-f0-9-]{36}$`));
    const downloading = page.waitForEvent('download'); await links.first().click();
    const download = await downloading; expect(download.suggestedFilename()).toBe('mcp-content.bin');
    expect((await readFile((await download.path())!)).toString()).toBe('disposable-audio');
    const retained = await page.request.get(base + href!);
    expect(retained.status()).toBe(200); expect(retained.headers()['content-type']).toContain('application/octet-stream');
    expect(retained.headers()['content-security-policy']).toContain('sandbox'); expect(retained.headers()['x-content-type-options']).toBe('nosniff');
    expect(retained.headers()['cache-control']).toBe('no-store');
    expect((await page.request.get(base + href!.replace(run.sessionId, 'unknown-session'))).status()).toBe(404);
    await page.reload(); await expect(page.locator('.message.tool img[src^="data:image/png;base64,"]')).toHaveCount(2);
    expect(await page.locator('body').textContent()).not.toContain('disposable-resource-secret');
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain('disposable-resource-secret');
    expect(JSON.stringify(wire.observed)).not.toContain('ui://app'); expect(wire.failure()).toBeUndefined();
    config.mcpServers.docs.env.MCP_RICH_TOOL = 'changed'; await writeFile(path.join(data, 'mcp.json'), JSON.stringify(config));
    expect((await page.request.get(base + href!)).status()).toBe(404);
  } finally {
    await page.goto('about:blank').catch(() => undefined); await stop(); await wire.close(); await rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
