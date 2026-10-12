export const dedicatedSpecs: readonly string[];
export const suites: readonly Readonly<{ name: string; config: string }>[];
export const ciPartitions: readonly Readonly<{ index: number; total: number; suites: readonly string[] }>[];
export function runE2e(args: string[], run?: (command: string, args: string[], env: Record<string, string>) => Promise<number>): Promise<{
  status: number;
  partition?: { index: number; total: number };
  results: Array<{ name: string; status: number; shard?: string }>;
}>;
