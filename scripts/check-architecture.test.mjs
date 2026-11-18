import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectArchitecture, architectureErrors } from './check-architecture.mjs';

const empty = { cycles: [], unused: [] };
async function fixture(t, changes = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'architecture-control-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'packages/core/src/index.ts': "export { publicSdk } from './public.js'; export interface PublicType { id: string }",
    'packages/core/src/public.ts': 'export const publicSdk = 1;',
    'packages/cli/src/index.ts': "import { publicSdk } from '@ai-harness/core'; void publicSdk;",
    'packages/server/src/index.ts': 'export const start = () => undefined;',
    'packages/web/src/index.tsx': "import type { PublicType } from '@ai-harness/core'; const value: PublicType = {id:'fixture'}; void value;",
    ...changes,
  };
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  }
  return inspectArchitecture(root);
}

test('public SDK and declared dynamic entries are not unused-export evidence', async t => {
  const inventory = await fixture(t, {
    'packages/core/src/media/image-worker.ts': 'export const computedWorker = 1;',
    'packages/web/src/components/provider-settings.fixture.tsx': 'export const browserEntry = 1;',
    'packages/web/src/test-support/native-frontend-relay.ts': "import http from 'node:http'; export const fixtureEntry = () => http;",
  });
  assert.deepEqual(architectureErrors(inventory, empty), []);
});

test('rejects reverse Core dependencies even for type imports', async t => {
  const inventory = await fixture(t, {
    'packages/core/src/reverse.ts': "import type { start } from '@ai-harness/server'; export type Reverse = typeof start;",
  });
  assert.match(architectureErrors(inventory, empty).join('\n'), /forbidden core -> server/);
});

test('Web allows only type imports or the reviewed browser-safe Core subpath', async t => {
  const inventory = await fixture(t, { 'packages/web/src/index.tsx': "import { publicSdk } from '@ai-harness/core'; void publicSdk;" });
  assert.match(architectureErrors(inventory, empty).join('\n'), /forbidden web -> core/);
  const safe = await fixture(t, {
    'packages/core/src/tools/shell-input.ts': 'export const shellInput = 1;',
    'packages/web/src/index.tsx': "import { shellInput } from '@ai-harness/core/shell-input'; void shellInput;",
  });
  assert.deepEqual(architectureErrors(safe, empty), []);
});

test('rejects Core UI, browser Node and unsafe subpath dependencies', async t => {
  const ui = await fixture(t, { 'packages/core/src/ui.ts': "import React from 'react'; void React;" });
  assert.match(architectureErrors(ui, empty).join('\n'), /Core UI dependency/);
  const node = await fixture(t, { 'packages/web/src/index.tsx': "import fs from 'node:fs'; void fs;" });
  assert.match(architectureErrors(node, empty).join('\n'), /browser Node dependency/);
  const subpath = await fixture(t, { 'packages/core/src/tools/shell-input.ts': "import fs from 'node:fs'; export const shellInput = fs;" });
  assert.match(architectureErrors(subpath, empty).join('\n'), /browser-safe Core entry/);
  const hostImport = await fixture(t, {
    'packages/web/src/index.tsx': "import { fixtureEntry } from './test-support/native-frontend-relay.js'; void fixtureEntry;",
    'packages/web/src/test-support/native-frontend-relay.ts': 'export const fixtureEntry = 1;',
  });
  assert.match(architectureErrors(hostImport, empty).join('\n'), /production import of host-only test entry/);
});

test('rejects a new value cycle but not a type-only cycle; exceptions pin deferred identity', async t => {
  const inventory = await fixture(t, {
    'packages/core/src/a.ts': "import { b } from './b.js'; export const a = () => b;",
    'packages/core/src/b.ts': "export const b = () => import('./a.js');",
  });
  assert.match(architectureErrors(inventory, empty).join('\n'), /Unreviewed value cycle/);
  const policy = { cycles: [{ reason: 'Reviewed deferred fixture', edges: inventory.cycles[0] }], unused: [] };
  assert.deepEqual(architectureErrors(inventory, policy), []);
  const eager = { ...inventory, cycles: inventory.cycles.map(edges => edges.map(edge => edge.replace('(deferred)', '(eager)'))) };
  assert.match(architectureErrors(eager, policy).join('\n'), /Unreviewed value cycle/);
  const types = await fixture(t, {
    'packages/core/src/a.ts': "import type { B } from './b.js'; export interface A { b?: B }",
    'packages/core/src/b.ts': "import type { A } from './a.js'; export interface B { a?: A }",
  });
  assert.deepEqual(architectureErrors(types, empty), []);
});

test('rejects an unconsumed internal value export and stale exclusions', async t => {
  const inventory = await fixture(t, { 'packages/core/src/internal.ts': 'export function unusedInternal() {}' });
  assert.deepEqual(inventory.unused, ['packages/core/src/internal.ts:unusedInternal']);
  assert.match(architectureErrors(inventory, empty).join('\n'), /Unused internal export/);
  const allowed = { cycles: [], unused: [{ export: inventory.unused[0], reason: 'Explicit bounded fixture control' }] };
  assert.deepEqual(architectureErrors(inventory, allowed), []);
  assert.match(architectureErrors({ ...inventory, unused: [] }, allowed).join('\n'), /Stale unused-export exception/);
  assert.match(architectureErrors(inventory, { ...allowed, cycles: [{ reason: 'Stale fixture', edges: ['absent'] }] }).join('\n'), /Stale\/unreviewed cycle exception/);
});

test('namespace and deferred computed consumers conservatively retain exported values', async t => {
  const inventory = await fixture(t, {
    'packages/core/src/index.ts': "export { publicSdk } from './public.js'; import * as values from './internal.js'; export const read = (key: string) => values[key]; export const deferred = () => import('./deferred.js');",
    'packages/core/src/internal.ts': 'export const computed = 1;',
    'packages/core/src/deferred.ts': 'export const deferredValue = 1;',
    'packages/cli/src/index.ts': '',
  });
  assert.deepEqual(architectureErrors(inventory, empty), []);
});
