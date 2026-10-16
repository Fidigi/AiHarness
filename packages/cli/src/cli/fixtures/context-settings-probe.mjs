import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { JsonlSessionStore, ProjectTrustManager, SessionManager } from '@ai-harness/core';

const cli = process.env.AIH_CONTEXT_CLI ?? fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
const all = ['thresholds', 'gates', 'untrusted', 'trusted', 'saved-trust', 'abort', 'eof',
  'print-below', 'print-above', 'json-below', 'json-above'];
const scenarios = process.argv[2] ? [process.argv[2]] : all;
assert.ok(scenarios.every(value => all.includes(value)));
const outcomes = [];
for (const scenario of scenarios) {
  const headless = scenario.startsWith('print-') ? 'print' : scenario.startsWith('json-') ? 'json' : undefined;
  const bigContext = headless !== undefined || ['thresholds', 'gates'].includes(scenario);
  const root = await mkdtemp(path.join(tmpdir(), 'context-settings-process-'));
  const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
  const globalFile = path.join(agent, 'settings.json'), projectFile = path.join(cwd, '.ai-harness', 'settings.json');
  let child, passed = false, stderr = '', serverError;
  const requests = [], sockets = new Set();
  const server = createServer(async (request, response) => {
    try {
      let text = '';
      for await (const chunk of request) { text += chunk; assert.ok(Buffer.byteLength(text) <= 2 * 1024 * 1024); }
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions');
      const body = JSON.parse(text); requests.push(body);
      assert.equal(body.model, 'fixture-model'); assert.ok(!body.tools?.length);
      const usage = { prompt_tokens: 23, completion_tokens: 3, total_tokens: 26 };
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture-model',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'Done' }, finish_reason: null }] })}\n\n`
          + `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture-model',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`);
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'fixture-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Summary' }, finish_reason: 'stop' }], usage }));
      }
    } catch (error) { serverError = error; response.writeHead(500); response.end('Fixture rejected request'); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const deadline = (promise, label) => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${scenario}/${label}: ${stderr}`)), 5_000);
    })]).finally(() => clearTimeout(timer));
  };
  try {
    await mkdir(cwd); await mkdir(agent); await mkdir(path.dirname(projectFile));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const initialEnabled = !['gates', 'untrusted', 'trusted', 'saved-trust'].includes(scenario);
    const settings = (enabled, reserve = 10_000) => ({ quietStartup: true, sessionDir: sessions,
      enabledModels: ['local/*'], compaction: { enabled, reserveTokens: reserve === 10_000 ? 30_000 : 10_000,
        keepRecentTokens: 1_000, modelOverrides: { 'local/fixture-model': { reserveTokens: reserve, keepRecentTokens: 1_000 } } },
      branchSummary: { reserveTokens: 8_192 } });
    await writeFile(globalFile, JSON.stringify(settings(initialEnabled, headless && scenario.endsWith('above') ? 30_000 : 10_000)));
    const savedTrust = new ProjectTrustManager(path.join(agent, 'trust.json'));
    if (scenario === 'trusted' || scenario === 'saved-trust') await writeFile(projectFile, JSON.stringify({ compaction: { enabled: true } }));
    if (scenario === 'saved-trust') await savedTrust.trust(cwd);
    if (scenario === 'untrusted') await writeFile(projectFile, '{poisoned untrusted project data');
    const manager = new SessionManager({ store: new JsonlSessionStore(sessions) });
    const session = await manager.create({ title: 'Context settings', cwd });
    const originalIds = [];
    for (let index = 0; index < (bigContext ? 4 : 1); index++) {
      await manager.addMessage(session.id, { role: index % 2 ? 'assistant' : 'user',
        content: bigContext ? 'x'.repeat(110_000) : 'Root' });
      originalIds.push(session.activeLeafId);
    }
    const command = process.env.AIH_CONTEXT_COMMAND;
    const modeFlags = headless === 'print' ? ['--print'] : ['--mode', headless ?? 'rpc'];
    child = spawn(command ?? process.execPath, [...(command ? [] : [cli]), ...modeFlags, '--offline',
      ...(scenario === 'saved-trust' ? [] : [scenario === 'trusted' ? '--approve' : '--no-approve']),
      '--no-context-files', '--no-tools',
      '--model', 'local/fixture-model', '--session-id', session.id, ...(headless ? ['NextHeadless'] : [])], {
      cwd, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent,
        LOCAL_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, LOCAL_MODEL: 'fixture-model', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.on('data', data => { stderr += data; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    if (headless) {
      let stdout = ''; child.stdout.on('data', data => { stdout += data; }); child.stdin.end();
      assert.deepEqual(await deadline(exited, 'headless exit'), { code: 0, signal: null }, stderr);
      assert.equal(serverError, undefined, String(serverError));
      if (headless === 'print') assert.equal(stdout, 'Done\n');
      else {
        const events = stdout.trim().split('\n').map(line => JSON.parse(line));
        assert.ok(events.every(event => typeof event.type === 'string'));
        assert.ok(events.some(event => event.type === 'agent_end'));
        assert.ok(stdout.includes('Done')); assert.ok(!events.some(event => event.type === 'error'));
      }
      const compactions = scenario.endsWith('above') ? 1 : 0;
      assert.equal(requests.length, compactions + 1);
      assert.equal(requests.filter(request => !request.stream).length, compactions);
      const restored = new SessionManager({ store: new JsonlSessionStore(sessions) }); await restored.loadFromStore(session.id);
      const raw = await restored.getRawEntries(session.id);
      assert.equal(raw.filter(entry => entry.type === 'compaction').length, compactions);
      for (const id of originalIds) assert.ok(raw.some(entry => entry.id === id));
      outcomes.push({ scenario, requests: requests.length, compactions, summaries: 0, exit: 0 });
      console.log(JSON.stringify(outcomes.at(-1))); passed = true; continue;
    }
    const records = [], waiting = new Map(), eventWaiters = new Set();
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      const record = JSON.parse(line); records.push(record); assert.ok(records.length <= 256);
      if (record.type === 'response' && waiting.has(record.id)) { waiting.get(record.id)(record); waiting.delete(record.id); }
      for (const waiter of eventWaiters) if (records.length > waiter.after && waiter.predicate(record)) {
        eventWaiters.delete(waiter); waiter.resolve(record);
      }
    });
    const expectResponse = id => deadline(new Promise(resolve => waiting.set(id, resolve)), id);
    const rpc = request => { const response = expectResponse(request.id); child.stdin.write(`${JSON.stringify(request)}\n`); return response; };
    const state = async id => {
      const result = await rpc({ type: 'get_state', id }); assert.equal(result.success, true, JSON.stringify({ result, stderr })); return result.data;
    };
    const reload = async id => {
      const result = await rpc({ type: 'reload_context_settings', id });
      assert.equal(result.success, true, JSON.stringify({ result, stderr }));
      assert.deepEqual(result.data, { cancelled: false, reloaded: ['compaction', 'branchSummary'] }); return result;
    };
    const turn = async id => {
      const complete = deadline(new Promise(resolve => eventWaiters.add({ after: records.length,
        predicate: record => record.type === 'agent_end', resolve })), `${id}/settlement`);
      const response = await rpc({ type: 'prompt', id, message: id }); assert.equal(response.success, true, JSON.stringify(response));
      await complete; assert.equal(serverError, undefined, String(serverError));
      assert.ok(!records.some(record => record.type === 'error'), JSON.stringify(records.filter(record => record.type === 'error')));
    };
    const initial = await state('ready');
    assert.equal(initial.sessionFile, path.join(sessions, `${session.id}.jsonl`));
    assert.equal(initial.autoCompactionEnabled, scenario === 'trusted' || scenario === 'saved-trust' || initialEnabled);
    assert.equal(requests.length, 0, 'Startup is passive');
    if (scenario === 'thresholds') {
      const trap = path.join(agent, 'trap.mjs'), marker = path.join(root, 'executed-marker');
      await writeFile(trap, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'EXECUTED'); throw new Error('Must not execute');`);
      const next = { ...settings(true, 30_000), branchSummary: { reserveTokens: 300, skipPrompt: true },
        sessionDir: path.join(root, 'must-not-move'), defaultProvider: 'openai', defaultModel: 'must-not-switch', extensions: [trap] };
      await writeFile(globalFile, JSON.stringify(next));
      await turn('old-snapshot'); assert.equal(requests.length, 1); assert.equal(requests[0].stream, true);
      await reload('reload'); await turn('new-threshold');
      assert.equal(requests.length, 3); assert.ok(!requests[1].stream); assert.equal(requests[2].stream, true);
      const current = await state('same-runtime');
      assert.deepEqual(current.model, initial.model); assert.equal(current.sessionFile, initial.sessionFile);
      await assert.rejects(access(marker), { code: 'ENOENT' }); await assert.rejects(access(next.sessionDir), { code: 'ENOENT' });
      const tree = await rpc({ type: 'get_tree', id: 'tree' }); const source = tree.data.leafId;
      assert.equal((await rpc({ type: 'navigate_tree', id: 'plain', entryId: originalIds[0] })).success, true);
      assert.equal((await rpc({ type: 'navigate_tree', id: 'restore', entryId: source, summarize: false })).success, true);
      assert.equal(requests.length, 3, 'skipPrompt does not authorize provider work');
      const summary = await rpc({ type: 'navigate_tree', id: 'summary', entryId: originalIds[0], summarize: true });
      assert.equal(summary.success, true, JSON.stringify({ summary, stderr }));
      assert.equal(requests.length, 4); assert.equal(requests[3].max_tokens, 150);
    } else if (scenario === 'gates') {
      await rpc({ type: 'set_auto_compaction', id: 'local-on', enabled: true });
      assert.equal((await state('global-off')).autoCompactionEnabled, false);
      await turn('globally-disabled'); assert.equal(requests.length, 1);
      await writeFile(globalFile, JSON.stringify(settings(true, 30_000)));
      await rpc({ type: 'set_auto_compaction', id: 'local-off', enabled: false }); await reload('reload');
      assert.equal((await state('still-opted-out')).autoCompactionEnabled, false);
      await turn('locally-disabled'); assert.equal(requests.length, 2);
      await rpc({ type: 'set_auto_compaction', id: 'local-enable', enabled: true }); await turn('enabled');
      assert.equal(requests.length, 4); assert.ok(!requests[2].stream); assert.equal(requests[3].stream, true);
    } else if (scenario === 'untrusted') {
      await writeFile(globalFile, JSON.stringify(settings(true))); await reload('global-only');
      assert.equal((await state('enabled')).autoCompactionEnabled, true);
      await writeFile(globalFile, '{malformed global');
      const refused = await rpc({ type: 'reload_context_settings', id: 'refused' });
      assert.equal(refused.success, false); assert.equal(refused.error, 'Context settings could not be reloaded.');
      assert.equal((await state('unchanged')).autoCompactionEnabled, true);
      await writeFile(globalFile, JSON.stringify(settings(false))); await reload('recovered');
      assert.equal((await state('disabled')).autoCompactionEnabled, false);
    } else if (scenario === 'saved-trust') {
      await savedTrust.setDecision(cwd, false);
      await writeFile(projectFile, '{poisoned after saved refusal');
      await reload('saved-refusal');
      assert.equal((await state('global-after-refusal')).autoCompactionEnabled, false);
      await writeFile(projectFile, JSON.stringify({ compaction: { enabled: true } }));
      await savedTrust.trust(cwd); await reload('saved-allow');
      assert.equal((await state('project-after-allow')).autoCompactionEnabled, true);
    } else if (scenario === 'trusted') {
      await writeFile(globalFile, JSON.stringify(settings(true)));
      await writeFile(projectFile, JSON.stringify({ compaction: { enabled: false } })); await reload('project-wins');
      assert.equal((await state('project-disabled')).autoCompactionEnabled, false);
      await rm(projectFile); await reload('project-removed'); assert.equal((await state('global-restored')).autoCompactionEnabled, true);
      await writeFile(projectFile, JSON.stringify({ compaction: { reserveTokens: -1 } }));
      assert.equal((await rpc({ type: 'reload_context_settings', id: 'invalid-project' })).success, false);
      assert.equal((await state('still-enabled')).autoCompactionEnabled, true);
    } else {
      await writeFile(globalFile, JSON.stringify(settings(false)));
      const pending = expectResponse('cancelled-reload');
      if (scenario === 'abort') {
        const aborted = expectResponse('abort');
        child.stdin.write(`${JSON.stringify({ type: 'reload_context_settings', id: 'cancelled-reload' })}\n`
          + `${JSON.stringify({ type: 'abort', id: 'abort' })}\n`);
        assert.equal((await aborted).success, true);
      } else child.stdin.end(`${JSON.stringify({ type: 'reload_context_settings', id: 'cancelled-reload' })}\n`);
      const result = await pending; assert.equal(result.success, true, JSON.stringify({ result, stderr }));
      assert.deepEqual(result.data, { cancelled: true, reloaded: [] });
      if (scenario === 'abort') {
        assert.equal((await state('unpublished')).autoCompactionEnabled, true);
        await reload('explicit-next'); assert.equal((await state('published-next')).autoCompactionEnabled, false);
      }
    }
    if (scenario !== 'eof') child.stdin.end();
    assert.deepEqual(await deadline(exited, 'exit'), { code: 0, signal: null }, stderr);
    assert.equal(serverError, undefined, String(serverError));
    const restored = new SessionManager({ store: new JsonlSessionStore(sessions) }); await restored.loadFromStore(session.id);
    const raw = await restored.getRawEntries(session.id);
    for (const id of originalIds) assert.ok(raw.some(entry => entry.id === id), 'Retained durable history');
    const compactions = raw.filter(entry => entry.type === 'compaction').length;
    const summaries = raw.filter(entry => entry.type === 'branch_summary').length;
    assert.equal(compactions, ['thresholds', 'gates'].includes(scenario) ? 1 : 0);
    assert.equal(summaries, scenario === 'thresholds' ? 1 : 0);
    if (!['thresholds', 'gates'].includes(scenario)) assert.equal(requests.length, 0);
    outcomes.push({ scenario, requests: requests.length, compactions, summaries, exit: 0 });
    console.log(JSON.stringify(outcomes.at(-1))); passed = true;
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
    if (passed) await rm(root, { recursive: true, force: true }); else console.error(`Retained failed fixture: ${root}`);
  }
}
console.log(JSON.stringify({ result: 'CONTEXT_SETTINGS_PROCESS_OK', node: process.versions.node, cases: outcomes.length }));
