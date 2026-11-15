import { spawn } from 'node:child_process';
import { createServer } from 'node:https';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createLocalTLSFixture } from './fixtures/oauth-local-tls.mjs';
import { bedrockText } from '../../../../tests/fixtures/bedrock-event-stream.js';
const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
it('parses an actual JSON CLI inference-profile ARN without losing its resource path or signing region', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-bedrock-arn-cli-')), cwd = path.join(root, 'work'), home = path.join(root, 'home'), agent = path.join(root, 'agent');
  await Promise.all([mkdir(cwd), mkdir(home), mkdir(agent)]);
  const model = 'arn:aws:bedrock:ap-southeast-2:123456789012:inference-profile/us.anthropic.claude-opus-4-6-v1:0';
  const calls: Array<{ url: string | undefined; authorization: string | undefined; body: string }> = [];
  const wire = createServer(await createLocalTLSFixture(root), async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    calls.push({ url: request.url, authorization: request.headers.authorization, body });
    response.setHeader('content-type', 'application/vnd.amazon.eventstream'); response.end(bedrockText('arn-cli-ready', 'end_turn', { inputTokens: 8, outputTokens: 2, totalTokens: 10 }));
  });
  await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `https://127.0.0.1:${(wire.address() as { port: number }).port}/prefix`;
    const result = await new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--no-maglev', cli, '--approve', '--no-extensions', '--no-context-files', '--no-session', '--model', 'bedrock/' + model, '--thinking', 'off', '--mode', 'json', 'synthetic ARN probe'], {
        cwd, env: { PATH: process.env.PATH, HOME: home, TMPDIR: root, NO_COLOR: '1', AI_HARNESS_AGENT_DIR: agent, AWS_ACCESS_KEY_ID: 'SYNTHETICCLIARNKEY', AWS_SECRET_ACCESS_KEY: 'SyntheticCliArnSecret', AWS_REGION: 'us-west-2', BEDROCK_BASE_URL: endpoint, BEDROCK_MODEL: model, NODE_EXTRA_CA_CERTS: path.join(root, 'cert.pem') }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Synthetic ARN CLI deadline')); }, 20000);
      child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    });
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null }); expect(result.stdout).toContain('arn-cli-ready');
    expect(result.stdout.trim().split('\n').map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ type: 'message_end', message: expect.objectContaining({ role: 'assistant', model, content: [{ type: 'text', text: 'arn-cli-ready' }] }) }));
    expect(calls).toHaveLength(1); expect(calls[0].url).toBe('/prefix/model/' + encodeURIComponent(model) + '/converse-stream');
    expect(calls[0].authorization).toContain('Credential=SYNTHETICCLIARNKEY/'); expect(calls[0].authorization).toContain('/ap-southeast-2/bedrock/aws4_request');
    expect(JSON.parse(calls[0].body).messages[0].content).toContainEqual({ text: 'synthetic ARN probe' });
    for (const secret of ['SYNTHETICCLIARNKEY', 'SyntheticCliArnSecret']) expect(result.stdout + result.stderr).not.toContain(secret);
  } finally { wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}, 30000);
