import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const execute = promisify(execFile);
async function exec(...args: Parameters<typeof execute>): Promise<Awaited<ReturnType<typeof execute>>> {
  try { return await execute(...args); }
  catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`${failure.message}\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`, { cause: error });
  }
}

/** Real package resolution + emitted declarations, no source aliases/private imports. */
async function consumer(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-sdk-public-'));
  try {
    const modules = path.join(cwd, 'node_modules');
    const installed = path.join(modules, '@ai-harness', 'core');
    await mkdir(installed, { recursive: true });
    await cp(path.resolve('packages/core/package.json'), path.join(installed, 'package.json'));
    await cp(path.resolve('packages/core/dist'), path.join(installed, 'dist'), { recursive: true });
    // Reuse installed dependencies, not Core source or its workspace package link.
    for (const dependency of ['undici', 'quickjs-emscripten', '@modelcontextprotocol', '@types']) {
      await symlink(path.resolve('node_modules', dependency), path.join(modules, dependency), 'dir');
    }
    await writeFile(path.join(cwd, 'package.json'), '{"type":"module"}');
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const declarations = `
import {
  AI_HARNESS_CORE_API_VERSION, createAgentSession, createAgentResourceLoader,
  AiProvider, JsonlSessionStore, deserializeSession, serializeSession,
  type AgentSession, type AgentProvider, type AgentProviderConfig,
  type CreateAgentSessionOptions, type SessionStore, type AgentCredential,
  type AgentAuthDescriptor, type AgentModel, type AgentResourceLoader,
  type AgentEvent, type AgentPromptOptions,
} from '@ai-harness/core';
const version: 1 = AI_HARNESS_CORE_API_VERSION;
declare const provider: AiProvider;
const binding: AgentProvider = { kind: 'instance', name: 'custom', provider };
const config: AgentProviderConfig = { type: 'openai', apiKey: 'disposable', httpIdleTimeoutMs: 100, transport: 'sse' };
const store: SessionStore = new JsonlSessionStore('/tmp/disposable-sdk-declarations');
const credential: AgentCredential = { version: 1, type: 'oauth', accessToken: 'disposable', expiresAt: 123 };
const descriptor: AgentAuthDescriptor = { provider: 'openai', type: 'oauth', source: 'memory', refreshable: false };
declare const model: AgentModel;
const loader: AgentResourceLoader = createAgentResourceLoader({ disableSkills: true, disablePrompts: true });
const options: CreateAgentSessionOptions = {
  cwd: '/tmp', provider: binding, store, resourceLoader: loader,
  isProjectTrusted: cwd => cwd === '/tmp', auth: { secrets: ['disposable'] },
  session: { kind: 'resume', id: 'session-id' },
  compaction: { settings: { keepRecentTokens: 100 }, summarize: async (_id, _old, _kept, signal) => {
    if (signal?.aborted) throw new Error('cancelled');
    return { summary: 'summary', usage: { totalTokens: 4 } };
  } },
};
const sdk: AgentSession = await createAgentSession(options);
const protocol: 1 = sdk.capabilities.eventProtocolVersion;
const prompt: AgentPromptOptions = { model: model.id, thinking: 'high', blocks: [{ type: 'text', text: 'input' }] };
await sdk.prompt('input', prompt);
await sdk.wait();
await sdk.stop();
sdk.steer('input'); sdk.followUp('later'); sdk.clearQueue('steer');
sdk.respondToInteraction('request-id', { cancelled: false, value: true });
const unsubscribe = sdk.subscribe((event: AgentEvent) => { const sequence: number = event.sequence; void sequence; });
sdk.events(0); sdk.state(); sdk.messages(); sdk.history(); sdk.effectiveContext();
const wire = sdk.exportSession();
const date: Date = deserializeSession(wire).messages[0].timestamp;
const iso: string = serializeSession(sdk.snapshot()).messages[0].timestamp;
await sdk.rename('name'); await sdk.setModel('model'); await sdk.setThinking('max');
const fork: AgentSession = await sdk.fork('user-id', { before: true });
await sdk.branchBefore('user-id'); await sdk.clone('copy');
sdk.compactionTarget(); await sdk.applyCompaction('summary', 'first-kept', { usage: { totalTokens: 5 } });
await sdk.reloadResources(); sdk.resources(); sdk.resourceDiagnostics();
await sdk.expandPrompt('template', ['value']); await sdk.invokeSkill('skill', 'question');
unsubscribe(); await fork.dispose(); await sdk.dispose();
void [version, protocol, config, credential, descriptor, date, iso];
// @ts-expect-error cwd is a required allowed-root boundary
await createAgentSession({ provider: binding });
// @ts-expect-error factories cannot auto-load custom executable provider registrations
const badConfig: AgentProviderConfig = { type: 'plugin-defined' };
// @ts-expect-error unknown factory capabilities are not silently supported
await createAgentSession({ cwd: '/tmp', provider: binding, extensions: ['unsafe.js'] });
// @ts-expect-error unsupported imported wire shortcuts must go through Date hydration + new-session options
await createAgentSession({ cwd: '/tmp', provider: binding, session: wire });
// @ts-expect-error provider identity is bound by the factory, not a per-prompt escape hatch
await sdk.prompt('input', { provider: 'other' });
// @ts-expect-error interaction cancellation is explicit in the Core response contract
sdk.respondToInteraction('request-id', { value: true });
// @ts-expect-error input is text; attachments use existing typed blocks
await sdk.prompt({ text: 'input' });
// @ts-expect-error unknown thinking levels fail declarations
await sdk.setThinking('extreme');
// @ts-expect-error no undocumented fork position shortcut
await sdk.fork(3);
// @ts-expect-error no SDK credential reveal surface
sdk.apiKey;
// @ts-expect-error no implicit OAuth login
await sdk.login();
// @ts-expect-error no automatic model discovery/read-time networking
await sdk.discoverModels();
// @ts-expect-error no implicit MCP connection hosting
await sdk.connectMcp();
// @ts-expect-error no direct shell execution facade
await sdk.shell('echo unsupported');
// @ts-expect-error no settings-file auto-loading facade
await sdk.reloadSettings();
// @ts-expect-error capability declarations are readonly
sdk.capabilities.oauthLogin = false;
// @ts-expect-error events retain Core's unknown payload rather than inventing a shape
sdk.subscribe(event => { event.data.content; });
// @ts-expect-error stores must implement raw-history preservation, not just get/set
const invalidStore: SessionStore = { loadSession: async () => null, saveSession: async () => {} };
// @ts-expect-error auth values use the versioned Core credential union
const invalidCredential: AgentCredential = { type: 'api-key', apiKey: 'disposable' };
void [badConfig, invalidStore, invalidCredential];
`;

const runtime = `
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  AI_HARNESS_CORE_API_VERSION, createAgentSession, createAgentResourceLoader,
  AiProvider, JsonlSessionStore, deserializeSession,
} from '@ai-harness/core';
assert.equal(AI_HARNESS_CORE_API_VERSION, 1);
assert.ok(import.meta.resolve('@ai-harness/core').startsWith(new URL('./node_modules/@ai-harness/core/', import.meta.url).href));
class Mock extends AiProvider {
  validateConfig() { return true; }
  async chat() { throw new Error('Must use runtime stream'); }
  async getAvailableModels() { throw new Error('Must never discover'); }
  async streamChat(_messages, chunk, complete, _error, options) {
    assert.equal(options.model, 'external-mock');
    await chunk('consumer:disposable-');
    await chunk('credential');
    complete({ content: 'consumer:disposable-credential', model: 'external-mock', usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } });
  }
}
const provider = new Mock({ type: 'mock' });
const cwd = process.cwd();
const options = {
  cwd, provider: { kind: 'instance', name: 'fixture', provider },
  auth: { secrets: ['disposable-credential'] }, isProjectTrusted: () => true,
  runDefaults: { model: 'external-mock', maxRetries: 0 },
};
const memory = await createAgentSession(options);
const events = [];
memory.subscribe(event => events.push(event.type));
assert.equal(memory.capabilities.persistence, 'memory');
assert.ok(Object.isFrozen(memory.capabilities));
assert.ok(Object.isFrozen(memory.ownership));
assert.equal(memory.capabilities.mcpHosting, false);
assert.equal(memory.capabilities.oauthLogin, false);
assert.equal((await memory.promptAndWait('first')).phase, 'completed');
assert.equal(memory.messages().at(-1).content, 'consumer:[REDACTED]');
assert.equal(memory.snapshot().usage.totalTokens, 3);
assert.ok(events.includes('run.completed'));
assert.ok(deserializeSession(memory.exportSession()).createdAt instanceof Date);
const fork = await memory.fork(memory.messages()[0].id, { before: true });
assert.equal(fork.messages().length, 0);
const clone = await memory.clone('clone');
assert.equal(clone.snapshot().metadata.clonedFromSessionId, memory.id);
await memory.dispose();
assert.equal((await fork.promptAndWait('fork')).phase, 'completed');
await fork.dispose(); await clone.dispose();
const disk = new JsonlSessionStore(path.join(cwd, 'disposable-sessions'));
// Not a JsonlSessionStore instance: a genuine caller-supplied structural store.
const store = Object.fromEntries(['setRedaction', 'listSessionIds', 'loadSession', 'saveSession', 'getRawEntries', 'deleteSession'].map(name => [name, disk[name].bind(disk)]));
const persisted = await createAgentSession({ ...options, store });
await persisted.promptAndWait('persist');
const id = persisted.id;
await persisted.dispose();
const journal = await readFile(path.join(cwd, 'disposable-sessions', id + '.jsonl'), 'utf8');
assert.ok(!journal.includes('disposable-credential'));
const resumed = await createAgentSession({ ...options, store, session: { kind: 'resume', id } });
assert.equal(resumed.messages().length, 2);
assert.equal((await resumed.history()).filter(entry => entry.type === 'message').length, 2);
await resumed.dispose();
const loader = createAgentResourceLoader({ disableSkills: true, disablePrompts: true });
const resources = await createAgentSession({ ...options, resourceLoader: loader });
assert.deepEqual(resources.resources(), []);
assert.deepEqual(await resources.reloadResources(), []);
await resources.dispose();
assert.ok(!(await readdir(cwd)).includes('.ai-harness'));
console.log('SDK public consumer: memory, custom store, resume, events, redaction, usage, fork/clone, resources OK');
`;

const reviewRuntime = `
import assert from 'node:assert/strict';
import { mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { createAgentSession, AiProvider, MockProvider, ExtensionRegistry, ProjectTrustManager, JsonlSessionStore } from '@ai-harness/core';
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
class Provider extends AiProvider {
  constructor() { super({ type: 'mock' }); this.turns = []; }
  validateConfig() { return true; }
  async chat() { throw new Error('Use shared stream loop'); }
  async streamChat(messages, _chunk, complete, _error, options) {
    this.turns.push({ messages: structuredClone(messages), options });
    complete({ content: 'answer', usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } });
  }
}
const cwd = process.cwd();
const workspace = path.join(cwd, 'workspace');
await mkdir(workspace);
const alias = path.join(cwd, 'workspace-alias');
await symlink(workspace, alias, 'dir');
const trustFile = path.join(cwd, 'host-policy', 'trust.json');
const host = new ProjectTrustManager(trustFile);
const otherHost = new ProjectTrustManager(trustFile);
await host.setDecision(cwd, true);
const trustedProvider = new Provider();
const checked = [];
const trusted = await createAgentSession({ cwd: alias, allowedRoots: [cwd], provider: { kind: 'instance', name: 'review', provider: trustedProvider }, isProjectTrusted: candidate => { checked.push(candidate); return host.isTrusted(candidate); } });
assert.equal(trusted.cwd, workspace);
assert.equal((await trusted.promptAndWait('inherited allow')).phase, 'completed');
await otherHost.setDecision(workspace, false);
await assert.rejects(trusted.prompt('fresh refusal'), error => error.code === 'PROJECT_TRUST_REQUIRED');
assert.equal(trustedProvider.turns.length, 1);
assert.ok(checked.every(candidate => candidate === workspace));
await trusted.dispose();

const registry = new ExtensionRegistry();
let cleanups = 0;
await registry.load('borrowed', () => () => { cleanups++; });
const provider = new Provider();
const delegate = new JsonlSessionStore(path.join(cwd, 'review-store'));
const writing = deferred();
const releaseWrite = deferred();
const writes = [];
const store = {
  // Intentionally ignores callbacks: adapter must scrub before crossing boundary.
  setRedaction() {},
  listSessionIds: () => delegate.listSessionIds(),
  loadSession: id => delegate.loadSession(id),
  getRawEntries: id => delegate.getRawEntries(id),
  deleteSession: id => delegate.deleteSession(id),
  async saveSession(value, entries, options) {
    writes.push(structuredClone({ value, entries }));
    if (value.title === 'held rename') { writing.resolve(); await releaseWrite.promise; }
    await delegate.saveSession(value, entries, options);
    value.title = 'store mutated its input';
    if (value.messages[0]) value.messages[0].content = 'store mutated its input';
  },
};
const options = { cwd, provider: { kind: 'instance', name: 'review', provider }, store, extensionRegistry: registry, isProjectTrusted: () => true, auth: { secrets: ['review-boundary-secret'] },
  onUsage(_name, _model, usage) { usage.totalTokens = 999; usage.promptTokens = 900; return 0.04; },
  compaction: { summarize: async () => 'summary', policy(session) { session.title = 'policy mutation'; session.messages[0].content = 'policy mutation'; return false; } },
};
await assert.rejects(createAgentSession({ ...options, store: { ...store, setRedaction() { throw new Error('store initialization: review-boundary-secret'); } } }), error => error.message === 'store initialization: [REDACTED]');
const sdk = await createAgentSession(options);
options.extensionRegistry = undefined;
const rename = sdk.rename('held rename');
await writing.promise;
const promptOptions = { model: 'admitted-model', blocks: [{ type: 'text', text: 'admitted-block' }] };
const prompt = sdk.prompt('review-boundary-secret', promptOptions);
promptOptions.model = 'mutated-model';
promptOptions.blocks[0].text = 'mutated-block';
releaseWrite.resolve();
await rename; await prompt; await sdk.wait();
assert.equal(provider.turns[0].options.model, 'admitted-model');
assert.equal(sdk.messages()[0].blocks[0].text, 'admitted-block');
assert.equal(sdk.snapshot().usage.totalTokens, 5);
assert.equal(sdk.snapshot().usage.costUsd, 0.04);
await sdk.promptAndWait('second');
assert.equal(sdk.messages()[0].content, '[REDACTED]');
assert.notEqual(sdk.snapshot().title, 'policy mutation');
assert.ok(!JSON.stringify(writes).includes('review-boundary-secret'));
assert.equal(sdk.snapshot().usage.totalTokens, 10);
await sdk.dispose();
assert.equal(cleanups, 0);
await registry.unloadAll();
assert.equal(cleanups, 1);

const held = deferred();
const entered = deferred();
const tools = new ExtensionRegistry();
await tools.load('progress', api => api.registerTool({ name: 'hold', description: 'hold', parameters: { type: 'object' }, execute: async () => { entered.resolve(); await held.promise; return { content: 'late' }; } }));
class Nested extends MockProvider {
  async classify() { return { label: 'yes', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } }; }
  async streamChat(_messages, _chunk, complete) {
    complete({ content: '', toolCalls: [{ id: 'nested', name: 'codemode', input: { code: "await models.classify({model:'virtual-chat:classifier',input:'review-progress-secret',labels:['yes']}); return await tools.hold({});" } }] });
  }
}
const nested = await createAgentSession({ cwd, provider: { kind: 'instance', name: 'mock', provider: new Nested({ type: 'mock', model: 'virtual-chat' }) }, extensionRegistry: tools, isProjectTrusted: () => true, auth: { secrets: ['review-progress-secret'] }, runDefaults: { codemode: { enabled: true } } });
let progressEvents = 0;
const observed = [];
nested.subscribe(event => {
  observed.push(structuredClone(event));
  if (event.type === 'tool.progress') { progressEvents++; event.data.kind = 'observer mutation'; }
});
await nested.prompt('nested');
await Promise.race([entered.promise, nested.wait().then(run => { throw new Error('Run settled before held tool: ' + JSON.stringify(run)); })]);
assert.ok(progressEvents > 0);
assert.ok(!JSON.stringify(observed).includes('review-progress-secret'));
const state = nested.state();
assert.ok(state.run.activeTool.nestedCalls.length > 0);
state.run.activeTool.nestedCalls[0].name = 'observer mutation';
assert.notEqual(nested.state().run.activeTool.nestedCalls[0].name, 'observer mutation');
assert.ok(nested.events().events.filter(event => event.type === 'tool.progress').every(event => event.data.kind === 'codemode'));
assert.ok(!JSON.stringify([nested.state(), nested.events()]).includes('review-progress-secret'));
const waiting = nested.wait();
assert.equal((await nested.stop()).phase, 'stopped');
assert.equal((await waiting).phase, 'stopped');
assert.equal(nested.messages().at(-1).metadata.interrupted, true);
const replay = nested.events();
held.resolve();
await new Promise(done => setTimeout(done, 30));
assert.deepEqual(nested.events(), replay);
await nested.dispose(); await tools.unloadAll();
console.log('SDK public review: fresh persisted canonical trust, queued options, accounting copies, policy copies, store boundary/init error redaction, ownership, nested progress copies and durable stop OK');
`;

describe('SDK emitted public package contract', () => {
  it('runs a genuine built-Core consumer outside the installation', async () => {
    await consumer(async cwd => {
      await writeFile(path.join(cwd, 'consumer.mjs'), runtime);
      const result = await exec(process.execPath, ['consumer.mjs'], { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 });
      expect(result.stdout).toContain('SDK public consumer:');
      expect(result.stderr).toBe('');
      console.log(String(result.stdout).trim());
    });
  }, 40_000);

  it('runs boundary regressions and nested progress/stop through the genuine public built entry', async () => {
    await consumer(async cwd => {
      await writeFile(path.join(cwd, 'review.mjs'), reviewRuntime);
      const result = await exec(process.execPath, ['review.mjs'], { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 });
      expect(result.stdout).toContain('SDK public review:');
      expect(result.stderr).toBe('');
      console.log(String(result.stdout).trim());
    });
  }, 40_000);

  it('checks positive and rejected public declaration calls using real package exports', async () => {
    await consumer(async cwd => {
      await writeFile(path.join(cwd, 'consumer.ts'), declarations);
      const result = await exec(process.execPath, [path.resolve('node_modules/typescript/bin/tsc'),
        '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext',
        '--moduleResolution', 'NodeNext', '--types', 'node', 'consumer.ts'], { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 });
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });
  }, 40_000);
});
