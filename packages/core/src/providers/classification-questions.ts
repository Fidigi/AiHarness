import { copySessionCustomValue } from '../sessions/session-custom-data.js';
import type { GeneratedImage } from './specialized-models.js';
import { validateGeneratedImages, SPECIALIZED_MODEL_LIMITS } from './specialized-models.js';
import type { TokenUsage } from '../types/index.js';

/** Native finite-domain questions. Probabilities are model-reported, not calibrated confidence. */
export type ClassificationQuestion = { prompt: string } & (
  { type: 'choice'; choices: string[] } | { type: 'boolean' } | { type: 'score'; values: number[] }
);
export interface QuestionClassificationRequest {
  model: string;
  state: unknown;
  questions: Record<string, ClassificationQuestion>;
  images?: GeneratedImage[];
}
export interface QuestionClassificationResult {
  answers: Record<string, { value: string | number | boolean; probabilities: Array<{ value: string | number | boolean; probability: number }> }>;
  usage?: TokenUsage;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function questionValues(question: ClassificationQuestion): Array<string | number | boolean> {
  return question.type === 'boolean' ? [true, false] : question.type === 'choice' ? question.choices : question.values;
}
export function copyQuestionClassificationRequest(value: unknown): QuestionClassificationRequest {
  const invalid = (): never => { throw new Error('Invalid question classification request.'); };
  if (!record(value) || Object.keys(value).some(key => !['model', 'state', 'questions', 'images'].includes(key))
    || typeof value.model !== 'string' || !value.model || Buffer.byteLength(value.model) > 500 || !Object.hasOwn(value, 'state')) return invalid();
  const state = copySessionCustomValue(value.state, SPECIALIZED_MODEL_LIMITS.inputBytes);
  const questions = copySessionCustomValue(value.questions, SPECIALIZED_MODEL_LIMITS.inputBytes);
  if (!record(questions) || !Object.keys(questions).length || Object.keys(questions).length > 16) return invalid();
  for (const [id, question] of Object.entries(questions)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u.test(id) || !record(question)
      || typeof question.prompt !== 'string' || !question.prompt || Buffer.byteLength(question.prompt) > 4096) return invalid();
    const fields = question.type === 'choice' ? ['type', 'prompt', 'choices'] : question.type === 'score' ? ['type', 'prompt', 'values'] : ['type', 'prompt'];
    if (!['choice', 'boolean', 'score'].includes(String(question.type)) || Object.keys(question).some(key => !fields.includes(key))) return invalid();
    const values = questionValues(question as ClassificationQuestion);
    if (!Array.isArray(values) || values.length < 2 || values.length > 16 || new Set(values).size !== values.length
      || (question.type === 'choice' && !values.every(item => typeof item === 'string' && item.length > 0 && Buffer.byteLength(item) <= 500))
      || (question.type === 'score' && !values.every(item => typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 1_000_000))) return invalid();
  }
  if (Buffer.byteLength(JSON.stringify({ state, questions })) > SPECIALIZED_MODEL_LIMITS.inputBytes) return invalid();
  return { model: value.model, state, questions: questions as Record<string, ClassificationQuestion>,
    ...(value.images === undefined ? {} : { images: validateGeneratedImages(value.images) }) };
}

/** Require one complete normalized finite distribution per question; never manufacture probabilities. */
export function copyQuestionAnswers(value: unknown, questions: QuestionClassificationRequest['questions']): QuestionClassificationResult['answers'] {
  const invalid = (): never => { throw new Error('Invalid question classification result.'); };
  const copied = copySessionCustomValue(value, SPECIALIZED_MODEL_LIMITS.inputBytes);
  if (!record(copied) || Object.keys(copied).length !== Object.keys(questions).length) return invalid();
  for (const [id, question] of Object.entries(questions)) {
    const answer = copied[id], values = questionValues(question);
    if (!record(answer) || Object.keys(answer).some(key => !['value', 'probabilities'].includes(key))
      || !values.some(value => value === answer.value) || !Array.isArray(answer.probabilities) || answer.probabilities.length !== values.length) return invalid();
    const seen = new Set<unknown>(); let total = 0;
    for (const item of answer.probabilities) {
      if (!record(item) || Object.keys(item).some(key => !['value', 'probability'].includes(key))
        || !values.some(value => value === item.value) || seen.has(item.value) || typeof item.probability !== 'number'
        || !Number.isFinite(item.probability) || item.probability < 0 || item.probability > 1) return invalid();
      seen.add(item.value); total += item.probability;
    }
    if (Math.abs(total - 1) > 0.000001) return invalid();
  }
  return copied as unknown as QuestionClassificationResult['answers'];
}
