import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bedrockFrame as frame, bedrockText } from '../../../../tests/fixtures/bedrock-event-stream.js';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const core = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));

describe('emitted CLI native Bedrock stream', () => {
  it.each([['json', 'sigv4'], ['rpc', 'sigv4'], ['json', 'bearer'], ['rpc', 'bearer']] as const)('%s/%s uses explicit SDK registration, binary wire output and durable native accounting', async (mode, auth) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-bedrock-cli-'));
    const cwd = path.join(root, 'project'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
    const calls: Array<{ url?: string; authorization?: string; authHeaders: string[]; body: Record<string, unknown> }> = [];
    let fixtureError: unknown;
    const upstream = createServer(async (request, response) => {
      try {
        let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
        calls.push({ url: request.url, authorization: request.headers.authorization, authHeaders: Object.keys(request.headers).filter(name => name.startsWith('x-amz-')), body: JSON.parse(text) });
        response.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
        if (calls.length === 1) response.end(Buffer.concat([
          frame('messageStart', { role: 'assistant' }),
          frame('contentBlockStart', { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'read-file', name: 'read' } } }),
          frame('contentBlockDelta', { contentBlockIndex: 0, delta: { toolUse: { input: '{"path":"fixture.txt"}' } } }),
          frame('contentBlockStop', { contentBlockIndex: 0 }), frame('messageStop', { stopReason: 'tool_use' }),
          frame('metadata', { usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } }),
        ]));
        else {
          expect(JSON.stringify(calls[1].body.messages)).toContain('tool-roundtrip-ok');
          response.end(bedrockText('native-bedrock-cli-ok', 'end_turn', { inputTokens: 7, outputTokens: 2, cacheReadInputTokens: 3, totalTokens: 12 }));
        }
      } catch (error) { fixtureError = error; response.writeHead(500); response.end('Invalid Bedrock fixture'); }
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    try {
      await mkdir(cwd); await writeFile(path.join(cwd, 'fixture.txt'), 'tool-roundtrip-ok');
      await mkdir(path.join(agent, 'extensions'), { recursive: true });
      await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ cacheWarming: 'off' }));
      await writeFile(path.join(agent, 'extensions/bedrock.mjs'), `import { BedrockProvider } from ${JSON.stringify(core)};
        export default api => api.registerProvider('operator-bedrock', { defaultConfig: { model: 'fixture:0' },
          create(config) { return new BedrockProvider({ ...config, accessKeyId: 'DISPOSABLECLI', secretAccessKey: 'disposableclisecret',
            baseUrl: 'http://127.0.0.1:${(upstream.address() as { port: number }).port}/proxy' }); } });`);
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, '--approve', '--offline', ...(auth === 'bearer' ? ['--api-key', 'disposable:cli:bearer'] : []), '--session-dir', sessions,
          '--model', 'operator-bedrock/fixture:0', '--tools', 'read', '--mode', mode, ...(mode === 'rpc' ? [] : ['hello'])], {
          cwd, env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), TMPDIR: root, NO_COLOR: '1', AI_HARNESS_AGENT_DIR: agent }, stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        child.stdout.setEncoding('utf8').on('data', text => { stdout += text; }); child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
        child.stdin.end(mode === 'rpc' ? [{ type: 'get_state', id: 'state' }, { type: 'prompt', id: 'prompt', message: 'hello' }].map(command => JSON.stringify(command)).join('\n') + '\n' : '');
      });
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
      const assistant = records.find(record => record.type === 'message_end' && JSON.stringify(record.message?.content).includes('native-bedrock-cli-ok'));
      expect(assistant?.message).toMatchObject({ content: [{ type: 'text', text: 'native-bedrock-cli-ok' }], api: 'bedrock-converse-stream' });
      if (mode === 'rpc') expect(records.find(record => record.id === 'state')?.data.model.api).toBe('bedrock-converse-stream');
      expect(fixtureError).toBeUndefined(); expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ url: '/proxy/model/fixture%3A0/converse-stream', authorization: auth === 'sigv4' ? expect.stringContaining('Credential=DISPOSABLECLI/') : 'Bearer disposable:cli:bearer', body: { messages: expect.any(Array) } });
      if (auth === 'bearer') for (const call of calls) { expect(call.authorization).toBe('Bearer disposable:cli:bearer'); expect(call.authHeaders).toEqual([]); }
      const entries = (await Promise.all((await readdir(sessions)).filter(name => name.endsWith('.jsonl')).map(name => readFile(path.join(sessions, name), 'utf8'))))
        .flatMap(text => text.trim().split('\n').map(line => JSON.parse(line)));
      expect(entries).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', api: 'bedrock-converse-stream',
        usage: expect.objectContaining({ inputTokens: 7, cacheReadTokens: 3, outputTokens: 2, totalTokens: 12 }) }));
      expect(JSON.stringify(entries) + result.stdout + result.stderr).not.toContain('disposableclisecret');
      expect(JSON.stringify(entries) + result.stdout + result.stderr).not.toContain('disposable:cli:bearer');
    } finally {
      upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
