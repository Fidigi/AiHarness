import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const bytes = readFileSync(new URL('./minimax-continuation-reference.json', import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'), '6671155239d400520bb007617f1e014a244e5aa6331fe8d080081d70c747ad9b');
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
