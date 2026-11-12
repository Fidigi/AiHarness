import type { Buffer } from 'node:buffer';
export function createLocalTLSFixture(root: string): Promise<{ key: Buffer; cert: Buffer }>;
