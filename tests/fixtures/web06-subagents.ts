import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getProxy, start, stop } from '../../packages/server/dist/index.js';
import type { ChatOptions, Message } from '@ai-harness/core';

/** Script only the local MockProvider. HTTP, auth, trust, tools, MCP and journals remain real. */
export async function subagentServer() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-web06-'));
  const cwd = path.join(root, 'project'), data = path.join(root, 'data');
  await mkdir(path.join(cwd, '.ai-harness/extensions'), { recursive: true });
  await mkdir(data);
  await writeFile(path.join(cwd, 'AGENTS.md'), 'Explicit disposable child-runtime trust.');
  const peer = path.resolve('packages/core/src/mcp/fixtures/test-server.mjs');
  const calls = path.join(root, 'mcp-calls.jsonl'), starts = path.join(root, 'mcp-starts.jsonl');
  const wrapper = path.join(root, 'mcp-peer.mjs');
  await writeFile(wrapper, `import {appendFileSync} from 'node:fs'; import {pathToFileURL} from 'node:url'; appendFileSync(${JSON.stringify(starts)},String(process.pid)+'\\n'); await import(pathToFileURL(${JSON.stringify(peer)}).href);`);
  await writeFile(path.join(data, 'mcp.json'), JSON.stringify({ mcpServers: { reviewed: {
    command: process.execPath, args: [wrapper], env: { MCP_TEST_CALL_LOG: calls }, exposure: 'direct',
  } } }));
  await writeFile(path.join(cwd, '.ai-harness/extensions/web06.mjs'), `export default api => {
    const waiting = new Map();
    api.registerTool({name:'wait_child',description:'Hold a disposable child until release or stop',parameters:{type:'object'},
      execute:async (_input,ctx,signal) => new Promise(resolve => {
        const done=()=>{signal?.removeEventListener('abort',done);waiting.delete(ctx.currentSessionId);resolve({content:'CHILD_RELEASED'});};
        waiting.set(ctx.currentSessionId,done);signal?.addEventListener('abort',done,{once:true});if(signal?.aborted)done();
      })});
    api.registerCommand('release-child',{description:'Release the held local child',handler:args=>{waiting.get(args.trim())?.();return 'RELEASED';}});
  };`);
  const names = ['AI_HARNESS_AUTH_TOKEN', 'AI_HARNESS_ADMIN_TOKEN', 'AI_HARNESS_AGENT_DIR'] as const;
  const previous = names.map(name => process.env[name]);
  const admin = 'web06-disposable-admin', user = 'web06-disposable-user';
  process.env.AI_HARNESS_AUTH_TOKEN = user; process.env.AI_HARNESS_ADMIN_TOKEN = admin;
  process.env.AI_HARNESS_AGENT_DIR = path.join(root, 'agent');
  let base = '';
  const frames: Array<{ sessionId?: string; input: string; tools: string[]; child: boolean }> = [];
  const boot = async () => {
    const server = await start({ port: 0, host: '127.0.0.1', dataDir: data, defaultCwd: cwd, allowedRoots: [root],
      webRoot: path.resolve('packages/web/dist'), enableMockProvider: true });
    base = `http://127.0.0.1:${server.port}`;
    const provider = getProxy().getAgentProvider('mock')!;
    provider.streamChat = async (messages: Message[], _chunk, complete, error, options?: ChatOptions) => {
      const index = messages.findLastIndex(message => message.role === 'user');
      const input = messages[index]?.content ?? '';
      const result = messages.slice(index + 1).findLast(message => message.role === 'tool');
      const child = Boolean(options?.systemPrompt?.includes('child agent.'));
      const tools = (options?.tools ?? []).map(tool => tool.name);
      frames.push({ sessionId: options?.sessionId, input, tools, child });
      if (input === 'child:fail') { error?.(Object.assign(new Error('Disposable child failure'), { status: 400 })); return; }
      if (!result && input.startsWith('delegate:')) {
        const background = input === 'delegate:background';
        complete?.({ content: '', toolCalls: [{ id: crypto.randomUUID(), name: 'spawn_subagent', input: {
          profile: 'general', task: background || input === 'delegate:sync-held' ? 'child:hold' : 'child:done', background,
        } }] }); return;
      }
      const name = input === 'child:hold' ? 'wait_child' : input === 'child:lookup'
        ? tools.find(tool => tool.includes('lookup')) : input === 'child:attack' ? 'write' : undefined;
      if (!result && name) {
        complete?.({ content: '', toolCalls: [{ id: crypto.randomUUID(), name, input: name === 'write'
          ? { path: path.join(cwd, 'forbidden.txt'), content: 'must not be written' } : {} }] }); return;
      }
      complete?.({ content: `${child ? 'CHILD_RESULT_é😀' : 'PARENT_RESULT'}${result ? ':' + result.content : ''}` });
    };
  };
  const request = (url: string, method = 'GET', body?: unknown, token = admin, origin = base) => fetch(base + url, {
    method, headers: { Authorization: `Bearer ${token}`, Origin: origin, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
  });
  const close = async () => {
    try { await stop(); await rm(root, { recursive: true, force: true }); }
    finally { names.forEach((name, index) => previous[index] === undefined ? delete process.env[name] : process.env[name] = previous[index]); }
  };
  try { await boot(); }
  catch (error) { await close(); throw error; }
  return { root, cwd, data, admin, user, frames, request, close, base: () => base,
    restart: async () => { await stop(); await boot(); },
    calls: async () => (await readFile(calls, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean),
    starts: async () => (await readFile(starts, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean),
    trustAndLoad: async () => {
      const trusted = await request('/api/workspaces/trust', 'POST', { cwd, confirm: true });
      if (!trusted.ok) throw new Error('Fixture trust refused');
      const loaded = await request('/api/agent/reload', 'POST', { cwd }).then(response => response.json());
      if (loaded.errors?.length || !loaded.loadedExtensions?.length) throw new Error('Fixture extension not loaded');
    },
  };
}
