import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const execute = promisify(execFile);

describe('public built Core interaction queue in disposable Node process', () => {
  it.each([false, true])('settles concurrent requests and durable results (stop=%s)', async stop => {
    const entry = pathToFileURL(path.resolve('packages/core/dist/index.js')).href;
    const { stdout, stderr } = await execute(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { mkdtemp, readFile, rm } from 'node:fs/promises';
      import os from 'node:os'; import path from 'node:path';
      import { AgentRuntime, ExtensionRegistry, MockProvider, SessionManager, JsonlSessionStore } from ${JSON.stringify(entry)};
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-queue-process-'));
      try {
        const manager = new SessionManager({store: new JsonlSessionStore(root)});
        const session = await manager.create({title: 'Process interactions'});
        const registry = new ExtensionRegistry();
        let ready; const started = new Promise(resolve => {ready = resolve}); let handles; let ctx;
        await registry.load('process', api => api.registerTool({name: 'ask', description: 'ask', execute: async (_, context) => {
          ctx = context;
          await context.onProgress({version: 1, content: 'before interaction'});
          handles = [context.requestInteraction({kind: 'confirm', title: 'first', timeoutMs: 100}), context.requestInteraction({kind: 'input', title: 'second'})];
          ready(); return {content: JSON.stringify(await Promise.all(handles))};
        }}));
        const provider = new MockProvider({type: 'mock'});
        provider.streamChat = async (messages, chunk, complete) => complete(messages.some(m => m.role === 'tool') ? {content: 'done'} : {content: '', toolCalls: [{id: 'public-outer', name: 'ask', input: {}}]});
        const runtime = new AgentRuntime({sessionManager: manager, extensionRegistry: registry, resolveProvider: () => provider, isProjectTrusted: () => true});
        const run = await runtime.start({sessionId: session.id, cwd: root, provider: 'mock', input: 'ask'}); await started;
        assert.deepEqual(runtime.snapshot(session.id).run.extensionRequests.map(r => r.id), handles.map(h => h.id));
        const events = []; const off = runtime.journal.subscribe(session.id, e => events.push(e));
        if (${stop}) runtime.stop(run.id);
        else {
          handles[0].update({kind: 'confirm', title: 'same ID replacement'});
          runtime.respondToInteraction(session.id, handles[1].id, {cancelled: false, value: 'answer'});
          assert.equal(runtime.snapshot(session.id).run.extensionRequest.id, handles[0].id);
        }
        const result = await runtime.wait(run.id); off();
        const settled = await Promise.all(handles);
        assert.equal(settled[0].cancelled, true); assert.equal(settled[1].cancelled, ${stop});
        assert.equal(result.phase, ${JSON.stringify(stop ? 'stopped' : 'completed')});
        assert.deepEqual(result.extensionRequests, []);
        const tools = session.messages.filter(m => m.role === 'tool'); assert.equal(tools.length, 1);
        assert.equal(tools[0].metadata.toolProgress.status, ${JSON.stringify(stop ? 'cancelled' : 'completed')});
        const disk = await readFile(path.join(root, session.id + '.jsonl'), 'utf8'); assert.ok(disk.includes('public-outer')); assert.ok(disk.includes('before interaction'));
        assert.equal(events.filter(e => e.type === 'extension.ui' && e.data.action === 'resolved').length, 2);
        const terminal = events.find(e => e.type === ${JSON.stringify(stop ? 'run.stopped' : 'run.completed')});
        assert.ok(events.filter(e => e.type === 'extension.ui').every(e => e.sequence < terminal.sequence));
        const sequence = runtime.snapshot(session.id).lastSequence;
        assert.equal(handles[0].close(), false); assert.equal(handles[1].close(), false);
        assert.deepEqual(await ctx.requestInteraction({kind: 'confirm', title: 'late'}), {cancelled: true});
        assert.equal(runtime.snapshot(session.id).lastSequence, sequence);
        process.stdout.write(JSON.stringify({phase: result.phase, settled: settled.length, tools: tools.length}) + '\\n');
      } finally { await rm(root, {recursive: true, force: true}); }
    `], { timeout: 15_000, maxBuffer: 128_000 });
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({ phase: stop ? 'stopped' : 'completed', settled: 2, tools: 1 });
  }, 20_000);
});
