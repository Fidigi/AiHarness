import type { Buffer } from 'node:buffer';
export function createLocalTLSFixture(root: string, names?: readonly string[]): Promise<{ key: Buffer; cert: Buffer }>;
