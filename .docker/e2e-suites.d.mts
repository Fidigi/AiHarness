export const dedicatedSpecs: readonly string[];
export const suites: readonly Readonly<{ name: string; config: string }>[];
export const ciPartitions: readonly Readonly<{ index: number; total: number; suites: readonly string[] }>[];
interface E2eProcessOutcome {
  status: number;
  code?: number | null;
  signal?: string | null;
  spawnErrorCode?: string;
}
export function runE2e(args: string[], run?: (command: string, args: string[], env: Record<string, string>) => Promise<number | E2eProcessOutcome>): Promise<{
  status: number;
  partition?: { index: number; total: number };
  results: Array<E2eProcessOutcome & { name: string; shard?: string }>;
}>;
