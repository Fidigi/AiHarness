// Run in Docker with a disposable pi-ai@1.2.0 installation at /tmp/codex-reference.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
const root = '/tmp/codex-reference/node_modules/@earendil-works/pi-ai/';
const prior = JSON.parse(await readFile('/app/tests/fixtures/codex-continuation-reference.json', 'utf8'));
const hashes = {};
for (const name of [...Object.keys(prior.hashes), 'api/constrained-sampling']) {
  const map = JSON.parse(await readFile(root + 'dist/' + name + '.js.map', 'utf8'));
  hashes[name] = createHash('sha256').update(map.sourcesContent[0]).digest('hex');
  if (prior.hashes[name]) assert.equal(hashes[name], prior.hashes[name]);
}
const { openaiCodexProvider } = await import(root + 'dist/providers/openai-codex.js');
const { normalizeContext } = await import(root + 'dist/utils/transcript.js');
const provider = openaiCodexProvider(), models = provider.getModels();
assert.equal(models.length, 9);
for (const model of models) {
  assert.equal(model.compat?.supportsStrictMode ?? true, true);
  assert.equal(model.compat?.supportsOpenAIGrammarTools, true);
}
const token = 'e30.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-codex-account' } })).toString('base64url') + '.fixture';
const tool = { name: 'echo', description: 'Echo', parameters: { type: 'object', properties: { source: { type: 'string' }, optional: { type: 'number' } }, required: ['source'] } };
const grammar = { type: 'grammar', variants: { openai_lark: 'start: /[a-z]+/', openai_regex: '[a-z]+' } };
const vectors = [
  ['ordinary', tool], ['disabled', { ...tool, constrainedSampling: false }],
  ['strict-prefer', { ...tool, constrainedSampling: { type: 'json_schema', strict: 'prefer' } }],
  ['strict-require', { ...tool, constrainedSampling: { type: 'json_schema', strict: 'require' } }],
  ...['prefer', 'require'].map(strict => ['unsupported-' + strict, { ...tool, parameters: { ...tool.parameters, additionalProperties: true }, constrainedSampling: { type: 'json_schema', strict } }]),
  ['lark', { ...tool, constrainedSampling: grammar }],
  ['regex', { ...tool, constrainedSampling: { type: 'grammar', variants: { openai_regex: '[a-z]+' } } }],
  ['missing-grammar', { ...tool, constrainedSampling: { type: 'grammar', variants: {} } }],
  ['invalid-property', { ...tool, parameters: { type: 'object', properties: { source: { type: 'number' } }, required: ['source'] }, constrainedSampling: grammar }],
];
const user = { role: 'user', content: 'probe', timestamp: 1 }, raw = 'raw "source"\n\\tail';
const item = { type: 'custom_tool_call', id: 'ctc_native', call_id: 'call_native', name: 'echo', input: raw, status: 'completed' };
const events = [
  { type: 'response.output_item.added', output_index: 0, item: { ...item, input: '' } },
  { type: 'response.custom_tool_call_input.delta', output_index: 0, delta: raw.slice(0, 4) },
  { type: 'response.custom_tool_call_input.delta', output_index: 0, delta: raw.slice(4) },
  { type: 'response.custom_tool_call_input.done', output_index: 0, input: raw },
  { type: 'response.output_item.done', output_index: 0, item },
  { type: 'response.completed', response: { id: 'resp_grammar', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
];
let captured, responseEvents = prior.finalEvents, requests = 0;
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + token);
  requests++;
  captured = JSON.parse(new Headers(init.headers).get('content-encoding') === 'zstd' ? zstdDecompressSync(init.body).toString() : String(init.body));
  return new Response(responseEvents.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
};
async function call(model, messages, tools) {
  captured = undefined;
  const stream = provider.stream(model, normalizeContext({ messages, tools }), { apiKey: token, transport: 'sse', signal: AbortSignal.timeout(15000) });
  for await (const event of stream) { /* Consume the actual SDK. */ }
  return stream.result();
}
const rows = [], replays = [];
for (const id of ['gpt-5.3-codex-spark', 'gpt-6.1-sol']) {
  const model = models.find(model => model.id === id);
  for (const [name, declaration] of vectors) {
    responseEvents = prior.finalEvents;
    const result = await call(model, [user], [declaration]);
    const refused = ['unsupported-require', 'missing-grammar', 'invalid-property'].includes(name);
    assert.equal(result.stopReason === 'error', refused, result.errorMessage);
    assert.equal(captured === undefined, refused);
    rows.push({ model: id, case: name, tool: declaration, refused, ...(captured ? { body: captured } : {}) });
  }
  responseEvents = events;
  const first = await call(model, [user], [{ ...tool, constrainedSampling: grammar }]);
  assert.equal(first.stopReason, 'toolUse', first.errorMessage);
  assert.deepEqual(first.content[0].arguments, { source: raw });
  for (const kind of ['exact', 'foreign-provider', 'foreign-model', 'function']) {
    const assistant = structuredClone(first);
    if (kind === 'foreign-provider') assistant.provider = 'openai';
    if (kind === 'foreign-model') assistant.model = 'other';
    responseEvents = prior.finalEvents;
    await call(model, [user, assistant, { role: 'toolResult', toolCallId: 'call_native|ctc_native', toolName: 'echo', content: [{ type: 'text', text: 'result' }], isError: false, timestamp: 2 }],
      [{ ...tool, ...(kind === 'function' ? {} : { constrainedSampling: grammar }) }]);
    replays.push({ model: id, case: kind, expected: captured.input });
  }
}
const result = { pinnedCommit: prior.pinnedCommit, hashes, scope: 'Two representative pinned CX profiles, synthetic SSE only. No vendor/account/host/grammar-fulfilment certificate.',
  capabilities: models.map(model => ({ model: model.id, strict: model.compat?.supportsStrictMode ?? true, grammar: model.compat?.supportsOpenAIGrammarTools ?? false })),
  requests, refusals: rows.filter(row => row.refused).length, events, raw, rows, replays };
await writeFile('/tmp/codex-constrained-reference.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ requests, refusals: result.refusals, declarations: rows.length, replays: replays.length }));
