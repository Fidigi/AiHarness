import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

describe('emitted CLI Azure Responses', () => {
  it.each(['print', 'json', 'rpc'] as const)('%s uses Azure auth/deployment and persists authentic usage', async mode => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-azure-cli-'));
    const cwd = path.join(root, 'project'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
    const calls: Array<{ url: string | undefined; authorization?: string; apiKey?: string | string[]; body: Record<string, unknown> }> = [];
    let fixtureError: unknown;
    const upstream = createServer(async (request, response) => {
      try {
        let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
        calls.push({ url: request.url, authorization: request.headers.authorization, apiKey: request.headers['api-key'], body: JSON.parse(text) });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of [
          { type: 'response.output_text.delta', delta: 'native-azure-ok' },
          { type: 'response.completed', response: { id: 'azure-cli-response', model: 'physical-deployment',
            usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 3 }, output_tokens: 2, total_tokens: 12 } } },
        ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end();
      } catch (error) { fixtureError = error; response.writeHead(500); response.end('Invalid Azure fixture'); }
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    try {
      await mkdir(cwd); await mkdir(agent); await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ cacheWarming: 'off' }));
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, '--approve', '--offline', '--no-extensions', '--session-dir', sessions,
          '--model', 'azure/logical-model', ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(mode === 'rpc' ? [] : ['hello'])], {
          cwd, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), TMPDIR: root, NO_COLOR: '1', AI_HARNESS_AGENT_DIR: agent,
            AZURE_OPENAI_API_KEY: 'disposable-cli-azure-key', AZURE_OPENAI_BASE_URL: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
            AZURE_OPENAI_MODEL: 'logical-model', AZURE_OPENAI_DEPLOYMENT_NAME_MAP: 'logical-model=physical-deployment' },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
        child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
        child.stdin.end(mode === 'rpc' ? JSON.stringify({ type: 'prompt', id: 'azure-prompt', message: 'hello' }) + '\n' : '');
      });
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      expect(result.stdout).toContain('native-azure-ok'); expect(result.stdout + result.stderr).not.toContain('disposable-cli-azure-key');
      if (mode !== 'print') for (const line of result.stdout.trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow();
      expect(fixtureError).toBeUndefined();
      expect(calls).toEqual([expect.objectContaining({ url: '/openai/v1/responses?api-version=v1', authorization: undefined,
        apiKey: 'disposable-cli-azure-key', body: expect.objectContaining({ model: 'physical-deployment', stream: true, store: false }) })]);
      const entries = (await Promise.all((await readdir(sessions)).filter(name => name.endsWith('.jsonl')).map(name => readFile(path.join(sessions, name), 'utf8'))))
        .flatMap(text => text.trim().split('\n').map(line => JSON.parse(line)));
      expect(entries).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', provider: 'azure', model: 'physical-deployment',
        usage: expect.objectContaining({ inputTokens: 7, cacheReadTokens: 3, outputTokens: 2, totalTokens: 12 }) }));
      expect(JSON.stringify(entries)).not.toContain('disposable-cli-azure-key');
    } finally {
      upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
