import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
it.each(['print', 'rpc'] as const)('uses native auxiliary TypeSafe through %s codemode without changing conversation identity', async mode => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-typesafe-cli-'));
  const cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
  const chatKey = 'synthetic-deepseek-chat-key', classifierKey = 'synthetic-typesafe-classifier-key';
  const code = `const model = (await models.getAvailableOfType('classifier')).find(model => model.id === 'typesafe::jev-latest');
    const result = await models.classify({model:model.id,input:'reviewed',labels:['safe','review']});
    store('label',result.label); return result;`;
  const calls: Array<{ url?: string; auth?: string; body: Record<string, any> }> = [];
  let fixtureError: unknown;
  const wire = createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
      const body = JSON.parse(text); calls.push({ url: request.url, auth: request.headers.authorization, body });
      if (request.url === '/typesafe%2Fowner/v1/systemone') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ answers: { label: { type: 'choice', choice: 'safe', confidence: 0.8, probabilities: { safe: 0.8, review: 0.2 } } }, usage: { input_tokens: 10, output_tokens: 2 } }));
        return;
      }
      expect(request.url).toBe('/chat%2Fowner/v1/chat/completions');
      const tool = body.messages.find((message: { role: string }) => message.role === 'tool');
      if (tool) expect(tool.content).toContain('"label":"safe"');
      const delta = tool ? { content: 'native-typesafe-cli-ok' } : { tool_calls: [{ index: 0, id: 'specialized', type: 'function', function: { name: 'codemode', arguments: JSON.stringify({ code }) } }] };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([{ choices: [{ delta }] }, { choices: [{ delta: {}, finish_reason: tool ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 6, completion_tokens: 2 } }]
        .map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid auxiliary CLI fixture'); }
  });
  await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  try {
    await mkdir(cwd); await mkdir(agent); await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ cacheWarming: 'off', codemode: {} }));
    const base = `http://127.0.0.1:${(wire.address() as { port: number }).port}`;
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, '--approve', '--offline', '--no-extensions', '-e', 'builtin:codemode', '--no-context-files', '--tools', 'codemode',
        '--session-dir', sessions, '--session-id', 'typesafe', '--model', 'deepseek/deepseek-flash', ...(mode === 'print' ? ['--print', 'review'] : ['--mode', 'rpc'])], {
        cwd, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), TMPDIR: root, NO_COLOR: '1', AI_HARNESS_AGENT_DIR: agent,
          DEEPSEEK_API_KEY: chatKey, DEEPSEEK_BASE_URL: `${base}/chat%2Fowner/v1`, TYPESAFE_API_KEY: classifierKey, TYPESAFE_BASE_URL: `${base}/typesafe%2Fowner/v1` }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      child.stdout.setEncoding('utf8').on('data', text => { stdout += text; }); child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
      child.stdin.end(mode === 'rpc' ? JSON.stringify({ type: 'prompt', id: 'review', message: 'review' }) + '\n' : '');
    });
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null }); expect(result.stdout).toContain('native-typesafe-cli-ok');
    for (const secret of [chatKey, classifierKey]) expect(result.stdout + result.stderr).not.toContain(secret);
    expect(fixtureError).toBeUndefined(); expect(calls).toHaveLength(3);
    expect(calls.map(call => call.auth)).toEqual([`Bearer ${chatKey}`, `Bearer ${classifierKey}`, `Bearer ${chatKey}`]);
    expect(calls[1]).toMatchObject({ url: '/typesafe%2Fowner/v1/systemone', body: { model: 'jev-latest', state: { input: 'reviewed' }, questions: { label: { type: 'choice', criteria: { safe: 'safe', review: 'review' } } } } });
    expect(calls[2].body.model).toBe('deepseek-flash');
    const entries = (await readFile(path.join(sessions, 'typesafe.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const tool = entries.find(entry => entry.type === 'message' && entry.role === 'tool');
    expect(tool?.metadata?.codemode).toMatchObject({ store: { label: 'safe' }, costComplete: true, usage: { totalTokens: 12, costUsd: 0 },
      nestedCalls: [{ kind: 'classifier', state: 'completed', usage: { totalTokens: 12, costUsd: 0 } }] });
    expect(entries.filter(entry => entry.role === 'assistant').every(entry => entry.provider === 'deepseek' && entry.model === 'deepseek-flash')).toBe(true);
    for (const secret of [chatKey, classifierKey]) expect(JSON.stringify(entries)).not.toContain(secret);
  } finally { wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}, 30_000);
