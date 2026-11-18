import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getCustomModelEditorSchema, MockProvider } from '@ai-harness/core';
import { start, stop } from '../index.js';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.js';

const sdkRequire = createRequire(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'));
const Ajv2020 = sdkRequire('ajv/dist/2020.js').default;
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addKeyword({ keyword: 'x-maxUtf16CodeUnits', schemaType: 'number', valid: true });
const validate = ajv.compile(getCustomModelEditorSchema());
let root: string, base: string, registry: string, services: RuntimeServices;
const body = { provider: 'mock', id: 'native-editor-http', name: 'Public native metadata',
  capabilities: { reasoning: false, imageInput: true, toolCalls: false }, contextWindow: 128000,
  maxOutputTokens: 4096, pricing: { inputPerMillion: 0, outputPerMillion: 1.25 }, compatibility: { flag: true, count: 2, label: 'public' } };
const admin = { authorization: 'Bearer disposable-editor-admin', 'content-type': 'application/json' };
beforeAll(async () => {
  vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'disposable-editor-user'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'disposable-editor-admin');
  root = await mkdtemp(path.join(os.tmpdir(), 'aih-editor-http-')); const cwd = path.join(root, 'work'); await mkdir(cwd);
  const dataDir = path.join(root, 'data'); registry = path.join(dataDir, 'providers.json');
  const server = await start({ host: '127.0.0.1', port: 0, dataDir, allowedRoots: [cwd], defaultCwd: cwd, enableMockProvider: true,
    runtimeServicesFactory: async (proxy, options) => { services = await createRuntimeServices(proxy, options); return services; },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await stop(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const post = (headers: Record<string, string>, data: unknown = body) => fetch(base + '/api/provider-registry/models', { method: 'POST', headers, body: JSON.stringify(data) });

describe('actual native HTTP model-registration editor boundary', () => {
  it.each([
    ['no authentication', { 'content-type': 'application/json' }, 401],
    ['ordinary role', { authorization: 'Bearer disposable-editor-user', 'content-type': 'application/json' }, 403],
    ['foreign browser Origin', { ...admin, origin: 'https://foreign-editor.invalid' }, 403],
  ] as const)('schema validity cannot authorize %s', async (_label, headers, status) => {
    expect(validate(body)).toBe(true); const before = await readFile(registry).catch(() => undefined);
    const save = vi.spyOn(services.providerRegistry, 'upsertModel');
    expect((await post(headers)).status).toBe(status); expect(save).not.toHaveBeenCalled();
    expect(await readFile(registry).catch(() => undefined)).toEqual(before);
  });
  it('registers, updates, reads and persists actual schema-valid data without provider/tool/MCP work', async () => {
    const observed = [vi.spyOn(MockProvider.prototype, 'chat'), vi.spyOn(MockProvider.prototype, 'streamChat'),
      vi.spyOn(services.agentRuntime, 'start'), vi.spyOn(services.extensionRegistry, 'executeTool'),
      vi.spyOn(services.extensionRegistry, 'executeHostedTool'), vi.spyOn(services.mcpHost, 'prepareForPrompt')];
    const response = await post({ ...admin, origin: base }); expect(response.status).toBe(201); expect(response.headers.get('cache-control')).toBe('no-store');
    const saved = await response.json(); expect(saved).toMatchObject(body); expect(saved.key).toBe('mock:native-editor-http');
    const changed = { ...body, name: 'Updated public metadata', maxOutputTokens: 8192 }; expect(validate(changed)).toBe(true);
    const update = await fetch(base + '/api/provider-registry/models/' + encodeURIComponent(saved.key), { method: 'PUT', headers: { ...admin, origin: base }, body: JSON.stringify(changed) });
    expect(update.status).toBe(200); expect(await update.json()).toMatchObject(changed);
    const read = await fetch(base + '/api/provider-registry/models', { headers: { authorization: 'Bearer disposable-editor-user' } });
    expect(read.status).toBe(200); expect(await read.json()).toEqual([expect.objectContaining(changed)]);
    expect(JSON.parse(await readFile(registry, 'utf8')).models).toEqual([expect.objectContaining(changed)]);
    for (const spy of observed) expect(spy).not.toHaveBeenCalled();
  });
  it('keeps provider membership and bounds as native HTTP admission, not editor authority', async () => {
    const state = await readFile(registry);
    const unknown = { ...body, provider: 'not_registered' }; expect(validate(unknown)).toBe(true);
    const unknownResponse = await post(admin, unknown); expect(unknownResponse.status).toBe(400); expect(await unknownResponse.json()).toMatchObject({ code: 'INVALID_MODEL' });
    const malformed = { ...body, contextWindow: 0 }; expect(validate(malformed)).toBe(false); expect((await post(admin, malformed)).status).toBe(400);
    expect(await readFile(registry)).toEqual(state);
  });
});
