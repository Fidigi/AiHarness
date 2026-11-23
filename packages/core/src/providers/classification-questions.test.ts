import { describe, expect, it, vi } from 'vitest';
import { MockProvider } from './index.js';
import { SpecializedModels } from './specialized-models.js';
import { copyQuestionAnswers, copyQuestionClassificationRequest, type QuestionClassificationRequest } from './classification-questions.js';
import { runCodemode } from '../tools/codemode.js';
import type { ExtensionRuntimeContext } from '../extensions/extension-registry.js';

const request: QuestionClassificationRequest = { model: 'fixture:classifier', state: { approved: true, level: 2 }, questions: {
  approved: { type: 'boolean', prompt: 'Approved?' },
  category: { type: 'choice', prompt: 'Select category', choices: ['safe', 'unsafe'] },
  level: { type: 'score', prompt: 'Select level', values: [0, 1, 2] },
} };
const answers = {
  approved: { value: true, probabilities: [{ value: true, probability: 0.9 }, { value: false, probability: 0.1 }] },
  category: { value: 'safe', probabilities: [{ value: 'safe', probability: 0.75 }, { value: 'unsafe', probability: 0.25 }] },
  level: { value: 2, probabilities: [{ value: 0, probability: 0 }, { value: 1, probability: 0.25 }, { value: 2, probability: 0.75 }] },
};

describe('native finite-domain classifier questions', () => {
  it('supports boolean, choice and finite scores over owned JSON state through the public bridge and guest', async () => {
    const provider = new MockProvider({ type: 'mock', model: 'fixture' });
    const chat = vi.spyOn(provider, 'chat').mockResolvedValue({ content: JSON.stringify({ answers }),
      usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4, costUsd: 0.002 } });
    const bridge = new SpecializedModels(provider);
    expect(await bridge.classifyQuestions(request)).toEqual({ answers, usage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 4, costUsd: 0.002 } });
    expect(chat.mock.calls[0]?.[0][0]?.content).toBe(JSON.stringify(request.state));
    expect(chat.mock.calls[0]?.[1]).toMatchObject({ tools: [], temperature: 0, systemPrompt: expect.stringContaining('not calibrated') });
    const result = await runCodemode({ code: `text((await models.classifyQuestions(${JSON.stringify(request)})).answers.approved.value); store('ok',true);`,
      context: { provider } as ExtensionRuntimeContext, tools: () => [], execute: vi.fn() });
    expect(result.isError).toBe(false); expect(result.content).toContain('\ntrue');
    expect(result.details).toMatchObject({ costComplete: true, usage: { totalTokens: 4, costUsd: 0.002 }, nestedCalls: [{ kind: 'classifier', state: 'completed' }], store: { ok: true } });
    expect(result.details?.nestedCalls).toHaveLength(1); expect(chat).toHaveBeenCalledTimes(2);
    const failed = await runCodemode({ code: `store('bad',true); await models.classifyQuestions(${JSON.stringify(request)}); throw Error('after classification');`,
      context: { provider } as ExtensionRuntimeContext, tools: () => [], execute: vi.fn() });
    expect(failed.isError).toBe(true); expect(failed.details?.store).toBeUndefined();
    expect(failed.details?.usage?.totalTokens).toBe(4); expect(chat).toHaveBeenCalledTimes(3);
  });

  it('rejects missing, duplicate, foreign, unnormalized or nonfinite distributions rather than inventing them', () => {
    expect(copyQuestionAnswers(answers, request.questions)).toEqual(answers);
    for (const malformed of [undefined, {}, { ...answers, foreign: answers.approved },
      ...[[], [{ value: true, probability: 1 }], [{ value: true, probability: 0.5 }, { value: true, probability: 0.5 }],
        [{ value: true, probability: 0.5 }, { value: false, probability: 0.6 }],
        [{ value: true, probability: -1 }, { value: false, probability: 2 }],
        [{ value: true, probability: NaN }, { value: false, probability: 1 }]]
        .map(probabilities => ({ ...answers, approved: { value: true, probabilities } })),
    ]) expect(() => copyQuestionAnswers(malformed, request.questions)).toThrow();
  });

  it('bounds and copies question/state input, rejects foreign credential/options fields and keeps labels separate', () => {
    const copied = copyQuestionClassificationRequest(request);
    expect(copied).toEqual(request); expect(copied.state).not.toBe(request.state); expect(copied.questions).not.toBe(request.questions);
    for (const malformed of [{ ...request, apiKey: 'forbidden' }, { ...request, options: {} }, { ...request, state: 'x'.repeat(32769) },
      { ...request, questions: {} }, { ...request, questions: { q: { type: 'probability', prompt: 'x' } } },
      { ...request, questions: { q: { type: 'choice', prompt: 'x', choices: ['x', 'x'] } } },
      { ...request, questions: { q: { type: 'score', prompt: 'x', values: [1, Infinity] } } },
      { ...request, questions: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`q${i}`, request.questions.approved])) },
    ]) expect(() => copyQuestionClassificationRequest(malformed)).toThrow();
  });

  it('revalidates transformed questions/capabilities, bounds cancellation and never dispatches withdrawn calls', async () => {
    const provider = new MockProvider({ type: 'mock', model: 'fixture' });
    const execute = vi.spyOn(provider, 'classifyQuestions');
    const invalid = new SpecializedModels(provider, undefined, async () => ({ ...request, questions: {} }));
    await expect(invalid.classifyQuestions(request)).rejects.toThrow('operation failed');
    const revoked = new SpecializedModels(provider, undefined, async (_type, input) => { provider.setConfiguredModel('replacement'); return input; });
    await expect(revoked.classifyQuestions(request)).rejects.toThrow('operation failed');
    expect(execute).not.toHaveBeenCalled(); provider.setConfiguredModel('fixture');
    const controller = new AbortController();
    const work = new SpecializedModels(provider, undefined, () => new Promise(() => {})).classifyQuestions(request, { signal: controller.signal });
    controller.abort(); await expect(work).rejects.toThrow('cancelled'); expect(execute).not.toHaveBeenCalled();
    let received: AbortSignal | undefined;
    execute.mockImplementation(async (_request, options) => { received = options?.signal; return new Promise(() => {}); });
    const dispatched = new AbortController();
    const pending = new SpecializedModels(provider).classifyQuestions(request, { signal: dispatched.signal });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    dispatched.abort(); await expect(pending).rejects.toThrow('cancelled'); expect(received?.aborted).toBe(true);
  });
});
