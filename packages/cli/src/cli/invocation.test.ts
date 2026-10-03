import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];
const entry = fileURLToPath(new URL('../index.ts', import.meta.url));
const tsxImport = createRequire(import.meta.url).resolve('tsx');

async function invoke(
  args: string[],
  input?: string,
  environment: NodeJS.ProcessEnv = {},
  workingDirectory?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const cwd = workingDirectory ?? await mkdtemp(path.join(os.tmpdir(), 'aih-cli-invocation-'));
  if (!workingDirectory) temporaryDirectories.push(cwd);
  const home = path.join(cwd, 'home');
  const child = spawn(process.execPath, ['--import', tsxImport, entry, ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      NO_COLOR: '1',
      NODE_NO_WARNINGS: '1',
      AI_HARNESS_DEFAULT_PROVIDER: '',
      ...environment,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('CLI invocation timed out.'));
    }, 15_000);
    child.once('error', reject);
    child.once('close', value => {
      clearTimeout(timeout);
      resolve(value);
    });
  });
  return { code, stdout, stderr };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('CLI invocation contract', () => {
  it('prints help/version and rejects unknown options before startup', async () => {
    await expect(invoke(['--version'])).resolves.toMatchObject({ code: 0, stdout: '0.1.0\n', stderr: '' });
    const help = await invoke(['--help']);
    expect(help).toMatchObject({ code: 0, stderr: '' });
    expect(help.stdout).toContain('ai-harness [options]');

    const models = await invoke(['--list-models', 'v1']);
    expect(models).toMatchObject({ code: 0, stderr: '' });
    expect(models.stdout).toContain('provider');
    expect(models.stdout).toContain('mock-model-v1');

    const invalid = await invoke(['--unknown']);
    expect(invalid.code).toBe(2);
    expect(invalid.stdout).toBe('');
    expect(invalid.stderr).toContain('Unknown option');
  });

  it('keeps print stdout pure for positional, piped, and @file input', async () => {
    const positional = await invoke(
      ['--print', '--no-session', 'hello'],
      undefined,
      { AI_HARNESS_KEYBINDINGS: '/missing/keybindings.json' },
    );
    expect(positional).toEqual({ code: 0, stdout: '[Mock AI Response]\n', stderr: '' });

    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-file-'));
    temporaryDirectories.push(cwd);
    await writeFile(path.join(cwd, 'notes.txt'), 'bounded file context');
    const child = spawn(process.execPath, ['--import', tsxImport, entry, '--no-session', '@notes.txt', 'review'], {
      cwd,
      env: {
        ...process.env,
        HOME: path.join(cwd, 'home'),
        NO_COLOR: '1',
        NODE_NO_WARNINGS: '1',
        AI_HARNESS_DEFAULT_PROVIDER: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.stdin.end('piped context');
    const code = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('CLI invocation timed out.'));
      }, 15_000);
      child.once('error', reject);
      child.once('close', value => {
        clearTimeout(timeout);
        resolve(value);
      });
    });
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: '[Mock AI Response]\n', stderr: '' });
  });

  it('applies shared system and context prompts in print, JSON, and RPC modes', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-instructions-'));
    temporaryDirectories.push(cwd);
    const agentDir = path.join(cwd, 'agent');
    await writeFile(path.join(cwd, 'base.md'), '\ufefffile base');
    await writeFile(path.join(cwd, 'append.md'), 'file append');
    await writeFile(path.join(cwd, 'capture.mjs'), `
      import { writeFileSync } from 'node:fs';
      export default api => api.before('before:provider', data => {
        writeFileSync(process.env.PROMPT_CAPTURE, String(data.options.systemPrompt));
      });
    `);
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, 'AGENTS.md'), 'user-level context');
    const capture = path.join(cwd, 'captured-prompt.txt');
    const environment = { PI_CODING_AGENT_DIR: agentDir, PROMPT_CAPTURE: capture };

    const printed = await invoke([
      '--print', '--no-session', '--extension', './capture.mjs',
      '--system-prompt', './base.md',
      '--append-system-prompt', 'literal append', '--append-system-prompt', './append.md',
      'hello',
    ], undefined, environment, cwd);
    expect(printed).toEqual({ code: 0, stdout: '[Mock AI Response]\n', stderr: '' });
    const printPrompt = await readFile(capture, 'utf8');
    expect(printPrompt).toContain('file base');
    expect(printPrompt).toContain('user-level context');
    expect(printPrompt.indexOf('literal append')).toBeLessThan(printPrompt.indexOf('file append'));

    const json = await invoke([
      '--mode', 'json', '--no-session', '--no-context-files', '--extension', './capture.mjs',
      '--system-prompt', 'JSON base', 'hello',
    ], undefined, environment, cwd);
    expect(json.code).toBe(0);
    expect(await readFile(capture, 'utf8')).toContain('JSON base');
    expect(await readFile(capture, 'utf8')).not.toContain('user-level context');

    const rpc = await invoke([
      '--mode', 'rpc', '--no-session', '--extension', './capture.mjs', '--system-prompt', 'RPC base',
    ], '{"type":"prompt","message":"hello"}\n', environment, cwd);
    expect(rpc.code).toBe(0);
    expect(await readFile(capture, 'utf8')).toContain('RPC base');
  });

  it('applies Pi settings to model scope, thinking, queues, tools, and session storage', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-settings-'));
    temporaryDirectories.push(cwd);
    const agentDir = path.join(cwd, 'agent');
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({
      defaultProvider: 'mock',
      defaultModel: 'mock-model-v1',
      defaultThinkingLevel: 'high',
      enabledModels: ['mock/mock-model', 'mock/mock-model-v1:low'],
      steeringMode: 'all',
      followUpMode: 'all',
      defaultTools: ['read'],
      sessionDir: './settings-sessions',
      unknownForDiagnostic: true,
    }));
    const environment = { PI_CODING_AGENT_DIR: agentDir };

    const rpc = await invoke(
      ['--mode', 'rpc', '--no-session'],
      '{"type":"get_state","id":"settings"}\n',
      environment,
      cwd,
    );
    expect(rpc.code).toBe(0);
    expect(rpc.stderr).toContain('unknownForDiagnostic');
    expect(JSON.parse(rpc.stdout)).toMatchObject({
      id: 'settings',
      success: true,
      data: {
        model: { provider: 'mock', id: 'mock-model-v1' },
        thinkingLevel: 'off',
        steeringMode: 'all',
        followUpMode: 'all',
      },
    });

    const persisted = await invoke(
      ['--print', '--session-id', 'settings-run', 'hello'],
      undefined,
      environment,
      cwd,
    );
    expect(persisted.code).toBe(0);
    expect(await readdir(path.join(cwd, 'settings-sessions'))).toEqual(['settings-run.jsonl']);

    const explicit = await invoke(
      ['--mode', 'rpc', '--no-session', '--model', 'mock/mock-model'],
      '{"type":"get_state"}\n',
      environment,
      cwd,
    );
    expect(JSON.parse(explicit.stdout)).toMatchObject({ data: { model: { id: 'mock-model' } } });
  });

  it('selects, names, and continues persisted startup sessions', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-sessions-'));
    temporaryDirectories.push(cwd);
    const sessionDir = path.join(cwd, 'sessions');
    const first = await invoke([
      '--print', '--session-dir', sessionDir, '--session-id', 'stable-1', '--name', 'Named run', 'first',
    ], undefined, {}, cwd);
    expect(first).toEqual({ code: 0, stdout: '[Mock AI Response]\n', stderr: '' });

    const continued = await invoke([
      '--print', '--session-dir', sessionDir, '--continue', 'second',
    ], undefined, {}, cwd);
    expect(continued).toEqual({ code: 0, stdout: '[Mock AI Response]\n', stderr: '' });
    expect(await readdir(sessionDir)).toEqual(['stable-1.jsonl']);
    const persisted = await readFile(path.join(sessionDir, 'stable-1.jsonl'), 'utf8');
    expect(persisted).toContain('"title":"Named run"');
    expect(persisted.match(/"type":"message"/g)).toHaveLength(4);
  });

  it('keeps RPC stdout protocol-pure and accepts in-memory startup', async () => {
    const extensionDirectory = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-rpc-extension-'));
    temporaryDirectories.push(extensionDirectory);
    const extensionPath = path.join(extensionDirectory, 'noisy.mjs');
    await writeFile(extensionPath, `console.log('rpc extension stdout noise'); export default () => {};`);
    const result = await invoke(
      ['--mode', 'rpc', '--no-session', '--extension', extensionPath],
      '{"id":1,"method":"system.ping"}\n',
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{"id":1,"result":{"ok":true}}\n');
    expect(result.stderr).toContain('rpc extension stdout noise');

    const invalidProvider = await invoke([
      '--mode', 'rpc', '--no-session', '--extension', extensionPath,
      '--provider', 'missing', '--model', 'missing-model',
    ], '');
    expect(invalidProvider.code).not.toBe(0);
    expect(invalidProvider.stdout).toBe('');
    expect(invalidProvider.stderr).toContain('Provider unavailable');
    expect(invalidProvider.stderr).not.toContain('rpc extension stdout noise');
  });

  it('accepts Pi RPC envelopes, strict LF framing, and startup session selectors', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-rpc-'));
    temporaryDirectories.push(cwd);
    const sessionDir = path.join(cwd, 'sessions');
    const separatorId = 'state\u2028request';
    const result = await invoke([
      '--mode', 'rpc', '--session-dir', sessionDir, '--session-id', 'rpc-stable', '--name', 'RPC run',
    ], `${JSON.stringify({ type: 'get_state', id: separatorId })}\n`, {}, cwd);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      type: 'response', command: 'get_state', id: separatorId, success: true,
      data: { sessionId: 'rpc-stable', sessionName: 'RPC run' },
    });
    expect(await readdir(sessionDir)).toEqual(['rpc-stable.jsonl']);
  });

  it('emits a strict JSONL lifecycle with a session header and no plain-text stdout', async () => {
    const extensionDirectory = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-json-extension-'));
    temporaryDirectories.push(extensionDirectory);
    const extensionPath = path.join(extensionDirectory, 'noisy.mjs');
    await writeFile(extensionPath, `console.log('extension stdout noise'); export default () => {};`);

    const result = await invoke([
      '--mode', 'json', '--no-session', '--extension', extensionPath, 'hello',
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('extension stdout noise');
    expect(result.stdout.endsWith('\n')).toBe(true);

    const records = result.stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    expect(records[0]).toMatchObject({ type: 'session', version: 3 });
    expect(records[0]?.id).toEqual(expect.any(String));
    expect(records[0]?.cwd).toEqual(expect.any(String));
    expect(records.map(record => record.type)).toEqual(expect.arrayContaining([
      'agent_start',
      'turn_start',
      'message_start',
      'message_update',
      'message_end',
      'turn_end',
      'agent_end',
      'agent_settled',
    ]));
    expect(records.at(-1)).toEqual({ type: 'agent_settled' });
    const assistantEnd = records.find(record => record.type === 'message_end'
      && (record.message as { role?: string } | undefined)?.role === 'assistant');
    expect(assistantEnd).toMatchObject({
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: '[Mock AI Response]' }],
      },
    });
  });
});
