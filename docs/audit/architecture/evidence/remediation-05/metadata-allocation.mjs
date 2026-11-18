// Allocation sampling of the same bounded native cohort; no object/credential values.
import assert from 'node:assert/strict';
import { Session } from 'node:inspector';
import { promisify } from 'node:util';
import * as core from '/app/packages/core/dist/index.js';
const inspector = new Session(); inspector.connect();
const post = promisify(inspector.post.bind(inspector));
try {
  const provider = new core.OpenRouterProvider({ type: 'custom', apiKey: 'synthetic-audit-key' });
  const rows = core.getProviderPublishedModels(provider), target = rows.at(-1).id;
  assert.equal(rows.length, 393);
  global.gc();
  await post('HeapProfiler.startSampling', { samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  for (let index = 0; index < 500; index++) {
    assert.equal(core.getProviderPublishedModel('openrouter', target, provider).id, target);
    assert.ok(core.getSupportedThinkingLevels('openrouter', target, undefined, provider).length);
  }
  const { profile } = await post('HeapProfiler.stopSampling');
  const frames = [];
  function visit(node) {
    if (node.selfSize) frames.push({ function: node.callFrame.functionName, url: node.callFrame.url, bytes: node.selfSize });
    node.children.forEach(visit);
  }
  visit(profile.head);
  console.log(JSON.stringify({ modelCount: rows.length, target, pairedReads: 500, samplingInterval: 32768,
    sampledAllocatedBytes: frames.reduce((sum, frame) => sum + frame.bytes, 0), frames: frames.sort((a, b) => b.bytes - a.bytes),
    profile, limits: 'V8 probabilistic allocation sampling, including collected objects. Not exact total allocation, retained heap/RSS, or production latency. Separate from the uninstrumented CPU/wall probe; contains stack metadata only, not object values.' }, null, 2));
} finally { inspector.disconnect(); }
