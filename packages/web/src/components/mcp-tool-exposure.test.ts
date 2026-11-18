import { describe, expect, it } from 'vitest';
import type { McpServerTestResult } from '@ai-harness/core';
import { mcpToolExposureValue } from './mcp-tool-exposure.js';

const report: McpServerTestResult = {
  state: 'connected', testedAt: '2026-10-18T00:00:00.000Z', durationMs: 1,
  resources: 0, resourceTemplates: 0, prompts: 0, toolCount: 2,
  tools: [{ name: 'search_docs', readOnly: true, exposure: 'deferred' }, { name: 'mutate', readOnly: false, exposure: 'hidden' }],
};

describe('MCP per-tool canonical exposure display', () => {
  it('uses effective Test metadata for a pattern-inherited remote name', () => {
    const server = { exposure: 'direct' as const, toolExposure: { 'search_*': 'deferred' as const, '*': 'hidden' as const }, testStatus: report };
    expect(mcpToolExposureValue(server, 'search_docs')).toBe('deferred');
    expect(mcpToolExposureValue(server, 'mutate')).toBe('hidden');
    expect(mcpToolExposureValue(server, 'search_*')).toBe('deferred');
    expect(mcpToolExposureValue(server, '*')).toBe('hidden');
  });

  it('prefers an explicit own override and otherwise preserves the server default', () => {
    expect(mcpToolExposureValue({ exposure: 'direct', toolExposure: { search_docs: 'codemode' }, testStatus: report }, 'search_docs')).toBe('codemode');
    expect(mcpToolExposureValue({ exposure: 'codemode' }, 'unknown')).toBe('codemode');
    expect(mcpToolExposureValue({ exposure: 'direct', testStatus: report }, 'unknown')).toBe('direct');
  });

  it('never interprets redacted display names as fresh pattern or prototype authority', () => {
    const toolExposure = Object.assign(Object.create({ constructor: 'hidden', '*': 'hidden' }), { '•••*': 'hidden' });
    const server = { exposure: 'direct' as const, toolExposure, testStatus: report };
    expect(mcpToolExposureValue(server, 'constructor')).toBe('direct');
    expect(mcpToolExposureValue(server, '__proto__')).toBe('direct');
    expect(mcpToolExposureValue(server, '•••_name')).toBe('direct');
    expect(mcpToolExposureValue(server, 'search_docs')).toBe('deferred');
  });
});
