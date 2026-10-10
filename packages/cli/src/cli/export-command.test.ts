import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, link, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EncryptedCredentialStore, JsonlSessionStore, ProviderCredentialService, type Session } from '@ai-harness/core';

const entry = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
let root: string, cwd: string, agent: string, sessions: string, source: string;
const secret = 'disposable-export-secret-817';
function invoke(args: string[], env: NodeJS.ProcessEnv = {}) {
  const bin = process.env.AIH_TOP_LEVEL_CLI_BIN;
  const child = spawn(bin ?? process.execPath, bin ? args : [entry, ...args], {
    cwd, env: { ...process.env, HOME: path.join(root, 'home'), AI_HARNESS_AGENT_DIR: agent,
      AI_HARNESS_SESSIONS_DIR: sessions, AI_HARNESS_MASTER_KEY: '', OPENAI_API_KEY: secret, NO_COLOR: '1',
      AI_HARNESS_OPENAI_API_KEY_COMMAND: `touch '${path.join(cwd, 'command-ran')}'`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  return new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Export child hung: ${stderr}`)); }, 10_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}
function args(format = 'json', selector = 'selected-session', output = `out.${format === 'markdown' ? 'md' : format}`) {
  return ['export', '--session', selector, '--format', format, '--output', output, '--approve'];
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'aih-top-export-'));
  cwd = path.join(root, 'workspace'); agent = path.join(root, 'agent'); sessions = path.join(root, 'sessions');
  await mkdir(cwd); await mkdir(agent); await mkdir(sessions, { mode: 0o700 });
  source = path.join(sessions, 'selected-session.jsonl');
  const session: Session = {
    id: 'selected-session', title: '<private-title> export', cwd,
    createdAt: new Date('2025-01-01T00:00:00Z'), updatedAt: new Date('2025-01-01T00:00:01Z'),
    messages: [{ id: 'm1', role: 'user', content: `<script>bad()</script> ${secret}`, timestamp: new Date('2025-01-01T00:00:00Z') },
      { id: 'm2', parentEntryId: 'm1', role: 'tool', name: '<img src=x onerror=bad()>', content: 'tool content', timestamp: new Date('2025-01-01T00:00:01Z') }],
    activeLeafId: 'm2', metadata: { secretCopy: secret }, providerConfig: { type: 'openai', apiKey: secret },
  };
  await new JsonlSessionStore(sessions).saveSession(session);
  await mkdir(path.join(cwd, '.ai-harness', 'extensions'), { recursive: true });
  await writeFile(path.join(cwd, '.ai-harness', 'extensions', 'evil.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(path.join(cwd, 'extension-ran'))}, 'ran'); export default () => {};`);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('actual top-level export CLI', () => {
  it('discovers command help and validates booleans/options/conflicts before startup', async () => {
    expect(await invoke(['export', '--help'])).toMatchObject({ code: 0, signal: null, stderr: '', stdout: expect.stringContaining('Usage: ai-harness export') });
    expect((await invoke(['--help'])).stdout).toContain('export --help');
    for (const invalid of [['--help=false'], ['--session', 'selected-session'], ['--format=xml', '--help'],
      ['--approve', '--no-approve'], ['--output=a.json', '--output=b.json'], ['--unknown', '--help'],
      ['--approve=false'], ['--extension', 'evil.mjs'], ['--help', '-h'], ['--session=']]) {
      expect(await invoke(['export', ...invalid])).toMatchObject({ code: 2, signal: null, stdout: '', stderr: 'Export usage error. Run "ai-harness export --help".\n' });
    }
    await expect(readFile(path.join(cwd, 'extension-ran'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(cwd, 'command-ran'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(agent)).toEqual([]);
  }, 30_000);

  it.each(['html', 'jsonl', 'json', 'markdown'])('publishes real %s bytes privately, with copied redaction and unchanged source', async format => {
    const before = await readFile(source);
    const result = await invoke(args(format));
    expect(result).toEqual({ code: 0, signal: null, stdout: 'Session export published.\n', stderr: '' });
    expect(result.stdout).not.toContain('<private-title>');
    const output = path.join(cwd, `out.${format === 'markdown' ? 'md' : format}`);
    const bytes = await readFile(output, 'utf8');
    expect(bytes).not.toContain(secret); expect(bytes).toContain('[REDACTED]');
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    if (format === 'html') {
      expect(bytes).toContain('<!doctype html>'); expect(bytes).toContain('&lt;script&gt;');
      expect(bytes).not.toContain('<img src=x'); expect(bytes).toContain('&lt;img src=x');
    } else if (format === 'jsonl') {
      const lines = bytes.trim().split('\n').map(line => JSON.parse(line));
      expect(lines).toHaveLength(2); expect(lines[0]).toMatchObject({ id: 'm1', role: 'user', timestamp: '2025-01-01T00:00:00.000Z' });
      expect(lines[1].name).toBe('<img src=x onerror=bad()>'); expect(lines[0]).not.toHaveProperty('type');
    } else if (format === 'json') {
      const data = JSON.parse(bytes); expect(data.id).toBe('selected-session'); expect(data.messages).toHaveLength(2);
      expect(data.providerConfig).not.toHaveProperty('apiKey'); expect(data.metadata.secretCopy).toBe('[REDACTED]');
    } else expect(bytes).toContain('**You**');
    expect(await readFile(source)).toEqual(before);
    expect((await readdir(cwd)).filter(name => /staging|command-ran|extension-ran/.test(name))).toEqual([]);
  });

  it('redacts stored-only credentials using genuine encrypted Core state without refresh or commands', async () => {
    const master = 'disposable-export-master-key-at-least-32-bytes';
    const stored = 'disposable-stored-only-token-918';
    const service = new ProviderCredentialService({ store: new EncryptedCredentialStore(path.join(agent, 'credentials.enc'), master) });
    await service.load(); await service.setOAuth('openai', { accessToken: stored, refreshToken: 'disposable-stored-refresh', expiresAt: 1 });
    await writeFile(source, (await readFile(source, 'utf8')).replaceAll(secret, stored));
    const before = await readFile(source);
    const result = await invoke(args('json'), { OPENAI_API_KEY: '', AI_HARNESS_MASTER_KEY: master });
    expect(result).toEqual({ code: 0, signal: null, stdout: 'Session export published.\n', stderr: '' });
    const output = await readFile(path.join(cwd, 'out.json'), 'utf8');
    expect(output).not.toContain(stored); expect(output).toContain('[REDACTED]');
    expect(await readFile(source)).toEqual(before);
    await expect(readFile(path.join(cwd, 'command-ran'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('exports a confined workspace path without a default store and honors the explicit storage root', async () => {
    const copy = path.join(cwd, 'workspace-session.jsonl'); await writeFile(copy, await readFile(source));
    await rm(sessions, { recursive: true });
    expect(await invoke(args('json', copy))).toMatchObject({ code: 0, signal: null });
    const explicit = args('json', 'workspace-session'); explicit.push('--session-dir', cwd);
    expect(await invoke(explicit)).toMatchObject({ code: 0, signal: null });
  });

  it('selects exact IDs, unique prefixes and confined paths without creating sessions', async () => {
    for (const selector of ['selected-session', 'selected', source]) expect(await invoke(args('json', selector))).toMatchObject({ code: 0, signal: null });
    expect(await readdir(sessions)).toEqual(['selected-session.jsonl']);
    await writeFile(path.join(sessions, 'selected-other.jsonl'), await readFile(source));
    expect(await invoke(args('json', 'selected'))).toMatchObject({ code: 1, stdout: '', stderr: 'Export selection failed: no unique session.\n' });
    expect(await invoke(args('json', 'missing'))).toMatchObject({ code: 1, stdout: '' });
    expect(await invoke(args('json', 'selected-session'))).toMatchObject({ code: 0 });
  });

  it('requires explicit/saved trust and respects an explicit refusal without output', async () => {
    const noApproval = args().filter(arg => arg !== '--approve');
    expect(await invoke(noApproval)).toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('Export refused') });
    await writeFile(path.join(agent, 'trust.json'), JSON.stringify({ version: 2, decisions: { [cwd]: true } }));
    expect(await invoke(noApproval)).toMatchObject({ code: 0, signal: null });
    expect(await invoke([...noApproval, '--no-approve'])).toMatchObject({ code: 1, stdout: '' });
  });

  it('refuses outside-root input/output and never replaces the source', async () => {
    const outside = path.join(root, 'private.jsonl'); await writeFile(outside, await readFile(source));
    const before = await readFile(source);
    for (const bad of [args('json', outside), args('json', 'selected-session', path.join(root, 'outside.json')), args('jsonl', source, source)]) {
      expect(await invoke(bad)).toMatchObject({ code: 1, signal: null, stdout: '' });
    }
    expect(await readFile(source)).toEqual(before);
    await expect(readFile(path.join(root, 'outside.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses linked input files, input parents and output targets/parents/hardlinks', async () => {
    await symlink(source, path.join(sessions, 'linked.jsonl'));
    await symlink(sessions, path.join(cwd, 'linked-parent'));
    const sentinel = path.join(cwd, 'sentinel.json'); await writeFile(sentinel, 'untouched');
    await symlink(sentinel, path.join(cwd, 'linked.json'));
    await link(sentinel, path.join(cwd, 'hard.json'));
    await mkdir(path.join(cwd, 'real-parent')); await symlink(path.join(cwd, 'real-parent'), path.join(cwd, 'output-parent'));
    for (const bad of [args('json', path.join(sessions, 'linked.jsonl')), args('json', 'linked-parent/selected-session.jsonl'),
      args('json', 'selected-session', 'linked.json'), args('json', 'selected-session', 'hard.json'), args('json', 'selected-session', 'output-parent/out.json')]) {
      expect(await invoke(bad)).toMatchObject({ code: 1, signal: null, stdout: '' });
    }
    expect(await readFile(sentinel, 'utf8')).toBe('untouched'); expect(await readdir(path.join(cwd, 'real-parent'))).toEqual([]);
  });

  it('atomically replaces a regular output and refuses failed publication with no success or staging', async () => {
    const output = path.join(cwd, 'out.json'); await writeFile(output, 'old', { mode: 0o644 });
    const oldInode = (await stat(output)).ino;
    expect(await invoke(args())).toMatchObject({ code: 0, signal: null });
    expect((await stat(output)).ino).not.toBe(oldInode); expect((await stat(output)).mode & 0o777).toBe(0o600);
    await mkdir(path.join(cwd, 'directory.json'));
    const result = await invoke(args('json', 'selected-session', 'directory.json'));
    expect(result).toMatchObject({ code: 1, signal: null, stdout: '', stderr: 'Export failed; no success confirmed. Check the selected output file.\n' });
    expect((await stat(path.join(cwd, 'directory.json'))).isDirectory()).toBe(true);
    expect((await readdir(cwd)).filter(name => name.includes('staging'))).toEqual([]);
  });
});
