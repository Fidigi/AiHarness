import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubCopilotProvider } from './index.js';
import { buildProviderModelCatalog, collectProviderModelCatalog, flattenModelCatalog } from './model-catalog.js';
import { getProviderPublishedModels } from './provider-model-metadata.js';
import type { Message } from '../types/index.js';
import type { ProviderOAuthCredential } from './credentials.js';
import { GITHUB_COPILOT_MODELS, githubCopilotAccountModels, githubCopilotHeaders, githubCopilotModel, githubCopilotRoute, type GitHubCopilotModel } from './github-copilot.js';

const fixture = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/github-copilot-routing-reference.json', import.meta.url), 'utf8')) as {
  models: GitHubCopilotModel[];
  rows: { model: string; api: string; case: string; expectedPath: string; expectedHeaders: Record<string, string> }[];
};
const message = (role: Message['role'], image = false): Message => ({ id: 'probe', role, content: 'probe', timestamp: new Date(0),
  ...(image ? { blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,cHJvYmU=' }] } : {}) });

afterEach(() => vi.restoreAllMocks());

describe('GitHub Copilot catalogue and request intent', () => {
  it('publishes owned context/capability metadata without interpreting API list prices as subscription billing', () => {
    const provider = new GitHubCopilotProvider({ type: 'operator-alias', model: 'gpt-5-mini' }, async () => undefined);
    const expected = fixture.models.map(model => ({ id: model.id, name: model.name, api: model.api,
      contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens,
      capabilities: { reasoning: model.reasoning, imageInput: model.input.includes('image'), toolCalls: true },
      ...(model.reasoning ? model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {} : { thinkingLevelMap: null }),
    }));
    const actual = getProviderPublishedModels(provider);
    expect(actual).toEqual(expected);
    actual![0].capabilities.imageInput = false;
    actual![0].contextWindow = 1;
    if (actual![0].thinkingLevelMap) actual![0].thinkingLevelMap.off = 'forged';
    expect(getProviderPublishedModels(provider)).toEqual(expected);
    expect(actual!.every(model => model.pricing === undefined && model.promptCache === undefined)).toBe(true);
  });

  it('requires fresh account discovery for availability and fails closed offline, after logout, or on discovery failure', async () => {
    let current: ProviderOAuthCredential | undefined = { version: 1, type: 'oauth', accessToken: 'disposable-copilot', expiresAt: Date.now() + 60000,
      subscription: { provider: 'github-copilot', availableModelIds: ['gpt-5-mini', 'unknown'] } };
    const source = vi.fn(async () => current), provider = new GitHubCopilotProvider({ type: 'github-copilot', model: 'gpt-5-mini' }, source);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
    const collect = async (discover: boolean) => flattenModelCatalog(await collectProviderModelCatalog(new Map([['operator-alias', provider]]), { discover }));
    const offline = await collect(false);
    expect(offline).toHaveLength(35);
    expect(offline.every(model => !model.available)).toBe(true);
    expect(source).not.toHaveBeenCalled();
    expect((await collect(true)).filter(model => model.available).map(model => model.id)).toEqual(['gpt-5-mini']);
    expect((await collect(false)).every(model => !model.available)).toBe(true);
    current = undefined;
    expect((await collect(true)).every(model => !model.available)).toBe(true);
    source.mockRejectedValueOnce(new Error('private-credential-failure'));
    const failed = await collect(true);
    expect(failed.every(model => !model.available)).toBe(true);
    expect(source).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(failed)).not.toMatch(/private-credential-failure|disposable-copilot/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not expose expired subscription models as available even if the credential source returns a stale value', async () => {
    const provider = new GitHubCopilotProvider({ type: 'github-copilot', model: 'gpt-5-mini' }, async () => ({
      version: 1, type: 'oauth', accessToken: 'disposable-expired', expiresAt: Date.now() - 1,
      subscription: { provider: 'github-copilot', availableModelIds: ['gpt-5-mini'] },
    }));
    const catalog = flattenModelCatalog(await collectProviderModelCatalog(new Map([['github-copilot', provider]])));
    expect(catalog.every(model => !model.available)).toBe(true);
  });

  it('does not let configured/custom entries bypass authoritative discovery, while retaining ordinary catalogue behavior', () => {
    const state = { provider: 'subscription', configured: true, configuredModel: 'hidden', discoveryAuthoritative: true, discoveredModels: ['visible'] };
    const custom = [{ key: 'subscription:custom', provider: 'subscription', id: 'custom', name: 'Custom', createdAt: '2026-01-01', updatedAt: '2026-01-01', capabilities: { reasoning: false, imageInput: false, toolCalls: true } }];
    const rows = flattenModelCatalog(buildProviderModelCatalog([state], custom));
    expect(rows.filter(model => model.available).map(model => model.id)).toEqual(['visible']);
    const ordinary = { ...state, discoveryAuthoritative: false };
    expect(flattenModelCatalog(buildProviderModelCatalog([ordinary], custom)).every(model => model.available)).toBe(true);
  });
  it('binds all 35 declarations and their A/C/R identities to the independently executed Copilot SDK', () => {
    expect(GITHUB_COPILOT_MODELS).toEqual(fixture.models);
    expect(GITHUB_COPILOT_MODELS).toHaveLength(35);
    expect(fixture.rows).toHaveLength(210);
    for (const row of fixture.rows) expect(githubCopilotModel(row.model).api).toBe(row.api);
    expect(() => githubCopilotModel('gpt-4o')).toThrow('GitHub Copilot model is not supported.');
    expect(() => githubCopilotModel('__proto__')).toThrow('GitHub Copilot model is not supported.');
  });

  it('intersects account visibility with the pinned catalogue without changing API identity or adding aliases', () => {
    expect(githubCopilotAccountModels([])).toEqual([]);
    const result = githubCopilotAccountModels(['gpt-5-mini', 'claude-fable-5', 'gpt-5-mini', 'unknown', '__proto__']);
    expect(result.map(model => [model.id, model.api])).toEqual([
      ['claude-fable-5', 'anthropic-messages'], ['gpt-5-mini', 'openai-responses'],
    ]);
    expect(GITHUB_COPILOT_MODELS).toHaveLength(35);
  });

  it('routes every admitted account model to its captured protocol on the credential-selected Copilot tier', () => {
    const credential: ProviderOAuthCredential = { version: 1, type: 'oauth', accessToken: 'tid=probe;proxy-ep=proxy.business.githubcopilot.com', expiresAt: 1000,
      subscription: { provider: 'github-copilot', availableModelIds: GITHUB_COPILOT_MODELS.map(model => model.id) } };
    const before = structuredClone(credential);
    for (const row of fixture.rows) {
      const route = githubCopilotRoute(credential, row.model, 0);
      expect(route.url).toBe('https://api.business.githubcopilot.com' + row.expectedPath);
      expect(route.model.id).toBe(row.model); expect(route.model.api).toBe(row.api);
    }
    expect(credential).toEqual(before);
  });

  it('refuses expired, non-subscription and unavailable models rather than inferring access from a label', () => {
    const credential: ProviderOAuthCredential = { version: 1, type: 'oauth', accessToken: 'disposable-token', expiresAt: 1000,
      subscription: { provider: 'github-copilot', availableModelIds: ['gpt-5-mini', 'unknown'] } };
    expect(() => githubCopilotRoute(credential, 'gpt-5-mini', 1000)).toThrow('GitHub Copilot subscription or model is unavailable.');
    expect(() => githubCopilotRoute({ ...credential, subscription: undefined }, 'gpt-5-mini', 0)).toThrow('GitHub Copilot subscription or model is unavailable.');
    expect(() => githubCopilotRoute(credential, 'claude-fable-5', 0)).toThrow('GitHub Copilot subscription or model is unavailable.');
    expect(() => githubCopilotRoute(credential, 'unknown', 0)).toThrow('GitHub Copilot model is not supported.');
    expect(() => githubCopilotRoute({ ...credential, accessToken: 'proxy-ep=evil.example' }, 'gpt-5-mini', 0)).toThrow('Invalid GitHub Copilot token endpoint.');
  });

  it('does not expose mutable route, pricing, compatibility or image-limit declarations', () => {
    const model = githubCopilotModel('claude-fable-5');
    for (const [object, key, value] of [[model, 'api', 'openai-responses'], [model.input, '0', 'foreign'],
      [model.cost, 'input', 0], [model.compat!, 'forceAdaptiveThinking', false], [model.thinkingLevelMap!, 'off', 'none'],
      [model.inputLimits!.images.resize, 'maxBytes', 1], [model.headers, 'User-Agent', 'foreign']] as const) {
      expect(Reflect.set(object, key, value)).toBe(false);
    }
    expect(model).toEqual(fixture.models[0]);
  });

  it.each(['anthropic-messages', 'openai-completions', 'openai-responses'])('matches captured Copilot identity and logical-message intent for %s', api => {
    for (const row of fixture.rows.filter(row => row.api === api)) {
      const messages = [message('user', row.case === 'user-image')];
      if (row.case === 'agent' || row.case === 'tool-image') messages.push(message('assistant'), message('tool', row.case === 'tool-image'));
      const before = structuredClone(messages);
      const headers = githubCopilotHeaders('disposable-copilot-routing-reference', messages);
      const actual = Object.fromEntries(Object.entries(headers).filter(([name]) => name !== 'Content-Type').map(([name, value]) => [name.toLowerCase(), value]));
      const expected = Object.fromEntries(Object.entries(row.expectedHeaders).filter(([name]) => !name.startsWith('anthropic-')));
      expect(actual).toEqual(expected);
      expect(headers['Content-Type']).toBe('application/json');
      expect(messages).toEqual(before);
    }
  });

  it('does not mistake assistant/system image blocks for vision input or let earlier turns determine initiator', () => {
    const headers = githubCopilotHeaders('disposable-token', [message('system', true), message('assistant', true), message('user')]);
    expect(headers['X-Initiator']).toBe('user');
    expect(headers['Copilot-Vision-Request']).toBeUndefined();
    expect(githubCopilotHeaders('disposable-token', [])['X-Initiator']).toBe('user');
  });

  it.each(['', 'bad\nheader', 'bad token'])('refuses invalid bearer tokens before constructing request headers (%j)', token => {
    expect(() => githubCopilotHeaders(token, [])).toThrow('Invalid GitHub Copilot token.');
  });
});
