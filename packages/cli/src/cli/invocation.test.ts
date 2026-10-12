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

function shellArgument(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

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
    child.once('close', (value, signal) => {
      clearTimeout(timeout);
      if (signal) console.error('CLI_SIGNAL_EXIT', JSON.stringify({ signal, node: process.version, argumentCount: args.length }));
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

  it('registers owned startup options once, exposes values and trust-gates generated help/completion', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-options-'));
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-options-agent-'));
    temporaryDirectories.push(cwd, agentDir);
    const extension = path.join(cwd, 'options.mjs');
    const marker = path.join(cwd, 'loaded.txt');
    const capture = path.join(cwd, 'values.json');
    await writeFile(extension, `
      import { appendFileSync, writeFileSync } from 'node:fs';
      appendFileSync(process.env.OPTION_MARKER, 'import\\n');
      export default api => {
        appendFileSync(process.env.OPTION_MARKER, 'factory\\n');
        api.registerOption('review-style', { type: 'string', description: 'Review style', default: 'brief', completions: ['brief', 'full'] });
        api.registerOption('review-check', { type: 'boolean', description: 'Check review', default: false });
        api.before('before:provider', () => {
          writeFileSync(process.env.OPTION_CAPTURE, JSON.stringify({ style: api.getOption('review-style'), check: api.getOption('review-check') }));
        });
      };
    `);
    const env = { AI_HARNESS_AGENT_DIR: agentDir, OPTION_MARKER: marker, OPTION_CAPTURE: capture };
    for (const flag of ['--help', '--version']) {
      const safe = await invoke(['--approve', '--extension', extension, flag], undefined, env, cwd);
      expect(safe.code).toBe(0);
      expect(safe.stderr).toBe('');
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      const unknownHelp = await invoke(['--approve', '--extension', extension, flag, '--review-style=full'], undefined, env, cwd);
      expect(unknownHelp).toMatchObject({ code: 2, stdout: '' });
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const denied = await invoke(['--no-approve', '--extension', extension, '--help-extensions'], undefined, env, cwd);
    expect(denied.code).toBe(0);
    expect(denied.stdout).not.toContain('--review-style');
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    const unknownDenied = await invoke(['--no-approve', '--extension', extension, '--review-style=full'], undefined, env, cwd);
    expect(unknownDenied).toMatchObject({ code: 2, stdout: '' });
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });

    const help = await invoke(['--approve', '--extension', extension, '--help-extensions'], undefined, env, cwd);
    expect(help).toMatchObject({ code: 0, stderr: '' });
    expect(help.stdout).toContain('--review-style <value>  Review style');
    await rm(marker);
    const completion = await invoke(['--approve', '--extension', extension, '--completion=--review-style=f'], undefined, env, cwd);
    expect(completion).toEqual({ code: 0, stdout: '--review-style=full\n', stderr: '' });
    await rm(marker);
    const print = await invoke(['--approve', '--extension', extension, '--review-style=full', '--review-check=false', '--print', '--no-session', 'hello'], undefined, env, cwd);
    expect(print).toEqual({ code: 0, stdout: '[Mock AI Response]\n', stderr: '' });
    expect(JSON.parse(await readFile(capture, 'utf8'))).toEqual({ style: 'full', check: false });
    expect(await readFile(marker, 'utf8')).toBe('import\nfactory\n');
    await rm(marker);
    const json = await invoke(['--approve', '--extension', extension, '--review-check', '--mode=json', '--no-session', 'hello'], undefined, env, cwd);
    expect(json.code, json.stderr).toBe(0);
    expect(json.stdout.trim().split('\n').every(line => !!JSON.parse(line))).toBe(true);
    expect(JSON.parse(await readFile(capture, 'utf8'))).toEqual({ style: 'brief', check: true });
    expect(await readFile(marker, 'utf8')).toBe('import\nfactory\n');
    for (const args of [['--review-style='], ['--review-check=maybe'], ['--review-check', '--review-check'], ['--missing']]) {
      const invalid = await invoke(['--approve', '--extension', extension, ...args], undefined, env, cwd);
      expect(invalid).toMatchObject({ code: 2, stdout: '' });
    }
    const conflicting = path.join(cwd, 'conflict.mjs');
    await writeFile(conflicting, `export default api => api.registerOption('review-style', { type: 'string', description: 'Conflict' });`);
    const conflict = await invoke(['--approve', '--extension', extension, '--extension', conflicting, '--help-extensions'], undefined, env, cwd);
    expect(conflict).toEqual({ code: 2, stdout: '', stderr: 'Error: Extension startup registration failed. Check trusted extension metadata.\n' });
    await writeFile(extension, `export default api => api.registerOption('help', { type: 'boolean', description: 'Hijack' });`);
    expect(await invoke(['--approve', '--extension', extension, '--help-extensions'], undefined, env, cwd))
      .toEqual({ code: 2, stdout: '', stderr: 'Error: Extension startup registration failed. Check trusted extension metadata.\n' });
  }, 60_000);

  it('reuses owned contributed values in real RPC processes with pure framing and consistent shutdown', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-rpc-options-'));
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-rpc-options-agent-'));
    temporaryDirectories.push(cwd, agentDir);
    const extension = path.join(cwd, 'a-owner.mjs');
    const observer = path.join(cwd, 'z-observer.mjs');
    const marker = path.join(cwd, 'lifecycle.jsonl');
    await writeFile(extension, `
      import { appendFileSync } from 'node:fs';
      const mark = value => appendFileSync(process.env.OPTION_MARKER, JSON.stringify(value) + '\\n');
      console.log('option import noise'); mark({ phase: 'import' });
      export default api => {
        console.log('option factory noise');
        api.registerOption('review-style', { type: 'string', description: 'Review style', default: 'brief', completions: ['brief', 'full'] });
        api.registerOption('review-check', { type: 'boolean', description: 'Review check', default: false });
        const values = () => ({ style: api.getOption('review-style'), check: api.getOption('review-check') });
        mark({ phase: 'factory', ...values() });
        api.before('before:provider', () => { console.log('option hook noise'); mark({ phase: 'hook', ...values() }); });
        api.registerCommand('review-values', { description: 'Read review values', handler: () => {
          mark({ phase: 'command', ...values() }); return JSON.stringify(values());
        } });
        api.registerTool({ name: 'review_values', description: 'Read review values', parameters: { type: 'object', properties: {} },
          execute: async () => ({ content: JSON.stringify(values()) }) });
        api.registerProvider('option-probe', { defaultConfig: { model: 'option-model' }, create(config) {
          return { config, validateConfig() { return true; }, getProviderType() { return 'option-probe'; },
            getConfiguredModel() { return this.config.model; }, setConfiguredModel(model) { this.config.model = model; },
            async chat() { return { content: 'unused' }; },
            async streamChat(messages, onChunk, onComplete, onError, options) {
              if (!options.tools.some(tool => tool.name === 'review_values')) throw new Error('Owned tool not declared');
              if (messages.some(message => message.role === 'tool')) onComplete({ content: 'review complete' });
              else onComplete({ content: '', toolCalls: [{ id: 'review-call', name: 'review_values', input: {} }] });
            },
          };
        } });
        api.on('system:shutdown', () => { console.log('option shutdown noise'); mark({ phase: 'shutdown', ...values() }); });
        return () => { console.log('option cleanup noise'); mark({ phase: 'cleanup' }); };
      };
    `);
    await writeFile(observer, `
      import { appendFileSync } from 'node:fs';
      export default api => api.before('before:provider', () => {
        appendFileSync(process.env.OPTION_MARKER, JSON.stringify({ phase: 'observer', value: api.getOption('review-style') ?? null }) + '\\n');
      });
    `);
    const env = { AI_HARNESS_AGENT_DIR: agentDir, OPTION_MARKER: marker };
    const base = ['--approve', '--extension', extension, '--extension', observer, '--mode=rpc', '--no-session'];
    const help = await invoke([...base, '--help-extensions'], '', env, cwd);
    expect(help.code, help.stderr).toBe(0);
    expect(help.stdout).toContain('--review-style <value>  Review style');
    expect((await readFile(marker, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))).toEqual([
      { phase: 'import' }, { phase: 'factory', style: 'brief', check: false }, { phase: 'cleanup' },
    ]);
    await rm(marker);
    const completion = await invoke([...base, '--completion=--review-style=f'], '', env, cwd);
    expect(completion).toMatchObject({ code: 0, stdout: '--review-style=full\n' });
    expect((await readFile(marker, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))).toEqual([
      { phase: 'import' }, { phase: 'factory', style: 'brief', check: false }, { phase: 'cleanup' },
    ]);
    await rm(marker);
    for (const [flags, values] of [
      [['--review-style', 'full', '--review-check=false'], { style: 'full', check: false }],
      [['--review-check'], { style: 'brief', check: true }],
      [[], { style: 'brief', check: false }],
    ] as Array<[string[], { style: string; check: boolean }]>) {
      const result = await invoke([...base, ...flags, '--provider=option-probe', '--model=option-model', '--tools=review_values'],
        '{"type":"get_commands","id":"commands"}\n{"type":"prompt","id":"values","message":"/review-values"}\n{"type":"prompt","message":"review"}\n', env, cwd);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout.endsWith('\n')).toBe(true);
      const records = result.stdout.trimEnd().split('\n').map(line => JSON.parse(line));
      expect(records.find(record => record.id === 'commands')).toMatchObject({ success: true,
        data: { commands: expect.arrayContaining([expect.objectContaining({ name: 'review-values', source: 'extension' })]) } });
      expect(records.find(record => record.type === 'tool_execution_end')).toMatchObject({
        toolName: 'review_values', isError: false, result: { content: [{ type: 'text', text: JSON.stringify(values) }] },
      });
      expect(records.at(-1)).toEqual({ type: 'agent_settled' });
      for (const phase of ['import', 'factory', 'hook', 'shutdown', 'cleanup']) expect(result.stderr).toContain(`option ${phase} noise`);
      const lifecycle = (await readFile(marker, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
      expect(lifecycle.filter(record => record.phase === 'import')).toHaveLength(1);
      expect(lifecycle.filter(record => record.phase === 'factory')).toEqual([{ phase: 'factory', style: 'brief', check: false }]);
      expect(lifecycle.filter(record => record.phase === 'command')).toEqual([{ phase: 'command', ...values }]);
      expect(lifecycle.filter(record => record.phase === 'hook')).toEqual([
        { phase: 'hook', ...values }, { phase: 'hook', ...values },
      ]);
      expect(lifecycle.filter(record => record.phase === 'observer')).toEqual([
        { phase: 'observer', value: null }, { phase: 'observer', value: null },
      ]);
      expect(lifecycle.slice(-2)).toEqual([{ phase: 'shutdown', ...values }, { phase: 'cleanup' }]);
      await rm(marker);
    }
    const failed = await invoke([...base, '--review-style=full', '--provider=missing', '--model=missing'], '', env, cwd);
    expect(failed.code).not.toBe(0);
    expect(failed.stdout).toBe('');
    expect(failed.stderr).toContain('Provider unavailable');
    const lifecycle = (await readFile(marker, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    expect(lifecycle.slice(-2)).toEqual([{ phase: 'shutdown', style: 'full', check: false }, { phase: 'cleanup' }]);
    await rm(marker);
    for (const flags of [['--review-style='], ['--review-check=maybe'], ['--review-check', '--review-check'], ['--missing']]) {
      const invalid = await invoke([...base, ...flags], '', env, cwd);
      expect(invalid).toMatchObject({ code: 2, stdout: '' });
      expect((await readFile(marker, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))).toEqual([
        { phase: 'import' }, { phase: 'factory', style: 'brief', check: false }, { phase: 'cleanup' },
      ]);
      await rm(marker);
    }
    const denied = await invoke(['--no-approve', '--extension', extension, '--mode=rpc', '--review-style=full'], '', env, cwd);
    expect(denied).toMatchObject({ code: 2, stdout: '' });
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);

  it('administers shared packages without starting the agent and loads enabled package resources', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-packages-'));
    temporaryDirectories.push(cwd);
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-packages-agent-'));
    temporaryDirectories.push(agentDir);
    const packageRoot = path.join(cwd, 'review-package');
    const marker = path.join(cwd, 'package-extension-loaded');
    await mkdir(path.join(packageRoot, 'extensions'), { recursive: true });
    await mkdir(path.join(packageRoot, 'prompts'), { recursive: true });
    await mkdir(path.join(packageRoot, 'skills', 'package-audit'), { recursive: true });
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: '@demo/cli-package',
      version: '1.0.0',
      aiHarness: { extensions: ['extensions/*.mjs'], skills: ['skills'], prompts: ['prompts/*.md'] },
    }));
    await writeFile(path.join(packageRoot, 'extensions', 'marker.mjs'), `
      import { writeFileSync } from 'node:fs';
      writeFileSync(process.env.PACKAGE_MARKER, 'loaded');
      export default () => {};
    `);
    await writeFile(path.join(packageRoot, 'prompts', 'review.md'), '---\nname: package-review\n---\nReview $@');
    await writeFile(
      path.join(packageRoot, 'skills', 'package-audit', 'SKILL.md'),
      '---\nname: package-audit\ndescription: Audit a package\n---\nAudit instructions',
    );
    const environment = { AI_HARNESS_AGENT_DIR: agentDir, PACKAGE_MARKER: marker };

    const installed = await invoke(['package', 'install', packageRoot, '--approve', '--json'], undefined, environment, cwd);
    expect(installed).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(installed.stdout)).toMatchObject({
      packages: [expect.objectContaining({ packageName: '@demo/cli-package', scope: 'global', status: 'active' })],
    });

    const listed = await invoke(['list', '--approve', '--json'], undefined, environment, cwd);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout).packages).toHaveLength(1);

    const active = await invoke(['--approve', '--print', '--no-session', 'hello'], undefined, environment, cwd);
    expect(active).toEqual({ code: 0, stdout: '[Mock AI Response]\n', stderr: '' });
    expect(await readFile(marker, 'utf8')).toBe('loaded');

    const rpc = await invoke(
      ['--approve', '--mode', 'rpc', '--no-session'],
      '{"type":"get_commands","id":"packages"}\n',
      environment,
      cwd,
    );
    expect(rpc.code).toBe(0);
    expect(JSON.parse(rpc.stdout)).toMatchObject({
      id: 'packages',
      success: true,
      data: { commands: expect.arrayContaining([
        expect.objectContaining({ name: 'package-review', source: 'prompt' }),
        expect.objectContaining({ name: 'skill:package-audit', source: 'skill' }),
      ]) },
    });

    const configured = await invoke([
      'config', '@demo/cli-package', '--approve', '--extensions=', '--prompts=+prompts/review.md', '--json',
    ], undefined, environment, cwd);
    expect(configured.code).toBe(0);
    expect(JSON.parse(configured.stdout).packages[0]).toMatchObject({
      counts: { extensions: 0, prompts: 1 },
      resourceFilters: { extensions: [], prompts: ['+prompts/review.md'] },
    });
    await rm(marker, { force: true });
    expect((await invoke(['--approve', '--print', '--no-session', 'hello'], undefined, environment, cwd)).code).toBe(0);
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const removed = await invoke(['remove', '@demo/cli-package', '--approve', '--json'], undefined, environment, cwd);
    expect(removed.code).toBe(0);
    expect(JSON.parse(removed.stdout).packages).toEqual([]);
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
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-instructions-agent-'));
    temporaryDirectories.push(agentDir);
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
    const environment = { AI_HARNESS_AGENT_DIR: agentDir, PROMPT_CAPTURE: capture };

    const printed = await invoke([
      '--approve', '--print', '--no-session', '--extension', './capture.mjs',
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
      '--approve', '--mode', 'json', '--no-session', '--no-context-files', '--extension', './capture.mjs',
      '--system-prompt', 'JSON base', 'hello',
    ], undefined, environment, cwd);
    expect(json.code).toBe(0);
    expect(await readFile(capture, 'utf8')).toContain('JSON base');
    expect(await readFile(capture, 'utf8')).not.toContain('user-level context');

    const rpc = await invoke([
      '--approve', '--mode', 'rpc', '--no-session', '--extension', './capture.mjs', '--system-prompt', 'RPC base',
    ], '{"type":"prompt","message":"hello"}\n', environment, cwd);
    expect(rpc.code).toBe(0);
    expect(await readFile(capture, 'utf8')).toContain('RPC base');
  });

  it('applies agent settings to model scope, thinking, queues, tools, and session storage', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-settings-'));
    temporaryDirectories.push(cwd);
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-settings-agent-'));
    temporaryDirectories.push(agentDir);
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
    const environment = { AI_HARNESS_AGENT_DIR: agentDir };

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

  it('applies one-process trust overrides and the global headless trust policy without persisting overrides', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-trust-'));
    temporaryDirectories.push(cwd);
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-trust-agent-'));
    temporaryDirectories.push(agentDir);
    const projectConfig = path.join(cwd, '.ai-harness');
    const capture = path.join(cwd, 'captured-trust-prompt.txt');
    await mkdir(agentDir, { recursive: true });
    await mkdir(projectConfig, { recursive: true });
    await writeFile(path.join(projectConfig, 'SYSTEM.md'), 'trusted project instructions');
    const captureExtension = path.join(agentDir, 'capture.mjs');
    await writeFile(captureExtension, `
      import { writeFileSync } from 'node:fs';
      export default api => api.before('before:provider', data => {
        writeFileSync(process.env.PROMPT_CAPTURE, String(data.options.systemPrompt));
      });
    `);
    const environment = { AI_HARNESS_AGENT_DIR: agentDir, PROMPT_CAPTURE: capture };
    const args = ['--print', '--no-session', '--extension', captureExtension, 'hello'];

    const untrusted = await invoke(args, undefined, environment, cwd);
    expect(untrusted.code, untrusted.stderr).toBe(0);
    expect(await readFile(capture, 'utf8')).not.toContain('trusted project instructions');

    const approved = await invoke(['--approve', ...args], undefined, environment, cwd);
    expect(approved.code, approved.stderr).toBe(0);
    expect(await readFile(capture, 'utf8')).toContain('trusted project instructions');
    await expect(readFile(path.join(agentDir, 'trust.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProjectTrust: 'always' }));
    const always = await invoke(args, undefined, environment, cwd);
    expect(always.code, always.stderr).toBe(0);
    expect(await readFile(capture, 'utf8')).toContain('trusted project instructions');

    const refused = await invoke(['--no-approve', ...args], undefined, environment, cwd);
    expect(refused.code, refused.stderr).toBe(0);
    expect(await readFile(capture, 'utf8')).not.toContain('trusted project instructions');
  });

  it('does not let an untrusted workspace masquerade as the global agent directory', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-agent-dir-trust-'));
    temporaryDirectories.push(cwd);
    const agentDir = path.join(cwd, '.attacker-agent');
    const safeExtensionDir = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-agent-dir-capture-'));
    temporaryDirectories.push(safeExtensionDir);
    const capture = path.join(cwd, 'captured-agent-dir-prompt.txt');
    const captureExtension = path.join(safeExtensionDir, 'capture.mjs');
    await mkdir(path.join(cwd, '.ai-harness'), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(cwd, '.ai-harness', 'SYSTEM.md'), 'project-controlled base');
    await writeFile(path.join(agentDir, 'AGENTS.md'), 'project-controlled fake global context');
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProjectTrust: 'always' }));
    await writeFile(captureExtension, `
      import { writeFileSync } from 'node:fs';
      export default api => api.before('before:provider', data => {
        writeFileSync(process.env.PROMPT_CAPTURE, String(data.options.systemPrompt));
      });
    `);
    const environment = { AI_HARNESS_AGENT_DIR: agentDir, PROMPT_CAPTURE: capture };
    const args = ['--print', '--no-session', '--extension', captureExtension, 'hello'];

    expect((await invoke(args, undefined, environment, cwd)).code).toBe(0);
    const untrusted = await readFile(capture, 'utf8');
    expect(untrusted).not.toContain('project-controlled base');
    expect(untrusted).not.toContain('project-controlled fake global context');

    expect((await invoke(['--approve', ...args], undefined, environment, cwd)).code).toBe(0);
    const trusted = await readFile(capture, 'utf8');
    expect(trusted).toContain('project-controlled base');
    expect(trusted).toContain('project-controlled fake global context');
  });

  it('prompts for protected resources in an interactive terminal and saves the selected decision', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-trust-prompt-'));
    temporaryDirectories.push(cwd);
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-trust-prompt-agent-'));
    temporaryDirectories.push(agentDir);
    await mkdir(path.join(cwd, '.ai-harness'), { recursive: true });
    await writeFile(path.join(cwd, '.ai-harness', 'SYSTEM.md'), 'project instructions');
    const command = [
      process.execPath, '--import', tsxImport, entry,
      '--tui-mode', 'regular', '--no-session',
    ].map(shellArgument).join(' ');
    const child = spawn('/usr/bin/script', ['-qefc', command, '/dev/null'], {
      cwd,
      env: {
        ...process.env,
        HOME: path.join(cwd, 'home'),
        AI_HARNESS_AGENT_DIR: agentDir,
        NO_COLOR: '1',
        NODE_NO_WARNINGS: '1',
        AI_HARNESS_DEFAULT_PROVIDER: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
    const waitForOutput = async (value: string): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (!output.includes(value)) {
        if (Date.now() >= deadline) throw new Error(`Interactive CLI did not emit: ${value}\n${output}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };

    try {
      await waitForOutput('Project-controlled resources require a trust decision');
      child.stdin.write('1\r');
      await waitForOutput('Nouvelle conversation:');
      child.stdin.write('/quit\r');
      child.stdin.end();
      const code = await new Promise<number | null>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`Interactive CLI trust prompt timed out.\n${output}`));
        }, 5_000);
        child.once('error', reject);
        child.once('close', value => {
          clearTimeout(timeout);
          resolve(value);
        });
      });
      expect(code).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }

    expect(JSON.parse(await readFile(path.join(agentDir, 'trust.json'), 'utf8'))).toMatchObject({
      version: 2,
      decisions: { [cwd]: true },
    });
  }, 15_000);

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

  it('queues interactive steering/follow-ups and restores pending input on Escape', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-interactive-queue-'));
    temporaryDirectories.push(cwd);
    const sessionDir = path.join(cwd, 'sessions');
    const extensionPath = path.join(cwd, 'slow-provider.mjs');
    await writeFile(extensionPath, `
      export default api => api.registerProvider('slow', {
        defaultConfig: { model: 'slow-model' },
        create(config) {
          return {
            config,
            validateConfig() { return true; },
            getProviderType() { return 'slow'; },
            getConfiguredModel() { return this.config.model || 'slow-model'; },
            setConfiguredModel(model) { this.config.model = model; },
            async chat() { return { content: 'unused' }; },
            async streamChat(messages, onChunk, onComplete, onError, options) {
              try {
                await new Promise((resolve, reject) => {
                  const timer = setTimeout(resolve, 250);
                  options?.signal?.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(new Error('aborted'));
                  }, { once: true });
                });
                const users = messages.filter(message => message.role === 'user')
                  .map(message => message.content).join('|');
                onChunk('answer:' + users);
                onComplete?.({ content: 'answer:' + users, model: 'slow-model' });
              } catch (error) { onError?.(error); }
            },
          };
        },
      });
    `);
    const command = [
      process.execPath, '--import', tsxImport, entry,
      '--approve', '--tui-mode', 'regular', '--session-dir', sessionDir, '--session-id', 'queue-test',
      '--extension', extensionPath, '--provider', 'slow', '--model', 'slow-model',
    ].map(shellArgument).join(' ');
    const child = spawn('/usr/bin/script', ['-qefc', command, '/dev/null'], {
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
    let output = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
    const waitForOutput = async (value: string, count = 1): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (output.split(value).length - 1 < count) {
        if (Date.now() >= deadline) throw new Error(`Interactive CLI did not emit: ${value}\n${output}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };

    try {
      await waitForOutput('Nouvelle conversation:');
      child.stdin.write('initial\r');
      await waitForOutput('┌─ Assistant');
      child.stdin.write('steer now\r');
      await waitForOutput('Steering en file');
      child.stdin.write('later task\u001b\r');
      await waitForOutput('Follow-up en file');
      await waitForOutput('answer:initial|steer now|later task');
      await new Promise(resolve => setTimeout(resolve, 200));

      child.stdin.write('abort base\r');
      await waitForOutput('┌─ Assistant', 4);
      child.stdin.write('restore me\r');
      await waitForOutput('Steering en file', 2);
      child.stdin.write('\u001b');
      await waitForOutput('[Interrupted]');
      await new Promise(resolve => setTimeout(resolve, 100));
      child.stdin.write('\r');
      await waitForOutput('answer:initial|steer now|later task|abort base|restore me');
      await new Promise(resolve => setTimeout(resolve, 200));
      child.stdin.write('\u001b');
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(child.exitCode).toBeNull();

      child.stdin.write('/quit\r');
      child.stdin.end();
      const code = await new Promise<number | null>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`Interactive CLI timed out.\n${output}`));
        }, 5_000);
        child.once('error', reject);
        child.once('close', value => {
          clearTimeout(timeout);
          resolve(value);
        });
      });
      expect(code).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }

    const entries = (await readFile(path.join(sessionDir, 'queue-test.jsonl'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    expect(entries.filter(entry => entry.type === 'message').map(entry => ({
      role: entry.role,
      content: entry.content,
      queueKind: (entry.metadata as { queueKind?: string } | undefined)?.queueKind,
    }))).toEqual([
      { role: 'user', content: 'initial', queueKind: undefined },
      { role: 'assistant', content: 'answer:initial', queueKind: undefined },
      { role: 'user', content: 'steer now', queueKind: 'steer' },
      { role: 'assistant', content: 'answer:initial|steer now', queueKind: undefined },
      { role: 'user', content: 'later task', queueKind: 'follow-up' },
      { role: 'assistant', content: 'answer:initial|steer now|later task', queueKind: undefined },
      { role: 'user', content: 'abort base', queueKind: undefined },
      { role: 'user', content: 'restore me', queueKind: undefined },
      { role: 'assistant', content: 'answer:initial|steer now|later task|abort base|restore me', queueKind: undefined },
    ]);
  }, 15_000);

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
    // Custom providers must now be discovered from trusted extensions before model resolution,
    // just as in print/JSON. Even failed custom resolution keeps extension noise off stdout.
    expect(invalidProvider.stderr).toContain('rpc extension stdout noise');
  });

  it('accepts RPC command envelopes, strict LF framing, and startup session selectors', async () => {
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

  it.each(['json', 'print', 'rpc'])('executes model/nested QuickJS bridges in %s outside the installation with authenticated accounting', async mode => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-codemode-'));
    temporaryDirectories.push(cwd);
    const sessionDir = path.join(cwd, 'sessions');
    const extensionPath = path.join(cwd, 'sandbox-provider.mjs');
    await writeFile(extensionPath, `
      export default api => {
        api.registerTool({ name: 'nested_lookup', description: 'Nested lookup', exposure: 'codemode',
          parameters: { type: 'object', properties: { value: { type: 'string' } } },
          execute: async input => ({ content: 'nested:' + input.value }) });
        api.registerProvider('sandbox', {
          defaultConfig: { model: 'sandbox-model' }, create(config) {
            return { config, validateConfig() { return true; }, getProviderType() { return 'sandbox'; },
              getConfiguredModel() { return this.config.model; }, setConfiguredModel(model) { this.config.model = model; },
              getSpecializedModels() { return [
                { id: 'classifier', type: 'classifier', model: 'sandbox-model', provider: 'sandbox' },
                { id: 'image', type: 'image', model: 'sandbox-image', provider: 'sandbox' },
              ]; },
              async classify(request) { return { label: request.labels[0], usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4, costUsd: 0.002 } }; },
              async generateImages() { return { images: [{ mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=' }], usage: { costUsd: 0.01 } }; },
              async chat() { return { content: 'unused' }; },
              async streamChat(messages, onChunk, onComplete, onError, options) {
                if (options.tools.some(tool => tool.name === 'nested_lookup')) throw new Error('Script-only tool declared directly');
                const previous = messages.find(message => message.role === 'tool');
                if (previous) { onComplete({ content: 'sandbox-complete' }); return; }
                onComplete({ content: '', toolCalls: [{ id: 'code-call', name: 'codemode', input: {
                  code: 'text(await tools.nested_lookup({value: "safe"})); text((await models.classify({model:"classifier",input:"test",labels:["safe"]})).label); text((await models.generateImages({model:"image",prompt:"pixel"})).images[0].mediaType); text(typeof process); store("remember", {count: 1});'
                } }] });
              }
            };
          }
        });
      };
    `);
    const result = await invoke([...(mode === 'print' ? ['--print'] : ['--mode', mode]), '--approve', '--extension', extensionPath,
      '--provider', 'sandbox', '--model', 'sandbox-model', '--tools', 'codemode,nested_lookup',
      '--session-id', 'sandbox-test', '--session-dir', sessionDir, ...(mode === 'rpc' ? [] : ['exercise sandbox'])],
      mode === 'rpc' ? '{"type":"prompt","message":"exercise sandbox"}\n' : undefined, {}, cwd);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    if (mode === 'print') expect(result.stdout).toBe('sandbox-complete\n');
    else {
      const records = result.stdout.trimEnd().split('\n').map(line => JSON.parse(line));
      expect(records.some(record => record.type === 'agent_settled')).toBe(true);
      const progress = records.filter(record => record.type === 'tool_execution_update' && record.partialResult?.details.kind === 'codemode');
      expect(progress).toHaveLength(6);
      expect(progress.every(record => record.toolCallId === 'code-call')).toBe(true);
      expect(records.filter(record => record.type === 'tool_execution_start')).toHaveLength(1);
    }
    const entries = (await readFile(path.join(sessionDir, 'sandbox-test.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    const tool = entries.find(entry => entry.role === 'tool');
    expect(tool).toMatchObject({ metadata: { codemode: { engine: 'QuickJS', store: { remember: { count: 1 } },
      parentId: 'code-call', costComplete: true, usage: { totalTokens: 4, costUsd: 0.012 },
      nestedCalls: [expect.objectContaining({ name: 'nested_lookup', isError: false }),
        expect.objectContaining({ kind: 'classifier', state: 'completed' }), expect.objectContaining({ kind: 'image', state: 'completed' })] } },
      usage: { totalTokens: 4, costUsd: 0.012 } });
    expect(tool.content).toContain('nested:safe');
    expect(tool.content).toContain('undefined');
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
