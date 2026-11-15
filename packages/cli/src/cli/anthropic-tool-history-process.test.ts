import { spawn } from 'node:child_process';
import { createServer } from 'node:https';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { createLocalTLSFixture } from './fixtures/oauth-local-tls.mjs';
const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url)), model = 'claude-opus-5';
it('keeps native initial declarations and loadout deltas across CLI restart/offline without restoring removed executable tools', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-tool-history-cli-')), cwd = path.join(root, 'work'), home = path.join(root, 'home'), agent = path.join(root, 'agent'), sessions = path.join(root, 'sessions'), extension = path.join(root, 'tools.mjs'), effects = path.join(root, 'effects.txt');
  await mkdir(cwd); await mkdir(home); await mkdir(agent); await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ cacheWarming: 'off' }));
  const parameters = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }, initial = [{ name: 'history_lookup', description: 'Original lookup', parameters }, { name: 'history_retired', description: 'Retired implementation', parameters }], latest = [{ name: 'history_lookup', description: 'Replacement lookup', parameters }, { name: 'history_added', description: 'New implementation', parameters }];
  const bodies: Array<Record<string, any>> = []; let failure: unknown;
  const server = createServer(await createLocalTLSFixture(root), async (request, response) => {
    try {
      expect(request.url).toBe('/native/v1/messages'); expect(request.headers['x-api-key']).toBe('synthetic-tool-history-cli-key'); expect(request.headers.authorization).toBeUndefined(); expect(request.headers['anthropic-beta']).toContain('inline-tools-2026-09-15');
      let text = ''; for await (const chunk of request) { text += chunk; expect(Buffer.byteLength(text)).toBeLessThan(2000000); } const body = JSON.parse(text); bodies.push(body); const count = bodies.length; expect(body.model).toBe(model);
      expect(body.tools.map((tool: { name: string }) => tool.name)).toEqual(['history_lookup', 'history_retired', '__pi_deferred_placeholder__']); expect(body.tools).toEqual(bodies[0].tools); expect(body.tools[2]).toMatchObject({ defer_loading: true });
      const updates = body.messages.filter((row: Record<string, any>) => Array.isArray(row.content) && row.content.some((block: Record<string, any>) => ['tool_addition', 'tool_removal'].includes(block.type)));
      if (count < 3) expect(updates).toHaveLength(0);
      else { expect(updates).toHaveLength(1); expect(updates[0].content[0]).toEqual({ type: 'tool_removal', tool: { type: 'tool_reference', name: 'history_retired' } }); expect(updates[0].content.slice(1).map((block: Record<string, any>) => [block.type, block.tool.definition.name, block.tool.definition.description])).toEqual(latest.map(tool => ['tool_addition', tool.name, tool.description])); if (count === 3) expect(updates[0].content.at(-1).cache_control).toEqual({ type: 'ephemeral' }); }
      const results = body.messages.flatMap((row: Record<string, any>) => row.content ?? []).filter((block: Record<string, any>) => block.type === 'tool_result');
      if (count >= 4) { const denied = results.find((block: Record<string, any>) => block.tool_use_id === 'retired-call'); expect(denied).toMatchObject({ is_error: true }); expect(JSON.stringify(denied.content)).toContain('history_retired'); expect(await readFile(effects, 'utf8')).not.toContain('history_retired'); }
      if (count >= 5) expect(JSON.stringify(results.find((block: Record<string, any>) => block.tool_use_id === 'added-call')?.content)).toContain('version-2-result');
      const call = count === 1 ? { id: 'lookup-call', name: 'history_lookup' } : count === 3 ? { id: 'retired-call', name: 'history_retired' } : count === 4 ? { id: 'added-call', name: 'history_added' } : undefined;
      response.setHeader('content-type', 'text/event-stream'); response.end([{ type: 'message_start', message: { id: 'native-history-' + count, type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 8, output_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: call ? { type: 'tool_use', ...call, input: {} } : { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: call ? { type: 'input_json_delta', partial_json: '{"value":"synthetic"}' } : { type: 'text_delta', text: 'native-tool-history-cli-ok' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
    } catch (error) { failure ??= error; response.statusCode = 500; response.end('Invalid synthetic tool history fixture'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const endpoint = `https://127.0.0.1:${(server.address() as { port: number }).port}/native`;
  const launch = (offline: boolean) => new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-maglev', cli, '--approve', '--no-extensions', '-e', extension, '--no-context-files', '--session-dir', sessions, '--session-id', 'tool-history', '--model', 'anthropic/' + model, '--thinking', 'high', ...(offline ? ['--offline'] : []), '--mode', 'json', 'probe'], { cwd, env: { PATH: process.env.PATH, HOME: home, TMPDIR: root, NO_COLOR: '1', AI_HARNESS_AGENT_DIR: agent, AI_HARNESS_MASTER_KEY: 'synthetic-tool-history-master', NODE_EXTRA_CA_CERTS: path.join(root, 'cert.pem'), ANTHROPIC_API_KEY: 'synthetic-tool-history-cli-key', ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_MODEL: model }, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += String(value); }); child.stderr.on('data', value => { stderr += String(value); }); const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Native tool history child hung')); }, 20000); child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
  try {
    const outputs: string[] = [];
    for (const version of [1, 2, 2]) {
      const definitions = version === 1 ? initial : latest;
      await writeFile(extension, `import{appendFileSync}from'node:fs';export default api=>{const tools=${JSON.stringify(definitions)};for(const tool of tools)api.registerTool({...tool,execute:()=>{appendFileSync(${JSON.stringify(effects)},${JSON.stringify('version-' + version + ':')}+tool.name+'\\n');return{content:${JSON.stringify('version-' + version + '-result')}}}});api.before('before:provider',data=>({...data,options:{...data.options,tools:data.options.tools.filter(tool=>tools.some(current=>current.name===tool.name))}}));};`);
      const result = await launch(outputs.length === 2); expect(failure).toBeUndefined(); expect(result, result.stderr).toMatchObject({ code: 0, signal: null }); expect(result.stdout).toContain('native-tool-history-cli-ok'); outputs.push(result.stdout + result.stderr);
    }
    expect(bodies).toHaveLength(6); expect(await readFile(effects, 'utf8')).toBe('version-1:history_lookup\nversion-2:history_added\n');
    const file = path.join(sessions, 'tool-history.jsonl'), journal = await readFile(file, 'utf8'), entries = journal.trim().split('\n').map(line => JSON.parse(line)), assistants = entries.filter(entry => entry.type === 'message' && entry.role === 'assistant');
    expect(assistants).toHaveLength(6); expect(assistants.reduce((sum, entry) => sum + entry.usage.totalTokens, 0)).toBe(60); expect(assistants.reduce((sum, entry) => sum + entry.usage.costUsd, 0)).toBeCloseTo(0.00054, 12); expect(entries.filter(entry => entry.type === 'loadout').at(-1).changes.tools).toEqual(latest); expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(outputs.join('') + journal).not.toContain('synthetic-tool-history-cli-key'); expect(outputs.join('') + journal).not.toContain('synthetic-tool-history-master');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}, 30000);
