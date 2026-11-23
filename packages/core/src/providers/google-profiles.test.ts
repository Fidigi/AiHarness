import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiProvider, VertexGeminiProvider, MockProvider, type ChatOptions, type ChatResponse, type ThinkingLevel, type ThinkingBudgets } from './index.js';
import { getSupportedThinkingLevels, PUBLISHED_THINKING_LEVELS } from './model-metadata.js';
import { getProviderPublishedModel, getProviderPublishedModels } from './provider-model-metadata.js';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import type { Message } from '../types/index.js';
import { streamProviderTurn } from '../agent/provider-turn.js';
import { runToolLoop } from '../agent/tool-loop.js';
import { JsonlSessionStore, SessionManager } from '../sessions/session-manager.js';
import { serializeSessionForExport } from '../sessions/serialization.js';
import { getCompactionModelMessages } from '../sessions/compaction-model-messages.js';
import { getSummaryModelMessages } from '../sessions/summary-model-messages.js';
import { CredentialRedactor } from './credentials.js';

const pin = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/provider-reference.json', import.meta.url), 'utf8'));
type Scope = 'google' | 'google-vertex';
type Price = { input: number; output: number; cacheRead: number; cacheWrite: number; inputTokensAbove?: number };
type Profile = { id: string; name: string; api: string; contextWindow: number; maxTokens: number; reasoning: boolean; input: string[];
  cost: Price & { tiers?: Price[] }; thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>> };
const reference = (scope: Scope) => {
  const bytes = readFileSync(new URL(`../../../../tests/fixtures/${scope}-reference.json`, import.meta.url));
  return { bytes, profiles: Object.values(JSON.parse(bytes.toString())).flatMap(group => Object.values(group as Record<string, Profile>)) };
};
const toolReference = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/google-tool-schema-reference.json', import.meta.url), 'utf8')) as {
  pinnedCommit: string; captureSha256: string; catalogueSha256: Record<Scope, string>; modelProjections: number; toolVectors: number;
  rows: Array<{ scope: Scope; model: string; api: string; case: string; parameters?: Record<string, unknown>; tools: unknown[] | null }>;
};
type GenerationConfig = { maxOutputTokens?: number; thinkingConfig?: { thinkingBudget?: number; thinkingLevel?: string; includeThoughts?: boolean } };
const generationReference = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/google-generation-reference.json', import.meta.url), 'utf8')) as {
  pinnedCommit: string; captureSha256: string; catalogueSha256: Record<Scope, string>; requestsCaptured: number;
  rows: Array<{ scope: Scope; model: string; api: string; case: string; inputCharacters: number; inputSha256: string;
    options: { reasoning?: Exclude<ThinkingLevel, 'off'>; maxTokens?: number; thinkingBudgets?: ThinkingBudgets }; generationConfig: GenerationConfig }>;
  rawDefaults: Array<{ scope: Scope; model: string; generationConfig: GenerationConfig }>;
};
const bearerReference = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/google-vertex-bearer-reference.json', import.meta.url), 'utf8')) as {
  pinnedCommit: string; captureSha256: string; catalogueSha256: string; requests: number; ownedTokenExchanges: number;
  rows: Array<{ model: string; api: string; origin: string; path: string; auth: string;
    tools: Array<{ functionDeclarations: Array<{ name: string; description: string; parametersJsonSchema: Record<string, unknown> }> }> }>;
};
const policyReference = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/google-tool-policy-reference.json', import.meta.url), 'utf8')) as {
  pinnedCommit: string; captureSha256: string; catalogueSha256: Record<Scope, string>; vectors: number; requests: number; pretransportErrors: number;
  strictProfiles: Array<{ scope: Scope; model: string }>;
  rows: Array<{ scope: Scope; model: string; api: string; case: string; refused: boolean; toolChoice?: 'auto' | 'none' | 'any';
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown>; constrainedSampling?: false | { type: 'json_schema'; strict: 'prefer' | 'require' } }>;
    wire: { tools: unknown[]; toolConfig: unknown } | null }>;
};
const boundaryReference = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/google-tool-schema-boundaries-reference.json', import.meta.url), 'utf8')) as {
  pinnedCommit: string; captureSha256: string; catalogueSha256: Record<Scope, string>; modelProjections: number; schemaCases: number;
  vectors: number; requests: number; pretransportErrors: number; rows: typeof policyReference.rows;
};
const historyReference = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/google-tool-results-reference.json', import.meta.url), 'utf8')) as {
  pinnedCommit: string; catalogueSha256: Record<Scope, string>; modelProjections: number; capturedCases: number; capturedRequests: number;
  boundUnsignedReplayCases: number; unboundImageCases: number; captures: Array<{ preparation: string; captureSha256: string; cases: number; requests: number }>;
  rows: Array<{ scope: Scope; model: string; api: string; case: string; responseParts: Array<Record<string, unknown>>;
    calls: NonNullable<ChatResponse['toolCalls']>; messages: Array<Omit<Message, 'timestamp'>>; tools: NonNullable<ChatOptions['tools']>; contents: unknown[] }>;
};
const imageReference = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/google-tool-images-reference.json', import.meta.url), 'utf8')) as {
  pinnedCommit: string; catalogueSha256: Record<Scope, string>; modelProjections: number; selectedVectors: number; selectedRequests: number; newlyExecutedSdkRequests: number;
  captures: Array<{ source: string; captureSha256: string; reusedExecution: boolean; selectedVectors: number; selectedRequests: number }>;
  rows: typeof historyReference.rows;
};
const userImageBytes = readFileSync(new URL('../../../../tests/fixtures/google-user-images-reference.json', import.meta.url));
const userImageReference = JSON.parse(userImageBytes.toString()) as {
  pinnedCommit: string; captureSha256: string; catalogueSha256: Record<Scope, string>; modelProjections: number; vectors: number; freshSdkRequests: number; orderedOpaqueImageProjections: number;
  rows: Array<{ scope: Scope; model: string; api: string; case: string; provided: { text: string; images: Array<{ mimeType: string; data: string }> }; expectedContents: unknown[] }>;
};
type ContinuationBlock = { type: 'text'; text: string; textSignature?: string }
  | { type: 'thinking'; thinking: string; thinkingSignature?: string }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown>; thoughtSignature?: string };
const continuationBytes = readFileSync(new URL('../../../../tests/fixtures/google-continuation-reference.json', import.meta.url));
const continuationReference = JSON.parse(continuationBytes.toString()) as {
  pinnedCommit: string; catalogueSha256: Record<Scope, string>; modelProjections: number; replayCases: number; requests: number;
  tools: NonNullable<ChatOptions['tools']>; parts: Array<Record<string, unknown>>; fragmentParts: Array<Record<string, unknown>>;
  rows: Array<{ scope: Scope; model: string; api: string; firstObserved: { content: ContinuationBlock[] };
    projections: Array<{ case: 'same' | 'provider' | 'api' | 'model' | 'missing-api' | 'expurgated' | 'failed'; expected: unknown[] }> }>;
  fragments: Array<{ scope: Scope; model: string; api: string; firstObserved: { content: ContinuationBlock[] }; expectedContents: unknown[] }>;
};
const continuationBlocks = (blocks: ContinuationBlock[]) => blocks.map(block => block.type === 'text' ? block
  : block.type === 'thinking' ? { type: 'reasoning', text: block.thinking, thinkingSignature: block.thinkingSignature }
    : { type: 'tool_call', id: block.id, name: block.name, input: block.arguments, thoughtSignature: block.thoughtSignature });
const input = [{ id: 'user', role: 'user' as const, content: 'probe', timestamp: new Date(0) }];
const observed = { promptTokenCount: 12, candidatesTokenCount: 2, thoughtsTokenCount: 3, cachedContentTokenCount: 4, totalTokenCount: 17 };
const known = (price: Price) => price.input > 0 || price.output > 0 || price.cacheRead > 0 || price.cacheWrite > 0;
const signedParts = [
  { text: 'left', thoughtSignature: 'bGVmdA==' }, { text: 'visible', thought: true, thoughtSignature: 'dGhvdWdodA==' },
  { functionCall: { id: 'native-call', name: 'echo', args: { x: 1 } }, thoughtSignature: 'dG9vbA==' },
  { text: '', thoughtSignature: 'ZW1wdHk=' }, { text: '', thought: true, thoughtSignature: 'aGlkZGVu' },
  { text: 'right', thoughtSignature: 'cmlnaHQ=' },
];
const signedBlocks = [
  { type: 'text', text: 'left', textSignature: 'bGVmdA==' }, { type: 'reasoning', text: 'visible', thinkingSignature: 'dGhvdWdodA==' },
  { type: 'tool_call', id: 'native-call', name: 'echo', input: { x: 1 }, thoughtSignature: 'dG9vbA==' },
  { type: 'text', text: '', textSignature: 'ZW1wdHk=' }, { type: 'reasoning', text: '', thinkingSignature: 'aGlkZGVu' },
  { type: 'text', text: 'right', textSignature: 'cmlnaHQ=' },
];
afterEach(() => vi.restoreAllMocks());
function fixture(scope: Scope, model: string, compatible = false, apiKey = 'disposable-google-key') {
  const Native = scope === 'google' ? GeminiProvider : VertexGeminiProvider;
  class Compatible extends Native {}
  const provider = new (compatible ? Compatible : Native)({ type: 'operator-alias', model, apiKey,
    baseUrl: 'http://127.0.0.1:1/owned/v1', project: 'disposable-project' });
  let usage: unknown = structuredClone(observed), beforeReply = () => {};
  let parts: Array<Record<string, unknown>> = [{ text: 'ok' }];
  const chunks: Array<[string, string | undefined, unknown]> = [], completed: Array<ChatResponse | undefined> = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    beforeReply();
    const event = { modelVersion: 'untrusted-response-alias', candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: usage };
    return String(_url).includes(':streamGenerateContent')
      ? new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
      : new Response(JSON.stringify(event), { headers: { 'Content-Type': 'application/json' } });
  });
  const call = async (stream: boolean, options: ChatOptions = {}, messages: Message[] = input) => {
    if (!stream) return provider.chat(messages, options);
    let result: ChatResponse | undefined, failure: Error | undefined;
    await provider.streamChat(messages, (text, event) => { chunks.push([text, event?.type, event?.data]); },
      value => { result = value; completed.push(value); }, error => { failure = error; }, options);
    if (failure) throw failure; return result!;
  };
  return { provider, fetch, call, chunks, completed, parts: (value: Array<Record<string, unknown>>) => { parts = value; },
    usage: (value: unknown) => { usage = value; }, beforeReply: (callback: () => void) => { beforeReply = callback; } };
}

describe('pinned original Google/Vertex declarations and observed accounting', () => {
  for (const scope of ['google', 'google-vertex'] as const) {
    const { bytes, profiles } = reference(scope);
    it(`${scope}: binds independent package catalogue bytes without online discovery`, () => {
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(pin.files[scope].catalogue);
      expect(createHash('sha256').update(continuationBytes).digest('hex')).toBe('d9210d534291e1f74d0a56dd7c54362fac33c35c8664c378429cd3807cb7a399');
      expect(continuationReference.pinnedCommit).toBe(pin.sourceCommit);
      expect(continuationReference.catalogueSha256[scope]).toBe(pin.files[scope].catalogue);
      expect([continuationReference.modelProjections, continuationReference.replayCases, continuationReference.requests]).toEqual([35, 245, 284]);
      expect(continuationReference.rows.filter(row => row.scope === scope).map(row => row.model)).toEqual(profiles.map(row => row.id));
      for (const row of continuationReference.rows) expect(row.projections.map(projection => projection.case))
        .toEqual(['same', 'provider', 'api', 'model', 'missing-api', 'expurgated', 'failed']);
      expect(profiles).toHaveLength(scope === 'google' ? 22 : 13);
      expect(toolReference.pinnedCommit).toBe('06a466935536f8c9bcacb2d5efc0fc021be1bdff');
      expect(toolReference.captureSha256).toBe('d134d8ae6bfac529580aaaf778e2568b72a0f22c44c1c702a4e3e36588faa384');
      expect(toolReference.catalogueSha256[scope]).toBe(pin.files[scope].catalogue);
      expect(toolReference.modelProjections).toBe(35); expect(toolReference.toolVectors).toBe(70); expect(toolReference.rows).toHaveLength(105);
      expect([...new Set(toolReference.rows.filter(row => row.scope === scope).map(row => row.model))]).toEqual(profiles.map(row => row.id));
      expect(historyReference.pinnedCommit).toBe(toolReference.pinnedCommit);
      expect(historyReference.catalogueSha256[scope]).toBe(pin.files[scope].catalogue);
      expect(historyReference.modelProjections).toBe(35); expect(historyReference.capturedCases).toBe(350); expect(historyReference.capturedRequests).toBe(700);
      expect(historyReference.boundUnsignedReplayCases).toBe(280); expect(historyReference.unboundImageCases).toBe(70); expect(historyReference.rows).toHaveLength(280);
      expect(historyReference.captures).toEqual([
        { preparation: 'reference', captureSha256: '7fe1bb81f869f8933c8dd797d8925cf08f7d8f86c79f9060b8aa27833b1ccb7f', cases: 210, requests: 420 },
        { preparation: 'cross-provenance', captureSha256: '6eb92181f28954ef5d6446dfe2d519be3facfd8f53d1a0c41295689c32d2b66c', cases: 140, requests: 280 },
      ]);
      expect([...new Set(historyReference.rows.filter(row => row.scope === scope).map(row => row.model))]).toEqual(profiles.map(row => row.id));
      expect(imageReference.pinnedCommit).toBe(toolReference.pinnedCommit); expect(imageReference.catalogueSha256[scope]).toBe(pin.files[scope].catalogue);
      expect(imageReference.modelProjections).toBe(35); expect(imageReference.selectedVectors).toBe(140); expect(imageReference.selectedRequests).toBe(280);
      expect(imageReference.newlyExecutedSdkRequests).toBe(140); expect(imageReference.rows).toHaveLength(140);
      expect(imageReference.captures).toEqual([
        { source: 'reused-reference', captureSha256: '7fe1bb81f869f8933c8dd797d8925cf08f7d8f86c79f9060b8aa27833b1ccb7f', reusedExecution: true, selectedVectors: 70, selectedRequests: 140 },
        { source: 'empty-reference', captureSha256: '10651e9881f2890c9b2f51e700e961a78051f79548b5d51fec74d7fcf3b9d221', reusedExecution: false, selectedVectors: 70, selectedRequests: 140 },
      ]);
      expect([...new Set(imageReference.rows.filter(row => row.scope === scope).map(row => row.model))]).toEqual(profiles.map(row => row.id));
      expect(createHash('sha256').update(userImageBytes).digest('hex')).toBe('46a6fa98a5c33590d83d9ec6b2570342dd8d063c903978428606bf437fd6b9ca');
      expect(userImageReference.pinnedCommit).toBe(toolReference.pinnedCommit); expect(userImageReference.catalogueSha256[scope]).toBe(pin.files[scope].catalogue);
      expect(userImageReference.captureSha256).toBe('595ef1fdd4173ce0c4f3b0ffa9de8df2729959a49dc04333101943daab00e9cb');
      expect(userImageReference.modelProjections).toBe(35); expect(userImageReference.vectors).toBe(140); expect(userImageReference.freshSdkRequests).toBe(140);
      expect(userImageReference.orderedOpaqueImageProjections).toBe(175); expect(userImageReference.rows).toHaveLength(140);
      expect([...new Set(userImageReference.rows.filter(row => row.scope === scope).map(row => row.model))]).toEqual(profiles.map(row => row.id));
      expect(boundaryReference.pinnedCommit).toBe(toolReference.pinnedCommit);
      expect(boundaryReference.captureSha256).toBe('53b5cc7a8c669fd79d832d21c4ebbb29daf4f34044a9839c46a6886045c7dfa2');
      expect(boundaryReference.catalogueSha256[scope]).toBe(pin.files[scope].catalogue);
      expect(boundaryReference.modelProjections).toBe(2); expect(boundaryReference.schemaCases).toBe(34);
      expect(boundaryReference.vectors).toBe(136); expect(boundaryReference.requests).toBe(76); expect(boundaryReference.pretransportErrors).toBe(60);
      expect(boundaryReference.rows).toHaveLength(136);
      expect([...new Set(boundaryReference.rows.filter(row => row.scope === scope).map(row => row.model))]).toEqual(['gemini-3.1-pro-preview']);
      expect(policyReference.pinnedCommit).toBe(toolReference.pinnedCommit);
      expect(policyReference.captureSha256).toBe('75484e1ee214a7dde6fd2b4fce36dba563977dae47bbc7321e78fea780e833b8');
      expect(policyReference.catalogueSha256[scope]).toBe(pin.files[scope].catalogue);
      expect(policyReference.vectors).toBe(420); expect(policyReference.requests).toBe(372); expect(policyReference.pretransportErrors).toBe(48);
      expect(policyReference.rows).toHaveLength(420); expect(policyReference.strictProfiles).toHaveLength(22);
      expect(policyReference.strictProfiles.filter(row => row.scope === scope)).toHaveLength(scope === 'google' ? 12 : 10);
      expect([...new Set(policyReference.rows.filter(row => row.scope === scope).map(row => row.model))]).toEqual(profiles.map(row => row.id));
      expect(generationReference.pinnedCommit).toBe(toolReference.pinnedCommit);
      expect(generationReference.captureSha256).toBe('9aef98c62dee5c6993b55ca2415c2ea46af69ed364812e1014becf5d505280cd');
      expect(generationReference.catalogueSha256[scope]).toBe(pin.files[scope].catalogue);
      expect(generationReference.requestsCaptured).toBe(315); expect(generationReference.rows).toHaveLength(210); expect(generationReference.rawDefaults).toHaveLength(35);
      expect([...new Set(generationReference.rows.filter(row => row.scope === scope).map(row => row.model))]).toEqual(profiles.map(row => row.id));
      if (scope === 'google-vertex') {
        expect(bearerReference.pinnedCommit).toBe(toolReference.pinnedCommit);
        expect(bearerReference.captureSha256).toBe('7cd1746e0c57581584e9c0ca9cc4c9916e2a9d330c968df1b7a72e786d13ad19');
        expect(bearerReference.catalogueSha256).toBe(pin.files[scope].catalogue);
        expect(bearerReference.requests).toBe(13); expect(bearerReference.ownedTokenExchanges).toBe(13);
        expect(bearerReference.rows.map(row => row.model)).toEqual(profiles.map(row => row.id));
      }
      const f = fixture(scope, profiles[0].id);
      for (const profile of profiles) expect(getProviderPublishedModel('unrelated', profile.id, f.provider)?.api).toBe(profile.api);
      expect(f.fetch).not.toHaveBeenCalled();
    });
    for (const profile of profiles) it(`${scope}/${profile.id}: owns API/metadata/prices on both physical transports`, async () => {
      const f = fixture(scope, profile.id), row = getProviderPublishedModel('unrelated-label', profile.id, f.provider);
      expect(row).toMatchObject({ id: profile.id, name: profile.name, api: profile.api, contextWindow: profile.contextWindow,
        maxOutputTokens: profile.maxTokens, capabilities: { reasoning: profile.reasoning, imageInput: profile.input.includes('image'), toolCalls: true } });
      expect(row?.pricing).toEqual(known(profile.cost) ? { inputPerMillion: profile.cost.input, outputPerMillion: profile.cost.output,
        cacheReadPerMillion: profile.cost.cacheRead, cacheWritePerMillion: profile.cost.cacheWrite } : undefined);
      for (const stream of [false, true]) {
        const response = await f.call(stream, { maxTokens: 64 });
        expect(response).toMatchObject({ content: 'ok', api: profile.api, model: profile.id });
        expect(response.usage).toMatchObject({ promptTokens: 8, completionTokens: 5, cacheReadTokens: 4, totalTokens: 17 });
        if (known(profile.cost)) expect(response.usage?.costUsd).toBeCloseTo((8 * profile.cost.input + 5 * profile.cost.output + 4 * profile.cost.cacheRead) / 1e6, 12);
        else expect(response.usage?.costUsd).toBeUndefined();
        const [url, init] = f.fetch.mock.calls.at(-1)!;
        expect(String(url)).toContain(`/models/${encodeURIComponent(profile.id)}:${stream ? 'streamGenerateContent' : 'generateContent'}`);
        expect(new Headers(init?.headers).get(scope === 'google' ? 'x-goog-api-key' : 'authorization'))
          .toBe(scope === 'google' ? 'disposable-google-key' : 'Bearer disposable-google-key');
        expect(new URL(String(url)).searchParams.has('key')).toBe(false);
        expect(JSON.parse(init!.body as string).tools ?? null).toEqual(toolReference.rows.find(row => row.scope === scope && row.model === profile.id && row.case === 'raw-default')!.tools);
      }
      const vectors = toolReference.rows.filter(row => row.scope === scope && row.model === profile.id && row.case !== 'raw-default');
      expect(vectors.map(row => row.case)).toEqual(['object', 'union-optional']);
      for (const vector of vectors) for (const stream of [false, true]) {
        const parameters = structuredClone(vector.parameters!);
        const result = await f.call(stream, { maxTokens: 64, temperature: 0.7, tools: [{ name: 'echo', description: 'Echo', parameters }] });
        expect(result).toMatchObject({ model: profile.id, api: vector.api });
        const body = JSON.parse(f.fetch.mock.calls.at(-1)![1]!.body as string);
        expect(body.tools).toEqual(vector.tools); expect(parameters).toEqual(vector.parameters);
      }
      const generation = generationReference.rows.filter(row => row.scope === scope && row.model === profile.id);
      expect(generation.map(row => row.case)).toEqual(['simple-default', 'simple-high', 'simple-minimal-answer64', 'simple-high-answer1', 'simple-high-budget1-answer64', 'simple-high-longer-context']);
      expect(generationReference.rawDefaults.find(row => row.scope === scope && row.model === profile.id)!.generationConfig.maxOutputTokens).toBeUndefined();
      for (const vector of generation) for (const stream of [false, true]) {
        const content = vector.case === 'simple-high-longer-context' ? 'x'.repeat(12000) : 'probe';
        expect(content.length).toBe(vector.inputCharacters); expect(createHash('sha256').update(content).digest('hex')).toBe(vector.inputSha256);
        const result = await f.call(stream, { model: profile.id, systemPrompt: 'owned system', thinking: vector.options.reasoning,
          maxTokens: vector.options.maxTokens, thinkingBudgets: vector.options.thinkingBudgets }, [{ ...input[0], content }]);
        expect(result).toMatchObject({ content: 'ok', model: profile.id, api: vector.api });
        const actual = JSON.parse(f.fetch.mock.calls.at(-1)![1]!.body as string).generationConfig;
        expect(actual).toEqual(vector.generationConfig);
      }
      if (scope === 'google-vertex') {
        const physical = bearerReference.rows.find(row => row.model === profile.id)!;
        const provider = new VertexGeminiProvider({ type: 'vertex', model: profile.id, project: 'owned-project', location: 'us-central1', apiKey: 'owned-exchanged-access' });
        const declaration = physical.tools[0].functionDeclarations[0];
        let result: ChatResponse | undefined;
        // Core receives a supplied opaque Bearer; it does not resolve the SDK's ADC credential file.
        await provider.streamChat(input, () => {}, value => { result = value; }, undefined, { maxTokens: 64, systemPrompt: 'owned system',
          tools: [{ name: declaration.name, description: declaration.description, parameters: declaration.parametersJsonSchema }] });
        expect(result).toMatchObject({ content: 'ok', model: profile.id, api: physical.api });
        const [url, init] = f.fetch.mock.calls.at(-1)!;
        expect(String(url)).toBe(physical.origin + physical.path); expect(physical.auth).toBe('Bearer');
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer owned-exchanged-access');
        expect(new Headers(init?.headers).get('x-goog-api-key')).toBeNull();
        expect(JSON.parse(init!.body as string).tools).toEqual(physical.tools);
      }
    });
    for (const profile of profiles) it(`${scope}/${profile.id}: binds unsigned IDs, same/cross identity history, one-image results and user-image arrays to actual SDK requests`, async () => {
      const f = fixture(scope, profile.id), vectors = historyReference.rows.filter(row => row.scope === scope && row.model === profile.id);
      const images = imageReference.rows.filter(row => row.scope === scope && row.model === profile.id);
      expect(vectors.map(row => row.case)).toEqual(['success', 'error', 'empty', 'adjacent-two-results', 'cross-provider', 'cross-api', 'cross-model', 'legacy-missing-identity']);
      expect(images.map(row => row.case)).toEqual(['image-success', 'image-error', 'image-only-success', 'image-only-error']);
      for (const vector of [...vectors, ...images]) for (const stream of [false, true]) {
        const options = { model: profile.id, maxTokens: 64, tools: structuredClone(vector.tools) };
        f.parts(vector.responseParts);
        const first = await f.call(stream, options);
        expect(first).toMatchObject({ content: '', model: profile.id, api: vector.api }); expect(first.toolCalls).toEqual(vector.calls);
        f.parts([{ text: 'ok' }]);
        const messages: Message[] = structuredClone(vector.messages).map(message => ({ ...message, timestamp: new Date(0) })), before = structuredClone(messages);
        const result = await f.call(stream, options, messages);
        expect(result).toMatchObject({ content: 'ok', model: profile.id, api: vector.api });
        expect(JSON.parse(f.fetch.mock.calls.at(-1)![1]!.body as string).contents).toEqual(vector.contents);
        expect(messages).toEqual(before); expect(options.tools).toEqual(vector.tools);
      }
      const users = userImageReference.rows.filter(row => row.scope === scope && row.model === profile.id), requests = f.fetch.mock.calls.length;
      expect(users.map(row => row.case)).toEqual(['text-image', 'image-only', 'whitespace-image', 'text-two-images']);
      for (const vector of users) for (const stream of [false, true]) {
        const messages: Message[] = [{ id: 'u', role: 'user', content: vector.provided.text, timestamp: new Date(0),
          blocks: vector.provided.images.map(image => ({ type: 'image', mediaType: image.mimeType, url: `data:${image.mimeType};base64,${image.data}` })) }];
        const options = { model: profile.id, maxTokens: 64 }, before = structuredClone({ messages, options });
        expect(await f.call(stream, options, messages)).toMatchObject({ content: 'ok', model: profile.id, api: vector.api });
        const body = JSON.parse(f.fetch.mock.calls.at(-1)![1]!.body as string);
        expect(body.contents, vector.case).toEqual(vector.expectedContents);
        for (const field of ['tools', 'toolConfig', 'systemInstruction']) expect(Object.hasOwn(body, field)).toBe(false);
        expect({ messages, options }).toEqual(before);
      }
      expect(f.fetch.mock.calls.length - requests).toBe(8);
    });
    it(`${scope}: does not lend native response IDs or history shapes to derived/unknown models or public API labels`, async () => {
      const model = 'gemini-3.1-pro-preview', vector = historyReference.rows.find(row => row.scope === scope && row.model === model && row.case === 'adjacent-two-results')!;
      const messages: Message[] = structuredClone(vector.messages).map(message => ({ ...message, timestamp: new Date(0) }));
      for (const [configured, compatible, selected] of [[model, true, model], [`${model}-unreviewed`, false, `${model}-unreviewed`],
        [model, false, `${model}-unreviewed`]] as const) {
        const f = fixture(scope, configured, compatible); f.provider.getModelApi = () => vector.api;
        for (const stream of [false, true]) {
          f.parts(vector.responseParts);
          expect((await f.call(stream, { model: selected, maxTokens: 64 })).toolCalls?.map(call => call.id)).toEqual(['gemini-0-echo', 'gemini-1-other']);
          f.parts([{ text: 'ok' }]); await f.call(stream, { model: selected, maxTokens: 64 }, messages);
          const contents = JSON.parse(f.fetch.mock.calls.at(-1)![1]!.body as string).contents;
          expect(contents[1].parts).toEqual(vector.calls.map(call => ({ functionCall: { name: call.name, args: call.input } })));
          expect(contents.slice(2)).toEqual([
            { role: 'user', parts: [{ functionResponse: { name: 'echo', response: { content: 'first', isError: false } } }] },
            { role: 'user', parts: [{ functionResponse: { name: 'other', response: { content: 'second', isError: true } } }] },
          ]);
          const image = imageReference.rows.find(row => row.scope === scope && row.model === model && row.case === 'image-success')!;
          const imageMessages: Message[] = structuredClone(image.messages).map(message => ({ ...message, timestamp: new Date(0) })), before = structuredClone(imageMessages);
          await f.call(stream, { model: selected, maxTokens: 64 }, imageMessages);
          const legacy = JSON.parse(f.fetch.mock.calls.at(-1)![1]!.body as string).contents;
          expect(legacy[2]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'echo', response: { content: 'first', isError: false } } }] });
          expect(legacy.at(-1).parts[0]).toEqual({ text: `Tool images for ${image.calls[0].id}` }); expect(imageMessages).toEqual(before);
        }
      }
      const f = fixture(scope, `${model}-unreviewed`); f.parts(vector.responseParts);
      for (const stream of [false, true]) {
        expect((await f.call(stream, { model, maxTokens: 64 })).toolCalls).toEqual(vector.calls);
        const image = imageReference.rows.find(row => row.scope === scope && row.model === model && row.case === 'image-success')!;
        const messages: Message[] = structuredClone(image.messages).map(message => ({ ...message, timestamp: new Date(0) }));
        f.parts([{ text: 'ok' }]); await f.call(stream, { model, maxTokens: 64 }, messages);
        expect(JSON.parse(f.fetch.mock.calls.at(-1)![1]!.body as string).contents).toEqual(image.contents); f.parts(vector.responseParts);
      }
    });
    for (const profile of profiles) it(`${scope}/${profile.id}: binds raw strict/prefer/choice construction and pretransport refusals to executed SDK vectors`, async () => {
      const f = fixture(scope, profile.id), vectors = policyReference.rows.filter(row => row.scope === scope && row.model === profile.id);
      expect(vectors.map(row => row.case)).toEqual(['default', 'prefer', 'require', 'prefer-structured-union', 'require-structured-union',
        'prefer-auto', 'prefer-none', 'prefer-any', 'off-auto', 'off-none', 'off-any', 'mixed-prefer-off']);
      const boundaries = boundaryReference.rows.filter(row => row.scope === scope && row.model === profile.id);
      expect(boundaries).toHaveLength(profile.id === 'gemini-3.1-pro-preview' ? 68 : 0);
      for (const vector of [...vectors, ...boundaries]) for (const stream of [false, true]) {
        const options = { maxTokens: 64, tools: structuredClone(vector.tools), toolChoice: vector.toolChoice };
        const requests = f.fetch.mock.calls.length, chunks = f.chunks.length, completed = f.completed.length;
        if (vector.refused) {
          await expect(f.call(stream, options)).rejects.toThrow('Google tool requires unsupported constrained sampling.');
          expect(f.fetch.mock.calls).toHaveLength(requests); expect(f.chunks).toHaveLength(chunks); expect(f.completed).toHaveLength(completed);
        } else {
          const result = await f.call(stream, options);
          expect(result).toMatchObject({ content: 'ok', model: profile.id, api: vector.api });
          const body = JSON.parse(f.fetch.mock.calls.at(-1)![1]!.body as string);
          expect(body.tools).toEqual(vector.wire!.tools); expect(body.toolConfig ?? null).toEqual(vector.wire!.toolConfig);
        }
        expect(options.tools).toEqual(vector.tools);
      }
    });
    it(`${scope}: keeps new tool controls private to owned models and rejects defined invalid controls before HTTP`, async () => {
      const model = profiles.find(row => row.id === 'gemini-3.1-pro-preview')!.id;
      const parameters = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false };
      const tool = { name: 'echo', description: 'Echo', parameters, constrainedSampling: { type: 'json_schema', strict: 'require' } };
      for (const f of [fixture(scope, model, true), fixture(scope, `${model}-unreviewed`)]) {
        f.provider.getModelApi = () => scope === 'google' ? 'google-generative-ai' : 'google-vertex';
        for (const stream of [false, true]) {
          let requests = f.fetch.mock.calls.length;
          const required = { maxTokens: 64, tools: [tool] };
          await expect(f.call(stream, required)).rejects.toThrow('Google tool requires unsupported constrained sampling.');
          expect(f.fetch.mock.calls).toHaveLength(requests);
          const preferred = { maxTokens: 64, tools: [{ ...tool, constrainedSampling: { type: 'json_schema', strict: 'prefer' } }] };
          await f.call(stream, preferred);
          const body = JSON.parse(f.fetch.mock.calls.at(-1)![1]!.body as string);
          expect(body.tools[0].functionDeclarations[0].parameters).toEqual(parameters);
          expect(Object.hasOwn(body.tools[0].functionDeclarations[0], 'parametersJsonSchema')).toBe(false); expect(body.toolConfig).toBeUndefined();
          requests = f.fetch.mock.calls.length;
          const choice = { ...preferred, toolChoice: 'none' };
          await expect(f.call(stream, choice)).rejects.toThrow('Invalid Google tool policy.'); expect(f.fetch.mock.calls).toHaveLength(requests);
        }
      }
      const f = fixture(scope, model);
      for (const options of [{ maxTokens: 64, tools: [tool], toolChoice: 'PRIVATE-invalid-choice' },
        { maxTokens: 64, tools: [{ ...tool, constrainedSampling: { type: 'json_schema', strict: 'PRIVATE-invalid-strict' } }] }]) {
        for (const stream of [false, true]) {
          const requests = f.fetch.mock.calls.length;
          await expect(f.call(stream, options)).rejects.toThrow('Invalid Google tool policy.'); expect(f.fetch.mock.calls).toHaveLength(requests);
        }
      }
    });
    for (const profile of profiles.filter(row => row.cost.tiers?.length)) it(`${scope}/${profile.id}: uses strictly-above gross-input tiers, not output or mutable metadata`, async () => {
      const f = fixture(scope, profile.id), row = getProviderPublishedModel('unrelated-label', profile.id, f.provider)!;
      row.pricing!.inputPerMillion = 999;
      for (const tier of profile.cost.tiers!) for (const above of [false, true]) for (const stream of [false, true]) {
        const gross = tier.inputTokensAbove! + (above ? 1 : 0), price = above ? tier : profile.cost;
        f.usage({ ...observed, promptTokenCount: gross, candidatesTokenCount: 300000, thoughtsTokenCount: 3, totalTokenCount: gross + 300003 });
        const response = await f.call(stream, { maxTokens: 64 });
        expect(response.usage?.costUsd).toBeCloseTo(((gross - 4) * price.input + 300003 * price.output + 4 * price.cacheRead) / 1e6, 12);
      }
    });
    it(`${scope}: retains absent SSE usage but respects explicit zero and invalid final observations`, async () => {
      const model = profiles.find(profile => profile.id === 'gemini-2.5-flash')!, f = fixture(scope, model.id);
      for (const last of [{}, { usageMetadata: null }, { usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 } },
        { usageMetadata: { ...observed, totalTokenCount: 'PRIVATE-invalid' } }]) {
        f.fetch.mockImplementationOnce(async () => new Response([
          { candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: observed },
          { candidates: [{ finishReason: 'STOP' }], ...last },
        ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } }));
        const response = await f.call(true, { maxTokens: 64 });
        if (!('usageMetadata' in last)) expect(response.usage).toMatchObject({ promptTokens: 8, completionTokens: 5, totalTokens: 17 });
        else if (last.usageMetadata?.promptTokenCount === 0) expect(response.usage).toMatchObject({ promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 });
        else expect(response.usage).toBeUndefined();
      }
    });
    it(`${scope}: refuses manufactured complete usage and captures per-call model before response callbacks`, async () => {
      const f = fixture(scope, profiles[0].id), selected = profiles.find(row => row.id === 'gemini-2.5-flash')!;
      const nativeApi = f.provider.getModelApi.bind(f.provider);
      f.provider.getModelApi = () => 'untrusted-metadata-api';
      f.beforeReply(() => f.provider.setConfiguredModel('untrusted-later-model'));
      for (const stream of [false, true]) {
        const response = await f.call(stream, { model: selected.id, maxTokens: 64 });
        expect(response.model).toBe(selected.id); expect(response.api).toBe(selected.api);
        expect(response.usage?.costUsd).toBeCloseTo((8 * selected.cost.input + 5 * selected.cost.output + 4 * selected.cost.cacheRead) / 1e6, 12);
        expect(String(f.fetch.mock.calls.at(-1)?.[0])).toContain(`/models/${selected.id}:`);
      }
      f.provider.getModelApi = nativeApi;
      f.beforeReply(() => {}); f.provider.setConfiguredModel(selected.id);
      for (const usage of [undefined, null, {}, { ...observed, promptTokenCount: undefined }, { ...observed, candidatesTokenCount: undefined },
        { ...observed, cachedContentTokenCount: 13 }, { ...observed, thoughtsTokenCount: -1 }, { ...observed, candidatesTokenCount: 0.5 },
        { ...observed, promptTokenCount: Number.MAX_SAFE_INTEGER, candidatesTokenCount: Number.MAX_SAFE_INTEGER },
        { ...observed, totalTokenCount: 'PRIVATE-malformed' }, { ...observed, totalTokenCount: 1 }]) {
        f.usage(usage);
        for (const stream of [false, true]) expect((await f.call(stream)).usage).toBeUndefined();
      }
      f.usage({ ...observed, totalTokenCount: 20 });
      for (const stream of [false, true]) {
        const usage = (await f.call(stream)).usage;
        expect(usage).toMatchObject({ promptTokens: 8, completionTokens: 5, cacheReadTokens: 4, totalTokens: 20 });
        expect(usage?.costUsd).toBeUndefined();
      }
      f.usage({ promptTokenCount: 0, candidatesTokenCount: 0 });
      for (const stream of [false, true]) expect((await f.call(stream)).usage).toMatchObject({ promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 });
      const pro = profiles.find(profile => profile.id === 'gemini-2.5-pro')!;
      const price = pro.cost.tiers?.[0] ?? pro.cost;
      f.usage({ ...observed, promptTokenCount: 200001, totalTokenCount: 200006 });
      for (const stream of [false, true]) {
        expect((await f.call(stream, { model: pro.id })).usage?.costUsd)
          .toBeCloseTo((199997 * price.input + 5 * price.output + 4 * price.cacheRead) / 1e6, 12);
      }
      const metadata = getProviderPublishedModels(f.provider)!;
      metadata[0].contextWindow = 1;
      expect(getProviderPublishedModels(f.provider)![0].contextWindow).toBe(profiles[0].contextWindow);
      const compatible = fixture(scope, selected.id, true);
      expect(getProviderPublishedModel(scope, selected.id, compatible.provider)).toBeUndefined();
      expect((await compatible.call(false)).usage?.costUsd).toBeUndefined();
      const unknown = fixture(scope, `${selected.id}-unverified`);
      expect(getProviderPublishedModel(scope, `${selected.id}-unverified`, unknown.provider)).toBeUndefined();
      expect((await unknown.call(false)).usage?.costUsd).toBeUndefined();
      const vector = toolReference.rows.find(row => row.scope === scope && row.model === selected.id && row.case === 'union-optional')!;
      for (const [adapter, model, native] of [
        [compatible, selected.id, false], [unknown, `${selected.id}-unverified`, false],
        [fixture(scope, 'unverified-configured-model'), selected.id, true],
        [fixture(scope, selected.id), `${selected.id}-unverified`, false],
      ] as const) for (const stream of [false, true]) {
        await adapter.call(stream, { model, maxTokens: 64, tools: [{ name: 'echo', description: 'Echo', parameters: vector.parameters! }] });
        const declaration = JSON.parse(adapter.fetch.mock.calls.at(-1)![1]!.body as string).tools[0].functionDeclarations[0];
        expect(declaration[native ? 'parametersJsonSchema' : 'parameters']).toEqual(vector.parameters);
        expect(Object.hasOwn(declaration, native ? 'parameters' : 'parametersJsonSchema')).toBe(false);
      }
    });
  }
});

describe('pinned original Google/Vertex native thinking and output policy', () => {
  const levels = [...PUBLISHED_THINKING_LEVELS];
  const supported = (profile: Profile) => levels.filter(level => profile.thinkingLevelMap?.[level] !== null
    && (!['xhigh', 'max'].includes(level) || profile.thinkingLevelMap?.[level] !== undefined));
  const clamp = (profile: Profile, level: ThinkingLevel): ThinkingLevel => {
    const available = supported(profile), index = levels.indexOf(level);
    return levels.slice(index).find(candidate => available.includes(candidate))
      ?? levels.slice(0, index).reverse().find(candidate => available.includes(candidate))!;
  };
  const expectedThinking = (scope: Scope, profile: Profile, requested?: ThinkingLevel) => {
    const selected = clamp(profile, requested ?? 'off');
    if (profile.thinkingLevelMap) return { thinkingLevel: (profile.thinkingLevelMap[selected] ?? selected).toUpperCase(),
      ...(requested !== undefined ? { includeThoughts: true } : {}) };
    if (selected === 'off') return { thinkingBudget: 0 };
    const budgets: Record<string, readonly number[]> = {
      'gemini-2.5-pro': [128, 2048, 8192, 32768],
      'gemini-2.5-flash': [128, 2048, 8192, 24576],
      'gemini-2.5-flash-lite': [scope === 'google' ? 512 : 128, 2048, 8192, 24576],
    };
    return { thinkingBudget: budgets[profile.id]?.[['minimal', 'low', 'medium', 'high'].indexOf(selected)] ?? -1, includeThoughts: true };
  };
  for (const scope of ['google', 'google-vertex'] as const) for (const profile of reference(scope).profiles) {
    it(`${scope}/${profile.id}: publishes the physical levels and uses their numeric/discrete wire format`, async () => {
      const f = fixture(scope, profile.id), getter = vi.fn(() => 9999);
      const opaque = Object.defineProperty({}, 'low', { get: getter });
      expect(getSupportedThinkingLevels('alias', profile.id, undefined, f.provider)).toEqual(supported(profile));
      for (const thinking of [undefined, ...levels]) for (const stream of [false, true]) {
        const options = { maxTokens: 64, ...(thinking === undefined ? {} : { thinking }),
          ...(profile.thinkingLevelMap || thinking === undefined || thinking === 'off' ? { thinkingBudgets: opaque } : {}) };
        await f.call(stream, options);
        const body = JSON.parse(String(f.fetch.mock.calls.at(-1)![1]?.body));
        expect(body.generationConfig).toMatchObject({ maxOutputTokens: 64 });
        expect(body.generationConfig.thinkingConfig).toEqual(expectedThinking(scope, profile, thinking));
        expect(options.maxTokens).toBe(64);
      }
      for (const stream of [false, true]) {
        await f.call(stream);
        expect(JSON.parse(String(f.fetch.mock.calls.at(-1)![1]?.body)).generationConfig.maxOutputTokens).toBe(profile.maxTokens);
      }
      expect(getter).not.toHaveBeenCalled();
    });
    it(`${scope}/${profile.id}: refuses invalid limits/levels before HTTP and keeps private policy after public mutation`, async () => {
      const f = fixture(scope, profile.id), row = getProviderPublishedModel('alias', profile.id, f.provider)!;
      row.maxOutputTokens = Number.MAX_SAFE_INTEGER;
      if (row.thinkingLevelMap) for (const level of levels) row.thinkingLevelMap[level] = 'UNTRUSTED';
      for (const maxTokens of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, profile.maxTokens + 1, null]) {
        for (const stream of [false, true]) await expect(f.call(stream, { maxTokens: maxTokens as number })).rejects.toThrow('Invalid Google output limit.');
      }
      for (const thinking of ['PRIVATE-invalid', null, NaN]) for (const stream of [false, true]) {
        await expect(f.call(stream, { thinking: thinking as ThinkingLevel })).rejects.toThrow('Invalid Google thinking level.');
      }
      expect(f.fetch).not.toHaveBeenCalled();
      await f.call(false, { maxTokens: profile.maxTokens, thinking: 'high' });
      const body = JSON.parse(String(f.fetch.mock.calls.at(-1)![1]?.body));
      expect(body.generationConfig.maxOutputTokens).toBe(profile.maxTokens);
      expect(body.generationConfig.thinkingConfig).toEqual(expectedThinking(scope, profile, 'high'));
    });
    if (!profile.thinkingLevelMap) it(`${scope}/${profile.id}: consumes only valid owned numeric budgets within existing conservative bounds`, async () => {
      const f = fixture(scope, profile.id), maximum = profile.id.includes('2.5-pro') ? 32768 : profile.id.includes('2.5-flash') ? 24576 : 8192;
      const budgets = Object.freeze({ high: Number.MAX_SAFE_INTEGER });
      for (const stream of [false, true]) {
        await f.call(stream, { thinking: 'max', thinkingBudgets: budgets });
        expect(JSON.parse(String(f.fetch.mock.calls.at(-1)![1]?.body)).generationConfig.thinkingConfig)
          .toEqual({ thinkingBudget: maximum, includeThoughts: true });
      }
      for (const high of [0, 1, 127]) {
        const thinkingBudgets = Object.freeze({ high });
        for (const stream of [false, true]) {
          await f.call(stream, { thinking: 'high', maxTokens: 64, thinkingBudgets });
          expect(JSON.parse(String(f.fetch.mock.calls.at(-1)![1]?.body)).generationConfig)
            .toEqual({ maxOutputTokens: 64, thinkingConfig: { thinkingBudget: high, includeThoughts: true } });
        }
        expect(thinkingBudgets).toEqual({ high });
      }
      const getter = vi.fn(() => 1000), invalid = Object.defineProperty({}, 'high', { get: getter });
      const before = f.fetch.mock.calls.length;
      for (const thinkingBudgets of [invalid, { high: -1 }, { high: 1.5 }, { high: Infinity }, { max: 1000 }, null]) {
        for (const stream of [false, true]) await expect(f.call(stream, { thinking: 'high', thinkingBudgets: thinkingBudgets as ThinkingBudgets })).rejects.toThrow('Thinking budgets');
      }
      expect(f.fetch.mock.calls).toHaveLength(before); expect(getter).not.toHaveBeenCalled();
      expect(budgets.high).toBe(Number.MAX_SAFE_INTEGER);
    });
  }
  it('does not lend a native level map, default or ceiling to compatible subclasses or unknown IDs', async () => {
    for (const scope of ['google', 'google-vertex'] as const) {
      const derived = fixture(scope, 'gemini-3.8-flash', true), unknown = fixture(scope, 'gemini-3.8-flash-unverified');
      for (const f of [derived, unknown]) {
        await f.call(false, { thinking: 'low' });
        const body = JSON.parse(String(f.fetch.mock.calls.at(-1)![1]?.body));
        expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 2048 });
        expect(body.generationConfig.maxOutputTokens).toBeUndefined();
      }
    }
  });
});

describe('native original Google/Vertex response authority', () => {
  const reply = (data: unknown, stream: boolean) => new Response(stream ? `data: ${JSON.stringify(data)}\n\n` : JSON.stringify(data),
    { headers: { 'Content-Type': stream ? 'text/event-stream' : 'application/json' } });
  for (const scope of ['google', 'google-vertex'] as const) {
    for (const profile of reference(scope).profiles) it(`${scope}/${profile.id}: separates visible thoughts and preserves native part order and length`, async () => {
      const f = fixture(scope, profile.id), vector = continuationReference.rows.find(row => row.scope === scope && row.model === profile.id)!;
      const start = f.fetch.mock.calls.length;
      f.parts(continuationReference.parts);
      for (const stream of [false, true]) {
        const options = { maxTokens: 64, tools: continuationReference.tools };
        const response = await f.call(stream, options);
        expect(response).toMatchObject({ provider: scope === 'google' ? 'google' : 'vertex', model: vector.model, api: vector.api });
        expect(response.blocks).toEqual(continuationBlocks(vector.firstObserved.content));
        f.parts([{ text: 'ok' }]);
        for (const projection of vector.projections) {
          const source: Message = { id: 'reference', role: 'assistant', content: response.content, blocks: structuredClone(response.blocks),
            toolCalls: structuredClone(response.toolCalls), provider: response.provider, api: response.api, model: response.model, timestamp: new Date(0) };
          if (projection.case === 'provider') source.provider = 'foreign-provider';
          if (projection.case === 'api') source.api = 'foreign-api';
          if (projection.case === 'model') source.model = 'foreign-model';
          if (projection.case === 'missing-api') delete source.api;
          if (projection.case === 'failed') source.metadata = { outputError: 'failed publication' };
          if (projection.case === 'expurgated') {
            source.blocks = source.blocks!.map(block => { const copy = { ...block };
              if (copy.type === 'text') delete copy.textSignature;
              if (copy.type === 'reasoning') delete copy.thinkingSignature;
              if (copy.type === 'tool_call') delete copy.thoughtSignature;
              return copy; });
            source.toolCalls = source.toolCalls!.map(({ thoughtSignature: _signature, ...call }) => call);
          }
          const messages: Message[] = [...input, source, ...(projection.case === 'failed' ? [] : [{ id: 'result', role: 'tool' as const,
            toolCallId: 'native-call', name: 'echo', content: 'result', isError: false, timestamp: new Date(0) }]),
            { id: 'continue', role: 'user', content: 'continue', timestamp: new Date(1) }];
          const before = structuredClone({ messages, options });
          expect(await f.call(stream, options, messages)).toMatchObject({ content: 'ok', model: vector.model, api: vector.api });
          const body = JSON.parse(String(f.fetch.mock.calls.at(-1)![1]?.body));
          expect(body.contents, `${stream}/${projection.case}`).toEqual(projection.expected);
          expect({ messages, options }).toEqual(before);
        }
        f.parts(continuationReference.parts);
      }
      expect(f.fetch.mock.calls.length - start).toBe(16);
      f.chunks.length = 0;
      const parts = [{ text: 'first', thought: true }, { text: 'A' }, { text: 'second', thought: true },
        { text: 'B', thoughtSignature: 'opaque-on-text-not-a-thinking-marker' }];
      for (const stream of [false, true]) {
        f.fetch.mockImplementationOnce(async () => reply({ candidates: [{ content: { parts }, finishReason: 'MAX_TOKENS' }], usageMetadata: observed }, stream));
        expect(await f.call(stream, { thinking: 'high', maxTokens: 64 })).toMatchObject({ content: 'AB', reasoning: 'firstsecond',
          stopReason: 'length', model: profile.id, api: profile.api });
      }
      expect(f.chunks).toEqual([['', 'reasoning_delta', { content: 'first' }], ['A', 'text_delta', 'A'], ['', 'reasoning_delta', { content: 'second' }], ['B', 'text_delta', 'B']]);
      f.parts(signedParts);
      const requiresIds = Number(/^gemini(?:-live)?-(\d+)/i.exec(profile.id)?.[1] ?? 0) >= 3;
      for (const stream of [false, true]) {
        const response = await f.call(stream, { maxTokens: 64 });
        expect(response).toMatchObject({ provider: scope === 'google' ? 'google' : 'vertex', api: profile.api, model: profile.id,
          content: 'leftright', reasoning: 'visible', blocks: signedBlocks,
          toolCalls: [{ id: 'native-call', name: 'echo', input: { x: 1 }, thoughtSignature: 'dG9vbA==' }] });
        const source: Message = { id: 'signed', role: 'assistant', content: response.content, blocks: response.blocks,
          toolCalls: response.toolCalls, provider: response.provider, api: response.api, model: response.model, timestamp: new Date(0) };
        const before = structuredClone(source);
        for (const change of ['same', 'provider', 'model', 'api', 'missing-api', 'expurgated', 'failed'] as const) {
          const message = structuredClone(source);
          if (change === 'provider') message.provider = 'foreign-provider';
          if (change === 'model') message.model = 'foreign-model';
          if (change === 'api') message.api = 'foreign-api';
          if (change === 'missing-api') delete message.api;
          if (change === 'failed') message.metadata = { outputError: 'failed publication' };
          if (change === 'expurgated') {
            message.blocks = message.blocks!.map(block => {
              const copy = { ...block };
              if (copy.type === 'text') delete copy.textSignature;
              if (copy.type === 'reasoning') delete copy.thinkingSignature;
              if (copy.type === 'tool_call') delete copy.thoughtSignature;
              return copy;
            });
            message.toolCalls = message.toolCalls!.map(({ thoughtSignature: _signature, ...call }) => call);
          }
          const owned = structuredClone(message);
          await f.call(stream, { maxTokens: 64 }, [message]);
          const body = JSON.parse(String(f.fetch.mock.calls.at(-1)![1]?.body));
          const tool = { functionCall: { name: 'echo', args: { x: 1 }, ...(requiresIds ? { id: 'native-call' } : {}) } };
          const same = signedParts.map(part => part.functionCall ? { ...part, ...tool } : part);
          const unsigned = [{ text: 'left' }, { text: 'visible', ...(change === 'expurgated' ? { thought: true } : {}) }, tool, { text: 'right' }];
          expect(body.contents).toEqual(change === 'failed' ? [] : [{ role: 'model', parts: change === 'same' ? same : unsigned }]);
          expect(message).toEqual(owned);
        }
        expect(source).toEqual(before);
        const image: Message = { ...source, content: 'image answer', blocks: [{ type: 'text', text: 'image answer' },
          { type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,AA==' }], toolCalls: undefined };
        await f.call(stream, { maxTokens: 64 }, [image]);
        expect(JSON.parse(String(f.fetch.mock.calls.at(-1)![1]?.body)).contents).toEqual([{ role: 'model', parts: [
          { text: 'image answer' }, { inlineData: { mimeType: 'image/png', data: 'AA==' } },
        ] }]);
      }
    });
    it(`${scope}: refuses invalid responses or missing finishes without completing or publishing pending tools`, async () => {
      const f = fixture(scope, 'gemini-3.8-flash'), call = { functionCall: { name: 'read', args: {} } };
      const candidate = (finishReason?: string, parts: unknown = [call]) => ({ candidates: [{ content: { parts }, ...(finishReason === undefined ? {} : { finishReason }) }] });
      for (const data of [candidate(), null, [], {}, { error: { message: 'PRIVATE-vendor-error' } }, candidate('SAFETY'), candidate('RECITATION'),
        candidate('OTHER'), candidate('MALFORMED_FUNCTION_CALL'), { candidates: [{ finishReason: 'STOP' }, { finishReason: 'STOP' }] },
        { candidates: {} }, { candidates: [{ finishReason: 'STOP', content: [] }] },
        candidate('STOP', null), candidate('STOP', {}), candidate('STOP', [{ text: 23 }]),
        candidate('STOP', [{ text: 'PRIVATE', thought: 'true' }]), candidate('STOP', [{ text: '', thoughtSignature: 23 }]),
        candidate('STOP', [call, { functionCall: { name: 'read', args: 'PRIVATE-arguments' } }])]) {
        for (const stream of [false, true]) {
          const count = f.completed.length; f.chunks.length = 0;
          f.fetch.mockImplementationOnce(async () => reply(data, stream));
          await expect(f.call(stream, { thinking: 'high', maxTokens: 64 })).rejects.toThrow('Invalid Google response.');
          expect(f.completed).toHaveLength(count); expect(f.chunks.some(([, type]) => type === 'tool_call')).toBe(false);
        }
      }
      f.fetch.mockImplementationOnce(async () => reply(candidate('STOP'), true));
      expect((await f.call(true)).toolCalls).toMatchObject([{ name: 'read', input: {} }]);
      expect(f.chunks.filter(([, type]) => type === 'tool_call')).toHaveLength(1);
      const records = [candidate('STOP', [{ text: 'accepted' }]), candidate('STOP', [call])];
      f.fetch.mockImplementationOnce(async () => new Response(records.map(data => `data: ${JSON.stringify(data)}\n\n`).join('')));
      const count = f.completed.length; f.chunks.length = 0;
      await expect(f.call(true)).rejects.toThrow('Invalid Google response.');
      expect(f.completed).toHaveLength(count); expect(f.chunks.some(([, type]) => type === 'tool_call')).toBe(false);
    });
    it(`${scope}: retains signatures across streamed fragments and bounds completed rich history`, async () => {
      const f = fixture(scope, 'gemini-3.8-flash'), vector = continuationReference.fragments.find(row => row.scope === scope)!;
      const framesFromReference = continuationReference.fragmentParts.map((part, index, parts) => ({
        modelVersion: 'untrusted-response-alias', candidates: [{ content: { role: 'model', parts: [part] },
          ...(index === parts.length - 1 ? { finishReason: 'STOP' } : {}) }],
      }));
      f.fetch.mockImplementationOnce(async () => new Response(framesFromReference.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''),
        { headers: { 'Content-Type': 'text/event-stream' } }));
      const captured = await f.call(true, { maxTokens: 64, tools: continuationReference.tools });
      expect(captured.blocks).toEqual(continuationBlocks(vector.firstObserved.content));
      const messages: Message[] = [...input, { id: 'fragment', role: 'assistant', content: captured.content, blocks: captured.blocks,
        toolCalls: captured.toolCalls, provider: captured.provider, model: captured.model, api: captured.api, timestamp: new Date(0) },
      { id: 'result', role: 'tool', toolCallId: 'native-call', name: 'echo', content: 'result', isError: false, timestamp: new Date(0) }];
      const before = structuredClone(messages);
      await f.call(true, { maxTokens: 64, tools: continuationReference.tools }, messages);
      expect(JSON.parse(String(f.fetch.mock.calls.at(-1)![1]?.body)).contents).toEqual(vector.expectedContents);
      expect(messages).toEqual(before);
      const frames = [
        { candidates: [{ content: { parts: [{ text: 'left', thoughtSignature: 'bGVmdA==' }, { text: 'visible', thought: true, thoughtSignature: 'Zmlyc3Q=' }] } }] },
        { candidates: [{ content: { parts: [{ text: ' thought', thought: true }, { text: '', thought: true, thoughtSignature: 'bGFzdA==' }] } }] },
        { candidates: [{ content: { parts: [{ functionCall: { id: 'native-call', name: 'echo', args: {} }, thoughtSignature: 'dG9vbA==' },
          { text: '', thoughtSignature: 'ZW1wdHk=' }] } }] },
        { candidates: [{ finishReason: 'STOP' }] },
      ];
      f.fetch.mockImplementationOnce(async () => new Response(frames.map(data => `data: ${JSON.stringify(data)}\n\n`).join('')));
      const response = await f.call(true);
      expect(response).toMatchObject({ content: 'left', reasoning: 'visible thought', blocks: [
        { type: 'text', text: 'left', textSignature: 'bGVmdA==' }, { type: 'reasoning', text: 'visible thought', thinkingSignature: 'bGFzdA==' },
        { type: 'tool_call', id: 'native-call', name: 'echo', input: {}, thoughtSignature: 'dG9vbA==' },
        { type: 'text', text: '', textSignature: 'ZW1wdHk=' },
      ] });
      for (const opaque of ['bad', 'AAAA====', '=AA=']) {
        const message: Message = { id: 'invalid-signature', role: 'assistant', content: 'visible', timestamp: new Date(0),
          provider: response.provider, api: response.api, model: response.model,
          blocks: [{ type: 'text', text: 'visible', textSignature: opaque }, { type: 'reasoning', text: '', thinkingSignature: opaque }] };
        await f.call(false, {}, [message]);
        expect(JSON.parse(String(f.fetch.mock.calls.at(-1)![1]?.body)).contents).toEqual([{ role: 'model', parts: [{ text: 'visible' }] }]);
        expect(message.blocks?.[0]).toMatchObject({ textSignature: opaque });
      }
      const excessive = Array.from({ length: 1025 }, (_, index) => ({ candidates: [{ content: { parts: [{ text: '', thought: index % 2 === 0 }] } }] }));
      f.fetch.mockImplementationOnce(async () => new Response([...excessive, frames[3]].map(data => `data: ${JSON.stringify(data)}\n\n`).join('')));
      const completed = f.completed.length;
      await expect(f.call(true)).rejects.toThrow('The provider response exceeded the content-block limit.');
      expect(f.completed).toHaveLength(completed);
      for (const compatible of [true, false]) {
        const adapter = fixture(scope, compatible ? 'gemini-3.8-flash' : 'gemini-3.8-flash-unverified', compatible);
        adapter.parts(signedParts);
        for (const stream of [false, true]) {
          const legacy = await adapter.call(stream);
          expect(legacy.blocks).toBeUndefined(); expect(legacy.provider).toBeUndefined();
          expect(legacy.toolCalls).toEqual([{ id: 'gemini-2-echo', name: 'echo', input: { x: 1 } }]);
        }
      }
    });
    it(`${scope}: awaits native delivery and honours withdrawal before later buffered text/tools/completion`, async () => {
      const f = fixture(scope, 'gemini-3.8-flash'), abort = new AbortController(), complete = vi.fn(), error = vi.fn();
      const data = [{ candidates: [{ content: { parts: [{ text: 'before' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'NEVER' }, { functionCall: { name: 'read', args: {} } }] }, finishReason: 'STOP' }] }];
      f.fetch.mockImplementationOnce(async () => new Response(data.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')));
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
      const chunks: string[] = [];
      const pending = f.provider.streamChat(input, async text => { chunks.push(text); enter(); await held; }, complete, error,
        { thinking: 'high', maxTokens: 64, signal: abort.signal });
      await entered;
      expect(chunks).toEqual(['before']); expect(complete).not.toHaveBeenCalled();
      abort.abort(); release(); await pending;
      expect(chunks).toEqual(['before']); expect(complete).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledOnce();
      expect(error.mock.calls[0]?.[0].message).toBe('Gemini request aborted.');
      // Also withdraw while the next read is pending, with a fetch body that ignores its signal.
      const Native = scope === 'google' ? GeminiProvider : VertexGeminiProvider;
      const waitingProvider = new Native({ type: 'operator-alias', model: 'gemini-3.8-flash', apiKey: 'disposable', httpIdleTimeoutMs: 0 });
      const waitingAbort = new AbortController(), cancel = vi.fn(), waitingComplete = vi.fn(), waitingError = vi.fn();
      let bodyController!: ReadableStreamDefaultController<Uint8Array>, reading!: () => void;
      const pendingRead = new Promise<void>(resolve => { reading = resolve; });
      const body = new ReadableStream<Uint8Array>({
        start(controller) { bodyController = controller; controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: signedParts } }] })}\n\n`)); },
        pull() { reading(); return new Promise<void>(() => {}); }, cancel,
      }, { highWaterMark: 0 });
      f.fetch.mockImplementationOnce(async () => new Response(body));
      const waiting = waitingProvider.streamChat(input, vi.fn(), waitingComplete, waitingError, { signal: waitingAbort.signal });
      await pendingRead;
      try {
        waitingAbort.abort(); expect(cancel).toHaveBeenCalledOnce(); await waiting;
        expect(waitingComplete).not.toHaveBeenCalled(); expect(waitingError).toHaveBeenCalledOnce();
        expect(waitingError.mock.calls[0]?.[0].message).toBe('Gemini request aborted.');
      } finally { try { bodyController.close(); } catch { /* Already cancelled. */ } await waiting; }
    });
  }
});

describe('native original Google/Vertex signed durability', () => {
  for (const scope of ['google', 'google-vertex'] as const) for (const stream of [false, true]) {
    it(`${scope}: retains tool/final history through reload, guarded export, edit and physical routing (stream=${stream})`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-google-replay-'));
      const redactor = new CredentialRedactor(['c2VjcmV0']), redactText = (value: string) => redactor.redact(value);
      const redactJson = <T>(value: T): T => redactor.redactJson(value);
      const f = fixture(scope, 'gemini-3.8-flash', false, 'c2VjcmV0');
      const manager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson });
      const session = await manager.create({ title: 'Google native replay' }), registry = new ExtensionRegistry();
      const provider = scope === 'google' ? 'google' : 'vertex';
      const native = signedParts.map((part, index) => index === 0 ? { ...part, thoughtSignature: 'c2VjcmV0' } : part);
      let turn = 0, effects = 0;
      await registry.load('echo', api => api.registerTool({ name: 'echo', description: 'Echo', execute: () => { effects++; return { content: 'result' }; } }));
      const now = Date.now(), clock = vi.spyOn(Date, 'now');
      try {
        await manager.addMessage(session.id, { role: 'user', content: 'start' });
        await runToolLoop({ sessionManager: manager, sessionId: session.id, extensionRegistry: registry, provider,
          tools: [{ name: 'echo', description: 'Echo', parameters: { type: 'object' } }], toolContext: { sessionManager: manager, notify: () => {} },
          redactText, streamTurn: async messages => {
            clock.mockReturnValue(turn === 0 ? now + 60_000 : now);
            f.parts(turn++ === 0 ? native : native.filter(part => !part.functionCall));
            return stream ? streamProviderTurn({ provider: f.provider, providerName: provider, model: 'gemini-3.8-flash',
              messages, tools: [], extensionRegistry: registry, sessionManager: manager, sessionId: session.id,
              redactText, redactJson, createTextRedactor: () => redactor.createStream(), maxRetries: 0, maxTokens: 64, cacheRetention: 'none' })
              : f.call(false, { maxTokens: 64 }, messages);
          } });
        clock.mockRestore();
        expect(effects).toBe(1); expect(turn).toBe(2);
        const file = path.join(root, session.id + '.jsonl'), bytes = await readFile(file, 'utf8');
        expect(bytes).not.toContain('c2VjcmV0'); expect(bytes).toContain('[REDACTED]'); expect((await stat(file)).mode & 0o777).toBe(0o600);
        const history = session.messages.filter(message => message.role === 'assistant');
        expect(history[0].timestamp.getTime()).toBeGreaterThan(history[1].timestamp.getTime());
        const expected = signedBlocks.map((block, index) => index === 0 ? { ...block, textSignature: '[REDACTED]' } : block);
        expect(history.map(message => message.blocks)).toEqual([expected, expected.filter(block => block.type !== 'tool_call')]);
        expect(history.map(message => [message.provider, message.api, message.model])).toEqual(Array(2).fill([provider, f.provider.getModelApi(), 'gemini-3.8-flash']));
        const restarted = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson });
        const loaded = (await restarted.loadFromStore(session.id))!;
        expect(loaded.messages.filter(message => message.role === 'assistant').map(message => message.blocks)).toEqual(history.map(message => message.blocks));
        const ordinary = serializeSessionForExport(loaded), complete = serializeSessionForExport(loaded, { includeOpaqueContinuations: true });
        expect(ordinary.warning).toContain('Native continuation'); expect(JSON.stringify(ordinary.session)).not.toContain('Signature');
        expect(JSON.stringify(complete.session)).toContain('dGhvdWdodA=='); expect(JSON.stringify(complete.session)).not.toContain('c2VjcmV0');
        f.parts([{ text: 'next' }]);
        await f.call(stream, { maxTokens: 64 }, loaded.messages);
        const replay = JSON.parse(String(f.fetch.mock.calls.at(-1)![1]?.body)).contents.filter((content: { role: string }) => content.role === 'model');
        const retained: Array<Record<string, unknown>> = native.map((part, index) => index === 0 ? { text: 'left' } : part);
        expect(replay.map((content: { parts: unknown }) => content.parts)).toEqual([retained, retained.filter(part => !part.functionCall)]);
        expect(await readFile(file, 'utf8')).toBe(bytes);
        await restarted.appendContextEdit(session.id, { targetEntryId: history[0].id, replacement: 'edited answer' });
        const clone = await restarted.cloneSession(session.id);
        if (!clone) throw new Error('Expected an independent session clone.');
        const projected = restarted.getEffectiveContext(clone.id).flatMap((entry): Message[] => entry.type === 'message' ? [{ ...entry, timestamp: new Date(entry.timestamp) }] : []);
        await f.call(stream, { maxTokens: 64 }, projected);
        const edited = JSON.parse(String(f.fetch.mock.calls.at(-1)![1]?.body)).contents.filter((content: { role: string }) => content.role === 'model');
        expect(edited[0].parts).toEqual([{ functionCall: { id: 'native-call', name: 'echo', args: { x: 1 } }, thoughtSignature: 'dG9vbA==' }, { text: 'edited answer' }]);
        expect(edited[1].parts).toEqual(retained.filter(part => !part.functionCall));
        expect((await restarted.getRawEntries(session.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant').map(entry => entry.blocks))
          .toEqual(history.map(message => message.blocks));
        expect(clone.messages.filter(message => message.role === 'assistant').map(message => message.blocks)).toEqual(history.map(message => message.blocks));
        registry.virtualModels.register({ provider: 'router', id: 'auto', maxOutputTokens: 64,
          route: () => ({ provider, id: 'gemini-2.5-flash' }) });
        await streamProviderTurn({ provider: registry.getVirtualProvider('router')!, providerName: 'router', model: 'auto', messages: loaded.messages,
          tools: [], extensionRegistry: registry, resolveProvider: name => name === provider ? f.provider : undefined, maxRetries: 0 });
        const foreign = JSON.parse(String(f.fetch.mock.calls.at(-1)![1]?.body)).contents;
        expect(JSON.stringify(foreign)).not.toContain('thoughtSignature'); expect(JSON.stringify(foreign)).toContain('visible');
        expect(native[0].thoughtSignature).toBe('c2VjcmV0');
        const canonical = getCompactionModelMessages(restarted, clone.id), beforeSummary = structuredClone(canonical);
        expect(JSON.stringify(getSummaryModelMessages(canonical))).not.toMatch(/Signature|opaque-/);
        expect(canonical).toEqual(beforeSummary);
        const kept = clone.messages.filter(message => message.role === 'assistant').at(-1)!;
        const sourceBytes = await readFile(file, 'utf8');
        await restarted.applyCompaction(clone.id, 'PUBLIC_COMPACTED_PREFIX', kept.id);
        const compactedManager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson });
        const compactedSession = (await compactedManager.loadFromStore(clone.id))!;
        const compacted = getCompactionModelMessages(compactedManager, clone.id);
        expect(compactedSession.metadata?.compactionSummary).toBe('PUBLIC_COMPACTED_PREFIX');
        expect(compacted.some(message => message.content.includes('PUBLIC_COMPACTED_PREFIX'))).toBe(true);
        expect(compacted.filter(message => message.role === 'assistant').map(message => message.blocks)).toEqual([expected.filter(block => block.type !== 'tool_call')]);
        expect(compacted.filter(message => message.role === 'tool')).toEqual([]);
        const raw = await compactedManager.getRawEntries(clone.id);
        expect(raw).toContainEqual(expect.objectContaining({ type: 'compaction', firstKeptEntryId: kept.id, summary: 'PUBLIC_COMPACTED_PREFIX' }));
        // A copy may persist in timestamp order; raw membership is not active ancestry.
        const retainedHistory = raw.filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant');
        expect(retainedHistory).toHaveLength(2);
        expect(retainedHistory.map(entry => entry.blocks)).toEqual(expect.arrayContaining(history.map(message => message.blocks)));
        const ancestry = (await compactedManager.getActiveBranchEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant');
        expect(ancestry.map(entry => entry.blocks)).toEqual(history.map(message => message.blocks));
        const compactedFile = path.join(root, clone.id + '.jsonl'), compactedBytes = await readFile(compactedFile, 'utf8');
        expect((await stat(compactedFile)).mode & 0o777).toBe(0o600);
        await f.call(stream, { maxTokens: 64 }, compacted);
        const compactedReplay = JSON.parse(String(f.fetch.mock.calls.at(-1)![1]?.body)).contents.filter((content: { role: string }) => content.role === 'model');
        expect(compactedReplay.map((content: { parts: unknown }) => content.parts)).toEqual([retained.filter(part => !part.functionCall)]);
        expect(await readFile(compactedFile, 'utf8')).toBe(compactedBytes);
        expect(await readFile(file, 'utf8')).toBe(sourceBytes);
        expect(effects).toBe(1);
      } finally { clock.mockRestore(); await registry.shutdown(); await rm(root, { recursive: true, force: true }); }
    });
  }
});

describe('original Google/Vertex through the shared physical turn', () => {
  for (const scope of ['google', 'google-vertex'] as const) {
    it(`${scope}: does not fill unknown unattributed cost from a legacy provider-name price`, async () => {
      const f = fixture(scope, 'gemini-2.5-pro'), registry = new ExtensionRegistry();
      const turn = () => streamProviderTurn({ provider: f.provider, providerName: 'google', model: 'gemini-2.5-pro',
        messages: input, tools: [], extensionRegistry: registry, cacheRetention: 'none' });
      try {
        f.usage({ ...observed, totalTokenCount: 18 });
        const uncertain = await turn();
        expect(uncertain.usage).toMatchObject({ promptTokens: 8, completionTokens: 5, cacheReadTokens: 4, totalTokens: 18 });
        expect(uncertain.usage?.costUsd).toBeUndefined();
        f.usage(observed);
        expect((await turn()).usage?.costUsd).toBeCloseTo(0.0000605, 12);
      } finally { await registry.shutdown(); }
    });
    it(`${scope}: delivers visible reasoning through the awaited shared reasoning observer`, async () => {
      const f = fixture(scope, 'gemini-2.5-pro'), registry = new ExtensionRegistry(), reasoning: string[] = [], text: string[] = [];
      f.fetch.mockImplementationOnce(async () => new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts:
        [{ text: 'thought', thought: true }, { text: 'answer' }] }, finishReason: 'STOP' }], usageMetadata: observed })}\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } }));
      try {
        const response = await streamProviderTurn({ provider: f.provider, providerName: 'google', model: 'gemini-2.5-pro', messages: input, tools: [],
          extensionRegistry: registry, cacheRetention: 'none', onReasoningDelta: async delta => { reasoning.push(delta); }, onTextDelta: async delta => { text.push(delta); } });
        expect(reasoning).toEqual(['thought']); expect(text).toEqual(['answer']);
        expect(response).toMatchObject({ content: 'answer', reasoning: 'thought' });
      } finally { await registry.shutdown(); }
    });
  }
  it('preserves legacy complete-component fallback and explicitly observed cost despite unattributed tokens', async () => {
    const provider = new MockProvider({ type: 'mock' }), registry = new ExtensionRegistry();
    try {
      for (const costUsd of [undefined, 0.1]) {
        vi.spyOn(provider, 'streamChat').mockImplementationOnce(async (_messages, chunk, complete) => {
          await chunk('ok'); complete?.({ content: 'ok', model: 'gemini-2.5-pro', usage: { promptTokens: 8, completionTokens: 5,
            cacheReadTokens: 4, totalTokens: costUsd === undefined ? 17 : 18, ...(costUsd === undefined ? {} : { costUsd }) } });
        });
        const response = await streamProviderTurn({ provider, providerName: 'google', model: 'gemini-2.5-pro', messages: input, tools: [],
          extensionRegistry: registry, cacheRetention: 'none' });
        expect(response.usage?.costUsd).toBeCloseTo(costUsd ?? 0.0000605, 12);
      }
    } finally { await registry.shutdown(); }
  });
});
