import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('exposes replay, presentation, updates, abort, and EOF through the emitted RPC executable', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-rpc-ui-process-'));
  const agentDir = await mkdtemp(path.join(os.tmpdir(), 'aih-rpc-ui-agent-'));
  const extension = path.join(cwd, 'ui.mjs');
  await writeFile(extension, `
    export default api => {
      let handle;
      api.registerCommand('ui-open', { description: 'Open', handler: async (_args, ctx) => {
        if (ctx.ui.mode !== 'rpc' || ctx.ui.capabilities.custom !== false) throw new Error('Wrong capabilities');
        ctx.ui.setStatus('build', 'running');
        ctx.ui.setWidget('summary', ['plain <b>text</b>']);
        ctx.ui.setTitle('owned title');
        ctx.ui.setEditorText('draft only');
        ctx.notify('attention once');
        handle = ctx.requestInteraction({ kind: 'select', title: 'First', options: [{ label: 'Old', value: 'old' }] });
        const response = await handle;
        return JSON.stringify(response);
      }});
      api.registerCommand('ui-update', { description: 'Update', handler: () => {
        if (!handle.update({ kind: 'select', title: 'Replacement', options: [{ label: 'New', value: 'new' }] })) throw new Error('Update refused');
      }});
    };
  `);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../dist/index.js', import.meta.url)),
    '--approve', '--extension', extension, '--mode', 'rpc', '--no-session', '--model', 'mock/mock-model'], {
    cwd, env: { ...process.env, HOME: path.join(cwd, 'home'), AI_HARNESS_AGENT_DIR: agentDir, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  let buffer = '';
  const records: Record<string, unknown>[] = [];
  const waiters = new Set<() => void>();
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      records.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
      buffer = buffer.slice(newline + 1);
      for (const waiter of waiters) waiter();
    }
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const wait = (matches: (record: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`RPC UI timeout: ${stderr}`)); }, 10_000);
    const check = (): void => {
      const found = records.find(matches);
      if (found) { clearTimeout(timer); waiters.delete(check); resolve(found); }
    };
    waiters.add(check);
    check();
  });
  const send = (record: Record<string, unknown>): void => { child.stdin.write(JSON.stringify(record) + '\n'); };
  const command = async (type: string, id: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    send({ type, id, ...extra });
    return wait(record => record.type === 'response' && record.id === id);
  };
  try {
    send({ type: 'prompt', id: 'open', message: '/ui-open' });
    const first = await wait(record => record.method === 'select' && record.title === 'First');
    const replay = await command('get_extension_ui', 'replay');
    expect(replay).toMatchObject({ success: true, data: {
      version: 1, mode: 'rpc', requests: [{ id: first.id, title: 'First' }],
      presentation: [
        { method: 'setStatus', value: 'running' }, { method: 'setWidget', value: ['plain <b>text</b>'] },
        { method: 'setTitle', value: 'owned title' }, { method: 'setEditorText', value: 'draft only' },
      ],
    } });
    expect(await command('get_extension_ui', 'invalid', { unknown: true })).toMatchObject({ success: false });
    expect(await command('prompt', 'update', { message: '/ui-update' })).toMatchObject({ success: true });
    expect(await wait(record => record.method === 'select' && record.title === 'Replacement')).toMatchObject({ id: first.id });
    send({ type: 'extension_ui_response', id: first.id, value: 'Old' });
    expect(await command('get_extension_ui', 'still-pending')).toMatchObject({ data: { requests: [{ id: first.id, title: 'Replacement' }] } });
    send({ type: 'extension_ui_response', id: first.id, value: 'New' });
    expect(await wait(record => record.type === 'response' && record.id === 'open')).toMatchObject({ success: true });
    expect(await command('get_extension_ui', 'settled')).toMatchObject({ data: { requests: [] } });
    // The controller also notifies the command's returned string; replay must not repeat either.
    expect(records.filter(record => record.method === 'notify').map(record => record.message)).toEqual([
      'attention once', '{"cancelled":false,"value":"new"}',
    ]);

    send({ type: 'prompt', id: 'abort-open', message: '/ui-open' });
    // Wait for a fresh host ID rather than matching the first dialog's history.
    const second = await wait(record => record.method === 'select' && record.title === 'First' && record.id !== first.id);
    expect(await command('abort', 'abort')).toMatchObject({ success: true });
    expect(await wait(record => record.type === 'extension_ui_closed' && record.id === second.id)).toMatchObject({ reason: 'aborted' });
    expect(await wait(record => record.type === 'response' && record.id === 'abort-open')).toMatchObject({ success: true });

    send({ type: 'prompt', id: 'session-open', message: '/ui-open' });
    const third = await wait(record => record.method === 'select' && record.title === 'First' && record.id !== first.id && record.id !== second.id);
    expect(await command('new_session', 'new-session')).toMatchObject({ success: true });
    expect(await wait(record => record.type === 'extension_ui_closed' && record.id === third.id)).toMatchObject({ reason: 'session-changed' });
    expect(await wait(record => record.type === 'response' && record.id === 'session-open')).toMatchObject({ success: true });

    send({ type: 'prompt', id: 'eof-open', message: '/ui-open' });
    const fourth = await wait(record => record.method === 'select' && record.title === 'First' && ![first.id, second.id, third.id].includes(record.id));
    child.stdin.end();
    expect(await closed, stderr).toEqual({ code: 0, signal: null });
    expect(records).toContainEqual({ type: 'extension_ui_closed', id: fourth.id, reason: 'shutdown' });
    expect(records).toContainEqual(expect.objectContaining({ type: 'response', id: 'eof-open', success: true }));
    expect(buffer).toBe('');
    expect(stderr).not.toContain('Wrong capabilities');
  } finally {
    child.kill('SIGKILL');
    await closed;
    await Promise.all([cwd, agentDir].map(directory => rm(directory, { recursive: true, force: true })));
  }
}, 40_000);
