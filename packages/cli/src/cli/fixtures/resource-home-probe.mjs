import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentResourceLoader, loadAgentSettings, parseResourceCommandLine, resolveAgentResourcePaths, resolveAgentResourceSelectors, ResourceManager } from '@ai-harness/core';

const [mode, scope, policy] = process.argv.slice(2);
assert.ok(['core', 'sdk', 'print', 'json', 'rpc'].includes(mode));
assert.ok(['global', 'project', 'explicit'].includes(scope));
assert.ok(['allow', 'refuse'].includes(policy));
const root = await mkdtemp(path.join(os.tmpdir(), 'aih-home-probe-'));
const cwd = path.join(root, 'work[literal]'), agentDir = path.join(root, 'agent[literal]'), home = path.join(root, 'home[literal]');
const capture = path.join(root, 'capture'), trace = path.join(root, 'reads');
const template = '${1:-first}|${2:-second}|${3:-third}|$ARGUMENTS|${@:2}';
const prompt = '/review "" middle';
const expected = '|middle|third| middle|middle';
const file = async (target, text) => { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, text); };
const readLines = async name => (await readFile(name, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
try {
  await mkdir(cwd); await mkdir(agentDir); await mkdir(home);
  for (const name of ['review', 'drop', 'hidden']) {
    await file(path.join(home, 'kit', name + '.md'), `---\nname: ${name}\n---\n${template}`);
    await file(path.join(home, 'kit-skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Home selectors\n---\nSKILL ${name}`);
  }
  const prompts = ['~/kit/*.md', '-~/kit/drop.md', '!~/kit/hidden*.md', '+~/kit/drop.md'];
  const skills = ['~/kit-skills/**/SKILL.md', '-~/kit-skills/drop', '!~/kit-skills/hidden/**', '+~/kit-skills/drop'];
  const settings = { prompts, skills };
  await file(path.join(agentDir, 'settings.json'), JSON.stringify({ quietStartup: true, ...(scope === 'global' ? settings : {}) }));
  if (scope === 'project') await file(path.join(cwd, '.ai-harness/settings.json'), JSON.stringify(settings));
  // These same-root decoys must never be treated as the declaring source or home.
  for (const base of [cwd, agentDir, path.join(cwd, '.ai-harness')]) {
    await file(path.join(base, '~', 'kit/review.md'), '---\nname: review\n---\nWRONG TILDE ROOT');
    await file(path.join(base, 'kit/review.md'), '---\nname: review\n---\nWRONG DECLARING ROOT');
  }
  const trusted = policy === 'allow';
  const admitted = scope !== 'project' || trusted;
  const selected = ['drop', 'review'];
  if (mode === 'core' || mode === 'sdk') {
    const resolved = await loadAgentSettings({ cwd, agentDir, projectTrusted: trusted });
    const selectors = (field, layer) => resolveAgentResourceSelectors(resolved, field, home, layer);
    const options = { cwd, homeDir: home, agentDir, projectTrusted: trusted,
      ...(scope === 'explicit' ? { promptPaths: prompts, skillPaths: skills } : {
        globalPromptSelectors: selectors('prompts', 'global'), globalSkillSelectors: selectors('skills', 'global'),
        projectPromptSelectors: selectors('prompts', 'project'), projectSkillSelectors: selectors('skills', 'project'),
      }) };
    if (scope !== 'explicit') {
      const legacy = resolveAgentResourcePaths(resolved, 'prompts', home);
      assert.ok(Array.isArray(legacy)); assert.ok(legacy.every(value => typeof value === 'string'));
      assert.deepEqual(legacy, admitted ? prompts.map(raw => {
        const marker = /^[+!-]/u.test(raw) ? raw[0] : '';
        return marker + path.join(home, (marker ? raw.slice(1) : raw).slice(2));
      }) : []);
      const manager = new ResourceManager({ cwd, homeDir: home, agentDir, projectTrusted: trusted, globalPromptPaths: legacy });
      assert.deepEqual((await manager.loadAll()).errors, []);
      assert.deepEqual(manager.listPrompts().map(item => item.name), admitted ? selected : []);
    }
    const resources = mode === 'core' ? new ResourceManager(options)
      : await createAgentResourceLoader(options).load({ cwd, projectTrusted: trusted });
    if (mode === 'core') assert.deepEqual((await resources.loadAll()).errors, []);
    else assert.deepEqual(resources.diagnostics, []);
    const inventory = mode === 'core' ? resources.listInventory() : resources.inventory();
    for (const kind of ['skill', 'prompt']) assert.deepEqual(inventory.filter(item => item.kind === kind).map(item => item.name).sort(), admitted ? selected : []);
    if (admitted) {
      for (const item of inventory) {
        assert.equal(item.provenance.scope, scope === 'explicit' ? 'temporary' : scope === 'project' ? 'project' : 'user');
        assert.equal(item.provenance.source, scope === 'explicit' ? 'cli' : 'settings');
      }
      assert.equal(resources.expandPrompt('review', parseResourceCommandLine('"" middle')), expected);
      assert.equal(resources.expandPrompt('review', []), 'first|second|third||');
      assert.equal(resources.invokeSkill('review', 'task'), '<skill name="review">\n\nSKILL review\n\n</skill>\n\ntask');
      assert.throws(() => resources.expandPrompt('hidden', []), /Unknown prompt/);
    } else assert.throws(() => resources.expandPrompt('review', []), /Unknown prompt/);
  } else {
    const observer = path.join(root, 'observe.mjs'), extension = path.join(root, 'capture.mjs');
    await file(observer, `import fs from 'node:fs/promises';import{appendFileSync,readlinkSync}from'node:fs';import{syncBuiltinESMExports}from'node:module';const open=fs.open;fs.open=async(...args)=>{const handle=await open(...args),read=handle.read.bind(handle);handle.read=(...values)=>{const name=readlinkSync('/proc/self/fd/'+handle.fd);if(name.startsWith(${JSON.stringify(root + path.sep)})&&name.endsWith('.md'))appendFileSync(${JSON.stringify(trace)},JSON.stringify(name)+'\\n');return read(...values);};return handle;};syncBuiltinESMExports();`);
    await file(extension, `import{appendFileSync}from'node:fs';export default api=>api.before('before:provider',data=>appendFileSync(${JSON.stringify(capture)},JSON.stringify(data.messages)+'\\n'));`);
    const command = process.env.AIH_RESOURCE_COMMAND ?? process.execPath;
    const entry = process.env.AIH_RESOURCE_COMMAND ? [] : [new URL('../../../dist/index.js', import.meta.url).pathname];
    const args = [...entry, '--offline', trusted ? '--approve' : '--no-approve', '--no-extensions', '-e', extension, '--no-context-files', '--no-session', '--model', 'mock/mock-model',
      ...(scope === 'explicit' ? [...prompts.map(value => '--prompt-template=' + value), ...skills.map(value => '--skill=' + value)] : []),
      ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : [admitted ? prompt : 'Hello.'])];
    const result = await new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, env: { PATH: process.env.PATH, HOME: home, TMPDIR: root, AI_HARNESS_AGENT_DIR: agentDir, NO_COLOR: '1', NODE_OPTIONS: '--import=' + JSON.stringify(observer) }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 18_000);
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
      child.stdin.end(mode === 'rpc' ? [JSON.stringify({ type: 'get_commands', id: 'commands' }), JSON.stringify({ type: 'prompt', id: 'turn', message: admitted ? prompt : 'Hello.' })].join('\n') + '\n' : '');
    });
    assert.equal(result.code, 0, JSON.stringify(result)); assert.equal(result.signal, null); assert.equal(result.stderr, '');
    if (mode === 'print') assert.equal(result.stdout, '[Mock AI Response]\n');
    else {
      const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
      assert.ok(records.every(record => typeof record.type === 'string')); assert.ok(result.stdout.includes('[Mock AI Response]'));
      if (mode === 'rpc') {
        const commands = records.find(record => record.type === 'response' && record.id === 'commands').data.commands;
        assert.deepEqual(commands.filter(item => item.source === 'prompt').map(item => item.name).sort(), admitted ? selected : []);
        assert.deepEqual(commands.filter(item => item.source === 'skill').map(item => item.name).sort(), admitted ? selected.map(name => 'skill:' + name) : []);
      }
    }
    const messages = await readLines(capture);
    assert.deepEqual(messages.map(list => list.filter(message => message.role === 'user').at(-1).content), [admitted ? mode === 'rpc' ? expected : prompt : 'Hello.']);
    const reads = await readLines(trace);
    const files = selected.flatMap(name => [path.join(home, 'kit', name + '.md'), path.join(home, 'kit-skills', name, 'SKILL.md')]);
    assert.deepEqual(reads.sort(), admitted ? files.sort() : []);
  }
  console.log('resource home/arguments OK');
} finally { await rm(root, { recursive: true, force: true }); }
