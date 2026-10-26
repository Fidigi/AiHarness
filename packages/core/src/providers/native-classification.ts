import { copySessionCustomValue } from '../sessions/session-custom-data.js';
import { SPECIALIZED_MODEL_LIMITS, type GeneratedImage } from './specialized-models.js';
import type { TokenUsage } from '../types/index.js';

/** Detailed native questions; scalar confidence is not a finite-domain distribution. */
export type NativeClassifierQuestion = { instructions: string } & (
  { type: 'choice'; criteria: Record<string, string> }
  | { type: 'score'; criteria: string[] }
  | { type: 'bool'; criteria: { true: string; false: string } }
);
export interface NativeClassifierRequest {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, NativeClassifierQuestion>;
  images?: GeneratedImage[];
}
export type NativeClassifierAnswer = { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; confidence: number }
  | { type: 'bool'; probability: number };
export interface NativeClassifierResult {
  api: string;
  provider: string;
  model: string;
  answers: Record<string, NativeClassifierAnswer>;
  usage?: TokenUsage;
  stopReason: 'stop' | 'error' | 'aborted';
  errorMessage?: string;
  timestamp: number;
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, limit: number): value is string { return typeof value === 'string' && Buffer.byteLength(value) <= limit; }
function invalidRequest(): never { throw new Error('Invalid native classifier request.'); }
function invalidResponse(): never { throw new Error('Invalid System One response.'); }
const probability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/** Own all JSON before I/O; never evaluate request getters or retain caller arrays. */
export function copyNativeClassifierRequest(value: unknown): NativeClassifierRequest {
  let copied: unknown;
  try { copied = copySessionCustomValue(value, SPECIALIZED_MODEL_LIMITS.inputBytes); } catch { invalidRequest(); }
  if (!record(copied) || Object.keys(copied).some(key => !['model', 'state', 'questions', 'images'].includes(key))
    || !text(copied.model, 500) || !copied.model.trim() || !record(copied.state) || !record(copied.questions)) invalidRequest();
  const entries = Object.entries(copied.questions);
  if (!entries.length || entries.length > 16) invalidRequest();
  for (const [id, question] of entries) {
    if (!id || !text(id, 500) || !record(question) || Object.keys(question).some(key => !['type', 'instructions', 'criteria'].includes(key))
      || !text(question.instructions, 4096)) invalidRequest();
    if (question.type === 'score') {
      if (!Array.isArray(question.criteria) || !question.criteria.length || question.criteria.length > 100
        || !question.criteria.every(item => text(item, 4096))) invalidRequest();
    } else if (question.type === 'choice' || question.type === 'bool') {
      if (!record(question.criteria)) invalidRequest();
      const criteria = Object.entries(question.criteria);
      if (!criteria.length || criteria.length > 100 || criteria.some(([name, description]) => !name || !text(name, 500) || !text(description, 4096))) invalidRequest();
      if (question.type === 'bool' && (criteria.length !== 2 || !Object.hasOwn(question.criteria, 'true') || !Object.hasOwn(question.criteria, 'false'))) invalidRequest();
    } else invalidRequest();
  }
  if (copied.images !== undefined && !Array.isArray(copied.images)) invalidRequest();
  return copied as unknown as NativeClassifierRequest;
}

/** Admit complete native answers without manufacturing a scalar-score probability table. */
export function parseSystemOneAnswers(value: unknown, questions: NativeClassifierRequest['questions']): NativeClassifierResult['answers'] {
  if (!record(value) || Object.keys(value).length !== Object.keys(questions).length) invalidResponse();
  return Object.fromEntries(Object.entries(questions).map(([id, question]): [string, NativeClassifierAnswer] => {
    const answer = Object.hasOwn(value, id) ? value[id] : undefined;
    if (!record(answer)) invalidResponse();
    if (question.type === 'bool') {
      if (answer.type !== 'noul' || !probability(answer.noul)) invalidResponse();
      return [id, { type: 'bool', probability: answer.noul }];
    }
    if (!probability(answer.confidence)) invalidResponse();
    if (question.type === 'score') {
      if (answer.type !== 'score' || typeof answer.score !== 'number' || !Number.isFinite(answer.score)) invalidResponse();
      return [id, { type: 'score', score: answer.score, confidence: answer.confidence }];
    }
    const names = Object.keys(question.criteria), probabilities = answer.probabilities;
    if (answer.type !== 'choice' || typeof answer.choice !== 'string' || !Object.hasOwn(question.criteria, answer.choice)
      || !record(probabilities) || Object.keys(probabilities).length !== names.length) invalidResponse();
    const pairs = names.map(name => {
      const item = Object.hasOwn(probabilities, name) ? probabilities[name] : undefined;
      if (!probability(item)) invalidResponse();
      return [name, item] as const;
    });
    if (Math.abs(pairs.reduce((sum, [, item]) => sum + item, 0) - 1) > 0.000001) invalidResponse();
    return [id, { type: 'choice', choice: answer.choice, confidence: answer.confidence, probabilities: Object.fromEntries(pairs) }];
  }));
}
