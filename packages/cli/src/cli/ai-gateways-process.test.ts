import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const cases = [
  { provider: 'cloudflare-ai-gateway', model: 'claude-fable-5', api: 'a', mode: 'print' },
  { provider: 'cloudflare-ai-gateway', model: 'workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731', api: 'c', mode: 'json' },
  { provider: 'cloudflare-ai-gateway', model: 'gpt-4.1', api: 'r', mode: 'rpc' },
  { provider: 'vercel-ai-gateway', model: 'alibaba/qwen-3-14b', api: 'a', mode: 'print' },
] as const;
it.each(cases)('executes native $provider $api through $mode without compatible auth or auxiliary service borrowing', async scenario => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-gateways-cli-')), cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
  const key = 'synthetic-gateway-cli', serviceKey = 'synthetic-gateway-cli-systemone';
  const code = `const model=(await models.getAvailableOfType('classifier')).find(model=>model.id==='vercel-ai-gateway::typesafe-ai/jev');
    if(!model) throw new Error('Gateway classifier missing'); const result=await models.classify({model:model.id,input:'reviewed',labels:['safe','review']}); store('label',result.label); return result;`;
  const calls: Array<{ url?: string; key?: string; body: Record<string, any> }> = []; let fixtureError: unknown;
  const wire = createServer(async (request, response) => {
    try {
      expect(request.method).toBe('POST'); let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
      const body = JSON.parse(text);
      if (request.url === '/service/typesafe/v1/systemone') {
        expect(request.headers.authorization).toBe(`Bearer ${serviceKey}`); expect(body).toMatchObject({ model: 'typesafe-ai/jev', state: { input: 'reviewed' } });
        calls.push({ url: request.url, key: serviceKey, body }); response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ answers: { label: { type: 'choice', choice: 'safe', confidence: 0.8, probabilities: { safe: 0.8, review: 0.2 } } }, usage: { input_tokens: 10, output_tokens: 2 } })); return;
      }
      const header = scenario.provider === 'cloudflare-ai-gateway' ? request.headers['cf-aig-authorization'] : request.headers['x-api-key'];
      expect(header).toBe(scenario.provider === 'cloudflare-ai-gateway' ? `Bearer ${key}` : key); expect(request.headers.authorization).toBeUndefined();
      if (scenario.provider === 'cloudflare-ai-gateway') expect(request.headers['x-api-key']).toBeUndefined();
      calls.push({ url: request.url, key, body }); expect(body.model).toBe(scenario.model);
      let events: unknown[];
      if (scenario.api === 'a') {
        expect(request.url).toBe(scenario.provider === 'cloudflare-ai-gateway' ? '/gateway/anthropic/v1/messages' : '/gateway/v1/messages');
        events = [{ type: 'message_start', message: { id: 'answer', model: body.model, usage: { input_tokens: 6, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'native-gateway-cli-ok' } }, { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }];
      } else if (scenario.api === 'c') {
        expect(request.url).toBe('/gateway/compat/chat/completions'); expect(body).toMatchObject({ thinking: { type: 'disabled' } }); expect(body.store).toBeUndefined();
        events = [{ model: body.model, choices: [{ delta: { content: 'native-gateway-cli-ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 6, completion_tokens: 2 } }];
      } else {
        expect(request.url).toBe('/gateway/openai/responses'); const tool = body.input.find((item: { type: string }) => item.type === 'function_call_output');
        if (tool) expect(tool.output).toContain('"label":"safe"');
        const item = { type: 'function_call', id: 'fc_gateway', call_id: 'gateway-script', name: 'codemode', arguments: JSON.stringify({ code }), status: 'completed' };
        events = [...(tool ? [{ type: 'response.output_text.delta', delta: 'native-gateway-cli-ok' }] : [
          { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
          { type: 'response.function_call_arguments.delta', item_id: item.id, delta: item.arguments }, { type: 'response.output_item.done', output_index: 0, item },
        ]), { type: 'response.completed', response: { id: 'r', status: 'completed', model: body.model,
          output: tool ? [{ type: 'message', id: 'msg_gateway', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'native-gateway-cli-ok', annotations: [] }] }] : [item],
          usage: { input_tokens: 6, output_tokens: 2, total_tokens: 8 } } }];
      }
      response.setHeader('content-type', 'text/event-stream'); response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (scenario.api === 'c' ? 'data: [DONE]\n\n' : ''));
    } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid native gateway CLI fixture'); }
  });
  await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  try {
    await mkdir(cwd); await mkdir(agent); await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ cacheWarming: 'off', codemode: {}, transport: 'sse' }));
    const base = `http://127.0.0.1:${(wire.address() as { port: number }).port}`;
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
      const cold = scenario.mode !== 'json';
      const child = spawn(process.execPath, [cli, '--approve', '--offline', '--no-extensions', '-e', 'builtin:codemode', '--no-context-files', '--tools', 'codemode',
        '--session-dir', sessions, '--session-id', 'gateway', '--thinking', 'off',
        ...(scenario.mode === 'rpc' ? ['--provider', scenario.provider, '--models', `${scenario.provider}/${scenario.model}`] : ['--model', `${scenario.provider}/${scenario.model}`]),
        ...(cold ? ['--api-key', key] : []), ...(scenario.mode === 'print' ? ['--print', 'probe'] : ['--mode', scenario.mode, ...(scenario.mode === 'rpc' ? [] : ['probe'])])], {
        cwd, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), TMPDIR: root, NO_COLOR: '1', AI_HARNESS_AGENT_DIR: agent,
          ...(scenario.provider === 'cloudflare-ai-gateway' ? { CLOUDFLARE_AI_GATEWAY_BASE_URL: `${base}/gateway`, CLOUDFLARE_ACCOUNT_ID: 'synthetic-account', CLOUDFLARE_GATEWAY_ID: 'synthetic-gateway',
            ...(cold ? {} : { CLOUDFLARE_API_KEY: key }), ...(scenario.mode === 'rpc' ? { AI_GATEWAY_API_KEY: serviceKey, VERCEL_AI_GATEWAY_BASE_URL: `${base}/service` } : {}) }
            : { VERCEL_AI_GATEWAY_BASE_URL: `${base}/gateway` }) }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      child.stdout.setEncoding('utf8').on('data', text => { stdout += text; }); child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
      child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
      child.stdin.end(scenario.mode === 'rpc' ? JSON.stringify({ type: 'prompt', id: 'probe', message: 'probe' }) + '\n' : '');
    });
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null }); expect(result.stdout).toContain('native-gateway-cli-ok'); expect(fixtureError).toBeUndefined();
    expect(calls).toHaveLength(scenario.mode === 'rpc' ? 3 : 1);
    const entries = (await readFile(path.join(sessions, 'gateway.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const api = scenario.api === 'a' ? 'anthropic-messages' : scenario.api === 'c' ? 'openai-completions' : 'openai-responses';
    expect(entries).toContainEqual(expect.objectContaining({ role: 'assistant', provider: scenario.provider, model: scenario.model, api, content: 'native-gateway-cli-ok', usage: expect.objectContaining({ totalTokens: 8 }) }));
    if (scenario.mode === 'rpc') {
      const tool = entries.find(entry => entry.role === 'tool'); expect(tool?.metadata?.codemode).toMatchObject({ store: { label: 'safe' }, costComplete: true,
        usage: { totalTokens: 12, costUsd: expect.closeTo(0.00000042, 12) }, nestedCalls: [{ kind: 'classifier', state: 'completed', usage: { totalTokens: 12 } }] });
      expect(calls.map(call => call.url)).toEqual(['/gateway/openai/responses', '/service/typesafe/v1/systemone', '/gateway/openai/responses']);
    }
    for (const secret of [key, serviceKey]) { expect(result.stdout + result.stderr).not.toContain(secret); expect(JSON.stringify(entries)).not.toContain(secret); }
  } finally { wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}, 30_000);
