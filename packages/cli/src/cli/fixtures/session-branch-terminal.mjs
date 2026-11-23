import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { createRequire } from 'node:module';
import { text as readText } from 'node:stream/consumers';

// Poll only LF-complete records. A concurrent append may expose a partial suffix;
// malformed completed records must still fail rather than being silently ignored.
function completeTraceRecords(value) {
  return value.slice(0, value.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line));
}
if (process.argv[2] === '--trace-records') {
  const output = JSON.stringify(completeTraceRecords(await readText(process.stdin))) + '\n';
  await new Promise((resolve, reject) => process.stdout.write(output, error => error ? reject(error) : resolve()));
  process.exit(0);
}

// The driver uses test-image PTY tooling; the child still executes the installed PATH-bin.
const pty = createRequire(import.meta.url)(process.env.AIH_TEST_PTY_MODULE ?? 'node-pty');
const scenario = process.argv[2], phase = process.argv[3] ?? 'all';
assert.ok(['all', 'cancellation', 'copies'].includes(phase));
assert.ok(['regular-memory', 'regular-durable', 'fullscreen-memory', 'fullscreen-durable'].includes(scenario));
const mode = scenario.startsWith('regular') ? 'regular' : 'fullscreen', durable = scenario.endsWith('durable');
const root = await mkdtemp(path.join(os.tmpdir(), 'branch-lifetime-terminal-'));
console.log(JSON.stringify({ root, scenario, phase, node: process.versions.node }));
const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions'), trace = path.join(root, 'trace.jsonl');
const readinessRelease = path.join(root, 'readiness-release');
await mkdir(cwd); await mkdir(agent); await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ quietStartup: true }));
const sourceId = 'branch-terminal-source', sourceFile = path.join(sessions, `${sourceId}.jsonl`);
await writeFile(path.join(agent, 'branch.mjs'), `import assert from 'node:assert/strict';
import {appendFile,readFile} from 'node:fs/promises';
import {MockProvider,SessionManager} from '@ai-harness/core';
const record=async value=>appendFile(${JSON.stringify(trace)},JSON.stringify(value)+'\\n');
let policy=process.env.AIH_BRANCH_STARTUP_VETO==='1'?'startup-veto':'allow';
class FixtureProvider extends MockProvider { async chat(){await record({kind:'fallback'});return {content:'UNEXPECTED_FALLBACK',model:'fixture-model'};} }
export default api=>{
  assert.equal(api.version,1);api.registerProvider('statefixture',{defaultConfig:{model:'fixture-model'},create:config=>new FixtureProvider(config)});
  api.registerCommand('branch-probe',{description:'Observe a freshly settled branch generation',handler:async(args,context)=>{
    const [operation,tag]=args.split(/\\s+/u),manager=context.sessionManager,id=context.currentSessionId;
    assert.ok(manager instanceof SessionManager);assert.equal(id,${JSON.stringify(sourceId)});
    if(operation==='readiness'){
      context.notify('BRANCH_COMMAND_OUTPUT_PENDING');
      while(!await readFile(${JSON.stringify(readinessRelease)},'utf8').catch(()=>''))await new Promise(resolve=>setTimeout(resolve,10));
      return 'BRANCH_COMMAND_OUTPUT_SETTLED';
    }
    if(operation==='setup'){
      await manager.addMessage(id,{role:'user',content:'Shared user'});
      await manager.appendCustomEntry(id,'fixture:branch-state',{revision:1,private:'NEVER_TERMINAL_STATE'});
      await manager.appendCustomMessage(id,'fixture:branch-note','MODEL_CUSTOM_NOTE',{display:false,details:{private:'NEVER_TERMINAL_DETAILS'}});
      await manager.addMessage(id,{role:'user',content:'Selected user'});
      await manager.addMessage(id,{role:'assistant',content:'Abandoned answer'});
      await manager.appendCustomEntry(id,'fixture:branch-state',{revision:2});
    }else if(operation==='policy') policy=tag;
    const inventory=[];
    for(const session of manager.list()) inventory.push({id:session.id,leaf:session.activeLeafId,
      raw:await manager.getRawEntries(session.id),active:await manager.getActiveBranchEntries(session.id)});
    inventory.sort((a,b)=>a.id.localeCompare(b.id));
    const model=JSON.stringify(manager.getEffectiveContext(id));assert.ok(!model.includes('NEVER_TERMINAL_STATE'));assert.ok(!model.includes('NEVER_TERMINAL_DETAILS'));
    await record({kind:'observed',operation,tag,id,inventory,model});return 'BRANCH_GENERATION_SETTLED_'+tag;
  }});
  api.before('before:session:branch',async event=>{
    assert.ok(Object.isFrozen(event));assert.equal(event.sourceSessionId,${JSON.stringify(sourceId)});assert.ok(event.signal instanceof AbortSignal);
    const tag=policy;if(tag.endsWith('hold'))event.signal.addEventListener('abort',()=>{void record({kind:'aborted',tag});},{once:true});
    await record({kind:'branch-hook',tag,operation:event.operation,entryId:event.entryId,position:event.position,aborted:event.signal.aborted});
    if(tag.endsWith('hold'))return new Promise(()=>{});
    if(tag.endsWith('veto'))return {cancel:true};
  });
  api.before('before:session:summary',async event=>{
    assert.ok(Object.isFrozen(event));assert.equal(event.sourceSessionId,${JSON.stringify(sourceId)});
    assert.ok(event.transcript.includes('MODEL_CUSTOM_NOTE'));assert.ok(!event.transcript.includes('NEVER_TERMINAL_STATE'));assert.ok(!event.transcript.includes('NEVER_TERMINAL_DETAILS'));
    const tag=policy;if(tag.endsWith('hold'))event.signal.addEventListener('abort',()=>{void record({kind:'aborted',tag});},{once:true});
    await record({kind:'summary-hook',tag,from:event.fromEntryId,target:event.targetEntryId});
    if(tag.endsWith('hold'))return new Promise(()=>{});
    if(tag.endsWith('veto'))return {cancel:true};
    assert.equal(tag,'summary-override');return {summary:'TERMINAL_GLOBAL_OVERRIDE',provider:'extensionfixture',model:'summary-override',usage:{totalTokens:3}};
  });
};`);
const records = async () => completeTraceRecords(await readFile(trace, 'utf8').catch(() => ''));
let terminal, exited, output = '', generation = 0, passed = false;
const startedAt = performance.now(), stages = [];
const visible = () => stripVTControlCharacters(output);
const waitFor = async (predicate, label) => {
  const start = performance.now(), end = Date.now() + 5_000;
  try {
    while (!await predicate()) {
      if (Date.now() >= end || exited) throw new Error(`${scenario}/${label}: ${visible()}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally {
    stages.push({ label, startMs: Math.round(start - startedAt), durationMs: Math.round(performance.now() - start), pid: terminal?.pid, exited });
  }
};
const readyAfter = async marker => waitFor(() => { const text = visible(), start = text.lastIndexOf(marker);
  return start >= 0 && text.indexOf('editor ready · Enter send', start) >= 0; }, `fresh readiness after ${marker}`);
async function open(startupVeto = false) {
  output = ''; exited = undefined;
  const command = process.env.AIH_STATE_COMMAND || undefined;
  terminal = pty.spawn(command ?? process.execPath, [...(command ? [] : [process.env.AIH_STATE_CLI ?? '/app/packages/cli/dist/index.js']),
    '--offline', '--approve', '--no-context-files', '--no-extensions', '-e', agent, '--model', 'statefixture/fixture-model', '--verbose',
    '--session-dir', sessions, '--session-id', startupVeto && durable ? 'branch-startup-rejected' : sourceId,
    ...(startupVeto ? ['--fork', durable ? sourceId : 'must-not-read-this-source'] : []),
    '--tui-mode', mode, '--theme', 'dark', ...(!durable ? ['--no-session'] : [])],
  { cwd, cols: 200, rows: 40, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent,
    AIH_BRANCH_STARTUP_VETO: startupVeto ? '1' : '0', TERM: 'xterm-256color', NO_COLOR: '1' } });
  terminal.onData(value => { output += value; }); terminal.onExit(value => { exited = value; });
  if (startupVeto) {
    await waitFor(() => exited !== undefined, 'startup refusal settlement'); assert.equal(exited.exitCode, 2);
    assert.ok(visible().includes(durable ? 'Session branch operation cancelled.' : '--fork cannot be combined with --no-session.'));
    terminal = undefined; return;
  }
  await waitFor(() => visible().includes('editor ready · Enter send'), 'initial readiness');
}
async function observe(operation = 'read', name) {
  const tag = name ?? `generation-${++generation}`;
  output = ''; terminal.write(`/branch-probe ${operation} ${tag}\r`);
  await waitFor(async () => (await records()).some(record => record.kind === 'observed' && record.operation === operation && record.tag === tag), `new observation ${tag}`);
  await readyAfter(`BRANCH_GENERATION_SETTLED_${tag}`);
  assert.ok(!visible().includes('NEVER_TERMINAL_STATE')); assert.ok(!visible().includes('NEVER_TERMINAL_DETAILS'));
  return (await records()).find(record => record.kind === 'observed' && record.operation === operation && record.tag === tag);
}
const source = observation => observation.inventory.find(session => session.id === sourceId);
async function cancelOperation(kind, hold) {
  const tag = `${kind}-${hold ? 'hold' : 'veto'}`;
  await observe('policy', tag); const before = await observe(), bytes = durable ? await readFile(sourceFile) : undefined;
  output = '';
  terminal.write(kind === 'summary' ? `/navigate ${rootEntry} --summarize\r` : `/${kind} ${sourceId}${kind === 'fork' ? ' 1' : ''}\r`);
  await waitFor(async () => (await records()).some(record => record.kind === (kind === 'summary' ? 'summary-hook' : 'branch-hook') && record.tag === tag), `hook entered ${tag}`);
  if (hold) {
    terminal.write('/new MustNotRun\r'); await waitFor(() => visible().includes('Une commande ou saisie est déjà en cours.'), 'foreground refusal');
    terminal.write('\u0003'); await waitFor(async () => (await records()).some(record => record.kind === 'aborted' && record.tag === tag), `owned signal ${tag}`);
  }
  const marker = kind === 'summary' ? 'Navigation cancelled.' : 'Session branch cancelled.';
  await readyAfter(marker);
  if (hold) terminal.write(mode === 'regular' ? '\u0005\u0015' : '\u0015');
  const after = await observe(); assert.deepEqual(after.inventory, before.inventory); assert.equal(after.id, before.id);
  if (durable) assert.deepEqual(await readFile(sourceFile), bytes);
  assert.equal((await records()).filter(record => record.kind === 'fallback').length, 0);
}
async function close() { terminal.write('\u0004'); await waitFor(() => exited !== undefined, 'direct Ctrl-D settlement'); assert.equal(exited.exitCode, 0); terminal = undefined; }
let rootEntry;
try {
  await open();
  if (mode === 'fullscreen') {
    output = ''; terminal.write('/branch-probe readiness\r');
    const marker = 'BRANCH_COMMAND_OUTPUT_PENDING';
    await waitFor(() => { const text = visible(), start = text.lastIndexOf(marker);
      return start >= 0 && text.indexOf('editor ', start) >= 0; }, 'held foreground output');
    assert.ok(visible().slice(visible().lastIndexOf(marker)).includes('editor busy'), 'foreground output must not advertise settled input');
    await writeFile(readinessRelease, 'release');
    await readyAfter('BRANCH_COMMAND_OUTPUT_SETTLED');
  }
  const initial = await observe('setup'), original = source(initial), selected = original.active.find(entry => entry.type === 'message' && entry.content === 'Selected user').id;
  rootEntry = original.active.find(entry => entry.type === 'message' && entry.content === 'Shared user').id;
  if (phase !== 'copies') {
    for (const kind of ['fork', 'clone', 'summary']) for (const hold of [false, true]) await cancelOperation(kind, hold);
  }
  if (phase !== 'cancellation') {
    await observe('policy', 'summary-override'); output = ''; terminal.write(`/navigate ${rootEntry} --summarize\r`); await readyAfter('Branch summary saved.');
    const summarized = await observe(), summary = source(summarized).active.at(-1);
    assert.equal(summary.type, 'branch_summary'); assert.equal(summary.summary, 'TERMINAL_GLOBAL_OVERRIDE'); assert.equal(summary.parentEntryId, rootEntry); assert.equal(summary.fromEntryId, original.leaf);
    assert.deepEqual(summary.usage, { totalTokens: 3 }); assert.deepEqual(source(summarized).raw.slice(0, original.raw.length), original.raw);
    assert.ok(summarized.model.includes('TERMINAL_GLOBAL_OVERRIDE')); assert.equal((await records()).filter(record => record.kind === 'fallback').length, 0);
    await observe('policy', 'no-summary'); output = ''; terminal.write(`/navigate ${original.leaf} --no-summary\r`); await readyAfter(`Navigated to ${original.leaf}.`);
    const reset = await observe(); assert.equal(source(reset).leaf, original.leaf);
    assert.equal((await records()).filter(record => record.kind === 'summary-hook' && record.tag === 'no-summary').length, 0);
    await observe('policy', 'allow');
    for (const kind of ['fork', 'clone']) {
      const before = await observe(), bytes = durable ? await readFile(sourceFile) : undefined;
      output = ''; terminal.write(`/${kind} ${sourceId}${kind === 'fork' ? ' 1' : ''}\r`); await readyAfter(kind === 'fork' ? 'Forked session' : 'Cloned session');
      const after = await observe(), child = after.inventory.find(session => !before.inventory.some(prior => prior.id === session.id));
      assert.ok(child); assert.equal(after.id, sourceId); assert.deepEqual(source(after), source(before)); if (durable) assert.deepEqual(await readFile(sourceFile), bytes);
      const revisions = child.active.filter(entry => entry.type === 'custom' && entry.customType === 'fixture:branch-state').map(entry => entry.data.revision);
      assert.deepEqual(revisions, kind === 'fork' ? [1] : [1, 2]);
      if (kind === 'fork') assert.equal(child.leaf, selected);
      else { assert.notEqual(child.leaf, original.leaf); assert.equal(child.active.at(-1).type, 'custom'); const ids = new Set(original.active.map(entry => entry.id)); assert.ok(child.active.every(entry => !ids.has(entry.id))); }
      assert.equal(child.active.some(entry => entry.type === 'branch_summary'), false);
    }
    const final = await observe(); assert.equal(final.inventory.length, 3); await close(); await open(); const restarted = await observe();
    if (durable) { assert.deepEqual(restarted.inventory, final.inventory); assert.equal(source(restarted).leaf, original.leaf); }
    else { assert.equal(restarted.inventory.length, 1); assert.deepEqual(source(restarted).raw, []); }
    await close(); const startupBytes = durable ? await readFile(sourceFile) : undefined;
    await open(true);
    const startupHooks = (await records()).filter(record => record.kind === 'branch-hook' && record.tag === 'startup-veto');
    if (durable) {
      assert.equal(startupHooks.length, 1); assert.deepEqual(await readFile(sourceFile), startupBytes);
      await open(); const afterVeto = await observe(); assert.deepEqual(afterVeto.inventory, final.inventory); await close();
    } else {
      assert.equal(startupHooks.length, 0);
      await open(); const blank = await observe(); assert.deepEqual(source(blank).raw, []); await close();
    }
  } else await close();
  passed = true;
} finally {
  try {
    if (process.env.AIH_INSTALLED_EVIDENCE_DIR) {
      await mkdir(process.env.AIH_INSTALLED_EVIDENCE_DIR, { recursive: true });
      await writeFile(path.join(process.env.AIH_INSTALLED_EVIDENCE_DIR, `branch-terminal-${scenario}${phase === 'all' ? '' : '-' + phase}.json`), JSON.stringify({
        scenario, phase, passed, probePid: process.pid, elapsedMs: Math.round(performance.now() - startedAt), stages, trace: await records(), output,
      }, null, 2));
    }
    if (passed) await rm(root, { recursive: true, force: true });
    else await writeFile(path.join(root, 'terminal-output.txt'), output);
  } finally { if (terminal && !exited) terminal.kill(); }
}
console.log(JSON.stringify({ result: 'TERMINAL_BRANCH_LIFETIME_OK', scenario, phase, cancellationPhases: phase === 'copies' ? 0 : 6,
  summaryOverride: phase !== 'cancellation', actualCopies: phase === 'cancellation' ? 0 : 2, restart: phase !== 'cancellation',
  startupVeto: phase !== 'cancellation' && durable, noSessionParserRefusal: phase !== 'cancellation' && !durable }));
