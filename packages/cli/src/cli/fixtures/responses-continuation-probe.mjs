import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Copied to the genuine installed consumer by installed-executable.test.ts.
// Resolve the executable through its installed PATH bin, never checkout dist.
const [provider, mode] = process.argv.slice(2);
assert(['native-r', 'azure', 'anthropic', 'google', 'vertex'].includes(provider)); assert(['print', 'json', 'rpc'].includes(mode));
const responses = ['native-r', 'azure'].includes(provider), anthropic = provider === 'anthropic';
const root = await mkdtemp(path.join(process.cwd(), 'responses-continuation-'));
const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
const journal = path.join(sessions, 'native-continuation.jsonl'), effects = path.join(root, 'effects'), preload = path.join(root, 'network.mjs');
const key = responses || anthropic ? 'installed-continuation-disposable-key' : 'c2VjcmV0';
const model = responses ? 'gpt-5' : anthropic ? 'claude-haiku-5-5' : 'gemini-3.8-flash';
const foreignModel = responses ? 'gpt-4o' : anthropic ? 'claude-sonnet-4-6' : 'gemini-2.5-flash';
const api = scope => ({ 'native-r': 'openai-responses', azure: 'azure-openai-responses', anthropic: 'anthropic-messages', google: 'google-generative-ai', vertex: 'google-vertex' })[scope];
const endpoint = (scope, selected = model) => scope === 'native-r' ? '/v1/responses' : scope === 'azure' ? '/openai/v1/responses?api-version=v1'
  : scope === 'anthropic' ? '/v1/messages' : `${scope === 'google' ? '/v1beta' : '/v1/projects/continuation-project/locations/us-central1/publishers/google'}/models/${selected}:streamGenerateContent?alt=sse`;
const bodies = [], wires = [];
function items(turn, redacted = true) {
  return [{ type: 'reasoning', id: `rs_empty_${turn}`, summary: [], encrypted_content: `opaque-empty-${turn}` },
    { type: 'message', id: `msg_left_${turn}`, phase: 'commentary', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `native-${turn}-left`, annotations: [] }] },
    { type: 'reasoning', id: `rs_visible_${turn}`, summary: [{ type: 'summary_text', text: `visible-${turn}` }], encrypted_content: `opaque-${redacted ? '[REDACTED]' : key}-tail` },
    ...(turn === 1 ? [{ type: 'function_call', id: 'fc_native', call_id: 'native-call', name: 'continuation_echo', arguments: '{"value":1}', status: 'completed' }] : []),
    { type: 'message', id: `msg_right_${turn}`, phase: 'final_answer', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `native-${turn}-right`, annotations: [] }] }];
}
function blocks(turn) {
  if (!responses) return signedBlocks(turn);
  return items(turn).map(item => item.type === 'reasoning'
    ? { type: 'reasoning', text: item.id === `rs_visible_${turn}` ? `visible-${turn}` : '', thinkingSignature: JSON.stringify(item) }
    : item.type === 'message' ? { type: 'text', text: item.id === `msg_left_${turn}` ? `native-${turn}-left` : `native-${turn}-right`, textSignature: JSON.stringify({ v: 1, id: item.id, phase: item.phase }) }
      : { type: 'tool_call', id: 'native-call|fc_native', name: 'continuation_echo', input: { value: 1 } });
}
const replay = turn => items(turn).map(item => item.type === 'function_call'
  ? { type: 'function_call', id: 'fc_native', call_id: 'native-call', name: 'continuation_echo', arguments: '{"value":1}' } : item);
function signedContent(turn, foreign = false, ids = true) {
  if (anthropic) return [{ type: 'text', text: `native-${turn}-left` },
    foreign ? { type: 'text', text: `visible-${turn}` } : { type: 'thinking', thinking: `visible-${turn}`, signature: 'opaque-[REDACTED]-tail' },
    ...(foreign ? [] : [{ type: 'redacted_thinking', data: `opaque-redacted-${turn}` }]), { type: 'text', text: `native-${turn}-right` },
    ...(turn === 1 ? [{ type: 'tool_use', id: 'native-call', name: 'continuation_echo', input: { value: 1 } }] : [])];
  return [{ text: `native-${turn}-left` }, { text: `visible-${turn}`, ...(foreign ? {} : { thought: true, thoughtSignature: 'bGFzdA==' }) },
    { text: `native-${turn}-right`, ...(foreign ? {} : { thoughtSignature: 'cmlnaHQ=' }) },
    ...(foreign ? [] : [{ text: '', thought: true, thoughtSignature: 'aGlkZGVu' }, { text: '', thoughtSignature: 'ZW1wdHk=' }]),
    ...(turn === 1 ? [{ functionCall: { ...(ids ? { id: 'native-call' } : {}), name: 'continuation_echo', args: { value: 1 } }, ...(foreign ? {} : { thoughtSignature: 'dG9vbA==' }) }] : [])];
}
function signedBlocks(turn) {
  if (anthropic) return [{ type: 'text', text: `native-${turn}-left` },
    { type: 'reasoning', text: `visible-${turn}`, thinkingSignature: 'opaque-[REDACTED]-tail' },
    { type: 'reasoning', text: '[Reasoning redacted]', redacted: true, thinkingSignature: `opaque-redacted-${turn}` }, { type: 'text', text: `native-${turn}-right` },
    ...(turn === 1 ? [{ type: 'tool_call', id: 'native-call', name: 'continuation_echo', input: { value: 1 } }] : [])];
  return [{ type: 'text', text: `native-${turn}-left`, textSignature: '[REDACTED]' },
    { type: 'reasoning', text: `visible-${turn}`, thinkingSignature: 'bGFzdA==' },
    { type: 'text', text: `native-${turn}-right`, textSignature: 'cmlnaHQ=' },
    { type: 'reasoning', text: '', thinkingSignature: 'aGlkZGVu' }, { type: 'text', text: '', textSignature: 'ZW1wdHk=' },
    ...(turn === 1 ? [{ type: 'tool_call', id: 'native-call', name: 'continuation_echo', input: { value: 1 }, thoughtSignature: 'dG9vbA==' }] : [])];
}
const assistants = body => responses ? body.input.filter(item => item.role === 'assistant' || ['reasoning', 'function_call'].includes(item.type))
  : anthropic ? body.messages.filter(item => item.role === 'assistant').map(item => item.content) : body.contents.filter(item => item.role === 'model').map(item => item.parts);
const opaque = responses ? ['opaque-', 'msg_left_', 'msg_right_', 'rs_empty_', 'rs_visible_'] : anthropic ? ['opaque-'] : ['bGFzdA==', 'cmlnaHQ=', 'aGlkZGVu', 'ZW1wdHk=', 'dG9vbA==', 'Zmlyc3Q='];
let fixtureError, summaryExpected = false;
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST');
    wires.push({ path: request.url, authorization: request.headers.authorization, apiKey: request.headers['api-key'],
      ...(!responses ? { googleKey: request.headers['x-goog-api-key'], anthropicKey: request.headers['x-api-key'] } : {}) });
    const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    const turn = bodies.length, summary = summaryExpected;
    summaryExpected = false;
    if (!responses) {
      const content = signedContent(turn);
      if (summary) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(anthropic
          ? { model: 'untrusted-response-alias', content: content.map(block => block.type === 'thinking' ? { ...block, signature: `opaque-${key}-tail` } : block),
            stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 } }
          : { modelVersion: 'untrusted-response-alias', candidates: [{ content: { parts: [{ ...content[0], thoughtSignature: key }, ...content.slice(1)] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } })); return;
      }
      const events = anthropic ? [{ type: 'message_start', message: { model: 'untrusted-response-alias' } },
        ...content.flatMap((block, index) => [
          { type: 'content_block_start', index, content_block: block.type === 'thinking' ? { ...block, signature: 'opaque-' } : block },
          ...(block.type === 'thinking' ? [{ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: `${key}-tail` } }] : []),
          { type: 'content_block_stop', index },
        ]), { type: 'message_delta', delta: { stop_reason: turn === 1 ? 'tool_use' : 'end_turn' } }, { type: 'message_stop' }]
        : [{ candidates: [{ content: { parts: [{ ...content[0], thoughtSignature: key }, { ...content[1], thoughtSignature: 'Zmlyc3Q=' }] } }] },
          { candidates: [{ content: { parts: [{ text: '', thought: true, thoughtSignature: 'bGFzdA==' }, ...content.slice(2)] } }] },
          { modelVersion: 'untrusted-response-alias', candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } }];
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')); return;
    }
    const output = items(turn, false), azure = request.url.startsWith('/openai/');
    const events = [{ type: 'response.created', response: { id: `resp_${turn}`, output: [] } }];
    for (const [index, item] of output.entries()) {
      const done = azure && item.type === 'reasoning' ? { ...item, encrypted_content: undefined } : item;
      events.push({ type: 'response.output_item.added', output_index: index, item: { ...done, ...(item.type === 'function_call' ? { arguments: '' } : {}) } });
      if (item.type === 'message') events.push({ type: 'response.output_text.delta', output_index: index, delta: item.id === `msg_left_${turn}` ? `native-${turn}-left` : `native-${turn}-right` });
      if (item.id === `rs_visible_${turn}`) for (const delta of ['visible-', String(turn)]) events.push({ type: 'response.reasoning_summary_text.delta', output_index: index, delta });
      if (item.type === 'function_call') for (const delta of ['{"value":', '1}']) events.push({ type: 'response.function_call_arguments.delta', output_index: index, delta });
      events.push({ type: 'response.output_item.done', output_index: index, item: done });
    }
    events.push({ type: 'response.completed', response: { id: `resp_${turn}`, model: 'untrusted-response-alias', status: 'completed', output,
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid installed continuation fixture'); }
});
let active;
try {
  // This public import and the extension below resolve the unpacked consumer package.
  const entry = await realpath(new URL(import.meta.resolve('@ai-harness/core')));
  assert(entry.startsWith(path.join(process.cwd(), 'node_modules', '@ai-harness', 'core') + path.sep));
  const bin = await realpath(path.join(process.cwd(), 'node_modules/.bin/ai-harness'));
  assert(bin.startsWith(path.join(process.cwd(), 'node_modules', '@ai-harness', 'cli') + path.sep));
  await mkdir(cwd); await mkdir(path.join(agent, 'extensions'), { recursive: true });
  await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ transport: 'sse', cacheWarming: 'off' }));
  await writeFile(path.join(agent, 'extensions/continuation.mjs'), `import { OpenAiMixedProvider } from '@ai-harness/core';
    import { appendFileSync } from 'node:fs';
    export default api => {
      if (${JSON.stringify(responses)}) api.registerProvider('native-r', { defaultConfig: { apiKey: ${JSON.stringify(key)}, model: 'gpt-5' }, create: config => new OpenAiMixedProvider(config) });
      api.registerTool({ name: 'continuation_echo', description: 'Echo', parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
        execute: input => { appendFileSync(${JSON.stringify(effects)}, JSON.stringify(input) + '\\n'); return { content: 'native-tool-result' }; } });
    };`);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await writeFile(preload, `const original = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const allowed = ${JSON.stringify(responses)}
        ? (url.origin === 'https://api.openai.com' && url.pathname === '/v1/responses')
          || (url.origin === 'https://continuation.openai.azure.com' && url.pathname === '/openai/v1/responses')
        : ${JSON.stringify(anthropic)} ? url.origin === 'https://api.anthropic.com' && url.pathname === '/v1/messages'
        : ['https://generativelanguage.googleapis.com', 'https://us-central1-aiplatform.googleapis.com'].includes(url.origin)
          && /\\/models\\/gemini-(3\\.8|2\\.5)-flash:(streamGenerateContent|generateContent)$/.test(url.pathname);
      if (!allowed) throw new Error('Non-fixture transport refused');
      const target = new URL(url.pathname + url.search, ${JSON.stringify(base)});
      return original(input instanceof Request ? new Request(target, input) : target, init);
    };`);
  const env = { ...process.env, AI_HARNESS_AGENT_DIR: agent, AI_HARNESS_EXTENSIONS: '',
    ...(responses ? { OPENAI_API_KEY: key, AZURE_OPENAI_API_KEY: key, AZURE_OPENAI_BASE_URL: 'https://continuation.openai.azure.com/openai/v1',
      AZURE_OPENAI_MODEL: model, AZURE_OPENAI_DEPLOYMENT_NAME_MAP: 'gpt-5=owned-deployment,gpt-4o=foreign-deployment' }
      : anthropic ? { ANTHROPIC_API_KEY: key } : { GEMINI_API_KEY: key, GOOGLE_API_KEY: key, GOOGLE_VERTEX_ACCESS_TOKEN: key,
        GOOGLE_CLOUD_PROJECT: 'continuation-project', GOOGLE_CLOUD_LOCATION: 'us-central1' }), NODE_OPTIONS: '--import=' + JSON.stringify(preload) };
  const start = () => {
    const child = spawn('ai-harness', ['--no-approve', '--offline', '--api-key', key, '--session-dir', sessions, '--session-id', 'native-continuation',
      '--model', `${provider}/${model}`, '--thinking', 'low', ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['Continue native history.'])], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    active = child;
    let stdout = '', stderr = '', buffer = ''; const records = [];
    child.stdout.setEncoding('utf8').on('data', text => {
      stdout += text; if (mode === 'print') return; buffer += text;
      while (buffer.includes('\n')) { const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line.trim()) records.push(JSON.parse(line)); }
    });
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    const ended = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); }); });
    const wait = predicate => new Promise((resolve, reject) => {
      const cleanup = () => { child.stdout.off('data', check); child.off('close', closed); };
      const check = () => { if (predicate()) { cleanup(); resolve(); } };
      const closed = (code, signal) => { cleanup(); reject(new Error(JSON.stringify({ code, signal, stderr, records }))); };
      child.stdout.on('data', check); child.once('close', closed); check();
    });
    const command = async record => { child.stdin.write(JSON.stringify(record) + '\n'); await wait(() => records.some(value => value.type === 'response' && value.id === record.id && value.success === true));
      return records.find(value => value.type === 'response' && value.id === record.id); };
    const prompt = async count => { await command({ type: 'prompt', id: `prompt-${count}`, message: 'Continue native history.' }); await wait(() => records.filter(value => value.type === 'agent_settled').length === count); };
    const finish = async () => {
      child.stdin.end(); assert.deepEqual(await ended, { code: 0, signal: null }, stderr); assert.equal(stderr, ''); assert.equal(buffer, '');
      assert(!stdout.includes(key)); active = undefined; return { stdout, records };
    };
    return { prompt, command, finish };
  };
  const readJournal = async () => {
    const bytes = await readFile(journal, 'utf8'); assert(!bytes.includes(key)); assert.equal((await stat(journal)).mode & 0o777, 0o600);
    return bytes.trim().split('\n').map(line => JSON.parse(line));
  };
  const sourceAssistants = entries => entries.filter(entry => entry.type === 'message' && entry.role === 'assistant');
  if (mode !== 'rpc') {
    for (const run of [1, 2]) {
      const result = await start().finish();
      if (mode === 'print') assert.equal(result.stdout, `native-${run + 1}-leftnative-${run + 1}-right\n`);
      else {
        assert.equal(result.records.filter(record => record.type === 'agent_settled').length, 1);
        assert.deepEqual(result.records.filter(record => record.type === 'message_end' && record.message?.role === 'assistant').map(record => record.message.content),
          (run === 1 ? [1, 2] : [3]).map(turn => [{ type: 'text', text: `native-${turn}-leftnative-${turn}-right` }, { type: 'thinking', thinking: `visible-${turn}` },
            ...(turn === 1 ? [{ type: 'toolCall', id: responses ? 'native-call|fc_native' : 'native-call', name: 'continuation_echo', arguments: { value: 1 } }] : [])]));
        for (const value of opaque) assert(!result.stdout.includes(value));
      }
      const history = sourceAssistants(await readJournal());
      assert.deepEqual(history.map(entry => entry.blocks), Array.from({ length: run + 1 }, (_, index) => blocks(index + 1)));
      for (const entry of history) { assert.equal(entry.provider, provider); assert.equal(entry.api, api(provider)); assert.equal(entry.model, model); }
    }
    assert.equal(bodies.length, 3);
    if (responses) assert(bodies[0].include.includes('reasoning.encrypted_content'));
    for (const index of [1, 2]) assert.deepEqual(assistants(bodies[index]), responses
      ? Array.from({ length: index }, (_, turn) => replay(turn + 1)).flat() : Array.from({ length: index }, (_, turn) => signedContent(turn + 1)));
  } else if (responses) {
    const process = start(), other = provider === 'native-r' ? 'azure' : 'native-r';
    const foreign = (index, turns) => {
      const projected = assistants(bodies[index]); assert.deepEqual(projected.filter(item => item.type === 'reasoning'), []);
      assert.deepEqual(projected.filter(item => item.role === 'assistant').map(item => item.content), turns.flatMap(turn =>
        [`native-${turn}-left`, `visible-${turn}`, `native-${turn}-right`].map(text => [{ type: 'output_text', text, annotations: [] }])));
      assert.deepEqual(projected.filter(item => item.type === 'function_call').map(({ id, ...item }) => item),
        [{ type: 'function_call', call_id: 'native-call', name: 'continuation_echo', arguments: '{"value":1}' }]);
      for (const value of [...opaque, 'fc_native']) assert(!JSON.stringify(projected).includes(value));
    };
    await process.prompt(1); await process.prompt(2);
    assert.deepEqual(assistants(bodies[1]), replay(1)); assert.deepEqual(assistants(bodies[2]), [1, 2].flatMap(replay));
    const original = sourceAssistants(await readJournal());
    await process.command({ type: 'set_model', id: 'foreign-model', provider, modelId: foreignModel }); await process.prompt(3); foreign(3, [1, 2, 3]);
    await process.command({ type: 'set_model', id: 'foreign-provider', provider: other, modelId: model }); await process.prompt(4); foreign(4, [1, 2, 3, 4]);
    assert.deepEqual(sourceAssistants(await readJournal()).slice(0, 3), original);
    await process.command({ type: 'set_model', id: 'owner', provider, modelId: model });
    await process.command({ type: 'context_edit', id: 'edit', targetEntryId: original[0].id, replacement: 'edited answer' }); await process.prompt(5);
    const projected = assistants(bodies[5]);
    assert.deepEqual(projected.slice(0, 10), [{ type: 'function_call', id: 'fc_native', call_id: 'native-call', name: 'continuation_echo', arguments: '{"value":1}' },
      { type: 'message', role: 'assistant', id: 'msg_pi_1', status: 'completed', content: [{ type: 'output_text', text: 'edited answer', annotations: [] }] }, ...[2, 3].flatMap(replay)]);
    assert.deepEqual(projected.slice(10).filter(item => item.role === 'assistant').map(item => item.content), [4, 5].flatMap(turn =>
      [`native-${turn}-left`, `visible-${turn}`, `native-${turn}-right`].map(text => [{ type: 'output_text', text, annotations: [] }])));
    assert(!JSON.stringify(projected.slice(10)).includes('opaque-'));
    const result = await process.finish(), entries = await readJournal(), history = sourceAssistants(entries);
    assert.deepEqual(history.slice(0, 3), original); assert.deepEqual(history.map(entry => entry.blocks), Array.from({ length: 6 }, (_, index) => blocks(index + 1)));
    for (const [index, entry] of history.entries()) { const scope = index === 4 ? other : provider;
      assert.equal(entry.provider, scope); assert.equal(entry.api, api(scope)); assert.equal(entry.model, index === 3 ? foreignModel : model); }
    assert.equal(entries.filter(entry => entry.type === 'context_edit').length, 1); assert.equal(bodies.length, 6);
    assert(!JSON.stringify(result.records).includes(key));
    for (const value of opaque) assert(!JSON.stringify(result.records.filter(record => record.type === 'message_end')).includes(value));
  } else {
    const process = start(), other = provider === 'google' ? 'vertex' : 'google';
    await process.prompt(1); await process.prompt(2);
    assert.deepEqual(assistants(bodies[1]), [signedContent(1)]); assert.deepEqual(assistants(bodies[2]), [1, 2].map(turn => signedContent(turn)));
    const original = sourceAssistants(await readJournal());
    await process.command({ type: 'set_model', id: 'foreign-model', provider, modelId: foreignModel }); await process.prompt(3);
    assert.deepEqual(assistants(bodies[3]), [1, 2, 3].map(turn => signedContent(turn, true, false)));
    if (!anthropic) {
      await process.command({ type: 'set_model', id: 'foreign-provider', provider: other, modelId: model }); await process.prompt(4);
      assert.deepEqual(assistants(bodies[4]), [1, 2, 3, 4].map(turn => signedContent(turn, true)));
    }
    assert.deepEqual(sourceAssistants(await readJournal()).slice(0, 3), original);
    await process.command({ type: 'set_model', id: 'owner', provider, modelId: model });
    await process.command({ type: 'context_edit', id: 'edit', targetEntryId: original[0].id, replacement: 'edited answer' }); await process.prompt(anthropic ? 4 : 5);
    assert.deepEqual(assistants(bodies.at(-1)), [
      anthropic ? [{ type: 'tool_use', id: 'native-call', name: 'continuation_echo', input: { value: 1 } }, { type: 'text', text: 'edited answer' }]
        : [{ functionCall: { id: 'native-call', name: 'continuation_echo', args: { value: 1 } }, thoughtSignature: 'dG9vbA==' }, { text: 'edited answer' }],
      signedContent(2), signedContent(3), ...Array.from({ length: anthropic ? 1 : 2 }, (_, index) => signedContent(index + 4, true)),
    ]);
    const result = await process.finish(), entries = await readJournal(), history = sourceAssistants(entries);
    assert.deepEqual(history.slice(0, 3), original);
    assert.deepEqual(history.map(entry => entry.blocks), Array.from({ length: anthropic ? 5 : 6 }, (_, index) => signedBlocks(index + 1)));
    for (const [index, entry] of history.entries()) { const scope = !anthropic && index === 4 ? other : provider;
      assert.equal(entry.provider, scope); assert.equal(entry.api, api(scope)); assert.equal(entry.model, index === 3 ? foreignModel : model); }
    assert.equal(entries.filter(entry => entry.type === 'context_edit').length, 1); assert.equal(bodies.length, anthropic ? 5 : 6);
    assert(!JSON.stringify(result.records).includes(key));
    for (const value of opaque) assert(!JSON.stringify(result.records.filter(record => record.type === 'message_end')).includes(value));
  }
  const scopes = mode === 'rpc' ? anthropic ? Array(5).fill(provider) : [provider, provider, provider, provider,
    responses ? provider === 'native-r' ? 'azure' : 'native-r' : provider === 'google' ? 'vertex' : 'google', provider] : Array(3).fill(provider);
  if (responses) {
    assert.deepEqual(wires, scopes.map(scope => ({ path: endpoint(scope), authorization: scope === 'native-r' ? `Bearer ${key}` : undefined, apiKey: scope === 'azure' ? key : undefined })));
    assert.deepEqual(bodies.map(body => body.model), scopes.map((scope, index) => scope === 'azure' ? index === 3 ? 'foreign-deployment' : 'owned-deployment' : index === 3 ? foreignModel : model));
    assert(bodies.every(body => body.stream === true));
    for (const body of bodies.slice(1)) assert.deepEqual(body.input.filter(item => item.type === 'function_call_output'), [{ type: 'function_call_output', call_id: 'native-call', output: 'native-tool-result' }]);
  } else {
    assert.deepEqual(wires, scopes.map((scope, index) => ({ path: endpoint(scope, index === 3 ? foreignModel : model), apiKey: undefined,
      authorization: scope === 'vertex' ? `Bearer ${key}` : undefined, googleKey: scope === 'google' ? key : undefined, anthropicKey: scope === 'anthropic' ? key : undefined })));
    if (anthropic) assert.deepEqual(bodies.map(body => body.model), scopes.map((_, index) => index === 3 ? foreignModel : model));
    for (const body of bodies.slice(1)) assert.deepEqual(anthropic
      ? body.messages.flatMap(item => Array.isArray(item.content) ? item.content : []).filter(item => item.type === 'tool_result')
      : body.contents.flatMap(item => item.parts).filter(item => item.functionResponse), anthropic
      ? [{ type: 'tool_result', tool_use_id: 'native-call', content: 'native-tool-result', is_error: false, ...(body === bodies[1] ? { cache_control: { type: 'ephemeral' } } : {}) }]
      : [{ functionResponse: { ...(body === bodies[3] ? {} : { id: 'native-call' }), name: 'continuation_echo', response: { output: 'native-tool-result' } } }]);
  }
  if (mode === 'rpc') {
    const Core = await import('@ai-harness/core'), before = await readJournal(), original = sourceAssistants(before), turn = bodies.length;
    const work = start(); summaryExpected = true;
    const compacted = await work.command({ type: 'compact', id: 'native-compact' });
    const summary = `native-${turn + 1}-leftnative-${turn + 1}-right`, summaryBody = bodies[turn];
    assert.equal(bodies.length, turn + 1); assert.equal(summaryExpected, false);
    assert.equal(compacted.data.summary, summary); assert.equal(summaryBody.max_output_tokens ?? summaryBody.max_tokens ?? summaryBody.generationConfig?.maxOutputTokens, 4096);
    assert.deepEqual(summaryBody.tools ?? summaryBody.toolConfig?.tools ?? [], []);
    const summaryHistory = JSON.stringify(assistants(summaryBody));
    assert(summaryHistory.includes('edited answer')); assert(!summaryHistory.includes('visible-'));
    for (const value of [...opaque, 'Signature', 'encrypted_content']) assert(!summaryHistory.includes(value), value);
    const manager = new Core.SessionManager({ store: new Core.JsonlSessionStore(sessions) });
    const loaded = await manager.loadFromStore('native-continuation'); assert(loaded);
    const canonical = Core.getCompactionModelMessages(manager, loaded.id), entries = await readJournal();
    assert.deepEqual(sourceAssistants(entries), original);
    assert.deepEqual(canonical.filter(message => message.role === 'assistant').map(message => message.blocks), [blocks(turn)]);
    assert.deepEqual(canonical.filter(message => message.role === 'tool'), []);
    assert(canonical.some(message => message.content.includes(summary)));
    const entry = entries.find(entry => entry.type === 'compaction'); assert(entry);
    assert.equal(entry.summary, summary); assert.equal(entry.firstKeptEntryId, compacted.data.firstKeptEntryId);
    assert.equal(entry.provider, provider); assert.equal(entry.model, model);
    assert.equal(entry.usage.inputTokens, 5); assert.equal(entry.usage.outputTokens, 2);
    for (const value of [...opaque, 'Signature', 'encrypted_content']) assert(!JSON.stringify(entry).includes(value), value);
    await work.prompt(1); const firstReplay = bodies[turn + 1];
    assert.deepEqual(assistants(firstReplay), responses ? replay(turn) : [signedContent(turn)]);
    assert(JSON.stringify(firstReplay).includes(summary));
    assert.deepEqual(responses ? firstReplay.input.filter(item => item.type === 'function_call_output')
      : anthropic ? firstReplay.messages.flatMap(item => Array.isArray(item.content) ? item.content : []).filter(item => item.type === 'tool_result')
      : firstReplay.contents.flatMap(item => item.parts).filter(item => item.functionResponse), []);
    const result = await work.finish();
    assert.deepEqual(result.records.filter(record => record.type === 'compaction_start'), [{ type: 'compaction_start', reason: 'manual' }]);
    assert.equal(result.records.filter(record => record.type === 'compaction_end' && record.aborted === false && record.result?.summary === summary).length, 1);
    for (const value of opaque) assert(!JSON.stringify(result.records).includes(value), value);
    const resumed = start(); await resumed.prompt(1); const resumedResult = await resumed.finish();
    assert.deepEqual(assistants(bodies[turn + 2]), responses ? [turn, turn + 2].flatMap(replay) : [turn, turn + 2].map(value => signedContent(value)));
    for (const value of opaque) assert(!JSON.stringify(resumedResult.records).includes(value), value);
    assert.equal(bodies.length, turn + 3);
    const expectedWire = { path: endpoint(provider), authorization: provider === 'native-r' || provider === 'vertex' ? `Bearer ${key}` : undefined,
      apiKey: provider === 'azure' ? key : undefined, ...(!responses ? { googleKey: provider === 'google' ? key : undefined, anthropicKey: anthropic ? key : undefined } : {}) };
    assert.deepEqual(wires.slice(turn), [{ ...expectedWire, path: expectedWire.path.replace('streamGenerateContent?alt=sse', 'generateContent') }, expectedWire, expectedWire]);
    const after = await readJournal(); assert.deepEqual(sourceAssistants(after).map(entry => entry.blocks), [...original.map(entry => entry.blocks), blocks(turn + 2), blocks(turn + 3)]);
    const metadata = after.find(entry => entry.type === 'metadata');
    assert.equal(metadata.activeLeafId, sourceAssistants(after).at(-1).id);
    assert.equal(metadata.metadata.compactionSummary, summary); assert.equal(metadata.metadata.compactionEntryId, entry.id);
    for (const entry of before.filter(entry => entry.type !== 'metadata')) assert.deepEqual(after.find(value => value.id === entry.id), entry);
  }
  assert.equal(await readFile(effects, 'utf8'), '{"value":1}\n'); assert.equal(fixtureError, undefined);
  console.log(responses ? 'INSTALLED_RESPONSES_CONTINUATION_OK' : 'INSTALLED_SIGNED_CONTINUATION_OK');
} finally {
  if (active && active.exitCode === null && active.signalCode === null) active.kill('SIGKILL');
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true });
}
