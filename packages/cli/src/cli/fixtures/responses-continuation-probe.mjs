import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { crc32 } from 'node:zlib';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Copied to the genuine installed consumer by installed-executable.test.ts.
// Resolve the executable through its installed PATH bin, never checkout dist.
const [provider, mode, credentialSource = 'cli', selectedModel] = process.argv.slice(2);
assert(['native-r', 'azure', 'anthropic', 'google', 'vertex', 'bedrock', 'minimax', 'minimax-cn'].includes(provider)); assert(['print', 'json', 'rpc'].includes(mode));
const minimax = provider === 'minimax' || provider === 'minimax-cn';
assert(credentialSource === 'cli' || credentialSource === 'extension-default' && minimax);
assert(selectedModel === undefined || minimax && ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M3'].includes(selectedModel));
const responses = ['native-r', 'azure'].includes(provider), anthropic = provider === 'anthropic' || minimax, bedrock = provider === 'bedrock';
const root = await mkdtemp(path.join(process.cwd(), 'responses-continuation-'));
const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
const journal = path.join(sessions, 'native-continuation.jsonl'), effects = path.join(root, 'effects'), preload = path.join(root, 'network.mjs');
const key = responses || anthropic || bedrock ? 'installed-continuation-disposable-key' : 'c2VjcmV0';
const model = minimax ? selectedModel ?? 'MiniMax-M2.7' : responses ? 'gpt-5' : anthropic ? 'claude-haiku-5-5' : bedrock ? 'anthropic.claude-opus-4-6-v1' : 'gemini-3.8-flash';
const foreignModel = minimax ? model === 'MiniMax-M3' ? 'MiniMax-M2.7' : 'MiniMax-M3' : responses ? 'gpt-4o' : anthropic ? 'claude-sonnet-4-6' : bedrock ? 'anthropic.claude-sonnet-4-6' : 'gemini-2.5-flash';
const api = scope => ({ 'native-r': 'openai-responses', azure: 'azure-openai-responses', anthropic: 'anthropic-messages', minimax: 'anthropic-messages', 'minimax-cn': 'anthropic-messages', google: 'google-generative-ai', vertex: 'google-vertex', bedrock: 'bedrock-converse-stream' })[scope];
const endpoint = (scope, selected = model) => scope === 'native-r' ? '/v1/responses' : scope === 'azure' ? '/openai/v1/responses?api-version=v1'
  : scope === 'minimax' || scope === 'minimax-cn' ? '/anthropic/v1/messages'
  : scope === 'anthropic' ? '/v1/messages' : scope === 'bedrock' ? `/model/${encodeURIComponent(selected)}/converse-stream`
    : `${scope === 'google' ? '/v1beta' : '/v1/projects/continuation-project/locations/us-central1/publishers/google'}/models/${selected}:streamGenerateContent?alt=sse`;
const summaryEndpoint = value => value.replace('streamGenerateContent?alt=sse', 'generateContent').replace('/converse-stream', '/converse');
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
  if (bedrock) {
    return [{ text: `native-${turn}-left` }, foreign ? { text: `visible-${turn}` }
      : { reasoningContent: { reasoningText: { text: `visible-${turn}`, signature: 'opaque-[REDACTED]-tail' } } },
    ...(foreign ? [] : [{ reasoningContent: { redactedContent: 'AP8BgAI=' } }]), { text: `native-${turn}-right` },
    ...(turn === 1 ? [{ toolUse: { toolUseId: 'native-call', name: 'continuation_echo', input: { value: 1 } } }] : [])];
  }
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
  if (bedrock) {
    return [{ type: 'text', text: `native-${turn}-left` }, { type: 'reasoning', text: `visible-${turn}`, thinkingSignature: 'opaque-[REDACTED]-tail' },
      { type: 'reasoning', text: '', redacted: true, thinkingSignature: 'AP8BgAI=' }, { type: 'text', text: `native-${turn}-right` },
      ...(turn === 1 ? [{ type: 'tool_call', id: 'native-call', name: 'continuation_echo', input: { value: 1 } }] : [])];
  }
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
  : anthropic || bedrock ? body.messages.filter(item => item.role === 'assistant').map(item => item.content) : body.contents.filter(item => item.role === 'model').map(item => item.parts);
const opaque = responses ? ['opaque-', 'msg_left_', 'msg_right_', 'rs_empty_', 'rs_visible_'] : anthropic ? ['opaque-'] : bedrock ? ['opaque-', 'AP8BgAI='] : ['bGFzdA==', 'cmlnaHQ=', 'aGlkZGVu', 'ZW1wdHk=', 'dG9vbA==', 'Zmlyc3Q='];
// Independently frame the copied installed probe's AWS transport; never import checkout/provider internals.
function bedrockFrame(type, body, messageType = 'event') {
  const headers = Buffer.concat(Object.entries({ ':message-type': messageType, ':event-type': type, ':content-type': 'application/json' }).map(([name, value]) => {
    const key = Buffer.from(name), text = Buffer.from(value), length = Buffer.alloc(2); length.writeUInt16BE(text.length);
    return Buffer.concat([Buffer.from([key.length]), key, Buffer.from([7]), length, text]);
  }));
  const payload = Buffer.from(JSON.stringify(body)), frame = Buffer.alloc(16 + headers.length + payload.length);
  frame.writeUInt32BE(frame.length); frame.writeUInt32BE(headers.length, 4); frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8);
  headers.copy(frame, 12); payload.copy(frame, 12 + headers.length); frame.writeUInt32BE(crc32(frame.subarray(0, -4)), frame.length - 4);
  return frame;
}
let fixtureError, summaryExpected = false, overflowRemaining = 0, partialFailure = false, holdNative = false, endNative = false, heldClosed, resetPeer;
const overflowPrivate = 'PRIVATE_OVERFLOW_DIAGNOSTIC', streamPrivate = 'PRIVATE_NATIVE_STREAM_DIAGNOSTIC', cancelMarker = 'PUBLIC_WITHDRAW_BOUNDARY.';
const resetMarker = 'PUBLIC_TRANSPORT_RESET_BOUNDARY.'; let holdMarker = cancelMarker;
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST');
    if (minimax) assert.equal(request.headers['anthropic-version'], '2023-06-01');
    wires.push({ path: request.url, authorization: request.headers.authorization, apiKey: request.headers['api-key'],
      ...(!responses ? { googleKey: request.headers['x-goog-api-key'], anthropicKey: request.headers['x-api-key'] } : {}) });
    const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    const turn = bodies.length;
    if (overflowRemaining > 0 && !JSON.stringify(bodies.at(-1)).includes('Produce a concise context summary for future assistant turns.')) {
      overflowRemaining--; response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'context_length_exceeded', message: `${overflowPrivate} ${key}` } })); return;
    }
    const summary = summaryExpected, failing = partialFailure, withdrawing = holdNative, ending = endNative; summaryExpected = false; partialFailure = false; holdNative = false; endNative = false;
    if (bedrock) {
      const content = signedContent(turn).map(block => block.reasoningContent?.reasoningText
        ? { reasoningContent: { reasoningText: { ...block.reasoningContent.reasoningText, signature: `opaque-${key}-tail` } } } : block);
      if (summary) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ output: { message: { role: 'assistant', content } }, stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } })); return;
      }
      if (failing || withdrawing || ending) content.push({ toolUse: { toolUseId: 'unpublished-call', name: 'continuation_echo', input: { value: 999 } } });
      if (withdrawing) content.push({ text: holdMarker });
      const frames = [bedrockFrame('messageStart', { role: 'assistant' })];
      for (const [contentBlockIndex, block] of content.entries()) {
        const delta = value => frames.push(bedrockFrame('contentBlockDelta', { contentBlockIndex, delta: value }));
        if (block.text !== undefined) delta({ text: block.text });
        else if (block.toolUse) {
          frames.push(bedrockFrame('contentBlockStart', { contentBlockIndex, start: { toolUse: { toolUseId: block.toolUse.toolUseId, name: block.toolUse.name } } }));
          delta({ toolUse: { input: JSON.stringify(block.toolUse.input) } });
        } else if (block.reasoningContent.reasoningText) {
          delta({ reasoningContent: { text: block.reasoningContent.reasoningText.text } });
          for (const signature of ['opaque-', `${key}-tail`]) delta({ reasoningContent: { signature } });
        } else for (const redactedContent of ['AP8=', 'AYAC']) delta({ reasoningContent: { redactedContent } });
        frames.push(bedrockFrame('contentBlockStop', { contentBlockIndex }));
      }
      if (failing) frames.push(bedrockFrame('internalServerException', { message: `${streamPrivate} ${key}` }, 'exception'));
      else if (!withdrawing && !ending) frames.push(bedrockFrame('messageStop', { stopReason: turn === 1 ? 'tool_use' : 'end_turn' }),
        bedrockFrame('metadata', { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }));
      response.writeHead(200, { 'Content-Type': 'application/vnd.amazon.eventstream' });
      if (withdrawing) {
        resetPeer = () => response.socket.resetAndDestroy(); heldClosed = new Promise(resolve => response.once('close', resolve)); response.write(Buffer.concat(frames)); return;
      }
      response.end(Buffer.concat(frames)); return;
    }
    if (!responses) {
      const content = signedContent(turn);
      if (failing || withdrawing || ending) content.push(anthropic ? { type: 'tool_use', id: 'unpublished-call', name: 'continuation_echo', input: { value: 999 } }
        : { functionCall: { id: 'unpublished-call', name: 'continuation_echo', args: { value: 999 } }, thoughtSignature: 'dG9vbA==' });
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
      if (ending) events.splice(anthropic ? -2 : -1, anthropic ? 2 : 1);
      if (failing) events.splice(anthropic ? -2 : -1, anthropic ? 2 : 1,
        { ...(anthropic ? { type: 'error' } : {}), error: { type: 'server_error', message: `${streamPrivate} ${key}` } });
      if (withdrawing) events.splice(anthropic ? -2 : -1, anthropic ? 2 : 1, ...(anthropic ? [
        { type: 'content_block_start', index: content.length, content_block: { type: 'text', text: holdMarker } }, { type: 'content_block_stop', index: content.length },
      ] : [{ candidates: [{ content: { parts: [{ text: holdMarker }] } }] }]));
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (withdrawing) {
        resetPeer = () => response.socket.resetAndDestroy();
        heldClosed = new Promise(resolve => response.once('close', resolve)); response.write(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')); return;
      }
      response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')); return;
    }
    const output = [...items(turn, false), ...(failing || withdrawing || ending ? [{ type: 'function_call', id: 'fc_unpublished', call_id: 'unpublished-call',
      name: 'continuation_echo', arguments: '{"value":1}', status: 'completed' }] : [])], azure = request.url.startsWith('/openai/');
    const events = [{ type: 'response.created', response: { id: `resp_${turn}`, output: [] } }];
    for (const [index, item] of output.entries()) {
      const done = azure && item.type === 'reasoning' && !failing && !withdrawing && !ending ? { ...item, encrypted_content: undefined } : item;
      events.push({ type: 'response.output_item.added', output_index: index, item: { ...done, ...(item.type === 'function_call' ? { arguments: '' } : {}) } });
      if (item.type === 'message') events.push({ type: 'response.output_text.delta', output_index: index, delta: item.id === `msg_left_${turn}` ? `native-${turn}-left` : `native-${turn}-right` });
      if (item.id === `rs_visible_${turn}`) for (const delta of ['visible-', String(turn)]) events.push({ type: 'response.reasoning_summary_text.delta', output_index: index, delta });
      if (item.type === 'function_call') for (const delta of ['{"value":', '1}']) events.push({ type: 'response.function_call_arguments.delta', output_index: index, delta });
      events.push({ type: 'response.output_item.done', output_index: index, item: done });
    }
    events.push({ type: 'response.completed', response: { id: `resp_${turn}`, model: 'untrusted-response-alias', status: 'completed', output,
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } });
    if (ending) events.splice(-1, 1);
    if (failing) events.splice(-1, 1, { type: 'error', error: { message: `${streamPrivate} ${key}` } });
    if (withdrawing) events.splice(-1, 1,
      { type: 'response.output_item.added', output_index: output.length, item: { type: 'message', id: 'msg_cancel_boundary', role: 'assistant', status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', output_index: output.length, delta: holdMarker });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (withdrawing) {
      resetPeer = () => response.socket.resetAndDestroy();
      heldClosed = new Promise(resolve => response.once('close', resolve)); response.write(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')); return;
    }
    response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid installed continuation fixture'); }
});
let active, processes = 0;
try {
  // This public import and the extension below resolve the unpacked consumer package.
  const entry = await realpath(new URL(import.meta.resolve('@ai-harness/core')));
  assert(entry.startsWith(path.join(process.cwd(), 'node_modules', '@ai-harness', 'core') + path.sep));
  const bin = await realpath(path.join(process.cwd(), 'node_modules/.bin/ai-harness'));
  assert(bin.startsWith(path.join(process.cwd(), 'node_modules', '@ai-harness', 'cli') + path.sep));
  await mkdir(cwd); await mkdir(path.join(agent, 'extensions'), { recursive: true });
  await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ transport: 'sse', cacheWarming: 'off' }));
  await writeFile(path.join(agent, 'extensions/continuation.mjs'), `import { OpenAiMixedProvider, MiniMaxProvider, MiniMaxCnProvider } from '@ai-harness/core';
    import { appendFileSync } from 'node:fs';
    export default api => {
      if (${JSON.stringify(responses)}) api.registerProvider('native-r', { defaultConfig: { apiKey: ${JSON.stringify(key)}, model: 'gpt-5' }, create: config => new OpenAiMixedProvider(config) });
      if (${JSON.stringify(minimax)}) api.registerProvider(${JSON.stringify(provider)}, { defaultConfig: { apiKey: ${JSON.stringify(key)}, model: ${JSON.stringify(model)} }, create: config => new ${provider === 'minimax-cn' ? 'MiniMaxCnProvider' : 'MiniMaxProvider'}(config) });
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
        : ${JSON.stringify(minimax)} ? url.origin === ${JSON.stringify(provider === 'minimax-cn' ? 'https://api.minimaxi.com' : 'https://api.minimax.io')} && url.pathname === '/anthropic/v1/messages'
        : ${JSON.stringify(anthropic)} ? url.origin === 'https://api.anthropic.com' && url.pathname === '/v1/messages'
        : ${JSON.stringify(bedrock)} ? url.origin === 'https://bedrock-runtime.us-east-1.amazonaws.com'
          && ${JSON.stringify([model, foreignModel])}.some(model => ['/converse', '/converse-stream'].some(operation => url.pathname === '/model/' + encodeURIComponent(model) + operation))
        : ['https://generativelanguage.googleapis.com', 'https://us-central1-aiplatform.googleapis.com'].includes(url.origin)
          && /\\/models\\/gemini-(3\\.8|2\\.5)-flash:(streamGenerateContent|generateContent)$/.test(url.pathname);
      if (!allowed) throw new Error('Non-fixture transport refused');
      const target = new URL(url.pathname + url.search, ${JSON.stringify(base)});
      return original(input instanceof Request ? new Request(target, input) : target, init);
    };`);
  const env = { ...process.env, AI_HARNESS_AGENT_DIR: agent, AI_HARNESS_EXTENSIONS: '',
    ...(responses ? { OPENAI_API_KEY: key, AZURE_OPENAI_API_KEY: key, AZURE_OPENAI_BASE_URL: 'https://continuation.openai.azure.com/openai/v1',
      AZURE_OPENAI_MODEL: model, AZURE_OPENAI_DEPLOYMENT_NAME_MAP: 'gpt-5=owned-deployment,gpt-4o=foreign-deployment' }
      : minimax ? {} : anthropic ? { ANTHROPIC_API_KEY: key } : bedrock ? { AWS_BEARER_TOKEN_BEDROCK: key, AWS_REGION: 'us-east-1', BEDROCK_MODEL: model }
        : { GEMINI_API_KEY: key, GOOGLE_API_KEY: key, GOOGLE_VERTEX_ACCESS_TOKEN: key,
        GOOGLE_CLOUD_PROJECT: 'continuation-project', GOOGLE_CLOUD_LOCATION: 'us-central1' }), NODE_OPTIONS: '--import=' + JSON.stringify(preload) };
  if (credentialSource === 'extension-default') assert(!Object.values(env).some(value => typeof value === 'string' && value.includes(key)), 'Default key must not be registered from the environment');
  const start = (sessionId = 'native-continuation') => {
    processes++;
    const child = spawn('ai-harness', ['--no-approve', '--offline', ...(credentialSource === 'cli' ? ['--api-key', key] : []), '--session-dir', sessions, '--session-id', sessionId,
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
    return { prompt, command, finish, text: value => wait(() => records.filter(record => record.type === 'message_update'
      && record.assistantMessageEvent?.type === 'text_delta').map(record => record.assistantMessageEvent.delta).join('').includes(value)) };
  };
  const readJournal = async (sessionId = 'native-continuation') => {
    const file = path.join(sessions, sessionId + '.jsonl');
    const bytes = await readFile(file, 'utf8'); assert(!bytes.includes(key)); assert.equal((await stat(file)).mode & 0o777, 0o600);
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
    if (!anthropic && !bedrock) {
      await process.command({ type: 'set_model', id: 'foreign-provider', provider: other, modelId: model }); await process.prompt(4);
      assert.deepEqual(assistants(bodies[4]), [1, 2, 3, 4].map(turn => signedContent(turn, true)));
    }
    assert.deepEqual(sourceAssistants(await readJournal()).slice(0, 3), original);
    await process.command({ type: 'set_model', id: 'owner', provider, modelId: model });
    await process.command({ type: 'context_edit', id: 'edit', targetEntryId: original[0].id, replacement: 'edited answer' }); await process.prompt(anthropic || bedrock ? 4 : 5);
    assert.deepEqual(assistants(bodies.at(-1)), [
      anthropic ? [{ type: 'tool_use', id: 'native-call', name: 'continuation_echo', input: { value: 1 } }, { type: 'text', text: 'edited answer' }]
        : bedrock ? [{ toolUse: { toolUseId: 'native-call', name: 'continuation_echo', input: { value: 1 } } }, { text: 'edited answer' }]
          : [{ functionCall: { id: 'native-call', name: 'continuation_echo', args: { value: 1 } }, thoughtSignature: 'dG9vbA==' }, { text: 'edited answer' }],
      signedContent(2), signedContent(3), ...Array.from({ length: anthropic || bedrock ? 1 : 2 }, (_, index) => signedContent(index + 4, true)),
    ]);
    const result = await process.finish(), entries = await readJournal(), history = sourceAssistants(entries);
    assert.deepEqual(history.slice(0, 3), original);
    assert.deepEqual(history.map(entry => entry.blocks), Array.from({ length: anthropic || bedrock ? 5 : 6 }, (_, index) => signedBlocks(index + 1)));
    for (const [index, entry] of history.entries()) { const scope = !anthropic && !bedrock && index === 4 ? other : provider;
      assert.equal(entry.provider, scope); assert.equal(entry.api, api(scope)); assert.equal(entry.model, index === 3 ? foreignModel : model); }
    assert.equal(entries.filter(entry => entry.type === 'context_edit').length, 1); assert.equal(bodies.length, anthropic || bedrock ? 5 : 6);
    assert(!JSON.stringify(result.records).includes(key));
    for (const value of opaque) assert(!JSON.stringify(result.records.filter(record => record.type === 'message_end')).includes(value));
  }
  const scopes = mode === 'rpc' ? anthropic || bedrock ? Array(5).fill(provider) : [provider, provider, provider, provider,
    responses ? provider === 'native-r' ? 'azure' : 'native-r' : provider === 'google' ? 'vertex' : 'google', provider] : Array(3).fill(provider);
  if (responses) {
    assert.deepEqual(wires, scopes.map(scope => ({ path: endpoint(scope), authorization: scope === 'native-r' ? `Bearer ${key}` : undefined, apiKey: scope === 'azure' ? key : undefined })));
    assert.deepEqual(bodies.map(body => body.model), scopes.map((scope, index) => scope === 'azure' ? index === 3 ? 'foreign-deployment' : 'owned-deployment' : index === 3 ? foreignModel : model));
    assert(bodies.every(body => body.stream === true));
    for (const body of bodies.slice(1)) assert.deepEqual(body.input.filter(item => item.type === 'function_call_output'), [{ type: 'function_call_output', call_id: 'native-call', output: 'native-tool-result' }]);
  } else {
    assert.deepEqual(wires, scopes.map((scope, index) => ({ path: endpoint(scope, index === 3 ? foreignModel : model), apiKey: undefined,
      authorization: scope === 'vertex' || scope === 'bedrock' ? `Bearer ${key}` : undefined, googleKey: scope === 'google' ? key : undefined, anthropicKey: ['anthropic', 'minimax', 'minimax-cn'].includes(scope) ? key : undefined })));
    if (anthropic) assert.deepEqual(bodies.map(body => body.model), scopes.map((_, index) => index === 3 ? foreignModel : model));
    for (const body of bodies.slice(1)) assert.deepEqual(anthropic
      ? body.messages.flatMap(item => Array.isArray(item.content) ? item.content : []).filter(item => item.type === 'tool_result')
      : bedrock ? body.messages.flatMap(item => item.content).filter(item => item.toolResult)
        : body.contents.flatMap(item => item.parts).filter(item => item.functionResponse), anthropic
      ? [{ type: 'tool_result', tool_use_id: 'native-call', content: 'native-tool-result', is_error: false, ...(body === bodies[1] ? { cache_control: { type: 'ephemeral' } } : {}) }]
      : bedrock ? [{ toolResult: { toolUseId: 'native-call', content: [{ text: 'native-tool-result' }], status: 'success' } }]
        : [{ functionResponse: { ...(body === bodies[3] ? {} : { id: 'native-call' }), name: 'continuation_echo', response: { output: 'native-tool-result' } } }]);
  }
  if (mode !== 'rpc') {
    const Core = await import('@ai-harness/core'), config = { type: provider, model, apiKey: key,
      ...(provider === 'azure' ? { azureApi: 'native', baseUrl: env.AZURE_OPENAI_BASE_URL } : {}) };
    const owner = minimax ? new Core[provider === 'minimax-cn' ? 'MiniMaxCnProvider' : 'MiniMaxProvider'](config)
      : provider === 'native-r' ? new Core.OpenAiMixedProvider(config) : Core.ProviderFactory.create(config);
    const contextWindow = Core.resolveAgentCompactionContextWindow(provider, model, owner); assert(contextWindow > 10_000);
    const settings = { enabled: true, reserveTokens: contextWindow - 10_000, keepRecentTokens: 512 };
    await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ transport: 'sse', cacheWarming: 'off', compaction: settings }));
    const below = await start().finish(); assert.equal(bodies.length, 4);
    assert.deepEqual(assistants(bodies.at(-1)), responses ? [1, 2, 3].flatMap(replay) : [1, 2, 3].map(value => signedContent(value)));
    assert.deepEqual(below.records.filter(record => ['compaction_start', 'compaction_end'].includes(record.type)), []);
    const manager = new Core.SessionManager({ store: new Core.JsonlSessionStore(sessions) }); assert(await manager.loadFromStore('native-continuation'));
    manager.setCompactionSettings(settings); manager.setCompactionContextWindow(contextWindow, 'native-continuation');
    assert(manager.estimateContextTokens('native-continuation') < contextWindow - settings.reserveTokens);
    const target = Core.getCompactionModelMessages(manager, 'native-continuation').filter(message => message.role === 'user').at(-1);
    assert(await manager.appendContextEdit('native-continuation', { targetEntryId: target.id, replacement: 'PUBLIC_HEADLESS_FILLER ' + 'x'.repeat(60_000) }));
    assert(manager.estimateContextTokens('native-continuation') > contextWindow - settings.reserveTokens);
    const prepared = Core.prepareCompactionContext(manager, 'native-continuation', 'threshold'); assert(prepared);
    assert.deepEqual(prepared.keptMessages.filter(message => message.role === 'assistant').map(message => message.blocks), [blocks(4)]);
    assert(prepared.toCompact.some(message => message.blocks?.some(block => block.type === 'reasoning')));
    const before = await readJournal(); summaryExpected = true;
    const automatic = await start().finish(), summary = 'native-5-leftnative-5-right', body = bodies[4];
    assert.equal(bodies.length, 6); assert.equal(summaryExpected, false);
    assert.equal(body.max_output_tokens ?? body.max_tokens ?? body.generationConfig?.maxOutputTokens ?? body.inferenceConfig?.maxTokens, 4096); assert.deepEqual(body.tools ?? body.toolConfig?.tools ?? [], []);
    const history = JSON.stringify(assistants(body)); assert(history.includes('native-1-left')); assert(!history.includes('visible-'));
    assert(JSON.stringify(body).includes('PUBLIC_HEADLESS_FILLER')); assert(JSON.stringify(body).includes('native-tool-result'));
    for (const value of [...opaque, 'Signature', 'encrypted_content']) assert(!history.includes(value), value);
    assert.deepEqual(assistants(bodies[5]), responses ? replay(4) : [signedContent(4)]);
    assert(JSON.stringify(bodies[5]).includes(summary)); assert(!JSON.stringify(bodies[5]).includes('PUBLIC_HEADLESS_FILLER'));
    const after = await readJournal(), entry = after.find(value => value.type === 'compaction'); assert(entry);
    assert.equal(entry.summary, summary); assert.equal(entry.firstKeptEntryId, prepared.firstKeptEntryId);
    assert.equal(entry.provider, provider); assert.equal(entry.model, model); assert.equal(entry.usage.inputTokens, 5); assert.equal(entry.usage.outputTokens, 2);
    for (const value of [...opaque, 'Signature', 'encrypted_content']) assert(!JSON.stringify(entry).includes(value), value);
    for (const value of before.filter(value => value.type !== 'metadata')) assert.deepEqual(after.find(item => item.id === value.id), value);
    const reloaded = new Core.SessionManager({ store: new Core.JsonlSessionStore(sessions) }), loaded = await reloaded.loadFromStore('native-continuation'); assert(loaded);
    assert.equal(loaded.metadata.compactionEntryId, entry.id); assert.equal(loaded.metadata.compactionSummary, summary);
    assert.deepEqual(Core.getCompactionModelMessages(reloaded, loaded.id).filter(message => message.role === 'assistant').map(message => message.blocks), [blocks(4), blocks(6)]);
    const restarted = await start().finish(); assert.equal(bodies.length, 7);
    assert.deepEqual(assistants(bodies.at(-1)), responses ? [4, 6].flatMap(replay) : [4, 6].map(value => signedContent(value)));
    assert(JSON.stringify(bodies.at(-1)).includes(summary)); assert(!JSON.stringify(bodies.at(-1)).includes('PUBLIC_HEADLESS_FILLER'));
    assert.deepEqual(restarted.records.filter(record => ['compaction_start', 'compaction_end'].includes(record.type)), []);
    for (const [result, turn] of [[below, 4], [automatic, 6], [restarted, 7]]) {
      if (mode === 'print') assert.equal(result.stdout, `native-${turn}-leftnative-${turn}-right\n`);
      else {
        assert.equal(result.records.filter(record => record.type === 'agent_settled').length, 1);
        assert.deepEqual(result.records.filter(record => record.type === 'message_end' && record.message?.role === 'assistant').map(record => record.message.content),
          [[{ type: 'text', text: `native-${turn}-leftnative-${turn}-right` }, { type: 'thinking', thinking: `visible-${turn}` }]]);
      }
      for (const value of opaque) assert(!result.stdout.includes(value), value);
    }
    if (mode === 'json') {
      assert.deepEqual(automatic.records.filter(record => record.type === 'compaction_start'), [{ type: 'compaction_start', reason: 'threshold' }]);
      assert.equal(automatic.records.filter(record => record.type === 'compaction_end' && record.aborted === false && record.result?.summary === summary).length, 1);
    }
    const final = await readJournal(); assert.equal(final.filter(value => value.type === 'compaction').length, 1);
    assert.deepEqual(sourceAssistants(final).map(value => value.blocks), [1, 2, 3, 4, 6, 7].map(blocks));
    for (const value of sourceAssistants(final)) { assert.equal(value.provider, provider); assert.equal(value.api, api(provider)); assert.equal(value.model, model); }
    for (const value of after.filter(value => value.type !== 'metadata')) assert.deepEqual(final.find(item => item.id === value.id), value);
    assert.deepEqual(wires.slice(3), [wires[0], { ...wires[0], path: summaryEndpoint(wires[0].path) }, wires[0], wires[0]]);
  }
  if (mode === 'rpc') {
    const Core = await import('@ai-harness/core'), before = await readJournal(), original = sourceAssistants(before), turn = bodies.length;
    const work = start(); summaryExpected = true;
    const compacted = await work.command({ type: 'compact', id: 'native-compact' });
    const summary = `native-${turn + 1}-leftnative-${turn + 1}-right`, summaryBody = bodies[turn];
    assert.equal(bodies.length, turn + 1); assert.equal(summaryExpected, false);
    assert.equal(compacted.data.summary, summary); assert.equal(summaryBody.max_output_tokens ?? summaryBody.max_tokens ?? summaryBody.generationConfig?.maxOutputTokens ?? summaryBody.inferenceConfig?.maxTokens, 4096);
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
      : bedrock ? firstReplay.messages.flatMap(item => item.content).filter(item => item.toolResult)
        : firstReplay.contents.flatMap(item => item.parts).filter(item => item.functionResponse), []);
    const result = await work.finish();
    assert.deepEqual(result.records.filter(record => record.type === 'compaction_start'), [{ type: 'compaction_start', reason: 'manual' }]);
    assert.equal(result.records.filter(record => record.type === 'compaction_end' && record.aborted === false && record.result?.summary === summary).length, 1);
    for (const value of opaque) assert(!JSON.stringify(result.records).includes(value), value);
    const resumed = start(); await resumed.prompt(1); const resumedResult = await resumed.finish();
    assert.deepEqual(assistants(bodies[turn + 2]), responses ? [turn, turn + 2].flatMap(replay) : [turn, turn + 2].map(value => signedContent(value)));
    for (const value of opaque) assert(!JSON.stringify(resumedResult.records).includes(value), value);
    assert.equal(bodies.length, turn + 3);
    const expectedWire = { path: endpoint(provider), authorization: provider === 'native-r' || provider === 'vertex' || bedrock ? `Bearer ${key}` : undefined,
      apiKey: provider === 'azure' ? key : undefined, ...(!responses ? { googleKey: provider === 'google' ? key : undefined, anthropicKey: anthropic ? key : undefined } : {}) };
    assert.deepEqual(wires.slice(turn), [{ ...expectedWire, path: summaryEndpoint(expectedWire.path) }, expectedWire, expectedWire]);
    const after = await readJournal(); assert.deepEqual(sourceAssistants(after).map(entry => entry.blocks), [...original.map(entry => entry.blocks), blocks(turn + 2), blocks(turn + 3)]);
    const metadata = after.find(entry => entry.type === 'metadata');
    assert.equal(metadata.activeLeafId, sourceAssistants(after).at(-1).id);
    assert.equal(metadata.metadata.compactionSummary, summary); assert.equal(metadata.metadata.compactionEntryId, entry.id);
    for (const entry of before.filter(entry => entry.type !== 'metadata')) assert.deepEqual(after.find(value => value.id === entry.id), entry);
    const forkManager = new Core.SessionManager({ store: new Core.JsonlSessionStore(sessions) });
    const source = await forkManager.loadFromStore('native-continuation'); assert(source);
    const sourceContext = Core.getCompactionModelMessages(forkManager, source.id), sourceBytes = await readFile(journal, 'utf8');
    const fork = await forkManager.forkSession(source.id); assert(fork);
    assert.notEqual(fork.id, source.id); assert.equal(fork.parentId, source.id); assert.equal(fork.branchId, source.branchId ?? source.id);
    assert.equal(await readFile(journal, 'utf8'), sourceBytes);
    const restartedFork = new Core.SessionManager({ store: new Core.JsonlSessionStore(sessions) });
    const loadedFork = await restartedFork.loadFromStore(fork.id); assert(loadedFork);
    assert.equal(loadedFork.parentId, source.id); assert.equal(loadedFork.metadata.compactionSummary, summary);
    assert.deepEqual(Core.getCompactionModelMessages(restartedFork, fork.id), sourceContext);
    const forkEntries = await readJournal(fork.id), forkCompaction = forkEntries.find(value => value.type === 'compaction');
    assert.equal(forkCompaction.id, loadedFork.metadata.compactionEntryId); assert.equal(forkCompaction.summary, summary);
    const child = start(fork.id); await child.prompt(1); const childResult = await child.finish(), forkReplay = bodies.at(-1);
    assert.equal(bodies.length, turn + 4); assert.deepEqual(wires.at(-1), expectedWire);
    assert.equal(forkReplay.model, provider === 'azure' ? 'owned-deployment' : responses || anthropic ? model : undefined);
    assert.deepEqual(assistants(forkReplay), responses ? [turn, turn + 2, turn + 3].flatMap(replay) : [turn, turn + 2, turn + 3].map(value => signedContent(value)));
    assert(JSON.stringify(forkReplay).includes(summary));
    for (const value of opaque) assert(!JSON.stringify(childResult.records).includes(value), value);
    const childEntries = await readJournal(fork.id), childAssistants = sourceAssistants(childEntries);
    assert.deepEqual(childAssistants.map(value => value.blocks), [...sourceAssistants(forkEntries).map(value => value.blocks), blocks(turn + 4)]);
    assert.equal(childAssistants.at(-1).provider, provider); assert.equal(childAssistants.at(-1).api, api(provider)); assert.equal(childAssistants.at(-1).model, model);
    for (const entry of forkEntries.filter(entry => entry.type !== 'metadata')) assert.deepEqual(childEntries.find(value => value.id === entry.id), entry);
    assert.equal(childEntries.find(value => value.type === 'metadata').parentId, source.id);
    assert.equal(await readFile(journal, 'utf8'), sourceBytes);
    const config = { type: provider, model, apiKey: key, ...(provider === 'azure' ? { azureApi: 'native', baseUrl: env.AZURE_OPENAI_BASE_URL } : {}) };
    const owner = minimax ? new Core[provider === 'minimax-cn' ? 'MiniMaxCnProvider' : 'MiniMaxProvider'](config)
      : provider === 'native-r' ? new Core.OpenAiMixedProvider(config) : Core.ProviderFactory.create(config);
    const contextWindow = Core.resolveAgentCompactionContextWindow(provider, model, owner); assert(contextWindow > 10_000);
    const settings = { enabled: true, reserveTokens: contextWindow - 10_000, keepRecentTokens: 512 };
    await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ transport: 'sse', cacheWarming: 'off', compaction: settings }));
    const below = start(fork.id); await below.command({ type: 'set_auto_compaction', id: 'auto-on', enabled: true }); await below.prompt(1);
    const belowResult = await below.finish(); assert.equal(bodies.length, turn + 5);
    assert.deepEqual(assistants(bodies.at(-1)), responses ? [turn, turn + 2, turn + 3, turn + 4].flatMap(replay)
      : [turn, turn + 2, turn + 3, turn + 4].map(value => signedContent(value)));
    assert.deepEqual(belowResult.records.filter(record => ['compaction_start', 'compaction_end'].includes(record.type)), []);
    const autoManager = new Core.SessionManager({ store: new Core.JsonlSessionStore(sessions) });
    assert(await autoManager.loadFromStore(fork.id)); autoManager.setCompactionSettings(settings); autoManager.setCompactionContextWindow(contextWindow, fork.id);
    assert(autoManager.estimateContextTokens(fork.id) < contextWindow - settings.reserveTokens);
    const target = Core.getCompactionModelMessages(autoManager, fork.id).filter(message => message.role === 'user').at(-1);
    assert(await autoManager.appendContextEdit(fork.id, { targetEntryId: target.id, replacement: 'PUBLIC_AUTO_FILLER ' + 'x'.repeat(60_000) }));
    assert(autoManager.estimateContextTokens(fork.id) > contextWindow - settings.reserveTokens);
    const prepared = Core.prepareCompactionContext(autoManager, fork.id, 'threshold'); assert(prepared);
    const autoTurn = bodies.length; assert.deepEqual(prepared.keptMessages.filter(message => message.role === 'assistant').map(message => message.blocks), [blocks(autoTurn)]);
    assert(prepared.toCompact.some(message => message.blocks?.some(block => block.type === 'reasoning')));
    const beforeAuto = await readJournal(fork.id), automatic = start(fork.id); summaryExpected = true; await automatic.prompt(1);
    const autoResult = await automatic.finish(), autoSummary = `native-${autoTurn + 1}-leftnative-${autoTurn + 1}-right`, autoBody = bodies[autoTurn];
    assert.equal(bodies.length, autoTurn + 2); assert.equal(summaryExpected, false);
    assert.equal(autoBody.max_output_tokens ?? autoBody.max_tokens ?? autoBody.generationConfig?.maxOutputTokens ?? autoBody.inferenceConfig?.maxTokens, 4096);
    assert.deepEqual(autoBody.tools ?? autoBody.toolConfig?.tools ?? [], []);
    const autoHistory = JSON.stringify(assistants(autoBody)); assert(autoHistory.includes(`native-${turn}-left`)); assert(!autoHistory.includes('visible-'));
    assert(JSON.stringify(autoBody).includes('PUBLIC_AUTO_FILLER'));
    for (const value of [...opaque, 'Signature', 'encrypted_content']) assert(!autoHistory.includes(value), value);
    assert.deepEqual(assistants(bodies[autoTurn + 1]), responses ? replay(autoTurn) : [signedContent(autoTurn)]);
    assert(JSON.stringify(bodies[autoTurn + 1]).includes(autoSummary)); assert(!JSON.stringify(bodies[autoTurn + 1]).includes('PUBLIC_AUTO_FILLER'));
    assert.deepEqual(autoResult.records.filter(record => record.type === 'compaction_start'), [{ type: 'compaction_start', reason: 'threshold' }]);
    assert.equal(autoResult.records.filter(record => record.type === 'compaction_end' && record.aborted === false && record.result?.summary === autoSummary).length, 1);
    const autoEntries = await readJournal(fork.id), autoEntry = autoEntries.filter(value => value.type === 'compaction').at(-1);
    assert.equal(autoEntries.filter(value => value.type === 'compaction').length, 2);
    assert.equal(autoEntry.summary, autoSummary); assert.equal(autoEntry.firstKeptEntryId, prepared.firstKeptEntryId);
    assert.equal(autoEntry.provider, provider); assert.equal(autoEntry.model, model); assert.equal(autoEntry.usage.inputTokens, 5); assert.equal(autoEntry.usage.outputTokens, 2);
    for (const value of [...opaque, 'Signature', 'encrypted_content']) assert(!JSON.stringify(autoEntry).includes(value), value);
    for (const entry of beforeAuto.filter(entry => entry.type !== 'metadata')) assert.deepEqual(autoEntries.find(value => value.id === entry.id), entry);
    const autoReload = new Core.SessionManager({ store: new Core.JsonlSessionStore(sessions) });
    const autoLoaded = await autoReload.loadFromStore(fork.id); assert(autoLoaded);
    assert.equal(autoLoaded.metadata.compactionEntryId, autoEntry.id); assert.equal(autoLoaded.metadata.compactionSummary, autoSummary);
    assert.deepEqual(Core.getCompactionModelMessages(autoReload, fork.id).filter(message => message.role === 'assistant').map(message => message.blocks), [blocks(autoTurn), blocks(autoTurn + 2)]);
    const autoResumed = start(fork.id); await autoResumed.prompt(1); const autoResumedResult = await autoResumed.finish();
    assert.equal(bodies.length, autoTurn + 3);
    assert.deepEqual(assistants(bodies.at(-1)), responses ? [autoTurn, autoTurn + 2].flatMap(replay) : [autoTurn, autoTurn + 2].map(value => signedContent(value)));
    assert(JSON.stringify(bodies.at(-1)).includes(autoSummary)); assert(!JSON.stringify(bodies.at(-1)).includes('PUBLIC_AUTO_FILLER'));
    assert.deepEqual(autoResumedResult.records.filter(record => ['compaction_start', 'compaction_end'].includes(record.type)), []);
    assert.deepEqual(wires.slice(turn + 4), [expectedWire, { ...expectedWire, path: summaryEndpoint(expectedWire.path) }, expectedWire, expectedWire]);
    for (const result of [belowResult, autoResult, autoResumedResult]) for (const value of opaque) assert(!JSON.stringify(result.records).includes(value), value);
    const finalAuto = await readJournal(fork.id);
    assert.deepEqual(sourceAssistants(finalAuto).map(value => value.blocks), [...sourceAssistants(beforeAuto).map(value => value.blocks), blocks(autoTurn + 2), blocks(autoTurn + 3)]);
    for (const entry of beforeAuto.filter(entry => entry.type !== 'metadata')) assert.deepEqual(finalAuto.find(value => value.id === entry.id), entry);
    assert.equal(finalAuto.filter(value => value.type === 'compaction').length, 2); assert.equal(await readFile(journal, 'utf8'), sourceBytes);
    const recoveryManager = new Core.SessionManager({ store: new Core.JsonlSessionStore(sessions) }); assert(await recoveryManager.loadFromStore(fork.id));
    assert(recoveryManager.estimateContextTokens(fork.id) < contextWindow - settings.reserveTokens);
    const recoveryNotes = entries => entries.filter(value => value.type === 'custom' && value.customType === 'run.context_recovery').map(value => value.data);
    const overflowTurn = bodies.length, recovering = start(fork.id); overflowRemaining = 1; summaryExpected = true;
    await recovering.prompt(1); const recoveredResult = await recovering.finish(), overflowSummary = `native-${overflowTurn + 2}-leftnative-${overflowTurn + 2}-right`;
    assert.equal(overflowRemaining, 0); assert.equal(summaryExpected, false); assert.equal(bodies.length, overflowTurn + 3);
    assert.deepEqual(assistants(bodies[overflowTurn]), responses ? [autoTurn, autoTurn + 2, autoTurn + 3].flatMap(replay)
      : [autoTurn, autoTurn + 2, autoTurn + 3].map(value => signedContent(value)));
    assert.deepEqual(assistants(bodies[overflowTurn + 2]), responses ? replay(overflowTurn) : [signedContent(overflowTurn)]);
    assert(JSON.stringify(bodies[overflowTurn + 2]).includes(overflowSummary));
    const afterRecovery = await readJournal(fork.id), notes = recoveryNotes(afterRecovery).slice(recoveryNotes(finalAuto).length);
    assert.equal(notes.length, 2); assert.deepEqual(notes[0], { reason: 'overflow', exhausted: false });
    const { before: recoveryBefore, after: recoveryAfter, ...recoveryState } = notes[1];
    assert.deepEqual(recoveryState, { reason: 'overflow', applied: true, useful: true }); assert(recoveryAfter < recoveryBefore);
    assert.deepEqual(sourceAssistants(afterRecovery).map(value => value.blocks), [...sourceAssistants(finalAuto).map(value => value.blocks), blocks(overflowTurn + 3)]);
    const recoveryRestart = start(fork.id); await recoveryRestart.prompt(1); const recoveryRestartResult = await recoveryRestart.finish();
    assert.equal(bodies.length, overflowTurn + 4);
    assert.deepEqual(assistants(bodies.at(-1)), responses ? [overflowTurn, overflowTurn + 3].flatMap(replay) : [overflowTurn, overflowTurn + 3].map(value => signedContent(value)));
    assert(JSON.stringify(bodies.at(-1)).includes(overflowSummary));
    const beforeExhaustion = await readJournal(fork.id), exhaustedTurn = bodies.length, exhausted = start(fork.id); overflowRemaining = 2; summaryExpected = true;
    await exhausted.prompt(1); const exhaustedResult = await exhausted.finish(), exhaustedSummary = `native-${exhaustedTurn + 2}-leftnative-${exhaustedTurn + 2}-right`;
    assert.equal(overflowRemaining, 0); assert.equal(summaryExpected, false); assert.equal(bodies.length, exhaustedTurn + 3);
    assert.deepEqual(assistants(bodies[exhaustedTurn]), responses ? [overflowTurn, overflowTurn + 3, overflowTurn + 4].flatMap(replay)
      : [overflowTurn, overflowTurn + 3, overflowTurn + 4].map(value => signedContent(value)));
    assert.deepEqual(assistants(bodies[exhaustedTurn + 2]), responses ? replay(exhaustedTurn) : [signedContent(exhaustedTurn)]);
    const afterExhaustion = await readJournal(fork.id), exhaustedNotes = recoveryNotes(afterExhaustion).slice(recoveryNotes(beforeExhaustion).length);
    assert.equal(exhaustedNotes.length, 3); assert.deepEqual(exhaustedNotes[0], { reason: 'overflow', exhausted: false });
    const { before: exhaustedBefore, after: exhaustedAfter, ...exhaustedState } = exhaustedNotes[1];
    assert.deepEqual(exhaustedState, { reason: 'overflow', applied: true, useful: true }); assert(exhaustedAfter < exhaustedBefore);
    assert.deepEqual(exhaustedNotes[2], { reason: 'overflow', exhausted: true });
    assert.deepEqual(sourceAssistants(afterExhaustion), sourceAssistants(beforeExhaustion));
    assert(exhaustedResult.records.some(record => record.type === 'message_end' && record.message?.stopReason === 'error'));
    const exhaustedReload = new Core.SessionManager({ store: new Core.JsonlSessionStore(sessions) }); assert(await exhaustedReload.loadFromStore(fork.id));
    assert.deepEqual(Core.getCompactionModelMessages(exhaustedReload, fork.id).filter(message => message.role === 'assistant').map(message => message.blocks), [blocks(exhaustedTurn)]);
    const afterFailure = start(fork.id); await afterFailure.prompt(1); const afterFailureResult = await afterFailure.finish(); assert.equal(bodies.length, exhaustedTurn + 4);
    assert.deepEqual(assistants(bodies.at(-1)), responses ? replay(exhaustedTurn) : [signedContent(exhaustedTurn)]); assert(JSON.stringify(bodies.at(-1)).includes(exhaustedSummary));
    for (const [result, summary] of [[recoveredResult, overflowSummary], [exhaustedResult, exhaustedSummary]]) {
      assert.equal(result.records.filter(record => record.type === 'compaction_start').length, 1);
      assert.equal(result.records.filter(record => record.type === 'compaction_end' && record.aborted === false && record.result?.summary === summary).length, 1);
    }
    for (const [offset, summary] of [[overflowTurn, overflowSummary], [exhaustedTurn, exhaustedSummary]]) {
      const body = bodies[offset + 1], history = JSON.stringify(assistants(body));
      assert.equal(body.max_output_tokens ?? body.max_tokens ?? body.generationConfig?.maxOutputTokens ?? body.inferenceConfig?.maxTokens, 4096); assert.deepEqual(body.tools ?? body.toolConfig?.tools ?? [], []);
      assert(history.includes('native-')); assert(!history.includes('visible-')); for (const value of [...opaque, 'Signature', 'encrypted_content', overflowPrivate]) assert(!history.includes(value), value);
      const entry = (await readJournal(fork.id)).find(value => value.type === 'compaction' && value.summary === summary); assert(entry);
      assert.equal(entry.provider, provider); assert.equal(entry.model, model); assert.equal(entry.usage.inputTokens, 5); assert.equal(entry.usage.outputTokens, 2);
      for (const value of [...opaque, 'Signature', 'encrypted_content', overflowPrivate]) assert(!JSON.stringify(entry).includes(value), value);
    }
    for (const result of [recoveredResult, recoveryRestartResult, exhaustedResult, afterFailureResult]) for (const value of [...opaque, overflowPrivate]) assert(!JSON.stringify(result.records).includes(value), value);
    for (const result of [recoveryRestartResult, afterFailureResult]) assert.deepEqual(result.records.filter(record => ['compaction_start', 'compaction_end'].includes(record.type)), []);
    const finalRecovery = await readJournal(fork.id);
    assert.deepEqual(sourceAssistants(finalRecovery).map(value => value.blocks), [...sourceAssistants(finalAuto).map(value => value.blocks), blocks(overflowTurn + 3), blocks(overflowTurn + 4), blocks(exhaustedTurn + 4)]);
    for (const entry of finalAuto.filter(entry => entry.type !== 'metadata')) assert.deepEqual(finalRecovery.find(value => value.id === entry.id), entry);
    assert.equal(finalRecovery.filter(value => value.type === 'compaction').length, 4); assert(!(await readFile(path.join(sessions, fork.id + '.jsonl'), 'utf8')).includes(overflowPrivate));
    assert.deepEqual(wires.slice(overflowTurn), [expectedWire, { ...expectedWire, path: summaryEndpoint(expectedWire.path) }, expectedWire, expectedWire,
      expectedWire, { ...expectedWire, path: summaryEndpoint(expectedWire.path) }, expectedWire, expectedWire]);
    assert.equal(await readFile(journal, 'utf8'), sourceBytes);
    const partialTurn = bodies.length, broken = start(fork.id); partialFailure = true;
    await broken.prompt(1); const brokenResult = await broken.finish(); assert.equal(partialFailure, false); assert.equal(bodies.length, partialTurn + 1);
    const failure = provider === 'native-r' ? 'OpenAI response request failed.' : provider === 'azure' ? 'The provider response failed.'
      : minimax ? 'Invalid MiniMax chat response.' : anthropic ? 'Invalid Anthropic response.' : bedrock ? 'Bedrock streaming error.' : 'Invalid Google response.';
    const partialEntries = await readJournal(fork.id), failed = sourceAssistants(partialEntries).at(-1);
    assert.equal(sourceAssistants(partialEntries).length, sourceAssistants(finalRecovery).length + 1);
    assert.equal(failed.content, `native-${partialTurn + 1}-leftnative-${partialTurn + 1}-right`); assert.equal(failed.metadata.outputError, failure);
    assert.equal(failed.provider, provider); assert.equal(failed.model, model); assert.equal(failed.api, undefined); assert.equal(failed.usage, undefined); assert.deepEqual(failed.toolCalls ?? [], []);
    assert.deepEqual(failed.blocks, [{ type: 'reasoning', text: `visible-${partialTurn + 1}` }, { type: 'text', text: failed.content }]);
    assert.deepEqual(assistants(bodies[partialTurn]), responses ? [exhaustedTurn, exhaustedTurn + 4].flatMap(replay)
      : [exhaustedTurn, exhaustedTurn + 4].map(value => signedContent(value)));
    const ended = brokenResult.records.filter(record => record.type === 'message_end' && record.message?.role === 'assistant'); assert.equal(ended.length, 1);
    assert.equal(ended[0].message.stopReason, 'error'); assert.equal(ended[0].message.errorMessage, failure);
    assert.deepEqual(ended[0].message.content, [{ type: 'text', text: failed.content }, { type: 'thinking', thinking: `visible-${partialTurn + 1}` }]);
    assert.deepEqual(brokenResult.records.filter(record => ['tool_execution_start', 'auto_retry_start', 'compaction_start', 'compaction_end'].includes(record.type)), []);
    const failedReload = new Core.SessionManager({ store: new Core.JsonlSessionStore(sessions) }); assert(await failedReload.loadFromStore(fork.id));
    assert.deepEqual((await failedReload.getRawEntries(fork.id)).find(value => value.id === failed.id), failed);
    const following = start(fork.id); await following.prompt(1); const followingResult = await following.finish(); assert.equal(bodies.length, partialTurn + 2);
    assert.deepEqual(assistants(bodies.at(-1)), responses ? [exhaustedTurn, exhaustedTurn + 4].flatMap(replay)
      : [exhaustedTurn, exhaustedTurn + 4].map(value => signedContent(value)));
    assert(JSON.stringify(bodies.at(-1)).includes(exhaustedSummary)); assert(!JSON.stringify(bodies.at(-1)).includes(`native-${partialTurn + 1}-`));
    const afterPartial = await readJournal(fork.id);
    assert.deepEqual(sourceAssistants(afterPartial).slice(0, -1), sourceAssistants(partialEntries)); assert.deepEqual(sourceAssistants(afterPartial).at(-1).blocks, blocks(partialTurn + 2));
    for (const value of finalRecovery.filter(value => value.type !== 'metadata')) assert.deepEqual(afterPartial.find(item => item.id === value.id), value);
    assert.equal(afterPartial.filter(value => value.type === 'compaction').length, 4); assert.deepEqual(recoveryNotes(afterPartial), recoveryNotes(finalRecovery));
    for (const result of [brokenResult, followingResult]) for (const value of [...opaque, streamPrivate, 'unpublished-call', 'fc_unpublished']) assert(!JSON.stringify(result.records).includes(value), value);
    assert(!(await readFile(path.join(sessions, fork.id + '.jsonl'), 'utf8')).includes(streamPrivate)); assert.deepEqual(wires.slice(partialTurn), [expectedWire, expectedWire]);
    assert.equal(await readFile(effects, 'utf8'), '{"value":1}\n'); assert.equal(await readFile(journal, 'utf8'), sourceBytes);
    const withdrawnTurn = bodies.length, withdrawal = start(fork.id); holdNative = true;
    const withdrawingPrompt = withdrawal.prompt(1); await withdrawal.text(cancelMarker); assert.equal(holdNative, false); assert(heldClosed);
    await withdrawal.command({ type: 'abort', id: 'withdraw-native' }); await withdrawingPrompt; await heldClosed;
    const withdrawnResult = await withdrawal.finish(); assert.equal(bodies.length, withdrawnTurn + 1);
    const withdrawnEntries = await readJournal(fork.id); assert.deepEqual(sourceAssistants(withdrawnEntries), sourceAssistants(afterPartial));
    const aborted = withdrawnResult.records.filter(record => record.type === 'message_end' && record.message?.role === 'assistant'); assert.equal(aborted.length, 1);
    assert.equal(aborted[0].message.stopReason, 'aborted'); assert.deepEqual(aborted[0].message.content, [
      { type: 'text', text: `native-${withdrawnTurn + 1}-leftnative-${withdrawnTurn + 1}-right${cancelMarker}` }, { type: 'thinking', thinking: `visible-${withdrawnTurn + 1}` },
    ]);
    assert.deepEqual(withdrawnResult.records.filter(record => ['tool_execution_start', 'auto_retry_start', 'compaction_start', 'compaction_end'].includes(record.type)), []);
    const withdrawnReload = new Core.SessionManager({ store: new Core.JsonlSessionStore(sessions) }); assert(await withdrawnReload.loadFromStore(fork.id));
    assert.deepEqual((await withdrawnReload.getRawEntries(fork.id)).filter(value => value.type === 'message' && value.role === 'assistant'), sourceAssistants(afterPartial));
    const afterWithdrawal = start(fork.id); await afterWithdrawal.prompt(1); const afterWithdrawalResult = await afterWithdrawal.finish(); assert.equal(bodies.length, withdrawnTurn + 2);
    for (const body of bodies.slice(withdrawnTurn)) assert.deepEqual(assistants(body), responses ? [exhaustedTurn, exhaustedTurn + 4, partialTurn + 2].flatMap(replay)
      : [exhaustedTurn, exhaustedTurn + 4, partialTurn + 2].map(value => signedContent(value)));
    assert(JSON.stringify(bodies.at(-1)).includes(exhaustedSummary)); assert(!JSON.stringify(bodies.at(-1)).includes(cancelMarker));
    assert(!JSON.stringify(bodies.at(-1)).includes(`native-${withdrawnTurn + 1}-`));
    const finalWithdrawal = await readJournal(fork.id);
    assert.deepEqual(sourceAssistants(finalWithdrawal).map(value => value.blocks), [...sourceAssistants(afterPartial).map(value => value.blocks), blocks(withdrawnTurn + 2)]);
    for (const value of afterPartial.filter(value => value.type !== 'metadata')) assert.deepEqual(finalWithdrawal.find(item => item.id === value.id), value);
    assert.equal(finalWithdrawal.filter(value => value.type === 'compaction').length, 4); assert.deepEqual(recoveryNotes(finalWithdrawal), recoveryNotes(afterPartial));
    assert(!JSON.stringify(finalWithdrawal).includes(cancelMarker));
    for (const result of [withdrawnResult, afterWithdrawalResult]) for (const value of [...opaque, 'unpublished-call', 'fc_unpublished', 'msg_cancel_boundary']) assert(!JSON.stringify(result.records).includes(value), value);
    assert.deepEqual(wires.slice(withdrawnTurn), [expectedWire, expectedWire]); assert.equal(await readFile(journal, 'utf8'), sourceBytes);
    const eofTurn = bodies.length, unfinished = start(fork.id); endNative = true;
    await unfinished.prompt(1); const unfinishedResult = await unfinished.finish(); assert.equal(endNative, false); assert.equal(bodies.length, eofTurn + 1);
    const eofFailure = minimax ? 'MiniMax chat request failed.' : provider === 'azure' ? 'The provider response was invalid.' : bedrock ? 'Invalid Bedrock event stream.' : failure;
    const eofThinking = unfinishedResult.records.filter(record => record.type === 'message_update' && record.assistantMessageEvent?.type === 'thinking_delta')
      .map(record => record.assistantMessageEvent.delta).join('');
    assert.equal(eofThinking, new Core.CredentialRedactor([key]).createStream().push(`visible-${eofTurn + 1}`));
    const eofEntries = await readJournal(fork.id), eofAssistant = sourceAssistants(eofEntries).at(-1);
    assert.deepEqual(sourceAssistants(eofEntries).slice(0, -1), sourceAssistants(finalWithdrawal));
    assert.equal(eofAssistant.content, `native-${eofTurn + 1}-leftnative-${eofTurn + 1}-right`); assert.equal(eofAssistant.metadata.outputError, eofFailure);
    assert.equal(eofAssistant.provider, provider); assert.equal(eofAssistant.model, model); assert.equal(eofAssistant.api, undefined); assert.equal(eofAssistant.usage, undefined); assert.deepEqual(eofAssistant.toolCalls ?? [], []);
    assert.deepEqual(eofAssistant.blocks, [{ type: 'reasoning', text: eofThinking }, { type: 'text', text: eofAssistant.content }]);
    const eofEnded = unfinishedResult.records.filter(record => record.type === 'message_end' && record.message?.role === 'assistant'); assert.equal(eofEnded.length, 1);
    assert.equal(eofEnded[0].message.stopReason, 'error'); assert.equal(eofEnded[0].message.errorMessage, eofFailure);
    assert.deepEqual(eofEnded[0].message.content, [{ type: 'text', text: eofAssistant.content }, { type: 'thinking', thinking: eofThinking }]);
    const eofReload = new Core.SessionManager({ store: new Core.JsonlSessionStore(sessions) }); assert(await eofReload.loadFromStore(fork.id));
    assert.deepEqual((await eofReload.getRawEntries(fork.id)).find(value => value.id === eofAssistant.id), eofAssistant);
    const afterEof = start(fork.id); await afterEof.prompt(1); const afterEofResult = await afterEof.finish(); assert.equal(bodies.length, eofTurn + 2);
    for (const body of bodies.slice(eofTurn)) assert.deepEqual(assistants(body), responses ? [exhaustedTurn, exhaustedTurn + 4, partialTurn + 2, withdrawnTurn + 2].flatMap(replay)
      : [exhaustedTurn, exhaustedTurn + 4, partialTurn + 2, withdrawnTurn + 2].map(value => signedContent(value)));
    assert(JSON.stringify(bodies.at(-1)).includes(exhaustedSummary)); assert(!JSON.stringify(bodies.at(-1)).includes(`native-${eofTurn + 1}-`));
    const finalEof = await readJournal(fork.id);
    assert.deepEqual(sourceAssistants(finalEof).slice(0, -1), sourceAssistants(eofEntries)); assert.deepEqual(sourceAssistants(finalEof).at(-1).blocks, blocks(eofTurn + 2));
    for (const value of finalWithdrawal.filter(value => value.type !== 'metadata')) assert.deepEqual(finalEof.find(item => item.id === value.id), value);
    assert.equal(finalEof.filter(value => value.type === 'compaction').length, 4); assert.deepEqual(recoveryNotes(finalEof), recoveryNotes(finalWithdrawal));
    for (const result of [unfinishedResult, afterEofResult]) {
      assert.deepEqual(result.records.filter(record => ['tool_execution_start', 'auto_retry_start', 'compaction_start', 'compaction_end'].includes(record.type)), []);
      for (const value of [...opaque, streamPrivate, 'unpublished-call', 'fc_unpublished']) assert(!JSON.stringify(result.records).includes(value), value);
    }
    assert.deepEqual(wires.slice(eofTurn), [expectedWire, expectedWire]); assert.equal(await readFile(journal, 'utf8'), sourceBytes);
    assert.equal((await stat(path.join(sessions, fork.id + '.jsonl'))).mode & 0o777, 0o600);
    assert(!(await readFile(path.join(sessions, fork.id + '.jsonl'), 'utf8')).includes(key));
    const resetTurn = bodies.length, interrupted = start(fork.id); holdMarker = resetMarker; holdNative = true;
    const interruptedPrompt = interrupted.prompt(1); await interrupted.text(resetMarker); assert.equal(holdNative, false); assert(heldClosed); assert.equal(typeof resetPeer, 'function');
    resetPeer(); await interruptedPrompt; await heldClosed;
    const interruptedResult = await interrupted.finish(); assert.equal(bodies.length, resetTurn + 1);
    const resetFailure = minimax ? 'MiniMax chat request failed.' : provider === 'native-r' ? 'OpenAI response request failed.' : 'terminated';
    const resetThinking = interruptedResult.records.filter(record => record.type === 'message_update' && record.assistantMessageEvent?.type === 'thinking_delta')
      .map(record => record.assistantMessageEvent.delta).join('');
    assert.equal(resetThinking, new Core.CredentialRedactor([key]).createStream().push(`visible-${resetTurn + 1}`));
    const resetEntries = await readJournal(fork.id), resetAssistant = sourceAssistants(resetEntries).at(-1);
    assert.deepEqual(sourceAssistants(resetEntries).slice(0, -1), sourceAssistants(finalEof));
    assert.equal(resetAssistant.content, `native-${resetTurn + 1}-leftnative-${resetTurn + 1}-right${resetMarker}`); assert.equal(resetAssistant.metadata.outputError, resetFailure);
    assert.equal(resetAssistant.provider, provider); assert.equal(resetAssistant.model, model); assert.equal(resetAssistant.api, undefined); assert.equal(resetAssistant.usage, undefined); assert.deepEqual(resetAssistant.toolCalls ?? [], []);
    assert.deepEqual(resetAssistant.blocks, [{ type: 'reasoning', text: resetThinking }, { type: 'text', text: resetAssistant.content }]);
    const resetEnded = interruptedResult.records.filter(record => record.type === 'message_end' && record.message?.role === 'assistant'); assert.equal(resetEnded.length, 1);
    assert.equal(resetEnded[0].message.stopReason, 'error'); assert.equal(resetEnded[0].message.errorMessage, resetFailure);
    assert.deepEqual(resetEnded[0].message.content, [{ type: 'text', text: resetAssistant.content }, { type: 'thinking', thinking: resetThinking }]);
    const resetReload = new Core.SessionManager({ store: new Core.JsonlSessionStore(sessions) }); assert(await resetReload.loadFromStore(fork.id));
    assert.deepEqual((await resetReload.getRawEntries(fork.id)).find(value => value.id === resetAssistant.id), resetAssistant);
    const afterReset = start(fork.id); await afterReset.prompt(1); const afterResetResult = await afterReset.finish(); assert.equal(bodies.length, resetTurn + 2);
    for (const body of bodies.slice(resetTurn)) assert.deepEqual(assistants(body), responses ? [exhaustedTurn, exhaustedTurn + 4, partialTurn + 2, withdrawnTurn + 2, eofTurn + 2].flatMap(replay)
      : [exhaustedTurn, exhaustedTurn + 4, partialTurn + 2, withdrawnTurn + 2, eofTurn + 2].map(value => signedContent(value)));
    assert(JSON.stringify(bodies.at(-1)).includes(exhaustedSummary)); assert(!JSON.stringify(bodies.at(-1)).includes(resetMarker)); assert(!JSON.stringify(bodies.at(-1)).includes(`native-${resetTurn + 1}-`));
    const finalReset = await readJournal(fork.id);
    assert.deepEqual(sourceAssistants(finalReset).slice(0, -1), sourceAssistants(resetEntries)); assert.deepEqual(sourceAssistants(finalReset).at(-1).blocks, blocks(resetTurn + 2));
    for (const value of finalEof.filter(value => value.type !== 'metadata')) assert.deepEqual(finalReset.find(item => item.id === value.id), value);
    assert.equal(finalReset.filter(value => value.type === 'compaction').length, 4); assert.deepEqual(recoveryNotes(finalReset), recoveryNotes(finalEof));
    for (const result of [interruptedResult, afterResetResult]) {
      assert.deepEqual(result.records.filter(record => ['tool_execution_start', 'auto_retry_start', 'compaction_start', 'compaction_end'].includes(record.type)), []);
      for (const value of [...opaque, streamPrivate, 'unpublished-call', 'fc_unpublished', 'msg_cancel_boundary']) assert(!JSON.stringify(result.records).includes(value), value);
    }
    assert.deepEqual(wires.slice(resetTurn), [expectedWire, expectedWire]); assert.equal(await readFile(journal, 'utf8'), sourceBytes);
    assert.equal((await stat(path.join(sessions, fork.id + '.jsonl'))).mode & 0o777, 0o600); assert(!(await readFile(path.join(sessions, fork.id + '.jsonl'), 'utf8')).includes(key));
  }
  assert.equal(await readFile(effects, 'utf8'), '{"value":1}\n'); assert.equal(fixtureError, undefined);
  if (minimax) { assert.equal(bodies.length, mode === 'rpc' ? 29 : 7); assert.equal(processes, mode === 'rpc' ? 19 : 5); }
  console.log(responses ? 'INSTALLED_RESPONSES_CONTINUATION_OK' : 'INSTALLED_SIGNED_CONTINUATION_OK');
} finally {
  if (active && active.exitCode === null && active.signalCode === null) active.kill('SIGKILL');
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true });
}
