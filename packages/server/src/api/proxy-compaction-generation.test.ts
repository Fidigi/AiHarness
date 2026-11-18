import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockProvider, type ChatOptions, type ChatResponse } from '@ai-harness/core';
import { AiProxyServer } from './proxy.js';

const seed = () => Array.from({ length: 4 }, (_, index) => ({
  id: `embedding-${index}`, timestamp: new Date(0),
  role: index % 2 ? 'assistant' as const : 'user' as const, content: `public-${index}`,
}));
const answer = (): ChatResponse => ({ content: 'COMPLETE_PROXY_SUMMARY', model: 'mock-model', usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } });

describe('direct embedding proxy completion evidence (no retired HTTP adapter)', () => {
  let proxy: AiProxyServer;
  beforeEach(() => { proxy = new AiProxyServer({ enableMockProvider: true }); });
  afterEach(() => { vi.restoreAllMocks(); });
  const summarize = () => proxy.sendChat('mock', seed(), { stream: false, tools: [] }, undefined, true);

  it.each(['valid', 'exact-output', 'length', 'tools', 'over-output'] as const)('bounds %s without false successful summaries and accounts settled work once', async kind => {
    const output = answer();
    if (kind === 'exact-output') output.content = 'a'.repeat(16_384);
    if (kind === 'over-output') output.content = 'a'.repeat(16_385);
    if (kind === 'length') output.stopReason = 'length';
    if (kind === 'tools') output.toolCalls = [{ id: 'pending', name: 'tool', input: {} }];
    const chat = vi.spyOn(MockProvider.prototype, 'chat').mockResolvedValue(output);
    const usage = vi.spyOn(proxy, 'recordUsage');
    if (kind === 'valid' || kind === 'exact-output') await expect(summarize()).resolves.toMatchObject({ content: output.content });
    else await expect(summarize()).rejects.toThrow('Compaction did not produce a complete bounded text summary.');
    expect(chat).toHaveBeenCalledOnce();
    expect(usage).toHaveBeenCalledOnce();
  });

  it.each(['stopReason', 'toolCalls'])('does not execute replacement %s accessors before refusing incomplete evidence', async key => {
    let reads = 0; const output = answer();
    Object.defineProperty(output, key, { enumerable: true, get() { reads++; return undefined; } });
    vi.spyOn(MockProvider.prototype, 'chat').mockResolvedValue(output);
    const usage = vi.spyOn(proxy, 'recordUsage');
    await expect(summarize()).rejects.toThrow('Compaction did not produce a complete bounded text summary.');
    expect(reads).toBe(0); expect(usage).toHaveBeenCalledOnce();
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
    await expect(summarize()).rejects.toThrow('Compaction did not produce a complete bounded text summary.');
    expect(omissions).toBe(1);
    expect(usage).toHaveBeenCalledOnce();
  });

  it('retains ordinary sendChat output and does not serialize private completion evidence', async () => {
    const output = answer(); output.stopReason = 'length'; output.content = 'ordinary '.repeat(2_000);
    vi.spyOn(MockProvider.prototype, 'chat').mockResolvedValue(output);
    const result = await proxy.sendChat('mock', seed(), { stream: false });
    expect(result.content).toBe(output.content); expect(Object.keys(result).sort()).toEqual(['content', 'model', 'usage']);
    expect(JSON.stringify(result)).not.toContain('compactionSummaryValid');
  });

  it('forwards the embedding caller signal and explicit output cap without HTTP request authority', async () => {
    let captured: ChatOptions | undefined;
    vi.spyOn(MockProvider.prototype, 'chat').mockImplementation(async (_messages, options) => { captured = options; return answer(); });
    const controller = new AbortController();
    await proxy.sendChat('mock', seed(), { stream: false, tools: [], maxTokens: 19, signal: controller.signal }, undefined, true);
    expect(captured?.maxTokens).toBe(19); expect(captured?.tools).toEqual([]); expect(captured?.signal).toBe(controller.signal);
    expect(captured?.signal?.aborted).toBe(false);
  });
});
