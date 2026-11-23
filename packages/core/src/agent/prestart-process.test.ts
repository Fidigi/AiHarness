import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
const exec = promisify(execFile);

describe('emitted public Core/SDK prestart admission', () => {
  for (const mode of ['core', 'sdk'] as const) it(`uses the actual built public ${mode} entry and native gates`, async () => {
    let result: Awaited<ReturnType<typeof exec>>;
    try {
      result = await exec(process.execPath, [path.join(process.cwd(), `packages/core/src/agent/fixtures/prestart-${mode}-probe.mjs`)], {
        cwd: os.tmpdir(), timeout: 20_000, maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      const failure = error as Error & { code?: unknown; signal?: unknown; stdout?: string; stderr?: string };
      console.error('[prestart-process] Child outcome.', { code: failure.code ?? null, signal: failure.signal ?? null });
      throw new Error(`${failure.message}\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`, { cause: error });
    }
    expect(result.stderr).toBe('');
    const output = String(result.stdout);
    if (mode === 'core') {
      expect(output.endsWith('native prestart admission OK\n')).toBe(true);
      const rows = [...output.matchAll(/^NATIVE_PRESTART_OBSERVATION (.+)$/gm)].map(match => JSON.parse(match[1]));
      expect(rows.map(row => row.phase)).toEqual(['trust', 'hook', 'provider']);
      for (const row of rows) {
        expect(row.beforeRelease).toEqual({ entered: 1, run: null, running: 0 });
        expect(row.second.status).toBe('rejected'); expect(row.providerCalls).toHaveLength(1);
        expect(row.persistedUsers).toEqual(['first native prompt']); expect(row.settled).toHaveLength(1); expect(row.settled[0].phase).toBe('completed');
      }
    } else {
      expect(output.endsWith('native SDK prestart cancellation OK\n')).toBe(true);
      const rows = [...output.matchAll(/^NATIVE_SDK_PRESTART_OBSERVATION (.+)$/gm)].map(match => JSON.parse(match[1]));
      expect(rows.map(row => row.action)).toEqual(['stop', 'dispose']);
      for (const row of rows) {
        expect(row.prompt.status).toBe('rejected'); expect(row.prompt.name).toBe('AbortError'); expect(row.providerCalls).toBe(0);
        expect(row.persistedUsers).toEqual([]); expect(row.bytesUnchanged).toBe(true); expect(row.beforeSha).toBe(row.afterSha); expect(row.events).toEqual([]);
      }
    }
  }, 30_000);
});
