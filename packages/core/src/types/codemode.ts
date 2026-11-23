import type { TokenUsage } from './index.js';

/** Nested activity belongs exclusively to one outer codemode invocation. */
export interface CodemodeCall {
  id: string;
  parentId: string;
  name: string;
  kind: 'tool' | 'classifier' | 'image';
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  isError: boolean;
  durationMs?: number;
  usage?: TokenUsage;
}
export interface CodemodeProgress { parentId: string; call: CodemodeCall }
export interface CodemodeDetails {
  engine: 'QuickJS';
  parentId: string;
  durationMs: number;
  nestedCalls: CodemodeCall[];
  /** Usage is aggregated once onto the outer result; calls are presentation only. */
  usage?: TokenUsage;
  /** False means costUsd is only the known subtotal, not the complete operation cost. */
  costComplete: boolean;
  store?: Record<string, unknown>;
}
