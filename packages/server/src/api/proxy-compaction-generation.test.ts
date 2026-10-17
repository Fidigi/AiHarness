import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MockProvider, type ChatOptions, type ChatResponse } from '@ai-harness/core';
import { start, stop } from '../index.js';
import { createRuntimeServices } from '../runtime/services.js';
import type { AiProxyServer } from './proxy.js';

const seed = (large = false) => Array.from({ length: large ? 50 : 4 }, (_, index) => ({
  role: index % 2 ? 'assistant' as const : 'user' as const,
  content: large ? `${index}:` + 'p'.repeat(50_400) : `public-${index}`,
}));
const answer = (): ChatResponse => ({ content: 'COMPLETE_PROXY_SUMMARY', model: 'mock-model', usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } });

describe('real legacy proxy compaction completion evidence', () => {
  let root: string, base: string, proxy: AiProxyServer, failed = false;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'proxy-compaction-generation-'));
    const cwd = path.join(root, 'workspace'); await mkdir(cwd);
    const application = await start({ host: '127.0.0.1', port: 0, dataDir: path.join(root, 'data'), allowedRoots: [cwd], defaultCwd: cwd,
      enableMockProvider: true, runtimeServicesFactory: async (created, options) => { proxy = created; return createRuntimeServices(created, options); } });
    base = `http://127.0.0.1:${application.port}`;
    expect((await fetch(`${base}/api/sessions`)).status).toBe(200);
  });
  afterEach(context => { if (context.task.result?.state === 'fail') failed = true; vi.restoreAllMocks(); });
  afterAll(async () => { await stop(); if (!failed) await rm(root, { recursive: true, force: true }); else console.error('Retained proxy generation root:', root); });
  const request = (messages = seed(), options?: Record<string, unknown>) => fetch(`${base}/api/chat/compact`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'mock', messages, ...(options ? { options } : {}) }),
  });

  it.each(['valid', 'exact-output', 'length', 'tools', 'over-output', 'over-input'] as const)('bounds %s without false successful summaries and accounts settled work once', async kind => {
    const output = answer();
    if (kind === 'exact-output') output.content = 'a'.repeat(16_384);
    if (kind === 'over-output') output.content = 'a'.repeat(16_385);
    if (kind === 'length') output.stopReason = 'length';
    if (kind === 'tools') output.toolCalls = [{ id: 'pending', name: 'tool', input: {} }];
    const chat = vi.spyOn(MockProvider.prototype, 'chat').mockResolvedValue(output);
    const usage = vi.spyOn(proxy, 'recordUsage'), messages = seed(kind === 'over-input');
    if (kind === 'over-input') expect(Buffer.byteLength(JSON.stringify(messages))).toBeGreaterThan(2_000_000);
    const response = await request(messages), body = await response.json();
    const valid = kind === 'valid' || kind === 'exact-output';
    if (valid) { expect(response.status).toBe(200); expect(body).toEqual({ summary: output.content }); }
    else { expect(response.status).toBe(500); expect(body).toEqual({ error: 'Internal server error' }); }
    expect(chat).toHaveBeenCalledTimes(kind === 'over-input' ? 0 : 1);
    expect(usage).toHaveBeenCalledTimes(kind === 'over-input' ? 0 : 1);
  });

  it.each(['stopReason', 'toolCalls'])('does not execute replacement %s accessors before refusing incomplete evidence', async key => {
    let reads = 0; const output = answer();
    Object.defineProperty(output, key, { enumerable: true, get() { reads++; return undefined; } });
    vi.spyOn(MockProvider.prototype, 'chat').mockResolvedValue(output);
    const usage = vi.spyOn(proxy, 'recordUsage');
    const response = await request(); expect(response.status).toBe(500); expect(reads).toBe(0); expect(usage).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });

  it.each(['length', 'tools'] as const)('does not let response redaction erase captured %s refusal evidence', async kind => {
    const output = answer();
    if (kind === 'length') output.stopReason = 'length';
    else output.toolCalls = [{ id: 'pending', name: 'must_not_run', input: {} }];
    vi.spyOn(MockProvider.prototype, 'chat').mockResolvedValue(output);
    const usage = vi.spyOn(proxy, 'recordUsage'), redact = proxy.redactJson.bind(proxy);
    let omissions = 0;
    vi.spyOn(proxy, 'redactJson').mockImplementation(value => {
      if (value && typeof value === 'object' && Object.hasOwn(value, 'compactionSummaryValid')) {
        omissions++;
        Reflect.deleteProperty(value, 'compactionSummaryValid');
      }
      return redact(value);
    });
    const response = await request();
    expect(omissions).toBe(1);
    expect(usage).toHaveBeenCalledOnce();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });

  it('retains ordinary sendChat output and does not serialize private completion evidence', async () => {
    const output = answer(); output.stopReason = 'length'; output.content = 'ordinary '.repeat(2_000);
    vi.spyOn(MockProvider.prototype, 'chat').mockResolvedValue(output);
    const result = await proxy.sendChat('mock', seed().map((message, index) => ({ ...message, id: `ordinary-${index}`, timestamp: new Date() })), { stream: false });
    expect(result.content).toBe(output.content); expect(Object.keys(result).sort()).toEqual(['content', 'model', 'usage']);
    expect(JSON.stringify(result)).not.toContain('compactionSummaryValid');
  });

  it('owns the authentic request signal and tool-free output cap while honoring a smaller caller limit', async () => {
    let captured: ChatOptions | undefined;
    vi.spyOn(MockProvider.prototype, 'chat').mockImplementation(async (_messages, options) => { captured = options; return answer(); });
    expect((await request(seed(), { maxTokens: 19 })).status).toBe(200);
    expect(captured?.maxTokens).toBe(19); expect(captured?.tools).toEqual([]); expect(captured?.signal).toBeInstanceOf(AbortSignal);
    expect(captured?.signal?.aborted).toBe(false);
  });
});
