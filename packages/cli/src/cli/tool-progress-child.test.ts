import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const entry = fileURLToPath(new URL('../index.ts', import.meta.url));
const tsx = createRequire(import.meta.url).resolve('tsx');
interface RecordEntry { type: string; [key: string]: any }

async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aih-generic-progress-'));
  const extension = path.join(cwd, 'progress.mjs');
  await writeFile(extension, `
    import { writeFile, access } from 'node:fs/promises';
    export default api => {
      api.registerTool({ name: 'arbitrary_work', description: 'Arbitrary progress',
        execute: async (_input, context, signal) => {
          await context.onProgress({ version: 1, content: 'incremental:😀:first',
            details: { stage: 'first', usage: { totalTokens: 999, costUsd: 99 }, codemode: { store: { bad: true } }, activatedTools: ['hidden'] } });
          signal?.addEventListener('abort', () => { void writeFile(process.env.PROGRESS_ABORTED, 'aborted'); }, { once: true });
          await writeFile(process.env.PROGRESS_STARTED, 'started');
          while (true) { try { await access(process.env.PROGRESS_RELEASE); break; } catch {} await new Promise(resolve => setTimeout(resolve, 5)); }
          if (signal?.aborted) {
            await context.onProgress({ version: 1, content: 'late after abort' });
            return { content: 'late result' };
          }
          await context.onProgress({ version: 1, content: 'incremental:😀:second', details: { stage: 'second' } });
          if (process.env.PROGRESS_FAIL === '1') throw new Error('arbitrary failure');
          const late = context.onProgress;
          setTimeout(() => { void late({ version: 1, content: 'late after completion' }); }, 0);
          return { content: 'tool result' };
        } });
      api.registerProvider('progress', { defaultConfig: { model: 'progress-model' }, create(config) {
        return { config, validateConfig() { return true; }, getProviderType() { return 'progress'; },
          getConfiguredModel() { return config.model; }, setConfiguredModel(model) { config.model = model; },
          async chat() { return { content: 'unused' }; },
          async streamChat(messages, _chunk, complete, _error, options) {
            if (options.tools.map(tool => tool.name).join(',') !== 'arbitrary_work') throw new Error('Declaration set changed');
            complete(messages.some(message => message.role === 'tool') ? { content: 'final answer' } : {
              content: '', toolCalls: [{ id: 'outer-child', name: 'arbitrary_work', input: {} }] });
          } };
      } });
    };
  `);
  return { cwd, extension, started: path.join(cwd, 'started'), release: path.join(cwd, 'release'), sessionDir: path.join(cwd, 'sessions') };
}

async function exercise(mode: 'json' | 'print' | 'rpc', outcome: 'success' | 'failure' | 'cancel' = 'success') {
  const f = await fixture();
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    child = spawn(process.execPath, ['--import', tsx, entry,
      ...(mode === 'print' ? ['--print'] : ['--mode', mode]), '--approve', '--extension', f.extension,
      '--provider', 'progress', '--model', 'progress-model', '--tools', 'arbitrary_work',
      '--session-id', 'progress-child', '--session-dir', f.sessionDir, ...(mode === 'rpc' ? [] : ['work'])], {
      cwd: f.cwd, env: { ...process.env, HOME: path.join(f.cwd, 'home'), AI_HARNESS_AGENT_DIR: path.join(f.cwd, 'agent'),
        AI_HARNESS_DEFAULT_PROVIDER: '', NO_COLOR: '1', NODE_NO_WARNINGS: '1',
        PROGRESS_STARTED: f.started, PROGRESS_RELEASE: f.release, PROGRESS_ABORTED: path.join(f.cwd, 'aborted'),
        PROGRESS_FAIL: outcome === 'failure' ? '1' : '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = ''; let lineBuffer = '';
    const records: RecordEntry[] = [];
    let requestedReplay = false;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      if (mode === 'print') return;
      lineBuffer += chunk;
      let newline: number;
      while ((newline = lineBuffer.indexOf('\n')) >= 0) {
        const line = lineBuffer.slice(0, newline); lineBuffer = lineBuffer.slice(newline + 1);
        records.push(JSON.parse(line) as RecordEntry);
      }
      if (mode === 'rpc' && !requestedReplay && records.some(record => record.type === 'agent_settled')) {
        requestedReplay = true;
        child!.stdin.end('{"type":"get_messages","id":"replay"}\n');
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const closed = new Promise<number | null>((resolve, reject) => {
      child!.once('error', reject); child!.once('close', resolve);
    });
    if (mode === 'rpc') child.stdin.write('{"type":"prompt","id":"prompt","message":"work"}\n');
    else child.stdin.end();
    await vi.waitFor(async () => expect(await readFile(f.started, 'utf8')).toBe('started'), { timeout: 15_000 });
    if (mode === 'print') expect(stdout).toBe('');
    else {
      await vi.waitFor(() => expect(records.filter(record => record.type === 'tool_execution_update')).toHaveLength(1));
      const first = records.find(record => record.type === 'tool_execution_update')!;
      expect(first).toMatchObject({ toolCallId: 'outer-child', toolName: 'arbitrary_work', partialResult: {
        content: [{ type: 'text', text: 'incremental:😀:first' }], details: { toolProgress: {
          version: 1, sequence: 1, status: 'running', toolCallId: 'outer-child', toolName: 'arbitrary_work' } } } });
      expect(records.some(record => ['tool_execution_end', 'agent_settled'].includes(record.type))).toBe(false);
    }
    if (outcome === 'cancel') {
      child.stdin.write('{"type":"abort","id":"stop"}\n');
      await vi.waitFor(async () => expect(await readFile(path.join(f.cwd, 'aborted'), 'utf8')).toBe('aborted'));
      // RPC's existing abort response awaits actual cleanup, unlike detached HTTP acknowledgement.
      expect(records.some(record => record.type === 'response' && record.id === 'stop')).toBe(false);
      expect(records.some(record => record.type === 'agent_settled')).toBe(false);
    }
    await writeFile(f.release, 'release');
    expect(await closed, stderr).toBe(0);
    expect(stderr).toBe('');
    if (outcome === 'cancel') expect(records.find(record => record.type === 'response' && record.id === 'stop')).toMatchObject({ success: true });
    if (mode === 'print') expect(stdout).toBe('final answer\n');
    else {
      expect(lineBuffer).toBe('');
      const updates = records.filter(record => record.type === 'tool_execution_update');
      expect(updates.map(record => [record.toolCallId, record.partialResult.details.toolProgress.sequence,
        record.partialResult.content[0].text])).toEqual(outcome === 'cancel'
        ? [['outer-child', 1, 'incremental:😀:first']]
        : [['outer-child', 1, 'incremental:😀:first'], ['outer-child', 2, 'incremental:😀:second']]);
      const ends = records.filter(record => record.type === 'tool_execution_end');
      expect(ends).toHaveLength(1);
      expect(ends[0]).toMatchObject({ toolCallId: 'outer-child', isError: outcome !== 'success', result: { details: { toolProgress: {
        status: outcome === 'cancel' ? 'cancelled' : outcome === 'failure' ? 'failed' : 'completed',
        sequence: outcome === 'cancel' ? 2 : 3,
      } } } });
      expect(records.filter(record => record.type === 'tool_execution_start')).toHaveLength(1);
      expect(records.filter(record => record.type === 'agent_settled')).toHaveLength(1);
      expect(records.indexOf(ends[0]!)).toBeLessThan(records.findIndex(record => record.type === 'agent_settled'));
      if (mode === 'rpc') {
        const replay = records.find(record => record.type === 'response' && record.id === 'replay')!;
        expect(replay.success).toBe(true);
        const tools = replay.data.messages.filter((message: RecordEntry) => message.role === 'toolResult');
        expect(tools).toHaveLength(1);
        expect(tools[0].details.toolProgress).toEqual(ends[0]!.result.details.toolProgress);
      }
    }
    const entries = (await readFile(path.join(f.sessionDir, 'progress-child.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    const tools = entries.filter(entry => entry.role === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0].usage).toBeUndefined();
    expect(tools[0].metadata.codemode).toBeUndefined();
    expect(Object.keys(tools[0].metadata).sort()).toEqual(outcome === 'cancel' ? ['interrupted', 'toolProgress'] : ['toolProgress']);
    expect(tools[0].metadata.toolProgress).toMatchObject({ version: 1, toolCallId: 'outer-child',
      status: outcome === 'cancel' ? 'cancelled' : outcome === 'failure' ? 'failed' : 'completed' });
    expect(JSON.stringify(tools)).not.toContain('late after');
    if (mode !== 'print') expect(tools[0].metadata.toolProgress).toEqual(records.find(record => record.type === 'tool_execution_end')!.result.details.toolProgress);
    if (mode === 'rpc') {
      // A new process must hydrate the same terminal snapshot from the durable journal.
      const replayChild = spawn(process.execPath, ['--import', tsx, entry, '--mode', 'rpc',
        '--approve', '--extension', f.extension, '--provider', 'progress', '--model', 'progress-model',
        '--tools', 'arbitrary_work', '--session', path.join(f.sessionDir, 'progress-child.jsonl')], {
        cwd: f.cwd, env: { ...process.env, HOME: path.join(f.cwd, 'home'),
          AI_HARNESS_AGENT_DIR: path.join(f.cwd, 'agent'), NO_COLOR: '1', NODE_NO_WARNINGS: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let replayOutput = ''; let replayError = '';
      replayChild.stdout.setEncoding('utf8').on('data', (chunk: string) => { replayOutput += chunk; });
      replayChild.stderr.setEncoding('utf8').on('data', (chunk: string) => { replayError += chunk; });
      const replayClosed = new Promise<number | null>((resolve, reject) => {
        replayChild.once('error', reject); replayChild.once('close', resolve);
      });
      replayChild.stdin.end('{"type":"get_messages","id":"fresh-replay"}\n');
      expect(await replayClosed, replayError).toBe(0);
      expect(replayError).toBe('');
      const replayRecords = replayOutput.trimEnd().split('\n').map(line => JSON.parse(line));
      expect(replayRecords).toHaveLength(1);
      expect(replayRecords[0]).toMatchObject({ type: 'response', id: 'fresh-replay', success: true });
      const replayTools = replayRecords[0].data.messages.filter((message: RecordEntry) => message.role === 'toolResult');
      expect(replayTools).toHaveLength(1);
      expect(replayTools[0].details.toolProgress).toEqual(tools[0].metadata.toolProgress);
    }
  } finally {
    child?.kill('SIGKILL');
    await rm(f.cwd, { recursive: true, force: true });
  }
}

describe('real CLI arbitrary-tool incremental progress', () => {
  it.each(['print', 'json', 'rpc'] as const)('%s has real incremental/backpressured progress and durable final snapshots', async mode => {
    await exercise(mode);
  }, 30_000);
  it.each(['json', 'rpc'] as const)('%s emits/persists exactly one failure after partial progress', async mode => {
    await exercise(mode, 'failure');
  }, 30_000);
  it('RPC abort waits for durable settlement, then replays one cancelled result without late updates', async () => {
    await exercise('rpc', 'cancel');
  }, 30_000);
});
