// Docker-only acquisition with disposable pi-ai@1.2.0 at /tmp/codex-reference.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = '/tmp/codex-reference/node_modules/@earendil-works/pi-ai/';
const replay = JSON.parse(await readFile('/app/tests/fixtures/codex-continuation-reference.json', 'utf8'));
const grammar = JSON.parse(await readFile('/app/tests/fixtures/codex-constrained-reference.json', 'utf8'));
for (const [name, hash] of Object.entries(grammar.hashes)) {
  const map = JSON.parse(await readFile(root + 'dist/' + name + '.js.map', 'utf8'));
  assert.equal(createHash('sha256').update(map.sourcesContent[0]).digest('hex'), hash);
}
const { openaiCodexProvider } = await import(root + 'dist/providers/openai-codex.js');
const { normalizeContext } = await import(root + 'dist/utils/transcript.js');
const provider = openaiCodexProvider(), model = provider.getModels().find(model => model.id === 'gpt-6.1-sol');
const token = 'e30.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-codex-account' } })).toString('base64url') + '.fixture';
let events, frames, connections = 0;
class Socket {
  readyState = 0;
  listeners = new Map();
  constructor(url, options) {
    assert.equal(String(url), 'wss://chatgpt.com/backend-api/codex/responses');
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer ' + token);
    connections++;
    queueMicrotask(() => { this.readyState = 1; this.emit('open', {}); });
  }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  emit(type, event) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  close() { this.readyState = 3; this.emit('close', {}); }
  send(data) { frames.push(JSON.parse(data)); queueMicrotask(() => { for (const event of events) this.emit('message', { data: JSON.stringify(event) }); }); }
}
globalThis.WebSocket = Socket;
globalThis.fetch = () => { throw new Error('Unexpected SSE fallback'); };
const user = { role: 'user', content: 'probe', timestamp: 1 };
async function call(messages, tools, sessionId) {
  const stream = provider.stream(model, normalizeContext({ messages, tools }), { apiKey: token, transport: 'websocket-cached', sessionId, signal: AbortSignal.timeout(15000) });
  for await (const event of stream) { /* Drain the actual SDK. */ }
  const result = await stream.result(); assert(['stop', 'toolUse'].includes(result.stopReason), result.errorMessage); return result;
}
const rows = [];
for (const mode of ['function', 'grammar']) {
  frames = []; events = mode === 'function' ? replay.events : grammar.events;
  const tools = mode === 'function' ? replay.tools : [grammar.rows.find(row => row.case === 'lark').tool];
  const sessionId = 'fixture-ws-' + mode;
  const first = await call([user], tools, sessionId);
  const history = [user, first, { role: 'toolResult', toolCallId: first.content.find(block => block.type === 'toolCall').id,
    toolName: 'echo', content: [{ type: 'text', text: 'result' }], isError: false, timestamp: 2 }];
  events = replay.finalEvents;
  const final = await call(history, tools, sessionId);
  await call([...history, final, { role: 'user', content: 'continue', timestamp: 3 }], tools, sessionId);
  assert.equal(frames.length, 3); assert(frames[1].previous_response_id); assert(frames[2].previous_response_id);
  assert(frames.every(frame => frame.store === false));
  rows.push({ mode, model: model.id, sessionId, tools, frames });
}
assert.equal(connections, 2);
await writeFile('/tmp/codex-websocket-reference.json', JSON.stringify({ pinnedCommit: replay.pinnedCommit, hashes: grammar.hashes,
  scope: 'Fresh synthetic cached WebSocket SDK execution: one function/private chain and one grammar chain. No real socket/vendor/account/host certificate.', connections, requests: 6, rows }, null, 2) + '\n');
const { closeOpenAICodexWebSocketSessions } = await import(root + 'dist/api/openai-codex-responses.js');
for (const row of rows) closeOpenAICodexWebSocketSessions(row.sessionId);
console.log(JSON.stringify({ connections, requests: 6, chains: rows.length }));
