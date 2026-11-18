import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MockProvider, prepareCompactionContext, type Message } from '@ai-harness/core';
import { start, stop } from '../index.js';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.js';

let root: string, base: string, cwd: string, services: RuntimeServices;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'aih-summary-http-')); cwd = path.join(root, 'work'); await mkdir(cwd);
  const server = await start({ host: '127.0.0.1', port: 0, dataDir: path.join(root, 'agent'), allowedRoots: [cwd], defaultCwd: cwd,
    enableMockProvider: true, runtimeServicesFactory: async (proxy, options) => { services = await createRuntimeServices(proxy, options); return services; } });
  base = `http://127.0.0.1:${server.port}`;
  expect((await fetch(base + '/api/sessions')).status).toBe(200);
  services.sessionManager.setCompactionSettings({ enabled: false, keepRecentTokens: 0 });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
const source = (): Array<Omit<Message, 'id' | 'timestamp'>> => [
  { role: 'user', content: 'PUBLIC_USER' },
  { role: 'assistant', content: 'PUBLIC_ANSWER', blocks: [{ type: 'text', text: 'PUBLIC_RICH' }, { type: 'reasoning', text: 'PRIVATE_THINKING' }],
    toolCalls: [{ id: 'lookup', name: 'lookup', input: { reasoning: 'PUBLIC_TOOL_REASONING', signature: 'PUBLIC_TOOL_SIGNATURE' } }], metadata: { signature: 'PRIVATE_SIGNATURE' } },
  { role: 'tool', toolCallId: 'lookup', name: 'lookup', content: 'PUBLIC_RESULT' },
  { role: 'assistant', content: 'PUBLIC_DONE' },
  { role: 'user', content: 'RETAINED_USER' },
  { role: 'assistant', content: 'RETAINED_ASSISTANT' },
];
async function compact(messages = source()) {
  const session = await services.sessionManager.create({ cwd, autoCompaction: false });
  for (const message of messages) await services.sessionManager.addMessage(session.id, message, { skipAutoCompaction: true });
  const canonicalBytes = Buffer.byteLength(JSON.stringify(prepareCompactionContext(services.sessionManager, session.id)!.toCompact));
  const response = await fetch(`${base}/api/agent/sessions/${session.id}/compact`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'mock' }) });
  return { response, canonicalBytes };
}

it('the owning manual agent summary preserves public tool traces and rich text, never private replay', async () => {
  let captured: Message[] = [];
  const chat = vi.spyOn(MockProvider.prototype, 'chat').mockImplementation(async (messages, options) => {
    captured = structuredClone(messages); expect(options?.tools).toEqual([]);
    expect(options?.maxTokens).toBe(4096); expect(options?.signal).toBeInstanceOf(AbortSignal);
    return { content: 'PUBLIC_SUMMARY' };
  });
  const { response } = await compact();
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ summary: 'PUBLIC_SUMMARY' }); expect(chat).toHaveBeenCalledOnce();
  const text = JSON.stringify(captured);
  for (const marker of ['PUBLIC_USER', 'PUBLIC_ANSWER', 'PUBLIC_RICH', 'PUBLIC_TOOL_REASONING', 'PUBLIC_TOOL_SIGNATURE', 'PUBLIC_RESULT']) expect(text).toContain(marker);
  expect(text).not.toContain('PRIVATE_'); expect(text).not.toContain('RETAINED_ASSISTANT');
  expect(captured[1].toolCalls?.[0].input).toEqual({ reasoning: 'PUBLIC_TOOL_REASONING', signature: 'PUBLIC_TOOL_SIGNATURE' });
});

it('retains the canonical two-million-byte ceiling before stripping oversized private metadata', async () => {
  // Individual strings must survive the existing redactor bounds before the API sees them.
  const messages = Array.from({ length: 50 }, (_, index) => ({
    role: index % 2 ? 'assistant' as const : 'user' as const, content: `public-${index}`,
    metadata: { signature: 'x'.repeat(50_400) },
  }));
  const chat = vi.spyOn(MockProvider.prototype, 'chat');
  const { response, canonicalBytes } = await compact(messages);
  expect(canonicalBytes).toBeGreaterThan(2_000_000);
  expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: 'Internal server error' }); expect(chat).not.toHaveBeenCalled();
});
