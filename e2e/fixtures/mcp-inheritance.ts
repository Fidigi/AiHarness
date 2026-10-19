import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { APIRequestContext } from '@playwright/test';
import type { McpConfigInventory } from '@ai-harness/core';
// The documented emitted native Server application, not a mocked route or a private Core alias.
import { start, stop } from '../../packages/server/dist/index.js';

export async function nativeMcpInheritance(request: APIRequestContext) {
  const previous = { AI_HARNESS_AUTH_TOKEN: process.env.AI_HARNESS_AUTH_TOKEN,
    AI_HARNESS_ADMIN_TOKEN: process.env.AI_HARNESS_ADMIN_TOKEN };
  const user = `fixture-user-${randomUUID()}`, admin = `fixture-admin-${randomUUID()}`;
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-mcp-browser-'));
  const cwd = path.join(root, 'project'), data = path.join(root, 'agent'), log = path.join(root, 'invocations.jsonl');
  const starts = path.join(root, 'starts.jsonl'), wrapper = path.join(root, 'native-peer.mjs');
  const globalFile = path.join(data, 'mcp.json'), projectFile = path.join(cwd, '.ai-harness/mcp.json');
  const peer = fileURLToPath(new URL('../../packages/core/src/mcp/fixtures/test-server.mjs', import.meta.url));
  const webRoot = fileURLToPath(new URL('../../packages/web/dist/', import.meta.url));
  const globalBytes = JSON.stringify({ version: 1, mcpServers: { shared: {
    command: process.execPath, args: [wrapper], enabled: false, exposure: 'hidden', toolExposure: { '*': 'hidden' },
    env: { MCP_TEST_CALL_LOG: log, INHERITED_SECRET: 'GLOBAL_INHERITANCE_BROWSER_PRIVATE' },
  } } });
  const controls = { enabled: true, exposure: 'direct', toolExposure: { '*': 'hidden', lookup: 'direct' } };
  const localBytes = JSON.stringify({ version: 1, mcpServers: { shared: controls } });
  await mkdir(data, { recursive: true }); await mkdir(path.dirname(projectFile), { recursive: true });
  // A real native peer startup witness; protocol comes unchanged from the owning fixture.
  await writeFile(wrapper, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(starts)}, JSON.stringify({ pid: process.pid }) + '\\n');\nawait import(${JSON.stringify(pathToFileURL(peer).href)});\n`);
  await writeFile(globalFile, globalBytes); await writeFile(projectFile, localBytes); await chmod(projectFile, 0o640);
  process.env.AI_HARNESS_AUTH_TOKEN = user; process.env.AI_HARNESS_ADMIN_TOKEN = admin;
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    try { await stop(); }
    finally {
      try { await rm(root, { recursive: true, force: true }); }
      finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
      }
    }
  };
  try {
    const server = await start({ host: '127.0.0.1', port: 0, webRoot, dataDir: data,
      defaultCwd: cwd, allowedRoots: [root], enableMockProvider: true });
    // A genuine separate host-only cookie origin, not a rewrite of auth/Origin.
    // Keeps this fixture's cookie separate from the ordinary 127.0.0.1 dev server.
    const base = `http://localhost:${server.port}`;
    const login = await request.post(base + '/api/auth/login', { headers: { Origin: base }, data: { token: admin } });
    if (login.status() !== 200) throw new Error(`Native fixture login failed: ${login.status()}`);
    const lockedResponse = await request.get(`${base}/api/mcp?cwd=${encodeURIComponent(cwd)}`);
    if (lockedResponse.status() !== 200) throw new Error(`Native fixture inventory failed: ${lockedResponse.status()}`);
    const locked = await lockedResponse.json() as McpConfigInventory;
    if (locked.files.find(file => file.scope === 'project')?.contentRead !== false
      || locked.servers.some(server => server.scope === 'project')) throw new Error('Native pretrust project inventory was not passive.');
    const trust = await request.post(base + '/api/workspaces/trust', { headers: { Origin: base }, data: { cwd, confirm: true } });
    if (trust.status() !== 200) throw new Error(`Native fixture trust failed: ${trust.status()}`);
    const inventory = async () => {
      const response = await request.get(`${base}/api/mcp?cwd=${encodeURIComponent(cwd)}`);
      if (response.status() !== 200) throw new Error(`Native fixture inventory failed: ${response.status()}`);
      return { data: await response.json() as McpConfigInventory, status: response.status(), headers: response.headers() };
    };
    return { base, cwd, log, starts, globalFile, projectFile, globalBytes, localBytes, controls, inventory, close,
      async local() { return JSON.parse(await readFile(projectFile, 'utf8')) as unknown; },
      async setInvalid() { await writeFile(projectFile, JSON.stringify({ mcpServers: { shared: { env: { TOKEN: 'PRIVATE_PROJECT_REDIRECT' } } } })); },
      async setOrphan() { await writeFile(projectFile, localBytes); await writeFile(globalFile, '{"mcpServers":{}}'); },
    };
  } catch (error) { await close(); throw error; }
}
