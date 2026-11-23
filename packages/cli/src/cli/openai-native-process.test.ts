import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
it.each(['print', 'json', 'rpc'] as const)('uses explicit native OpenAI through %s without migrating legacy C or borrowing subscription credentials', async mode => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-openai-native-cli-'));
  const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
  const key = 'synthetic-openai-native-cli-key', model = 'gpt-6-luna';
  const code = `const model = (await models.getAvailableOfType('classifier')).find(model => model.api === 'openai-decisions');
    const result = await models.classify({model:model.id,input:'reviewed',labels:['safe','review']}); store('label',result.label); return result;`;
  const calls: Array<{ url?: string; auth?: string; body: Record<string, any> }> = [];
  const upgrades: Array<{ url?: string; auth?: string }> = [];
  let fixtureError: unknown;
  const wire = createServer(async (request, response) => {
    try {
      if (request.method === 'GET') {
        expect(request.url).toBe('/native%2Fowner/v1/responses'); expect(request.headers.upgrade).toBe('websocket');
        expect(request.headers.authorization).toBe(`Bearer ${key}`);
        upgrades.push({ url: request.url, auth: request.headers.authorization });
        response.writeHead(426, { connection: 'close' }); response.end('Fixture supports SSE only'); return;
      }
      expect(request.method).toBe('POST');
      let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
      const body = JSON.parse(text); calls.push({ url: request.url, auth: request.headers.authorization, body });
      expect(request.headers['chatgpt-account-id']).toBeUndefined();
      if (request.url === '/native%2Fowner/v1/decisions') {
        expect(body).toMatchObject({ model, input: JSON.stringify({ input: 'reviewed' }), questions: [{ name: 'label', type: 'choice', choices: [{ value: 'safe', description: 'safe' }, { value: 'review', description: 'review' }] }] });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ answers: [{ name: 'label', type: 'choice', choice: 'safe', confidence: 0.8, probabilities: [{ value: 'safe', probability: 0.8 }, { value: 'review', probability: 0.2 }] }], usage: { input_tokens: 10, output_tokens: 2 } })); return;
      }
      expect(request.url).toBe('/native%2Fowner/v1/responses'); expect(body).toMatchObject({ model, stream: true, store: false });
      expect(body).not.toHaveProperty('messages');
      const tool = body.input.find((item: { type: string }) => item.type === 'function_call_output');
      if (tool) expect(tool.output).toContain('"label":"safe"');
      const scripted = mode === 'rpc' && !tool;
      const item = { type: 'function_call', id: 'fc-specialized', call_id: 'specialized', name: 'codemode', arguments: JSON.stringify({ code }), status: 'completed' };
      const events = scripted ? [
        { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
        { type: 'response.function_call_arguments.delta', item_id: item.id, delta: item.arguments },
        { type: 'response.output_item.done', output_index: 0, item },
      ] : [{ type: 'response.output_text.delta', delta: 'native-openai-cli-ok' }];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([...events, { type: 'response.completed', response: { id: scripted ? 'first' : 'final', status: 'completed', model,
        output: scripted ? [item] : [{ type: 'message', id: 'answer', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'native-openai-cli-ok', annotations: [] }] }],
        usage: { input_tokens: 6, output_tokens: 2, total_tokens: 8 } } }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid native OpenAI CLI fixture'); }
  });
  await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  try {
    await mkdir(cwd); await mkdir(agent); await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ cacheWarming: 'off', codemode: {} }));
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, '--approve', '--offline', '--no-extensions', '-e', 'builtin:codemode', '--no-context-files', '--tools', 'codemode',
        '--session-dir', sessions, '--session-id', 'native-openai', '--model', `openai-native/${model}`, '--thinking', 'off',
        ...(mode === 'print' ? ['--print', 'review'] : ['--mode', mode, ...(mode === 'rpc' ? [] : ['review'])])], {
        cwd, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), TMPDIR: root, NO_COLOR: '1', AI_HARNESS_AGENT_DIR: agent,
          OPENAI_NATIVE_API_KEY: key, OPENAI_NATIVE_BASE_URL: `http://127.0.0.1:${(wire.address() as { port: number }).port}/native%2Fowner/v1` }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      child.stdout.setEncoding('utf8').on('data', text => { stdout += text; }); child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
      child.stdin.end(mode === 'rpc' ? JSON.stringify({ type: 'prompt', id: 'review', message: 'review' }) + '\n' : '');
    });
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null }); expect(result.stdout).toContain('native-openai-cli-ok');
    expect(result.stdout + result.stderr).not.toContain(key); expect(fixtureError).toBeUndefined();
    expect(calls).toHaveLength(mode === 'rpc' ? 3 : 1); expect(calls.every(call => call.auth === `Bearer ${key}`)).toBe(true);
    expect(upgrades).toHaveLength(1); // Existing identity-scoped auto fallback suppresses another probe on the RPC continuation.
    if (mode !== 'print') {
      const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
      expect(records.find(record => record.type === 'message_end' && record.message?.role === 'assistant')?.message)
        .toMatchObject({ provider: 'openai-native', model, api: 'openai-responses' });
    }
    const entries = (await readFile(path.join(sessions, 'native-openai.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(entries).toContainEqual(expect.objectContaining({ role: 'assistant', provider: 'openai-native', model, api: 'openai-responses', content: 'native-openai-cli-ok', usage: expect.objectContaining({ totalTokens: 8 }) }));
    if (mode === 'rpc') {
      const tool = entries.find(entry => entry.type === 'message' && entry.role === 'tool');
      expect(tool?.metadata?.codemode).toMatchObject({ store: { label: 'safe' }, costComplete: true, usage: { totalTokens: 12, costUsd: 0.000001 },
        nestedCalls: [{ kind: 'classifier', state: 'completed', usage: { totalTokens: 12, costUsd: 0.000001 } }] });
      expect(calls.map(call => call.url)).toEqual(['/native%2Fowner/v1/responses', '/native%2Fowner/v1/decisions', '/native%2Fowner/v1/responses']);
    }
    expect(JSON.stringify(entries)).not.toContain(key);
  } finally { wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}, 30_000);
