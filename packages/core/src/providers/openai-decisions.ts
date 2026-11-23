import type { GeneratedImage } from './specialized-models.js';

/** Reviewed pinned classifier profile; base descriptor prices and strict all-input tier threshold. */
export const OPENAI_DECISIONS_MODEL = Object.freeze({ id: 'gpt-6-luna', type: 'classifier' as const, name: 'GPT-6 Luna',
  api: 'openai-decisions', imageInput: true, contextWindow: 922_000,
  pricing: Object.freeze({ inputPerMillion: 0.1, outputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0 }),
  pricingTiers: Object.freeze([Object.freeze({ inputTokensAbove: 272_000, inputPerMillion: 0.2, outputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0 })]),
});

export interface NativeWireQuestion { type: string; instructions: string; criteria: Record<string, string> | string[] }

/** State is JSON text, never a chat prompt; predicates do not accept a criteria field. */
export function decisionsBody(model: string, state: unknown, questions: Record<string, NativeWireQuestion>, images?: GeneratedImage[]): object {
  const text = JSON.stringify(state);
  return { model, input: images?.length ? [{ role: 'user', content: [{ type: 'input_text', text },
    ...images.map(image => ({ type: 'input_image', image_url: `data:${image.mediaType};base64,${image.data}` }))] }] : text,
    questions: Object.entries(questions).map(([name, question]) => {
      if (question.type === 'choice') return { name, type: 'choice', instructions: question.instructions,
        choices: Object.entries(question.criteria).map(([value, description]) => ({ value, ...(description ? { description } : {}) })) };
      if (question.type === 'score') return { name, type: 'score', instructions: question.instructions,
        levels: (question.criteria as string[]).map(label => ({ label })) };
      const criteria = question.criteria as Record<string, string>;
      const meanings = [criteria.true ? `True means: ${criteria.true}` : '', criteria.false ? `False means: ${criteria.false}` : ''].filter(Boolean);
      return { name, type: 'predicate', instructions: meanings.length ? `${question.instructions}\n\n${meanings.join('\n')}` : question.instructions };
    }),
  };
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function invalid(): never { throw new Error('Invalid OpenAI Decisions response.'); }

/** Normalize only the envelope; shared validation still requires complete finite/native answers. */
export function decisionsAnswers(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || !value.length || value.length > 16) invalid();
  const names = new Set<string>();
  return Object.fromEntries(value.map(answer => {
    if (!record(answer) || typeof answer.name !== 'string' || names.has(answer.name)) invalid();
    names.add(answer.name);
    if (answer.type === 'predicate') return [answer.name, { type: 'noul', noul: answer.probability }];
    if (answer.type === 'choice') {
      if (!Array.isArray(answer.probabilities) || answer.probabilities.length > 100) invalid();
      const labels = new Set<string>();
      const pairs = answer.probabilities.map(item => {
        if (!record(item) || typeof item.value !== 'string' || labels.has(item.value)) invalid();
        labels.add(item.value); return [item.value, item.probability];
      });
      return [answer.name, { ...answer, probabilities: Object.fromEntries(pairs) }];
    }
    if (answer.type !== 'score') invalid();
    return [answer.name, answer];
  }));
}
