import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { OpenAICodexProvider, OPENAI_CODEX_MODELS } from '@ai-harness/core';
const reference = JSON.parse(await readFile(process.argv[2], 'utf8'));
const token = 'e30.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-codex-account' } })).toString('base64url') + '.c2ln';
const credential = { version: 1, type: 'oauth', accessToken: token, refreshToken: 'disposable-installed-cx-refresh', expiresAt: Date.now() + 3600000,
  subscription: { provider: 'openai-codex', accountId: 'fixture-codex-account' } };
let available = true, events = reference.events, request, posts = 0;
globalThis.fetch = async (url, init) => {
  const headers = new Headers(init.headers);
  assert.equal(headers.get('authorization'), 'Bearer ' + token); assert.equal(headers.get('chatgpt-account-id'), 'fixture-codex-account');
  if (String(url) === 'https://chatgpt.com/backend-api/codex/models?client_version=0.167.2') return Response.json({ models: OPENAI_CODEX_MODELS.map(model => ({ slug: model.id, visibility: 'list' })) });
  assert.equal(String(url), 'https://chatgpt.com/backend-api/codex/responses');
  request = JSON.parse(String(init.body)); posts++;
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
};
const user = { id: 'u', role: 'user', content: 'probe', timestamp: new Date(1) };
for (const row of reference.rows) {
  const provider = new OpenAICodexProvider({ type: 'not-api-key', model: row.model }, async () => available ? credential : undefined);
  events = reference.events;
  const first = await provider.chat([user], { tools: reference.tools });
  assert.equal(first.api, 'openai-codex-responses'); assert.equal(first.provider, 'openai-codex'); assert.equal(first.model, row.model);
  assert.deepEqual(first.toolCalls, [{ id: 'call_native|fc_native', name: 'echo', input: { x: 1 } }]);
  assert.deepEqual(first.blocks, row.firstObserved.content.map(block => block.type === 'thinking'
    ? { type: 'reasoning', text: block.thinking, thinkingSignature: block.thinkingSignature }
    : block.type === 'text' ? block : { type: 'tool_call', id: block.id, name: block.name, input: block.arguments }));
  for (const vector of row.projections) {
    const message = { id: 'a', role: 'assistant', content: first.content, blocks: structuredClone(first.blocks), toolCalls: structuredClone(first.toolCalls),
      provider: 'openai-codex', api: 'openai-codex-responses', model: row.model, timestamp: new Date(2) };
    if (vector.case === 'provider') message.provider = 'openai';
    if (vector.case === 'api') message.api = 'openai-responses';
    if (vector.case === 'model') message.model = 'foreign-model';
    if (vector.case === 'missing-api') delete message.api;
    if (vector.case === 'failed') message.metadata = { outputError: true };
    if (vector.case === 'expurgated') for (const block of message.blocks) { delete block.thinkingSignature; delete block.textSignature; }
    const history = [user, message, ...(vector.case === 'failed' ? [] : [{ id: 'result', role: 'tool', name: 'echo', toolCallId: 'call_native|fc_native', content: 'result', timestamp: new Date(3) }]),
      { id: 'next', role: 'user', content: 'continue', timestamp: new Date(4) }];
    const before = JSON.stringify(history); events = reference.finalEvents;
    await provider.chat(history, { tools: reference.tools }); assert.deepEqual(request.input, vector.expected); assert.equal(JSON.stringify(history), before);
  }
  available = false; const count = posts;
  await assert.rejects(provider.chat([user])); assert.equal(posts, count); available = true;
}
assert.equal(posts, 72);
console.log('CODEX_REPLAY_PUBLIC_OK ' + posts);
