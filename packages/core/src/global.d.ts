// Global types for testing
import type { Vi, VitestExpect } from 'vitest';

declare global {
  const describe: Vi['describe'];
  const it: Vi['it'];
  const test: Vi['test'];
  const expect: VitestExpect;
  const beforeEach: Vi['beforeEach'];
  const afterEach: Vi['afterEach'];
  const beforeAll: Vi['beforeAll'];
  const afterAll: Vi['afterAll'];
  const vi: Vi;
}

export {};
