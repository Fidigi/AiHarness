// Synthetic, network-isolated audit probes. No real account, user store or product mutation.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
const scratch = await mkdtemp(path.join(os.tmpdir(), 'aih-architecture-audit-'));
try {
  const importStart = performance.now();
  const core = await import('/app/packages/core/dist/index.js');
  const coreImportMs = performance.now() - importStart;
  const startup = [];
  for (let sample = 0; sample < 5; sample++) {
    const started = performance.now();
    const child = spawnSync(process.execPath, ['/app/packages/cli/dist/index.js', '--help'], {
      cwd: scratch, timeout: 30_000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: scratch, AI_HARNESS_AGENT_DIR: path.join(scratch, 'agent'), AI_HARNESS_OFFLINE: '1' },
    });
    assert.equal(child.status, 0); assert.equal(child.signal, null); assert.equal(child.error, undefined);
    assert.ok(child.stdout.includes(Buffer.from('ai-harness')));
    startup.push({ wallMs: performance.now() - started, stdoutBytes: child.stdout.length, stderrBytes: child.stderr.length });
  }
  const provider = new core.OpenRouterProvider({ type: 'custom', apiKey: 'synthetic-audit-key' });
  const rows = core.getProviderPublishedModels(provider);
  assert.ok(rows?.length > 300);
  const target = rows.at(-1).id, snapshot = new Map(rows.map(row => [row.id, row]));
  const metadata = { modelCount: rows.length, target, iterations: 500, freshProjectionMs: [], requestLocalSnapshotLookupMs: [] };
  for (let sample = 0; sample < 5; sample++) {
    let started = performance.now();
    for (let i = 0; i < metadata.iterations; i++) assert.equal(core.getProviderPublishedModel('openrouter', target, provider)?.id, target);
    metadata.freshProjectionMs.push(performance.now() - started);
    started = performance.now();
    for (let i = 0; i < metadata.iterations; i++) assert.equal(snapshot.get(target)?.id, target);
    metadata.requestLocalSnapshotLookupMs.push(performance.now() - started);
  }
  const storage = [];
  for (const count of [10, 100]) {
    const directory = path.join(scratch, 'sessions-' + count); await mkdir(directory, { mode: 0o700 });
    let bytes = 0;
    for (let i = 0; i < count; i++) {
      const id = 'audit-session-' + i, now = 1_700_000_000_000;
      const entries = [{ id: 'metadata-' + id, type: 'metadata', version: 2, schemaVersion: 2,
        timestamp: now, createdAt: now, updatedAt: now, title: id, cwd: scratch }];
      for (let j = 0; j < 64; j++) entries.push({ id: `${id}-m${j}`, type: 'message', version: 2,
        timestamp: now + j, role: j % 2 ? 'assistant' : 'user', content: 'Synthetic audit payload. '.repeat(24),
        ...(j ? { parentMessageId: `${id}-m${j - 1}` } : {}) });
      const body = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n'; bytes += Buffer.byteLength(body);
      await writeFile(path.join(directory, id + '.jsonl'), body, { mode: 0o600 });
    }
    const store = new core.JsonlSessionStore(directory), manager = new core.SessionManager({ store });
    const load = store.loadSession.bind(store); let calls = 0;
    store.loadSession = async id => { calls++; return load(id); };
    const passes = [];
    for (let pass = 0; pass < 2; pass++) {
      const before = calls, started = performance.now(); await manager.loadAllSessions();
      assert.equal(manager.list().length, count);
      assert.equal(manager.list()[0].messages.length, 64);
      passes.push({ wallMs: performance.now() - started, loadSessionCalls: calls - before });
    }
    storage.push({ files: count, messagesPerFile: 64, bytes, passes });
  }
  const { handleRpcRequest } = await import('/app/packages/cli/dist/rpc/rpc-server.js');
  const manager = new core.SessionManager(), session = await manager.create({ title: 'Synthetic legacy RPC' });
  let receivedSignal = false, requestedTools = false;
  const events = [];
  const legacyProvider = {
    getConfiguredModel: () => 'synthetic-model',
    streamChat: async (_messages, chunk, complete, _error, options) => {
      receivedSignal = Boolean(options?.signal); requestedTools = Boolean(options?.tools?.length);
      await chunk('Synthetic reply');
      await complete({ content: 'Synthetic reply', model: 'synthetic-model', toolCalls: [{ id: 'never-executed', name: 'synthetic_tool', input: {} }] });
    },
  };
  const response = await handleRpcRequest({ id: 'legacy', method: 'chat.send', params: { sessionId: session.id, content: 'Synthetic input' } },
    { sessionManager: manager, providers: new Map([['mock', legacyProvider]]), emit: record => { events.push(record.event); } });
  assert.equal(response.result.content, 'Synthetic reply');
  assert.equal(manager.get(session.id).messages.length, 2);
  const legacy = { receivedSignal, requestedTools, eventNames: events,
    responseToolCalls: response.result.toolCalls.length, persistedAssistantToolCalls: manager.get(session.id).messages.at(-1).toolCalls?.length ?? 0 };
  assert.equal(receivedSignal, false); assert.equal(requestedTools, false);
  const framingRoot = path.join(scratch, 'framing'), framingHome = path.join(scratch, 'home');
  await mkdir(framingRoot); await mkdir(framingHome);
  const framingCode = `
    import { Readable } from 'node:stream';
    import { runRpcMode } from '/app/packages/cli/dist/rpc/rpc-server.js';
    const line = JSON.stringify({id:'oversized-audit',method:'system.ping',params:{padding:'x'.repeat(8*1024*1024)}})+'\\n';
    let accepted = false;
    await runRpcMode({offline:true,noSession:true,noExtensions:true,noMcp:true,noSkills:true,noPromptTemplates:true,noTools:true,projectTrust:false,
      input:Readable.from([line]),output:record=>{if(record.id==='oversized-audit'&&record.result?.ok===true)accepted=true;}});
    process.stdout.write(JSON.stringify({inputBytes:Buffer.byteLength(line),accepted}));`;
  const framingChild = spawnSync(process.execPath, ['--input-type=module', '-e', framingCode], {
    cwd: framingRoot, timeout: 30_000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: framingHome, AI_HARNESS_AGENT_DIR: path.join(framingHome, '.ai-harness'), AI_HARNESS_OFFLINE: '1' },
  });
  assert.equal(framingChild.status, 0); assert.equal(framingChild.signal, null); assert.equal(framingChild.error, undefined);
  const framing = JSON.parse(framingChild.stdout.toString()); assert.equal(framing.accepted, true);
  process.stdout.write(JSON.stringify({ node: process.version, coreImportMs, startup, metadata, storage, legacy, framing,
    limits: 'Local synthetic observations only. Startup samples use warm OS caches. Snapshot lookup is an illustrative local alternative, not a product patch or validated cache. Storage sizes use one two-pass sequence each, not a distribution. No browser render, vendor, production or global-suite qualification.' }, null, 2) + '\n');
} finally { await rm(scratch, { recursive: true, force: true }); }
