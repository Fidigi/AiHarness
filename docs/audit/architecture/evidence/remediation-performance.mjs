// Comparable synthetic workloads; run serially in pinned network-none images.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import * as core from '/app/packages/core/dist/index.js';
const root = await mkdtemp(path.join(os.tmpdir(), 'architecture-performance-'));
try {
  const provider = new core.OpenRouterProvider({ type: 'custom', apiKey: 'synthetic-audit-key' });
  const rows = core.getProviderPublishedModels(provider), target = rows.at(-1).id;
  assert.equal(rows.length, 393);
  const metadata = [];
  for (let sample = 0; sample < 5; sample++) {
    global.gc(); const heap = process.memoryUsage().heapUsed, cpu = process.cpuUsage(), started = performance.now();
    for (let index = 0; index < 500; index++) {
      assert.equal(core.getProviderPublishedModel('openrouter', target, provider).id, target);
      assert.ok(core.getSupportedThinkingLevels('openrouter', target, undefined, provider).length);
    }
    metadata.push({ wallMs: performance.now() - started, cpu: process.cpuUsage(cpu), transientHeapDelta: process.memoryUsage().heapUsed - heap });
  }
  const storage = [];
  for (const count of [10, 100, 500]) {
    const directory = path.join(root, String(count)); await mkdir(directory);
    let bytes = 0;
    for (let index = 0; index < count; index++) {
      const id = 'audit-' + index, now = 1_700_000_000_000;
      const entries = [{ id: 'meta-' + id, type: 'metadata', version: 2, schemaVersion: 2,
        timestamp: now, createdAt: now, updatedAt: now, title: id, cwd: root }];
      for (let message = 0; message < 64; message++) entries.push({ id: `${id}-m${message}`, type: 'message', version: 2,
        timestamp: now + message, role: message % 2 ? 'assistant' : 'user', content: 'Synthetic audit payload. '.repeat(24),
        ...(message ? { parentMessageId: `${id}-m${message - 1}` } : {}) });
      const body = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n'; bytes += Buffer.byteLength(body);
      await writeFile(path.join(directory, id + '.jsonl'), body, { mode: 0o600 });
    }
    const store = new core.JsonlSessionStore(directory), manager = new core.SessionManager({ store });
    const load = store.loadSession.bind(store); let calls = 0;
    store.loadSession = async id => { calls++; return load(id); };
    const passes = [];
    for (let pass = 0; pass < Number(process.argv[2]); pass++) {
      global.gc(); const heap = process.memoryUsage().heapUsed, cpu = process.cpuUsage(), started = performance.now(), before = calls;
      await manager.loadAllSessions();
      assert.equal(manager.list().length, count); assert.equal(manager.list()[0].messages.length, 64);
      passes.push({ wallMs: performance.now() - started, cpu: process.cpuUsage(cpu), loadCalls: calls - before,
        transientHeapDelta: process.memoryUsage().heapUsed - heap });
    }
    storage.push({ files: count, messagesPerFile: 64, bytes, passes });
  }
  console.log(JSON.stringify({ node: process.version, rows: rows.length, target, iterations: 500, metadata, storage,
    limits: 'Warm OS caches; five CPU/wall metadata batches, one staged-load sequence per size. Heap deltas are noisy transient observations, not total allocations/RSS or production latency. Startup load counts need separate actual-host controls.' }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
