import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const execute = promisify(execFile);

/** No Vitest aliases in the child: actual Server composition consumes the built public Core package. */
describe('public package managed generation composition in a disposable Node process', () => {
  it('commits a managed tool, preserves rejected same-cwd candidates and safety-clears a failed workspace replacement', async () => {
    const serverEntry = pathToFileURL(path.resolve('packages/server/src/index.ts')).href;
    const servicesEntry = pathToFileURL(path.resolve('packages/server/src/runtime/services.ts')).href;
    const { stdout, stderr } = await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
      import os from 'node:os'; import path from 'node:path';
      import { AgentRuntime, ExtensionRegistry } from '@ai-harness/core';
      import { start, stop } from ${JSON.stringify(serverEntry)};
      import { createRuntimeServices } from ${JSON.stringify(servicesEntry)};
      process.env.AI_HARNESS_AUTH_TOKEN = 'public-generation-admin';
      process.env.AI_HARNESS_ADMIN_TOKEN = 'public-generation-admin';
      process.env.AI_HARNESS_PROVIDER_RENAME_EXCLUSIVE_HOST = '';
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-public-generation-'));
      const cwd = path.join(root, 'workspace'), next = path.join(root, 'next'), data = path.join(root, 'data');
      const file = workspace => path.join(workspace, '.ai-harness', 'extensions', 'generation.js');
      const source = version => 'export default function(api) { api.registerTool({name: "public_generation_ask", description: "Managed version ' + version + '", execute: async (_, ctx) => ({content: JSON.stringify({version: ' + version + ', results: await Promise.all([ctx.requestInteraction({kind: "confirm", title: "first"}), ctx.requestInteraction({kind: "confirm", title: "second"})])})})}); }';
      let services, callback, release = () => {}, providerWaiting = false;
      try {
        for (const workspace of [cwd, next]) await mkdir(path.dirname(file(workspace)), {recursive: true});
        const server = await start({port: 0, host: '127.0.0.1', dataDir: data, defaultCwd: cwd, allowedRoots: [cwd, next],
          runtimeServicesFactory: async (proxy, options) => (services = await createRuntimeServices(proxy, options))});
        assert.ok(services.agentRuntime instanceof AgentRuntime);
        assert.ok(services.extensionRegistry instanceof ExtensionRegistry);
        assert.equal(await services.workspaceManager.resolve(next, {kind: 'directory'}), next);
        await services.trustManager.trust(cwd); await services.trustManager.trust(next);
        assert.ok((await readFile(path.join(data, 'trust.json'), 'utf8')).includes(next));
        await writeFile(file(cwd), source(1));
        assert.deepEqual((await services.reloadResources({cwd})).errors, []);
        await services.extensionRegistry.load('public-observer', api => api.before('before:tool', event => {
          if (event.tool === 'public_generation_ask') callback = event.context.requestInteraction;
        }));
        const headers = {Authorization: 'Bearer public-generation-admin', 'Content-Type': 'application/json'};
        const post = (url, body) => fetch('http://127.0.0.1:' + server.port + '/api/' + url, {method: 'POST', headers, body: JSON.stringify(body)});
        const waitFor = async predicate => { for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Public generation probe deadline'); };
        async function begin() {
          providerWaiting = false;
          const held = new Promise(resolve => {release = resolve});
          services.resolveProvider('mock').streamChat = async (messages, chunk, complete) => {
            if (messages.some(m => m.role === 'tool')) {providerWaiting = true; await held; complete({content: 'done'});}
            else complete({content: '', toolCalls: [{id: 'public-generation-call', name: 'public_generation_ask', input: {}}]});
          };
          const response = await post('agent/runs', {cwd, provider: 'mock', input: 'ask', toolPreset: 'full', autoCompaction: false});
          assert.equal(response.status, 202); const {run} = await response.json();
          await waitFor(() => services.agentRuntime.getRun(run.id).extensionRequests.length === 2);
          return run;
        }
        async function revoked(run, old, version) {
          await waitFor(() => providerWaiting);
          assert.ok(services.agentRuntime.listRunning().some(item => item.id === run.id));
          const sequence = services.agentRuntime.journal.lastSequence(run.sessionId);
          assert.deepEqual(await old({kind: 'confirm', title: 'revoked while active'}), {cancelled: true});
          assert.equal(services.agentRuntime.journal.lastSequence(run.sessionId), sequence);
          assert.deepEqual(services.agentRuntime.getRun(run.id).extensionRequests, []);
          const events = services.agentRuntime.journal.replay(run.sessionId).events;
          const requests = events.filter(e => e.type === 'extension.ui' && e.data.action === 'request');
          for (const request of requests) {
            assert.equal(events.filter(e => e.type === 'extension.ui' && e.data.action === 'resolved' && e.data.requestId === request.data.request.id).length, 1);
            assert.equal((await post('agent/sessions/' + run.sessionId + '/interactions/' + request.data.request.id, {cancelled: true})).status, 404);
          }
          release(); assert.equal((await services.agentRuntime.wait(run.id)).phase, 'completed');
          const messages = services.sessionManager.get(run.sessionId).messages.filter(m => m.role === 'tool');
          assert.equal(messages.length, 1);
          assert.deepEqual(JSON.parse(messages[0].content), {version, results: [{cancelled: true}, {cancelled: true}]});
          assert.ok((await readFile(path.join(data, 'sessions', run.sessionId + '.jsonl'), 'utf8')).includes('public-generation-call'));
        }
        const first = await begin(), old = callback;
        const before = services.agentRuntime.getRun(first.id).extensionRequests;
        const original = services.extensionRegistry.getTools().find(t => t.name === 'public_generation_ask');
        await writeFile(file(cwd), 'export default syntax error');
        const failed = await post('agent/reload', {cwd}); assert.equal(failed.status, 200);
        assert.ok((await failed.json()).errors.length > 0);
        assert.deepEqual(services.agentRuntime.getRun(first.id).extensionRequests, before);
        const stillAuthorized = old({kind: 'confirm', title: 'survives failure'});
        assert.equal(services.agentRuntime.getRun(first.id).extensionRequests.length, 3);
        // Resolve this one to keep the managed tool's two own promises pending until commit.
        assert.equal((await post('agent/sessions/' + first.sessionId + '/interactions/' + stillAuthorized.id, {cancelled: false, value: true})).status, 200);
        assert.deepEqual(await stillAuthorized, {cancelled: false, value: true});
        await writeFile(file(cwd), source(2));
        const committed = await post('agent/reload', {cwd}); assert.equal(committed.status, 200);
        assert.deepEqual((await committed.json()).errors, []);
        const replacement = services.extensionRegistry.getTools().find(t => t.name === 'public_generation_ask');
        assert.equal(replacement.description, 'Managed version 2'); assert.notEqual(replacement.execute, original.execute);
        // Includes the individually accepted third request, which settled exactly once rather than being cancelled again.
        await waitFor(() => providerWaiting);
        assert.equal(services.agentRuntime.journal.replay(first.sessionId).events.filter(e => e.type === 'extension.ui' && e.data.action === 'resolved' && e.data.requestId === stillAuthorized.id).length, 1);
        assert.equal((await post('agent/sessions/' + first.sessionId + '/interactions/' + stillAuthorized.id, {cancelled: true})).status, 404);
        // Only the two managed requests belong in the revoked/cancelled assertion below.
        const events = services.agentRuntime.journal.replay(first.sessionId).events;
        for (const request of before) assert.equal(events.filter(e => e.type === 'extension.ui' && e.data.action === 'resolved' && e.data.requestId === request.id).length, 1);
        await revoked(first, old, 1);
        const second = await begin(), secondOld = callback;
        await writeFile(file(next), 'export default function() { throw new Error("trusted next candidate rejected"); }');
        const switched = await post('plugins/reload', {cwd: path.join(next, '..', 'next')}); assert.equal(switched.status, 200);
        const result = await switched.json(); assert.ok(result.reload.errors.some(e => e.message.includes('trusted next candidate rejected')));
        assert.equal(services.extensionRegistry.getTools().some(t => t.name === 'public_generation_ask'), false);
        assert.ok(services.extensionRegistry.getTools().some(t => t.name === 'read'));
        await revoked(second, secondOld, 2);
        process.stdout.write('PUBLIC_GENERATION_EVIDENCE ' + JSON.stringify({publicCore: true, sameCwdPreserved: true, managedToolCommit: true, failedWorkspaceSafetyClear: true, revokedWhileActive: true, stale404: true, settledOnce: true}) + '\\n');
      } finally {
        release();
        if (services) {
          for (const run of services.agentRuntime.listRunning()) {services.agentRuntime.stop(run.id); await services.agentRuntime.wait(run.id);}
          await rm(file(cwd), {force: true}); await rm(file(next), {force: true});
          assert.deepEqual((await services.reloadResources({cwd})).errors, []);
          await services.extensionRegistry.unload('public-observer');
        }
        await stop(); await rm(root, {recursive: true, force: true});
      }
    `], { timeout: 30_000, maxBuffer: 256_000 });
    expect(stderr).toBe('');
    const evidence = stdout.split('\n').find(line => line.startsWith('PUBLIC_GENERATION_EVIDENCE '))!;
    expect(JSON.parse(evidence.slice('PUBLIC_GENERATION_EVIDENCE '.length))).toEqual({
      publicCore: true, sameCwdPreserved: true, managedToolCommit: true, failedWorkspaceSafetyClear: true,
      revokedWhileActive: true, stale404: true, settledOnce: true,
    });
  }, 35_000);
});
