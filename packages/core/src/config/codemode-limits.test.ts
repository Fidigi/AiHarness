import { describe, expect, it, vi } from 'vitest';
import { CODEMODE_LIMITS, CONFIGURABLE_CODEMODE_LIMITS, resolveCodemodeLimits, validateCodemodeLimits } from './codemode-limits.js';
import { createAgentToolLoadout } from '../tools/tool-search.js';
import type { ExtensionRuntimeContext } from '../extensions/extension-registry.js';

// Existing codemode/intrinsics tests cover fixed budgets and physical worker lifetimes.
// These cases cover the missing trusted configuration channel and its hosted enforcement.
describe('trusted native code-mode limits', () => {
  it('keeps defaults/absolute ceilings, owns configuration and rejects malformed or larger values', () => {
    expect(resolveCodemodeLimits()).toEqual(CODEMODE_LIMITS);
    const source = { calls: 2 };
    const resolved = resolveCodemodeLimits(source); source.calls = 64;
    expect(resolved.calls).toBe(2);
    const getter = vi.fn(() => 1);
    for (const value of [null, [], 'x', { other: 1 }, { stackBytes: 1 }, Object.defineProperty({}, 'calls', { get: getter })]) {
      expect(() => validateCodemodeLimits(value)).toThrow('Invalid codemode limits.');
    }
    expect(getter).not.toHaveBeenCalled();
    for (const [key, maximum] of Object.entries(CONFIGURABLE_CODEMODE_LIMITS)) {
      expect(validateCodemodeLimits({ [key]: maximum })).toEqual({ [key]: maximum });
      for (const value of [0, -1, 1.5, NaN, Infinity, '2', maximum + 1]) {
        expect(() => validateCodemodeLimits({ [key]: value })).toThrow('Invalid codemode limits.');
      }
    }
  });

  it('enforces reduced output/call/memory/time budgets without publishing failed stores', async () => {
    for (const [limits, code] of [
      [{ outputBytes: 4 }, 'store("bad",1); text("12345");'],
      [{ calls: 1 }, 'store("bad",1); await describeTool("read"); await describeTool("read");'],
      [{ memoryBytes: 8 * 1024 * 1024 }, 'store("bad",1); const a=[]; while(true) a.push("x".repeat(100000));'],
      [{ timeoutMs: 200 }, 'store("bad",1); /(a+)+$/.test("a".repeat(10000)+"!");'],
    ] as const) {
      const loadout = createAgentToolLoadout({ staticTools: [], codemode: { enabled: true, limits } });
      const result = await loadout.executeCodemode({ code }, {} as ExtensionRuntimeContext, vi.fn());
      expect(result.isError).toBe(true);
      if ('timeoutMs' in limits) expect(result.content).toContain('Codemode deadline exceeded.');
      expect(loadout.resultMetadata('codemode', result)?.codemode).not.toHaveProperty('store');
    }
  });

  it('pins configuration at loadout creation, advertises it and denies guest override fields', async () => {
    const limits = { outputBytes: 5 };
    const loadout = createAgentToolLoadout({ staticTools: [], codemode: { enabled: true, limits } });
    limits.outputBytes = 65536;
    expect(loadout.getTools()[0]?.description).toContain('"outputBytes":5');
    const success = await loadout.executeCodemode({ code: '// @options outputBytes=999999\nstore("ok",1); return "12345";' }, {} as ExtensionRuntimeContext, vi.fn());
    expect(success.isError).toBe(false); // A JavaScript comment has no configuration authority.
    const failure = await loadout.executeCodemode({ code: '// @options outputBytes=999999\nstore("bad",1); return "123456";' }, {} as ExtensionRuntimeContext, vi.fn());
    expect(failure.isError).toBe(true);
    for (const field of ['limits', 'options', 'timeoutMs']) {
      await expect(loadout.executeCodemode({ code: 'return 1', [field]: {} }, {} as ExtensionRuntimeContext, vi.fn())).rejects.toThrow('Invalid or disabled codemode input.');
    }
    expect(() => createAgentToolLoadout({ staticTools: [], codemode: { limits: { calls: 65 } } })).toThrow('Invalid codemode limits.');
  });
});
