import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const bytes = readFileSync(new URL('./minimax-continuation-reference.json', import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'), '35ed7f0f601daaea5ac76682cf39fc382dac05c6c1a205212ba32956f74c05cb');
const reference = JSON.parse(bytes);
let mode;

export function sendMiniMaxContinuation(response, stream) {
  if (!mode) return false;
  if (stream) {
    const events = structuredClone(reference.seedEvents);
    if (mode === 'header') events[0].message.content = structuredClone(reference.syntheticJsonContent);
    response.setHeader('content-type', 'text/event-stream');
    response.end(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
  } else response.end(JSON.stringify({ type: 'message', role: 'assistant', model: 'untrusted-response-alias',
    stop_reason: 'tool_use', content: reference.syntheticJsonContent }));
  return true;
}

export async function checkMiniMaxAdmission(Constructor, calls, scope, owner, baseUrl, expectedPath, key) {
  const start = calls.length, model = 'MiniMax-M3', row = reference.rows.find(row => row.scope === scope && row.model === model);
  assert.ok(row); class Derived extends Constructor {}
  const options = { model, thinking: 'off', maxTokens: 64, cacheRetention: 'none' }, initial = [{ id: 'u', role: 'user', content: 'probe', timestamp: new Date(0) }];
  const history = [...initial, { id: 'a', role: 'assistant', content: 'left!right?', provider: owner, api: row.api, model, timestamp: new Date(1),
    blocks: structuredClone(reference.expectedBlocks), toolCalls: [{ id: 'call', name: 'echo', input: { x: 1 } }] },
    { id: 't', role: 'tool', toolCallId: 'call', content: 'result', timestamp: new Date(2) }, { id: 'next', role: 'user', content: 'continue', timestamp: new Date(3) }];
  const before = structuredClone({ history, options }), legacy = [{ role: 'user', content: 'probe' }, { role: 'assistant', content: [
    { type: 'text', text: 'firstsecond\n[Reasoning redacted]' }, { type: 'text', text: 'left!right?' }, { type: 'tool_use', id: 'call', name: 'echo', input: { x: 1 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'result' }] }, { role: 'user', content: 'continue' }];
  mode = 'normal';
  try {
    for (const stream of [false, true]) for (const native of [false, true]) {
      const config = { type: owner, apiKey: key, baseUrl, model }, provider = native ? new Constructor(config) : new Derived(config);
      Object.defineProperty(provider, 'ownsMiniMaxReplay', { value: !native, writable: true, configurable: true });
      Object.defineProperty(provider, 'constructor', { value: Constructor, configurable: true });
      const invoke = async messages => {
        if (!stream) return provider.chat(messages, options);
        let result; await provider.streamChat(messages, () => {}, value => { result = value; }, error => { throw error; }, options);
        assert.ok(result); return result;
      };
      for (const messages of [initial, history]) {
        if (native) assert.deepEqual((await invoke(messages)).blocks, reference.expectedBlocks);
        else await assert.rejects(invoke(messages), /Unsupported MiniMax (reasoning replay|message content)\./);
        assert.deepEqual(calls.at(-1).body, { model, max_tokens: 64, stream, thinking: { type: 'disabled' },
          messages: messages === initial ? [{ role: 'user', content: 'probe' }] : native ? row.cases[0].expectedMessages : legacy });
        assert.deepEqual({ history, options }, before);
      }
    }
    assert.equal(calls.length - start, 8);
    for (const call of calls.slice(start)) { assert.equal(call.url, expectedPath); assert.equal(call.headers['x-api-key'], key); assert.equal(call.headers.authorization, undefined); }
  } finally { mode = undefined; }
}

export async function checkMiniMaxContinuation(provider, calls, scope, owner, expectedPath, key) {
  const start = calls.length, rows = reference.rows.filter(row => row.scope === scope);
  assert.equal(rows.length, 3);
  assert.equal(Object.hasOwn(provider, 'getProviderType'), false);
  provider.getProviderType = () => 'foreign-getter';
  mode = 'normal';
  try {
    for (const row of rows) {
      const options = { model: row.model, maxTokens: 64, cacheRetention: 'none', tools: structuredClone(reference.tools) };
      const initial = [{ id: 'u', role: 'user', content: 'probe', timestamp: new Date(0) }];
      for (const stream of [false, true]) {
        const callbacks = [];
        const call = async messages => {
          if (!stream) return provider.chat(messages, options);
          let result;
          await provider.streamChat(messages, (text, event) => callbacks.push({ text, event }), value => { result = value; }, error => { throw error; }, options);
          assert.ok(result); return result;
        };
        const captured = await call(initial);
        assert.equal(captured.provider, owner); assert.equal(captured.model, row.model); assert.equal(captured.api, row.api);
        assert.equal(captured.content, 'left!right?'); assert.equal(captured.reasoning, 'firstsecond'); assert.deepEqual(captured.blocks, reference.expectedBlocks);
        assert.deepEqual(captured.toolCalls, [{ id: 'call', name: 'echo', input: { x: 1 } }]);
        for (const vector of row.cases) {
          const assistant = { id: 'a', role: 'assistant', timestamp: new Date(1), content: captured.content,
            provider: captured.provider, model: captured.model, api: captured.api, blocks: structuredClone(captured.blocks), toolCalls: structuredClone(captured.toolCalls) };
          if (vector.case === 'foreign-provider') assistant.provider = 'foreign-owner';
          if (vector.case === 'foreign-model') assistant.model = 'foreign-model';
          if (vector.case === 'foreign-api') assistant.api = 'foreign-api';
          if (vector.case === 'missing-api') delete assistant.api;
          if (vector.case.startsWith('failed-')) assistant.metadata = { outputError: vector.case };
          const thought = assistant.blocks[1]; assert.equal(thought.type, 'reasoning');
          if (vector.case === 'unsigned') delete thought.thinkingSignature;
          if (vector.case === 'empty-thinking') thought.text = '';
          if (vector.case === 'blank-thinking') thought.text = ' \t';
          if (vector.case === 'empty-signature') thought.thinkingSignature = '';
          if (vector.case === 'blank-signature') thought.thinkingSignature = ' \t';
          const messages = [...initial, assistant, ...(vector.case.startsWith('failed-') ? [] : [
            { id: 't', role: 'tool', toolCallId: 'call', content: 'result', timestamp: new Date(2) }]),
            { id: 'u2', role: 'user', content: 'continue', timestamp: new Date(3) }], before = structuredClone({ messages, options });
          await call(messages); assert.deepEqual(calls.at(-1).body.messages, vector.expectedMessages, row.model + '/' + vector.case);
          assert.deepEqual({ messages, options }, before);
        }
        assert.equal(JSON.stringify(callbacks).includes('opaque-'), false);
      }
      mode = 'header'; const callbacks = []; let complete;
      await provider.streamChat(initial, (text, event) => callbacks.push({ text, event }), value => { complete = value; }, error => { throw error; }, options);
      assert.deepEqual(complete.blocks, reference.expectedBlocks); assert.equal(JSON.stringify(callbacks).includes('opaque-'), false); mode = 'normal';
    }
    assert.equal(calls.length - start, 81);
    for (const call of calls.slice(start)) {
      assert.equal(call.url, expectedPath); assert.equal(call.headers['x-api-key'], key);
      assert.equal(call.headers.authorization, undefined); assert.equal(call.headers['anthropic-version'], '2023-06-01'); assert.equal(call.body.max_tokens, 64);
    }
  } finally { delete provider.getProviderType; mode = undefined; }
}
