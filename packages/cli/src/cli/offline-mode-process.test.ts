import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { spawn as spawnPty } from 'node-pty';
import { EncryptedCredentialStore, ProviderCredentialService } from '@ai-harness/core';
import { describe, expect, it, vi } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
type Mode = 'print' | 'json' | 'rpc';
async function fixture(credentials = true, mutateEnvironment?: '0' | '1', extensionNetwork = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-offline-process-')), cwd = path.join(root, 'work'), agent = path.join(root, 'agent');
  await mkdir(cwd); await mkdir(agent);
  const requests: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = text && request.url !== '/oauth/token' ? JSON.parse(text) : {};
    requests.push({ method: request.method ?? '', url: request.url ?? '', body });
    if (request.url === '/oauth/token') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ access_token: 'fresh-offline-fixture', expires_in: 3600 })); }
    else if (request.url?.endsWith('/models')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: request.url === '/openai/models' ? 'gpt-fixture' : 'local-model' }, { id: 'live-only' }] })); }
    else if (request.url === '/v1/chat/completions') { response.setHeader('Content-Type', 'text/event-stream'); response.end(`data: ${JSON.stringify({ id: 'fixture', choices: [{ delta: { role: 'assistant', content: 'LOCAL EXPLICIT RESPONSE' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'fixture', choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`); }
    else { response.end('explicit extension network allowed'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected a loopback address');
  const base = `http://127.0.0.1:${address.port}`, commandMarker = path.join(root, 'command'), extensionMarker = path.join(root, 'extension');
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(commandMarker)},'executed');process.stdout.write('command-offline-fixture')`)}`;
  await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ quietStartup: true, enabledModels: ['mock/*'], ...(credentials ? { providerApiKeyCommands: { local: command } } : {}) }));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, TMPDIR: root, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent, AI_HARNESS_OFFLINE: '', AI_HARNESS_EXTENSIONS: '', AI_HARNESS_THEME: '', AI_HARNESS_MASTER_KEY: '', LOCAL_BASE_URL: base + '/v1', LOCAL_MODEL: 'local-model', LOCAL_API_KEY: '', LLAMA_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GOOGLE_API_KEY: '', GEMINI_API_KEY: '', AZURE_OPENAI_API_KEY: '', GOOGLE_VERTEX_ACCESS_TOKEN: '', AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', NO_COLOR: '1', TERM: 'xterm-256color' };
  let before: Buffer | undefined;
  if (credentials) {
    env.AI_HARNESS_MASTER_KEY = 'a sufficiently long offline fixture key';
    const service = new ProviderCredentialService({ store: new EncryptedCredentialStore(path.join(agent, 'credentials.enc'), env.AI_HARNESS_MASTER_KEY) }); await service.load();
    await service.setOAuth('openai', { accessToken: 'expired-offline-fixture', refreshToken: 'refresh-offline-fixture', expiresAt: 1 });
    before = await readFile(path.join(agent, 'credentials.enc'));
  }
  const preload = path.join(root, 'redirect.mjs'), fetchMarker = path.join(root, 'fetch-attempts');
  await writeFile(preload, `import{appendFileSync}from'node:fs';const original=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=input instanceof Request?input.url:String(input);appendFileSync(${JSON.stringify(fetchMarker)},JSON.stringify(url)+'\\n');const target=url==='https://oauth.example.test/token'?${JSON.stringify(base + '/oauth/token')}:url==='https://api.openai.com/v1/models'?${JSON.stringify(base + '/openai/models')}:url;if(!target.startsWith(${JSON.stringify(base + '/')}))throw Error('Unapproved offline fixture network request');return original(target,init);};`);
  const extension = path.join(root, 'probe.mjs');
  await writeFile(extension, `import{writeFileSync}from'node:fs';export default async api=>{api.registerOption('offline-custom',{type:'boolean',description:'Authoritative arity probe'});${mutateEnvironment ? `process.env.AI_HARNESS_OFFLINE=${JSON.stringify(mutateEnvironment)};` : ''}${extensionNetwork ? `await fetch(${JSON.stringify(base + '/explicit-extension')});api.registerTool({name:'offline_probe',description:'Kept explicit tool',parameters:{type:'object'},execute:()=>({content:'kept'})});` : ''}writeFileSync(${JSON.stringify(extensionMarker)},'loaded');};`);
  Object.assign(env, { AI_HARNESS_OAUTH_OPENAI_TOKEN_URL: 'https://oauth.example.test/token', AI_HARNESS_OAUTH_OPENAI_CLIENT_ID: 'fixture-client', AI_HARNESS_OPENAI_API_KEY_COMMAND: '', AI_HARNESS_LOCAL_API_KEY_COMMAND: '' });
  const args = ['--import', preload, cli, '--no-approve', '--no-extensions', '--no-session', ...((mutateEnvironment || extensionNetwork) ? ['-e', extension] : [])];
  const close = async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(root, { recursive: true, force: true }); };
  const passive = async () => { expect(requests).toEqual([]); await expect(readFile(fetchMarker)).rejects.toMatchObject({ code: 'ENOENT' }); await expect(readFile(commandMarker)).rejects.toMatchObject({ code: 'ENOENT' }); if (before) expect(await readFile(path.join(agent, 'credentials.enc'))).toEqual(before); };
  return { root, cwd, agent, env, args, requests, commandMarker, extensionMarker, before, passive, close };
}
async function run(test: Awaited<ReturnType<typeof fixture>>, mode: Mode, flags: string[], model = 'mock', tail?: string[]) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [...test.args, ...flags, ...(model === 'local' ? ['--model', 'local/local-model'] : []), ...(mode === 'print' ? ['--print'] : ['--mode', mode]), ...(tail ?? (mode === 'rpc' ? [] : ['Hello.']))], { cwd: test.cwd, env: test.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; }); child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    child.stdin.end(mode === 'rpc' ? [JSON.stringify({ type: 'get_available_models', id: 'models' }), JSON.stringify({ type: 'prompt', id: 'turn', message: 'Hello.' })].join('\n') + '\n' : '');
  });
}
function success(result: Awaited<ReturnType<typeof run>>, mode: Mode, text = '[Mock AI Response]') {
  expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: '' });
  if (mode === 'print') expect(result.stdout).toBe(text + '\n');
  else { const records = result.stdout.trim().split('\n').map(line => JSON.parse(line)); expect(records.length).toBeGreaterThan(0); expect(records.every(record => typeof record.type === 'string')).toBe(true); expect(result.stdout).toContain(text); if (mode === 'rpc') expect(records).toContainEqual(expect.objectContaining({ type: 'response', id: 'models', success: true })); }
}

describe('actual offline startup and conserved explicit operations', () => {
  for (const mode of ['print', 'json', 'rpc'] as const) for (const source of ['flag', 'environment'] as const) {
    it(`${mode}/${source}: no model HTTP, command process or expired OAuth write`, async () => {
      const test = await fixture(); test.env.AI_HARNESS_OFFLINE = source === 'environment' ? 'YeS' : 'false';
      try { success(await run(test, mode, source === 'flag' ? ['--offline'] : []), mode); await test.passive(); }
      finally { await test.close(); }
    }, 30_000);
  }
  for (const mode of ['print', 'json', 'rpc'] as const) {
    it(`${mode}: the default online control really discovers, executes and refreshes`, async () => {
      const test = await fixture(); test.env.AI_HARNESS_OFFLINE = '0';
      try { success(await run(test, mode, []), mode); expect(await readFile(test.commandMarker, 'utf8')).toBe('executed'); expect(test.requests.filter(request => request.url === '/oauth/token')).toHaveLength(1); expect(test.requests.filter(request => request.url === '/v1/models')).toHaveLength(mode === 'rpc' ? 2 : 1); expect(test.requests.filter(request => request.url === '/openai/models')).toHaveLength(mode === 'rpc' ? 2 : 1); expect(await readFile(path.join(test.agent, 'credentials.enc'))).not.toEqual(test.before); }
      finally { await test.close(); }
    }, 30_000);
    it(`${mode}: offline is not a ban on explicit cloud-style turns, extensions or tools`, async () => {
      const test = await fixture(false, undefined, true);
      try {
        success(await run(test, mode, ['--offline'], 'local'), mode, 'LOCAL EXPLICIT RESPONSE');
        expect(await readFile(test.extensionMarker, 'utf8')).toBe('loaded');
        expect(test.requests.map(request => request.url)).toEqual(['/explicit-extension', '/v1/chat/completions']);
        const tools = test.requests[1].body.tools as Array<{ function: { name: string } }>;
        expect(tools.map(tool => tool.function.name)).toEqual(expect.arrayContaining(['read', 'offline_probe']));
      } finally { await test.close(); }
    }, 30_000);
  }
  for (const mode of ['print', 'json'] as const) {
    it(`${mode}: authoritative contributed-option arity never promotes a prompt --offline token`, async () => {
      const test = await fixture(true, '1');
      try {
        const result = await run(test, mode, [], 'mock', ['--offline-custom', 'Hello.', '--offline']);
        expect(result).toMatchObject({ code: 0, signal: null, stderr: '' });
        if (mode === 'print') expect(result.stdout).toBe('[Mock AI Response]\n');
        else expect(result.stdout.trim().split('\n').map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ type: 'message_end', message: expect.objectContaining({ role: 'user', content: '--offline' }) }));
        expect(await readFile(test.commandMarker, 'utf8')).toBe('executed');
        expect(test.requests.map(request => request.url).sort()).toEqual(['/oauth/token', '/openai/models', '/v1/models']);
      } finally { await test.close(); }
    }, 30_000);
  }
  for (const offline of [false, true]) {
    it(`--list-models respects offline=${offline} without starting a conversation`, async () => {
      const test = await fixture(false);
      try {
        const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => { const child = spawn(process.execPath, [...test.args, ...(offline ? ['--offline'] : []), '--list-models'], { cwd: test.cwd, env: test.env, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; }); child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); });
        expect(result).toMatchObject({ code: 0, stderr: '' }); expect(result.stdout).toContain('local-model'); expect(result.stdout.includes('live-only')).toBe(!offline);
        expect(test.requests.map(request => request.url)).toEqual(offline ? [] : ['/v1/models']);
      } finally { await test.close(); }
    }, 30_000);
  }
  for (const value of ['true', 'false', '']) {
    it(`rejects --offline=${value} before executable or credential admission`, async () => {
      const test = await fixture(true, '0');
      try { const result = await run(test, 'print', ['--offline=' + value]); expect(result).toMatchObject({ code: 2, signal: null, stdout: '', stderr: 'Error: --offline does not accept a value.\n' }); await test.passive(); await expect(readFile(test.extensionMarker)).rejects.toMatchObject({ code: 'ENOENT' }); }
      finally { await test.close(); }
    }, 30_000);
  }
  for (const mode of ['regular', 'fullscreen'] as const) for (const source of ['flag', 'environment', 'online'] as const) {
    it(`${mode}/${source}: catalogue commands and reload retain the original policy despite extension environment mutation`, async () => {
      const offline = source !== 'online', test = await fixture(true, offline ? '0' : '1');
      test.env.AI_HARNESS_OFFLINE = source === 'environment' ? 'true' : '0';
      const terminal = spawnPty(process.execPath, [...test.args, ...(source === 'flag' ? ['--offline'] : []), '--tui-mode', mode, '--theme', 'dark', '--name', 'offline-probe'], { cwd: test.cwd, env: test.env, cols: 180, rows: 35 });
      let output = '', exited: { exitCode: number; signal?: number } | undefined; terminal.onData(text => { output += text; }); terminal.onExit(value => { exited = value; }); const visible = () => stripVTControlCharacters(output);
      try {
        await vi.waitFor(() => expect(visible()).toContain('offline-probe: '), { timeout: 10_000 }); expect(await readFile(test.extensionMarker, 'utf8')).toBe('loaded');
        if (offline) await test.passive(); else expect(test.requests.filter(request => request.url === '/v1/models')).toHaveLength(1);
        output = ''; terminal.write('/model list\r'); await vi.waitFor(() => { expect(visible()).toContain('MOCK Models:'); expect(visible()).toContain('offline-probe: '); }, { timeout: 10_000 });
        if (offline) await test.passive(); else expect(test.requests.filter(request => request.url === '/v1/models')).toHaveLength(2);
        output = ''; terminal.write('/reload\r'); await vi.waitFor(() => { expect(visible()).toContain('Reloaded '); expect(visible()).toContain('offline-probe: '); }, { timeout: 10_000 });
        if (offline) await test.passive(); else expect(test.requests.filter(request => request.url === '/v1/models')).toHaveLength(3);
        terminal.write('/quit\r'); await vi.waitFor(() => expect(exited).toMatchObject({ exitCode: 0 }), { timeout: 10_000 });
      } finally { if (!exited) terminal.kill(); await test.close(); }
    }, 30_000);
  }
});
