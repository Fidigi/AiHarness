// Browser-local conservative negative membership, never backend execution authority.
// Fixed 1024 bits; collisions deny raw admission and require a fresh canonical read.
export type RetirementFilter = readonly number[];
const WORDS = 32;
function positions(key: string): number[] {
  let first = 2166136261; let second = 5381;
  for (let i = 0; i < key.length; i++) {
    first = Math.imul(first ^ key.charCodeAt(i), 16777619);
    second = Math.imul(second, 33) ^ key.charCodeAt(i);
  }
  const step = (second >>> 0) | 1;
  return [0, 1, 2].map(i => ((first + Math.imul(i, step)) >>> 0) % (WORDS * 32));
}
export function remembersRetirement(filter: RetirementFilter | undefined, key: string): boolean {
  return Boolean(filter && positions(key).every(bit => ((filter[bit >>> 5] ?? 0) & (1 << (bit & 31))) !== 0));
}
export function rememberRetirement(filter: RetirementFilter | undefined, key: string): RetirementFilter {
  const next = Array.from({ length: WORDS }, (_, i) => filter?.[i] ?? 0);
  for (const bit of positions(key)) next[bit >>> 5] = (next[bit >>> 5]! | (1 << (bit & 31))) >>> 0;
  return Object.freeze(next);
}
export function mergeRetirements(left: RetirementFilter | undefined, right: RetirementFilter | undefined): RetirementFilter {
  return Object.freeze(Array.from({ length: WORDS }, (_, i) => ((left?.[i] ?? 0) | (right?.[i] ?? 0)) >>> 0));
}
