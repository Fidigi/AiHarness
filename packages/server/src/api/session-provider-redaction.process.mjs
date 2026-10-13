import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '../../../core/dist/index.js';
import { start, stop } from '../../dist/index.js';
import { createRuntimeServices } from '../../dist/runtime/services.js';

// Use emitted entries in a plain Node child, not Vitest aliases or mocked HTTP.
const kind = process.argv[2];
assert.ok(['cold', 'boundary'].includes(kind));
const root = await mkdtemp(path.join(os.tmpdir(), 'aih-session-provider-http-'));
const cwd = path.join(root, 'workspace');
const dataDir = path.join(root, 'private');
await mkdir(cwd);
try {
  let services;
  const server = await start({ port: 0, host: '127.0.0.1', dataDir, allowedRoots: [cwd], defaultCwd: cwd,
    enableMockProvider: true,
    runtimeServicesFactory: async (proxy, options) => services = await createRuntimeServices(proxy, options) });
  assert.ok(services.sessionManager instanceof SessionManager);
  const get = async route => {
    const response = await fetch(`http://127.0.0.1:${server.port}${route}`);
    assert.equal(response.status, 200, route);
    const body = await response.text();
    assert.equal(body.includes('fixture-secret'), false, route);
    return JSON.parse(body);
  };
  const safe = { type: 'custom', model: 'safe-model', baseUrl: 'https://example.invalid/v1',
    headers: { 'X-Region': 'eu' }, options: [{ label: 'safe' }] };

  if (kind === 'cold') {
    const borrowed = await services.sessionManager.create({ cwd, title: 'Persisted profile', providerConfig: safe });
    const bytes = await readFile(path.join(dataDir, 'sessions', `${borrowed.id}.jsonl`));
    let getterCalls = 0;
    // A host-only volatile override is not a supported persistence operation.
    borrowed.providerConfig = { type: 'custom', model: 'volatile-only', refreshToken: 'cold-fixture-secret' };
    Object.defineProperty(borrowed.providerConfig, 'opaque', {
      enumerable: true, get() { getterCalls++; return 'getter-fixture-secret'; },
    });
    assert.equal(services.sessionManager.get(borrowed.id), borrowed);
    const wire = await get(`/api/sessions/${borrowed.id}`);
    assert.deepEqual(wire.providerConfig, safe);
    assert.notEqual(services.sessionManager.get(borrowed.id), borrowed);
    assert.deepEqual(services.sessionManager.get(borrowed.id).providerConfig, safe);
    assert.equal(borrowed.providerConfig.model, 'volatile-only');
    assert.equal(getterCalls, 0);
    assert.deepEqual(await readFile(path.join(dataDir, 'sessions', `${borrowed.id}.jsonl`)), bytes);
  } else {
    // The first protected request loads credentials and rewrites/reloads legacy
    // sessions. Complete that real boundary before borrowing a runtime object.
    assert.deepEqual(await get('/api/sessions'), []);
    const source = await services.sessionManager.create({ cwd, title: 'Safe profile', providerConfig: safe,
      messages: [{ id: 'question', role: 'user', content: 'Unchanged history', timestamp: new Date(0) }] });
    const bytes = await readFile(path.join(dataDir, 'sessions', `${source.id}.jsonl`));
    let getterCalls = 0;
    let toJSONCalls = 0;
    const nested = { label: 'safe', clientSecret: 'nested-fixture-secret',
      toJSON() { toJSONCalls++; return { label: 'callback-fixture-secret' }; } };
    const config = { ...safe, refreshToken: 'root-fixture-secret',
      headers: { Authorization: 'header-fixture-secret', 'X-Region': 'eu' }, options: [nested] };
    Object.defineProperty(config, 'opaque', {
      enumerable: true, get() { getterCalls++; return 'getter-fixture-secret'; },
    });
    source.providerConfig = config;
    for (const route of [`/api/sessions/${source.id}`, `/api/sessions/${source.id}?messageLimit=0`,
      '/api/sessions', '/api/sessions?messageLimit=0']) {
      const wire = await get(route);
      const session = Array.isArray(wire) ? wire.find(entry => entry.id === source.id) : wire;
      assert.ok(session, route);
      assert.deepEqual(session.providerConfig, safe, route);
      assert.equal(session.title, 'Safe profile');
      assert.equal(session.cwd, cwd);
      if (route.includes('messageLimit=0')) assert.deepEqual(session.messages, []);
      else assert.deepEqual(session.messages.map(message => message.content), ['Unchanged history']);
      assert.equal(getterCalls, 0, route);
      assert.equal(toJSONCalls, 0, route);
    }
    assert.equal(services.sessionManager.get(source.id), source);
    assert.equal(source.providerConfig, config);
    assert.equal(config.refreshToken, 'root-fixture-secret');
    assert.equal(config.options[0], nested);
    assert.equal(nested.clientSecret, 'nested-fixture-secret');
    assert.equal(typeof Object.getOwnPropertyDescriptor(config, 'opaque').get, 'function');
    assert.deepEqual((await services.sessionStore.loadSession(source.id)).providerConfig, safe);
    assert.deepEqual(await readFile(path.join(dataDir, 'sessions', `${source.id}.jsonl`)), bytes);
  }
  assert.equal(services.sessionManager.list().length, 1);
  assert.deepEqual(services.agentRuntime.listRunning(), []);
  assert.equal(services.agentRuntime.getSessionRun(services.sessionManager.list()[0].id), undefined);
  assert.equal(await services.trustManager.isTrusted(cwd), false);
  console.log(`SESSION_PROVIDER_HTTP_OK ${kind}`);
} finally {
  await stop();
  await rm(root, { recursive: true, force: true });
}
