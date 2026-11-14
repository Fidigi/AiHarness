import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
it.each(['print', 'json', 'rpc'] as const)('uses native Radius account discovery through %s and reuses only its owned offline cache', async mode => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-radius-cli-')), cwd = path.join(root, 'work'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
  const key = 'synthetic-radius-cli-key', model = 'account-only';
  const calls: Array<{ method?: string; url?: string; auth?: string; body?: Record<string, any> }> = []; let fixtureError: unknown;
  const wire = createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
      const body = text ? JSON.parse(text) : undefined; calls.push({ method: request.method, url: request.url, auth: request.headers.authorization, body });
      expect(request.headers.authorization).toBe(`Bearer ${key}`);
      if (request.method === 'GET') {
        expect(request.url).toBe('/v1/config'); response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ baseUrl: `http://127.0.0.1:${(wire.address() as { port: number }).port}/p/v1`,
          models: [{ id: model, name: 'Owned Radius', reasoning: true, input: ['text'], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 131072 }] })); return;
      }
      expect(request.url).toBe('/p/v1/messages'); expect(body).toMatchObject({ model, context: { messages: [{ role: 'user' }] } });
      expect(body.messages).toBeUndefined();
      response.setHeader('content-type', 'text/event-stream');
      response.end([{ type: 'start' }, { type: 'text_start', contentIndex: 0 }, { type: 'text_delta', contentIndex: 0, delta: 'native-radius-cli-ok' },
        { type: 'text_end', contentIndex: 0, content: 'native-radius-cli-ok' },
        { type: 'done', reason: 'stop', usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: 0.001 } } },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid Radius CLI fixture'); }
  });
  await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  try {
    await mkdir(cwd); await mkdir(agent); await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ cacheWarming: 'off' }));
    const run = async (offline: boolean) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, '--approve', ...(offline ? ['--offline'] : []), '--no-extensions', '--no-context-files',
        '--session-dir', sessions, '--session-id', offline ? 'cached' : 'fresh', '--thinking', 'off',
        ...(mode === 'rpc' && !offline ? ['--provider', 'radius', '--models', 'radius/*'] : ['--model', `radius/${model}`]),
        ...(mode !== 'json' && !offline ? ['--api-key', key] : []),
        ...(mode === 'print' ? ['--print', 'probe'] : ['--mode', mode, ...(mode === 'rpc' ? [] : ['probe'])])], {
        cwd, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), TMPDIR: root, NO_COLOR: '1', AI_HARNESS_AGENT_DIR: agent,
          ...(mode !== 'json' && !offline ? {} : { RADIUS_API_KEY: key }), RADIUS_GATEWAY: `http://127.0.0.1:${(wire.address() as { port: number }).port}` }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      child.stdout.setEncoding('utf8').on('data', text => { stdout += text; }); child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      child.stdin.end(mode === 'rpc' ? JSON.stringify({ type: 'prompt', id: 'probe', message: 'probe' }) + '\n' : '');
    });
    for (const offline of [false, true]) {
      const result = await run(offline); expect(result, result.stderr).toMatchObject({ code: 0 }); expect(result.stdout).toContain('native-radius-cli-ok');
      expect(result.stdout + result.stderr).not.toContain(key);
      const entries = (await readFile(path.join(sessions, `${offline ? 'cached' : 'fresh'}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(entries).toContainEqual(expect.objectContaining({ role: 'assistant', provider: 'radius', model, api: 'pi-messages', content: 'native-radius-cli-ok', usage: expect.objectContaining({ totalTokens: 10, costUsd: 0.001 }) }));
      expect(JSON.stringify(entries)).not.toContain(key);
    }
    expect(calls.map(call => call.method)).toEqual(['GET', 'POST', 'POST']); expect(fixtureError).toBeUndefined();
    const cache = path.join(agent, 'radius-models'); expect(await readdir(cache)).toHaveLength(1);
    expect(await readFile(path.join(cache, (await readdir(cache))[0]!), 'utf8')).not.toContain(key);
  } finally { wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}, 30_000);
